"""Local command execution with durable, idempotent run synchronization."""

from __future__ import annotations

import hashlib
import os
import subprocess
import sys
import threading
import uuid
from dataclasses import dataclass
from datetime import UTC, datetime
from pathlib import Path
from typing import BinaryIO, Protocol, TextIO, cast

from qdag.client import APIClient
from qdag.config import ConfigPaths, _atomic_write_private_json, _read_private_json
from qdag.endpoints import RUNS, run_complete, run_fail
from qdag.errors import ManifestError, QdagError, RunError
from qdag.evidence import (
    DEFAULT_LOG_MAX_BYTES,
    DEFAULT_PATCH_MAX_BYTES,
    ArtifactUploader,
    EvidenceBlob,
    SecretScanner,
    capture_git_patch,
)
from qdag.manifest import ResultManifest, load_result_manifest
from qdag.metadata import capture_environment_metadata, discover_git_root
from qdag.portability import PathNormalizer
from qdag.types import JSONObject, JSONValue

POSTPROCESSING_EXIT_CODE = 2
INTERRUPTED_EXIT_CODE = 130
PENDING_STATE_VERSION = 1


class RunAPI(Protocol):
    """HTTP operations required by the run wrapper."""

    def post(
        self,
        path: str,
        payload: JSONObject,
        *,
        idempotency_key: str | None = None,
    ) -> JSONValue:
        """Submit an idempotent mutation."""


@dataclass(frozen=True, slots=True)
class PendingOperation:
    """One terminal run mutation awaiting successful API acknowledgement."""

    run_id: str
    endpoint: str
    payload: JSONObject
    idempotency_key: str
    created_at: str

    def as_payload(self) -> JSONObject:
        """Serialize this operation for a private state file."""
        return {
            "version": PENDING_STATE_VERSION,
            "run_id": self.run_id,
            "endpoint": self.endpoint,
            "payload": self.payload,
            "idempotency_key": self.idempotency_key,
            "created_at": self.created_at,
        }

    @classmethod
    def from_payload(cls, raw: object) -> PendingOperation:
        """Validate a pending-operation state document."""
        if not isinstance(raw, dict) or raw.get("version") != PENDING_STATE_VERSION:
            raise RunError("pending run state has an unsupported format")
        required = ("run_id", "endpoint", "payload", "idempotency_key", "created_at")
        if any(key not in raw for key in required):
            raise RunError("pending run state is missing required fields")
        if not all(
            isinstance(raw[key], str)
            for key in ("run_id", "endpoint", "idempotency_key", "created_at")
        ):
            raise RunError("pending run state contains invalid string fields")
        payload = raw["payload"]
        if not isinstance(payload, dict):
            raise RunError("pending run payload must be an object")
        return cls(
            run_id=cast(str, raw["run_id"]),
            endpoint=cast(str, raw["endpoint"]),
            payload=cast(JSONObject, payload),
            idempotency_key=cast(str, raw["idempotency_key"]),
            created_at=cast(str, raw["created_at"]),
        )


class PendingCompletionStore:
    """Durably queue terminal run updates before attempting network delivery."""

    def __init__(self, state_dir: Path | None = None) -> None:
        root = state_dir or ConfigPaths.default().state_dir
        self.directory = root / "pending-completions"

    def _path_for(self, operation: PendingOperation) -> Path:
        key = f"{operation.run_id}\0{operation.endpoint}".encode()
        return self.directory / f"{hashlib.sha256(key).hexdigest()}.json"

    def save(self, operation: PendingOperation) -> Path:
        """Persist an operation atomically with mode 0600."""
        path = self._path_for(operation)
        _atomic_write_private_json(path, operation.as_payload())
        return path

    def remove(self, operation: PendingOperation) -> None:
        """Delete an acknowledged operation."""
        self._path_for(operation).unlink(missing_ok=True)

    def list(self) -> list[PendingOperation]:
        """Load pending operations in deterministic order."""
        if not self.directory.exists():
            return []
        operations = [
            PendingOperation.from_payload(_read_private_json(path))
            for path in sorted(self.directory.glob("*.json"))
        ]
        return operations

    def submit(self, client: RunAPI, operation: PendingOperation) -> None:
        """Queue then submit one operation, deleting only after success."""
        self.save(operation)
        client.post(
            operation.endpoint,
            operation.payload,
            idempotency_key=operation.idempotency_key,
        )
        self.remove(operation)

    def retry_all(self, client: RunAPI) -> tuple[int, int]:
        """Retry all queued operations and return ``(succeeded, remaining)``."""
        succeeded = 0
        for operation in self.list():
            try:
                client.post(
                    operation.endpoint,
                    operation.payload,
                    idempotency_key=operation.idempotency_key,
                )
            except QdagError:
                continue
            self.remove(operation)
            succeeded += 1
        return succeeded, len(self.list())


