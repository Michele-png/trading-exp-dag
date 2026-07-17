"""Typer command-line interface for the qdag experiment registry."""

from __future__ import annotations

import json
import os
import stat
from enum import StrEnum
from pathlib import Path
from typing import NoReturn, cast

import typer
from pydantic import ValidationError
from rich.console import Console

from qdag.backup import BackupManager
from qdag.client import APIClient
from qdag.config import (
    CredentialStore,
    Settings,
    SettingsStore,
    validate_personal_token,
)
from qdag.endpoints import (
    AUTH_STATUS,
    EXPERIMENTS,
    LINEAGE_LINKS,
    SEMANTIC_LINKS,
    SPACES,
    experiment,
    experiment_finalize,
)
from qdag.errors import ConfigurationError, QdagError
from qdag.runner import RunExecutor, RunOptions
from qdag.types import JSONObject, JSONValue

console = Console()
error_console = Console(stderr=True)

app = typer.Typer(
    name="qdag",
    help="Capture reproducible local experiments in a private DAG registry.",
    no_args_is_help=True,
    pretty_exceptions_enable=False,
)
auth_app = typer.Typer(help="Manage the personal API token.", no_args_is_help=True)
spaces_app = typer.Typer(help="List and create experiment spaces.", no_args_is_help=True)
experiments_app = typer.Typer(
    help="Create, inspect, and finalize experiments.",
    no_args_is_help=True,
)
lineage_app = typer.Typer(help="Create DAG lineage links.", no_args_is_help=True)
semantic_app = typer.Typer(
    help="Create non-lineage semantic links.",
    no_args_is_help=True,
)
app.add_typer(auth_app, name="auth")
app.add_typer(spaces_app, name="spaces")
app.add_typer(experiments_app, name="experiments")
app.add_typer(lineage_app, name="lineage")
app.add_typer(semantic_app, name="semantic")


class ConclusionState(StrEnum):
    """Supported scientific conclusion states."""

    SUPPORTED = "supported"
    REFUTED = "refuted"
    MIXED = "mixed"
    INCONCLUSIVE = "inconclusive"


class LineageType(StrEnum):
    """Supported acyclic ancestry relationships."""

    DERIVED_FROM = "derived_from"
    SYNTHESIZES = "synthesizes"


class SemanticRelation(StrEnum):
    """Supported non-ancestry scientific relationships."""

    SUPPORTS = "supports"
    CONTRADICTS = "contradicts"
    REPLICATES = "replicates"


def _abort(error: Exception, *, exit_code: int = 1) -> NoReturn:
    error_console.print(f"[red]Error:[/red] {error}")
    raise typer.Exit(exit_code)


def _print_json(payload: JSONValue) -> None:
    console.print_json(json=json.dumps(payload, ensure_ascii=False, sort_keys=True, default=str))


def _build_client() -> APIClient:
    settings = SettingsStore().load()
    token = CredentialStore().get_token()
    if token is None:
        raise ConfigurationError("not authenticated; run `qdag auth login` first")
    return APIClient(settings.base_url, token)


def _read_passphrase(
    passphrase_file: Path | None,
    *,
    confirmation: bool,
) -> str:
    if passphrase_file is None:
        return cast(
            str,
            typer.prompt(
                "Backup passphrase",
                hide_input=True,
                confirmation_prompt=confirmation,
            ),
        )
    try:
        if os.name == "posix" and stat.S_IMODE(passphrase_file.stat().st_mode) & 0o077:
            raise ConfigurationError(f"passphrase file must have mode 0600: {passphrase_file}")
        passphrase = passphrase_file.read_text(encoding="utf-8").rstrip("\r\n")
    except OSError as exc:
        raise ConfigurationError(f"cannot read passphrase file: {passphrase_file}") from exc
    if not passphrase:
        raise ConfigurationError("backup passphrase must not be empty")
    return passphrase


@auth_app.command("login")
def auth_login(
    token: str | None = typer.Option(
        None,
        "--token",
        help="Personal token; omit to enter it through a hidden prompt.",
        hide_input=True,
    ),
    base_url: str | None = typer.Option(
        None,
        "--base-url",
        help="API origin. Defaults to the configured origin.",
    ),
    no_verify: bool = typer.Option(
        False,
        "--no-verify",
        help="Store the token without checking the API.",
    ),
) -> None:
    """Validate and store a high-entropy personal token."""
    try:
        settings_store = SettingsStore()
        current = settings_store.load()
        settings = Settings(base_url=base_url or current.base_url)
        raw_token = token or cast(
            str,
            typer.prompt("Personal token", hide_input=True),
        )
        supplied_token = validate_personal_token(raw_token)
        if not no_verify:
            with APIClient(settings.base_url, supplied_token) as client:
                client.get(AUTH_STATUS)
        storage = CredentialStore().set_token(supplied_token)
        settings_store.save(settings)
    except (QdagError, ValidationError) as exc:
        _abort(exc)
    console.print(f"Authenticated; token stored in {storage}.")


