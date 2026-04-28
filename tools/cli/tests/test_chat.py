"""Tests for `chemclaw chat`."""

from __future__ import annotations

import json
from collections.abc import Callable
from pathlib import Path

import httpx
import pytest
from typer.testing import CliRunner

from chemclaw_cli.app import app
from chemclaw_cli.session_store import SessionStore


def _sse_response(events: list[dict], status_code: int = 200) -> httpx.Response:
    """Build an SSE-shaped Response from a list of event dicts."""
    body = "".join(f"data: {json.dumps(e)}\n\n" for e in events).encode()
    return httpx.Response(
        status_code=status_code,
        headers={"content-type": "text/event-stream"},
        content=body,
    )


def _patch_transport(
    monkeypatch: pytest.MonkeyPatch,
    handler: Callable[[httpx.Request], httpx.Response],
) -> list[httpx.Request]:
    """Replace httpx.Client with one that uses MockTransport(handler).

    Returns a list that captures every request made — tests can then
    assert on headers / bodies after running the command.
    """
    captured: list[httpx.Request] = []

    def _capturing_handler(request: httpx.Request) -> httpx.Response:
        captured.append(request)
        return handler(request)

    transport = httpx.MockTransport(_capturing_handler)
    real_client = httpx.Client

    def _factory(*args, **kwargs):  # type: ignore[no-untyped-def]
        kwargs["transport"] = transport
        return real_client(*args, **kwargs)

    monkeypatch.setattr(httpx, "Client", _factory)
    return captured


def test_streams_text_deltas_to_stdout(monkeypatch: pytest.MonkeyPatch) -> None:
    events = [
        {"type": "text_delta", "delta": "hello "},
        {"type": "text_delta", "delta": "world"},
        {
            "type": "finish",
            "finishReason": "stop",
            "usage": {"promptTokens": 1, "completionTokens": 2},
        },
    ]
    _patch_transport(monkeypatch, lambda req: _sse_response(events))

    result = CliRunner().invoke(app, ["chat", "hi"])
    assert result.exit_code == 0
    assert "hello world" in result.stdout


def test_sends_user_header_from_env(monkeypatch: pytest.MonkeyPatch) -> None:
    monkeypatch.setenv("CHEMCLAW_USER", "alice@corp.test")
    captured = _patch_transport(
        monkeypatch,
        lambda req: _sse_response(
            [
                {
                    "type": "finish",
                    "finishReason": "stop",
                    "usage": {"promptTokens": 0, "completionTokens": 0},
                }
            ]
        ),
    )

    result = CliRunner().invoke(app, ["chat", "hi"])
    assert result.exit_code == 0
    assert captured[0].headers["x-user-entra-id"] == "alice@corp.test"


def test_sends_messages_array_and_no_session_on_fresh(monkeypatch: pytest.MonkeyPatch) -> None:
    captured = _patch_transport(
        monkeypatch,
        lambda req: _sse_response(
            [
                {
                    "type": "finish",
                    "finishReason": "stop",
                    "usage": {"promptTokens": 0, "completionTokens": 0},
                }
            ]
        ),
    )

    CliRunner().invoke(app, ["chat", "hello"])
    body = json.loads(captured[0].content.decode())
    assert body["messages"] == [{"role": "user", "content": "hello"}]
    assert "session_id" not in body or body.get("session_id") is None


def test_writes_session_id_on_session_event(
    monkeypatch: pytest.MonkeyPatch, tmp_path: Path
) -> None:
    monkeypatch.setenv("CHEMCLAW_CONFIG_DIR", str(tmp_path / "chemclaw"))
    monkeypatch.setenv("CHEMCLAW_USER", "alice@corp.test")
    sid = "11111111-1111-1111-1111-111111111111"
    events = [
        {"type": "session", "session_id": sid},
        {"type": "text_delta", "delta": "hi"},
        {
            "type": "finish",
            "finishReason": "stop",
            "usage": {"promptTokens": 0, "completionTokens": 0},
        },
    ]
    _patch_transport(monkeypatch, lambda req: _sse_response(events))

    result = CliRunner().invoke(app, ["chat", "hello"])
    assert result.exit_code == 0
    assert SessionStore(tmp_path / "chemclaw").read("alice@corp.test") == sid