@dataclass(frozen=True, slots=True)
class RunOptions:
    """Inputs controlling one local experiment command."""

    experiment_id: str
    result_path: Path
    command: list[str]
    cwd: Path
    seed: int | None = None
    include_patch: bool = False
    upload_log: bool = False
    allow_secrets: bool = False
    patch_max_bytes: int = DEFAULT_PATCH_MAX_BYTES
    log_max_bytes: int = DEFAULT_LOG_MAX_BYTES

    def __post_init__(self) -> None:
        if not self.experiment_id:
            raise ValueError("experiment_id must not be empty")
        if not self.command:
            raise ValueError("command must not be empty")
        if self.patch_max_bytes < 1 or self.log_max_bytes < 1:
            raise ValueError("evidence size caps must be positive")


@dataclass(frozen=True, slots=True)
class RunOutcome:
    """Terminal local and synchronization state returned by the wrapper."""

    run_id: str
    exit_code: int
    synchronized: bool
    log_path: Path
    log_truncated: bool
    error: str | None = None


class _CappedLog:
    def __init__(self, path: Path, max_bytes: int) -> None:
        path.parent.mkdir(mode=0o700, parents=True, exist_ok=True)
        if os.name == "posix":
            path.parent.chmod(0o700)
        descriptor = os.open(path, os.O_WRONLY | os.O_CREAT | os.O_TRUNC, 0o600)
        self._handle = os.fdopen(descriptor, "wb")
        self.path = path
        self.max_bytes = max_bytes
        self.written = 0
        self.truncated = False
        self._lock = threading.Lock()

    def write(self, data: bytes) -> None:
        with self._lock:
            remaining = self.max_bytes - self.written
            if remaining <= 0:
                self.truncated = self.truncated or bool(data)
                return
            chunk = data[:remaining]
            self._handle.write(chunk)
            self.written += len(chunk)
            if len(chunk) < len(data):
                self.truncated = True

    def close(self) -> None:
        with self._lock:
            self._handle.flush()
            os.fsync(self._handle.fileno())
            self._handle.close()


def _console_stream(stderr: bool) -> BinaryIO | None:
    stream = sys.stderr if stderr else sys.stdout
    return cast(BinaryIO | None, getattr(stream, "buffer", None))


def _pump_stream(
    source: BinaryIO,
    destination: BinaryIO | None,
    text_destination: TextIO,
    log: _CappedLog,
) -> None:
    for chunk in iter(lambda: source.read(64 * 1024), b""):
        log.write(chunk)
        if destination is not None:
            destination.write(chunk)
            destination.flush()
        else:
            text_destination.write(chunk.decode("utf-8", errors="replace"))
            text_destination.flush()
    source.close()


