"""Tests for API retries, idempotency, and typed failures.

Test classes:
    - TestRetryPolicy: safe/idempotent retry boundaries.
    - TestTypedErrors: stable response-to-exception mapping.
"""

from __future__ import annotations

import httpx
import pytest
import respx

from qdag.client import APIClient, RetryPolicy
from qdag.errors import AuthenticationError, ServerError

BASE_URL = "https://registry.example.test"
TOKEN = "test-token-not-printed"


class TestRetryPolicy:
    """Retry only safe or explicitly idempotent requests."""

    @respx.mock
    def test_get_retries_transient_server_error(self) -> None:
        route = respx.get(f"{BASE_URL}/api/v1/spaces").mock(
            side_effect=[
                httpx.Response(503, json={"error": "temporary"}),
                httpx.Response(200, json={"items": []}),
            ]
        )
        sleeps: list[float] = []
        with APIClient(
            BASE_URL,
            TOKEN,
            retry_policy=RetryPolicy(max_attempts=3, base_delay_seconds=0.01),
            sleeper=sleeps.append,
        ) as client:
            result = client.get("/api/v1/spaces")

        assert result == {"items": []}
        assert route.call_count == 2
        assert sleeps == [0.01]
        assert all(call.request.content == b"" for call in route.calls)

    @respx.mock
    def test_post_reuses_one_idempotency_key_across_retries(self) -> None:
        route = respx.post(f"{BASE_URL}/api/v1/runs").mock(
            side_effect=[
                httpx.Response(503, json={"error": "temporary"}),
                httpx.Response(201, json={"id": "run-1"}),
            ]
        )
        with APIClient(BASE_URL, TOKEN, sleeper=lambda _delay: None) as client:
            result = client.post(
                "/api/v1/runs",
                {"experiment_id": "exp-1"},
                idempotency_key="stable-key",
            )

        assert result == {"id": "run-1"}
        assert route.call_count == 2
        assert {call.request.headers["Idempotency-Key"] for call in route.calls} == {"stable-key"}
        assert all(
            call.request.headers["Authorization"] == f"Bearer {TOKEN}" for call in route.calls
        )

    @respx.mock
    def test_non_idempotent_raw_post_is_not_retried(self) -> None:
        route = respx.post(f"{BASE_URL}/api/v1/unsafe").mock(
            return_value=httpx.Response(503, json={"error": "temporary"})
        )
        with (
            APIClient(BASE_URL, TOKEN, sleeper=lambda _delay: None) as client,
            pytest.raises(ServerError),
        ):
            client.request("POST", "/api/v1/unsafe", json_body={"value": 1})

        assert route.call_count == 1

    @respx.mock
    def test_safe_transport_failure_is_retried(self) -> None:
        route = respx.get(f"{BASE_URL}/api/v1/spaces").mock(
            side_effect=[
                httpx.ConnectError("connection reset"),
                httpx.Response(200, json={"items": ["space-1"]}),
            ]
        )
        with APIClient(BASE_URL, TOKEN, sleeper=lambda _delay: None) as client:
            result = client.get("/api/v1/spaces")

        assert result == {"items": ["space-1"]}
        assert route.call_count == 2


class TestTypedErrors:
    """Map stable status classes to explicit public errors."""

    @respx.mock
    def test_unauthorized_response_raises_authentication_error(self) -> None:
        respx.get(f"{BASE_URL}/api/v1/auth/status").mock(
            return_value=httpx.Response(
                401,
                json={
                    "error": {
                        "code": "invalid_token",
                        "message": "Personal token is invalid",
                    }
                },
                headers={"x-request-id": "request-123"},
            )
        )
        with (
            APIClient(BASE_URL, TOKEN) as client,
            pytest.raises(AuthenticationError) as captured,
        ):
            client.get("/api/v1/auth/status")

        assert captured.value.code == "invalid_token"
        assert captured.value.request_id == "request-123"
        assert TOKEN not in str(captured.value)
