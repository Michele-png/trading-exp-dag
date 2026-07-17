"""Deterministic backup archives, authenticated encryption, and safe extraction."""

from __future__ import annotations

import base64
import binascii
import hashlib
import io
import json
import os
import re
import stat
import struct
import tempfile
import zipfile
from dataclasses import dataclass
from pathlib import Path, PurePosixPath
from typing import NoReturn, cast

from cryptography.exceptions import InvalidTag
from cryptography.hazmat.primitives.ciphers.aead import AESGCM
from cryptography.hazmat.primitives.kdf.scrypt import Scrypt

from qdag.errors import BackupError, BackupIntegrityError, UnsafeArchiveError
from qdag.types import JSONObject, JSONValue

BUNDLE_FORMAT = "qdag-backup"
BUNDLE_VERSION = 1
ENCRYPTION_FORMAT = "qdag-backup-aesgcm"
ENCRYPTION_VERSION = 1
ENVELOPE_MAGIC = b"QDAGBK01"
SALT_BYTES = 16
NONCE_BYTES = 12
KEY_BYTES = 32
SCRYPT_N = 2**15
SCRYPT_R = 8
SCRYPT_P = 1
MAX_HEADER_BYTES = 4096
MAX_ARCHIVE_BYTES = 1024 * 1024 * 1024
MAX_MEMBER_BYTES = 256 * 1024 * 1024
MAX_MEMBERS = 10_000
MIN_PASSPHRASE_LENGTH = 12
FIXED_ZIP_TIMESTAMP = (1980, 1, 1, 0, 0, 0)
RESOURCE_NAME = re.compile(r"^[A-Za-z0-9][A-Za-z0-9._-]*$")


@dataclass(frozen=True, slots=True)
class VerifiedBackup:
    """Verified plaintext archive and its decoded contents."""

    manifest: JSONObject
    files: dict[str, bytes]
    sha256: str


def _json_bytes(payload: object) -> bytes:
    try:
        return (
            json.dumps(
                payload,
                ensure_ascii=False,
                indent=2,
                sort_keys=True,
                allow_nan=False,
            )
            + "\n"
        ).encode("utf-8")
    except (TypeError, ValueError) as exc:
        raise BackupError("backup contains a non-JSON-compatible value") from exc


def _reject_json_constant(value: str) -> NoReturn:
    raise ValueError(f"non-standard JSON numeric constant: {value}")


def _sha256(data: bytes) -> str:
    return hashlib.sha256(data).hexdigest()


def validate_member_name(name: str) -> str:
    """Validate and normalize a relative POSIX archive path."""
    if not name or "\x00" in name or "\\" in name or name.endswith("/"):
        raise UnsafeArchiveError(f"unsafe archive member path: {name!r}")
    if name.startswith("/") or re.match(r"^[A-Za-z]:", name):
        raise UnsafeArchiveError(f"unsafe archive member path: {name!r}")
    raw_parts = name.split("/")
    if any(part in {"", ".", ".."} for part in raw_parts):
        raise UnsafeArchiveError(f"unsafe archive member path: {name!r}")
    parsed = PurePosixPath(name)
    if parsed.is_absolute() or ".." in parsed.parts:
        raise UnsafeArchiveError(f"unsafe archive member path: {name!r}")
    return parsed.as_posix()


def _resource_name(value: str) -> str:
    if not RESOURCE_NAME.fullmatch(value):
        raise BackupError(f"record resource name must match {RESOURCE_NAME.pattern!r}: {value!r}")
    return value


def _record_count(value: JSONValue) -> int:
    if isinstance(value, list):
        return len(value)
    return 1


def _render_markdown(resource: str, records: JSONValue) -> str:
    title = resource.replace("_", " ").replace("-", " ").title()
    serialized = _json_bytes(records).decode("utf-8").rstrip()
    return f"# {title}\n\nRecord count: {_record_count(records)}\n\n```json\n{serialized}\n```\n"


def _zip_info(name: str) -> zipfile.ZipInfo:
    info = zipfile.ZipInfo(name, FIXED_ZIP_TIMESTAMP)
    info.compress_type = zipfile.ZIP_STORED
    info.create_system = 3
    info.external_attr = (stat.S_IFREG | 0o600) << 16
    return info


