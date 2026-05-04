-- review-v2 Cycle-1: agent_todos.(session_id, ordering) needs a UNIQUE
-- constraint. The createTodos function in core/session-store.ts reads
-- COALESCE(MAX(ordering),0)+1 then INSERTs; under READ COMMITTED two
-- parallel turns on the same session_id can both compute the same
-- nextOrdering and both INSERT successfully, producing duplicate
-- (session_id, ordering) rows that violate the implicit invariant the
-- ORDER BY ordering reader relies on.
--
-- The existing index `idx_agent_todos_session_ordering` (added in init/13)
-- is non-unique. Promoting it to a UNIQUE constraint makes the second
-- racer's INSERT fail with check_violation 23505, which `manage_todos`
-- can surface as a tool error so the agent can retry. Better than
-- silently producing inconsistent state.
--
-- Re-applicable: skips the work if a unique constraint of any name
-- already covers (session_id, ordering).

BEGIN;

DO $$
BEGIN
  IF to_regclass('public.agent_todos') IS NULL THEN
    RAISE NOTICE 'agent_todos table not present; skipping unique-constraint addition.';
    RETURN;
  END IF;

  -- Check whether ANY unique constraint already covers exactly
  -- (session_id, ordering) on agent_todos. If yes, this migration is
  -- a no-op.
  IF EXISTS (
    SELECT 1
      FROM pg_index ix
      JOIN pg_class c   ON c.oid = ix.indexrelid
      JOIN pg_class tc  ON tc.oid = ix.indrelid
     WHERE tc.relname = 'agent_todos'
       AND ix.indisunique
       -- Cast both sides explicitly: pg_index.indkey is int2vector (PG16
       -- doesn't allow the implicit cast to int[]), and pg_attribute.attnum
       -- is smallint, so we normalise to smallint[] on both sides.
       AND string_to_array(ix.indkey::text, ' ')::smallint[] = ARRAY(
             SELECT a.attnum
               FROM pg_attribute a
              WHERE a.attrelid = tc.oid
                AND a.attname IN ('session_id', 'ordering')
              ORDER BY CASE a.attname WHEN 'session_id' THEN 1 ELSE 2 END
           )
  ) THEN
    RAISE NOTICE 'agent_todos already has a unique constraint covering (session_id, ordering); skipping.';
    RETURN;
  END IF;

  -- Add the named UNIQUE constraint via a unique index so we can use
  -- IF NOT EXISTS — Postgres lacks IF NOT EXISTS on ADD CONSTRAINT.
  CREATE UNIQUE INDEX IF NOT EXISTS agent_todos_session_ordering_uniq
    ON agent_todos (session_id, ordering);
END $$;

COMMIT;
