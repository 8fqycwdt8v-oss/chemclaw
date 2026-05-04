-- 32_rls_completeness.sql — close the multi-tenant data leak across tables
-- introduced by the Z-series, Phase 4-9, and workflow-engine merges.
--
-- Findings (from the 2026-05-03 deep-review):
--   • Workflow tables (29_workflows.sql) ship without RLS — a row created
--     by user A is readable/writable by user B through the agent's
--     workflow_inspect / workflow_run / workflow_modify builtins.
--   • task_queue / task_batches / chemspace_screens / gen_runs likewise
--     have no FORCE RLS, so a project_lead in tenant A can see tenant B's
--     queued QM jobs through any direct SQL path.
--   • The qm_* tables (8 of them) are intended to be globally cached
--     across tenants but had no RLS at all — meaning even chemclaw_app
--     could in theory mutate cache entries without authentication.
--   • user_project_access itself was missing RLS — a chemclaw_app session
--     could SELECT * and enumerate every other tenant's RBAC layout.
--
-- Strategy:
--   • For tables with a clear user-owner column (workflows.created_by,
--     workflow_runs.created_by, gen_runs.requested_by, chemspace_screens.created_by)
--     scope reads/writes to that user OR to project_lead/admin via
--     current_user_is_admin().
--   • For child rows (workflow_events, workflow_state, workflow_modifications)
--     join through to workflow_runs.created_by.
--   • For globally-shared cache tables (qm_*) and infrastructure
--     (task_queue, task_batches), enable RLS with a permissive
--     "authenticated session" policy: any authenticated agent-claw user
--     can read/write, but unauthenticated direct connections are blocked.
--     chemclaw_service (BYPASSRLS) is unaffected.
--   • For user_project_access, scope to the row owner OR admin.
--
-- All policies match the patterns already established in
-- 12_security_hardening.sql and 18_admin_roles_and_audit.sql.

BEGIN;

-- ────────────────────────────────────────────────────────────────────────────
-- Helper: a single authenticated-session predicate. We use the existing
-- `current_setting('app.current_user_entra_id', true)` convention; tests
-- without that setting (e.g., direct psql sessions) get NULL and are
-- denied unless they're chemclaw_service (BYPASSRLS).
-- ────────────────────────────────────────────────────────────────────────────
-- (No new function — we inline the predicate to keep migration self-contained.)


-- ────────────────────────────────────────────────────────────────────────────
-- 1. Workflow tables (29_workflows.sql)
-- ────────────────────────────────────────────────────────────────────────────
ALTER TABLE workflows ENABLE ROW LEVEL SECURITY;
ALTER TABLE workflows FORCE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS workflows_owner_or_admin ON workflows;
CREATE POLICY workflows_owner_or_admin ON workflows
  FOR ALL
  USING (
    created_by = current_setting('app.current_user_entra_id', true)
    OR current_user_is_admin('global_admin')
  )
  WITH CHECK (
    created_by = current_setting('app.current_user_entra_id', true)
    OR current_user_is_admin('global_admin')
  );

ALTER TABLE workflow_runs ENABLE ROW LEVEL SECURITY;
ALTER TABLE workflow_runs FORCE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS workflow_runs_owner_or_admin ON workflow_runs;
CREATE POLICY workflow_runs_owner_or_admin ON workflow_runs
  FOR ALL
  USING (
    created_by = current_setting('app.current_user_entra_id', true)
    OR current_user_is_admin('global_admin')
  )
  WITH CHECK (
    created_by = current_setting('app.current_user_entra_id', true)
    OR current_user_is_admin('global_admin')
  );