def build_backup_archive(
    *,
    records: dict[str, JSONValue],
    schema_versions: dict[str, str],
    exported_at: str,
    markdown_records: dict[str, str] | None = None,
    artifacts: dict[str, bytes] | None = None,
) -> bytes:
    """Build byte-for-byte deterministic plaintext backup content.

    Determinism is scoped to identical inputs, including ``exported_at``.
    Encryption is intentionally randomized and therefore non-deterministic.
    """
    if not exported_at:
        raise BackupError("exported_at must not be empty")
    files: dict[str, bytes] = {}
    record_index: JSONObject = {}
    supplied_markdown = markdown_records or {}

    for resource, value in sorted(records.items()):
        safe_resource = _resource_name(resource)
        json_path = f"records/{safe_resource}.json"
        markdown_path = f"records/{safe_resource}.md"
        files[json_path] = _json_bytes(value)
        markdown = supplied_markdown.get(resource) or _render_markdown(resource, value)
        files[markdown_path] = markdown.replace("\r\n", "\n").encode("utf-8")
        record_index[resource] = {
            "json_path": json_path,
            "markdown_path": markdown_path,
            "count": _record_count(value),
        }

    for artifact_path, data in sorted((artifacts or {}).items()):
        safe_path = validate_member_name(artifact_path)
        archive_path = safe_path if safe_path.startswith("artifacts/") else f"artifacts/{safe_path}"
        archive_path = validate_member_name(archive_path)
        if archive_path in files:
            raise BackupError(f"duplicate backup path: {archive_path}")
        if len(data) > MAX_MEMBER_BYTES:
            raise BackupError(f"artifact exceeds member size cap: {artifact_path}")
        files[archive_path] = data

    file_entries: list[JSONObject] = []
    for path, data in sorted(files.items()):
        kind = (
            "record_json"
            if path.endswith(".json")
            else "record_markdown"
            if path.startswith("records/")
            else "artifact"
        )
        file_entries.append(
            {
                "path": path,
                "kind": kind,
                "size_bytes": len(data),
                "sha256": _sha256(data),
            }
        )

    manifest: JSONObject = {
        "format": BUNDLE_FORMAT,
        "bundle_version": BUNDLE_VERSION,
        "exported_at": exported_at,
        "schema_versions": {key: schema_versions[key] for key in sorted(schema_versions)},
        "records": record_index,
        "files": file_entries,
    }
    files["manifest.json"] = _json_bytes(manifest)

    buffer = io.BytesIO()
    with zipfile.ZipFile(buffer, mode="w", allowZip64=True) as archive:
        for path, data in sorted(files.items()):
            archive.writestr(_zip_info(path), data)
    result = buffer.getvalue()
    if len(result) > MAX_ARCHIVE_BYTES:
        raise BackupError("plaintext backup archive exceeds the total size cap")
    verify_backup_archive(result)
    return result


def _load_archive_files(archive_bytes: bytes) -> dict[str, bytes]:
    if len(archive_bytes) > MAX_ARCHIVE_BYTES:
        raise BackupIntegrityError("backup archive exceeds the total size cap")
    files: dict[str, bytes] = {}
    casefolded_names: set[str] = set()
    total_size = 0
    try:
        with zipfile.ZipFile(io.BytesIO(archive_bytes), mode="r") as archive:
            infos = archive.infolist()
            if len(infos) > MAX_MEMBERS:
                raise BackupIntegrityError("backup archive has too many members")
            names = [info.filename for info in infos]
            if names != sorted(names):
                raise BackupIntegrityError(
                    "backup archive members are not deterministically ordered"
                )
            for info in infos:
                name = validate_member_name(info.filename)
                if name in files:
                    raise UnsafeArchiveError(f"duplicate archive member: {name}")
                folded_name = name.casefold()
                if folded_name in casefolded_names:
                    raise UnsafeArchiveError(f"case-insensitive archive path collision: {name}")
                casefolded_names.add(folded_name)
                unix_mode = info.external_attr >> 16
                if stat.S_ISLNK(unix_mode):
                    raise UnsafeArchiveError(f"symlink archive member rejected: {name}")
                if info.is_dir():
                    raise UnsafeArchiveError(f"directory archive member rejected: {name}")
                if info.file_size > MAX_MEMBER_BYTES:
                    raise BackupIntegrityError(f"archive member is too large: {name}")
                total_size += info.file_size
                if total_size > MAX_ARCHIVE_BYTES:
                    raise BackupIntegrityError("expanded backup exceeds the size cap")
                if info.compress_type not in {
                    zipfile.ZIP_STORED,
                    zipfile.ZIP_DEFLATED,
                }:
                    raise BackupIntegrityError(
                        f"unsupported compression for archive member: {name}"
                    )
                data = archive.read(info)
                if len(data) != info.file_size:
                    raise BackupIntegrityError(f"archive member size mismatch: {name}")
                files[name] = data
    except (zipfile.BadZipFile, RuntimeError, OSError) as exc:
        raise BackupIntegrityError("backup is not a valid ZIP archive") from exc
    return files


