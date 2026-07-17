"""Validation and typed parsing for versioned result manifests."""

from __future__ import annotations

import json
import math
from pathlib import Path
from typing import Literal, NoReturn

from jsonschema import Draft202012Validator
from jsonschema.exceptions import SchemaError
from pydantic import BaseModel, ConfigDict, Field, JsonValue, ValidationError

from qdag.errors import ManifestError

RESULT_MANIFEST_VERSION = "1.0"
MAX_MANIFEST_BYTES = 10 * 1024 * 1024

_EMBEDDED_SCHEMA_JSON = r"""
{
  "$schema": "https://json-schema.org/draft/2020-12/schema",
  "$id": "https://qdag.dev/contracts/result-manifest/1.0",
  "type": "object",
  "additionalProperties": false,
  "required": ["schema_version", "metrics", "parameters", "narrative", "conclusion"],
  "properties": {
    "schema_version": {"const": "1.0"},
    "metrics": {
      "type": "object",
      "propertyNames": {"minLength": 1},
      "additionalProperties": {
        "oneOf": [{"type": "number"}, {"$ref": "#/$defs/metric"}]
      }
    },
    "artifacts": {
      "type": "array",
      "items": {"$ref": "#/$defs/artifact"},
      "default": []
    },
    "parameters": {"type": "object", "additionalProperties": true},
    "narrative": {"type": "string", "minLength": 1},
    "conclusion": {"$ref": "#/$defs/conclusion"}
  },
  "$defs": {
    "metric": {
      "type": "object",
      "additionalProperties": false,
      "required": ["value"],
      "properties": {
        "value": {"type": "number"},
        "unit": {"type": "string", "minLength": 1},
        "lower_bound": {"type": "number"},
        "upper_bound": {"type": "number"},
        "direction": {
          "enum": ["higher_is_better", "lower_is_better", "neutral"]
        },
        "description": {"type": "string"}
      }
    },
    "artifact": {
      "type": "object",
      "additionalProperties": false,
      "required": ["name", "uri"],
      "properties": {
        "name": {"type": "string", "minLength": 1},
        "uri": {"type": "string", "minLength": 1},
        "sha256": {"type": "string", "pattern": "^[A-Fa-f0-9]{64}$"},
        "media_type": {"type": "string", "minLength": 1},
        "size_bytes": {"type": "integer", "minimum": 0},
        "description": {"type": "string"}
      }
    },
    "conclusion": {
      "type": "object",
      "additionalProperties": false,
      "required": ["state", "summary"],
      "properties": {
        "state": {
          "enum": ["supported", "refuted", "mixed", "inconclusive"]
        },
        "summary": {"type": "string", "minLength": 1},
        "limitations": {
          "type": "array",
          "items": {"type": "string", "minLength": 1},
          "default": []
        }
      }
    }
  }
}
"""


class Metric(BaseModel):
    """Structured numeric metric with optional interpretation metadata."""

    model_config = ConfigDict(extra="forbid", strict=True, allow_inf_nan=False)

    value: float | int
    unit: str | None = None
    lower_bound: float | int | None = None
    upper_bound: float | int | None = None
    direction: Literal["higher_is_better", "lower_is_better", "neutral"] | None = None
    description: str | None = None


class ArtifactReference(BaseModel):
    """Immutable local or external evidence reference."""

    model_config = ConfigDict(extra="forbid", strict=True)

    name: str = Field(min_length=1)
    uri: str = Field(min_length=1)
    sha256: str | None = Field(default=None, pattern=r"^[A-Fa-f0-9]{64}$")
    media_type: str | None = None
    size_bytes: int | None = Field(default=None, ge=0)
    description: str | None = None


class Conclusion(BaseModel):
    """Scientific interpretation independent of operational run state."""

    model_config = ConfigDict(extra="forbid", strict=True)

    state: Literal["supported", "refuted", "mixed", "inconclusive"]
    summary: str = Field(min_length=1)
    limitations: list[str] = Field(default_factory=list)