-- workflow_events / workflow_state / workflow_modifications scope through run_id.
ALTER TABLE workflow_events ENABLE ROW LEVEL SECURITY;
ALTER TABLE workflow_events FORCE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS workflow_events_via_run ON workflow_events;
CREATE POLICY workflow_events_via_run ON workflow_events
  FOR ALL
  USING (
    EXISTS (
      SELECT 1 FROM workflow_runs r
       WHERE r.id = workflow_events.run_id
         AND (
           r.created_by = current_setting('app.current_user_entra_id', true)
           OR current_user_is_admin('global_admin')
         )
    )
  )
  WITH CHECK (
    EXISTS (
      SELECT 1 FROM workflow_runs r
       WHERE r.id = workflow_events.run_id
         AND (
           r.created_by = current_setting('app.current_user_entra_id', true)
           OR current_user_is_admin('global_admin')
         )
    )
  );

ALTER TABLE workflow_state ENABLE ROW LEVEL SECURITY;
ALTER TABLE workflow_state FORCE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS workflow_state_via_run ON workflow_state;
CREATE POLICY workflow_state_via_run ON workflow_state
  FOR ALL
  USING (
    EXISTS (
      SELECT 1 FROM workflow_runs r
       WHERE r.id = workflow_state.run_id
         AND (
           r.created_by = current_setting('app.current_user_entra_id', true)
           OR current_user_is_admin('global_admin')
         )
    )
  )
  WITH CHECK (
    EXISTS (
      SELECT 1 FROM workflow_runs r
       WHERE r.id = workflow_state.run_id
         AND (
           r.created_by = current_setting('app.current_user_entra_id', true)
           OR current_user_is_admin('global_admin')
         )
    )
  );

ALTER TABLE workflow_modifications ENABLE ROW LEVEL SECURITY;
ALTER TABLE workflow_modifications FORCE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS workflow_modifications_via_run ON workflow_modifications;
CREATE POLICY workflow_modifications_via_run ON workflow_modifications
  FOR ALL
  USING (
    EXISTS (
      SELECT 1 FROM workflow_runs r
       WHERE r.id = workflow_modifications.run_id
         AND (
           r.created_by = current_setting('app.current_user_entra_id', true)
           OR current_user_is_admin('global_admin')
         )
    )
  )
  WITH CHECK (
    EXISTS (
      SELECT 1 FROM workflow_runs r
       WHERE r.id = workflow_modifications.run_id
         AND (
           r.created_by = current_setting('app.current_user_entra_id', true)
           OR current_user_is_admin('global_admin')
         )
    )
  );

-- Index to make the EXISTS subquery fast (workflow_runs.id is already PK).
-- created_by needs an index for the owner-policy fast path.
CREATE INDEX IF NOT EXISTS idx_workflow_runs_created_by ON workflow_runs(created_by);
CREATE INDEX IF NOT EXISTS idx_workflows_created_by ON workflows(created_by);


-- ────────────────────────────────────────────────────────────────────────────
-- 2. Generative chemistry tables (26_genchem.sql)
-- ────────────────────────────────────────────────────────────────────────────
ALTER TABLE gen_runs ENABLE ROW LEVEL SECURITY;
ALTER TABLE gen_runs FORCE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS gen_runs_owner_or_admin ON gen_runs;
CREATE POLICY gen_runs_owner_or_admin ON gen_runs
  FOR ALL
  USING (
    requested_by IS NULL
    OR requested_by = current_setting('app.current_user_entra_id', true)
    OR current_user_is_admin('global_admin')
  )
  WITH CHECK (
    requested_by IS NULL
    OR requested_by = current_setting('app.current_user_entra_id', true)
    OR current_user_is_admin('global_admin')
  );

ALTER TABLE gen_proposals ENABLE ROW LEVEL SECURITY;
ALTER TABLE gen_proposals FORCE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS gen_proposals_via_run ON gen_proposals;
CREATE POLICY gen_proposals_via_run ON gen_proposals
  FOR ALL
  USING (
    EXISTS (
      SELECT 1 FROM gen_runs r
       WHERE r.id = gen_proposals.run_id
         AND (
           r.requested_by IS NULL
           OR r.requested_by = current_setting('app.current_user_entra_id', true)
           OR current_user_is_admin('global_admin')
         )
    )
  )
  WITH CHECK (
    EXISTS (
      SELECT 1 FROM gen_runs r
       WHERE r.id = gen_proposals.run_id
         AND (
           r.requested_by IS NULL
           OR r.requested_by = current_setting('app.current_user_entra_id', true)
           OR current_user_is_admin('global_admin')
         )
    )
  );

