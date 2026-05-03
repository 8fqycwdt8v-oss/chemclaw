"""Verify the queue worker mints + sends MCP JWTs on every dispatch.

Doesn't run the lease loop — instead invokes a single handler from
`_build_handlers` against a stub HTTPX client and asserts the
`Authorization: Bearer ...` header is set when MCP_AUTH_SIGNING_KEY is
present, and absent otherwise.
"""

from __future__ import annotations

import asyncio
from unittest.mock import MagicMock

import pytest

from services.mcp_tools.common.auth import verify_mcp_token
from services.queue import worker


SIGNING_KEY = "test-signing-key-with-at-least-thirty-two-chars-and-then-some"


class _FakeResponse:
    status_code = 200

    def json(self) -> dict:
        return {"ok": True}


def _stub_client_returning(captured_headers: list[dict]) -> MagicMock:
    client = MagicMock()

    async def fake_post(url: str, json: dict, headers: dict | None = None):
        captured_headers.append(headers or {})
        return _FakeResponse()

    client.post = MagicMock(side_effect=fake_post)
    return client


def _patch_handler(monkeypatch, handler_factory_returns: MagicMock) -> None:
    monkeypatch.setattr(
        worker.httpx, "AsyncClient",
        lambda *a, **kw: handler_factory_returns,
    )


def test_handler_sends_authorization_header_when_key_set(monkeypatch):
    monkeypatch.setenv("MCP_AUTH_SIGNING_KEY", SIGNING_KEY)
    captured: list[dict] = []
    client = _stub_client_returning(captured)
    _patch_handler(monkeypatch, client)

    handlers = worker._build_handlers(worker.WorkerSettings())
    asyncio.run(handlers["qm_single_point"]({"smiles": "CCO"}))
    assert len(captured) == 1
    assert captured[0]["Authorization"].startswith("Bearer ")
    token = captured[0]["Authorization"].split(" ", 1)[1]
    claims = verify_mcp_token(
        token, signing_key=SIGNING_KEY, expected_audience="mcp-xtb",
    )
    assert "mcp_xtb:invoke" in claims.scopes


def test_handler_omits_authorization_header_in_dev_mode(monkeypatch):
    monkeypatch.delenv("MCP_AUTH_SIGNING_KEY", raising=False)
    captured: list[dict] = []
    client = _stub_client_returning(captured)
    _patch_handler(monkeypatch, client)

    handlers = worker._build_handlers(worker.WorkerSettings())
    asyncio.run(handlers["qm_geometry_opt"]({"smiles": "CCO"}))
    assert len(captured) == 1
    assert "Authorization" not in captured[0]


def test_genchem_handler_uses_genchem_audience(monkeypatch):
    monkeypatch.setenv("MCP_AUTH_SIGNING_KEY", SIGNING_KEY)
    captured: list[dict] = []
    client = _stub_client_returning(captured)
    _patch_handler(monkeypatch, client)

    handlers = worker._build_handlers(worker.WorkerSettings())
    asyncio.run(handlers["genchem_scaffold"]({"scaffold_smiles": "c1ccccc1[*:1]"}))
    token = captured[0]["Authorization"].split(" ", 1)[1]
    claims = verify_mcp_token(
        token, signing_key=SIGNING_KEY, expected_audience="mcp-genchem",
    )
    assert "mcp_genchem:invoke" in claims.scopes


def test_crest_handler_uses_crest_audience(monkeypatch):
    monkeypatch.setenv("MCP_AUTH_SIGNING_KEY", SIGNING_KEY)
    captured: list[dict] = []
    client = _stub_client_returning(captured)
    _patch_handler(monkeypatch, client)

    handlers = worker._build_handlers(worker.WorkerSettings())
    asyncio.run(handlers["qm_crest_conformers"]({"smiles": "CCO"}))
    token = captured[0]["Authorization"].split(" ", 1)[1]
    claims = verify_mcp_token(
        token, signing_key=SIGNING_KEY, expected_audience="mcp-crest",
    )
    assert "mcp_crest:invoke" in claims.scopes
