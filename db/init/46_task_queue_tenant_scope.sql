-- Cluster C: scope task_queue inserts by tenant.
--
-- Pre-fix the task_queue_authn policy was a permissive
-- "current_user is not empty" gate, and chemclaw_app had INSERT.
-- That meant any authenticated user could enqueue any task_kind
-- (including high-cost shapes like `qm.recompute`) and the queue
-- worker (chemclaw_service, BYPASSRLS) would happily lease + execute.
-- The agent layer's permission_policies catches user-driven
-- `enqueue_batch` calls, but a direct DB INSERT bypasses that.
--
-- This migration:
--   1. Adds enqueued_by TEXT NOT NULL DEFAULT current_setting(...)
--      to record the actor on every row (no backfill — pre-existing
--      rows get '' which the new policy treats as "system-enqueued").
--   2. Tightens the INSERT policy WITH CHECK so chemclaw_app can only
--      INSERT rows whose enqueued_by matches its current_user GUC.
--      System workers (chemclaw_service, BYPASSRLS) ignore the policy.
--   3. Keeps SELECT permissive on the assumption operators want their
--      own queue visibility — reads remain authn-gated only.

BEGIN;

-- 1. enqueued_by column. Default reads current GUC at INSERT time so
-- legitimate app-side enqueues self-stamp; pre-existing rows get ''.
DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM information_schema.columns
     WHERE table_name = 'task_queue' AND column_name = 'enqueued_by'
  ) THEN
    ALTER TABLE task_queue
      ADD COLUMN enqueued_by TEXT NOT NULL
        DEFAULT current_setting('app.current_user_entra_id', true);
  END IF;
END
$$;

-- 2. Tighten the INSERT path of the authn policy.
--
-- Subtle but critical: the existing `task_queue_authn` is `FOR ALL` with
-- `USING (current_user IS NOT NULL/empty)` and no explicit WITH CHECK,
-- which means WITH CHECK defaults to USING — i.e. the existing policy
-- already admits any authenticated INSERT. Adding a *permissive*
-- second policy (Postgres's default) would OR the two checks, leaving
-- the loose existing policy as the de-facto gate.
--
-- Declaring the new policy `AS RESTRICTIVE` makes Postgres AND the two
-- checks: a row is admitted only when BOTH the loose authn check AND
-- the strict enqueued_by-matches-actor check pass. That actually
-- tightens the gate.
--
-- chemclaw_service (BYPASSRLS) ignores both policies entirely, so the
-- queue worker continues to write unaffected.
DROP POLICY IF EXISTS task_queue_insert_self ON task_queue;
CREATE POLICY task_queue_insert_self ON task_queue
  AS RESTRICTIVE
  FOR INSERT
  WITH CHECK (
    current_setting('app.current_user_entra_id', true) IS NOT NULL
    AND current_setting('app.current_user_entra_id', true) <> ''
    AND enqueued_by = current_setting('app.current_user_entra_id', true)
  );

-- Note for test fixtures: the new `enqueued_by NOT NULL DEFAULT
-- current_setting(...)` column means a direct INSERT without an
-- `app.current_user_entra_id` GUC set will fail with NOT NULL
-- violation. Production paths set the GUC via withUserContext;
-- system workers run as chemclaw_service (BYPASSRLS) and can pass an
-- explicit enqueued_by value.

COMMIT;
