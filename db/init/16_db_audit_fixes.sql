-- DB audit fixes — consolidates findings from a deep database review.
-- Re-applicable: every change is guarded by IF NOT EXISTS / DROP ... IF EXISTS
-- and (additionally) by table-existence checks so the migration is safe to
-- run against a partial schema (e.g. CI env that only loaded a subset of
-- the prior init files).
--
-- Numbered 16 to land after 15_feedback_prompt_link.sql so policies/indexes
-- on feedback_events that reference the prompt_name column are valid.
--
-- This file addresses the following classes of issues uncovered by the audit:
--
--   1. FORCE ROW LEVEL SECURITY gaps. Several tables enabled RLS but did not
--      FORCE it, so the table owner (chemclaw) silently bypassed every policy.
--      The owner is the migration role, not application traffic, but the gap
--      is an error-of-omission footgun.
--
--   2. Incomplete RLS policies. paperclip_state had a USING-only policy;
--      research_reports had a SELECT-only policy with the legacy fail-open
--      empty-user fall-through; hypotheses/artifacts lacked DELETE policies.
--
--   3. Over-permissive RLS. shadow_run_scores and skill_promotion_events
--      had USING (true) — anyone (even unauthenticated) could read. Tightened
--      to require a non-empty app.current_user_entra_id.
--
--   4. plpgsql functions without SET search_path. set_updated_at,
--      notify_ingestion_event, agent_sessions_regen_etag,
--      mock_eln.set_entry_modified_at were vulnerable to search_path
--      hijacking by a SECURITY INVOKER caller.
--
--   5. Missing indexes. ingestion_events.payload (no GIN), projection_acks
--      replays (no projector_name-leading index), research_reports.agent_trace_id,
--      compounds.{chebi_id,pubchem_cid}, agent_sessions composite for purger,
--      paperclip_state.session_id, artifacts composite, mock_eln.entries
--      composite, corrections.{applied,user_entra_id}.
--
--   6. Type / range bugs. paperclip_state.{est_tokens,actual_tokens} INT
--      caps at ~2.1B tokens — too tight for long sessions. Promote to BIGINT.
--
--   7. Missing constraints. agent_sessions.awaiting_question had no length
--      cap (DoS surface for malicious tools); auto_resume_count vs
--      auto_resume_cap had no relationship constraint; finish_reason had
--      no enumeration.

BEGIN;

-- --------------------------------------------------------------------
-- Helper: skip a statement when the table doesn't exist. Each section
-- below is wrapped in a DO $$ ... IF to_regclass(...) IS NOT NULL THEN
-- ... END $$ block; that makes the whole migration tolerant of partial
-- prior init state without losing transactional atomicity.
-- --------------------------------------------------------------------

-- 1. FORCE ROW LEVEL SECURITY where it was missing.
DO $$
DECLARE
  t TEXT;
BEGIN
  FOREACH t IN ARRAY ARRAY[
    'paperclip_state', 'research_reports', 'hypotheses', 'hypothesis_citations',
    'skill_library',   'artifacts',        'forged_tool_tests',
    'forged_tool_validation_runs',         'shadow_run_scores',
    'skill_promotion_events'
  ]
  LOOP
    IF to_regclass('public.' || t) IS NOT NULL THEN
      EXECUTE format('ALTER TABLE public.%I FORCE ROW LEVEL SECURITY', t);
    END IF;
  END LOOP;
END $$;

-- 2a. paperclip_state — replace the USING-only policy with a complete one.
DO $$
BEGIN
  IF to_regclass('public.paperclip_state') IS NOT NULL THEN
    DROP POLICY IF EXISTS paperclip_own_policy ON paperclip_state;
    CREATE POLICY paperclip_own_policy ON paperclip_state
      FOR ALL
      USING (
        current_setting('app.current_user_entra_id', true) IS NOT NULL
        AND current_setting('app.current_user_entra_id', true) <> ''
        AND user_entra_id = current_setting('app.current_user_entra_id', true)
      )
      WITH CHECK (
        user_entra_id = current_setting('app.current_user_entra_id', true)
      );
  END IF;
END $$;

