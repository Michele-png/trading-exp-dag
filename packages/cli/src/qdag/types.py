"""Shared JSON-compatible type aliases."""

from __future__ import annotations

from collections.abc import Mapping, Sequence
from typing import TypeAlias

JSONPrimitive: TypeAlias = str | int | float | bool | None
JSONValue: TypeAlias = JSONPrimitive | Sequence["JSONValue"] | Mapping[str, "JSONValue"]
JSONObject: TypeAlias = dict[str, JSONValue]
