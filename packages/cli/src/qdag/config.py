"""Secure local configuration and personal-token storage."""

from __future__ import annotations

import json
import math
import os
import stat
import tempfile
from dataclasses import dataclass
from pathlib import Path
from typing import Protocol
from urllib.parse import urlsplit, urlunsplit

import keyring
from keyring.errors import KeyringError
from platformdirs import PlatformDirs
from pydantic import BaseModel, ConfigDict, ValidationError, field_validator

from qdag.errors import ConfigurationError, CredentialError

APP_NAME = "qdag"
KEYRING_SERVICE = "qdag"
KEYRING_USERNAME = "personal-token"
DEFAULT_BASE_URL = "http://localhost:3000"
MIN_TOKEN_LENGTH = 32
MIN_TOKEN_ENTROPY_BITS = 128.0


class Settings(BaseModel):
    """Non-secret CLI settings persisted in the user configuration directory."""

    model_config = ConfigDict(extra="forbid", frozen=True)

    base_url: str = DEFAULT_BASE_URL

    @field_validator("base_url")
    @classmethod
    def validate_base_url(cls, value: str) -> str:
        """Require an origin-only HTTP(S) API base URL."""
        candidate = value.strip().rstrip("/")
        parsed = urlsplit(candidate)
        if parsed.scheme not in {"http", "https"} or not parsed.netloc:
            raise ValueError("base_url must be an absolute http:// or https:// URL")
        if parsed.username or parsed.password:
            raise ValueError("base_url must not contain credentials")
        if parsed.query or parsed.fragment:
            raise ValueError("base_url must not contain a query string or fragment")
        if parsed.path not in {"", "/"}:
            raise ValueError("base_url must be an origin without a path")
        return urlunsplit((parsed.scheme, parsed.netloc, "", "", ""))


@dataclass(frozen=True, slots=True)
class ConfigPaths:
    """Filesystem locations used by qdag."""

    config_dir: Path
    state_dir: Path
    settings_file: Path
    credentials_file: Path

    @classmethod
    def default(cls) -> ConfigPaths:
        """Build platform-appropriate user configuration and state paths."""
        dirs = PlatformDirs(APP_NAME, appauthor=False)
        config_dir = Path(dirs.user_config_dir)
        state_dir = Path(dirs.user_state_dir)
        return cls(
            config_dir=config_dir,
            state_dir=state_dir,
            settings_file=config_dir / "config.json",
            credentials_file=config_dir / "credentials.json",
        )


class KeyringBackend(Protocol):
    """Minimal keyring interface used by :class:`CredentialStore`."""

    def get_password(self, service_name: str, username: str) -> str | None:
        """Read a password from the OS credential store."""

    def set_password(self, service_name: str, username: str, password: str) -> None:
        """Write a password to the OS credential store."""

    def delete_password(self, service_name: str, username: str) -> None:
        """Delete a password from the OS credential store."""


def validate_personal_token(token: str) -> str:
    """Validate that a personal token has enough apparent entropy.

    This is a format sanity check, not a substitute for server-side token
    generation. The API should generate tokens with a CSPRNG.
    """
    normalized = token.strip()
    if len(normalized) < MIN_TOKEN_LENGTH:
        raise CredentialError(f"personal token must contain at least {MIN_TOKEN_LENGTH} characters")
    alphabet_size = len(set(normalized))
    entropy_upper_bound = len(normalized) * math.log2(max(alphabet_size, 1))
    if entropy_upper_bound < MIN_TOKEN_ENTROPY_BITS:
        raise CredentialError(
            "personal token does not appear to contain at least 128 bits of entropy"
        )
    if any(character.isspace() for character in normalized):
        raise CredentialError("personal token must not contain whitespace")
    return normalized


def _ensure_private_directory(path: Path) -> None:
    path.mkdir(mode=0o700, parents=True, exist_ok=True)
    if os.name == "posix":
        path.chmod(0o700)


