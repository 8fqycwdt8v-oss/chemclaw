-- db/seed/09_universal_extraction_config.sql
--
-- Universal Knowledge Accumulation — Phase 0 seeds.
--
-- This seed populates THREE catalogs the rest of the universal-extraction
-- pipeline (Phases 1–5) reads at runtime:
--
--   1. feature_flags : the master kill switch `kg.auto_extraction.enabled`,
--                      OFF by default. The Phase 1 tool-invocation-emitter
--                      hook short-circuits when this is false, so the seed
--                      is safe to land before any extractor exists.
--
--   2. config_settings : 14 global-scope knobs covering extractor-reliability
--                        decay factors, investigation-scorer weights, sweep
--                        cadences, and per-scope budgets. Operators tune
--                        these via the admin endpoint without redeploys.
--
--   3. prompt_registry : 4 INACTIVE placeholder rows for prompts that will
--                        be populated with real templates in Phase 3+. They
--                        exist now so the prompt-name catalog is stable and
--                        callers can wire references before the templates
--                        land.
--
-- Idempotent: each section uses an UPSERT (bootstrap helpers for
-- feature_flags / config_settings; ON CONFLICT … DO UPDATE for
-- prompt_registry). Re-running this file refreshes descriptions /
-- placeholder text without disturbing prompt activation state changed
-- downstream.

BEGIN;

-- ────────────────────────────────────────────────────────────────────────────
-- 1. Feature flag (off by default)
--
-- Routes through bootstrap_feature_flag() (SECURITY DEFINER, defined in
-- db/init/22_admin_rls_bootstrap_helpers.sql) so a non-superuser
-- migration role can seed the row even though feature_flags is
-- FORCE-RLS + admin-INSERT-only.
--
-- The helper is ON CONFLICT DO NOTHING, so we use it for first insert
-- and then run an explicit UPDATE for idempotent refresh of the
-- description on re-apply.
-- ────────────────────────────────────────────────────────────────────────────
SELECT bootstrap_feature_flag(
  'kg.auto_extraction.enabled',
  FALSE,
  'Master switch for the universal knowledge-accumulation pipeline. '
  'When OFF the tool-invocation-emitter hook short-circuits and emits '
  'no events. Default OFF in Phase 0 — flip per project (via scope_rule) '
  'or globally once extractors land in Phase 1+.',
  '__bootstrap__'
);
UPDATE feature_flags
   SET description =
        'Master switch for the universal knowledge-accumulation pipeline. '
        'When OFF the tool-invocation-emitter hook short-circuits and emits '
        'no events. Default OFF in Phase 0 — flip per project (via scope_rule) '
        'or globally once extractors land in Phase 1+.',
       updated_at  = NOW()
 WHERE key = 'kg.auto_extraction.enabled';

-- Phase 6: agent-internal ABSTRACTED fact extraction
SELECT bootstrap_feature_flag(
  'kg.conclusion_extraction.enabled',
  FALSE,
  'Phase 6 switch for agent-internal ABSTRACTED fact extraction. '
  'When ON the kg-conclusion-buffer post_tool hook buffers chemistry tool '
  'outputs each turn and the kg-conclusion-extractor post_turn hook calls '
  'LLM to derive ABSTRACTED facts (confidence ≤ 0.70). Off by default — '
  'flip per project once the prompt template is tuned.',
  '__bootstrap__'
);
UPDATE feature_flags
   SET description =
        'Phase 6 switch for agent-internal ABSTRACTED fact extraction. '
        'When ON the kg-conclusion-buffer post_tool hook buffers chemistry tool '
        'outputs each turn and the kg-conclusion-extractor post_turn hook calls '
        'LLM to derive ABSTRACTED facts (confidence ≤ 0.70). Off by default — '
        'flip per project once the prompt template is tuned.',
       updated_at  = NOW()
 WHERE key = 'kg.conclusion_extraction.enabled';

