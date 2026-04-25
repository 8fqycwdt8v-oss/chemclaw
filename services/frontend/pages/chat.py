"""Streamlit chat page.

Streams tokens from the agent service as they arrive, renders tool calls
inline as expandable panels, and keeps the conversation in session_state.
"""

from __future__ import annotations

import json
import re
from typing import Any

import pandas as pd
import streamlit as st

from services.frontend.chat_client import ChatClientError, stream_chat
from services.frontend.chart_spec import ChartSpec, parse_chart_spec
from services.frontend.settings import get_settings

st.set_page_config(page_title="ChemClaw — Chat", page_icon="💬", layout="wide")

settings = get_settings()

# ---------------------------------------------------------------------------
# Chart rendering helpers
# ---------------------------------------------------------------------------

# Matches triple-backtick fenced blocks with the "chart" info string, e.g.:
#   ```chart
#   {"type": "bar", "x": [...], "y": [...]}
#   ```
_CHART_BLOCK_RE = re.compile(
    r"```chart\s*\n(.*?)\n```",
    re.DOTALL,
)


def _render_chart(spec: ChartSpec) -> None:
    """Render a validated ``ChartSpec`` using the appropriate Streamlit chart widget."""
    if spec.title:
        st.caption(spec.title)

    # Build a DataFrame: primary y column + any extra series.
    data: dict[str, list[float]] = {spec.y_label or "y": spec.y}
    for s in spec.series:
        data[s.name] = s.values
    df = pd.DataFrame(data, index=spec.x)

    if spec.type == "bar":
        st.bar_chart(df)
    elif spec.type == "line":
        st.line_chart(df)
    elif spec.type == "scatter":
        st.scatter_chart(df)


def render_assistant_markdown(text: str) -> None:
    """Render assistant text, replacing fenced ``chart`` blocks with live charts.

    Any block whose JSON is invalid or whose type is unsupported is rendered as
    a plain ``code`` block (safe fallback) so no information is lost.
    """
    cursor = 0
    for m in _CHART_BLOCK_RE.finditer(text):
        # Render any text before this block as normal markdown.
        before = text[cursor : m.start()]
        if before.strip():
            st.markdown(before)

        raw_json = m.group(1).strip()
        spec = parse_chart_spec(raw_json)
        if spec is not None:
            _render_chart(spec)
        else:
            # Fallback: render as a plain code block.
            st.code(raw_json, language="json")

        cursor = m.end()

    # Render any trailing text after the last chart block.
    remainder = text[cursor:]
    if remainder.strip():
        st.markdown(remainder)
    elif cursor == 0:
        # No chart blocks were found — render the whole text as markdown.
        st.markdown(text)


def current_user_email() -> str:
    if settings.chemclaw_dev_mode:
        return settings.chemclaw_dev_user_email
    return st.session_state.get("user_email", "unknown@local.test")


# --- Session state ---------------------------------------------------------
if "chat_messages" not in st.session_state:
    st.session_state.chat_messages = []  # list[{"role", "content"}]

# Defence against unbounded session growth. The agent also caps history
# server-side; this is a belt-and-braces measure so the UI never sends
# oversize payloads.
_MAX_UI_HISTORY = 30


def _trim_history() -> None:
    if len(st.session_state.chat_messages) > _MAX_UI_HISTORY:
        st.session_state.chat_messages = st.session_state.chat_messages[
            -_MAX_UI_HISTORY:
        ]


def _render_tool_panel(tc: dict[str, Any]) -> None:
    """Render a single tool-call panel, with a Hypothesis badge when applicable."""
    tool_id: str = tc.get("toolId", "?")
    inp: dict[str, Any] = tc.get("input") or {}
    raw_out = tc.get("output")
    out: dict[str, Any] = raw_out if isinstance(raw_out, dict) else {}

    if tool_id == "propose_hypothesis":
        hypothesis_id: str = str(out.get("hypothesis_id", ""))
        short_id = hypothesis_id[:8] if hypothesis_id else "????????"
        try:
            confidence = float(inp.get("confidence", 0.0))
        except (TypeError, ValueError):
            confidence = 0.0
        tier: str = str(out.get("confidence_tier", "unknown"))
        st.markdown(
            f"**Hypothesis `{short_id}` · conf={confidence:.2f} · tier={tier}**"
        )

    with st.expander(f"🔧 {tool_id}", expanded=False):
        st.json({"input": inp, "output": raw_out})