-- 2b. research_reports — owner-scoped FOR ALL with WITH CHECK.
--
-- The explicit IS NOT NULL AND <> '' guards mirror the paperclip_state
-- and shadow_run_scores policies. Without them the predicate `user_entra_id
-- = current_setting(...)` would evaluate to NULL when the GUC is unset,
-- which is correctly falsy — but the explicit guards make the gate
-- self-documenting and consistent with the rest of the file.
DO $$
BEGIN
  IF to_regclass('public.research_reports') IS NOT NULL THEN
    DROP POLICY IF EXISTS research_reports_owner_policy ON research_reports;
    CREATE POLICY research_reports_owner_policy ON research_reports
      FOR ALL
      USING (
        current_setting('app.current_user_entra_id', true) IS NOT NULL
        AND current_setting('app.current_user_entra_id', true) <> ''
        AND user_entra_id = current_setting('app.current_user_entra_id', true)
      )
      WITH CHECK (
        user_entra_id = current_setting('app.current_user_entra_id', true)
      );
  END IF;
END $$;

-- 2c. hypotheses — add the missing DELETE policy.
-- The IS NOT NULL/<> '' guards mirror 2a/2b and defend against an
-- unauthenticated caller deleting any row whose proposed_by_user_entra_id
-- is accidentally stored as '' (the bare equality predicate would otherwise
-- match such a row when the GUC is also empty).
DO $$
BEGIN
  IF to_regclass('public.hypotheses') IS NOT NULL THEN
    DROP POLICY IF EXISTS hypotheses_owner_delete ON hypotheses;
    CREATE POLICY hypotheses_owner_delete ON hypotheses FOR DELETE
      USING (
        current_setting('app.current_user_entra_id', true) IS NOT NULL
        AND current_setting('app.current_user_entra_id', true) <> ''
        AND proposed_by_user_entra_id = current_setting('app.current_user_entra_id', true)
      );
  END IF;
END $$;

-- 2d. artifacts — add the missing DELETE policy. Same guards as 2c.
DO $$
BEGIN
  IF to_regclass('public.artifacts') IS NOT NULL THEN
    DROP POLICY IF EXISTS artifacts_owner_delete ON artifacts;
    CREATE POLICY artifacts_owner_delete ON artifacts FOR DELETE
      USING (
        current_setting('app.current_user_entra_id', true) IS NOT NULL
        AND current_setting('app.current_user_entra_id', true) <> ''
        AND owner_entra_id = current_setting('app.current_user_entra_id', true)
      );
  END IF;
END $$;

-- 3. Tighten over-permissive read policies (USING (true)).
DO $$
BEGIN
  IF to_regclass('public.shadow_run_scores') IS NOT NULL THEN
    DROP POLICY IF EXISTS shadow_run_scores_read ON shadow_run_scores;
    CREATE POLICY shadow_run_scores_read ON shadow_run_scores
      FOR SELECT
      USING (
        current_setting('app.current_user_entra_id', true) IS NOT NULL
        AND current_setting('app.current_user_entra_id', true) <> ''
      );
  END IF;
  IF to_regclass('public.skill_promotion_events') IS NOT NULL THEN
    DROP POLICY IF EXISTS skill_promotion_events_read ON skill_promotion_events;
    CREATE POLICY skill_promotion_events_read ON skill_promotion_events
      FOR SELECT
      USING (
        current_setting('app.current_user_entra_id', true) IS NOT NULL
        AND current_setting('app.current_user_entra_id', true) <> ''
      );
  END IF;
END $$;

-- 4. Pin SET search_path on plpgsql functions (search_path hijack defense).
--
-- The targeted functions are all zero-arg trigger functions. We filter on
-- pronargs = 0 so that a future overloaded variant with arguments isn't
-- silently skipped (ALTER FUNCTION resolves by exact signature, so the
-- bare `name()` call would no-op against a same-named non-zero-arg
-- function). Use OID-based ALTER FUNCTION via regprocedure so the
-- signature is implicit in the OID lookup.
DO $$
DECLARE
  fn RECORD;
BEGIN
  FOR fn IN
    SELECT p.oid::regprocedure AS sig,
           n.nspname           AS schema
      FROM pg_proc p
      JOIN pg_namespace n ON n.oid = p.pronamespace
     WHERE (n.nspname, p.proname) IN (
       ('public',   'set_updated_at'),
       ('public',   'notify_ingestion_event'),
       ('public',   'agent_sessions_regen_etag'),
       ('mock_eln', 'set_entry_modified_at')
     )
       AND p.pronargs = 0
  LOOP
    EXECUTE format(
      'ALTER FUNCTION %s SET search_path = %s, pg_temp',
      fn.sig::text,
      CASE WHEN fn.schema = 'public' THEN 'public'
           ELSE fn.schema || ', public'
      END
    );
  END LOOP;