def _execute_child(
    command: list[str],
    *,
    cwd: Path,
    log_path: Path,
    max_log_bytes: int,
) -> tuple[int, bool, bool]:
    log = _CappedLog(log_path, max_log_bytes)
    try:
        process = subprocess.Popen(
            command,
            cwd=cwd,
            stdin=None,
            stdout=subprocess.PIPE,
            stderr=subprocess.PIPE,
        )
    except (FileNotFoundError, OSError) as exc:
        log.close()
        raise RunError(f"cannot start child command: {command[0]}") from exc

    if process.stdout is None or process.stderr is None:  # pragma: no cover
        log.close()
        raise RunError("child process streams were not created")
    stdout_thread = threading.Thread(
        target=_pump_stream,
        args=(process.stdout, _console_stream(False), sys.stdout, log),
        daemon=True,
    )
    stderr_thread = threading.Thread(
        target=_pump_stream,
        args=(process.stderr, _console_stream(True), sys.stderr, log),
        daemon=True,
    )
    stdout_thread.start()
    stderr_thread.start()

    interrupted = False
    try:
        while True:
            try:
                return_code = process.wait(timeout=0.2)
                break
            except subprocess.TimeoutExpired:
                continue
    except KeyboardInterrupt:
        interrupted = True
        process.terminate()
        try:
            process.wait(timeout=5)
        except subprocess.TimeoutExpired:
            process.kill()
            process.wait()
        return_code = INTERRUPTED_EXIT_CODE
    finally:
        stdout_thread.join()
        stderr_thread.join()
        log.close()

    if return_code < 0:
        return_code = 128 + abs(return_code)
    return return_code, interrupted, log.truncated


def _extract_run_id(payload: JSONValue) -> str:
    if not isinstance(payload, dict):
        raise RunError("run creation response must be an object")
    candidates: list[JSONValue] = [payload.get("id"), payload.get("run_id")]
    for container_name in ("data", "run"):
        container = payload.get(container_name)
        if isinstance(container, dict):
            candidates.extend([container.get("id"), container.get("run_id")])
    for candidate in candidates:
        if isinstance(candidate, str) and candidate:
            return candidate
    raise RunError("run creation response is missing a run id")


