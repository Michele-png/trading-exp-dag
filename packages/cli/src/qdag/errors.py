"""Typed exceptions raised by the qdag client."""

from __future__ import annotations

from dataclasses import dataclass


class QdagError(Exception):
    """Base class for user-facing qdag failures."""


class ConfigurationError(QdagError):
    """Raised when local configuration is missing or invalid."""


class CredentialError(QdagError):
    """Raised when a personal token cannot be stored or loaded safely."""


@dataclass(slots=True)
class APIError(QdagError):
    """Base error for an HTTP response returned by the qdag API."""

    message: str
    status_code: int
    code: str | None = None
    request_id: str | None = None

    def __str__(self) -> str:
        suffix = f" (request {self.request_id})" if self.request_id else ""
        return f"{self.message} [HTTP {self.status_code}]{suffix}"


class AuthenticationError(APIError):
    """Raised when a personal token is absent, expired, or invalid."""


class AuthorizationError(APIError):
    """Raised when the authenticated actor cannot access a resource."""


class NotFoundError(APIError):
    """Raised when an API resource does not exist."""


class ConflictError(APIError):
    """Raised when a request conflicts with existing state."""


class APIValidationError(APIError):
    """Raised when the API rejects a request payload."""


class RateLimitError(APIError):
    """Raised after an API rate-limit response cannot be retried."""


class ServerError(APIError):
    """Raised after a retryable server error is exhausted."""


class APIResponseError(APIError):
    """Raised when the API returns a response that violates its JSON contract."""


class APIConnectionError(QdagError):
    """Raised when the API cannot be reached after eligible retries."""


class ManifestError(QdagError):
    """Raised when a result manifest is unreadable or schema-invalid."""


class SecretDetectedError(QdagError):
    """Raised when evidence contains a high-confidence secret."""


class EvidenceError(QdagError):
    """Raised when evidence cannot be captured or uploaded safely."""


class RunError(QdagError):
    """Raised when a local run cannot be started or synchronized."""


class BackupError(QdagError):
    """Base class for backup and restore failures."""


class BackupIntegrityError(BackupError):
    """Raised when encrypted or checksummed backup content is corrupted."""


class UnsafeArchiveError(BackupError):
    """Raised when a backup contains an unsafe archive member."""