END $$;

-- 5. Missing indexes — add for common query paths. Each guarded by
--    presence of the underlying table to keep partial-schema applies safe.
DO $$
BEGIN
  IF to_regclass('public.ingestion_events') IS NOT NULL THEN
    -- jsonb_path_ops over jsonb_ops: 2-3x smaller and faster for the
    -- containment queries projectors actually use (`payload @> '{...}'`
    -- to filter by event-payload key/value). The default jsonb_ops would
    -- also support `?`, `?|`, `?&` key-existence operators; projectors
    -- never run those, so we don't pay for them.
    CREATE INDEX IF NOT EXISTS idx_ingestion_events_payload_gin
      ON ingestion_events USING gin (payload jsonb_path_ops);
  END IF;
  IF to_regclass('public.projection_acks') IS NOT NULL THEN
    CREATE INDEX IF NOT EXISTS idx_projection_acks_projector_name
      ON projection_acks (projector_name);
  END IF;
  IF to_regclass('public.research_reports') IS NOT NULL THEN
    CREATE INDEX IF NOT EXISTS idx_research_reports_trace_id
      ON research_reports (agent_trace_id) WHERE agent_trace_id IS NOT NULL;
  END IF;
  IF to_regclass('public.compounds') IS NOT NULL THEN
    CREATE INDEX IF NOT EXISTS idx_compounds_chebi_id
      ON compounds (chebi_id) WHERE chebi_id IS NOT NULL;
    CREATE INDEX IF NOT EXISTS idx_compounds_pubchem_cid
      ON compounds (pubchem_cid) WHERE pubchem_cid IS NOT NULL;
  END IF;
  -- Note: 13_agent_sessions.sql already has idx_agent_sessions_expires
  -- on (expires_at) WHERE expires_at IS NOT NULL. The session_purger query
  -- is `WHERE expires_at < NOW() AND created_at < NOW() - hours`; the
  -- existing single-column index covers the leading predicate, after
  -- which the secondary created_at filter is applied to a small set
  -- (rows past expires_at). A composite (expires_at, created_at) index
  -- would marginally reduce that set scan but adds INSERT/UPDATE write
  -- amplification on a hot table. The existing index is sufficient — no
  -- new index added here. Drop any composite created by an earlier draft
  -- of this migration so the on-disk state matches the current intent.
  DROP INDEX IF EXISTS public.idx_agent_sessions_expires_created;
  IF to_regclass('public.paperclip_state') IS NOT NULL THEN
    CREATE INDEX IF NOT EXISTS idx_paperclip_session_id
      ON paperclip_state (session_id);
  END IF;
  IF to_regclass('public.artifacts') IS NOT NULL THEN
    CREATE INDEX IF NOT EXISTS idx_artifacts_owner_maturity
      ON artifacts (owner_entra_id, maturity);
  END IF;
  IF to_regclass('public.corrections') IS NOT NULL THEN
    CREATE INDEX IF NOT EXISTS idx_corrections_unapplied
      ON corrections (created_at DESC) WHERE applied = false;
    CREATE INDEX IF NOT EXISTS idx_corrections_user
      ON corrections (user_entra_id);
  END IF;
  IF to_regclass('mock_eln.entries') IS NOT NULL THEN
    CREATE INDEX IF NOT EXISTS idx_mock_eln_entries_project_status_modified
      ON mock_eln.entries (project_id, status, modified_at DESC);
  END IF;
END $$;