def verify_backup_archive(archive_bytes: bytes) -> VerifiedBackup:
    """Validate paths, manifest shape, sizes, and every file checksum."""
    files = _load_archive_files(archive_bytes)
    raw_manifest = files.get("manifest.json")
    if raw_manifest is None:
        raise BackupIntegrityError("backup archive is missing manifest.json")
    try:
        manifest_value = json.loads(raw_manifest)
    except (UnicodeDecodeError, json.JSONDecodeError) as exc:
        raise BackupIntegrityError("backup manifest is not valid UTF-8 JSON") from exc
    if not isinstance(manifest_value, dict):
        raise BackupIntegrityError("backup manifest root must be an object")
    manifest = cast(JSONObject, manifest_value)
    if manifest.get("format") != BUNDLE_FORMAT:
        raise BackupIntegrityError("backup manifest format is unsupported")
    if manifest.get("bundle_version") != BUNDLE_VERSION:
        raise BackupIntegrityError("backup manifest version is unsupported")
    if raw_manifest != _json_bytes(manifest):
        raise BackupIntegrityError("backup manifest is not canonically serialized")

    raw_entries = manifest.get("files")
    if not isinstance(raw_entries, list):
        raise BackupIntegrityError("backup manifest files must be an array")
    expected_paths = set(files) - {"manifest.json"}
    listed_paths: set[str] = set()
    for raw_entry in raw_entries:
        if not isinstance(raw_entry, dict):
            raise BackupIntegrityError("backup manifest file entry must be an object")
        path = raw_entry.get("path")
        expected_size = raw_entry.get("size_bytes")
        expected_hash = raw_entry.get("sha256")
        if not isinstance(path, str):
            raise BackupIntegrityError("backup manifest file path must be a string")
        safe_path = validate_member_name(path)
        if safe_path in listed_paths:
            raise BackupIntegrityError(f"duplicate path in backup manifest: {safe_path}")
        listed_paths.add(safe_path)
        data = files.get(safe_path)
        if data is None:
            raise BackupIntegrityError(f"manifest references a missing file: {safe_path}")
        if expected_size != len(data) or expected_hash != _sha256(data):
            raise BackupIntegrityError(f"checksum or size mismatch for backup file: {safe_path}")
    if listed_paths != expected_paths:
        extras = sorted(expected_paths - listed_paths)
        missing = sorted(listed_paths - expected_paths)
        raise BackupIntegrityError(
            f"backup file inventory mismatch (unlisted={extras}, missing={missing})"
        )

    raw_records = manifest.get("records")
    if not isinstance(raw_records, dict):
        raise BackupIntegrityError("backup manifest records must be an object")
    for resource, raw_index in raw_records.items():
        if not isinstance(resource, str):
            raise BackupIntegrityError("backup record name must be a string")
        try:
            _resource_name(resource)
        except BackupError as exc:
            raise BackupIntegrityError(f"backup record name is invalid: {resource!r}") from exc
        if not isinstance(raw_index, dict):
            raise BackupIntegrityError("backup record index must be an object")
        json_path = raw_index.get("json_path")
        markdown_path = raw_index.get("markdown_path")
        if (
            not isinstance(json_path, str)
            or json_path not in files
            or not json_path.startswith("records/")
            or not json_path.endswith(".json")
        ):
            raise BackupIntegrityError(f"backup record {resource!r} has an invalid json_path")
        if (
            not isinstance(markdown_path, str)
            or markdown_path not in files
            or not markdown_path.startswith("records/")
            or not markdown_path.endswith(".md")
        ):
            raise BackupIntegrityError(f"backup record {resource!r} has an invalid markdown_path")
        try:
            decoded_record = json.loads(
                files[json_path],
                parse_constant=_reject_json_constant,
            )
            files[markdown_path].decode("utf-8")
        except (UnicodeDecodeError, ValueError) as exc:
            raise BackupIntegrityError(
                f"backup record {resource!r} is not valid JSON/Markdown"
            ) from exc
        if raw_index.get("count") != _record_count(cast(JSONValue, decoded_record)):
            raise BackupIntegrityError(f"backup record {resource!r} count does not match its JSON")

    return VerifiedBackup(
        manifest=manifest,
        files=files,
        sha256=_sha256(archive_bytes),
    )


