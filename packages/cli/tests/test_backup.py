"""Tests for deterministic encrypted backup and safe restore.

Test classes:
    - TestDeterministicArchive: canonical bytes and checksums.
    - TestAuthenticatedEncryption: round trip and tamper rejection.
    - TestSafeExtraction: path-traversal defenses.
    - TestBackupManagerRoundTrip: API export to API restore.
"""

from __future__ import annotations

import hashlib
import io
import os
import stat
import zipfile
from pathlib import Path

import pytest

from qdag.backup import BackupManager
from qdag.backup_archive import (
    build_backup_archive,
    decrypt_backup,
    encrypt_backup,
    read_encrypted_backup,
    safe_extract_archive,
    verify_backup_archive,
)
from qdag.endpoints import BACKUPS_EXPORT, BACKUPS_RESTORE
from qdag.errors import BackupIntegrityError, UnsafeArchiveError
from qdag.types import JSONObject, JSONValue

PASSPHRASE = "correct horse battery staple"
EXPORTED_AT = "2026-07-10T20:00:00+00:00"


def _archive() -> bytes:
    return build_backup_archive(
        records={
            "spaces": [{"id": "space-1", "name": "Research"}],
            "experiments": [{"id": "experiment-1", "state": "finalized"}],
        },
        schema_versions={"records": "1", "result_manifest": "1.0"},
        exported_at=EXPORTED_AT,
        artifacts={"plots/equity.txt": b"equity curve\n"},
    )


class TestDeterministicArchive:
    """Identical logical exports produce identical verified bytes."""

    def test_build_is_byte_for_byte_deterministic(self) -> None:
        first = _archive()
        second = _archive()

        assert first == second
        verified = verify_backup_archive(first)
        assert verified.manifest["bundle_version"] == 1
        assert verified.files["artifacts/plots/equity.txt"] == b"equity curve\n"


class TestAuthenticatedEncryption:
    """Reject ciphertext tampering and recover exact plaintext."""

    def test_encrypt_decrypt_round_trip(self) -> None:
        archive = _archive()

        encrypted = encrypt_backup(archive, PASSPHRASE)
        decrypted = decrypt_backup(encrypted, PASSPHRASE)

        assert decrypted == archive

    def test_tamper_is_detected(self) -> None:
        encrypted = bytearray(encrypt_backup(_archive(), PASSPHRASE))
        encrypted[-1] ^= 0x01

        with pytest.raises(BackupIntegrityError, match="authentication failed"):
            decrypt_backup(bytes(encrypted), PASSPHRASE)

    def test_wrong_passphrase_is_indistinguishable_from_tamper(self) -> None:
        encrypted = encrypt_backup(_archive(), PASSPHRASE)

        with pytest.raises(BackupIntegrityError, match="authentication failed"):
            decrypt_backup(encrypted, "different secure passphrase")


class TestSafeExtraction:
    """Validate every member before writing anything to disk."""

    def test_path_traversal_member_is_rejected(self, tmp_path: Path) -> None:
        buffer = io.BytesIO()
        with zipfile.ZipFile(buffer, "w") as archive:
            archive.writestr("../outside.txt", b"escape")

        with pytest.raises(UnsafeArchiveError, match="unsafe archive member"):
            verify_backup_archive(buffer.getvalue())
        assert not (tmp_path / "outside.txt").exists()

    def test_verified_archive_extracts_without_symlinks(self, tmp_path: Path) -> None:
        destination = tmp_path / "restore"

        verified = safe_extract_archive(_archive(), destination)

        assert (destination / "records" / "spaces.json").is_file()
        assert (destination / "artifacts" / "plots" / "equity.txt").read_bytes() == (
            b"equity curve\n"
        )
        assert verified.sha256 == verify_backup_archive(_archive()).sha256

    @pytest.mark.skipif(os.name == "nt", reason="symlink creation requires privileges")
    def test_symlink_destination_is_rejected(self, tmp_path: Path) -> None:
        real_destination = tmp_path / "outside"
        real_destination.mkdir()
        destination = tmp_path / "restore-link"
        destination.symlink_to(real_destination, target_is_directory=True)

        with pytest.raises(UnsafeArchiveError, match="symlink restore destination"):
            safe_extract_archive(_archive(), destination)


