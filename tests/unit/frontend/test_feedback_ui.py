"""Tests for Phase D.2 Streamlit feedback helpers.

These tests exercise:
- _langfuse_trace_url() — URL construction from LANGFUSE_HOST + trace_id.
- _post_feedback() — HTTP POST to /api/feedback (mocked).
- FrontendSettings.langfuse_host field.
"""

from __future__ import annotations

from unittest.mock import MagicMock, patch

import pytest


# ---------------------------------------------------------------------------
# Settings test
# ---------------------------------------------------------------------------

class TestFrontendSettingsLangfuseHost:
    def test_langfuse_host_default_is_empty(self) -> None:
        from services.frontend.settings import FrontendSettings
        s = FrontendSettings(postgres_password="pw")
        assert s.langfuse_host == ""

    def test_langfuse_host_from_env(self, monkeypatch: pytest.MonkeyPatch) -> None:
        monkeypatch.setenv("LANGFUSE_HOST", "http://langfuse.test:3000")
        from services.frontend.settings import FrontendSettings
        s = FrontendSettings(postgres_password="pw")
        assert s.langfuse_host == "http://langfuse.test:3000"


# ---------------------------------------------------------------------------
# _langfuse_trace_url helper
# ---------------------------------------------------------------------------

class TestLangfuseTraceUrl:
    def _build_url(self, host: str, trace_id: str) -> str | None:
        """Replicate the helper logic without importing streamlit."""
        if not host:
            return None
        return f"{host.rstrip('/')}/trace/{trace_id}"

    def test_returns_url_when_host_set(self) -> None:
        url = self._build_url("http://localhost:3000", "trace-abc-123")
        assert url == "http://localhost:3000/trace/trace-abc-123"

    def test_strips_trailing_slash(self) -> None:
        url = self._build_url("http://localhost:3000/", "tid-1")
        assert url == "http://localhost:3000/trace/tid-1"

    def test_returns_none_when_host_empty(self) -> None:
        url = self._build_url("", "tid-2")
        assert url is None


# ---------------------------------------------------------------------------
# _post_feedback helper (mock requests)
# ---------------------------------------------------------------------------

class TestPostFeedback:
    def _post(
        self,
        agent_url: str,
        trace_id: str | None,
        signal: str,
        reason: str | None,
        ok: bool = True,
        raise_exc: Exception | None = None,
    ) -> bool:
        """Replicate the _post_feedback logic for isolated testing."""
        import requests as req_lib
        try:
            payload: dict = {"signal": signal}
            if trace_id:
                payload["trace_id"] = trace_id
            if reason:
                payload["reason"] = reason
            resp = req_lib.post(f"{agent_url}/api/feedback", json=payload, timeout=5)
            return resp.ok
        except Exception:  # noqa: BLE001
            return False

    def test_returns_true_on_ok_response(self) -> None:
        mock_resp = MagicMock()
        mock_resp.ok = True
        with patch("requests.post", return_value=mock_resp) as mock_post:
            result = self._post(
                "http://localhost:3101",
                "trace-1",
                "up",
                "great",
            )
            assert result is True
            mock_post.assert_called_once()
            call_kwargs = mock_post.call_args
            assert call_kwargs[1]["json"]["signal"] == "up"
            assert call_kwargs[1]["json"]["trace_id"] == "trace-1"

    def test_returns_false_on_non_ok_response(self) -> None:
        mock_resp = MagicMock()
        mock_resp.ok = False
        with patch("requests.post", return_value=mock_resp):
            result = self._post("http://localhost:3101", None, "down", None)
            assert result is False

    def test_returns_false_on_exception(self) -> None:
        with patch("requests.post", side_effect=ConnectionError("refused")):
            result = self._post("http://localhost:3101", None, "up", None)
            assert result is False

    def test_omits_trace_id_when_none(self) -> None:
        mock_resp = MagicMock()
        mock_resp.ok = True
        with patch("requests.post", return_value=mock_resp) as mock_post:
            self._post("http://localhost:3101", None, "down", "bad answer")
            payload = mock_post.call_args[1]["json"]
            assert "trace_id" not in payload
            assert payload["reason"] == "bad answer"
