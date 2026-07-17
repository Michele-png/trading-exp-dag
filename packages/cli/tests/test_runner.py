"""Tests for local command execution and durable terminal updates.

Test classes:
    - TestRunExitStates: failed commands and malformed result manifests.
    - TestPendingCompletion: interrupted idempotent completion recovery.
"""

from __future__ import annotations

import json
import os
import stat
import sys
from pathlib import Path

import pytest

from qdag.endpoints import RUNS
from qdag.runner import (
    POSTPROCESSING_EXIT_CODE,
    PendingCompletionStore,
    PendingOperation,
    RunExecutor,
    RunOptions,
)
from qdag.types import JSONObject, JSONValue


class FakeRunClient:
    """Record run mutations and return a stable server run id."""

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
        if path == RUNS:
            return {"id": "run-1"}
        return {"ok": True}


def _write_valid_manifest(path: Path, payload: object) -> None:
    path.write_text(json.dumps(payload), encoding="utf-8")


class TestRunExitStates:
    """Preserve child failures and reject invalid successful outputs."""

    def test_failed_command_preserves_child_exit_code(
        self,
        tmp_path: Path,
    ) -> None:
        client = FakeRunClient()
        outcome = RunExecutor(client, state_dir=tmp_path / "state").execute(
            RunOptions(
                experiment_id="experiment-1",
                result_path=tmp_path / "missing.json",
                command=[
                    sys.executable,
                    "-c",
                    "import sys; print('failed'); sys.exit(7)",
                ],
                cwd=tmp_path,
            )
        )

        assert outcome.exit_code == 7
        assert outcome.synchronized is True
        terminal_path, terminal_payload, _ = client.calls[-1]
        assert terminal_path.endswith("/runs/run-1/fail")
        assert terminal_payload["failure_kind"] == "command"
        assert terminal_payload["exit_code"] == 7
        assert outcome.log_path.read_text(encoding="utf-8") == "failed\n"
        if os.name == "posix":
            assert stat.S_IMODE(outcome.log_path.stat().st_mode) == 0o600

    def test_successful_command_with_malformed_manifest_fails_postprocessing(
        self,
        tmp_path: Path,
    ) -> None:
        result_path = tmp_path / "result.json"
        result_path.write_text("{malformed", encoding="utf-8")
        client = FakeRunClient()

        outcome = RunExecutor(client, state_dir=tmp_path / "state").execute(
            RunOptions(
                experiment_id="experiment-1",
                result_path=Path("result.json"),
                command=[sys.executable, "-c", "print('completed')"],
                cwd=tmp_path,
            )
        )

        assert outcome.exit_code == POSTPROCESSING_EXIT_CODE
        terminal_path, terminal_payload, _ = client.calls[-1]
        assert terminal_path.endswith("/fail")
        assert terminal_payload["failure_kind"] == "postprocessing"
        assert "result manifest" in str(terminal_payload["error"])

    def test_local_log_is_capped_without_changing_child_exit(
        self,
        tmp_path: Path,
    ) -> None:
        client = FakeRunClient()

        outcome = RunExecutor(client, state_dir=tmp_path / "state").execute(
            RunOptions(
                experiment_id="experiment-1",
                result_path=Path("unused.json"),
                command=[
                    sys.executable,
                    "-c",
                    "import sys; sys.stdout.write('x' * 100); sys.exit(9)",
                ],
                cwd=tmp_path,
                log_max_bytes=16,
            )
        )

        assert outcome.exit_code == 9
        assert outcome.log_truncated is True
        assert outcome.log_path.stat().st_size == 16
        assert client.calls[-1][1]["local_log"]["truncated"] is True

    def test_successful_command_completes_with_manifest(
        self,
        tmp_path: Path,
        valid_manifest_payload,
    ) -> None:
        result_path = tmp_path / "result.json"
        _write_valid_manifest(result_path, valid_manifest_payload)
        client = FakeRunClient()

        outcome = RunExecutor(client, state_dir=tmp_path / "state").execute(
            RunOptions(
                experiment_id="experiment-1",
                result_path=result_path,
                command=[sys.executable, "-c", "print('completed')"],
                cwd=tmp_path,
                seed=42,
            )
        )

        assert outcome.exit_code == 0
        terminal_path, terminal_payload, _ = client.calls[-1]
        assert terminal_path.endswith("/complete")
        assert terminal_payload["status"] == "completed"
        assert terminal_payload["result_manifest"] == valid_manifest_payload


class InterruptingClient:
    """Simulate interruption after durable state is written."""

    def post(
        self,
        _path: str,
        _payload: JSONObject,
        *,
        idempotency_key: str | None = None,
    ) -> JSONValue:
        del idempotency_key
        raise KeyboardInterrupt


class TestPendingCompletion:
    """Retry terminal mutations with exactly the original idempotency key."""

    def test_interrupted_completion_remains_and_retries(
        self,
        tmp_path: Path,
    ) -> None:
        store = PendingCompletionStore(tmp_path / "state")
        operation = PendingOperation(
            run_id="run-123",
            endpoint="/api/v1/runs/run-123/complete",
            payload={"status": "completed", "exit_code": 0},
            idempotency_key="run:run-123:terminal",
            created_at="2026-07-10T20:00:00+00:00",
        )

        with pytest.raises(KeyboardInterrupt):
            store.submit(InterruptingClient(), operation)
        assert store.list() == [operation]
        if os.name == "posix":
            pending_file = next(store.directory.glob("*.json"))
            assert stat.S_IMODE(pending_file.stat().st_mode) == 0o600

        client = FakeRunClient()
        succeeded, remaining = store.retry_all(client)

        assert (succeeded, remaining) == (1, 0)
        assert client.calls == [
            (
                operation.endpoint,
                operation.payload,
                operation.idempotency_key,
            )
        ]
