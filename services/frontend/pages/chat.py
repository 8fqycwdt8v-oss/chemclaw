"""Streamlit chat page.

Streams tokens from the agent service as they arrive, renders tool calls
inline as expandable panels, and keeps the conversation in session_state.

Phase B.3 additions:
- Skill chips — toggleable row of skill-pack buttons above the input.
- Plan-mode preview panel — shows plan_step events + Approve / Reject buttons.
- "Open original" button on citations that have source_kind in
  {'document_chunk', 'original_doc'} with a document_id.
- Slash autocomplete hint below the input (static list; Streamlit limitation).

Phase D.2 additions:
- "View trace" link under each assistant turn → Langfuse UI at LANGFUSE_HOST/trace/<id>.
- Thumbs-up / thumbs-down feedback buttons under each assistant turn.
- "Promote to WORKING" button also fires a Langfuse score (best-effort).
"""

from __future__ import annotations

import json
import logging
import re
from typing import Any

import pandas as pd
import requests
import streamlit as st

from services.frontend.chat_client import ChatClientError, stream_chat
from services.frontend.chart_spec import ChartSpec, parse_chart_spec
from services.frontend.settings import get_settings
from services.frontend.skill_client import (
    disable_skill,
    enable_skill,
    fetch_original_document_url,
    list_skills,
    reject_plan,
)

_log = logging.getLogger(__name__)

st.set_page_config(page_title="ChemClaw — Chat", page_icon="💬", layout="wide")

settings = get_settings()

# ---------------------------------------------------------------------------
# Slash-verb autocomplete list (static — matches core/slash.ts verbs).
# ---------------------------------------------------------------------------
_SLASH_VERBS = [
    "/help",
    "/skills list",
    "/skills enable <id>",
    "/skills disable <id>",
    "/feedback up|down <reason>",
    "/check",
    "/learn",
    "/plan <question>",
    "/dr <question>",
    "/retro <smiles>",
    "/qc <question>",
]

# ---------------------------------------------------------------------------
# Chart rendering helpers
# ---------------------------------------------------------------------------

_CHART_BLOCK_RE = re.compile(
    r"```chart\s*\n(.*?)\n```",
    re.DOTALL,
)


def _render_chart(spec: ChartSpec) -> None:
    """Render a validated ``ChartSpec`` using the appropriate Streamlit chart widget."""
    if spec.title:
        st.caption(spec.title)

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
    """Render assistant text, replacing fenced ``chart`` blocks with live charts."""
    cursor = 0
    for m in _CHART_BLOCK_RE.finditer(text):
        before = text[cursor : m.start()]
        if before.strip():
            st.markdown(before)

        raw_json = m.group(1).strip()
        spec = parse_chart_spec(raw_json)
        if spec is not None:
            _render_chart(spec)
        else:
            st.code(raw_json, language="json")

        cursor = m.end()

    remainder = text[cursor:]
    if remainder.strip():
        st.markdown(remainder)
    elif cursor == 0:
        st.markdown(text)


def current_user_email() -> str:
    if settings.chemclaw_dev_mode:
        return settings.chemclaw_dev_user_email
    return st.session_state.get("user_email", "unknown@local.test")


# ---------------------------------------------------------------------------
# Langfuse trace link helper (Phase D.2)
# ---------------------------------------------------------------------------

def _langfuse_trace_url(trace_id: str) -> str | None:
    """Return a Langfuse UI URL for a trace, or None if LANGFUSE_HOST is unset."""
    host = settings.langfuse_host
    if not host:
        return None
    return f"{host.rstrip('/')}/trace/{trace_id}"


# ---------------------------------------------------------------------------
# Feedback helper (Phase D.2)
# ---------------------------------------------------------------------------

def _post_feedback(
    trace_id: str | None,
    signal: str,
    reason: str | None = None,
) -> bool:
    """POST /api/feedback to the agent service. Returns True on success."""
    agent_url = settings.resolved_agent_base_url
    try:
        payload: dict[str, Any] = {"signal": signal}
        if trace_id:
            payload["trace_id"] = trace_id
        if reason:
            payload["reason"] = reason
        resp = requests.post(
            f"{agent_url}/api/feedback",
            json=payload,
            timeout=5,
        )
        return resp.ok
    except Exception as exc:  # noqa: BLE001
        _log.warning("feedback post failed: %s", exc)
        return False


# ---------------------------------------------------------------------------
# Session state
# ---------------------------------------------------------------------------
if "chat_messages" not in st.session_state:
    st.session_state.chat_messages = []

if "active_plan" not in st.session_state:
    # Holds the most recent plan_ready payload, cleared after approve/reject.
    st.session_state.active_plan = None  # dict | None

_MAX_UI_HISTORY = 30


def _trim_history() -> None:
    if len(st.session_state.chat_messages) > _MAX_UI_HISTORY:
        st.session_state.chat_messages = st.session_state.chat_messages[
            -_MAX_UI_HISTORY:
        ]