class FakeBackupAPI:
    """In-memory API export and restore test double."""

    def __init__(self) -> None:
        self.restore_calls: list[tuple[str, JSONObject, str | None]] = []

    def get(
        self,
        path: str,
        *,
        params: dict[str, object] | None = None,
    ) -> JSONValue:
        assert path == BACKUPS_EXPORT
        assert params == {"include_artifacts": False}
        return {
            "exported_at": EXPORTED_AT,
            "schema_versions": {"records": "1"},
            "records": {
                "spaces": [{"id": "space-1", "name": "Research"}],
                "experiments": [{"id": "experiment-1", "status": "finalized"}],
            },
            "markdown": {
                "spaces": "# Spaces\n\nOne space.\n",
                "experiments": "# Experiments\n\nOne experiment.\n",
            },
            "artifacts": [],
        }

    def post(
        self,
        path: str,
        payload: JSONObject,
        *,
        idempotency_key: str | None = None,
    ) -> JSONValue:
        self.restore_calls.append((path, payload, idempotency_key))
        return {"restored": True}


class TestBackupManagerRoundTrip:
    """Export records, encrypt locally, then verify and restore them."""

    def test_round_trip_and_private_file_mode(self, tmp_path: Path) -> None:
        api = FakeBackupAPI()
        manager = BackupManager(api)
        output_directory = tmp_path / "exports"
        output_directory.mkdir(mode=0o755)
        if os.name == "posix":
            output_directory.chmod(0o755)
        backup_path = output_directory / "registry.qdag"

        created = manager.create(backup_path, passphrase=PASSPHRASE)
        restored = manager.restore(
            backup_path,
            passphrase=PASSPHRASE,
            extract_to=tmp_path / "extracted",
        )
        offline = BackupManager(None).restore(
            backup_path,
            passphrase=PASSPHRASE,
            dry_run=True,
        )

        assert created.archive_sha256 == restored.archive_sha256
        assert offline.archive_sha256 == created.archive_sha256
        assert offline.api_response is None
        assert restored.record_resources == ("experiments", "spaces")
        assert restored.api_response == {"restored": True}
        assert api.restore_calls[0][0] == BACKUPS_RESTORE
        assert api.restore_calls[0][2] == (f"backup-restore:{created.archive_sha256}")
        restore_payload = api.restore_calls[0][1]
        assert restore_payload["records"]["spaces"][0]["id"] == "space-1"
        plaintext = read_encrypted_backup(backup_path, PASSPHRASE)
        assert verify_backup_archive(plaintext).sha256 == created.archive_sha256
        if os.name == "posix":
            assert stat.S_IMODE(backup_path.stat().st_mode) == 0o600
            assert stat.S_IMODE(output_directory.stat().st_mode) == 0o755

    def test_optional_artifact_is_downloaded_without_persisting_signed_url(
        self,
        tmp_path: Path,
    ) -> None:
        artifact_data = b"small private artifact\n"
        signed_url = "https://objects.example.test/file?signature=secret"

        class ArtifactAPI(FakeBackupAPI):
            def get(
                self,
                path: str,
                *,
                params: dict[str, object] | None = None,
            ) -> JSONValue:
                assert path == BACKUPS_EXPORT
                assert params == {"include_artifacts": True}
                return {
                    "exported_at": EXPORTED_AT,
                    "schema_versions": {"records": "1"},
                    "records": {"spaces": []},
                    "markdown": {},
                    "artifacts": [
                        {
                            "path": "evidence/output.txt",
                            "download_url": signed_url,
                            "size_bytes": len(artifact_data),
                            "sha256": hashlib.sha256(artifact_data).hexdigest(),
                        }
                    ],
                }

        class Downloader:
            def download(self, url: str, **_kwargs: object) -> bytes:
                assert url == signed_url
                return artifact_data

        backup_path = tmp_path / "artifacts.qdag"
        BackupManager(ArtifactAPI(), downloader=Downloader()).create(
            backup_path,
            passphrase=PASSPHRASE,
            include_artifacts=True,
        )

        archive = read_encrypted_backup(backup_path, PASSPHRASE)
        verified = verify_backup_archive(archive)
        assert verified.files["artifacts/evidence/output.txt"] == artifact_data
        assert signed_url.encode() not in archive
