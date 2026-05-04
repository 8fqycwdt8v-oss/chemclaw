"""Tranche 4 / H2 (M2 from PR #85 review): pin the v3 prompt seed contract.

This test is intentionally text-level — we don't spin up Postgres. The
failure mode we're guarding against is "a future migration accidentally
deactivates v3 / reactivates v2 / drops the routing rules that make
this whole tranche worthwhile". Reading the seed SQL and asserting on
its content catches the regression cheaply.
"""

from __future__ import annotations

from pathlib import Path

import pytest


SEED_FILE = (
    Path(__file__).resolve().parents[2]
    / "db"
    / "seed"
    / "06_kg_first_system_prompt.sql"
)


@pytest.fixture(scope="module")
def seed_sql() -> str:
    assert SEED_FILE.exists(), f"missing seed file: {SEED_FILE}"
    return SEED_FILE.read_text(encoding="utf-8")


def test_seed_deactivates_v2_and_activates_v3(seed_sql: str) -> None:
    # The deactivation step must explicitly target version=2 so it doesn't
    # collateral-damage future versions.
    assert "active = false" in seed_sql.lower() or "active=false" in seed_sql.lower()
    assert "version = 2" in seed_sql or "version=2" in seed_sql
    # The INSERT for v3 must be the one that ends up active=true.
    assert "'agent.system'," in seed_sql
    assert "  3," in seed_sql, "expected v3 insertion"


def test_seed_carries_kg_first_routing_keywords(seed_sql: str) -> None:
    """The whole point of v3 is the explicit branching rule. If any of these
    keywords disappear from the prompt, the agent's routing semantics
    silently regress to the v2 permissive shape."""
    must_contain = [
        # Tool surfaces the agent must know about.
        "query_kg",
        "query_kg_at_time",
        "query_provenance",
        "retrieve_related",
        "search_knowledge",
        "update_hypothesis_status",
        # Routing rules that distinguish v3 from v2.
        "query_kg first",  # the directive
        "as of",  # time-travel trigger phrase
        "why is this fact here",  # provenance trigger phrase
        # Bi-temporal contract referenced explicitly.
        "bi-temporal",
        "tenant",
        "confidence_label",
        "foundational",
    ]
    missing = [kw for kw in must_contain if kw not in seed_sql]
    assert not missing, f"v3 prompt missing required keywords: {missing}"


def test_seed_uses_idempotent_on_conflict(seed_sql: str) -> None:
    """Re-applying the seed must be a no-op (per project convention for
    every seed file)."""
    assert "ON CONFLICT" in seed_sql.upper()