CREATE INDEX IF NOT EXISTS idx_gen_runs_requested_by ON gen_runs(requested_by);

-- bioisostere_rules and mmp_pairs are global reference catalogues — keep
-- them readable by any authenticated session; only admins write.
ALTER TABLE bioisostere_rules ENABLE ROW LEVEL SECURITY;
ALTER TABLE bioisostere_rules FORCE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS bioisostere_rules_read ON bioisostere_rules;
CREATE POLICY bioisostere_rules_read ON bioisostere_rules
  FOR SELECT
  USING (current_setting('app.current_user_entra_id', true) IS NOT NULL
         AND current_setting('app.current_user_entra_id', true) <> '');

DROP POLICY IF EXISTS bioisostere_rules_write ON bioisostere_rules;
CREATE POLICY bioisostere_rules_write ON bioisostere_rules
  FOR ALL
  USING (current_user_is_admin('global_admin'))
  WITH CHECK (current_user_is_admin('global_admin'));

ALTER TABLE mmp_pairs ENABLE ROW LEVEL SECURITY;
ALTER TABLE mmp_pairs FORCE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS mmp_pairs_authn ON mmp_pairs;
CREATE POLICY mmp_pairs_authn ON mmp_pairs
  FOR ALL
  USING (current_setting('app.current_user_entra_id', true) IS NOT NULL
         AND current_setting('app.current_user_entra_id', true) <> '')
  WITH CHECK (current_setting('app.current_user_entra_id', true) IS NOT NULL
              AND current_setting('app.current_user_entra_id', true) <> '');


-- ────────────────────────────────────────────────────────────────────────────
-- 3. Task queue (27_job_queue.sql)
-- Globally shared infrastructure; require authenticated session for app-role
-- access. Workers connect as chemclaw_service (BYPASSRLS) and are unaffected.
-- ────────────────────────────────────────────────────────────────────────────
ALTER TABLE task_queue ENABLE ROW LEVEL SECURITY;
ALTER TABLE task_queue FORCE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS task_queue_authn ON task_queue;
CREATE POLICY task_queue_authn ON task_queue
  FOR ALL
  USING (current_setting('app.current_user_entra_id', true) IS NOT NULL
         AND current_setting('app.current_user_entra_id', true) <> '')
  WITH CHECK (current_setting('app.current_user_entra_id', true) IS NOT NULL
              AND current_setting('app.current_user_entra_id', true) <> '');

ALTER TABLE task_batches ENABLE ROW LEVEL SECURITY;
ALTER TABLE task_batches FORCE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS task_batches_authn ON task_batches;
CREATE POLICY task_batches_authn ON task_batches
  FOR ALL
  USING (current_setting('app.current_user_entra_id', true) IS NOT NULL
         AND current_setting('app.current_user_entra_id', true) <> '')
  WITH CHECK (current_setting('app.current_user_entra_id', true) IS NOT NULL
              AND current_setting('app.current_user_entra_id', true) <> '');


-- ────────────────────────────────────────────────────────────────────────────
-- 4. Chemspace screens (28_screens.sql)
-- ────────────────────────────────────────────────────────────────────────────
ALTER TABLE chemspace_screens ENABLE ROW LEVEL SECURITY;
ALTER TABLE chemspace_screens FORCE ROW LEVEL SECURITY;

-- chemspace_screens has `created_by`; default to that.
DROP POLICY IF EXISTS chemspace_screens_owner_or_admin ON chemspace_screens;
CREATE POLICY chemspace_screens_owner_or_admin ON chemspace_screens
  FOR ALL
  USING (
    created_by IS NULL
    OR created_by = current_setting('app.current_user_entra_id', true)
    OR current_user_is_admin('global_admin')
  )
  WITH CHECK (
    created_by IS NULL
    OR created_by = current_setting('app.current_user_entra_id', true)
    OR current_user_is_admin('global_admin')
  );

