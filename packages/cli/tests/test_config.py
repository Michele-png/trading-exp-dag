"""Tests for configuration, token entropy, and owner-only permissions.

Test classes:
    - TestCredentialStore: keyring-first storage and secure fallback.
    - TestSettingsStore: validated API origin and private config file.
"""

from __future__ import annotations

import os
import stat

import pytest
from keyring.errors import NoKeyringError
from pydantic import ValidationError

from qdag.config import (
    CredentialStore,
    Settings,
    SettingsStore,
    validate_personal_token,
)
from qdag.errors import CredentialError


class MemoryKeyring:
    """In-memory keyring test double."""

    def __init__(self, *, available: bool = True) -> None:
        self.available = available
        self.password: str | None = None

    def _check(self) -> None:
        if not self.available:
            raise NoKeyringError("test backend unavailable")

    def get_password(self, _service_name: str, _username: str) -> str | None:
        self._check()
        return self.password

    def set_password(
        self,
        _service_name: str,
        _username: str,
        password: str,
    ) -> None:
        self._check()
        self.password = password

    def delete_password(self, _service_name: str, _username: str) -> None:
        self._check()
        self.password = None


class TestCredentialStore:
    """Credential storage security and fallback behavior."""

    def test_uses_keyring_when_available(
        self,
        config_paths,
        valid_token: str,
    ) -> None:
        backend = MemoryKeyring()
        store = CredentialStore(config_paths, backend)

        assert store.set_token(valid_token) == "keyring"
        assert store.get_token() == valid_token
        assert store.storage_location() == "keyring"
        assert not config_paths.credentials_file.exists()

    def test_fallback_file_is_mode_0600(
        self,
        config_paths,
        valid_token: str,
    ) -> None:
        store = CredentialStore(config_paths, MemoryKeyring(available=False))

        assert store.set_token(valid_token) == "file"
        assert store.get_token() == valid_token
        if os.name == "posix":
            assert stat.S_IMODE(config_paths.credentials_file.stat().st_mode) == 0o600
            assert stat.S_IMODE(config_paths.config_dir.stat().st_mode) == 0o700

    def test_logout_removes_keyring_and_fallback(
        self,
        config_paths,
        valid_token: str,
    ) -> None:
        unavailable = MemoryKeyring(available=False)
        fallback = CredentialStore(config_paths, unavailable)
        fallback.set_token(valid_token)
        assert config_paths.credentials_file.exists()

        fallback.delete_token()

        assert not config_paths.credentials_file.exists()

    @pytest.mark.parametrize(
        "token",
        [
            "short",
            "x" * 64,
            "valid-looking-token with whitespace 1234567890ABCD",
        ],
    )
    def test_rejects_low_entropy_or_malformed_tokens(self, token: str) -> None:
        with pytest.raises(CredentialError, match="token"):
            validate_personal_token(token)


class TestSettingsStore:
    """Non-secret configuration validation and permissions."""

    def test_round_trip_and_mode_0600(self, config_paths) -> None:
        store = SettingsStore(config_paths)
        settings = Settings(base_url="https://registry.example.test/")

        store.save(settings)

        assert store.load().base_url == "https://registry.example.test"
        if os.name == "posix":
            assert stat.S_IMODE(config_paths.settings_file.stat().st_mode) == 0o600

    @pytest.mark.parametrize(
        "base_url",
        [
            "registry.example.test",
            "ftp://registry.example.test",
            "https://user:password@registry.example.test",
            "https://registry.example.test?token=secret",
            "https://registry.example.test/api",
        ],
    )
    def test_rejects_unsafe_api_origins(self, base_url: str) -> None:
        with pytest.raises(ValidationError):
            Settings(base_url=base_url)

    def test_tightens_existing_fallback_permissions(
        self,
        config_paths,
        valid_token: str,
    ) -> None:
        config_paths.config_dir.mkdir(parents=True)
        config_paths.credentials_file.write_text(
            f'{{"personal_token": "{valid_token}", "version": 1}}',
            encoding="utf-8",
        )
        if os.name == "posix":
            config_paths.credentials_file.chmod(0o644)

        token = CredentialStore(
            config_paths,
            MemoryKeyring(available=False),
        ).get_token()

        assert token == valid_token
        if os.name == "posix":
            assert stat.S_IMODE(config_paths.credentials_file.stat().st_mode) == 0o600
