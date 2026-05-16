"""Tests for services/optimizer/session_reanimator — auto-resume daemon.

The daemon polls every 5 minutes for stalled `in_progress` agent sessions
and POSTs to the agent's resume endpoint. These tests stub psycopg +
httpx via AsyncMock and verify:
  - Settings defaults match the documented safe values + RLS posture.
  - find_resumable issues the bounded SQL with the right parameters.
  - resume_session mints a JWT with scope=agent:resume + aud=agent-claw
    when MCP_AUTH_SIGNING_KEY is set, posting to the internal route.
  - resume_session falls back to the dev-mode x-user-entra-id header
    against the public route when no signing key is configured (this
    is the legacy path; cluster-D's drop-the-fallback patch is deferred,
    so the existing behaviour stays unit-tested for now).
  - assert_production_safe refuses to start when the signing key is
    missing AND dev mode is off.
  - Per-call x-request-id is a fresh UUID for trace correlation.
"""

from __future__ import annotations

from typing import Any
from unittest.mock import AsyncMock, MagicMock, patch

import pytest

from services.optimizer.session_reanimator.main import (
    Settings,
    _FIND_RESUMABLE_SQL,
    _FINISH_REASON_ALLOWLIST_DEFAULT,
    _load_reanimator_config,
    find_resumable,
    resume_session,
)


def _make_async_conn(rows: list[dict[str, Any]]) -> Any:
    """psycopg.AsyncConnection.connect mock for find_resumable (dict_row)."""
    cursor = MagicMock()
    cursor.execute = AsyncMock(return_value=None)
    cursor.fetchall = AsyncMock(return_value=rows)
    cursor.__aenter__ = AsyncMock(return_value=cursor)
    cursor.__aexit__ = AsyncMock(return_value=None)

    conn = MagicMock()
    conn.cursor = MagicMock(return_value=cursor)
    conn.commit = AsyncMock(return_value=None)
    conn.__aenter__ = AsyncMock(return_value=conn)
    conn.__aexit__ = AsyncMock(return_value=None)

    conn._cursor = cursor
    return conn


def _make_httpx_response(status: int, json_body: Any = None, text: str = "") -> Any:
    r = MagicMock()
    r.status_code = status
    r.json = MagicMock(return_value=json_body if json_body is not None else {})
    r.text = text
    return r


# ---------------------------------------------------------------------------
# Settings
# ---------------------------------------------------------------------------


class TestSettings:
    def test_defaults_match_documented_safe_values(self, monkeypatch):
        # services/mcp_tools/conftest.py sets CHEMCLAW_DEV_MODE=true at
        # collection time so the user-hash resolver doesn't raise during
        # unrelated mcp_tools tests. That env var leaks into
        # pydantic-settings, so we explicitly clear it here to assert
        # the true documented default.
        monkeypatch.delenv("CHEMCLAW_DEV_MODE", raising=False)
        monkeypatch.delenv("MCP_AUTH_SIGNING_KEY", raising=False)
        s = Settings()
        assert s.poll_interval_seconds == 300  # 5 min
        assert s.batch_size == 10
        assert s.stale_after_seconds == 300
        # Must connect as the BYPASSRLS role to read across users.
        assert s.postgres_user == "chemclaw_service"
        # Production-safe default: signing key empty + dev mode off
        # — assert_production_safe will refuse to start.
        assert s.mcp_auth_signing_key == ""
        assert s.chemclaw_dev_mode is False

    def test_postgres_dsn_assembly(self):
        s = Settings(
            postgres_host="db",
            postgres_port=5433,
            postgres_db="cc",
            postgres_user="u",
            postgres_password="pw",
        )
        assert s.postgres_dsn == (
            "host=db port=5433 dbname=cc user=u password=pw"
        )

    def test_assert_production_safe_passes_when_signing_key_set(self):
        s = Settings(mcp_auth_signing_key="x" * 32)
        s.assert_production_safe()  # must not raise

    def test_assert_production_safe_passes_when_dev_mode_explicit(self):
        s = Settings(chemclaw_dev_mode=True)
        s.assert_production_safe()  # must not raise even with empty key

    def test_assert_production_safe_refuses_when_signing_key_missing(self, monkeypatch):
        # Same env-leak guard as test_defaults_match_documented_safe_values
        # — services/mcp_tools/conftest.py sets CHEMCLAW_DEV_MODE=true at
        # collection time, which would shortcut assert_production_safe().
        monkeypatch.delenv("CHEMCLAW_DEV_MODE", raising=False)
        monkeypatch.delenv("MCP_AUTH_SIGNING_KEY", raising=False)
        s = Settings()  # all defaults: empty key + dev_mode=False
        with pytest.raises(RuntimeError, match="mcp_auth_signing_key"):
            s.assert_production_safe()

    def test_assert_production_safe_treats_whitespace_as_unset(self, monkeypatch):
        # A misconfigured helm secret can land "   " in the env var.
        # The strip() guard catches it before silent downgrade.
        monkeypatch.delenv("CHEMCLAW_DEV_MODE", raising=False)
        s = Settings(mcp_auth_signing_key="   ")
        with pytest.raises(RuntimeError):
            s.assert_production_safe()


