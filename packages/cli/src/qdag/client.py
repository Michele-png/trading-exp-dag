"""Versioned HTTP client with typed errors and bounded retries."""

from __future__ import annotations

import email.utils
import time
import uuid
from collections.abc import Callable, Mapping
from dataclasses import dataclass
from datetime import UTC, datetime
from typing import cast

import httpx

from qdag.errors import (
    APIConnectionError,
    APIError,
    APIResponseError,
    APIValidationError,
    AuthenticationError,
    AuthorizationError,
    ConflictError,
    NotFoundError,
    RateLimitError,
    ServerError,
)
from qdag.types import JSONObject, JSONValue

SAFE_METHODS = frozenset({"GET", "HEAD", "OPTIONS"})
IDEMPOTENT_METHODS = frozenset({"PUT", "DELETE"})
RETRYABLE_STATUS_CODES = frozenset({408, 425, 429, 500, 502, 503, 504})
MUTATING_METHODS = frozenset({"POST", "PUT", "PATCH", "DELETE"})


@dataclass(frozen=True, slots=True)
class RetryPolicy:
    """Bounded retry settings for safe or explicitly idempotent operations."""

    max_attempts: int = 3
    base_delay_seconds: float = 0.2
    max_delay_seconds: float = 2.0

    def __post_init__(self) -> None:
        if self.max_attempts < 1:
            raise ValueError("max_attempts must be at least 1")
        if self.base_delay_seconds < 0:
            raise ValueError("base_delay_seconds must be non-negative")
        if self.max_delay_seconds < self.base_delay_seconds:
            raise ValueError(
                "max_delay_seconds must be greater than or equal to base_delay_seconds"
            )


