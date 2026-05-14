-- Extend audit_row_change() coverage to canonical chemistry tables.
--
-- 19_observability.sql installed audit triggers on the agent / project
-- working set (nce_projects, synthetic_steps, experiments, agent_sessions,
-- agent_plans, agent_todos, skill_library, forged_tool_tests). It did NOT
-- cover the canonical knowledge tables. The 2026-05-08 ab-initio review
-- (`docs/review/2026-05-08/ab-initio-tools-deep-review.md` §3.8) flagged
-- the gap: silent overwrite of a hypothesis via a re-run of
-- `propose_hypothesis`, an artifact rewrite via tag-maturity, or a
-- bi-temporal close on `reactions` all leave no audit trail today. This
-- becomes more pressing once chemistry-result write paths land.
--
-- Idempotent: each trigger is DROPped before CREATE, the table-presence
-- guard prevents failure on partial init.

BEGIN;

DO $$
DECLARE
    audited_tables CONSTANT TEXT[] := ARRAY[
        'reactions',
        'hypotheses',
        'artifacts'
    ];
    t TEXT;
    trigger_name TEXT;
BEGIN
    FOREACH t IN ARRAY audited_tables LOOP
        IF EXISTS (
            SELECT 1 FROM information_schema.tables
            WHERE table_schema = 'public' AND table_name = t
        ) THEN
            trigger_name := format('audit_%s', t);
            EXECUTE format(
                'DROP TRIGGER IF EXISTS %I ON %I',
                trigger_name, t
            );
            EXECUTE format(
                'CREATE TRIGGER %I
                    AFTER INSERT OR UPDATE OR DELETE ON %I
                    FOR EACH ROW EXECUTE FUNCTION audit_row_change()',
                trigger_name, t
            );
        END IF;
    END LOOP;
END;
$$;
-- Self-record for schema_version (Makefile loop is belt-and-suspenders).
INSERT INTO schema_version (filename, applied_at)
  VALUES ('52_audit_canonical_tables.sql', NOW())
  ON CONFLICT (filename) DO NOTHING;

COMMIT;