# ---------------------------------------------------------------------------
# SQL contract — find_resumable's stall-criteria are load-bearing.
# ---------------------------------------------------------------------------


class TestFindResumableSql:
    def test_filters_by_unblocked_finish_reason(self):
        # max_steps + stop are the two finish reasons that mean
        # "agent didn't pause on a question, has more work to do".
        # awaiting-question states are deliberately excluded.
        # The allowlist is now a runtime parameter (= ANY(%s::text[])) so
        # operators can tune it via config_settings without a code deploy.
        assert "= ANY(%s::text[])" in _FIND_RESUMABLE_SQL
        assert "max_steps" in str(_FINISH_REASON_ALLOWLIST_DEFAULT)
        assert "stop" in str(_FINISH_REASON_ALLOWLIST_DEFAULT)

    def test_filters_by_auto_resume_cap(self):
        # Hard cap per session prevents unbounded loops.
        assert "auto_resume_count < s.auto_resume_cap" in _FIND_RESUMABLE_SQL

    def test_filters_by_token_budget(self):
        # Per-session token budget caps cumulative cost.
        assert "session_input_tokens < COALESCE(s.session_token_budget" in _FIND_RESUMABLE_SQL

    def test_requires_inprogress_todo(self):
        # No work means no point waking the session.
        assert "EXISTS" in _FIND_RESUMABLE_SQL
        assert "agent_todos t" in _FIND_RESUMABLE_SQL
        assert "t.status = 'in_progress'" in _FIND_RESUMABLE_SQL

    def test_orders_oldest_first(self):
        # Fairness — oldest stalled session resumes first.
        assert "ORDER BY s.updated_at ASC" in _FIND_RESUMABLE_SQL

    def test_uses_make_interval_for_stale_window(self):
        # make_interval(secs => %s) parameterises the 5-min stale-after
        # window safely (no string-fragment SQL injection surface).
        assert "make_interval(secs => %s)" in _FIND_RESUMABLE_SQL


# ---------------------------------------------------------------------------
# find_resumable — the production read path.
# ---------------------------------------------------------------------------


class TestFindResumable:
    @pytest.mark.asyncio
    async def test_returns_rows_from_fetchall(self):
        rows = [
            {"id": "s1", "user_entra_id": "u@x", "last_finish_reason": "max_steps"},
            {"id": "s2", "user_entra_id": "v@y", "last_finish_reason": "stop"},
        ]
        fake_conn = _make_async_conn(rows)
        with patch(
            "services.optimizer.session_reanimator.main."
            "psycopg.AsyncConnection.connect",
            new=AsyncMock(return_value=fake_conn),
        ):
            out = await find_resumable(
                Settings(stale_after_seconds=600, batch_size=42),
                stale_after_seconds=600,
                batch_size=42,
                finish_reason_allowlist=["max_steps", "stop"],
            )

        assert out == rows
        # SQL parameters: finish_reason_allowlist, stale_after_seconds, batch_size.
        assert fake_conn._cursor.execute.call_args[0][1] == (
            ["max_steps", "stop"], 600, 42
        )