ALTER TABLE chemspace_results ENABLE ROW LEVEL SECURITY;
ALTER TABLE chemspace_results FORCE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS chemspace_results_via_screen ON chemspace_results;
CREATE POLICY chemspace_results_via_screen ON chemspace_results
  FOR ALL
  USING (
    EXISTS (
      SELECT 1 FROM chemspace_screens s
       WHERE s.id = chemspace_results.screen_id
         AND (
           s.created_by IS NULL
           OR s.created_by = current_setting('app.current_user_entra_id', true)
           OR current_user_is_admin('global_admin')
         )
    )
  )
  WITH CHECK (
    EXISTS (
      SELECT 1 FROM chemspace_screens s
       WHERE s.id = chemspace_results.screen_id
         AND (
           s.created_by IS NULL
           OR s.created_by = current_setting('app.current_user_entra_id', true)
           OR current_user_is_admin('global_admin')
         )
    )
  );

CREATE INDEX IF NOT EXISTS idx_chemspace_screens_created_by
  ON chemspace_screens(created_by);


-- ────────────────────────────────────────────────────────────────────────────
-- 5. QM cache tables (23_qm_results.sql)
-- These are deliberately global — every tenant benefits from cached compute.
-- We enable RLS with an authenticated-session policy so unauthenticated
-- chemclaw_app sessions cannot read or scribble cache entries; chemclaw_service
-- (BYPASSRLS) workers and chemclaw_app sessions with a real user pass through.
-- ────────────────────────────────────────────────────────────────────────────
DO $$
DECLARE
  t TEXT;
BEGIN
  FOREACH t IN ARRAY ARRAY[
    'qm_jobs', 'qm_results', 'qm_conformers', 'qm_frequencies',
    'qm_thermo', 'qm_scan_points', 'qm_irc_points', 'qm_md_frames'
  ]
  LOOP
    EXECUTE format('ALTER TABLE %I ENABLE ROW LEVEL SECURITY', t);
    EXECUTE format('ALTER TABLE %I FORCE ROW LEVEL SECURITY', t);
    EXECUTE format('DROP POLICY IF EXISTS %I_authn ON %I', t, t);
    EXECUTE format(
      'CREATE POLICY %I_authn ON %I '
      'FOR ALL '
      'USING (current_setting(''app.current_user_entra_id'', true) IS NOT NULL '
      '       AND current_setting(''app.current_user_entra_id'', true) <> '''')'
      'WITH CHECK (current_setting(''app.current_user_entra_id'', true) IS NOT NULL '
      '            AND current_setting(''app.current_user_entra_id'', true) <> '''')',
      t, t
    );
  END LOOP;
END $$;


-- ────────────────────────────────────────────────────────────────────────────
-- 6. user_project_access — close the RBAC enumeration leak
-- A user can SELECT only their own access rows; admins can SELECT everyone.
-- Writes are admin-only (the seed scripts and admin endpoints use chemclaw
-- the table owner — RLS-enforced via FORCE so even owner needs a policy).
-- ────────────────────────────────────────────────────────────────────────────
ALTER TABLE user_project_access ENABLE ROW LEVEL SECURITY;
ALTER TABLE user_project_access FORCE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS upa_self_or_admin_select ON user_project_access;
CREATE POLICY upa_self_or_admin_select ON user_project_access
  FOR SELECT
  USING (
    user_entra_id = current_setting('app.current_user_entra_id', true)
    OR current_user_is_admin('global_admin')
  );

DROP POLICY IF EXISTS upa_admin_modify ON user_project_access;
CREATE POLICY upa_admin_modify ON user_project_access
  FOR ALL
  USING (current_user_is_admin('global_admin'))
  WITH CHECK (current_user_is_admin('global_admin'));


