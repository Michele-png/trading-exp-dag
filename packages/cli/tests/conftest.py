"""Shared fixtures for qdag CLI tests."""

from __future__ import annotations

from pathlib import Path
from typing import Any

import pytest

from qdag.config import ConfigPaths


@pytest.fixture
def config_paths(tmp_path: Path) -> ConfigPaths:
    """Return isolated config and state paths."""
    config_dir = tmp_path / "config"
    state_dir = tmp_path / "state"
    return ConfigPaths(
        config_dir=config_dir,
        state_dir=state_dir,
        settings_file=config_dir / "config.json",
        credentials_file=config_dir / "credentials.json",
    )


@pytest.fixture
def valid_token() -> str:
    """Return a deterministic token that passes the entropy sanity check."""
    return "qdag_A1b2C3d4E5f6G7h8I9j0K1l2M3n4O5p6Q7r8S9t0"


@pytest.fixture
def valid_manifest_payload() -> dict[str, Any]:
    """Return a minimal valid result-manifest payload."""
    return {
        "schema_version": "1.0",
        "metrics": {
            "sharpe": {
                "value": 1.25,
                "unit": "ratio",
                "direction": "higher_is_better",
            }
        },
        "artifacts": [
            {
                "name": "equity-curve",
                "uri": "s3://bucket/equity.json",
                "sha256": "a" * 64,
                "size_bytes": 123,
            }
        ],
        "parameters": {"seed": 42, "lookback": 60},
        "narrative": "The strategy remained stable across the holdout period.",
        "conclusion": {
            "state": "supported",
            "summary": "The preregistered threshold was exceeded.",
            "limitations": ["Single-market evaluation."],
        },
    }
