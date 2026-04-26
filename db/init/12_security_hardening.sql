-- Security hardening migration (post-v1.0.0-claw audit).
-- Re-applicable: every change is guarded by IF NOT EXISTS / DROP POLICY IF EXISTS.
--
-- This file addresses six findings from the post-v1.0.0 security audit:
--
--   1. RLS was vacuous in production — table OWNERS bypass RLS in Postgres
--      unless `FORCE ROW LEVEL SECURITY` is set. The agent and frontend
--      connect as the table owner (`chemclaw`), so every read silently
--      ignored every policy. We FORCE every RLS-enabled table here.
--
--   2. Several project-scoped tables had NO RLS at all (documents,
--      document_chunks, compounds, reactions, feedback_events, corrections,
--      notifications, prompt_registry). Each gets a policy here.
--
--   3. The `chemclaw_service` role was created NOLOGIN, which broke the
--      kg-hypotheses docker-compose entry that tried to connect as it
--      directly. It is promoted to LOGIN here; projectors and ingestion
--      workers should connect as chemclaw_service to bypass RLS.
--
--   4. Empty-user RLS policies were "permissive for everyone" (USING (...
--      IS NULL OR = '')) — fail-OPEN. We add a parallel `chemclaw_app`
--      role intended for app traffic; the BYPASSRLS path is reserved for
--      `chemclaw_service`, so when services migrate to chemclaw_app + a
--      real `app.current_user_entra_id`, the empty-user fall-through can
--      be removed (deferred — see docs/runbooks/security-hardening-migration.md).
--
--   5. contextual_chunker projector queries `byte_start` / `byte_end` from
--      document_chunks, but those columns were never added to the schema.
--      The projector was crashing on every document_ingested event.
--
--   6. The `mcp_doc_fetcher` SSRF surface and source-system URL-injection
--      surface are addressed in code; nothing schema-level.

BEGIN;

-- --------------------------------------------------------------------
-- (5) Missing columns for contextual_chunker.
-- --------------------------------------------------------------------
ALTER TABLE document_chunks
  ADD COLUMN IF NOT EXISTS byte_start BIGINT,
  ADD COLUMN IF NOT EXISTS byte_end   BIGINT;

CREATE INDEX IF NOT EXISTS idx_document_chunks_byte_range
  ON document_chunks(document_id, byte_start)
  WHERE byte_start IS NOT NULL;

COMMENT ON COLUMN document_chunks.byte_start IS
  'Inclusive byte offset of this chunk within documents.parsed_markdown. '
  'Used by contextual_chunker for byte-offset → page mapping (PDFs). '
  'NULL for chunks ingested before this column was added.';

COMMENT ON COLUMN document_chunks.byte_end IS
  'Exclusive byte offset of this chunk within documents.parsed_markdown. '
  'NULL for chunks ingested before this column was added.';

-- --------------------------------------------------------------------
-- (3) Promote chemclaw_service to LOGIN; add chemclaw_app role.
--
-- Rationale: in v1.0.0-claw, every service connects as the database
-- owner role `chemclaw` (POSTGRES_USER), which trivially bypasses RLS.
-- We add a non-bypass app role; services should migrate to it via
-- the new POSTGRES_APP_USER env vars in docker-compose.
--
-- The passwords default to the dev placeholder so `make up` keeps
-- working without env-var changes; production deployments must
-- override CHEMCLAW_APP_PASSWORD and CHEMCLAW_SERVICE_PASSWORD.
-- --------------------------------------------------------------------

DO $$
DECLARE
  v_app_password     TEXT := coalesce(current_setting('chemclaw.app_password',    true), 'chemclaw_dev_password_change_me');
  v_service_password TEXT := coalesce(current_setting('chemclaw.service_password', true), 'chemclaw_dev_password_change_me');
BEGIN
  IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'chemclaw_service') THEN
    -- Was created NOLOGIN in 01_schema.sql; promote.
    EXECUTE format('ALTER ROLE chemclaw_service WITH LOGIN BYPASSRLS PASSWORD %L', v_service_password);
  ELSE
    EXECUTE format('CREATE ROLE chemclaw_service WITH LOGIN BYPASSRLS PASSWORD %L', v_service_password);
  END IF;

  IF NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'chemclaw_app') THEN
    EXECUTE format('CREATE ROLE chemclaw_app WITH LOGIN NOBYPASSRLS PASSWORD %L', v_app_password);
  END IF;
