-- Tranche 1 / C6: documentation marker for the Neo4j-side `group_id`
-- tenant scope.
--
-- The actual Cypher constraint + indexes are applied by mcp-kg at startup
-- (see services/mcp_tools/mcp_kg/cypher.py:bootstrap_cyphers and the
-- /readyz lifespan in services/mcp_tools/mcp_kg/main.py). This SQL file
-- exists so the change appears in the Postgres init sequence audit trail
-- alongside the other migrations — a future operator running `make db.init`
-- will see the marker and read the inline notes about the Neo4j-side
-- migration that needs to run in lockstep.
--
-- What lives where:
--   * Postgres (this file): documentation only.
--   * Neo4j (cypher.py):
--       - CREATE INDEX rel_group_id_lookup … FOR ()-[r]-() ON (r.group_id)
--       - Every write_fact MERGE sets r.group_id = $group_id
--       - Every query_at_time MATCH filters WHERE r.group_id = $group_id
--       - invalidate_fact MATCH adds {fact_id: $fact_id, group_id: $group_id}
--   * Backfill script: scripts/backfill_kg_group_id.py
--       - One-shot: for every Fact edge missing group_id, derive it from
--         related canonical Postgres rows (or set "__legacy__" when
--         provenance is too sparse to recover the project) and SET it.
--
-- Rollout sequence (production):
--   1. Deploy mcp-kg with `group_id` accepted (defaulted to "__system__").
--   2. Run scripts/backfill_kg_group_id.py against the live Neo4j.
--   3. Tighten rollout in a later tranche by switching projectors away from
--      "__system__" defaults and (eventually) flipping to a NOT-NULL
--      constraint.
--
-- Re-applicable: pure documentation; no DDL is executed.

BEGIN;

-- A no-op statement so this file appears in `psql --echo-all` output and the
-- schema_version row inserts cleanly. Postgres treats this as valid SQL.
SELECT 'tranche-1/c6: kg_group_id_constraint marker (see comments above)' AS migration_marker;

COMMIT;