def _atomic_write_private_json(path: Path, payload: object) -> None:
    """Atomically write JSON with owner-only permissions."""
    _ensure_private_directory(path.parent)
    serialized = (json.dumps(payload, indent=2, sort_keys=True, ensure_ascii=False) + "\n").encode(
        "utf-8"
    )
    file_descriptor, temporary_name = tempfile.mkstemp(prefix=f".{path.name}.", dir=path.parent)
    temporary_path = Path(temporary_name)
    try:
        if os.name == "posix":
            os.fchmod(file_descriptor, 0o600)
        with os.fdopen(file_descriptor, "wb") as handle:
            handle.write(serialized)
            handle.flush()
            os.fsync(handle.fileno())
        os.replace(temporary_path, path)
        if os.name == "posix":
            path.chmod(0o600)
    except Exception:
        temporary_path.unlink(missing_ok=True)
        raise


def _read_private_json(path: Path) -> object:
    if not path.exists():
        raise FileNotFoundError(path)
    if os.name == "posix":
        mode = stat.S_IMODE(path.stat().st_mode)
        if mode & 0o077:
            try:
                path.chmod(0o600)
            except OSError as exc:
                raise CredentialError(f"cannot secure credential file permissions: {path}") from exc
    try:
        return json.loads(path.read_text(encoding="utf-8"))
    except (OSError, json.JSONDecodeError) as exc:
        raise ConfigurationError(f"cannot read valid JSON from {path}") from exc


class SettingsStore:
    """Read and write non-secret CLI settings."""

    def __init__(self, paths: ConfigPaths | None = None) -> None:
        self.paths = paths or ConfigPaths.default()

    def load(self) -> Settings:
        """Load settings, returning defaults when no file exists."""
        try:
            payload = _read_private_json(self.paths.settings_file)
        except FileNotFoundError:
            return Settings()
        try:
            return Settings.model_validate(payload)
        except ValidationError as exc:
            raise ConfigurationError(
                f"invalid qdag configuration: {self.paths.settings_file}"
            ) from exc

    def save(self, settings: Settings) -> None:
        """Persist settings with owner-only permissions."""
        _atomic_write_private_json(
            self.paths.settings_file,
            settings.model_dump(mode="json"),
        )


class CredentialStore:
    """Store the personal token in keyring, with a private-file fallback."""

    def __init__(
        self,
        paths: ConfigPaths | None = None,
        keyring_backend: KeyringBackend | None = None,
    ) -> None:
        self.paths = paths or ConfigPaths.default()
        self._keyring = keyring_backend or keyring

    def set_token(self, token: str) -> str:
        """Persist a validated token and return the storage mechanism used."""
        normalized = validate_personal_token(token)
        try:
            self._keyring.set_password(
                KEYRING_SERVICE,
                KEYRING_USERNAME,
                normalized,
            )
        except KeyringError:
            _atomic_write_private_json(
                self.paths.credentials_file,
                {"personal_token": normalized, "version": 1},
            )
            return "file"
        self.paths.credentials_file.unlink(missing_ok=True)
        return "keyring"

    def get_token(self) -> str | None:
        """Read the token from keyring, then the secure fallback file."""
        try:
            token = self._keyring.get_password(
                KEYRING_SERVICE,
                KEYRING_USERNAME,
            )
        except KeyringError:
            token = None
        if token:
            return validate_personal_token(token)

        try:
            payload = _read_private_json(self.paths.credentials_file)
        except FileNotFoundError:
            return None
        if not isinstance(payload, dict) or not isinstance(payload.get("personal_token"), str):
            raise CredentialError("credential fallback file has an invalid format")
        return validate_personal_token(payload["personal_token"])

    def storage_location(self) -> str | None:
        """Return where the current token is stored without exposing it."""
        try:
            if self._keyring.get_password(KEYRING_SERVICE, KEYRING_USERNAME):
                return "keyring"
        except KeyringError:
            pass
        return "file" if self.paths.credentials_file.exists() else None

    def delete_token(self) -> None:
        """Remove the token from both keyring and fallback storage."""
        try:
            self._keyring.delete_password(KEYRING_SERVICE, KEYRING_USERNAME)
        except KeyringError:
            pass
        self.paths.credentials_file.unlink(missing_ok=True)