class ResultManifest(BaseModel):
    """Typed representation of result-manifest schema version 1.0."""

    model_config = ConfigDict(extra="forbid", strict=True, allow_inf_nan=False)

    schema_version: Literal["1.0"]
    metrics: dict[str, float | int | Metric]
    artifacts: list[ArtifactReference] = Field(default_factory=list)
    parameters: dict[str, JsonValue]
    narrative: str = Field(min_length=1)
    conclusion: Conclusion


def _default_schema_path() -> Path | None:
    package_contract = Path(__file__).resolve().parents[3] / "contracts"
    candidate = package_contract / "result-manifest.schema.json"
    return candidate if candidate.is_file() else None


def load_result_schema(schema_path: Path | None = None) -> dict[str, object]:
    """Load the canonical schema, using an embedded wheel-safe fallback."""
    path = schema_path or _default_schema_path()
    try:
        raw = path.read_text(encoding="utf-8") if path else _EMBEDDED_SCHEMA_JSON
        payload = json.loads(raw)
    except (OSError, json.JSONDecodeError) as exc:
        location = str(path) if path else "embedded schema"
        raise ManifestError(f"cannot load result-manifest schema from {location}") from exc
    if not isinstance(payload, dict):
        raise ManifestError("result-manifest schema root must be an object")
    try:
        Draft202012Validator.check_schema(payload)
    except SchemaError as exc:
        raise ManifestError("result-manifest schema is itself invalid") from exc
    return payload


def _format_validation_error(error_path: list[object], message: str) -> str:
    location = ".".join(str(part) for part in error_path) or "<root>"
    return f"{location}: {message}"


def _reject_non_json_constant(value: str) -> NoReturn:
    raise ValueError(f"non-standard JSON numeric constant: {value}")


def load_result_manifest(
    path: Path,
    *,
    schema_path: Path | None = None,
) -> ResultManifest:
    """Read, schema-validate, and parse a result manifest."""
    try:
        size = path.stat().st_size
    except OSError as exc:
        raise ManifestError(f"cannot access result manifest: {path}") from exc
    if size > MAX_MANIFEST_BYTES:
        raise ManifestError(f"result manifest exceeds {MAX_MANIFEST_BYTES} bytes: {path}")
    try:
        payload = json.loads(
            path.read_text(encoding="utf-8"),
            parse_constant=_reject_non_json_constant,
        )
    except (OSError, ValueError) as exc:
        raise ManifestError(f"result manifest is not valid UTF-8 JSON: {path}") from exc
    if not isinstance(payload, dict):
        raise ManifestError("result manifest root must be a JSON object")

    validator = Draft202012Validator(load_result_schema(schema_path))
    errors = sorted(
        validator.iter_errors(payload),
        key=lambda error: tuple(str(part) for part in error.path),
    )
    if errors:
        details = "; ".join(
            _format_validation_error(list(error.path), error.message) for error in errors[:5]
        )
        raise ManifestError(f"result manifest failed schema validation: {details}")
    try:
        manifest = ResultManifest.model_validate(payload)
    except ValidationError as exc:
        raise ManifestError("result manifest failed typed validation") from exc
    _validate_metric_bounds(manifest)
    return manifest


def _validate_metric_bounds(manifest: ResultManifest) -> None:
    for name, metric in manifest.metrics.items():
        values: list[float | int]
        if isinstance(metric, Metric):
            values = [
                value
                for value in (metric.value, metric.lower_bound, metric.upper_bound)
                if value is not None
            ]
            if (
                metric.lower_bound is not None
                and metric.upper_bound is not None
                and metric.lower_bound > metric.upper_bound
            ):
                raise ManifestError(f"metric {name!r} has lower_bound greater than upper_bound")
        else:
            values = [metric]
        if any(not math.isfinite(float(value)) for value in values):
            raise ManifestError(f"metric {name!r} contains a non-finite number")
