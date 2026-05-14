-- db/init/62_facts_table.sql
--
-- Universal Knowledge Accumulation — Phase 0
--
-- Canonical, RLS-enforced fact store. Postgres-side mirror of the :Fact
-- nodes already maintained in Neo4j by mcp-kg and the direct-driver
-- projectors (kg_hypotheses, kg_documents, qm_kg). Going forward,
-- Postgres is the source of truth and the audit surface; the (future)
-- kg_facts_sync projector mirrors each row to a :Fact node with a
-- deterministic id (fact_id_postgres = facts.id) so Neo4j and Postgres
-- never diverge.
--
-- Every fact carries provenance back to either a canonical source row
-- (source_table + source_row_id) or to its parent facts
-- (source_fact_ids[]). Bi-temporal via valid_from / valid_to, with
-- invalidated_by (a forward pointer to the fact that replaced it) and
-- invalidation_reason for the audit trail.
--
-- See docs/plans/2026-05-14-universal-knowledge-accumulation.md §4.1.2
-- for the design rationale and the long-form column glossary.
--
-- RLS posture: SELECT is gated on project membership via the standard
-- user_project_access EXISTS pattern (mirrors db/init/03_hypotheses.sql).
-- All writes go through chemclaw_service (BYPASSRLS) — the agent never
-- INSERTs facts directly. The polarity / derivation_class / confidence
-- CHECKs encode the §3.2 fact-model invariants.

BEGIN;

CREATE TABLE IF NOT EXISTS facts (
  id                  UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
  project_id          UUID,                          -- NULL ⇒ global / shared
  subject_label       TEXT NOT NULL,                 -- e.g. 'Compound'
  subject_id_value    TEXT NOT NULL,                 -- e.g. inchikey
  predicate           TEXT NOT NULL,                 -- e.g. 'has_barrier_kJ_mol'
  object_label        TEXT,                          -- nullable for scalar objects
  object_id_value     TEXT,
  object_value        JSONB,                         -- scalar / structured value
  unit                TEXT,                          -- e.g. 'kJ/mol', '%'
  polarity            TEXT NOT NULL DEFAULT 'positive'
                      CHECK (polarity IN ('positive', 'negative', 'anomaly')),
  derivation_class    TEXT NOT NULL
                      CHECK (derivation_class IN
                             ('OBSERVED', 'COMPUTED', 'INTERPRETED',
                              'HYPOTHESIZED', 'ABSTRACTED')),
  confidence          NUMERIC(4,3) NOT NULL
                      CHECK (confidence BETWEEN 0 AND 1),
  confidence_tier     TEXT NOT NULL
                      CHECK (confidence_tier IN
                             ('foundational', 'high', 'medium', 'low',
                              'exploratory')),
  source_table        TEXT,                          -- canonical source row, if any
  source_row_id       TEXT,
  source_fact_ids     UUID[] NOT NULL DEFAULT ARRAY[]::UUID[],  -- empty for OBSERVED/COMPUTED
  extractor_name      TEXT NOT NULL,                 -- projector / hook that emitted
  derivation_depth    INT  NOT NULL DEFAULT 0
                      CHECK (derivation_depth BETWEEN 0 AND 10),
  valid_from          TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  valid_to            TIMESTAMPTZ,
  invalidated_by      UUID REFERENCES facts(id),
  invalidation_reason TEXT,
  created_at          TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  -- Mirrors Neo4j's project group; '__system__' for global facts. Kept
  -- in lockstep with the :Fact group_id by kg_facts_sync.
  group_id            TEXT NOT NULL DEFAULT '__system__'
);

COMMENT ON TABLE facts IS
  'Canonical fact store for the universal knowledge-accumulation pipeline '
  '(Phase 0). Source of truth; Neo4j :Fact nodes are mirrored by '
  'kg_facts_sync. Every row is fully traceable to a source row '
  '(source_table/source_row_id) or to parent facts (source_fact_ids[]). '
  'Bi-temporal via valid_from / valid_to.';

CREATE INDEX IF NOT EXISTS idx_facts_subject_active
  ON facts (subject_label, subject_id_value) WHERE valid_to IS NULL;
CREATE INDEX IF NOT EXISTS idx_facts_predicate_active
  ON facts (predicate) WHERE valid_to IS NULL;
CREATE INDEX IF NOT EXISTS idx_facts_class_polarity_active
  ON facts (derivation_class, polarity) WHERE valid_to IS NULL;
CREATE INDEX IF NOT EXISTS idx_facts_project_active
  ON facts (project_id) WHERE valid_to IS NULL;
CREATE INDEX IF NOT EXISTS idx_facts_source
  ON facts (source_table, source_row_id);
CREATE INDEX IF NOT EXISTS idx_facts_extractor
  ON facts (extractor_name, created_at DESC);

-- ─────────────────────────────────────────────────────────────────────
-- RLS — SELECT gated on project_id (NULL ⇒ org-wide visibility, joined
-- against user_project_access for project-scoped rows). Writes happen
-- as chemclaw_service (BYPASSRLS) via the explicit policy below;
-- chemclaw_app has no write policy → cannot INSERT/UPDATE/DELETE.
-- Note: user_project_access.nce_project_id is the join column (see
-- db/init/01_schema.sql); this table's project_id refers to the same
-- nce_projects.id space.
-- ─────────────────────────────────────────────────────────────────────
ALTER TABLE facts ENABLE ROW LEVEL SECURITY;
ALTER TABLE facts FORCE  ROW LEVEL SECURITY;

DROP POLICY IF EXISTS facts_project_visibility ON facts;
CREATE POLICY facts_project_visibility ON facts
  FOR SELECT
  USING (
    project_id IS NULL
    OR EXISTS (
      SELECT 1 FROM user_project_access upa
       WHERE upa.nce_project_id = facts.project_id
         AND upa.user_entra_id = current_setting('app.current_user_entra_id', true)
    )
  );

DROP POLICY IF EXISTS facts_service_write ON facts;
CREATE POLICY facts_service_write ON facts
  FOR ALL
  TO chemclaw_service
  USING (true) WITH CHECK (true);

-- ─────────────────────────────────────────────────────────────────────
-- Grants
-- ─────────────────────────────────────────────────────────────────────
DO $$
BEGIN
  IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'chemclaw_app') THEN
    GRANT SELECT ON facts TO chemclaw_app;
  END IF;
  IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'chemclaw_service') THEN
    GRANT ALL ON facts TO chemclaw_service;
  END IF;
END $$;

-- ─────────────────────────────────────────────────────────────────────
-- schema_version
-- ─────────────────────────────────────────────────────────────────────
INSERT INTO schema_version (filename)
VALUES ('62_facts_table.sql')
ON CONFLICT DO NOTHING;

COMMIT;
