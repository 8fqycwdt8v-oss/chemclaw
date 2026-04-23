"""ChemClaw — Streamlit frontend entrypoint.

This is the Phase-0 skeleton: a home page that confirms the stack is wired up
end-to-end (frontend → app DB with RLS → schema applied → sample data visible).
"""

from __future__ import annotations

import httpx
import streamlit as st

from services.frontend.db import fetch_notifications, list_experiments, list_projects
from services.frontend.settings import get_settings

st.set_page_config(page_title="ChemClaw", page_icon="🧪", layout="wide")

settings = get_settings()


def current_user_email() -> str:
    """In dev mode, use the configured dev email. In prod (Phase 8), read
    the OIDC-populated header from oauth2-proxy."""
    if settings.chemclaw_dev_mode:
        return settings.chemclaw_dev_user_email
    # Placeholder: real impl will read X-Forwarded-User from oauth2-proxy.
    return st.session_state.get("user_email", "unknown@local.test")


# --- Sidebar ---------------------------------------------------------------
with st.sidebar:
    st.markdown("### ChemClaw")
    st.caption("Knowledge Intelligence Agent — Phase 0 skeleton")
    user = current_user_email()
    st.write(f"**User:** `{user}`")

    # Liveness/readiness indicator for the agent service.
    try:
        r = httpx.get(f"{settings.agent_base_url}/readyz", timeout=2.0)
        if r.status_code == 200:
            st.success("Agent service: ready")
        else:
            st.warning(f"Agent service: {r.status_code}")
    except httpx.HTTPError:
        st.error("Agent service: unreachable")


# --- Main body -------------------------------------------------------------
st.title("🧪 ChemClaw")
st.write(
    "The autonomous knowledge intelligence agent for chemical & analytical "
    "development. This page is the Phase-0 smoke test — it confirms the data "
    "layer, schema, RLS, and sample data are all wired up correctly."
)

col_proj, col_notif = st.columns([2, 1])

with col_proj:
    st.subheader("Projects you can access")
    projects = list_projects(user)
    if not projects:
        st.info(
            "No projects visible. If this is a fresh install, run:\n\n"
            "```\nmake db.seed\n```\n\n"
            "or check that your user email has entries in `user_project_access`."
        )
    else:
        for p in projects:
            with st.container(border=True):
                st.markdown(f"**{p['internal_id']} — {p['name']}**")
                st.caption(
                    f"Area: {p['therapeutic_area'] or '—'} · "
                    f"Phase: {p['phase'] or '—'} · "
                    f"Status: {p['status']}"
                )
                experiments = list_experiments(user, p["internal_id"])
                if experiments:
                    st.write(f"{len(experiments)} experiments")
                    st.dataframe(experiments, use_container_width=True, hide_index=True)
                else:
                    st.caption("No experiments ingested for this project yet.")

with col_notif:
    st.subheader("Proactive notifications")
    notifs = fetch_notifications(user)
    if not notifs:
        st.caption("No notifications yet. Proactive agent runs will push messages here.")
    else:
        for n in notifs:
            with st.container(border=True):
                st.markdown(f"**{n['kind']}**")
                st.caption(n["created_at"].isoformat() if n["created_at"] else "")
                st.json(n["payload"], expanded=False)


st.markdown("---")
st.caption(
    "This is a skeleton. Chat, Deep Research, KG explorer, and the admin page "
    "land in Phase 3+. See `/docs/runbooks/local-dev.md` for next steps."
)
