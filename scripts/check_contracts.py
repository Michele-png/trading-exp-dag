"""Validate shared API and run-manifest contract documents."""

from __future__ import annotations

import json
from pathlib import Path

import yaml
from jsonschema.validators import validator_for


ROOT = Path(__file__).resolve().parents[1]
OPENAPI_PATH = ROOT / "packages" / "contracts" / "openapi.yaml"
RESULT_SCHEMA_PATH = ROOT / "packages" / "contracts" / "result-manifest.schema.json"


def main() -> None:
    """Validate that shared contracts parse and declare expected versions."""
    with OPENAPI_PATH.open(encoding="utf-8") as openapi_file:
        openapi = yaml.safe_load(openapi_file)
    if not isinstance(openapi, dict) or not str(openapi.get("openapi", "")).startswith("3."):
        raise ValueError("openapi.yaml must declare an OpenAPI 3.x document")
    if not openapi.get("paths"):
        raise ValueError("openapi.yaml must define at least one path")

    with RESULT_SCHEMA_PATH.open(encoding="utf-8") as schema_file:
        result_schema = json.load(schema_file)
    validator_cls = validator_for(result_schema)
    validator_cls.check_schema(result_schema)
    if result_schema.get("$id") is None:
        raise ValueError("result-manifest schema must declare a stable $id")

    print("Shared contracts are valid.")


if __name__ == "__main__":
    main()