END $$;

-- Grant rights. chemclaw_service gets full access (it already had BYPASSRLS,
-- so the GRANTs are belt-and-suspenders); chemclaw_app gets DML on tables
-- and USAGE on sequences, but RLS will gate every row it sees.
GRANT ALL ON ALL TABLES    IN SCHEMA public TO chemclaw_service;
GRANT ALL ON ALL SEQUENCES IN SCHEMA public TO chemclaw_service;
GRANT ALL ON ALL FUNCTIONS IN SCHEMA public TO chemclaw_service;

GRANT SELECT, INSERT, UPDATE, DELETE ON ALL TABLES    IN SCHEMA public TO chemclaw_app;
GRANT USAGE, SELECT                  ON ALL SEQUENCES IN SCHEMA public TO chemclaw_app;
GRANT EXECUTE                        ON ALL FUNCTIONS IN SCHEMA public TO chemclaw_app;

ALTER DEFAULT PRIVILEGES IN SCHEMA public
  GRANT ALL ON TABLES    TO chemclaw_service;
ALTER DEFAULT PRIVILEGES IN SCHEMA public
  GRANT ALL ON SEQUENCES TO chemclaw_service;
ALTER DEFAULT PRIVILEGES IN SCHEMA public
  GRANT SELECT, INSERT, UPDATE, DELETE ON TABLES TO chemclaw_app;
ALTER DEFAULT PRIVILEGES IN SCHEMA public
  GRANT USAGE, SELECT ON SEQUENCES TO chemclaw_app;

-- --------------------------------------------------------------------
-- (1) FORCE RLS on already-RLS-enabled tables.
-- --------------------------------------------------------------------
ALTER TABLE nce_projects     FORCE ROW LEVEL SECURITY;
ALTER TABLE synthetic_steps  FORCE ROW LEVEL SECURITY;
ALTER TABLE experiments      FORCE ROW LEVEL SECURITY;

-- --------------------------------------------------------------------
-- (2) Add RLS to project-scoped and user-scoped tables that had none.
--
-- Strategy:
--   - `documents`, `document_chunks`, `compounds`, `prompt_registry`:
--      globally readable but require an authenticated user (non-empty
--      app.current_user_entra_id). Writes are permitted by app role
--      (chemclaw_app); ingestion workers bypass via chemclaw_service.
--   - `reactions`: scoped by joining experiment → synthetic_step →
--      user_project_access. Mirrors the experiments_read_policy.
--   - `feedback_events`, `corrections`, `notifications`: scoped by
--      user_entra_id directly.
--
-- Each policy is FOR ALL so writes inherit the same gate as reads.
-- WITH CHECK clauses prevent users from inserting rows attributed
-- to a different user_entra_id.
-- --------------------------------------------------------------------

-- documents — globally readable, write by service.
ALTER TABLE documents ENABLE ROW LEVEL SECURITY;
ALTER TABLE documents FORCE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS documents_authenticated_policy ON documents;
CREATE POLICY documents_authenticated_policy ON documents
  FOR ALL
  USING (
    current_setting('app.current_user_entra_id', true) IS NOT NULL
    AND current_setting('app.current_user_entra_id', true) <> ''
  )
  WITH CHECK (
    current_setting('app.current_user_entra_id', true) IS NOT NULL
    AND current_setting('app.current_user_entra_id', true) <> ''
  );

-- document_chunks — same gate as documents.
ALTER TABLE document_chunks ENABLE ROW LEVEL SECURITY;
ALTER TABLE document_chunks FORCE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS document_chunks_authenticated_policy ON document_chunks;
CREATE POLICY document_chunks_authenticated_policy ON document_chunks
  FOR ALL
  USING (
    current_setting('app.current_user_entra_id', true) IS NOT NULL
    AND current_setting('app.current_user_entra_id', true) <> ''
  )
  WITH CHECK (
    current_setting('app.current_user_entra_id', true) IS NOT NULL
    AND current_setting('app.current_user_entra_id', true) <> ''
  );