@auth_app.command("logout")
def auth_logout() -> None:
    """Remove all locally stored personal-token copies."""
    try:
        CredentialStore().delete_token()
    except QdagError as exc:
        _abort(exc)
    console.print("Logged out.")


@auth_app.command("status")
def auth_status(
    offline: bool = typer.Option(
        False,
        "--offline",
        help="Inspect local token storage without calling the API.",
    ),
) -> None:
    """Show local authentication state and optionally verify it with the API."""
    store = CredentialStore()
    try:
        token = store.get_token()
        location = store.storage_location()
        if token is None:
            raise ConfigurationError("no personal token is configured")
        if offline:
            _print_json(
                {
                    "authenticated": True,
                    "storage": location,
                    "verified": False,
                }
            )
            return
        with _build_client() as client:
            remote = client.get(AUTH_STATUS)
        _print_json(
            {
                "authenticated": True,
                "storage": location,
                "verified": True,
                "actor": remote,
            }
        )
    except QdagError as exc:
        _abort(exc)


@spaces_app.command("list")
def spaces_list(
    include_archived: bool = typer.Option(False, "--include-archived"),
) -> None:
    """List spaces visible to the authenticated actor."""
    try:
        with _build_client() as client:
            result = client.get(
                SPACES,
                params={"include_archived": include_archived},
            )
    except QdagError as exc:
        _abort(exc)
    _print_json(result)


@spaces_app.command("create")
def spaces_create(
    name: str = typer.Option(..., "--name", help="Human-readable space name."),
    objective: str = typer.Option(
        ...,
        "--objective",
        help="Objective text used to create the root node.",
    ),
) -> None:
    """Create a space and its single objective root."""
    try:
        with _build_client() as client:
            result = client.post(
                SPACES,
                {"name": name, "objective": objective},
            )
    except QdagError as exc:
        _abort(exc)
    _print_json(result)


@experiments_app.command("create")
def experiments_create(
    space_id: str = typer.Option(..., "--space", help="Owning space id."),
    title: str = typer.Option(..., "--title"),
    hypothesis: str = typer.Option(..., "--hypothesis"),
    method: str | None = typer.Option(None, "--method"),
    success_criteria: str | None = typer.Option(None, "--success-criteria"),
    retrospective: bool = typer.Option(False, "--retrospective"),
) -> None:
    """Create a draft experiment."""
    payload: JSONObject = {
        "space_id": space_id,
        "title": title,
        "hypothesis": hypothesis,
        "retrospective": retrospective,
    }
    if method is not None:
        payload["method"] = method
    if success_criteria is not None:
        payload["success_criteria"] = success_criteria
    try:
        with _build_client() as client:
            result = client.post(EXPERIMENTS, payload)
    except QdagError as exc:
        _abort(exc)
    _print_json(result)


@experiments_app.command("show")
def experiments_show(
    experiment_id: str = typer.Argument(..., help="Experiment id."),
) -> None:
    """Show one experiment and its current revision."""
    try:
        with _build_client() as client:
            result = client.get(experiment(experiment_id))
    except QdagError as exc:
        _abort(exc)
    _print_json(result)


@experiments_app.command("finalize")
def experiments_finalize(
    experiment_id: str = typer.Argument(..., help="Experiment id."),
    state: ConclusionState = typer.Option(..., "--state"),
    summary: str = typer.Option(..., "--summary"),
) -> None:
    """Freeze the current experiment revision with a conclusion."""
    try:
        with _build_client() as client:
            result = client.post(
                experiment_finalize(experiment_id),
                {
                    "conclusion": {
                        "state": state.value,
                        "summary": summary,
                    }
                },
            )
    except QdagError as exc:
        _abort(exc)
    _print_json(result)


@lineage_app.command("link")
def lineage_link(
    parent_id: str = typer.Option(..., "--parent"),
    child_id: str = typer.Option(..., "--child"),
    link_type: LineageType = typer.Option(
        LineageType.DERIVED_FROM,
        "--type",
    ),
) -> None:
    """Create an acyclic in-space lineage edge."""
    try:
        with _build_client() as client:
            result = client.post(
                LINEAGE_LINKS,
                {
                    "parent_experiment_id": parent_id,
                    "child_experiment_id": child_id,
                    "type": link_type.value,
                },
            )
    except QdagError as exc:
        _abort(exc)
    _print_json(result)


