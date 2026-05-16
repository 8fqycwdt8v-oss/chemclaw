-- Tranche 7: migrate per-role LLM inference params and reanimator knobs
-- to config_settings so they are tunable without a code deploy.
--
-- All rows use scope='global' / scope_id=''. Per-org or per-project
-- overrides can be inserted via the admin API without touching this seed.

-- ---------------------------------------------------------------------------
-- LLM inference params
-- ---------------------------------------------------------------------------

-- Global max_tokens cap applied to every LLM call unless a role-specific
-- override is present. Matches the historical hardcoded value of 4096.
SELECT bootstrap_config_setting(
  'global', '', 'llm.max_tokens',
  '4096'::jsonb,
  'Maximum output tokens for LLM calls. Per-role overrides: llm.max_tokens.planner/executor/compactor/judge.',
  '__bootstrap__'
);

-- Per-role overrides (absent = inherit llm.max_tokens).
-- Compactor is given a smaller budget because its output is a compact summary,
-- not a full reasoning trace.
SELECT bootstrap_config_setting(
  'global', '', 'llm.max_tokens.compactor',
  '2048'::jsonb,
  'Max output tokens for the compactor role. Lower than the global default because compactor output is a dense summary.',
  '__bootstrap__'
);

-- ---------------------------------------------------------------------------
-- Reanimator knobs
-- ---------------------------------------------------------------------------

SELECT bootstrap_config_setting(
  'global', '', 'reanimator.stale_after_seconds',
  '300'::jsonb,
  'Seconds since updated_at before a session is considered stale and eligible for auto-resume.',
  '__bootstrap__'
);

SELECT bootstrap_config_setting(
  'global', '', 'reanimator.batch_size',
  '10'::jsonb,
  'Maximum number of sessions to resume in a single reanimator poll tick.',
  '__bootstrap__'
);

-- Stored as a JSON array; the reanimator parses it into a SQL ANY() clause.
-- Changing this controls which finish reasons are eligible for auto-resume.
SELECT bootstrap_config_setting(
  'global', '', 'reanimator.finish_reason_allowlist',
  '["max_steps","stop"]'::jsonb,
  'JSON array of last_finish_reason values that are eligible for auto-resume.',
  '__bootstrap__'
);