-- compounds — globally readable cache.
ALTER TABLE compounds ENABLE ROW LEVEL SECURITY;
ALTER TABLE compounds FORCE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS compounds_authenticated_policy ON compounds;
CREATE POLICY compounds_authenticated_policy ON compounds
  FOR ALL
  USING (
    current_setting('app.current_user_entra_id', true) IS NOT NULL
    AND current_setting('app.current_user_entra_id', true) <> ''
  )
  WITH CHECK (
    current_setting('app.current_user_entra_id', true) IS NOT NULL
    AND current_setting('app.current_user_entra_id', true) <> ''
  );

-- reactions — scoped by experiment → step → project access.
ALTER TABLE reactions ENABLE ROW LEVEL SECURITY;
ALTER TABLE reactions FORCE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS reactions_project_policy ON reactions;
CREATE POLICY reactions_project_policy ON reactions
  FOR ALL
  USING (
    EXISTS (
      SELECT 1
        FROM experiments e
        JOIN synthetic_steps ss ON ss.id = e.synthetic_step_id
        JOIN user_project_access upa ON upa.nce_project_id = ss.nce_project_id
       WHERE e.id = reactions.experiment_id
         AND upa.user_entra_id = current_setting('app.current_user_entra_id', true)
    )
  )
  WITH CHECK (
    EXISTS (
      SELECT 1
        FROM experiments e
        JOIN synthetic_steps ss ON ss.id = e.synthetic_step_id
        JOIN user_project_access upa ON upa.nce_project_id = ss.nce_project_id
       WHERE e.id = reactions.experiment_id
         AND upa.user_entra_id = current_setting('app.current_user_entra_id', true)
    )
  );

-- feedback_events — owned by the user_entra_id column.
ALTER TABLE feedback_events ENABLE ROW LEVEL SECURITY;
ALTER TABLE feedback_events FORCE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS feedback_events_owner_policy ON feedback_events;
CREATE POLICY feedback_events_owner_policy ON feedback_events
  FOR ALL
  USING (user_entra_id = current_setting('app.current_user_entra_id', true))
  WITH CHECK (user_entra_id = current_setting('app.current_user_entra_id', true));

-- corrections — owned by the user_entra_id column.
ALTER TABLE corrections ENABLE ROW LEVEL SECURITY;
ALTER TABLE corrections FORCE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS corrections_owner_policy ON corrections;
CREATE POLICY corrections_owner_policy ON corrections
  FOR ALL
  USING (user_entra_id = current_setting('app.current_user_entra_id', true))
  WITH CHECK (user_entra_id = current_setting('app.current_user_entra_id', true));

-- notifications — owned by the user_entra_id column.
ALTER TABLE notifications ENABLE ROW LEVEL SECURITY;
ALTER TABLE notifications FORCE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS notifications_owner_policy ON notifications;
CREATE POLICY notifications_owner_policy ON notifications
  FOR ALL
  USING (user_entra_id = current_setting('app.current_user_entra_id', true))
  WITH CHECK (user_entra_id = current_setting('app.current_user_entra_id', true));

-- prompt_registry — globally readable cache (versions, templates).
ALTER TABLE prompt_registry ENABLE ROW LEVEL SECURITY;
ALTER TABLE prompt_registry FORCE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS prompt_registry_authenticated_policy ON prompt_registry;
CREATE POLICY prompt_registry_authenticated_policy ON prompt_registry
  FOR ALL
  USING (
    current_setting('app.current_user_entra_id', true) IS NOT NULL
    AND current_setting('app.current_user_entra_id', true) <> ''
  )
  WITH CHECK (
    current_setting('app.current_user_entra_id', true) IS NOT NULL
    AND current_setting('app.current_user_entra_id', true) <> ''
  );

-- --------------------------------------------------------------------
-- (4) W2.3 — Fail-closed empty-user RLS policies.
--
-- After the docker-compose role migration (every system worker now
-- connects as chemclaw_service which has BYPASSRLS), the empty-user
-- "permissive" branch in 01_schema.sql's policies is no longer needed
-- as a system-bypass mechanism — BYPASSRLS-by-role IS the bypass. The
-- legacy `IS NULL OR = ''` predicate becomes a fail-OPEN footgun: a
-- forgetful developer who skips `set_config(...)` would otherwise read
-- every project's data as chemclaw_app.
--
-- We replace the legacy policies with strict ones that require a real
-- non-empty user. System workers continue to bypass via BYPASSRLS.
-- --------------------------------------------------------------------

