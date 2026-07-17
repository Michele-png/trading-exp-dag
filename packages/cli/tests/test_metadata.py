"""Tests for clean/dirty Git state and portable, non-secret metadata.

Test classes:
    - TestGitMetadata: repository identity and dirty detection.
    - TestPortability: path aliases and URL credential stripping.
    - TestEnvironmentSafety: no environment-value capture.
"""

from __future__ import annotations

import hashlib
import subprocess
from pathlib import Path

from qdag.metadata import capture_environment_metadata, capture_git_metadata
from qdag.portability import PathNormalizer, sanitize_url


def _git(repository: Path, *arguments: str) -> None:
    subprocess.run(
        ["git", *arguments],
        cwd=repository,
        check=True,
        capture_output=True,
        text=True,
    )


def _initialized_repository(tmp_path: Path) -> Path:
    repository = tmp_path / "repository"
    repository.mkdir()
    _git(repository, "init")
    _git(repository, "config", "user.email", "tests@example.test")
    _git(repository, "config", "user.name", "qdag tests")
    (repository / "tracked.txt").write_text("initial\n", encoding="utf-8")
    _git(repository, "add", "tracked.txt")
    _git(repository, "commit", "-m", "initial")
    return repository


class TestGitMetadata:
    """Capture clean and dirty repositories without patch content."""

    def test_clean_then_dirty_repository(self, tmp_path: Path) -> None:
        repository = _initialized_repository(tmp_path)

        clean = capture_git_metadata(repository)
        assert clean is not None
        assert clean["dirty"] is False
        assert isinstance(clean["sha"], str)

        (repository / "tracked.txt").write_text("changed\n", encoding="utf-8")
        dirty = capture_git_metadata(repository)

        assert dirty is not None
        assert dirty["dirty"] is True

    def test_remote_credentials_and_query_are_removed(self, tmp_path: Path) -> None:
        repository = _initialized_repository(tmp_path)
        _git(
            repository,
            "remote",
            "add",
            "origin",
            "https://token:password@github.com/acme/repo.git?signature=secret",
        )

        metadata = capture_git_metadata(repository)

        assert metadata is not None
        assert metadata["remote"] == "https://github.com/acme/repo.git"


class TestPortability:
    """Normalize machine-specific roots and signed URLs."""

    def test_repo_alias_takes_precedence_over_home(self, tmp_path: Path) -> None:
        home = tmp_path / "home"
        repository = home / "work" / "repo"
        target = repository / "results" / "metrics.json"
        normalizer = PathNormalizer(repo_root=repository, home=home)

        assert normalizer.normalize_path(target) == "$REPO/results/metrics.json"
        assert normalizer.normalize_path(home / "notes.txt") == "$HOME/notes.txt"

    def test_command_arguments_strip_signed_queries_and_credentials(
        self,
        tmp_path: Path,
    ) -> None:
        normalizer = PathNormalizer(repo_root=tmp_path, home=tmp_path.parent)

        normalized = normalizer.normalize_command(
            [
                f"--output={tmp_path}/result.json",
                "https://user:secret@example.test/file?X-Amz-Signature=abc",
                "git@github.com:acme/repo.git",
                "--api-token",
                "plaintext-token",
                "--password=plaintext-password",
                "API_SECRET=plaintext-environment-value",
            ]
        )

        assert normalized[0] == "--output=$REPO/result.json"
        assert normalized[1] == "https://example.test/file"
        assert normalized[2] == "github.com:acme/repo.git"
        assert normalized[3:] == [
            "--api-token",
            "<redacted>",
            "--password=<redacted>",
            "API_SECRET=<redacted>",
        ]

    def test_sanitize_url_leaves_plain_text_unchanged(self) -> None:
        assert sanitize_url("not a URL") == "not a URL"


class TestEnvironmentSafety:
    """Capture reproducibility fields without reading environment values."""

    def test_metadata_has_lock_hash_but_not_environment_secret(
        self,
        tmp_path: Path,
        monkeypatch,
    ) -> None:
        repository = _initialized_repository(tmp_path)
        lockfile = repository / "uv.lock"
        lockfile.write_text("version = 1\n", encoding="utf-8")
        secret = "QDAG_TEST_SECRET_4fbbd1e96ff247af"
        monkeypatch.setenv("PRIVATE_TEST_VALUE", secret)

        metadata = capture_environment_metadata(
            ["python", f"--output={repository}/result.json"],
            cwd=repository,
            seed=42,
        )

        assert secret not in str(metadata)
        assert metadata["seed"] == 42
        lockfiles = metadata["lockfiles"]
        assert isinstance(lockfiles, list)
        uv_entry = next(item for item in lockfiles if item["path"] == "$REPO/uv.lock")
        assert uv_entry["sha256"] == hashlib.sha256(b"version = 1\n").hexdigest()
