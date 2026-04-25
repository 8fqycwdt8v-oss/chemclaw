"""Skill-pack API helpers for the Streamlit frontend.

Talks to the agent-claw /api/skills/* endpoints.
All functions are synchronous (Streamlit runs in a single-threaded event loop).
"""
from __future__ import annotations

import requests

from services.frontend.settings import get_settings


def _base() -> str:
    return get_settings().agent_base_url.rstrip("/")


def list_skills() -> list[dict]:
    """Return all skill packs with active flag.

    Returns an empty list on network / parse errors — the UI degrades gracefully.
    """
    try:
        resp = requests.get(f"{_base()}/api/skills/list", timeout=5)
        resp.raise_for_status()
        data = resp.json()
        return data.get("skills", [])
    except Exception:  # noqa: BLE001
        return []


def enable_skill(skill_id: str) -> bool:
    """Enable a skill. Returns True on success."""
    try:
        resp = requests.post(
            f"{_base()}/api/skills/enable",
            json={"id": skill_id},
            timeout=5,
        )
        return resp.ok
    except Exception:  # noqa: BLE001
        return False


def disable_skill(skill_id: str) -> bool:
    """Disable a skill. Returns True on success."""
    try:
        resp = requests.post(
            f"{_base()}/api/skills/disable",
            json={"id": skill_id},
            timeout=5,
        )
        return resp.ok
    except Exception:  # noqa: BLE001
        return False


def approve_plan(plan_id: str) -> bool:
    """Approve a saved plan. Returns True if the approve endpoint accepted it."""
    try:
        resp = requests.post(
            f"{_base()}/api/chat/plan/approve",
            json={"plan_id": plan_id},
            timeout=5,
        )
        return resp.ok
    except Exception:  # noqa: BLE001
        return False


def reject_plan(plan_id: str) -> bool:
    """Reject / drop a saved plan. Returns True on success."""
    try:
        resp = requests.post(
            f"{_base()}/api/chat/plan/reject",
            json={"plan_id": plan_id},
            timeout=5,
        )
        return resp.ok
    except Exception:  # noqa: BLE001
        return False


def fetch_original_document_url(document_id: str) -> str:
    """Return a URL to GET the original document bytes.

    This is a simple proxy URL on the agent service — the browser can navigate
    directly to it (used for the "Open original" download button).
    """
    return f"{_base()}/api/documents/{document_id}/original"
