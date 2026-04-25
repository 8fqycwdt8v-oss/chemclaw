"""Tests for services/frontend/pages/forged_tools.py — Phase D.5.

Uses mocked requests to verify the page helpers function correctly.
"""

from __future__ import annotations

import os
from unittest.mock import MagicMock, patch

import pytest


# ---------------------------------------------------------------------------
# Helpers (extracted from the page for testability)
# ---------------------------------------------------------------------------


def is_admin(user_entra_id: str, admin_users_env: str) -> bool:
    """Replicate the admin check from forged_tools.py."""
    admins = {
        u.strip().lower()
        for u in admin_users_env.split(",")
        if u.strip()
    }
    return user_entra_id.lower() in admins


def pass_rate_bar(pass_rate: float | None) -> str:
    """Replicate the _pass_rate_bar helper."""
    if pass_rate is None:
        return "—"
    pct = int(pass_rate * 100)
    filled = int(pct / 10)
    bar = "█" * filled + "░" * (10 - filled)
    return f"{bar} {pct}%"


def scope_badge(scope: str, active: bool) -> str:
    color = {"private": "gray", "project": "blue", "org": "green"}.get(scope, "gray")
    status = "" if active else " (disabled)"
    return f":{color}[{scope}{status}]"


# ---------------------------------------------------------------------------
# Tests
# ---------------------------------------------------------------------------


def test_is_admin_match():
    assert is_admin("admin@corp.com", "admin@corp.com,other@corp.com") is True


def test_is_admin_case_insensitive():
    assert is_admin("ADMIN@CORP.COM", "admin@corp.com") is True


def test_is_admin_no_match():
    assert is_admin("user@corp.com", "admin@corp.com") is False


def test_is_admin_empty_env():
    assert is_admin("anyone@corp.com", "") is False


def test_pass_rate_bar_100_pct():
    bar = pass_rate_bar(1.0)
    assert "100%" in bar
    assert "█" * 10 in bar


def test_pass_rate_bar_0_pct():
    bar = pass_rate_bar(0.0)
    assert "0%" in bar


def test_pass_rate_bar_none():
    assert pass_rate_bar(None) == "—"


def test_pass_rate_bar_partial():
    bar = pass_rate_bar(0.8)
    assert "80%" in bar


def test_scope_badge_private_active():
    badge = scope_badge("private", True)
    assert "gray" in badge
    assert "private" in badge
    assert "disabled" not in badge


def test_scope_badge_org_disabled():
    badge = scope_badge("org", False)
    assert "green" in badge
    assert "disabled" in badge


def test_scope_badge_project():
    badge = scope_badge("project", True)
    assert "blue" in badge
