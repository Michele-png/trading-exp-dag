"""Exercise the authenticated Web and CLI API paths against a local stack."""

from __future__ import annotations

import hashlib
import os
import secrets
import tempfile
import time
from pathlib import Path
from typing import Any

import httpx

from qdag.backup import BackupManager
from qdag.client import APIClient


def wait_for_supabase_auth(base_url: str, publishable_key: str) -> None:
    """Block until the Supabase auth service is ready after a container restart."""
    deadline = time.monotonic() + 60
    last_status = "unknown"
    while time.monotonic() < deadline:
        try:
            response = httpx.get(
                f"{base_url}/auth/v1/health",
                headers={"apikey": publishable_key},
                timeout=5,
            )
            if response.status_code == 200:
                return
            last_status = str(response.status_code)
        except httpx.HTTPError as error:  # noqa: PERF203 - readiness poll
            last_status = type(error).__name__
        time.sleep(1)
    raise RuntimeError(f"Supabase auth did not become ready (last status {last_status})")


def require_env(name: str) -> str:
    """Return a required environment value without logging it."""
    value = os.environ.get(name)
    if not value:
        raise RuntimeError(f"{name} is required")
    return value


def checked(response: httpx.Response) -> dict[str, Any]:
    """Raise for HTTP errors and return an object response."""
    if response.is_error:
        raise RuntimeError(
            f"{response.request.method} {response.request.url} returned "
            f"{response.status_code}: {response.text[:500]}"
        )
    payload = response.json()
    if not isinstance(payload, dict):
        raise TypeError("Expected an object response")
    return payload


def exercise_backup(
    app_url: str,
    personal_token: str,
    backup_path: Path,
    passphrase: str,
) -> None:
    """Create, validate, and idempotently restore an encrypted backup."""
    with APIClient(app_url, personal_token) as api_client:
        manager = BackupManager(api_client)
        manager.create(
            backup_path,
            passphrase=passphrase,
            include_artifacts=True,
        )
        manager.restore(
            backup_path,
            passphrase=passphrase,
            dry_run=True,
        )
        manager.restore(
            backup_path,
            passphrase=passphrase,
            dry_run=False,
        )


