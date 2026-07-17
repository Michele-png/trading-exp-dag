"""Restore a persistent smoke backup into a freshly reset local database."""

from __future__ import annotations

import hashlib
import os
import secrets
import time
from pathlib import Path
from typing import Any

import httpx


def wait_for_supabase_auth(base_url: str, publishable_key: str) -> None:
    """Block until the Supabase auth service is ready after a container restart."""
    deadline = time.monotonic() + 60
    last_status = "unknown"
    while time.monotonic() < deadline:
        try:
            response = httpx.get(
                f"{base_url}/auth/v1/health",
                headers={"apikey": publishable_key},
                timeout=5,
            )
            if response.status_code == 200:
                return
            last_status = str(response.status_code)
        except httpx.HTTPError as error:  # noqa: PERF203 - readiness poll
            last_status = type(error).__name__
        time.sleep(1)
    raise RuntimeError(f"Supabase auth did not become ready (last status {last_status})")

from qdag.backup import BackupManager
from qdag.client import APIClient, RetryPolicy


def require_env(name: str) -> str:
    """Return a required environment variable without logging it."""
    value = os.environ.get(name)
    if not value:
        raise RuntimeError(f"{name} is required")
    return value


def checked(response: httpx.Response) -> dict[str, Any]:
    """Return a JSON object or raise a bounded diagnostic."""
    if response.is_error:
        raise RuntimeError(
            f"{response.request.method} {response.request.url} returned "
            f"{response.status_code}: {response.text[:500]}"
        )
    payload = response.json()
    if not isinstance(payload, dict):
        raise TypeError("Expected an object response")
    return payload


def main() -> None:
    """Restore and verify records plus private artifact bytes."""
    supabase_url = require_env("NEXT_PUBLIC_SUPABASE_URL").rstrip("/")
    publishable_key = require_env("NEXT_PUBLIC_SUPABASE_PUBLISHABLE_KEY")
    secret_key = require_env("SUPABASE_SECRET_KEY")
    backup_path = Path(require_env("QDAG_SMOKE_BACKUP_PATH")).resolve()
    passphrase = os.environ.get(
        "QDAG_SMOKE_BACKUP_PASSPHRASE",
        "local-smoke-backup-passphrase",
    )
    app_url = os.environ.get("QDAG_API_URL", "http://localhost:3000").rstrip("/")
    if not supabase_url.startswith(("http://127.0.0.1:", "http://localhost:")):
        raise RuntimeError("Empty-database restore smoke is local-only")
    if not backup_path.is_file():
        raise FileNotFoundError(backup_path)

    suffix = secrets.token_hex(6)
    email = f"qdag-restore-{suffix}@example.test"
    password = f"Local-{secrets.token_urlsafe(24)}"

    wait_for_supabase_auth(supabase_url, publishable_key)
    with httpx.Client(timeout=30) as client:
        admin_headers = {
            "apikey": secret_key,
            "Authorization": f"Bearer {secret_key}",
        }
        user = checked(
            client.post(
                f"{supabase_url}/auth/v1/admin/users",
                headers=admin_headers,
                json={"email": email, "password": password, "email_confirm": True},
            )
        )
        user_id = str(user["id"])
        session = checked(
            client.post(
                f"{supabase_url}/auth/v1/token",
                params={"grant_type": "password"},
                headers={"apikey": publishable_key},
                json={"email": email, "password": password},
            )
        )
        access_token = str(session["access_token"])
        user_headers = {
            "apikey": publishable_key,
            "Authorization": f"Bearer {access_token}",
        }
        workspace_response = client.get(
            f"{supabase_url}/rest/v1/workspaces",
            params={
                "select": "id",
                "personal_owner_user_id": f"eq.{user_id}",
            },
            headers=user_headers,
        )
        workspace_response.raise_for_status()
        workspace_id = str(workspace_response.json()[0]["id"])
        token_result = checked(
            client.post(
                f"{app_url}/api/v1/auth/tokens",
                headers={
                    "Authorization": f"Bearer {access_token}",
                    "Content-Type": "application/json",
                    "X-Workspace-Id": workspace_id,
                    "Idempotency-Key": f"restore-token-{suffix}",
                    "Origin": app_url,
                },
                json={
                    "workspaceId": workspace_id,
                    "name": "Empty restore smoke",
                    "scopes": [
                        "spaces:read",
                        "spaces:write",
                        "nodes:read",
                        "nodes:write",
                        "runs:write",
                        "artifacts:write",
                        "export:read",
                        "import:write",
                    ],
                },
            )
        )
        personal_token = str(token_result["token"])

        with APIClient(
            app_url,
            personal_token,
            retry_policy=RetryPolicy(max_attempts=1),
        ) as api_client:
            restored = BackupManager(api_client).restore(
                backup_path,
                passphrase=passphrase,
                dry_run=False,
            )
            if not isinstance(restored.api_response, dict):
                raise RuntimeError("Restore API response is missing")
            export = api_client.get(
                "/api/v1/backups/export",
                params={"include_artifacts": True},
            )
        if not isinstance(export, dict):
            raise TypeError("Expected an export object")
        records = export.get("records")
        if not isinstance(records, dict):
            raise RuntimeError("Restored export is missing records")
        expected_minimums = {
            "spaces": 1,
            "nodes": 2,
            "node_revisions": 3,
            "lineage_edges": 1,
            "runs": 1,
            "artifacts": 1,
        }
        for resource, minimum in expected_minimums.items():
            rows = records.get(resource)
            if not isinstance(rows, list) or len(rows) < minimum:
                raise RuntimeError(
                    f"Restored {resource} count is below {minimum}"
                )

        artifact_exports = export.get("artifacts")
        if not isinstance(artifact_exports, list) or not artifact_exports:
            raise RuntimeError("Restored artifact download metadata is missing")
        artifact = artifact_exports[0]
        if not isinstance(artifact, dict):
            raise TypeError("Expected artifact metadata")
        artifact_response = client.get(str(artifact["download_url"]))
        artifact_response.raise_for_status()
        if (
            hashlib.sha256(artifact_response.content).hexdigest()
            != artifact["sha256"]
        ):
            raise RuntimeError("Restored artifact checksum differs")

    print("Encrypted backup restored into an empty database with matching artifact bytes.")


if __name__ == "__main__":
    main()