def test_resume_sends_stored_session_id(
    monkeypatch: pytest.MonkeyPatch, tmp_path: Path
) -> None:
    monkeypatch.setenv("CHEMCLAW_CONFIG_DIR", str(tmp_path / "chemclaw"))
    monkeypatch.setenv("CHEMCLAW_USER", "alice@corp.test")
    sid = "22222222-2222-2222-2222-222222222222"
    SessionStore(tmp_path / "chemclaw").write("alice@corp.test", sid)
    captured = _patch_transport(
        monkeypatch,
        lambda req: _sse_response(
            [
                {
                    "type": "finish",
                    "finishReason": "stop",
                    "usage": {"promptTokens": 0, "completionTokens": 0},
                }
            ]
        ),
    )

    result = CliRunner().invoke(app, ["chat", "--resume", "follow up"])
    assert result.exit_code == 0
    body = json.loads(captured[0].content.decode())
    assert body["session_id"] == sid


def test_resume_with_no_stored_session_exits_5(
    monkeypatch: pytest.MonkeyPatch, tmp_path: Path
) -> None:
    monkeypatch.setenv("CHEMCLAW_CONFIG_DIR", str(tmp_path / "chemclaw"))
    monkeypatch.setenv("CHEMCLAW_USER", "noone@corp.test")
    # No transport patched — should exit before any HTTP call.
    result = CliRunner().invoke(app, ["chat", "--resume", "x"])
    assert result.exit_code == 5
    combined = (result.stdout or "") + (result.stderr or "")
    assert "no saved session" in combined.lower()


def test_explicit_session_flag_overrides_resume(
    monkeypatch: pytest.MonkeyPatch, tmp_path: Path
) -> None:
    monkeypatch.setenv("CHEMCLAW_CONFIG_DIR", str(tmp_path / "chemclaw"))
    monkeypatch.setenv("CHEMCLAW_USER", "alice@corp.test")
    SessionStore(tmp_path / "chemclaw").write(
        "alice@corp.test", "aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa"
    )
    captured = _patch_transport(
        monkeypatch,
        lambda req: _sse_response(
            [
                {
                    "type": "finish",
                    "finishReason": "stop",
                    "usage": {"promptTokens": 0, "completionTokens": 0},
                }
            ]
        ),
    )

    explicit = "33333333-3333-3333-3333-333333333333"
    result = CliRunner().invoke(app, ["chat", "--resume", "--session", explicit, "x"])
    assert result.exit_code == 0
    body = json.loads(captured[0].content.decode())
    assert body["session_id"] == explicit


def test_awaiting_user_input_exits_2(monkeypatch: pytest.MonkeyPatch, tmp_path: Path) -> None:
    monkeypatch.setenv("CHEMCLAW_CONFIG_DIR", str(tmp_path / "chemclaw"))
    monkeypatch.setenv("CHEMCLAW_USER", "alice@corp.test")
    sid = "44444444-4444-4444-4444-444444444444"
    events = [
        {"type": "session", "session_id": sid},
        {"type": "awaiting_user_input", "session_id": sid, "question": "Which solvent?"},
    ]
    _patch_transport(monkeypatch, lambda req: _sse_response(events))

    result = CliRunner().invoke(app, ["chat", "ambiguous"])
    assert result.exit_code == 2
    assert "Which solvent?" in result.stdout
    # The session_id must still be stored so a follow-up --resume works.
    assert SessionStore(tmp_path / "chemclaw").read("alice@corp.test") == sid


def test_error_event_exits_1(monkeypatch: pytest.MonkeyPatch) -> None:
    events = [{"type": "error", "error": "model timeout"}]
    _patch_transport(monkeypatch, lambda req: _sse_response(events))

    result = CliRunner().invoke(app, ["chat", "boom"])
    assert result.exit_code == 1
    assert "model timeout" in result.stdout


def test_connect_error_exits_3(monkeypatch: pytest.MonkeyPatch) -> None:
    def _raise(_request: httpx.Request) -> httpx.Response:
        raise httpx.ConnectError("nope")

    _patch_transport(monkeypatch, _raise)

    result = CliRunner().invoke(app, ["chat", "x"])
    assert result.exit_code == 3
    assert "not reachable" in result.stdout.lower()


def test_http_401_exits_4(monkeypatch: pytest.MonkeyPatch) -> None:
    _patch_transport(monkeypatch, lambda req: httpx.Response(status_code=401, content=b"nope"))

    result = CliRunner().invoke(app, ["chat", "x"])
    assert result.exit_code == 4
    assert "auth" in result.stdout.lower()


def test_http_500_exits_1(monkeypatch: pytest.MonkeyPatch) -> None:
    _patch_transport(
        monkeypatch, lambda req: httpx.Response(status_code=500, content=b"server boom")
    )

    result = CliRunner().invoke(app, ["chat", "x"])
    assert result.exit_code == 1
    assert "server boom" in result.stdout