# ---------------------------------------------------------------------------

st.title("💬 ChemClaw Chat")
st.caption(f"You are signed in as `{current_user_email()}`.")

with st.sidebar:
    st.header("Session")
    if st.button("🧹 Clear conversation", use_container_width=True):
        st.session_state.chat_messages = []
        st.rerun()

    st.caption(f"Model: `{st.secrets.get('AGENT_MODEL', 'configured-in-agent')}`")
    st.caption(f"{len(st.session_state.chat_messages)} messages in history.")

# Render prior conversation.
for msg in st.session_state.chat_messages:
    with st.chat_message(msg["role"]):
        if msg["role"] == "assistant":
            render_assistant_markdown(msg["content"])
        else:
            st.markdown(msg["content"])
        tool_calls: list[dict[str, Any]] = msg.get("tool_calls") or []
        for tc in tool_calls:
            _render_tool_panel(tc)

prompt = st.chat_input("Ask about your projects, reactions, or experiments…")

if prompt:
    # Append user turn + render.
    st.session_state.chat_messages.append({"role": "user", "content": prompt})
    _trim_history()
    with st.chat_message("user"):
        st.markdown(prompt)

    # Prepare the assistant reply placeholder.
    with st.chat_message("assistant"):
        text_holder = st.empty()
        status_holder = st.status("Thinking…", expanded=False)
        tool_entries: list[dict[str, Any]] = []
        accumulated_text = ""
        finish_reason = "incomplete"

        try:
            history = [
                {"role": m["role"], "content": m["content"]}
                for m in st.session_state.chat_messages
            ]
            for evt in stream_chat(current_user_email(), history):
                etype = evt.get("type")
                if etype == "text_delta":
                    accumulated_text += evt.get("delta", "")
                    text_holder.markdown(accumulated_text + "▌")
                elif etype == "tool_call":
                    tool_entries.append(
                        {
                            "toolId": evt.get("toolId", "?"),
                            "input": evt.get("input"),
                            "output": None,
                        }
                    )
                    with status_holder:
                        st.write(f"Calling tool `{evt.get('toolId')}`…")
                elif etype == "tool_result":
                    # Attach the result to the most recent matching call.
                    for entry in reversed(tool_entries):
                        if entry["toolId"] == evt.get("toolId") and entry["output"] is None:
                            entry["output"] = evt.get("output")
                            break
                    with status_holder:
                        st.write(f"Got result for `{evt.get('toolId')}`.")
                elif etype == "finish":
                    finish_reason = evt.get("finishReason", "stop")
                    status_holder.update(label=f"Done ({finish_reason}).", state="complete")
                elif etype == "error":
                    status_holder.update(
                        label=f"Error: {evt.get('error', 'unknown')}", state="error"
                    )
        except ChatClientError as exc:
            status_holder.update(label=f"Agent unreachable: {exc}", state="error")
        except Exception as exc:  # noqa: BLE001 — surface any client error to the user
            status_holder.update(label=f"Client error: {exc}", state="error")

        # Finalise: strip the cursor, render tool-call panels.
        # Clear the streaming placeholder, then render the full text (which
        # may contain fenced chart blocks) via render_assistant_markdown.
        text_holder.empty()
        render_assistant_markdown(accumulated_text or "_(no response text)_")
        for tc in tool_entries:
            _render_tool_panel(tc)

    st.session_state.chat_messages.append(
        {
            "role": "assistant",
            "content": accumulated_text,
            "tool_calls": tool_entries,
        }
    )
    _trim_history()
