"""Portable path aliases and credential-safe URL normalization."""

from __future__ import annotations

import re
from pathlib import Path
from urllib.parse import SplitResult, urlsplit, urlunsplit

from qdag.types import JSONValue

_SCP_REMOTE = re.compile(r"^(?:(?P<user>[^@\s/:]+)@)?(?P<host>[^:\s/]+):(?P<path>.+)$")
_SENSITIVE_OPTION = re.compile(
    r"(?:api[-_]?key|credential|password|passwd|secret|token)",
    flags=re.IGNORECASE,
)
REDACTED_ARGUMENT = "<redacted>"


def sanitize_url(value: str) -> str:
    """Remove user information, query parameters, and fragments from a URL.

    Signed query parameters are intentionally stripped wholesale because
    reliably distinguishing a signature from an ordinary query parameter is
    impossible at the client boundary.
    """
    candidate = value.strip()
    if "://" not in candidate:
        scp_match = _SCP_REMOTE.fullmatch(candidate)
        if scp_match and scp_match.group("user"):
            return f"{scp_match.group('host')}:{scp_match.group('path')}"
        return value

    try:
        parsed = urlsplit(candidate)
        hostname = parsed.hostname
        if not hostname:
            return value
        host = f"[{hostname}]" if ":" in hostname else hostname
        if parsed.port is not None:
            host = f"{host}:{parsed.port}"
        sanitized = SplitResult(
            scheme=parsed.scheme,
            netloc=host,
            path=parsed.path,
            query="",
            fragment="",
        )
        return urlunsplit(sanitized)
    except (ValueError, UnicodeError):
        return value


class PathNormalizer:
    """Replace machine-specific roots with ``$REPO`` and ``$HOME`` aliases."""

    def __init__(
        self,
        *,
        repo_root: Path | None,
        home: Path | None = None,
    ) -> None:
        self.repo_root = repo_root.expanduser().resolve(strict=False) if repo_root else None
        self.home = (home or Path.home()).expanduser().resolve(strict=False)

    def normalize_path(self, path: str | Path) -> str:
        """Return a portable representation for one path."""
        candidate = Path(path).expanduser()
        if not candidate.is_absolute():
            return candidate.as_posix()
        resolved = candidate.resolve(strict=False)
        if self.repo_root and resolved.is_relative_to(self.repo_root):
            relative = resolved.relative_to(self.repo_root)
            return "$REPO" if not relative.parts else f"$REPO/{relative.as_posix()}"
        if resolved.is_relative_to(self.home):
            relative = resolved.relative_to(self.home)
            return "$HOME" if not relative.parts else f"$HOME/{relative.as_posix()}"
        return resolved.as_posix()

    def normalize_argument(self, argument: str) -> str:
        """Normalize a command argument without interpreting shell syntax."""
        prefix = ""
        value = argument
        if argument.startswith("-") and "=" in argument:
            key, value = argument.split("=", 1)
            prefix = f"{key}="

        if "://" in value or _SCP_REMOTE.fullmatch(value):
            value = sanitize_url(value)
        elif Path(value).is_absolute():
            value = self.normalize_path(value)
        else:
            value = self._replace_embedded_roots(value)
        return f"{prefix}{value}"

    def normalize_command(self, command: list[str]) -> list[str]:
        """Normalize arguments and redact values of explicitly sensitive flags."""
        normalized: list[str] = []
        redact_next = False
        for argument in command:
            if redact_next:
                normalized.append(REDACTED_ARGUMENT)
                redact_next = False
                continue
            assignment_name, assignment_separator, _assignment_value = argument.partition("=")
            if (
                assignment_separator
                and not argument.startswith("-")
                and assignment_name.isidentifier()
                and _SENSITIVE_OPTION.search(assignment_name)
            ):
                normalized.append(f"{assignment_name}={REDACTED_ARGUMENT}")
                continue
            if argument.startswith("-"):
                option, separator, _value = argument.partition("=")
                if _SENSITIVE_OPTION.search(option):
                    if separator:
                        normalized.append(f"{option}={REDACTED_ARGUMENT}")
                    else:
                        normalized.append(option)
                        redact_next = True
                    continue
            normalized.append(self.normalize_argument(argument))
        return normalized

    def _replace_embedded_roots(self, value: str) -> str:
        replacements: list[tuple[str, str]] = []
        if self.repo_root:
            replacements.append((str(self.repo_root), "$REPO"))
        replacements.append((str(self.home), "$HOME"))
        normalized = value
        for raw_root, alias in replacements:
            normalized = normalized.replace(raw_root, alias)
        return normalized

    def normalize_value(self, value: object) -> JSONValue:
        """Recursively normalize JSON-compatible metadata values."""
        if value is None or isinstance(value, bool | int | float):
            return value
        if isinstance(value, Path):
            return self.normalize_path(value)
        if isinstance(value, str):
            return self.normalize_argument(value)
        if isinstance(value, list | tuple):
            return [self.normalize_value(item) for item in value]
        if isinstance(value, dict):
            return {str(key): self.normalize_value(item) for key, item in value.items()}
        return str(value)