def _derive_key(passphrase: str, salt: bytes) -> bytes:
    if len(passphrase) < MIN_PASSPHRASE_LENGTH:
        raise BackupError(
            f"backup passphrase must contain at least {MIN_PASSPHRASE_LENGTH} characters"
        )
    kdf = Scrypt(
        salt=salt,
        length=KEY_BYTES,
        n=SCRYPT_N,
        r=SCRYPT_R,
        p=SCRYPT_P,
    )
    return kdf.derive(passphrase.encode("utf-8"))


def encrypt_backup(archive_bytes: bytes, passphrase: str) -> bytes:
    """Encrypt a verified archive with Scrypt-derived AES-256-GCM."""
    verify_backup_archive(archive_bytes)
    salt = os.urandom(SALT_BYTES)
    nonce = os.urandom(NONCE_BYTES)
    header: JSONObject = {
        "format": ENCRYPTION_FORMAT,
        "version": ENCRYPTION_VERSION,
        "kdf": {
            "name": "scrypt",
            "n": SCRYPT_N,
            "r": SCRYPT_R,
            "p": SCRYPT_P,
            "salt": base64.b64encode(salt).decode("ascii"),
        },
        "cipher": {
            "name": "aes-256-gcm",
            "nonce": base64.b64encode(nonce).decode("ascii"),
        },
    }
    header_bytes = json.dumps(
        header,
        sort_keys=True,
        separators=(",", ":"),
    ).encode("utf-8")
    prefix = ENVELOPE_MAGIC + struct.pack(">I", len(header_bytes)) + header_bytes
    ciphertext = AESGCM(_derive_key(passphrase, salt)).encrypt(
        nonce,
        archive_bytes,
        prefix,
    )
    return prefix + ciphertext


def _decode_envelope(encrypted: bytes) -> tuple[bytes, bytes, bytes, bytes]:
    prefix_size = len(ENVELOPE_MAGIC) + 4
    if len(encrypted) < prefix_size or not encrypted.startswith(ENVELOPE_MAGIC):
        raise BackupIntegrityError("encrypted backup has an invalid header")
    header_length = struct.unpack(">I", encrypted[len(ENVELOPE_MAGIC) : prefix_size])[0]
    if header_length < 2 or header_length > MAX_HEADER_BYTES:
        raise BackupIntegrityError("encrypted backup header length is invalid")
    header_end = prefix_size + header_length
    if header_end >= len(encrypted):
        raise BackupIntegrityError("encrypted backup is truncated")
    header_bytes = encrypted[prefix_size:header_end]
    try:
        header = json.loads(header_bytes)
    except (UnicodeDecodeError, json.JSONDecodeError) as exc:
        raise BackupIntegrityError("encrypted backup header is invalid") from exc
    if not isinstance(header, dict):
        raise BackupIntegrityError("encrypted backup header must be an object")
    if header.get("format") != ENCRYPTION_FORMAT or header.get("version") != ENCRYPTION_VERSION:
        raise BackupIntegrityError("encrypted backup version is unsupported")
    kdf = header.get("kdf")
    cipher = header.get("cipher")
    if not isinstance(kdf, dict) or not isinstance(cipher, dict):
        raise BackupIntegrityError("encrypted backup algorithms are missing")
    if (
        kdf.get("name") != "scrypt"
        or kdf.get("n") != SCRYPT_N
        or kdf.get("r") != SCRYPT_R
        or kdf.get("p") != SCRYPT_P
        or cipher.get("name") != "aes-256-gcm"
    ):
        raise BackupIntegrityError("encrypted backup algorithms are unsupported")
    try:
        salt_value = kdf["salt"]
        nonce_value = cipher["nonce"]
        if not isinstance(salt_value, str) or not isinstance(nonce_value, str):
            raise ValueError
        salt = base64.b64decode(salt_value, validate=True)
        nonce = base64.b64decode(nonce_value, validate=True)
    except (KeyError, ValueError, binascii.Error) as exc:
        raise BackupIntegrityError("encrypted backup salt or nonce is invalid") from exc
    if len(salt) != SALT_BYTES or len(nonce) != NONCE_BYTES:
        raise BackupIntegrityError("encrypted backup salt or nonce has invalid length")
    prefix = encrypted[:header_end]
    return salt, nonce, prefix, encrypted[header_end:]