-- ────────────────────────────────────────────────────────────────────────────
-- 2. Config knobs (global defaults; resolution chain user → project → org → global).
--
-- scope_id is the empty string for global rows (config_settings CHECK
-- constraint enforces this). bootstrap_config_setting() is SECURITY
-- DEFINER so we don't need superuser to apply the seed on hardened
-- deployments.
--
-- The two value families:
--   kg.extractor_reliability.*   — multiplicative decay factors applied
--                                   when a derivation_class flows down the
--                                   COMPUTED > INTERPRETED > HYPOTHESIZED >
--                                   ABSTRACTED ladder. Monotone decreasing.
--   investigation.*              — investigation-scorer weights, cron
--                                   cadences, and per-scope budget caps.
-- ────────────────────────────────────────────────────────────────────────────

-- Reliability factors (4)
SELECT bootstrap_config_setting(
  'global', '', 'kg.extractor_reliability.computed',
  '0.95'::jsonb,
  'Multiplicative decay factor for COMPUTED derivation_class facts.',
  '__bootstrap__'
);
SELECT bootstrap_config_setting(
  'global', '', 'kg.extractor_reliability.interpreted',
  '0.75'::jsonb,
  'Multiplicative decay factor for INTERPRETED derivation_class facts.',
  '__bootstrap__'
);
SELECT bootstrap_config_setting(
  'global', '', 'kg.extractor_reliability.hypothesized',
  '0.60'::jsonb,
  'Multiplicative decay factor for HYPOTHESIZED derivation_class facts.',
  '__bootstrap__'
);
SELECT bootstrap_config_setting(
  'global', '', 'kg.extractor_reliability.abstracted',
  '0.50'::jsonb,
  'Multiplicative decay factor for ABSTRACTED derivation_class facts.',
  '__bootstrap__'
);

-- Investigation knobs (10)
SELECT bootstrap_config_setting(
  'global', '', 'investigation.score_threshold_sync',
  '0.70'::jsonb,
  'Facts with investigation score >= this threshold trigger sync interpretation.',
  '__bootstrap__'
);
SELECT bootstrap_config_setting(
  'global', '', 'investigation.score_anomaly_weight',
  '0.45'::jsonb,
  'Weight of anomaly_score in the composite investigation score.',
  '__bootstrap__'
);
SELECT bootstrap_config_setting(
  'global', '', 'investigation.score_novelty_weight',
  '0.35'::jsonb,
  'Weight of novelty_score in the composite investigation score.',
  '__bootstrap__'
);
SELECT bootstrap_config_setting(
  'global', '', 'investigation.score_priority_weight',
  '0.20'::jsonb,
  'Weight of project priority in the composite investigation score.',
  '__bootstrap__'
);
SELECT bootstrap_config_setting(
  'global', '', 'investigation.sweep_interval_minutes',
  '15'::jsonb,
  'How often the investigation_queue sweep runs (Phase 3).',
  '__bootstrap__'
);
SELECT bootstrap_config_setting(
  'global', '', 'investigation.pattern_sweep_interval_hours',
  '24'::jsonb,
  'How often the pattern_detector cron daemon runs (Phase 4).',
  '__bootstrap__'
);
SELECT bootstrap_config_setting(
  'global', '', 'investigation.max_active_hypotheses_per_project',
  '12'::jsonb,
  'Cap on concurrent HYPOTHESIZED facts per project to bound LLM cost.',
  '__bootstrap__'
);
SELECT bootstrap_config_setting(
  'global', '', 'investigation.daily_llm_budget_usd',
  '50'::jsonb,
  'Daily LLM-spend cap for the investigation loop, per scope.',
  '__bootstrap__'
);
SELECT bootstrap_config_setting(
  'global', '', 'investigation.daily_cpu_hours_budget',
  '100'::jsonb,
  'Daily compute-hours cap for the test planner / external feeds, per scope.',
  '__bootstrap__'
);
SELECT bootstrap_config_setting(
  'global', '', 'investigation.max_derivation_depth',
  '4'::jsonb,
  'Hard cap on derivation_depth; beyond this facts land as ABSTRACTED.',
  '__bootstrap__'
);

