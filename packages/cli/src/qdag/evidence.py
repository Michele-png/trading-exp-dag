"""Secret-aware preparation and upload of optional run evidence."""

from __future__ import annotations

import hashlib
import json
import os
import subprocess
import tempfile
from dataclasses import dataclass
from pathlib import Path

import httpx
from detect_secrets.core.secrets_collection import SecretsCollection
from detect_secrets.settings import default_settings

from qdag.client import APIClient
from qdag.endpoints import ARTIFACTS_PREPARE, artifact_finalize
from qdag.errors import EvidenceError, SecretDetectedError
from qdag.types import JSONObject, JSONValue

DEFAULT_PATCH_MAX_BYTES = 5 * 1024 * 1024
DEFAULT_LOG_MAX_BYTES = 10 * 1024 * 1024
LOW_CONFIDENCE_SECRET_TYPES = frozenset(
    {
        "Base64 High Entropy String",
        "Hex High Entropy String",
        "Public IP (ipv4)",
        "Secret Keyword",
    }
)


@dataclass(frozen=True, slots=True)
class SecretFinding:
    """One redacted detect-secrets finding."""

    secret_type: str
    line_number: int
    secret_hash: str
    high_confidence: bool

    def as_payload(self) -> JSONObject:
        """Return audit-safe metadata without the detected value."""
        return {
            "type": self.secret_type,
            "line_number": self.line_number,
            "hashed_secret": self.secret_hash,
            "high_confidence": self.high_confidence,
        }


@dataclass(frozen=True, slots=True)
class SecretScanReport:
    """Redacted scan findings and explicit-override state."""

    findings: tuple[SecretFinding, ...]
    override_used: bool

    @property
    def high_confidence_count(self) -> int:
        """Return the number of blocking findings."""
        return sum(finding.high_confidence for finding in self.findings)

    def as_payload(self) -> JSONObject:
        """Return audit metadata suitable for API payloads."""
        types = sorted({finding.secret_type for finding in self.findings})
        return {
            "scanner": "detect-secrets",
            "finding_count": len(self.findings),
            "high_confidence_count": self.high_confidence_count,
            "finding_types": types,
            "override_used": self.override_used,
            "findings": [finding.as_payload() for finding in self.findings],
        }


class SecretScanner:
    """Run detect-secrets and block high-confidence findings by default."""

    def scan(
        self,
        data: bytes,
        *,
        source_name: str,
        allow_secrets: bool = False,
    ) -> SecretScanReport:
        """Scan bytes and return redacted findings.

        Args:
            data: Evidence bytes to scan.
            source_name: Display name used only for a temporary-file suffix.
            allow_secrets: Explicitly permit high-confidence findings.

        Raises:
            SecretDetectedError: If blocking findings exist without an override.
        """
        suffix = Path(source_name).suffix or ".txt"
        descriptor, temporary_name = tempfile.mkstemp(prefix="qdag-scan-", suffix=suffix)
        temporary_path = Path(temporary_name)
        try:
            with os.fdopen(descriptor, "wb") as handle:
                handle.write(data)
            collection = SecretsCollection()
            with default_settings():
                collection.scan_file(str(temporary_path))
            findings = self._parse_findings(collection.json())
        finally:
            temporary_path.unlink(missing_ok=True)

        high_confidence = tuple(finding for finding in findings if finding.high_confidence)
        if high_confidence and not allow_secrets:
            locations = ", ".join(
                f"{finding.secret_type} at line {finding.line_number}"
                for finding in high_confidence
            )
            raise SecretDetectedError(
                f"evidence upload blocked by high-confidence secret(s): {locations}"
            )
        return SecretScanReport(
            findings=tuple(findings),
            override_used=bool(high_confidence and allow_secrets),
        )

    @staticmethod
    def _parse_findings(payload: dict[str, object]) -> list[SecretFinding]:
        findings: list[SecretFinding] = []
        for raw_items in payload.values():
            if not isinstance(raw_items, list):
                continue
            for raw in raw_items:
                if not isinstance(raw, dict):
                    continue
                secret_type = str(raw.get("type", "Unknown"))
                line_number = raw.get("line_number", 0)
                secret_hash = raw.get("hashed_secret", "")
                findings.append(
                    SecretFinding(
                        secret_type=secret_type,
                        line_number=(line_number if isinstance(line_number, int) else 0),
                        secret_hash=(secret_hash if isinstance(secret_hash, str) else ""),
                        high_confidence=(secret_type not in LOW_CONFIDENCE_SECRET_TYPES),
                    )
                )
        findings.sort(
            key=lambda finding: (
                finding.line_number,
                finding.secret_type,
                finding.secret_hash,
            )
        )
        return findings


@dataclass(frozen=True, slots=True)
class EvidenceBlob:
    """Bounded evidence bytes plus integrity and secret-scan metadata."""

    kind: str
    filename: str
    media_type: str
    data: bytes
    sha256: str
    secret_scan: SecretScanReport

    @classmethod
    def prepare(
        cls,
        *,
        kind: str,
        filename: str,
        media_type: str,
        data: bytes,
        max_bytes: int,
        allow_secrets: bool,
        scanner: SecretScanner | None = None,
    ) -> EvidenceBlob:
        """Validate size, scan content, and compute its checksum."""
        if max_bytes < 1:
            raise ValueError("max_bytes must be positive")
        if len(data) > max_bytes:
            raise EvidenceError(f"{kind} evidence exceeds the {max_bytes}-byte size cap")
        report = (scanner or SecretScanner()).scan(
            data,
            source_name=filename,
            allow_secrets=allow_secrets,
        )
        return cls(
            kind=kind,
            filename=Path(filename).name,
            media_type=media_type,
            data=data,
            sha256=hashlib.sha256(data).hexdigest(),
            secret_scan=report,
        )


