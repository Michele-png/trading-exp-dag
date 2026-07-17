"""Safe, portable metadata captured around local experiment runs."""

from __future__ import annotations

import hashlib
import importlib.metadata
import os
import platform
import subprocess
import sys
from pathlib import Path

from qdag.portability import PathNormalizer, sanitize_url
from qdag.types import JSONObject, JSONValue

LOCKFILE_NAMES = frozenset(
    {
        "Cargo.lock",
        "Pipfile.lock",
        "package-lock.json",
        "pnpm-lock.yaml",
        "poetry.lock",
        "uv.lock",
        "yarn.lock",
    }
)
SKIPPED_DIRECTORIES = frozenset(
    {
        ".git",
        ".mypy_cache",
        ".pytest_cache",
        ".ruff_cache",
        ".tox",
        ".venv",
        "__pycache__",
        "dist",
        "node_modules",
    }
)
MAX_LOCKFILE_BYTES = 100 * 1024 * 1024
MAX_SCAN_DEPTH = 4


def _run_git(cwd: Path, *arguments: str) -> str | None:
    try:
        completed = subprocess.run(
            ["git", *arguments],
            cwd=cwd,
            check=False,
            capture_output=True,
            text=True,
            timeout=5,
        )
    except (FileNotFoundError, OSError, subprocess.TimeoutExpired):
        return None
    if completed.returncode != 0:
        return None
    return completed.stdout.strip()


def discover_git_root(cwd: Path) -> Path | None:
    """Return the repository root containing ``cwd``, when available."""
    output = _run_git(cwd, "rev-parse", "--show-toplevel")
    return Path(output).resolve(strict=False) if output else None


def capture_git_metadata(cwd: Path) -> JSONObject | None:
    """Capture commit identity and dirty state without file contents."""
    root = discover_git_root(cwd)
    if root is None:
        return None
    normalizer = PathNormalizer(repo_root=root)
    sha = _run_git(root, "rev-parse", "HEAD")
    status = _run_git(root, "status", "--porcelain=v1", "--untracked-files=normal")
    branch = _run_git(root, "symbolic-ref", "--short", "-q", "HEAD")
    remote = _run_git(root, "remote", "get-url", "origin")

    result: JSONObject = {
        "root": normalizer.normalize_path(root),
        "sha": sha,
        "dirty": bool(status),
    }
    if branch:
        result["branch"] = branch
    if remote:
        result["remote"] = sanitize_url(remote)
    return result


def _is_lockfile(filename: str) -> bool:
    return filename in LOCKFILE_NAMES or (
        filename.startswith("requirements") and filename.endswith(".txt")
    )


def _sha256_file(path: Path) -> str:
    digest = hashlib.sha256()
    with path.open("rb") as handle:
        for block in iter(lambda: handle.read(1024 * 1024), b""):
            digest.update(block)
    return digest.hexdigest()


def capture_lockfile_hashes(
    root: Path,
    normalizer: PathNormalizer,
) -> list[JSONObject]:
    """Hash recognized lockfiles without recording their contents."""
    results: list[JSONObject] = []
    for directory, directory_names, filenames in os.walk(root):
        current = Path(directory)
        try:
            depth = len(current.relative_to(root).parts)
        except ValueError:
            continue
        directory_names[:] = sorted(
            name
            for name in directory_names
            if name not in SKIPPED_DIRECTORIES
            and not (name.startswith(".") and name != ".github")
            and depth < MAX_SCAN_DEPTH
        )
        for filename in sorted(filenames):
            if not _is_lockfile(filename):
                continue
            path = current / filename
            try:
                size = path.stat().st_size
                if size > MAX_LOCKFILE_BYTES:
                    continue
                digest = _sha256_file(path)
            except OSError:
                continue
            results.append(
                {
                    "path": normalizer.normalize_path(path),
                    "sha256": digest,
                    "size_bytes": size,
                }
            )
    results.sort(key=lambda item: str(item["path"]))
    return results


def capture_dependency_snapshot() -> list[JSONObject]:
    """Return installed Python distribution names and versions only."""
    packages: dict[str, str] = {}
    for distribution in importlib.metadata.distributions():
        name = distribution.metadata["Name"]
        if not name:
            continue
        packages[name.casefold()] = distribution.version
    return [{"name": name, "version": packages[name]} for name in sorted(packages)]


def capture_environment_metadata(
    command: list[str],
    *,
    cwd: Path,
    seed: int | None = None,
) -> JSONObject:
    """Capture reproducibility metadata without reading environment variables."""
    resolved_cwd = cwd.resolve(strict=False)
    repo_root = discover_git_root(resolved_cwd)
    normalizer = PathNormalizer(repo_root=repo_root)
    lockfile_root = repo_root or resolved_cwd

    metadata: JSONObject = {
        "python": {
            "version": platform.python_version(),
            "implementation": platform.python_implementation(),
            "executable": normalizer.normalize_path(Path(sys.executable)),
        },
        "os": {
            "system": platform.system(),
            "release": platform.release(),
            "machine": platform.machine(),
        },
        "command": normalizer.normalize_command(command),
        "cwd": normalizer.normalize_path(resolved_cwd),
        "git": capture_git_metadata(resolved_cwd),
        "lockfiles": capture_lockfile_hashes(lockfile_root, normalizer),
        "dependencies": capture_dependency_snapshot(),
    }
    if seed is not None:
        metadata["seed"] = seed
    return metadata


def contains_environment_values(metadata: JSONValue, environment: dict[str, str]) -> bool:
    """Return whether metadata accidentally contains a complete environment value.

    This helper is intended for defensive tests. Empty and very short values are
    ignored because they produce meaningless substring matches.
    """
    serialized = str(metadata)
    return any(len(value) >= 8 and value in serialized for value in environment.values() if value)