DROP POLICY IF EXISTS nce_projects_read_policy ON nce_projects;
CREATE POLICY nce_projects_read_policy ON nce_projects
  FOR SELECT
  USING (
    EXISTS (
      SELECT 1 FROM user_project_access upa
       WHERE upa.nce_project_id = nce_projects.id
         AND upa.user_entra_id = current_setting('app.current_user_entra_id', true)
    )
  );

DROP POLICY IF EXISTS synthetic_steps_read_policy ON synthetic_steps;
CREATE POLICY synthetic_steps_read_policy ON synthetic_steps
  FOR SELECT
  USING (
    EXISTS (
      SELECT 1 FROM user_project_access upa
       WHERE upa.nce_project_id = synthetic_steps.nce_project_id
         AND upa.user_entra_id = current_setting('app.current_user_entra_id', true)
    )
  );

DROP POLICY IF EXISTS experiments_read_policy ON experiments;
CREATE POLICY experiments_read_policy ON experiments
  FOR SELECT
  USING (
    EXISTS (
      SELECT 1
        FROM synthetic_steps ss
        JOIN user_project_access upa ON upa.nce_project_id = ss.nce_project_id
       WHERE ss.id = experiments.synthetic_step_id
         AND upa.user_entra_id = current_setting('app.current_user_entra_id', true)
    )
  );

-- INSERT/UPDATE/DELETE policies for the same tables — required when FORCE RLS
-- is on. Same project-membership predicate; chemclaw_service still bypasses.

DROP POLICY IF EXISTS nce_projects_modify_policy ON nce_projects;
CREATE POLICY nce_projects_modify_policy ON nce_projects
  FOR ALL
  USING (
    EXISTS (
      SELECT 1 FROM user_project_access upa
       WHERE upa.nce_project_id = nce_projects.id
         AND upa.user_entra_id = current_setting('app.current_user_entra_id', true)
    )
  )
  WITH CHECK (
    EXISTS (
      SELECT 1 FROM user_project_access upa
       WHERE upa.nce_project_id = nce_projects.id
         AND upa.user_entra_id = current_setting('app.current_user_entra_id', true)
    )
  );

DROP POLICY IF EXISTS synthetic_steps_modify_policy ON synthetic_steps;
CREATE POLICY synthetic_steps_modify_policy ON synthetic_steps
  FOR ALL
  USING (
    EXISTS (
      SELECT 1 FROM user_project_access upa
       WHERE upa.nce_project_id = synthetic_steps.nce_project_id
         AND upa.user_entra_id = current_setting('app.current_user_entra_id', true)
    )
  )
  WITH CHECK (
    EXISTS (
      SELECT 1 FROM user_project_access upa
       WHERE upa.nce_project_id = synthetic_steps.nce_project_id
         AND upa.user_entra_id = current_setting('app.current_user_entra_id', true)
    )
  );

DROP POLICY IF EXISTS experiments_modify_policy ON experiments;
CREATE POLICY experiments_modify_policy ON experiments
  FOR ALL
  USING (
    EXISTS (
      SELECT 1
        FROM synthetic_steps ss
        JOIN user_project_access upa ON upa.nce_project_id = ss.nce_project_id
       WHERE ss.id = experiments.synthetic_step_id
         AND upa.user_entra_id = current_setting('app.current_user_entra_id', true)
    )
  )
  WITH CHECK (
    EXISTS (
      SELECT 1
        FROM synthetic_steps ss
        JOIN user_project_access upa ON upa.nce_project_id = ss.nce_project_id
       WHERE ss.id = experiments.synthetic_step_id
         AND upa.user_entra_id = current_setting('app.current_user_entra_id', true)
    )
  );

-- --------------------------------------------------------------------
-- Forged-tool integrity: SHA-256 of the on-disk Python file, computed
-- and persisted at forge time. The agent's tool registry recomputes
-- the hash on every call and refuses to execute a forged tool whose
-- on-disk content has changed since validation.
-- --------------------------------------------------------------------
ALTER TABLE skill_library
  ADD COLUMN IF NOT EXISTS code_sha256 TEXT;

COMMENT ON COLUMN skill_library.code_sha256 IS
  'SHA-256 hex digest of the Python file at scripts_path computed at '
  'forge_tool persist. Compared against the on-disk content at every '
  'call — mismatch means the file was tampered with after validation '
  'and the tool refuses to execute. NULL for tools forged before the '
  'integrity-check migration; the agent logs once and runs without '
  'verification for those (re-forge to enable).';

COMMIT;