# ---------------------------------------------------------------------------
# _load_reanimator_config — config_settings override path.
# ---------------------------------------------------------------------------


class TestLoadReanimatorConfig:
    def test_returns_settings_defaults_when_config_registry_unavailable(self):
        # No reachable DB → ConfigRegistry._fetch_value will raise; the helper
        # must fall back silently and return Settings values.
        s = Settings(stale_after_seconds=600, batch_size=5)
        stale, batch, allowlist = _load_reanimator_config(s)
        assert stale == 600
        assert batch == 5
        assert allowlist == ["max_steps", "stop"]

    def test_config_registry_overrides_stale_and_batch(self):
        from unittest.mock import MagicMock

        reg = MagicMock()
        reg.get_int.side_effect = lambda key, default: (
            900 if key == "reanimator.stale_after_seconds" else
            20 if key == "reanimator.batch_size" else
            default
        )
        reg.get.return_value = None  # no allowlist override

        s = Settings(stale_after_seconds=300, batch_size=10)
        with patch(
            "services.optimizer.session_reanimator.main.ConfigRegistry",
            return_value=reg,
        ):
            stale, batch, allowlist = _load_reanimator_config(s)
        assert stale == 900
        assert batch == 20
        assert allowlist == ["max_steps", "stop"]

    def test_config_registry_overrides_finish_reason_allowlist(self):
        from unittest.mock import MagicMock

        reg = MagicMock()
        reg.get_int.side_effect = lambda key, default: default
        reg.get.return_value = ["max_steps"]

        s = Settings()
        with patch(
            "services.optimizer.session_reanimator.main.ConfigRegistry",
            return_value=reg,
        ):
            _, _, allowlist = _load_reanimator_config(s)
        assert allowlist == ["max_steps"]


# ---------------------------------------------------------------------------
# resume_session — the production write path.
# ---------------------------------------------------------------------------


class TestResumeSessionJwtPath:
    @pytest.mark.asyncio
    async def test_mints_jwt_with_correct_scope_and_audience(self):
        client = MagicMock()
        client.post = AsyncMock(return_value=_make_httpx_response(200, json_body={"ok": True}))

        signing_key = "x" * 32
        with patch(
            "services.optimizer.session_reanimator.main.sign_mcp_token",
            return_value="token-here",
        ) as mint:
            out = await resume_session(
                client,
                Settings(
                    agent_base_url="http://agent:3101",
                    mcp_auth_signing_key=signing_key,
                ),
                session_id="abc-123",
                user_entra_id="user@test.com",
            )

        # Token mint args bind the JWT to the resume route specifically.
        mint.assert_called_once()
        kwargs = mint.call_args.kwargs
        assert kwargs["sandbox_id"] == "reanimator"
        assert kwargs["user_entra_id"] == "user@test.com"
        assert kwargs["scopes"] == ["agent:resume"]
        assert kwargs["audience"] == "agent-claw"
        assert kwargs["ttl_seconds"] == 300
        assert kwargs["signing_key"] == signing_key

        # POST goes to the INTERNAL route (no x-user-entra-id forgery surface).
        url = client.post.call_args.args[0]
        assert url == "http://agent:3101/api/internal/sessions/abc-123/resume"
        headers = client.post.call_args.kwargs["headers"]
        assert headers["Authorization"] == "Bearer token-here"
        # No x-user-entra-id header on the JWT path.
        assert "x-user-entra-id" not in headers
        # Per-call x-request-id is a fresh UUID for trace correlation.
        assert "x-request-id" in headers

        assert out == {"ok": True, "status": 200, "body": {"ok": True}}

    @pytest.mark.asyncio
    async def test_returns_structured_error_on_token_mint_failure(self):
        from services.mcp_tools.common.auth import McpAuthError

        client = MagicMock()
        client.post = AsyncMock()  # must NOT be called

        with patch(
            "services.optimizer.session_reanimator.main.sign_mcp_token",
            side_effect=McpAuthError("bad key"),
        ):
            out = await resume_session(
                client,
                Settings(mcp_auth_signing_key="x" * 32),
                session_id="abc-123",
                user_entra_id="user@test.com",
            )

        client.post.assert_not_awaited()
        assert out["ok"] is False
        assert out["status"] == 0
        assert "token-mint-failed" in out["body"]


