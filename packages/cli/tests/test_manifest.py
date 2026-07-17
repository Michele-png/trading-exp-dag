"""Tests for the versioned result-manifest contract.

Test classes:
    - TestValidManifest: typed parsing of the v1.0 schema.
    - TestMalformedManifest: invalid JSON, versions, metrics, and bounds.
"""

from __future__ import annotations

import json
from pathlib import Path

import pytest

from qdag.errors import ManifestError
from qdag.manifest import RESULT_MANIFEST_VERSION, Metric, load_result_manifest


def _write_manifest(path: Path, payload: object) -> Path:
    path.write_text(json.dumps(payload), encoding="utf-8")
    return path


class TestValidManifest:
    """Accept the documented versioned result contract."""

    def test_parses_typed_metrics(
        self,
        tmp_path: Path,
        valid_manifest_payload,
    ) -> None:
        path = _write_manifest(tmp_path / "result.json", valid_manifest_payload)

        manifest = load_result_manifest(path)

        assert manifest.schema_version == RESULT_MANIFEST_VERSION
        metric = manifest.metrics["sharpe"]
        assert isinstance(metric, Metric)
        assert metric.value == 1.25
        assert manifest.conclusion.state == "supported"


class TestMalformedManifest:
    """Reject unreadable and semantically invalid result files."""

    def test_rejects_invalid_json(self, tmp_path: Path) -> None:
        path = tmp_path / "result.json"
        path.write_text("{invalid", encoding="utf-8")

        with pytest.raises(ManifestError, match="not valid"):
            load_result_manifest(path)

    def test_rejects_missing_schema_version(
        self,
        tmp_path: Path,
        valid_manifest_payload,
    ) -> None:
        valid_manifest_payload.pop("schema_version")
        path = _write_manifest(tmp_path / "result.json", valid_manifest_payload)

        with pytest.raises(ManifestError, match="schema validation"):
            load_result_manifest(path)

    def test_rejects_unknown_schema_version(
        self,
        tmp_path: Path,
        valid_manifest_payload,
    ) -> None:
        valid_manifest_payload["schema_version"] = "2.0"
        path = _write_manifest(tmp_path / "result.json", valid_manifest_payload)

        with pytest.raises(ManifestError, match="schema validation"):
            load_result_manifest(path)

    def test_rejects_inverted_metric_bounds(
        self,
        tmp_path: Path,
        valid_manifest_payload,
    ) -> None:
        valid_manifest_payload["metrics"]["sharpe"]["lower_bound"] = 2.0
        valid_manifest_payload["metrics"]["sharpe"]["upper_bound"] = 1.0
        path = _write_manifest(tmp_path / "result.json", valid_manifest_payload)

        with pytest.raises(ManifestError, match="lower_bound"):
            load_result_manifest(path)

    def test_rejects_non_finite_metric(
        self,
        tmp_path: Path,
        valid_manifest_payload,
    ) -> None:
        valid_manifest_payload["metrics"]["sharpe"]["value"] = float("nan")
        path = _write_manifest(tmp_path / "result.json", valid_manifest_payload)

        with pytest.raises(ManifestError):
            load_result_manifest(path)