# ---------------------------------------------------------------------------
# Citation rendering helpers
# ---------------------------------------------------------------------------

def _render_citation_download(doc_id: str, label: str = "Open original") -> None:
    """Render a download link for the original document bytes."""
    url = fetch_original_document_url(doc_id)
    st.markdown(f"[{label}]({url})", unsafe_allow_html=False)


def _render_tool_panel(tc: dict[str, Any]) -> None:
    """Render a single tool-call panel.

    Additions in B.3:
    - Hypothesis badge (existing).
    - "Open original" button on citations with a document_id.
    """
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

        # ── "Open original" button ──────────────────────────────────────────
        # Surface when the output contains a citation with source_kind in
        # {'document_chunk', 'original_doc'} and a resolvable document_id.
        citations_to_show: list[dict[str, Any]] = []
        # Direct citation on the output object.
        if isinstance(out.get("citation"), dict):
            citations_to_show.append(out["citation"])
        # Array of citations.
        if isinstance(out.get("citations"), list):
            citations_to_show.extend(
                c for c in out["citations"] if isinstance(c, dict)
            )
        # fetch_original_document returns document_id at root.
        if tool_id == "fetch_original_document" and inp.get("document_id"):
            citations_to_show.append(
                {
                    "source_kind": "original_doc",
                    "source_id": inp["document_id"],
                }
            )

        for cit in citations_to_show:
            kind = cit.get("source_kind", "")
            if kind in ("document_chunk", "original_doc"):
                doc_id = cit.get("source_id") or inp.get("document_id")
                if doc_id:
                    _render_citation_download(str(doc_id))


# ---------------------------------------------------------------------------
# Trace + feedback footer (Phase D.2)
# ---------------------------------------------------------------------------

def _render_turn_footer(
    turn_idx: int,
    trace_id: str | None,
) -> None:
    """Render 'View trace' link and thumbs feedback buttons under an assistant turn."""
    cols = st.columns([3, 1, 1])

    with cols[0]:
        if trace_id:
            trace_url = _langfuse_trace_url(trace_id)
            if trace_url:
                st.markdown(
                    f"[View trace ↗]({trace_url})",
                    unsafe_allow_html=False,
                )

    with cols[1]:
        if st.button(
            "👍",
            key=f"fb_up_{turn_idx}",
            help="This response was helpful",
            use_container_width=True,
        ):
            ok = _post_feedback(trace_id, "up", "user thumbs-up")
            if ok:
                st.toast("Feedback recorded (👍)")
            else:
                st.toast("Could not reach agent service", icon="⚠️")

    with cols[2]:
        if st.button(
            "👎",
            key=f"fb_down_{turn_idx}",
            help="This response was not helpful",
            use_container_width=True,
        ):
            ok = _post_feedback(trace_id, "down", "user thumbs-down")
            if ok:
                st.toast("Feedback recorded (👎)")
            else:
                st.toast("Could not reach agent service", icon="⚠️")


# ---------------------------------------------------------------------------
# Plan-mode preview panel
# ---------------------------------------------------------------------------

def _render_plan_panel(plan: dict[str, Any]) -> None:
    """Render the plan_ready payload as a numbered list with Approve / Reject."""
    plan_id: str = plan.get("plan_id", "")
    steps: list[dict[str, Any]] = plan.get("steps", [])

    st.markdown("### Plan preview")
    for step in steps:
        step_num = step.get("step_number", "?")
        tool = step.get("tool", "?")
        rationale = step.get("rationale", "")
        args_str = json.dumps(step.get("args", {}), indent=2)
        st.markdown(
            f"**Step {step_num}** — `{tool}`  \n"
            f"_{rationale}_  \n"
            f"```json\n{args_str}\n```"
        )

    col_approve, col_reject = st.columns(2)
    with col_approve:
        if st.button("✅ Approve", key=f"approve_{plan_id}", use_container_width=True):
            # POST to approve; the response SSE stream is not re-rendered here
            # because Streamlit can't handle nested SSE in a button callback.
            # Instead we send a synthetic user message "/plan approve <plan_id>"
            # that the chat route will pick up on the next submission.
            st.session_state.chat_messages.append(
                {
                    "role": "user",
                    "content": f"/plan approve {plan_id}",
                }
            )
            st.session_state.active_plan = None
            st.rerun()
    with col_reject:
        if st.button("❌ Reject", key=f"reject_{plan_id}", use_container_width=True):
            reject_plan(plan_id)
            st.session_state.active_plan = None
            st.rerun()


# ---------------------------------------------------------------------------
# Skill chips
# ---------------------------------------------------------------------------