class APIClient:
    """Synchronous client for the stable ``/api/v1`` contract."""

    def __init__(
        self,
        base_url: str,
        token: str,
        *,
        retry_policy: RetryPolicy | None = None,
        timeout: float = 30.0,
        transport: httpx.BaseTransport | None = None,
        sleeper: Callable[[float], None] = time.sleep,
    ) -> None:
        if not token:
            raise ValueError("token must not be empty")
        self.retry_policy = retry_policy or RetryPolicy()
        self._sleep = sleeper
        self._client = httpx.Client(
            base_url=base_url.rstrip("/"),
            headers={
                "Accept": "application/json",
                "Authorization": f"Bearer {token}",
                "User-Agent": "qdag-cli/0.1.0",
            },
            timeout=timeout,
            transport=transport,
        )

    def __enter__(self) -> APIClient:
        return self

    def __exit__(self, *_args: object) -> None:
        self.close()

    def close(self) -> None:
        """Close pooled HTTP connections."""
        self._client.close()

    def get(
        self,
        path: str,
        *,
        params: Mapping[str, str | int | float | bool | None] | None = None,
    ) -> JSONValue:
        """Issue a retryable GET request."""
        return self.request("GET", path, params=params)

    def post(
        self,
        path: str,
        payload: JSONObject,
        *,
        idempotency_key: str | None = None,
    ) -> JSONValue:
        """Issue an idempotent POST using one stable key across retries."""
        return self.request(
            "POST",
            path,
            json_body=payload,
            idempotency_key=idempotency_key or str(uuid.uuid4()),
        )

    def patch(
        self,
        path: str,
        payload: JSONObject,
        *,
        idempotency_key: str | None = None,
    ) -> JSONValue:
        """Issue an idempotent PATCH using one stable key across retries."""
        return self.request(
            "PATCH",
            path,
            json_body=payload,
            idempotency_key=idempotency_key or str(uuid.uuid4()),
        )

    def delete(
        self,
        path: str,
        *,
        idempotency_key: str | None = None,
    ) -> JSONValue:
        """Issue an idempotent DELETE request."""
        return self.request(
            "DELETE",
            path,
            idempotency_key=idempotency_key or str(uuid.uuid4()),
        )

    def request(
        self,
        method: str,
        path: str,
        *,
        json_body: JSONValue | None = None,
        params: Mapping[str, str | int | float | bool | None] | None = None,
        idempotency_key: str | None = None,
        retry: bool = True,
    ) -> JSONValue:
        """Issue one API request.

        Retries are permitted only for safe methods, inherently idempotent
        methods, or mutations carrying an explicit ``Idempotency-Key``.
        """
        normalized_method = method.upper()
        request_headers: dict[str, str] = {}
        if normalized_method in MUTATING_METHODS and idempotency_key:
            request_headers["Idempotency-Key"] = idempotency_key

        retry_eligible = (
            normalized_method in SAFE_METHODS
            or normalized_method in IDEMPOTENT_METHODS
            or bool(idempotency_key)
        )
        attempts = self.retry_policy.max_attempts if retry and retry_eligible else 1

        response: httpx.Response | None = None
        for attempt in range(1, attempts + 1):
            try:
                if json_body is None:
                    response = self._client.request(
                        normalized_method,
                        path,
                        headers=request_headers,
                        params=params,
                    )
                else:
                    response = self._client.request(
                        normalized_method,
                        path,
                        headers=request_headers,
                        json=json_body,
                        params=params,
                    )
            except httpx.RequestError as exc:
                if attempt >= attempts:
                    raise APIConnectionError(
                        f"{normalized_method} {path} failed after {attempt} attempt(s)"
                    ) from exc
                self._sleep(self._retry_delay(attempt, None))
                continue

            if response.status_code in RETRYABLE_STATUS_CODES and attempt < attempts:
                self._sleep(self._retry_delay(attempt, response))
                continue
            break

        if response is None:  # pragma: no cover - loop always sets or raises
            raise APIConnectionError(f"{normalized_method} {path} produced no response")
        if response.is_error:
            raise self._error_from_response(response)
        if response.status_code == 204 or not response.content:
            return None
        try:
            return cast(JSONValue, response.json())
        except ValueError as exc:
            raise APIResponseError(
                message="API returned a non-JSON success response",
                status_code=response.status_code,
                request_id=response.headers.get("x-request-id"),
            ) from exc

    def _retry_delay(
        self,
        attempt: int,
        response: httpx.Response | None,
    ) -> float:
        retry_after = response.headers.get("retry-after") if response else None
        if retry_after:
            parsed = self._parse_retry_after(retry_after)
            if parsed is not None:
                return min(parsed, self.retry_policy.max_delay_seconds)
        exponential = self.retry_policy.base_delay_seconds * float(2 ** (attempt - 1))
        return min(exponential, self.retry_policy.max_delay_seconds)

    @staticmethod
    def _parse_retry_after(value: str) -> float | None:
        try:
            return max(0.0, float(value))
        except ValueError:
            try:
                when = email.utils.parsedate_to_datetime(value)
            except (TypeError, ValueError):
                return None
            if when.tzinfo is None:
                when = when.replace(tzinfo=UTC)
            return max(0.0, (when - datetime.now(UTC)).total_seconds())

    @staticmethod
    def _error_from_response(response: httpx.Response) -> APIError:
        message = response.reason_phrase or "API request failed"
        code: str | None = None
        try:
            payload = response.json()
        except ValueError:
            payload = None
        if isinstance(payload, dict):
            error = payload.get("error", payload)
            if isinstance(error, dict):
                detail = error.get("message") or error.get("detail")
                if isinstance(detail, str):
                    message = detail
                raw_code = error.get("code")
                if isinstance(raw_code, str):
                    code = raw_code
            elif isinstance(error, str):
                message = error

        kwargs = {
            "message": message,
            "status_code": response.status_code,
            "code": code,
            "request_id": response.headers.get("x-request-id"),
        }
        error_type: type[APIError]
        if response.status_code == 401:
            error_type = AuthenticationError
        elif response.status_code == 403:
            error_type = AuthorizationError
        elif response.status_code == 404:
            error_type = NotFoundError
        elif response.status_code == 409:
            error_type = ConflictError
        elif response.status_code in {400, 422}:
            error_type = APIValidationError
        elif response.status_code == 429:
            error_type = RateLimitError
        elif response.status_code >= 500:
            error_type = ServerError
        else:
            error_type = APIError
        return error_type(**kwargs)
