-- Reject the '__system__' sentinel as a real user identity on owner-scoped
-- tables.
--
-- Background. `withSystemContext` (services/agent-claw/src/db/with-user-context.ts)
-- sets app.current_user_entra_id = '__system__' for queries that read
-- globally-cached state without a real user. Several RLS policies are bare
-- owner-equality:
--
--   USING (user_entra_id = current_setting('app.current_user_entra_id', true))
--
-- If any row's owner column literally contains the string '__system__',
-- a withSystemContext caller would silently match it. These CHECKs make
-- that impossible at the schema level — '__system__' is reserved for the
-- session-level GUC and may never appear in an owner-identity column.
--
-- Scope: only columns that semantically mean "this is a real human user".
-- enqueued_by / created_by / updated_by columns on system-mutable rows
-- (task_queue.enqueued_by, config_settings.updated_by, …) are intentionally
-- left unconstrained — system workers legitimately stamp them with a
-- bootstrap-style sentinel.
--
-- Re-applicable: every constraint-add is guarded by an existence check.

BEGIN;

-- One helper procedure to avoid 11× cut-and-paste DO blocks.
DO $bootstrap$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_proc WHERE proname = '_add_no_system_check') THEN
    EXECUTE $proc$
      CREATE OR REPLACE FUNCTION _add_no_system_check(
        p_table  TEXT,
        p_column TEXT,
        p_schema TEXT DEFAULT 'public'
      ) RETURNS VOID
      LANGUAGE plpgsql AS $body$
      DECLARE
        v_constraint_name TEXT := format('%s_no_system_sentinel', p_column);
        v_qualified       TEXT := format('%I.%I', p_schema, p_table);
      BEGIN
        IF to_regclass(v_qualified) IS NULL THEN
          RETURN;  -- table not present in this partial bootstrap; skip silently
        END IF;
        IF NOT EXISTS (
          SELECT 1 FROM information_schema.columns
           WHERE table_schema = p_schema
             AND table_name   = p_table
             AND column_name  = p_column
        ) THEN
          RETURN;  -- column not present (older schema slice); skip silently
        END IF;
        IF EXISTS (
          SELECT 1 FROM pg_constraint
           WHERE conname  = v_constraint_name
             AND conrelid = v_qualified::regclass
        ) THEN
          RETURN;  -- already applied
        END IF;
        EXECUTE format(
          'ALTER TABLE %I.%I ADD CONSTRAINT %I CHECK (%I IS DISTINCT FROM ''__system__'')',
          p_schema, p_table, v_constraint_name, p_column
        );
      END
      $body$;
    $proc$;
  END IF;
END
$bootstrap$;

-- ────────────────────────────────────────────────────────────────────────────
-- Owner-identity columns (real human users only).
-- ────────────────────────────────────────────────────────────────────────────
SELECT _add_no_system_check('agent_sessions',     'user_entra_id');
SELECT _add_no_system_check('feedback_events',    'user_entra_id');
SELECT _add_no_system_check('corrections',        'user_entra_id');
SELECT _add_no_system_check('notifications',      'user_entra_id');
SELECT _add_no_system_check('paperclip_state',    'user_entra_id');
SELECT _add_no_system_check('research_reports',   'user_entra_id');
SELECT _add_no_system_check('user_project_access', 'user_entra_id');
SELECT _add_no_system_check('hypotheses',         'proposed_by_user_entra_id');
SELECT _add_no_system_check('artifacts',          'owner_entra_id');

-- Drop the helper so it doesn't clutter the catalog. The constraints it
-- created are independent of the function's continued existence.
DROP FUNCTION IF EXISTS _add_no_system_check(TEXT, TEXT, TEXT);

INSERT INTO schema_version (filename)
VALUES ('53_system_sentinel_checks.sql')
ON CONFLICT DO NOTHING;

COMMIT;