-- 6. Type widening — paperclip_state token columns.
--
-- LOCKING WARNING: ALTER COLUMN TYPE INT → BIGINT requires a full table
-- rewrite (INT is 4 bytes, BIGINT is 8 — different on-disk size). Postgres
-- holds an AccessExclusiveLock on the table for the duration. There is no
-- CONCURRENTLY equivalent. paperclip_state is small (one row per agent
-- reservation, purged on release_at), so the rewrite finishes in
-- milliseconds even in production. If this migration is ever reused on a
-- larger table, prefer a multi-step approach: add a new BIGINT column,
-- backfill in batches, swap, drop old.
--
-- The pre-check on data_type='integer' makes re-applies a true no-op
-- (skips the table rewrite entirely on already-widened columns).
DO $$
BEGIN
  IF to_regclass('public.paperclip_state') IS NOT NULL
     AND EXISTS (
       SELECT 1 FROM information_schema.columns
        WHERE table_schema = 'public'
          AND table_name   = 'paperclip_state'
          AND column_name  = 'est_tokens'
          AND data_type    = 'integer'
     )
  THEN
    ALTER TABLE paperclip_state
      ALTER COLUMN est_tokens    TYPE BIGINT,
      ALTER COLUMN actual_tokens TYPE BIGINT;
  END IF;
END $$;

-- 7. Missing CHECK constraints.

-- agent_sessions.awaiting_question — bound length.
DO $$
BEGIN
  IF to_regclass('public.agent_sessions') IS NOT NULL
     AND NOT EXISTS (
       SELECT 1 FROM pg_constraint
        WHERE conname  = 'agent_sessions_awaiting_question_length'
          AND conrelid = 'agent_sessions'::regclass
     )
  THEN
    ALTER TABLE agent_sessions
      ADD CONSTRAINT agent_sessions_awaiting_question_length
      CHECK (awaiting_question IS NULL OR char_length(awaiting_question) <= 4000);
  END IF;
END $$;

-- agent_sessions.auto_resume_count <= cap.
DO $$
BEGIN
  IF to_regclass('public.agent_sessions') IS NOT NULL
     AND EXISTS (
       SELECT 1 FROM information_schema.columns
        WHERE table_schema = 'public' AND table_name = 'agent_sessions'
          AND column_name  = 'auto_resume_cap'
     )
     AND NOT EXISTS (
       SELECT 1 FROM pg_constraint
        WHERE conname  = 'agent_sessions_auto_resume_count_within_cap'
          AND conrelid = 'agent_sessions'::regclass
     )
  THEN
    ALTER TABLE agent_sessions
      ADD CONSTRAINT agent_sessions_auto_resume_count_within_cap
      CHECK (auto_resume_count >= 0 AND auto_resume_count <= auto_resume_cap);
  END IF;
END $$;

-- agent_sessions counters are non-negative.
DO $$
BEGIN
  IF to_regclass('public.agent_sessions') IS NOT NULL
     AND EXISTS (
       SELECT 1 FROM information_schema.columns
        WHERE table_schema = 'public' AND table_name = 'agent_sessions'
          AND column_name  = 'session_input_tokens'
     )
     AND NOT EXISTS (
       SELECT 1 FROM pg_constraint
        WHERE conname  = 'agent_sessions_token_counters_nonneg'
          AND conrelid = 'agent_sessions'::regclass
     )
  THEN
    ALTER TABLE agent_sessions
      ADD CONSTRAINT agent_sessions_token_counters_nonneg
      CHECK (
        session_input_tokens  >= 0
        AND session_output_tokens >= 0
        AND session_steps         >= 0
        AND (session_token_budget IS NULL OR session_token_budget >= 0)
      );
  END IF;
END $$;

-- agent_sessions.last_finish_reason enumeration.
DO $$
BEGIN
  IF to_regclass('public.agent_sessions') IS NOT NULL
     AND NOT EXISTS (
       SELECT 1 FROM pg_constraint
        WHERE conname  = 'agent_sessions_finish_reason_check'
          AND conrelid = 'agent_sessions'::regclass
     )
  THEN
    ALTER TABLE agent_sessions
      ADD CONSTRAINT agent_sessions_finish_reason_check
      CHECK (last_finish_reason IS NULL OR last_finish_reason IN (
        'stop', 'max_steps', 'budget_exceeded',
        'awaiting_user_input', 'error'
      ));
  END IF;
END $$;

-- paperclip_state.session_id shape (UUID-ish; NOT VALID skips legacy rows).
DO $$
BEGIN
  IF to_regclass('public.paperclip_state') IS NOT NULL
     AND NOT EXISTS (
       SELECT 1 FROM pg_constraint
        WHERE conname  = 'paperclip_state_session_id_shape'
          AND conrelid = 'paperclip_state'::regclass
     )
  THEN
    ALTER TABLE paperclip_state
      ADD CONSTRAINT paperclip_state_session_id_shape
      CHECK (
        session_id ~ '^[0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{12}$'
      ) NOT VALID;
  END IF;
