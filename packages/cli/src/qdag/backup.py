"""API-backed creation and restoration of encrypted portable backups."""

from __future__ import annotations

import base64
import hashlib
import json
import time
from collections.abc import Mapping
from dataclasses import dataclass
from datetime import UTC, datetime
from pathlib import Path
from typing import Protocol, cast

import httpx

from qdag.backup_archive import (
    MAX_ARCHIVE_BYTES,
    MAX_MEMBER_BYTES,
    VerifiedBackup,
    build_backup_archive,
    encrypt_backup,
    read_encrypted_backup,
    safe_extract_archive,
    verify_backup_archive,
    write_encrypted_backup,
)
from qdag.endpoints import BACKUPS_EXPORT, BACKUPS_RESTORE
from qdag.errors import BackupError, BackupIntegrityError
from qdag.types import JSONObject, JSONValue

DEFAULT_TOTAL_ARTIFACT_BYTES = 512 * 1024 * 1024
DOWNLOAD_RETRY_STATUSES = frozenset({408, 425, 429, 500, 502, 503, 504})


class BackupAPI(Protocol):
    """HTTP operations used by backup export and restore."""

    def get(
        self,
        path: str,
        *,
        params: Mapping[str, str | int | float | bool | None] | None = None,
    ) -> JSONValue:
        """Read a canonical export."""

    def post(
        self,
        path: str,
        payload: JSONObject,
        *,
        idempotency_key: str | None = None,
    ) -> JSONValue:
        """Submit an idempotent restore."""


@dataclass(frozen=True, slots=True)
class BackupSummary:
    """Result of creating one encrypted backup."""

    path: Path
    archive_sha256: str
    encrypted_size_bytes: int
    record_resources: tuple[str, ...]
    artifact_count: int


@dataclass(frozen=True, slots=True)
class RestoreSummary:
    """Verified restore result and optional API response."""

    archive_sha256: str
    record_resources: tuple[str, ...]
    artifact_count: int
    api_response: JSONValue
    extracted_to: Path | None = None


class ArtifactDownloader:
    """Download bounded signed artifact URLs without API authorization headers."""

    def __init__(
        self,
        *,
        timeout: float = 60.0,
        max_attempts: int = 3,
        transport: httpx.BaseTransport | None = None,
    ) -> None:
        self.timeout = timeout
        self.max_attempts = max_attempts
        self.transport = transport

    def download(
        self,
        url: str,
        *,
        display_path: str,
        expected_sha256: str | None,
        expected_size: int | None,
    ) -> bytes:
        """Download and verify one small private artifact."""
        if self.max_attempts < 1:
            raise ValueError("max_attempts must be at least 1")
        if expected_size is not None and expected_size > MAX_MEMBER_BYTES:
            raise BackupError(f"artifact exceeds the size cap: {display_path}")

        data: bytes | None = None
        with httpx.Client(
            timeout=self.timeout,
            transport=self.transport,
            follow_redirects=False,
        ) as client:
            for attempt in range(1, self.max_attempts + 1):
                try:
                    with client.stream("GET", url) as response:
                        if (
                            response.status_code in DOWNLOAD_RETRY_STATUSES
                            and attempt < self.max_attempts
                        ):
                            time.sleep(min(0.2 * float(2 ** (attempt - 1)), 2.0))
                            continue
                        if response.is_error:
                            raise BackupError(
                                f"artifact download failed for {display_path} "
                                f"(HTTP {response.status_code})"
                            )
                        content_length = response.headers.get("content-length")
                        if content_length and content_length.isdigit():
                            if int(content_length) > MAX_MEMBER_BYTES:
                                raise BackupError(
                                    f"downloaded artifact is too large: {display_path}"
                                )
                        buffer = bytearray()
                        for chunk in response.iter_bytes():
                            buffer.extend(chunk)
                            if len(buffer) > MAX_MEMBER_BYTES:
                                raise BackupError(
                                    f"downloaded artifact is too large: {display_path}"
                                )
                        data = bytes(buffer)
                        break
                except httpx.RequestError as exc:
                    if attempt >= self.max_attempts:
                        raise BackupError(f"artifact download failed: {display_path}") from exc
                    time.sleep(min(0.2 * float(2 ** (attempt - 1)), 2.0))
        if data is None:
            raise BackupError(f"artifact download failed: {display_path}")
        if expected_size is not None and len(data) != expected_size:
            raise BackupIntegrityError(f"downloaded artifact size mismatch: {display_path}")
        digest = hashlib.sha256(data).hexdigest()
        if expected_sha256 is not None and digest != expected_sha256.lower():
            raise BackupIntegrityError(f"downloaded artifact checksum mismatch: {display_path}")
        return data