def main() -> None:
    """Create and finalize one experiment through the public API contract."""
    supabase_url = require_env("NEXT_PUBLIC_SUPABASE_URL").rstrip("/")
    publishable_key = require_env("NEXT_PUBLIC_SUPABASE_PUBLISHABLE_KEY")
    secret_key = require_env("SUPABASE_SECRET_KEY")
    app_url = os.environ.get("QDAG_API_URL", "http://localhost:3000").rstrip("/")
    if not supabase_url.startswith(("http://127.0.0.1:", "http://localhost:")):
        if os.environ.get("QDAG_SMOKE_ALLOW_REMOTE") != "1":
            raise RuntimeError("Refusing to create smoke data outside local Supabase")

    suffix = secrets.token_hex(6)
    email = f"qdag-smoke-{suffix}@example.test"
    password = f"Local-{secrets.token_urlsafe(24)}"

    wait_for_supabase_auth(supabase_url, publishable_key)
    with httpx.Client(timeout=30) as client:
        admin_headers = {
            "apikey": secret_key,
            "Authorization": f"Bearer {secret_key}",
        }
        user = checked(
            client.post(
                f"{supabase_url}/auth/v1/admin/users",
                headers=admin_headers,
                json={"email": email, "password": password, "email_confirm": True},
            )
        )
        user_id = str(user["id"])
        session = checked(
            client.post(
                f"{supabase_url}/auth/v1/token",
                params={"grant_type": "password"},
                headers={"apikey": publishable_key},
                json={"email": email, "password": password},
            )
        )
        access_token = str(session["access_token"])
        user_headers = {
            "apikey": publishable_key,
            "Authorization": f"Bearer {access_token}",
        }
        workspace_rows = client.get(
            f"{supabase_url}/rest/v1/workspaces",
            params={
                "select": "id",
                "personal_owner_user_id": f"eq.{user_id}",
            },
            headers=user_headers,
        )
        workspace_rows.raise_for_status()
        workspaces = workspace_rows.json()
        if not isinstance(workspaces, list) or len(workspaces) != 1:
            raise RuntimeError("Personal workspace provisioning failed")
        workspace_id = str(workspaces[0]["id"])

        browser_headers = {
            "Authorization": f"Bearer {access_token}",
            "Content-Type": "application/json",
            "X-Workspace-Id": workspace_id,
            "Idempotency-Key": f"smoke-token-{suffix}",
            "Origin": app_url,
        }
        token_result = checked(
            client.post(
                f"{app_url}/api/v1/auth/tokens",
                headers=browser_headers,
                json={
                    "workspaceId": workspace_id,
                    "name": "Local smoke test",
                    "scopes": [
                        "spaces:read",
                        "spaces:write",
                        "nodes:read",
                        "nodes:write",
                        "runs:write",
                        "artifacts:write",
                        "export:read",
                        "import:write",
                    ],
                },
            )
        )
        personal_token = str(token_result["token"])
        token_headers = {
            "Authorization": f"Bearer {personal_token}",
            "Content-Type": "application/json",
        }
        checked(client.get(f"{app_url}/api/v1/auth/status", headers=token_headers))

        token_headers["Idempotency-Key"] = f"smoke-space-{suffix}"
        space_result = checked(
            client.post(
                f"{app_url}/api/v1/spaces",
                headers=token_headers,
                json={
                    "name": f"Smoke space {suffix}",
                    "objective": "Verify the complete registry lifecycle.",
                },
            )
        )
        space_id = str(space_result["id"])
        objective_id = str(space_result["objective"]["id"])

        token_headers["Idempotency-Key"] = f"smoke-experiment-{suffix}"
        experiment = checked(
            client.post(
                f"{app_url}/api/v1/experiments",
                headers=token_headers,
                json={
                    "space_id": space_id,
                    "title": "Local API smoke experiment",
                    "hypothesis": "The integrated lifecycle completes without data leakage.",
                    "method": "Create, run, attach evidence, and finalize through /api/v1.",
                    "success_criteria": "Every authenticated operation succeeds.",
                    "retrospective": False,
                },
            )
        )
        experiment_id = str(experiment["experiment_id"])

        token_headers["Idempotency-Key"] = f"smoke-lineage-{suffix}"
        checked(
            client.post(
                f"{app_url}/api/v1/lineage-links",
                headers=token_headers,
                json={
                    "parent_experiment_id": objective_id,
                    "child_experiment_id": experiment_id,
                    "type": "derived_from",
                },
            )
        )

        token_headers["Idempotency-Key"] = f"smoke-run-{suffix}"
        run = checked(
            client.post(
                f"{app_url}/api/v1/runs",
                headers=token_headers,
                json={
                    "experiment_id": experiment_id,
                    "command": "python smoke.py",
                    "environment": {"python": "3.11", "os": "local"},
                    "parameters": {"seed": 42},
                    "status": "running",
                },
            )
        )
        run_id = str(run["run_id"])

        evidence = b"qdag local smoke evidence\n"
        checksum = hashlib.sha256(evidence).hexdigest()
        token_headers["Idempotency-Key"] = f"smoke-artifact-{suffix}"
        prepared = checked(
            client.post(
                f"{app_url}/api/v1/artifacts/prepare",
                headers=token_headers,
                json={
                    "run_id": run_id,
                    "filename": "smoke.txt",
                    "media_type": "text/plain",
                    "size_bytes": len(evidence),
                    "sha256": checksum,
                    "kind": "smoke",
                },
            )
        )
        upload = prepared["upload"]
        upload_response = client.put(
            str(upload["url"]),
            headers={str(key): str(value) for key, value in upload["headers"].items()},
            content=evidence,
        )
        upload_response.raise_for_status()
        artifact_id = str(prepared["artifact_id"])
        token_headers["Idempotency-Key"] = f"smoke-artifact-finalize-{suffix}"
        checked(
            client.post(
                f"{app_url}/api/v1/artifacts/{artifact_id}/finalize",
                headers=token_headers,
                json={"sha256": checksum, "size_bytes": len(evidence)},
            )
        )

        token_headers["Idempotency-Key"] = f"smoke-complete-{suffix}"
        checked(
            client.post(
                f"{app_url}/api/v1/runs/{run_id}/complete",
                headers=token_headers,
                json={
                    "exit_code": 0,
                    "result_manifest": {
                        "schema_version": "1.0",
                        "metrics": {
                            "checks_passed": {
                                "value": 1,
                                "unit": "boolean",
                                "direction": "higher_is_better",
                            }
                        },
                        "parameters": {"seed": 42},
                        "narrative": "The integrated lifecycle completed.",
                        "conclusion": {
                            "state": "supported",
                            "summary": "The local stack satisfies the smoke contract.",
                        },
                    },
                },
            )
        )

        token_headers["Idempotency-Key"] = f"smoke-finalize-{suffix}"
        checked(
            client.post(
                f"{app_url}/api/v1/experiments/{experiment_id}/finalize",
                headers=token_headers,
                json={
                    "conclusion": {
                        "state": "supported",
                        "summary": "All smoke assertions passed.",
                    }
                },
            )
        )
        checked(
            client.get(
                f"{app_url}/api/v1/experiments/{experiment_id}",
                headers=token_headers,
            )
        )
        token_headers["Idempotency-Key"] = f"smoke-editorial-{suffix}"
        checked(
            client.post(
                f"{app_url}/api/v1/nodes/{experiment_id}/revisions",
                headers=token_headers,
                json={
                    "workspaceId": workspace_id,
                    "editorial": True,
                    "correctionReason": "Clarify the local smoke-test wording.",
                    "content": {
                        "title": "Local API smoke experiment",
                        "hypothesis": (
                            "The integrated lifecycle completes without "
                            "cross-workspace data leakage."
                        ),
                        "method": (
                            "Create, run, attach evidence, and finalize through "
                            "the versioned API."
                        ),
                        "successCriteria": "Every authenticated operation succeeds.",
                        "preregistrationState": "preregistered",
                        "conclusion": "All smoke assertions passed.",
                        "notes": "Editorial wording correction only.",
                    },
                },
            )
        )
        token_headers["Idempotency-Key"] = f"smoke-editorial-finalize-{suffix}"
        checked(
            client.post(
                f"{app_url}/api/v1/experiments/{experiment_id}/finalize",
                headers=token_headers,
                json={
                    "conclusion": {
                        "state": "supported",
                        "summary": "All corrected smoke assertions passed.",
                    }
                },
            )
        )
        backup = checked(
            client.get(
                f"{app_url}/api/v1/backups/export",
                headers=token_headers,
            )
        )
        if "data" not in backup and "records" not in backup:
            raise RuntimeError("Backup export did not contain canonical records")

        persistent_backup = os.environ.get("QDAG_SMOKE_BACKUP_PATH")
        if persistent_backup:
            backup_path = Path(persistent_backup).expanduser().resolve()
            backup_path.parent.mkdir(parents=True, exist_ok=True)
            backup_path.unlink(missing_ok=True)
            passphrase = os.environ.get(
                "QDAG_SMOKE_BACKUP_PASSPHRASE",
                "local-smoke-backup-passphrase",
            )
            exercise_backup(app_url, personal_token, backup_path, passphrase)
        else:
            with tempfile.TemporaryDirectory(
                prefix="qdag-smoke-backup-"
            ) as directory:
                exercise_backup(
                    app_url,
                    personal_token,
                    Path(directory) / "smoke.qdag",
                    secrets.token_urlsafe(32),
                )

    print("Authenticated Web, CLI, run, artifact, finalization, and export smoke passed.")


if __name__ == "__main__":
    main()
