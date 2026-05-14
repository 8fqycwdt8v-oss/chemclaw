-- db/init/67_investigation_budget_usage.sql
--
-- Universal Knowledge Accumulation — Phase 0
-- Daily-window budget consumption for the investigation loop. Resolution
-- mirrors config_settings (user/project/org/global). Phase 4 enforces the
-- budgets; this table is populated from Phase 0.

BEGIN;

CREATE TABLE IF NOT EXISTS investigation_budget_usage (
  scope               TEXT NOT NULL CHECK (scope IN
                        ('global', 'org', 'project', 'user')),
  scope_id            TEXT NOT NULL,
  date_utc            DATE NOT NULL,
  llm_usd_spent       NUMERIC(8,3) NOT NULL DEFAULT 0,
  cpu_hours_spent     NUMERIC(8,3) NOT NULL DEFAULT 0,
  facts_extracted     INT NOT NULL DEFAULT 0,
  hypotheses_proposed INT NOT NULL DEFAULT 0,
  PRIMARY KEY (scope, scope_id, date_utc)
);

COMMENT ON TABLE investigation_budget_usage IS
  'Daily-window budget consumption for the investigation loop. '
  'Resolution mirrors config_settings (user/project/org/global). '
  'Phase 4 enforces the budgets; this table is populated from Phase 0.';

DO $$
BEGIN
  IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'chemclaw_service') THEN
    GRANT ALL ON investigation_budget_usage TO chemclaw_service;
  END IF;
END $$;

INSERT INTO schema_version (filename, applied_at)
VALUES ('67_investigation_budget_usage.sql', NOW())
ON CONFLICT (filename) DO NOTHING;

COMMIT;
