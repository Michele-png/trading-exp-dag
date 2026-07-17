"""Tests for secret-aware optional evidence preparation.

Test classes:
    - TestSecretBlocking: default blocking and explicit audit override.
    - TestEvidenceBounds: byte caps and checksum metadata.
"""

from __future__ import annotations

import hashlib

import httpx
import pytest

from qdag.errors import EvidenceError, SecretDetectedError
from qdag.evidence import ArtifactUploader, EvidenceBlob, SecretScanner
from qdag.types import JSONObject, JSONValue

PRIVATE_KEY_MARKER = b"-----BEGIN PRIVATE KEY-----\nnot-a-real-key\n"


class TestSecretBlocking:
    """Block high-confidence detector findings unless explicitly overridden."""

    def test_private_key_marker_is_blocked(self) -> None:
        with pytest.raises(SecretDetectedError, match="Private Key"):
            SecretScanner().scan(
                PRIVATE_KEY_MARKER,
                source_name="evidence.log",
            )

    def test_override_is_explicit_and_never_contains_secret_value(self) -> None:
        report = SecretScanner().scan(
            PRIVATE_KEY_MARKER,
            source_name="evidence.log",
            allow_secrets=True,
        )

        payload = report.as_payload()
        assert payload["override_used"] is True
        assert payload["high_confidence_count"] == 1
        assert "not-a-real-key" not in str(payload)


class TestEvidenceBounds:
    """Enforce local caps before any API upload is prepared."""

    def test_size_cap_blocks_large_log(self) -> None:
        with pytest.raises(EvidenceError, match="size cap"):
            EvidenceBlob.prepare(
                kind="log",
                filename="run.log",
                media_type="text/plain",
                data=b"x" * 11,
                max_bytes=10,
                allow_secrets=False,
            )

    def test_prepared_blob_has_checksum_and_redacted_audit(self) -> None:
        data = b"ordinary experiment output\n"

        blob = EvidenceBlob.prepare(
            kind="log",
            filename="run.log",
            media_type="text/plain",
            data=data,
            max_bytes=1024,
            allow_secrets=False,
        )

        assert blob.sha256 == hashlib.sha256(data).hexdigest()
        assert blob.secret_scan.high_confidence_count == 0
        assert blob.secret_scan.override_used is False


class FakeArtifactAPI:
    """Return one signed upload and record prepare/finalize payloads."""

    def __init__(self) -> None:
        self.calls: list[tuple[str, JSONObject, str | None]] = []

    def post(
        self,
        path: str,
        payload: JSONObject,
        *,
        idempotency_key: str | None = None,
    ) -> JSONValue:
        self.calls.append((path, payload, idempotency_key))
        if path.endswith("/prepare"):
            return {
                "artifact_id": "artifact-1",
                "upload_url": "https://uploads.example.test/object?signature=secret",
                "upload_headers": {"x-upload-token": "signed-header"},
            }
        return {"id": "artifact-1", "status": "finalized"}


class TestArtifactUploadFlow:
    """Use prepare/direct-upload/finalize without leaking API authorization."""

    def test_override_metadata_reaches_prepare_and_finalize(self) -> None:
        blob = EvidenceBlob.prepare(
            kind="log",
            filename="run.log",
            media_type="text/plain",
            data=PRIVATE_KEY_MARKER,
            max_bytes=1024,
            allow_secrets=True,
        )
        uploaded_requests: list[httpx.Request] = []

        def handle_upload(request: httpx.Request) -> httpx.Response:
            uploaded_requests.append(request)
            return httpx.Response(200)

        api = FakeArtifactAPI()
        result = ArtifactUploader(
            api,
            transport=httpx.MockTransport(handle_upload),
        ).upload(blob, run_id="run-1")

        assert result["secret_override_used"] is True
        assert len(uploaded_requests) == 1
        assert "Authorization" not in uploaded_requests[0].headers
        assert uploaded_requests[0].headers["x-upload-token"] == "signed-header"
        assert uploaded_requests[0].content == PRIVATE_KEY_MARKER
        assert "signature=secret" not in str(api.calls)
        prepare_payload = api.calls[0][1]
        finalize_payload = api.calls[1][1]
        assert prepare_payload["secret_scan"]["override_used"] is True
        assert finalize_payload["secret_scan"]["override_used"] is True