END $$;

-- mock_eln.entries.schema_kind enumeration.
DO $$
BEGIN
  IF to_regclass('mock_eln.entries') IS NOT NULL
     AND NOT EXISTS (
       SELECT 1 FROM pg_constraint
        WHERE conname  = 'mock_eln_entries_schema_kind_check'
          AND conrelid = 'mock_eln.entries'::regclass
     )
  THEN
    ALTER TABLE mock_eln.entries
      ADD CONSTRAINT mock_eln_entries_schema_kind_check
      CHECK (schema_kind IN ('ord-v0.3', 'signals-v1', 'freeform', 'legacy-csv'));
  END IF;
END $$;

-- 8a. Grants — `chemclaw_service` must have ALL on every public table.
--
-- 12_security_hardening.sql sets ALTER DEFAULT PRIVILEGES so future tables
-- created by the chemclaw owner inherit ALL for chemclaw_service. But that
-- only covers tables created AFTER 12 ran. Tables from 02–11 (paperclip_state,
-- skill_library, tools, mcp_tools, etc.) miss the grant when 12 itself
-- isn't fully replayed (CI envs, partial dev installs). Belt-and-suspenders:
-- re-grant explicitly here.
DO $$
DECLARE
  t RECORD;
BEGIN
  IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'chemclaw_service') THEN
    FOR t IN
      SELECT schemaname, tablename
        FROM pg_tables
       WHERE schemaname = 'public'
    LOOP
      EXECUTE format('GRANT ALL ON %I.%I TO chemclaw_service', t.schemaname, t.tablename);
    END LOOP;
    -- Sequences too (BIGSERIAL counters etc.). All projectors that INSERT
    -- need USAGE+SELECT on the matching sequence.
    FOR t IN
      SELECT schemaname, sequencename
        FROM pg_sequences
       WHERE schemaname = 'public'
    LOOP
      EXECUTE format('GRANT USAGE, SELECT ON SEQUENCE %I.%I TO chemclaw_service',
                     t.schemaname, t.sequencename);
    END LOOP;
  END IF;
END $$;

-- 9. Comments — document non-obvious decisions.
DO $$
BEGIN
  IF to_regclass('public.reactions') IS NOT NULL THEN
    COMMENT ON COLUMN reactions.drfp_vector IS
      'DRFP (Differential Reaction Fingerprint) as 2048-dim float vector. '
      'Uses ivfflat (not HNSW) due to pgvector HNSW dimension cap of 2000. '
      'See db/init/01_schema.sql line 132 for the index choice rationale.';
  END IF;
  IF to_regclass('public.paperclip_state') IS NOT NULL THEN
    COMMENT ON COLUMN paperclip_state.session_id IS
      'Logical session identifier — typically agent_sessions.id (UUID), but '
      'stored as TEXT to accept legacy dev sessions and external session keys. '
      'New rows must match the UUID shape; see paperclip_state_session_id_shape.';
  END IF;
  IF to_regclass('public.skill_library') IS NOT NULL THEN
    COMMENT ON COLUMN skill_library.kind IS
      'Type of skill: prompt (LLM-templated, prompt_md only) or forged_tool '
      '(executable Python at scripts_path with code_sha256 integrity guard).';
    IF EXISTS (
      SELECT 1 FROM information_schema.columns
       WHERE table_schema = 'public' AND table_name = 'skill_library'
         AND column_name  = 'scope'
    ) THEN
      COMMENT ON COLUMN skill_library.scope IS
        'Visibility scope: private (owner only), project (active+shared via '
        'user_project_access), org (active+anyone authenticated). Scope is '
        'orthogonal to active — an inactive scope=org skill is still private.';
    END IF;
  END IF;
  IF to_regclass('public.agent_sessions') IS NOT NULL THEN
    COMMENT ON COLUMN agent_sessions.scratchpad IS
      'Free-form per-session JSONB scratch. Hooks own well-known keys: '
      'redact_log (list), seenFactIds (list of UUIDs), session_id (self-ref), '
      'and per-tool private keys. NEVER expose this directly to the LLM — it '
      'has the same security posture as the audit log.';
  END IF;
END $$;

COMMIT;