def _unwrap_export(payload: JSONValue) -> JSONObject:
    if not isinstance(payload, dict):
        raise BackupError("backup export response must be an object")
    data = payload.get("data")
    if isinstance(data, dict) and "records" in data:
        return cast(JSONObject, data)
    return cast(JSONObject, payload)


def _parse_string_mapping(value: JSONValue, *, field: str) -> dict[str, str]:
    if not isinstance(value, dict):
        raise BackupError(f"backup export {field} must be an object")
    result: dict[str, str] = {}
    for key, item in value.items():
        if not isinstance(item, str):
            raise BackupError(f"backup export {field} values must be strings")
        result[str(key)] = item
    return result


class BackupManager:
    """Coordinate API export/restore with the portable encrypted bundle format."""

    def __init__(
        self,
        client: BackupAPI | None,
        *,
        downloader: ArtifactDownloader | None = None,
    ) -> None:
        self.client = client
        self.downloader = downloader or ArtifactDownloader()

    def create(
        self,
        output_path: Path,
        *,
        passphrase: str,
        include_artifacts: bool = False,
        max_total_artifact_bytes: int = DEFAULT_TOTAL_ARTIFACT_BYTES,
    ) -> BackupSummary:
        """Export canonical records and write an authenticated encrypted backup."""
        if max_total_artifact_bytes < 0:
            raise ValueError("max_total_artifact_bytes must be non-negative")
        client = self._require_client()
        exported_raw = client.get(
            BACKUPS_EXPORT,
            params={"include_artifacts": include_artifacts},
        )
        exported = _unwrap_export(exported_raw)
        raw_records = exported.get("records")
        if not isinstance(raw_records, dict):
            raise BackupError("backup export response is missing records")
        records = cast(dict[str, JSONValue], raw_records)
        schema_versions = _parse_string_mapping(
            exported.get("schema_versions", {}),
            field="schema_versions",
        )
        raw_markdown = exported.get("markdown", {})
        markdown = _parse_string_mapping(raw_markdown, field="markdown")
        exported_at = exported.get("exported_at")
        if not isinstance(exported_at, str) or not exported_at:
            exported_at = datetime.now(UTC).isoformat()

        artifacts: dict[str, bytes] = {}
        if include_artifacts:
            raw_artifacts = exported.get("artifacts", [])
            if not isinstance(raw_artifacts, list):
                raise BackupError("backup export artifacts must be an array")
            total = 0
            for raw_artifact in raw_artifacts:
                path, data = self._download_artifact(raw_artifact)
                total += len(data)
                if total > max_total_artifact_bytes:
                    raise BackupError("downloaded artifacts exceed the total size cap")
                if path in artifacts:
                    raise BackupError(f"duplicate exported artifact path: {path}")
                artifacts[path] = data

        archive = build_backup_archive(
            records=records,
            schema_versions=schema_versions,
            exported_at=exported_at,
            markdown_records=markdown,
            artifacts=artifacts,
        )
        verified = verify_backup_archive(archive)
        encrypted = encrypt_backup(archive, passphrase)
        write_encrypted_backup(output_path, encrypted)
        return BackupSummary(
            path=output_path,
            archive_sha256=verified.sha256,
            encrypted_size_bytes=len(encrypted),
            record_resources=tuple(sorted(records)),
            artifact_count=len(artifacts),
        )

    def restore(
        self,
        backup_path: Path,
        *,
        passphrase: str,
        extract_to: Path | None = None,
        dry_run: bool = False,
    ) -> RestoreSummary:
        """Verify/decrypt a backup and optionally restore it through the API."""
        archive = read_encrypted_backup(backup_path, passphrase)
        verified = verify_backup_archive(archive)
        if extract_to is not None:
            safe_extract_archive(archive, extract_to)
        records = self._records_from_verified(verified)
        artifacts = self._artifacts_from_verified(verified)

        response: JSONValue = None
        if not dry_run:
            client = self._require_client()
            restore_payload: JSONObject = {
                "bundle_version": verified.manifest["bundle_version"],
                "archive_sha256": verified.sha256,
                "manifest": verified.manifest,
                "records": records,
                "artifacts": artifacts,
            }
            response = client.post(
                BACKUPS_RESTORE,
                restore_payload,
                idempotency_key=f"backup-restore:{verified.sha256}",
            )
        return RestoreSummary(
            archive_sha256=verified.sha256,
            record_resources=tuple(sorted(records)),
            artifact_count=len(artifacts),
            api_response=response,
            extracted_to=extract_to,
        )

    def _require_client(self) -> BackupAPI:
        if self.client is None:
            raise BackupError("an authenticated API client is required for this operation")
        return self.client

    def _download_artifact(self, raw: JSONValue) -> tuple[str, bytes]:
        if not isinstance(raw, dict):
            raise BackupError("backup artifact descriptor must be an object")
        path = raw.get("path")
        url = raw.get("download_url")
        sha256 = raw.get("sha256")
        size = raw.get("size_bytes")
        if not isinstance(path, str) or not path:
            raise BackupError("backup artifact descriptor is missing path")
        if not isinstance(url, str) or not url:
            raise BackupError(f"backup artifact descriptor is missing download URL: {path}")
        if sha256 is not None and not isinstance(sha256, str):
            raise BackupError(f"backup artifact checksum is invalid: {path}")
        if size is not None and (not isinstance(size, int) or isinstance(size, bool) or size < 0):
            raise BackupError(f"backup artifact size is invalid: {path}")
        data = self.downloader.download(
            url,
            display_path=path,
            expected_sha256=sha256,
            expected_size=size,
        )
        return path, data

    @staticmethod
    def _records_from_verified(verified: VerifiedBackup) -> dict[str, JSONValue]:
        raw_index = verified.manifest.get("records")
        if not isinstance(raw_index, dict):
            raise BackupIntegrityError("verified backup record index is invalid")
        records: dict[str, JSONValue] = {}
        for resource, descriptor in raw_index.items():
            if not isinstance(descriptor, dict):
                raise BackupIntegrityError("verified backup record descriptor is invalid")
            json_path = descriptor.get("json_path")
            if not isinstance(json_path, str):
                raise BackupIntegrityError("verified backup record path is invalid")
            try:
                decoded = json.loads(verified.files[json_path])
            except (KeyError, ValueError, UnicodeDecodeError) as exc:
                raise BackupIntegrityError(f"backup record JSON is invalid: {resource}") from exc
            records[str(resource)] = cast(JSONValue, decoded)
        return records

    @staticmethod
    def _artifacts_from_verified(verified: VerifiedBackup) -> list[JSONObject]:
        artifacts: list[JSONObject] = []
        for path, data in sorted(verified.files.items()):
            if not path.startswith("artifacts/"):
                continue
            artifacts.append(
                {
                    "path": path.removeprefix("artifacts/"),
                    "size_bytes": len(data),
                    "sha256": hashlib.sha256(data).hexdigest(),
                    "content_base64": base64.b64encode(data).decode("ascii"),
                }
            )
        encoded_size = sum(len(str(item["content_base64"])) for item in artifacts)
        if encoded_size > MAX_ARCHIVE_BYTES:
            raise BackupError("restore artifact payload exceeds the size cap")
        return artifacts
