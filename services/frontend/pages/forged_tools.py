"""Streamlit Forged Tools page — Phase D.5.

Lists every forged tool the user can see (via RLS-scoped API).
Per row: name, version, scope badge, success-rate sparkline, forged_by_model, forged_by_role.
Click a row → opens a detail panel with code, test cases, recent validation runs.
Admin-only: Promote to project, Promote to org, Disable.
"""

from __future__ import annotations

import logging
from typing import Any

import requests
import streamlit as st

from services.frontend.settings import get_settings

_log = logging.getLogger(__name__)

st.set_page_config(page_title="ChemClaw — Forged Tools", page_icon="🔨", layout="wide")

settings = get_settings()
AGENT_URL = settings.agent_base_url.rstrip("/")

# User Entra ID is surfaced from query params in dev; replaced by auth header in prod.
user_entra_id = st.query_params.get("user_id", "dev@example.com")

# ---- Admin check (mirrors server-side AGENT_ADMIN_USERS env var) --------------------

import os

_ADMIN_USERS = {
    u.strip().lower()
    for u in os.environ.get("AGENT_ADMIN_USERS", "").split(",")
    if u.strip()
}
_is_admin = user_entra_id.lower() in _ADMIN_USERS


# ---------------------------------------------------------------------------
# API helpers
# ---------------------------------------------------------------------------


def _headers() -> dict[str, str]:
    return {"x-user-id": user_entra_id, "Content-Type": "application/json"}


def _get_tools() -> list[dict[str, Any]]:
    try:
        resp = requests.get(f"{AGENT_URL}/api/forged-tools", headers=_headers(), timeout=10)
        resp.raise_for_status()
        return resp.json().get("tools", [])
    except Exception as exc:
        st.error(f"Failed to load forged tools: {exc}")
        return []


def _get_code(tool_id: str) -> str | None:
    try:
        resp = requests.get(
            f"{AGENT_URL}/api/forged-tools/{tool_id}/code", headers=_headers(), timeout=10
        )
        if resp.status_code == 404:
            return None
        resp.raise_for_status()
        return resp.json().get("code", "")
    except Exception as exc:
        _log.warning("Failed to fetch code for %s: %s", tool_id, exc)
        return None


def _get_tests(tool_id: str) -> list[dict[str, Any]]:
    try:
        resp = requests.get(
            f"{AGENT_URL}/api/forged-tools/{tool_id}/tests", headers=_headers(), timeout=10
        )
        resp.raise_for_status()
        return resp.json().get("tests", [])
    except Exception as exc:
        _log.warning("Failed to fetch tests for %s: %s", tool_id, exc)
        return []


def _promote_scope(tool_id: str, scope: str) -> bool:
    try:
        resp = requests.post(
            f"{AGENT_URL}/api/forged-tools/{tool_id}/scope",
            headers=_headers(),
            json={"scope": scope},
            timeout=10,
        )
        resp.raise_for_status()
        return True
    except Exception as exc:
        st.error(f"Promotion failed: {exc}")
        return False


def _disable_tool(tool_id: str, reason: str) -> bool:
    try:
        resp = requests.post(
            f"{AGENT_URL}/api/forged-tools/{tool_id}/disable",
            headers=_headers(),
            json={"reason": reason},
            timeout=10,
        )
        resp.raise_for_status()
        return True
    except Exception as exc:
        st.error(f"Disable failed: {exc}")
        return False


# ---------------------------------------------------------------------------
# Sparkline helper (simple pass-rate bar)
# ---------------------------------------------------------------------------


def _pass_rate_bar(pass_rate: float | None) -> str:
    if pass_rate is None:
        return "—"
    pct = int(pass_rate * 100)
    filled = int(pct / 10)
    bar = "█" * filled + "░" * (10 - filled)
    return f"{bar} {pct}%"


# ---------------------------------------------------------------------------
# Scope badge
# ---------------------------------------------------------------------------


def _scope_badge(scope: str, active: bool) -> str:
    color = {"private": "gray", "project": "blue", "org": "green"}.get(scope, "gray")
    status = "" if active else " (disabled)"
    return f":{color}[{scope}{status}]"


# ---------------------------------------------------------------------------
# Main page
# ---------------------------------------------------------------------------


def main() -> None:
    st.title("Forged Tools")
    st.caption("Phase D.5 — cross-project tool sharing, nightly validation, weak-from-strong.")

    if st.button("Refresh"):
        st.rerun()

    tools = _get_tools()

    if not tools:
        st.info("No forged tools found. Use `/forge <description>` in the chat to create one.")
        return

    # ---- Tool list table -------------------------------------------------------

    st.subheader(f"{len(tools)} tool(s) visible to you")

    for tool in tools:
        tool_id = tool.get("id", "")
        name = tool.get("name", "—")
        version = tool.get("version", 1)
        scope = tool.get("scope", "private")
        active = tool.get("active", False)
        by_model = tool.get("forged_by_model") or "—"
        by_role = tool.get("forged_by_role") or "—"
        last_status = tool.get("last_status") or "never run"
        pass_rate = tool.get("pass_rate")

        with st.expander(
            f"**{name}** v{version}  {_scope_badge(scope, active)}  "
            f"| {last_status}  {_pass_rate_bar(pass_rate)}"
        ):
            col1, col2 = st.columns([2, 1])

            with col1:
                st.markdown(f"**Forged by model:** `{by_model}`  |  **Role:** `{by_role}`")
                st.markdown(f"**Tool ID:** `{tool_id}`")

            with col2:
                if _is_admin or tool.get("proposed_by_user_entra_id") == user_entra_id:
                    if scope == "private" and st.button("Promote to project", key=f"proj_{tool_id}"):
                        if _promote_scope(tool_id, "project"):
                            st.success("Promoted to project scope.")
                            st.rerun()

                    if scope in ("private", "project") and _is_admin and st.button(
                        "Promote to org", key=f"org_{tool_id}"
                    ):
                        if _promote_scope(tool_id, "org"):
                            st.success("Promoted to org scope.")
                            st.rerun()

                    disable_reason = st.text_input("Disable reason", key=f"dis_r_{tool_id}")
                    if st.button("Disable", key=f"dis_{tool_id}") and disable_reason:
                        if _disable_tool(tool_id, disable_reason):
                            st.success("Tool disabled.")
                            st.rerun()

            # ---- Code tab -------------------------------------------------------

            tab_code, tab_tests, tab_runs = st.tabs(["Code", "Test Cases", "Validation Runs"])

            with tab_code:
                code = _get_code(tool_id)
                if code is None:
                    st.info("Code not available.")
                else:
                    st.code(code, language="python")

            with tab_tests:
                tests = _get_tests(tool_id)
                if not tests:
                    st.info("No test cases found.")
                else:
                    for i, tc in enumerate(tests):
                        st.markdown(f"**Test {i+1}** — kind: `{tc.get('kind', 'functional')}`")
                        col_in, col_out = st.columns(2)
                        with col_in:
                            st.json(tc.get("input_json", {}))
                        with col_out:
                            st.json(tc.get("expected_output_json", {}))

            with tab_runs:
                # Validation run history is surfaced in the tool list (last_status).
                st.caption("Validation runs are recorded nightly by forged-tool-validator.")
                st.markdown(
                    f"**Last run status:** `{last_status}`  \n"
                    f"**Pass rate:** {_pass_rate_bar(pass_rate)}"
                )


main()
