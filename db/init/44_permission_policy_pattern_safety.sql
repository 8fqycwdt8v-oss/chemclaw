-- Phase G hardening: defense-in-depth CHECK on
-- permission_policies.argument_pattern.
--
-- The admin route (services/agent-claw/src/routes/admin/admin-permissions.ts)
-- now runs `isPatternSafe()` on every POST so a pathological regex
-- (`(a+)+`, `[a-z]+`, etc.) is rejected at the boundary. The DB CHECK
-- here is the belt-and-braces backstop: a direct INSERT (psql script,
-- migration backfill, or a future admin route that forgets the
-- validator) still cannot install a pattern that would let a single
-- request burn the agent's pre_tool path.
--
-- Mirror: redaction_patterns enforces the same CHECK shape via
-- `redaction_patterns_no_long_pattern` (length ≤ 200 already
-- exists) plus the in-app `is_pattern_safe()` validator. We only
-- enforce the length bound here because Postgres regexp_match
-- semantics differ from JS / Python and writing a SQL-side
-- "no unbounded quantifier" check is fragile. The application-side
-- validator is the primary gate; this CHECK catches gross misuse.

BEGIN;

DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1
      FROM pg_constraint
     WHERE conrelid = 'public.permission_policies'::regclass
       AND conname = 'permission_policies_argument_pattern_max_len'
  ) THEN
    ALTER TABLE permission_policies
      ADD CONSTRAINT permission_policies_argument_pattern_max_len
      CHECK (argument_pattern IS NULL OR length(argument_pattern) <= 200);
  END IF;
END
$$;


-- Self-record for schema_version (Makefile loop is belt-and-suspenders).
INSERT INTO schema_version (filename)
VALUES ('44_permission_policy_pattern_safety.sql')
ON CONFLICT DO NOTHING;
COMMIT;