class RunExecutor:
    """Create an API run, execute locally, and synchronize terminal state."""

    def __init__(
        self,
        client: APIClient,
        *,
        state_dir: Path | None = None,
        scanner: SecretScanner | None = None,
        artifact_uploader: ArtifactUploader | None = None,
    ) -> None:
        self.client = client
        self.state_dir = state_dir or ConfigPaths.default().state_dir
        self.pending = PendingCompletionStore(self.state_dir)
        self.scanner = scanner or SecretScanner()
        self.artifact_uploader = artifact_uploader or ArtifactUploader(client)

    def execute(self, options: RunOptions) -> RunOutcome:
        """Execute one command and preserve its exit code."""
        cwd = options.cwd.resolve(strict=False)
        if not cwd.is_dir():
            raise RunError(f"working directory does not exist: {cwd}")

        self.pending.retry_all(self.client)
        patch: EvidenceBlob | None = None
        if options.include_patch:
            patch = capture_git_patch(
                cwd,
                max_bytes=options.patch_max_bytes,
                allow_secrets=options.allow_secrets,
                scanner=self.scanner,
            )

        client_run_id = str(uuid.uuid4())
        started = datetime.now(UTC)
        environment = capture_environment_metadata(
            options.command,
            cwd=cwd,
            seed=options.seed,
        )
        create_payload: JSONObject = {
            "client_run_id": client_run_id,
            "experiment_id": options.experiment_id,
            "status": "running",
            "started_at": started.isoformat(),
            "environment": environment,
        }
        created = self.client.post(
            RUNS,
            create_payload,
            idempotency_key=f"run:{client_run_id}:create",
        )
        run_id = _extract_run_id(created)
        log_path = self.state_dir / "logs" / f"{client_run_id}.log"
        uploaded_artifacts: list[JSONObject] = []

        preflight_error: str | None = None
        if patch is not None and patch.data:
            try:
                uploaded_artifacts.append(self.artifact_uploader.upload(patch, run_id=run_id))
            except QdagError as exc:
                preflight_error = str(exc)

        if preflight_error:
            ended = datetime.now(UTC)
            terminal_payload: JSONObject = {
                "status": "failed",
                "ended_at": ended.isoformat(),
                "duration_seconds": (ended - started).total_seconds(),
                "exit_code": POSTPROCESSING_EXIT_CODE,
                "failure_kind": "evidence_preflight",
                "error": preflight_error,
                "artifacts": uploaded_artifacts,
            }
            synchronized = self._submit_terminal(
                run_id,
                run_fail(run_id),
                terminal_payload,
            )
            return RunOutcome(
                run_id=run_id,
                exit_code=POSTPROCESSING_EXIT_CODE,
                synchronized=synchronized,
                log_path=log_path,
                log_truncated=False,
                error=preflight_error,
            )

        child_exit, interrupted, log_truncated = _execute_child(
            options.command,
            cwd=cwd,
            log_path=log_path,
            max_log_bytes=options.log_max_bytes,
        )
        ended = datetime.now(UTC)

        manifest: ResultManifest | None = None
        postprocessing_error: str | None = None
        result_path = (
            options.result_path if options.result_path.is_absolute() else cwd / options.result_path
        )
        if child_exit == 0 and not interrupted:
            try:
                manifest = load_result_manifest(result_path)
            except ManifestError as exc:
                postprocessing_error = str(exc)

        log_uploaded = False
        if options.upload_log:
            try:
                log_blob = EvidenceBlob.prepare(
                    kind="log",
                    filename=log_path.name,
                    media_type="text/plain",
                    data=log_path.read_bytes(),
                    max_bytes=options.log_max_bytes,
                    allow_secrets=options.allow_secrets,
                    scanner=self.scanner,
                )
                uploaded_artifacts.append(self.artifact_uploader.upload(log_blob, run_id=run_id))
                log_uploaded = True
            except (OSError, QdagError) as exc:
                postprocessing_error = postprocessing_error or str(exc)

        repo_root = discover_git_root(cwd)
        normalizer = PathNormalizer(repo_root=repo_root)
        common_payload: JSONObject = {
            "ended_at": ended.isoformat(),
            "duration_seconds": max(0.0, (ended - started).total_seconds()),
            "exit_code": child_exit,
            "local_log": {
                "path": normalizer.normalize_path(log_path),
                "size_bytes": log_path.stat().st_size,
                "truncated": log_truncated,
                "uploaded": log_uploaded,
            },
            "artifacts": uploaded_artifacts,
            "audit": {
                "secret_override_requested": options.allow_secrets,
                "secret_override_used": any(
                    artifact.get("secret_override_used") is True for artifact in uploaded_artifacts
                ),
            },
        }

        failure_kind: str | None = None
        effective_exit = child_exit
        if interrupted:
            failure_kind = "interrupted"
        elif child_exit != 0:
            failure_kind = "command"
        elif postprocessing_error:
            failure_kind = "postprocessing"
            effective_exit = POSTPROCESSING_EXIT_CODE

        if failure_kind:
            terminal_payload = {
                **common_payload,
                "status": "failed",
                "failure_kind": failure_kind,
            }
            if postprocessing_error:
                terminal_payload["error"] = postprocessing_error
            endpoint = run_fail(run_id)
        else:
            if manifest is None:  # pragma: no cover - guarded above
                raise RunError("successful run has no result manifest")
            terminal_payload = {
                **common_payload,
                "status": "completed",
                "result_manifest": cast(
                    JSONValue,
                    manifest.model_dump(mode="json", exclude_none=True),
                ),
            }
            endpoint = run_complete(run_id)

        synchronized = self._submit_terminal(run_id, endpoint, terminal_payload)
        return RunOutcome(
            run_id=run_id,
            exit_code=effective_exit,
            synchronized=synchronized,
            log_path=log_path,
            log_truncated=log_truncated,
            error=postprocessing_error,
        )

    def _submit_terminal(
        self,
        run_id: str,
        endpoint: str,
        payload: JSONObject,
    ) -> bool:
        operation = PendingOperation(
            run_id=run_id,
            endpoint=endpoint,
            payload=payload,
            idempotency_key=f"run:{run_id}:terminal",
            created_at=datetime.now(UTC).isoformat(),
        )
        try:
            self.pending.submit(self.client, operation)
        except QdagError:
            return False
        return True