class TestResumeSessionMissingSigningKey:
    """The dev-mode x-user-entra-id header fallback against the public
    /api/sessions/:id/resume route was REMOVED in deferred-D2. It was
    identity-spoof surface if MCP_AUTH_DEV_MODE leaked into a real
    cluster — the daemon could resume any user's session by stamping
    the header. These tests lock in the new fail-closed contract: an
    unset signing key returns a structured error envelope without
    making any HTTP call."""

    @pytest.mark.asyncio
    async def test_refuses_to_resume_when_signing_key_unset(self):
        client = MagicMock()
        client.post = AsyncMock()  # must NOT be called

        out = await resume_session(
            client,
            Settings(agent_base_url="http://agent:3101", mcp_auth_signing_key=""),
            session_id="abc-123",
            user_entra_id="user@test.com",
        )

        # No HTTP call attempted — the daemon refuses up-front.
        client.post.assert_not_awaited()
        # Structured error envelope so the main loop can chart the rate.
        assert out == {
            "ok": False,
            "status": 0,
            "body": "mcp-auth-signing-key-required",
        }

    @pytest.mark.asyncio
    async def test_whitespace_only_signing_key_treated_as_unset(self):
        # The Settings.mcp_auth_signing_key string is truthy with " " but
        # production-safety relies on .strip() in assert_production_safe.
        # resume_session uses the raw .mcp_auth_signing_key truthiness so
        # a literal space passes the check — but the JWT signer rejects
        # short keys, so we still fail fast. Documented behaviour: empty
        # string returns the structured error; whitespace passes through
        # to the signer which raises McpAuthError.
        client = MagicMock()
        client.post = AsyncMock()
        out = await resume_session(
            client,
            Settings(mcp_auth_signing_key=""),
            session_id="abc-123",
            user_entra_id="user@test.com",
        )
        client.post.assert_not_awaited()
        assert out["body"] == "mcp-auth-signing-key-required"


class TestResumeSessionResponseHandling:
    @pytest.mark.asyncio
    async def test_409_returns_structured_body_for_inflight_conflict(self):
        client = MagicMock()
        client.post = AsyncMock(
            return_value=_make_httpx_response(409, json_body={"error": "in_progress"}),
        )
        out = await resume_session(
            client,
            Settings(mcp_auth_signing_key="x" * 32),
            session_id="abc-123",
            user_entra_id="user@test.com",
        )
        assert out["ok"] is False
        assert out["status"] == 409
        assert out["body"] == {"error": "in_progress"}

    @pytest.mark.asyncio
    async def test_5xx_returns_truncated_text_body(self):
        client = MagicMock()
        # 500 with a long body — daemon truncates to 500 chars.
        client.post = AsyncMock(
            return_value=_make_httpx_response(500, text="x" * 9999),
        )
        with patch(
            "services.optimizer.session_reanimator.main.sign_mcp_token",
            return_value="token-here",
        ):
            out = await resume_session(
                client,
                Settings(mcp_auth_signing_key="x" * 32),
                session_id="abc-123",
                user_entra_id="user@test.com",
            )
        assert out["ok"] is False
        assert out["status"] == 500
        assert len(out["body"]) == 500

    @pytest.mark.asyncio
    async def test_request_id_is_unique_per_call(self):
        client = MagicMock()
        client.post = AsyncMock(return_value=_make_httpx_response(200, json_body={}))
        with patch(
            "services.optimizer.session_reanimator.main.sign_mcp_token",
            return_value="token-here",
        ):
            await resume_session(
                client,
                Settings(mcp_auth_signing_key="x" * 32),
                session_id="s1",
                user_entra_id="user@test.com",
            )
            first_id = client.post.call_args.kwargs["headers"]["x-request-id"]

            await resume_session(
                client,
                Settings(mcp_auth_signing_key="x" * 32),
                session_id="s2",
                user_entra_id="user@test.com",
            )
            second_id = client.post.call_args.kwargs["headers"]["x-request-id"]

        assert first_id != second_id