@semantic_app.command("link")
def semantic_link(
    source_id: str = typer.Option(..., "--source"),
    target_id: str = typer.Option(..., "--target"),
    relation: SemanticRelation = typer.Option(..., "--relation"),
    note: str | None = typer.Option(None, "--note"),
) -> None:
    """Create a support, contradiction, or replication link."""
    payload: JSONObject = {
        "source_experiment_id": source_id,
        "target_experiment_id": target_id,
        "relation": relation.value,
    }
    if note is not None:
        payload["note"] = note
    try:
        with _build_client() as client:
            result = client.post(SEMANTIC_LINKS, payload)
    except QdagError as exc:
        _abort(exc)
    _print_json(result)


@app.command(
    "run",
    context_settings={"allow_extra_args": True, "ignore_unknown_options": True},
)
def run_command(
    experiment_id: str = typer.Option(..., "--experiment"),
    result_path: Path = typer.Option(..., "--result"),
    command: list[str] = typer.Argument(
        ...,
        help="Child command after `--`.",
    ),
    cwd: Path = typer.Option(Path.cwd(), "--cwd"),
    seed: int | None = typer.Option(None, "--seed"),
    include_patch: bool = typer.Option(False, "--include-patch"),
    upload_log: bool = typer.Option(False, "--upload-log"),
    allow_secrets: bool = typer.Option(
        False,
        "--allow-secrets",
        help="Explicitly override high-confidence evidence findings.",
    ),
    patch_max_bytes: int = typer.Option(5 * 1024 * 1024, "--patch-max-bytes"),
    log_max_bytes: int = typer.Option(10 * 1024 * 1024, "--log-max-bytes"),
) -> None:
    """Run a command locally and synchronize its terminal state idempotently."""
    try:
        with _build_client() as client:
            outcome = RunExecutor(client).execute(
                RunOptions(
                    experiment_id=experiment_id,
                    result_path=result_path,
                    command=command,
                    cwd=cwd,
                    seed=seed,
                    include_patch=include_patch,
                    upload_log=upload_log,
                    allow_secrets=allow_secrets,
                    patch_max_bytes=patch_max_bytes,
                    log_max_bytes=log_max_bytes,
                )
            )
    except QdagError as exc:
        _abort(exc)
    _print_json(
        {
            "run_id": outcome.run_id,
            "exit_code": outcome.exit_code,
            "synchronized": outcome.synchronized,
            "log_path": str(outcome.log_path),
            "log_truncated": outcome.log_truncated,
            "error": outcome.error,
        }
    )
    raise typer.Exit(outcome.exit_code)


@app.command("backup")
def backup_command(
    output_path: Path = typer.Argument(..., help="Encrypted .qdag backup path."),
    include_artifacts: bool = typer.Option(False, "--include-artifacts"),
    passphrase_file: Path | None = typer.Option(
        None,
        "--passphrase-file",
        help="Mode-0600 file used instead of the hidden prompt.",
    ),
    force: bool = typer.Option(False, "--force", help="Replace an existing backup."),
) -> None:
    """Export, verify, and encrypt canonical registry records."""
    try:
        if output_path.exists() and not force:
            raise ConfigurationError(
                f"backup already exists; pass --force to replace it: {output_path}"
            )
        passphrase = _read_passphrase(passphrase_file, confirmation=True)
        with _build_client() as client:
            summary = BackupManager(client).create(
                output_path,
                passphrase=passphrase,
                include_artifacts=include_artifacts,
            )
    except QdagError as exc:
        _abort(exc)
    _print_json(
        {
            "path": str(summary.path),
            "archive_sha256": summary.archive_sha256,
            "encrypted_size_bytes": summary.encrypted_size_bytes,
            "record_resources": list(summary.record_resources),
            "artifact_count": summary.artifact_count,
        }
    )


@app.command("restore")
def restore_command(
    backup_path: Path = typer.Argument(..., help="Encrypted .qdag backup path."),
    passphrase_file: Path | None = typer.Option(None, "--passphrase-file"),
    extract_to: Path | None = typer.Option(None, "--extract-to"),
    dry_run: bool = typer.Option(False, "--dry-run"),
) -> None:
    """Verify/decrypt a backup and restore canonical records idempotently."""
    try:
        passphrase = _read_passphrase(passphrase_file, confirmation=False)
        if dry_run:
            summary = BackupManager(None).restore(
                backup_path,
                passphrase=passphrase,
                extract_to=extract_to,
                dry_run=True,
            )
        else:
            with _build_client() as client:
                summary = BackupManager(client).restore(
                    backup_path,
                    passphrase=passphrase,
                    extract_to=extract_to,
                    dry_run=False,
                )
    except QdagError as exc:
        _abort(exc)
    _print_json(
        {
            "archive_sha256": summary.archive_sha256,
            "record_resources": list(summary.record_resources),
            "artifact_count": summary.artifact_count,
            "extracted_to": str(summary.extracted_to) if summary.extracted_to else None,
            "dry_run": dry_run,
            "api_response": summary.api_response,
        }
    )


def main() -> None:
    """Run the qdag Typer application."""
    app()
