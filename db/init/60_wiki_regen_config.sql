-- ADR 012 Phase 2b: default config_settings rows for the wiki_regen daemon
-- (services/optimizer/wiki_regen/). The daemon reads these knobs from env
-- vars today (WIKI_REGEN_MODEL etc., set in docker-compose); these rows are
-- the discoverable catalog so an admin can see/override them via
-- PATCH /api/admin/config/global//?key=wiki.regen.<k>. (Wiring the daemon to
-- read config_settings via the Python ConfigRegistry instead of env vars is a
-- BACKLOG follow-up — same "born hardcoded, file a follow-up" pattern.)
--
-- Routes through bootstrap_config_setting() (SECURITY DEFINER, defined in
-- 22_admin_rls_bootstrap_helpers.sql which runs first by lex order).
-- Idempotent (ON CONFLICT DO NOTHING).

BEGIN;

SELECT bootstrap_config_setting(
  'global', '', 'wiki.regen.model',
  '"claude-haiku-4-5"'::jsonb,
  'LiteLLM model the wiki_regen daemon uses to synthesise knowledge-wiki page '
    'bodies. Mirrors WIKI_REGEN_MODEL.',
  '__bootstrap__'
);
SELECT bootstrap_config_setting(
  'global', '', 'wiki.regen.poll_seconds',
  '120'::jsonb,
  'How often the wiki_regen daemon polls for dirty pages. Mirrors WIKI_REGEN_POLL_SECONDS.',
  '__bootstrap__'
);
SELECT bootstrap_config_setting(
  'global', '', 'wiki.regen.debounce_seconds',
  '300'::jsonb,
  'A dirty page is only regenerated once it has been dirty for at least this '
    'long, so a burst of backing-data changes collapses into one regen. '
    'Mirrors WIKI_REGEN_DEBOUNCE_SECONDS.',
  '__bootstrap__'
);
SELECT bootstrap_config_setting(
  'global', '', 'wiki.regen.max_per_hour',
  '200'::jsonb,
  'Sliding-window cap on LLM page regenerations per hour (cost guard). '
    'Mirrors WIKI_REGEN_MAX_PER_HOUR.',
  '__bootstrap__'
);
SELECT bootstrap_config_setting(
  'global', '', 'wiki.regen.batch_size',
  '8'::jsonb,
  'Max pages the wiki_regen daemon regenerates per poll tick. Mirrors WIKI_REGEN_BATCH_SIZE.',
  '__bootstrap__'
);

INSERT INTO schema_version (filename, applied_at)
  VALUES ('60_wiki_regen_config.sql', NOW())
  ON CONFLICT (filename) DO NOTHING;

COMMIT;
