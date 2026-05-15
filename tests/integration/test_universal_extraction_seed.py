"""Verify Phase 0 seed rows landed in feature_flags + config_settings + prompt_registry.

The seed file is db/seed/09_universal_extraction_config.sql.

Column names in this repo deviate from the plan's pseudo-SQL — see CLAUDE.md
"Feature flags" / "Runtime config" sections and db/init/22_feature_flags.sql,
db/init/19_config_settings.sql, db/init/01_schema.sql:
  - feature_flags(key, enabled, description, ...)            — NOT (flag_key, enabled_default)
  - config_settings(scope, scope_id, key, value JSONB, ...)  — global rows use scope_id=''
  - prompt_registry(prompt_name, version, template, ...)     — NOT (mode, prompt_text)
"""
from __future__ import annotations

import os
import psycopg
import pytest

pytestmark = [
    pytest.mark.integration,
    pytest.mark.skipif(
        not os.getenv("POSTGRES_HOST"),
        reason="POSTGRES_HOST not set; skipping integration test",
    ),
]

REQUIRED_CONFIG_KEYS = [
    "kg.extractor_reliability.computed",
    "kg.extractor_reliability.interpreted",
    "kg.extractor_reliability.hypothesized",
    "kg.extractor_reliability.abstracted",
    "investigation.score_threshold_sync",
    "investigation.score_anomaly_weight",
    "investigation.score_novelty_weight",
    "investigation.score_priority_weight",
    "investigation.sweep_interval_minutes",
    "investigation.pattern_sweep_interval_hours",
    "investigation.max_active_hypotheses_per_project",
    "investigation.daily_llm_budget_usd",
    "investigation.daily_cpu_hours_budget",
    "investigation.max_derivation_depth",
]

REQUIRED_PROMPT_NAMES = [
    "kg.fact_interpretation",
    "kg.hypothesis_formation",
    "kg.test_planning",
    "kg.pattern_summary",
]


@pytest.fixture
def conn():
    with psycopg.connect(
        host=os.environ["POSTGRES_HOST"],
        port=int(os.environ.get("POSTGRES_PORT", "5432")),
        dbname=os.environ.get("POSTGRES_DB", "chemclaw"),
        user=os.environ.get("POSTGRES_USER", "chemclaw"),
        password=os.environ.get("POSTGRES_PASSWORD", ""),
    ) as c:
        yield c


def test_feature_flag_seeded_off_by_default(conn):
    with conn.cursor() as cur:
        cur.execute(
            "SELECT enabled FROM feature_flags WHERE key='kg.auto_extraction.enabled'"
        )
        row = cur.fetchone()
    assert row is not None, "feature flag row missing"
    assert row[0] is False, "feature flag MUST default to OFF in Phase 0"


def test_all_config_keys_seeded(conn):
    with conn.cursor() as cur:
        cur.execute(
            "SELECT key FROM config_settings WHERE scope='global' AND scope_id=''"
        )
        actual = {r[0] for r in cur.fetchall()}
    missing = set(REQUIRED_CONFIG_KEYS) - actual
    assert not missing, f"missing config keys: {missing}"


def test_reliability_factors_sane(conn):
    """The four extractor_reliability factors must be a monotone-decreasing
    ladder matching the plan's COMPUTED > INTERPRETED > HYPOTHESIZED > ABSTRACTED
    epistemic ranking.
    """
    with conn.cursor() as cur:
        cur.execute(
            "SELECT key, value FROM config_settings "
            "WHERE scope='global' AND key LIKE 'kg.extractor_reliability.%%'"
        )
        vals = {k: float(v) for k, v in cur.fetchall()}
    assert vals["kg.extractor_reliability.computed"] == 0.95
    assert vals["kg.extractor_reliability.interpreted"] == 0.75
    assert vals["kg.extractor_reliability.hypothesized"] == 0.60
    assert vals["kg.extractor_reliability.abstracted"] == 0.50
    assert (vals["kg.extractor_reliability.computed"] >
            vals["kg.extractor_reliability.interpreted"] >
            vals["kg.extractor_reliability.hypothesized"] >
            vals["kg.extractor_reliability.abstracted"])


def test_prompt_names_present(conn):
    with conn.cursor() as cur:
        cur.execute("SELECT DISTINCT prompt_name FROM prompt_registry")
        names = {r[0] for r in cur.fetchall()}
    missing = set(REQUIRED_PROMPT_NAMES) - names
    assert not missing, f"missing prompt_name rows: {missing}"


def test_phase_0_prompts_are_inactive(conn):
    """Placeholder prompts seeded by Phase 0 must be inactive — Phase 3+ enables them."""
    with conn.cursor() as cur:
        cur.execute(
            "SELECT prompt_name, active FROM prompt_registry "
            "WHERE prompt_name = ANY(%s)",
            (REQUIRED_PROMPT_NAMES,),
        )
        rows = cur.fetchall()
    assert rows, "no placeholder prompt rows found"
    for prompt_name, active in rows:
        assert active is False, (
            f"{prompt_name} should be inactive in Phase 0; got active={active}"
        )