def _render_skill_chips() -> None:
    """Render a row of toggleable skill chips above the input."""
    skills = list_skills()
    if not skills:
        return

    st.caption("Active skills:")
    cols = st.columns(min(len(skills), 6))
    for i, skill in enumerate(skills):
        skill_id: str = skill.get("id", "?")
        is_active: bool = skill.get("active", False)
        label = f"{'✓ ' if is_active else ''}{skill_id}"
        with cols[i % len(cols)]:
            if st.button(
                label,
                key=f"skill_chip_{skill_id}",
                use_container_width=True,
                type="primary" if is_active else "secondary",
            ):
                if is_active:
                    disable_skill(skill_id)
                else:
                    enable_skill(skill_id)
                st.rerun()


# ---------------------------------------------------------------------------
# Page layout
# ---------------------------------------------------------------------------

st.title("💬 ChemClaw Chat")
st.caption(f"You are signed in as `{current_user_email()}`.")

with st.sidebar:
    st.header("Session")
    if st.button("🧹 Clear conversation", use_container_width=True):
        st.session_state.chat_messages = []
        st.session_state.active_plan = None
        st.rerun()

    st.caption(f"Model: `{st.secrets.get('AGENT_MODEL', 'configured-in-agent')}`")
    st.caption(f"{len(st.session_state.chat_messages)} messages in history.")

    st.divider()
    st.subheader("Slash commands")
    for verb in _SLASH_VERBS:
        st.caption(f"`{verb}`")

# Skill chips row.
_render_skill_chips()

# Active plan preview (if a /plan turn returned plan_ready).
if st.session_state.active_plan:
    _render_plan_panel(st.session_state.active_plan)
    st.divider()

# Render prior conversation.
for _turn_idx, msg in enumerate(st.session_state.chat_messages):
    with st.chat_message(msg["role"]):
        if msg["role"] == "assistant":
            render_assistant_markdown(msg["content"])
        else:
            st.markdown(msg["content"])
        tool_calls: list[dict[str, Any]] = msg.get("tool_calls") or []
        for tc in tool_calls:
            _render_tool_panel(tc)
        if msg["role"] == "assistant":
            _render_turn_footer(
                turn_idx=_turn_idx,
                trace_id=msg.get("trace_id"),
            )

prompt = st.chat_input("Ask about your projects, reactions, or experiments…")

if prompt:
    # Append user turn + render.
    st.session_state.chat_messages.append({"role": "user", "content": prompt})
    _trim_history()
    with st.chat_message("user"):
        st.markdown(prompt)

    # Prepare the assistant reply placeholder.
    current_agent_trace_id: str | None = None
    with st.chat_message("assistant"):
        text_holder = st.empty()
        status_holder = st.status("Thinking…", expanded=False)
        tool_entries: list[dict[str, Any]] = []
        plan_steps: list[dict[str, Any]] = []
        plan_ready_payload: dict[str, Any] | None = None
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
                    for entry in reversed(tool_entries):
                        if entry["toolId"] == evt.get("toolId") and entry["output"] is None:
                            entry["output"] = evt.get("output")
                            break
                    with status_holder:
                        st.write(f"Got result for `{evt.get('toolId')}`.")
                elif etype == "plan_step":
                    plan_steps.append(evt)
                    with status_holder:
                        st.write(f"Planning step {evt.get('step_number')}: `{evt.get('tool')}`…")
                elif etype == "plan_ready":
                    plan_ready_payload = {
                        "plan_id": evt.get("plan_id"),
                        "steps": evt.get("steps", []),
                        "created_at": evt.get("created_at"),
                    }
                    st.session_state.active_plan = plan_ready_payload
                    with status_holder:
                        st.write(f"Plan ready ({len(evt.get('steps', []))} steps).")
                elif etype == "finish":
                    finish_reason = evt.get("finishReason", "stop")
                    # Capture trace_id if included in finish event.
                    if evt.get("trace_id"):
                        current_agent_trace_id = str(evt["trace_id"])
                    status_holder.update(label=f"Done ({finish_reason}).", state="complete")
                elif etype == "error":
                    status_holder.update(
                        label=f"Error: {evt.get('error', 'unknown')}", state="error"
                    )
        except ChatClientError as exc:
            status_holder.update(label=f"Agent unreachable: {exc}", state="error")
        except Exception as exc:  # noqa: BLE001
            status_holder.update(label=f"Client error: {exc}", state="error")

        # Finalise.
        text_holder.empty()
        render_assistant_markdown(accumulated_text or "_(no response text)_")
        for tc in tool_entries:
            _render_tool_panel(tc)

        # Show plan preview inline if plan_ready arrived.
        if plan_ready_payload:
            _render_plan_panel(plan_ready_payload)

        # Phase D.2: trace link + feedback buttons under the current turn.
        current_turn_idx = len(st.session_state.chat_messages)  # before append
        _render_turn_footer(
            turn_idx=current_turn_idx,
            trace_id=current_agent_trace_id,
        )

    st.session_state.chat_messages.append(
        {
            "role": "assistant",
            "content": accumulated_text,
            "tool_calls": tool_entries,
            "trace_id": current_agent_trace_id,
        }
    )
    _trim_history()