-- Idempotent refresh: bootstrap_config_setting() is ON CONFLICT DO NOTHING,
-- so re-running the seed leaves the value/description columns stale if an
-- operator edited them. We deliberately do NOT rewrite value here — an
-- operator-tuned knob should survive a seed re-apply. Descriptions are
-- baseline-curated content; refresh them so the catalog stays current.
UPDATE config_settings
   SET description = sub.description,
       updated_at  = NOW()
  FROM (VALUES
    ('kg.extractor_reliability.computed',
     'Multiplicative decay factor for COMPUTED derivation_class facts.'),
    ('kg.extractor_reliability.interpreted',
     'Multiplicative decay factor for INTERPRETED derivation_class facts.'),
    ('kg.extractor_reliability.hypothesized',
     'Multiplicative decay factor for HYPOTHESIZED derivation_class facts.'),
    ('kg.extractor_reliability.abstracted',
     'Multiplicative decay factor for ABSTRACTED derivation_class facts.'),
    ('investigation.score_threshold_sync',
     'Facts with investigation score >= this threshold trigger sync interpretation.'),
    ('investigation.score_anomaly_weight',
     'Weight of anomaly_score in the composite investigation score.'),
    ('investigation.score_novelty_weight',
     'Weight of novelty_score in the composite investigation score.'),
    ('investigation.score_priority_weight',
     'Weight of project priority in the composite investigation score.'),
    ('investigation.sweep_interval_minutes',
     'How often the investigation_queue sweep runs (Phase 3).'),
    ('investigation.pattern_sweep_interval_hours',
     'How often the pattern_detector cron daemon runs (Phase 4).'),
    ('investigation.max_active_hypotheses_per_project',
     'Cap on concurrent HYPOTHESIZED facts per project to bound LLM cost.'),
    ('investigation.daily_llm_budget_usd',
     'Daily LLM-spend cap for the investigation loop, per scope.'),
    ('investigation.daily_cpu_hours_budget',
     'Daily compute-hours cap for the test planner / external feeds, per scope.'),
    ('investigation.max_derivation_depth',
     'Hard cap on derivation_depth; beyond this facts land as ABSTRACTED.')
  ) AS sub(key, description)
 WHERE config_settings.scope    = 'global'
   AND config_settings.scope_id = ''
   AND config_settings.key      = sub.key;

-- ────────────────────────────────────────────────────────────────────────────
-- 3. Prompt registry placeholders.
--
-- Inserted INACTIVE (active = FALSE). Phase 3+ will write the real
-- template body and flip active on a new version row. The unique
-- partial index uq_prompt_registry_active enforces at-most-one-active
-- per prompt_name, so seeding inactive rows here is safe alongside
-- whatever active rows future versions add.
-- ────────────────────────────────────────────────────────────────────────────
INSERT INTO prompt_registry (prompt_name, version, template, metadata, created_by, active)
VALUES
  ('kg.fact_interpretation', 1,
   '-- placeholder; populated in Phase 3 with the full interpretation prompt',
   '{"phase": 0, "purpose": "interpret anomaly/novelty signals into hypotheses"}'::jsonb,
   '__bootstrap__', FALSE),
  ('kg.hypothesis_formation', 1,
   '-- placeholder; populated in Phase 4',
   '{"phase": 0, "purpose": "form HYPOTHESIZED facts from cross-fact patterns"}'::jsonb,
   '__bootstrap__', FALSE),
  ('kg.test_planning', 1,
   '-- placeholder; populated in Phase 5',
   '{"phase": 0, "purpose": "plan experiments / queries to test a hypothesis"}'::jsonb,
   '__bootstrap__', FALSE),
  ('kg.pattern_summary', 1,
   '-- placeholder; populated in Phase 4',
   '{"phase": 0, "purpose": "summarise pattern_detected event clusters"}'::jsonb,
   '__bootstrap__', FALSE),
  ('kg.conclusion_extraction', 1,
   '-- placeholder; populated in Phase 6',
   '{"phase": 0, "purpose": "extract ABSTRACTED facts from buffered chemistry tool outputs"}'::jsonb,
   '__bootstrap__', FALSE)
ON CONFLICT (prompt_name, version) DO UPDATE SET
  template = EXCLUDED.template,
  metadata = EXCLUDED.metadata;

COMMIT;
