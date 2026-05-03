"""Verify the workflow engine mints + sends MCP JWTs on tool_call steps."""

from __future__ import annotations

import asyncio
from unittest.mock import MagicMock

from services.mcp_tools.common.auth import verify_mcp_token
from services.workflow_engine.main import EngineSettings, WorkflowEngine


SIGNING_KEY = "test-signing-key-with-at-least-thirty-two-chars-and-then-some"


class _FakeResponse:
    status_code = 200

    def json(self) -> dict:
        return {"job_id": "job-1", "cache_hit": False}


def _stub_client_capturing(captured: list[dict]) -> MagicMock:
    client = MagicMock()

    async def fake_post(url: str, json: dict, headers: dict | None = None):
        captured.append({"url": url, "headers": headers or {}})
        return _FakeResponse()

    client.post = MagicMock(side_effect=fake_post)
    return client


def test_tool_service_routing():
    """qm_* → mcp-xtb, qm_crest_* → mcp-crest, generate_* → mcp-genchem."""
    f = WorkflowEngine._tool_service
    assert f("qm_single_point") == "mcp-xtb"
    assert f("qm_geometry_opt") == "mcp-xtb"
    assert f("qm_frequencies") == "mcp-xtb"
    assert f("qm_fukui") == "mcp-xtb"
    assert f("qm_redox_potential") == "mcp-xtb"
    assert f("qm_crest_screen") == "mcp-crest"
    assert f("generate_focused_library") == "mcp-genchem"


def test_exec_tool_call_sends_authorization_when_key_set(monkeypatch):
    monkeypatch.setenv("MCP_AUTH_SIGNING_KEY", SIGNING_KEY)
    captured: list[dict] = []
    eng = WorkflowEngine(EngineSettings())
    eng._http = _stub_client_capturing(captured)

    asyncio.run(eng._exec_tool_call(
        {"id": "s1", "kind": "tool_call", "tool": "qm_single_point", "args": {"smiles": "CCO"}},
        {},
    ))
    assert len(captured) == 1
    assert captured[0]["headers"]["Authorization"].startswith("Bearer ")
    token = captured[0]["headers"]["Authorization"].split(" ", 1)[1]
    claims = verify_mcp_token(
        token, signing_key=SIGNING_KEY, expected_audience="mcp-xtb",
    )
    assert "mcp_xtb:invoke" in claims.scopes


def test_exec_tool_call_omits_authorization_in_dev_mode(monkeypatch):
    monkeypatch.delenv("MCP_AUTH_SIGNING_KEY", raising=False)
    captured: list[dict] = []
    eng = WorkflowEngine(EngineSettings())
    eng._http = _stub_client_capturing(captured)

    asyncio.run(eng._exec_tool_call(
        {"id": "s1", "kind": "tool_call", "tool": "qm_single_point", "args": {}},
        {},
    ))
    assert "Authorization" not in captured[0]["headers"]


def test_exec_tool_call_uses_genchem_audience(monkeypatch):
    monkeypatch.setenv("MCP_AUTH_SIGNING_KEY", SIGNING_KEY)
    captured: list[dict] = []
    eng = WorkflowEngine(EngineSettings())
    eng._http = _stub_client_capturing(captured)

    asyncio.run(eng._exec_tool_call(
        {"id": "s1", "kind": "tool_call", "tool": "generate_focused_library",
         "args": {"kind": "scaffold", "seed_smiles": "c1ccccc1[*:1]"}},
        {},
    ))
    token = captured[0]["headers"]["Authorization"].split(" ", 1)[1]
    claims = verify_mcp_token(
        token, signing_key=SIGNING_KEY, expected_audience="mcp-genchem",
    )
    assert "mcp_genchem:invoke" in claims.scopes
