-- Phase G hardening: dedupe bioisostere_rules and add a UNIQUE
-- constraint so the seed is replay-safe.
--
-- The seed in 26_genchem.sql is `INSERT ... ON CONFLICT DO NOTHING`
-- with no conflict target. Combined with the surrogate UUID PK (which
-- never collides), every `make db.init` re-apply appended six new
-- duplicate rows to the catalog. Phase 5 generation reads
--   FROM bioisostere_rules WHERE valid_to IS NULL
-- and weights duplicate matches, distorting the sampling.
--
-- Fix:
--   1. Remove duplicate rows (keep the lowest ctid per `name`).
--   2. Add UNIQUE (name) so the seed's ON CONFLICT can target it
--      (operators re-running 26_genchem.sql after this migration get
--      idempotent-by-name semantics).
-- The seed file itself is left in place; its ON CONFLICT clause is
-- still permissive but now actually does work because of the
-- constraint added below.

BEGIN;

-- Idempotent dedupe — keep the row with the smallest ctid (the oldest
-- physical row) per `name` group; delete every other.
DELETE FROM bioisostere_rules a
 USING bioisostere_rules b
 WHERE a.name = b.name
   AND a.ctid > b.ctid;

-- Add the unique constraint. IF NOT EXISTS guard via a DO-block since
-- ALTER TABLE … ADD CONSTRAINT IF NOT EXISTS isn't accepted everywhere.
DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1
      FROM pg_constraint
     WHERE conrelid = 'public.bioisostere_rules'::regclass
       AND conname = 'bioisostere_rules_name_unique'
  ) THEN
    ALTER TABLE bioisostere_rules
      ADD CONSTRAINT bioisostere_rules_name_unique UNIQUE (name);
  END IF;
END
$$;


-- Self-record for schema_version (Makefile loop is belt-and-suspenders).
INSERT INTO schema_version (filename)
VALUES ('43_bioisostere_rules_unique.sql')
ON CONFLICT DO NOTHING;
COMMIT;
