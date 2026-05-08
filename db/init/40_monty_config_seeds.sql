-- Phase G: Monty code-mode orchestration runtime — default config rows.
--
-- Documents the monty.* config keys consumed by services/agent-claw/src/
-- runtime/monty/limits.ts. Defaults match DEFAULT_MONTY_LIMITS so the TS
-- side and the DB are in sync. UPSERT pattern: safe to re-run.
--
-- Operators enable code-mode by writing a row at scope='global' (or per
-- org/project/user) for monty.enabled = true AND monty.binary_path = '<path>'.
-- Until both are set, the run_orchestration_script builtin returns
-- outcome='runtime_disabled' and the agent falls back to sequential ReAct.

-- Routes through bootstrap_config_setting() (SECURITY DEFINER) so a
-- non-superuser migration role can apply this file even though
-- config_settings is FORCE-RLS + admin-INSERT-only.
-- The helper is defined in 22_admin_rls_bootstrap_helpers.sql which
-- runs first by lex order (`22_admin_...` < `22_feature_...` < `40_...`).

BEGIN;

SELECT bootstrap_config_setting(
  'global', '', 'monty.enabled',
  'false'::jsonb,
  'Master switch for the Monty code-mode orchestration runtime. '
    'Set true once monty.binary_path points at an installed runner.',
  '__bootstrap__'
);
SELECT bootstrap_config_setting(
  'global', '', 'monty.binary_path',
  '""'::jsonb,
  'Filesystem path to the Monty runner binary that speaks the line-delimited '
    'JSON-RPC protocol from services/agent-claw/src/runtime/monty/protocol.ts.',
  '__bootstrap__'
);
SELECT bootstrap_config_setting(
  'global', '', 'monty.wall_time_ms',
  '30000'::jsonb,
  'Per-script wall-clock cap (ms). Clamped to [1000, 600000] at read time.',
  '__bootstrap__'
);
SELECT bootstrap_config_setting(
  'global', '', 'monty.max_external_calls',
  '32'::jsonb,
  'Per-script cap on external_function calls. Defense-in-depth against '
    'runaway scripts; the script itself can throw earlier.',
  '__bootstrap__'
);
SELECT bootstrap_config_setting(
  'global', '', 'monty.warm_pool_size',
  '4'::jsonb,
  'Reserved for the warm child pool. Spawn-per-script today; pool lands later.',
  '__bootstrap__'
);

COMMIT;