-- ────────────────────────────────────────────────────────────────────────────
-- 6b. task_queue retry_after — exponential-backoff guard
-- A handler that fails on a transient downstream outage previously spun
-- at full sweep cadence (~30s) until max_attempts. Now the worker writes
-- retry_after on _maybe_retry; _lease_one skips rows whose retry_after
-- is still in the future. Older rows where retry_after IS NULL are
-- treated as immediately eligible (back-compat).
-- ────────────────────────────────────────────────────────────────────────────
ALTER TABLE task_queue
  ADD COLUMN IF NOT EXISTS retry_after TIMESTAMPTZ;

CREATE INDEX IF NOT EXISTS idx_task_queue_retry_after
  ON task_queue (status, task_kind, retry_after)
  WHERE status = 'pending';


-- ────────────────────────────────────────────────────────────────────────────
-- 6c. ensure_audit_log_partitions(months_ahead INT) — SECURITY DEFINER
-- helper for the audit_partition_maintainer daemon.
--
-- Postgres requires that the role creating a partition be the OWNER of the
-- parent table; ownership is not granted by a separate privilege. Rather
-- than transfer ownership of audit_log to chemclaw_service (which would
-- broaden its blast radius), we expose a SECURITY DEFINER function owned
-- by chemclaw and grant EXECUTE to chemclaw_service. The daemon calls this
-- function at its polling interval; the function runs with chemclaw's
-- privileges and can ATTACH the new partition.
--
-- Surfaced by the 2026-05-03 deep-review smoke test: the daemon's first
-- run failed with `must be owner of table audit_log` because the previous
-- attempt to grant CREATE ON SCHEMA wasn't sufficient.
-- ────────────────────────────────────────────────────────────────────────────
CREATE OR REPLACE FUNCTION ensure_audit_log_partitions(months_ahead INTEGER DEFAULT 3)
RETURNS INTEGER
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = pg_catalog, public
AS $$
DECLARE
    v_start DATE;
    v_end   DATE;
    v_name  TEXT;
    i       INTEGER;
    n_created INTEGER := 0;
BEGIN
    IF months_ahead < 0 OR months_ahead > 24 THEN
        RAISE EXCEPTION 'months_ahead out of range: %', months_ahead;
    END IF;
    v_start := date_trunc('month', now())::DATE;
    FOR i IN 0 .. months_ahead LOOP
        v_name := format(
            'audit_log_y%sm%s',
            to_char((v_start + (i || ' months')::INTERVAL), 'YYYY'),
            to_char((v_start + (i || ' months')::INTERVAL), 'MM')
        );
        v_end := (v_start + ((i + 1) || ' months')::INTERVAL)::DATE;
        IF NOT EXISTS (SELECT 1 FROM pg_class WHERE relname = v_name) THEN
            -- Schema-qualify the partition name so the SECURITY DEFINER's
            -- `search_path = pg_catalog, public` doesn't cause Postgres to
            -- attempt CREATE in pg_catalog (which fails with "system
            -- catalog modifications are currently disallowed").
            EXECUTE format(
                'CREATE TABLE IF NOT EXISTS public.%I PARTITION OF public.audit_log
                    FOR VALUES FROM (%L) TO (%L)',
                v_name,
                (v_start + (i || ' months')::INTERVAL)::DATE,
                v_end
            );
            n_created := n_created + 1;
        END IF;
    END LOOP;
    RETURN n_created;
END $$;

REVOKE ALL ON FUNCTION ensure_audit_log_partitions(INTEGER) FROM PUBLIC;
DO $$
BEGIN
  IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'chemclaw_service') THEN
    GRANT EXECUTE ON FUNCTION ensure_audit_log_partitions(INTEGER) TO chemclaw_service;
  END IF;
END $$;

COMMENT ON FUNCTION ensure_audit_log_partitions(INTEGER) IS
  'Creates monthly partitions of audit_log for the next N months '
  '(default 3). Returns the number of partitions actually created. '
  'Called by services/optimizer/audit_partition_maintainer/. '
  'SECURITY DEFINER because partition creation requires audit_log ownership.';


