-- 2026-05-10 review §1.5 (originally landed as 54; renumbered to 57 to avoid
-- a numbering collision with concurrently-merged 54_* migrations).
-- reactions.invalidated was added in
-- 17_unified_confidence_and_temporal.sql but is NEVER written by any
-- projector or builtin. Invalidation actually lives at the Neo4j edge
-- level: kg_hypotheses sets `invalidated_at` on :CITES edges, and
-- mcp-kg's invalidate_fact endpoint flips edge properties via Cypher.
-- The Postgres column is a misleading affordance — a developer querying
-- `reactions WHERE NOT invalidated` will get an answer that diverges
-- from what's actually in the graph.
--
-- This migration documents the column as deprecated. Dropping the
-- column is deferred (BACKLOG.md) so any unknown external consumer
-- gets one release of warning before the column disappears.
--
-- Re-applicable: COMMENT ON COLUMN replaces in place.

BEGIN;

COMMENT ON COLUMN reactions.invalidated IS
  'DEPRECATED — never written by projectors or builtins. The source of '
  'truth for reaction-fact invalidation is the Neo4j edge property '
  '`invalidated_at` on :CITES / :HAS_YIELD / :HAS_PURITY / etc. relationships. '
  'Use mcp-kg /tools/invalidate_fact to invalidate; query Neo4j to read. '
  'Scheduled to be dropped in a future migration — see BACKLOG.md.';
-- Self-record for schema_version (Makefile loop is belt-and-suspenders).
INSERT INTO schema_version (filename, applied_at)
  VALUES ('57_deprecate_reactions_invalidated.sql', NOW())
  ON CONFLICT (filename) DO NOTHING;

COMMIT;