def decrypt_backup(encrypted: bytes, passphrase: str) -> bytes:
    """Authenticate, decrypt, and verify a backup envelope."""
    if len(encrypted) > MAX_ARCHIVE_BYTES + MAX_HEADER_BYTES + 1024:
        raise BackupIntegrityError("encrypted backup exceeds the size cap")
    salt, nonce, associated_data, ciphertext = _decode_envelope(encrypted)
    try:
        archive_bytes = AESGCM(_derive_key(passphrase, salt)).decrypt(
            nonce,
            ciphertext,
            associated_data,
        )
    except InvalidTag as exc:
        raise BackupIntegrityError(
            "backup authentication failed (wrong passphrase or tampered data)"
        ) from exc
    verify_backup_archive(archive_bytes)
    return archive_bytes


def write_encrypted_backup(path: Path, encrypted: bytes) -> None:
    """Atomically write an encrypted backup with mode 0600."""
    parent_existed = path.parent.exists()
    path.parent.mkdir(mode=0o700, parents=True, exist_ok=True)
    if os.name == "posix" and not parent_existed:
        path.parent.chmod(0o700)
    descriptor, temporary_name = tempfile.mkstemp(
        prefix=f".{path.name}.",
        dir=path.parent,
    )
    temporary_path = Path(temporary_name)
    try:
        if os.name == "posix":
            os.fchmod(descriptor, 0o600)
        with os.fdopen(descriptor, "wb") as handle:
            handle.write(encrypted)
            handle.flush()
            os.fsync(handle.fileno())
        os.replace(temporary_path, path)
        if os.name == "posix":
            path.chmod(0o600)
    except Exception:
        temporary_path.unlink(missing_ok=True)
        raise


def read_encrypted_backup(path: Path, passphrase: str) -> bytes:
    """Read and decrypt a bounded local backup file."""
    try:
        if path.stat().st_size > MAX_ARCHIVE_BYTES + MAX_HEADER_BYTES + 1024:
            raise BackupIntegrityError("encrypted backup exceeds the size cap")
        encrypted = path.read_bytes()
    except OSError as exc:
        raise BackupError(f"cannot read backup file: {path}") from exc
    return decrypt_backup(encrypted, passphrase)


def safe_extract_archive(archive_bytes: bytes, destination: Path) -> VerifiedBackup:
    """Extract a verified archive into a new or empty directory safely."""
    verified = verify_backup_archive(archive_bytes)
    if destination.is_symlink():
        raise UnsafeArchiveError(f"symlink restore destination rejected: {destination}")
    destination.mkdir(mode=0o700, parents=True, exist_ok=True)
    if any(destination.iterdir()):
        raise BackupError(f"restore destination must be empty: {destination}")
    root = destination.resolve(strict=False)

    for name, data in sorted(verified.files.items()):
        safe_name = validate_member_name(name)
        target = destination.joinpath(*PurePosixPath(safe_name).parts)
        target.parent.mkdir(mode=0o700, parents=True, exist_ok=True)
        resolved_parent = target.parent.resolve(strict=False)
        if not resolved_parent.is_relative_to(root):
            raise UnsafeArchiveError(f"archive member escapes destination: {name}")
        current = destination
        for part in PurePosixPath(safe_name).parts[:-1]:
            current = current / part
            if current.is_symlink():
                raise UnsafeArchiveError(f"symlink in restore destination rejected: {current}")
        flags = os.O_WRONLY | os.O_CREAT | os.O_EXCL
        if hasattr(os, "O_NOFOLLOW"):
            flags |= os.O_NOFOLLOW
        try:
            descriptor = os.open(target, flags, 0o600)
        except OSError as exc:
            raise UnsafeArchiveError(f"cannot safely create restore member: {name}") from exc
        with os.fdopen(descriptor, "wb") as handle:
            handle.write(data)
        if os.name == "posix":
            target.chmod(0o600)
    return verified
