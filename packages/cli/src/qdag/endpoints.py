"""Centralized REST endpoint paths for the qdag API."""

from __future__ import annotations

from urllib.parse import quote

API_PREFIX = "/api/v1"

AUTH_STATUS = f"{API_PREFIX}/auth/status"
SPACES = f"{API_PREFIX}/spaces"
EXPERIMENTS = f"{API_PREFIX}/experiments"
LINEAGE_LINKS = f"{API_PREFIX}/lineage-links"
SEMANTIC_LINKS = f"{API_PREFIX}/semantic-links"
RUNS = f"{API_PREFIX}/runs"
ARTIFACTS_PREPARE = f"{API_PREFIX}/artifacts/prepare"
BACKUPS_EXPORT = f"{API_PREFIX}/backups/export"
BACKUPS_RESTORE = f"{API_PREFIX}/backups/restore"


def _segment(value: str) -> str:
    """Quote one untrusted path segment."""
    if not value:
        raise ValueError("resource identifier must not be empty")
    return quote(value, safe="")


def space(space_id: str) -> str:
    """Return the path for one space."""
    return f"{SPACES}/{_segment(space_id)}"


def experiment(experiment_id: str) -> str:
    """Return the path for one experiment."""
    return f"{EXPERIMENTS}/{_segment(experiment_id)}"


def experiment_finalize(experiment_id: str) -> str:
    """Return the idempotent finalization path for an experiment."""
    return f"{experiment(experiment_id)}/finalize"


def run(run_id: str) -> str:
    """Return the path for one run."""
    return f"{RUNS}/{_segment(run_id)}"


def run_complete(run_id: str) -> str:
    """Return the idempotent completion path for a run."""
    return f"{run(run_id)}/complete"


def run_fail(run_id: str) -> str:
    """Return the idempotent failure path for a run."""
    return f"{run(run_id)}/fail"


def artifact_finalize(artifact_id: str) -> str:
    """Return the finalization path for a prepared artifact."""
    return f"{API_PREFIX}/artifacts/{_segment(artifact_id)}/finalize"
