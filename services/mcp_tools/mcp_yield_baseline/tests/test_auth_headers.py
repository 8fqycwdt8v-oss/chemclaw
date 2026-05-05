"""DR-12 Bearer-auth fan-out: when mcp-yield-baseline calls mcp-drfp and
mcp-chemprop on its own (not via the agent-claw harness), every outbound
request must carry an Authorization header minted via the shared
McpTokenCache. PR #87 added `auth_headers(...)` to both fan-out call sites
in `services/mcp_tools/mcp_yield_baseline/main.py`; this regression test
locks the wiring so a future refactor that drops the header is caught.

We avoid a live FastAPI route invocation (anyio.to_thread + heavy
xgboost dependency) and instead exercise `_encode_drfp_batch` and
`_call_chemprop_batch` directly with httpx.Client patched.
"""
from __future__ import annotations

from contextlib import contextmanager
from typing import Any
from unittest import mock

import pytest

from services.mcp_tools.common.auth import verify_mcp_token
from services.mcp_tools.common.mcp_token_cache import default_cache
from services.mcp_tools.mcp_yield_baseline import main as ybl


SIGNING_KEY = "test-signing-key-with-at-least-thirty-two-chars-and-then-some"


class _FakeResp:
    """Tiny stand-in for httpx.Response — only the methods our caller uses."""

    def __init__(self, payload: dict[str, Any]) -> None:
        self._payload = payload
        self.status_code = 200

    def raise_for_status(self) -> None:
        return None

    def json(self) -> dict[str, Any]:
        return self._payload


class _FakeClient:
    """Records the headers of every POST so the test can assert on them."""

    def __init__(self, payload: dict[str, Any]) -> None:
        self.payload = payload
        self.captured: list[dict[str, str]] = []

    def __enter__(self) -> "_FakeClient":
        return self

    def __exit__(self, *exc: object) -> None:
        return None

    def post(self, url: str, *, json: dict[str, Any], headers: dict[str, str] | None = None) -> _FakeResp:  # noqa: A002
        self.captured.append(headers or {})
        return _FakeResp(self.payload)


@contextmanager
def _patch_httpx_client(payload: dict[str, Any]):
    fake = _FakeClient(payload)
    with mock.patch.object(ybl.httpx, "Client", lambda *a, **kw: fake):
        yield fake


@pytest.fixture(autouse=True)
def _isolated_token_cache(monkeypatch: pytest.MonkeyPatch):
    """Prevent module-state token cache from leaking between tests."""
    default_cache().invalidate()
    yield
    default_cache().invalidate()


def test_drfp_fanout_sends_authorization_header(monkeypatch: pytest.MonkeyPatch) -> None:
    monkeypatch.setenv("MCP_AUTH_SIGNING_KEY", SIGNING_KEY)

    drfp_payload = {"vectors": [{"vector": [0.0] * 2048}]}
    with _patch_httpx_client(drfp_payload) as fake:
        out = ybl._encode_drfp_batch(["CC>>CO"])

    assert out == [[0.0] * 2048]
    assert len(fake.captured) == 1
    auth = fake.captured[0].get("Authorization", "")
    assert auth.startswith("Bearer "), "DR-12 regression: drfp call missing Bearer header"

    token = auth.split(" ", 1)[1]
    claims = verify_mcp_token(token, signing_key=SIGNING_KEY, expected_audience="mcp-drfp")
    assert "mcp_drfp:invoke" in claims.scopes


def test_chemprop_fanout_sends_authorization_header(monkeypatch: pytest.MonkeyPatch) -> None:
    monkeypatch.setenv("MCP_AUTH_SIGNING_KEY", SIGNING_KEY)

    chemprop_payload = {"predictions": [{"mean": 50.0, "std": 5.0}]}
    with _patch_httpx_client(chemprop_payload) as fake:
        out = ybl._call_chemprop_batch(["CC>>CO"])

    assert out == [(50.0, 5.0)]
    auth = fake.captured[0].get("Authorization", "")
    assert auth.startswith("Bearer "), "DR-12 regression: chemprop call missing Bearer header"

    token = auth.split(" ", 1)[1]
    claims = verify_mcp_token(token, signing_key=SIGNING_KEY, expected_audience="mcp-chemprop")
    assert "mcp_chemprop:invoke" in claims.scopes


def test_drfp_fanout_omits_header_in_dev_mode(monkeypatch: pytest.MonkeyPatch) -> None:
    """Without MCP_AUTH_SIGNING_KEY the cache returns None and `auth_headers`
    yields {} — receiving service in dev mode accepts the unsigned request."""
    monkeypatch.delenv("MCP_AUTH_SIGNING_KEY", raising=False)

    drfp_payload = {"vectors": [{"vector": [0.0] * 2048}]}
    with _patch_httpx_client(drfp_payload) as fake:
        ybl._encode_drfp_batch(["CC>>CO"])

    assert "Authorization" not in fake.captured[0]


def test_chemprop_fanout_omits_header_in_dev_mode(monkeypatch: pytest.MonkeyPatch) -> None:
    monkeypatch.delenv("MCP_AUTH_SIGNING_KEY", raising=False)

    chemprop_payload = {"predictions": [{"mean": 50.0, "std": 5.0}]}
    with _patch_httpx_client(chemprop_payload) as fake:
        ybl._call_chemprop_batch(["CC>>CO"])

    assert "Authorization" not in fake.captured[0]
