"""Streamlit chat page.

Streams tokens from the agent service as they arrive, renders tool calls
inline as expandable panels, and keeps the conversation in session_state.
"""

from __future__ import annotations

import json
from typing import Any

import streamlit as st

from services.frontend.chat_client import ChatClientError, stream_chat
from services.frontend.settings import get_settings

st.set_page_config(page_title="ChemClaw — Chat", page_icon="💬", layout="wide")

settings = get_settings()


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
        st.markdown(msg["content"])
        tool_calls: list[dict[str, Any]] = msg.get("tool_calls") or []
        for tc in tool_calls:
            with st.expander(f"🔧 {tc['toolId']}", expanded=False):
                st.json({"input": tc.get("input"), "output": tc.get("output")})

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
        text_holder.markdown(accumulated_text or "_(no response text)_")
        for tc in tool_entries:
            with st.expander(f"🔧 {tc['toolId']}", expanded=False):
                st.json({"input": tc.get("input"), "output": tc.get("output")})

    st.session_state.chat_messages.append(
        {
            "role": "assistant",
            "content": accumulated_text,
            "tool_calls": tool_entries,
        }
    )
    _trim_history()