-- ────────────────────────────────────────────────────────────────────────────
-- 7. kg-hypotheses ack-key naming consistency
-- Every other projector uses underscores; only kg-hypotheses used hyphen,
-- breaking the documented replay runbook (DELETE FROM projection_acks
-- WHERE projector_name='kg_hypotheses' silently does nothing).
-- ────────────────────────────────────────────────────────────────────────────
UPDATE projection_acks
   SET projector_name = 'kg_hypotheses'
 WHERE projector_name = 'kg-hypotheses';


-- ────────────────────────────────────────────────────────────────────────────
-- 7b. redaction_patterns ReDoS-resistance CHECK
-- The original constraint capped length at 200 chars, which alone does not
-- prevent catastrophic backtracking. We add a defense-in-depth rejection of
-- the obvious "nested quantifier" patterns (e.g. `(a+)+`, `(a*)*`, `(a|a)*`)
-- and unbounded greedy classes (`.*` repeated). The Python loader's
-- `is_pattern_safe()` already rejects unbounded quantifiers; this CHECK
-- closes the same gate at the DB level so a direct INSERT (bypassing the
-- admin route) cannot smuggle a ReDoS regex into a tenant.
-- ────────────────────────────────────────────────────────────────────────────
DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint
    WHERE conrelid = 'redaction_patterns'::regclass
      AND conname = 'redaction_patterns_no_nested_quantifier'
  ) THEN
    -- The CHECK targets the two classical ReDoS shapes that are
    -- unambiguous regardless of context:
    --   (X+)+, (X*)*, (X+)*, (X*)+ — nested quantifier on a group
    --   (X|X)+ — alternation with overlapping branches under a quantifier
    -- We deliberately do NOT also reject `.*` / `.+` here because they
    -- frequently appear inside character classes (e.g. `[a-z.+\-]`) where
    -- the `+` is a literal, not a quantifier. The Python-side
    -- `is_pattern_safe()` checks the unbounded-greedy case at the loader
    -- with proper context awareness; this DB CHECK is defense-in-depth
    -- for the unambiguous shapes only.
    ALTER TABLE redaction_patterns
      ADD CONSTRAINT redaction_patterns_no_nested_quantifier
      CHECK (
        pattern_regex !~ '\([^)]*[+*][^)]*\)[+*]'
        AND pattern_regex !~ '\([^)]*\|[^)]*\)[+*]'
      );
  END IF;
END $$;

-- ────────────────────────────────────────────────────────────────────────────
-- 7c. shadow_until — mark deprecated until Phase E shadow-serving lands
-- The skill loader currently ignores this column (W2.12 F-12.2). Rather than
-- DROP the column (irreversible without a backup) we leave it in place and
-- add an explicit comment so future readers know it's not load-bearing yet.
-- ────────────────────────────────────────────────────────────────────────────
COMMENT ON COLUMN skill_library.shadow_until IS
  'DEPRECATED until Phase E shadow-serving lands. The skill loader does not '
  'currently read this column. Setting it has no effect. See '
  'docs/review/2026-05-03/12-hooks-skills-permissions.md F-12.2.';

DO $$
BEGIN
  IF EXISTS (SELECT 1 FROM information_schema.columns
              WHERE table_name = 'model_cards' AND column_name = 'shadow_until') THEN
    EXECUTE
      'COMMENT ON COLUMN model_cards.shadow_until IS '
      '''DEPRECATED until Phase E shadow-serving lands. Currently unread.'' ';
  END IF;
END $$;


-- ────────────────────────────────────────────────────────────────────────────
-- 8. schema_version
-- ────────────────────────────────────────────────────────────────────────────
INSERT INTO schema_version (filename, applied_at)
  VALUES ('32_rls_completeness.sql', NOW())
  ON CONFLICT (filename) DO NOTHING;

COMMIT;