def capture_git_patch(
    cwd: Path,
    *,
    max_bytes: int = DEFAULT_PATCH_MAX_BYTES,
    allow_secrets: bool = False,
    scanner: SecretScanner | None = None,
) -> EvidenceBlob:
    """Capture the tracked working-tree patch as optional evidence."""
    try:
        completed = subprocess.run(
            ["git", "diff", "--binary", "--no-ext-diff", "HEAD", "--"],
            cwd=cwd,
            check=False,
            capture_output=True,
            timeout=15,
        )
    except (FileNotFoundError, OSError, subprocess.TimeoutExpired) as exc:
        raise EvidenceError("unable to capture Git patch") from exc
    if completed.returncode != 0:
        raise EvidenceError("unable to capture Git patch from the current repository")
    return EvidenceBlob.prepare(
        kind="patch",
        filename="working-tree.patch",
        media_type="text/x-diff",
        data=completed.stdout,
        max_bytes=max_bytes,
        allow_secrets=allow_secrets,
        scanner=scanner,
    )


class ArtifactUploader:
    """Perform the API prepare, direct upload, and finalize sequence."""

    def __init__(
        self,
        client: APIClient,
        *,
        upload_timeout: float = 60.0,
        transport: httpx.BaseTransport | None = None,
    ) -> None:
        self.client = client
        self.upload_timeout = upload_timeout
        self.transport = transport

    def upload(self, blob: EvidenceBlob, *, run_id: str) -> JSONObject:
        """Upload one prepared evidence blob and finalize its API record."""
        prepare_payload: JSONObject = {
            "run_id": run_id,
            "kind": blob.kind,
            "filename": blob.filename,
            "media_type": blob.media_type,
            "size_bytes": len(blob.data),
            "sha256": blob.sha256,
            "secret_scan": blob.secret_scan.as_payload(),
        }
        prepared = self.client.post(
            ARTIFACTS_PREPARE,
            prepare_payload,
            idempotency_key=f"artifact:{run_id}:{blob.kind}:{blob.sha256}",
        )
        artifact_id, upload_url, upload_headers = self._parse_prepare_response(prepared)

        try:
            with httpx.Client(
                timeout=self.upload_timeout,
                transport=self.transport,
            ) as upload_client:
                response = upload_client.put(
                    upload_url,
                    content=blob.data,
                    headers=upload_headers,
                )
        except httpx.RequestError as exc:
            raise EvidenceError("direct evidence upload failed") from exc
        if response.is_error:
            raise EvidenceError(f"direct evidence upload failed with HTTP {response.status_code}")

        finalized = self.client.post(
            artifact_finalize(artifact_id),
            {
                "size_bytes": len(blob.data),
                "sha256": blob.sha256,
                "secret_scan": blob.secret_scan.as_payload(),
            },
            idempotency_key=f"artifact:{artifact_id}:finalize:{blob.sha256}",
        )
        result: JSONObject = {
            "artifact_id": artifact_id,
            "kind": blob.kind,
            "sha256": blob.sha256,
            "size_bytes": len(blob.data),
            "secret_override_used": blob.secret_scan.override_used,
        }
        if isinstance(finalized, dict):
            result["record"] = finalized
        return result

    @staticmethod
    def _parse_prepare_response(
        payload: JSONValue,
    ) -> tuple[str, str, dict[str, str]]:
        if not isinstance(payload, dict):
            raise EvidenceError("artifact prepare response must be an object")
        artifact = payload.get("artifact")
        upload = payload.get("upload")
        artifact_id: JSONValue = payload.get("artifact_id")
        upload_url: JSONValue = payload.get("upload_url")
        raw_headers: JSONValue = payload.get("upload_headers", {})
        if isinstance(artifact, dict):
            artifact_id = artifact.get("id", artifact_id)
        if isinstance(upload, dict):
            upload_url = upload.get("url", upload_url)
            raw_headers = upload.get("headers", raw_headers)
        if not isinstance(artifact_id, str) or not artifact_id:
            raise EvidenceError("artifact prepare response is missing artifact id")
        if not isinstance(upload_url, str) or not upload_url:
            raise EvidenceError("artifact prepare response is missing upload URL")
        if not isinstance(raw_headers, dict):
            raise EvidenceError("artifact upload headers must be an object")
        headers: dict[str, str] = {}
        for key, value in raw_headers.items():
            if not isinstance(value, str):
                raise EvidenceError("artifact upload header values must be strings")
            headers[str(key)] = value
        return artifact_id, upload_url, headers


def serialize_evidence_audit(blobs: list[EvidenceBlob]) -> str:
    """Serialize redacted evidence audit metadata deterministically."""
    payload = [
        {
            "kind": blob.kind,
            "sha256": blob.sha256,
            "secret_scan": blob.secret_scan.as_payload(),
        }
        for blob in blobs
    ]
    return json.dumps(payload, sort_keys=True, separators=(",", ":"))
