-- Phase D.1: forged tools support.
-- Adds 'forged' as a valid source value in the tools table.
-- Idempotent: ALTER TABLE ... ADD CONSTRAINT IF NOT EXISTS is not standard;
-- we drop and re-add the constraint to safely extend the CHECK.
-- The safe pattern: add the new value to the existing constraint.

BEGIN;

-- Step 1: drop the existing CHECK constraint on tools.source so we can widen it.
-- The constraint name is derived from the CREATE TABLE in 02_harness.sql.
-- We use a DO block to handle the case where the constraint name differs.

DO $$
DECLARE
  _constraint_name text;
BEGIN
  SELECT conname
    INTO _constraint_name
    FROM pg_constraint
   WHERE conrelid = 'tools'::regclass
     AND contype = 'c'
     AND pg_get_constraintdef(oid) LIKE '%source%';

  IF _constraint_name IS NOT NULL THEN
    EXECUTE format('ALTER TABLE tools DROP CONSTRAINT %I', _constraint_name);
  END IF;
END;
$$;

-- Step 2: re-add the CHECK with the widened set that includes 'forged'.
ALTER TABLE tools
  ADD CONSTRAINT tools_source_check
  CHECK (source IN ('builtin', 'mcp', 'skill', 'forged'));

-- Step 3: ensure the scripts_path column exists (for registry load).
-- Already present in skill_library; nothing to add for the tools table itself.

-- Step 4: index on source='forged' for efficient registry load.
CREATE INDEX IF NOT EXISTS idx_tools_source_forged
  ON tools(source)
  WHERE source = 'forged';

COMMIT;
