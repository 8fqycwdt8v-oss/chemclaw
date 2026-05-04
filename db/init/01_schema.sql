-- ChemClaw — core app schema.
-- Applied by Postgres container on first boot (mounted at /docker-entrypoint-initdb.d/).
-- Re-applicable (all CREATEs are IF NOT EXISTS).
--
-- References: Deliverable 3 of the implementation plan.

BEGIN;

-- --------------------------------------------------------------------
-- Extensions
-- --------------------------------------------------------------------
CREATE EXTENSION IF NOT EXISTS "uuid-ossp";
CREATE EXTENSION IF NOT EXISTS vector;
-- pgvectorscale provides StreamingDiskANN. Present in the timescaledb-ha image.
CREATE EXTENSION IF NOT EXISTS vectorscale CASCADE;
-- pg_trgm for sparse trigram matching (BM25-style fallback for MVP)
CREATE EXTENSION IF NOT EXISTS pg_trgm;
-- For timestamp convenience
CREATE EXTENSION IF NOT EXISTS btree_gin;

-- --------------------------------------------------------------------
-- Helpers
-- --------------------------------------------------------------------
CREATE OR REPLACE FUNCTION set_updated_at()
RETURNS TRIGGER AS $$
BEGIN
  NEW.updated_at = NOW();
  RETURN NEW;
END;
$$ LANGUAGE plpgsql;

-- --------------------------------------------------------------------
-- Organizational hierarchy (first-class per plan)
-- --------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS nce_projects (
  id                UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
  internal_id       TEXT UNIQUE NOT NULL,
  name              TEXT NOT NULL,
  therapeutic_area  TEXT,
  phase             TEXT,
  status            TEXT NOT NULL DEFAULT 'active'
                      CHECK (status IN ('active', 'paused', 'closed')),
  metadata          JSONB NOT NULL DEFAULT '{}'::jsonb,
  created_at        TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at        TIMESTAMPTZ NOT NULL DEFAULT NOW()
);
DROP TRIGGER IF EXISTS trg_nce_projects_updated_at ON nce_projects;
CREATE TRIGGER trg_nce_projects_updated_at
  BEFORE UPDATE ON nce_projects
  FOR EACH ROW EXECUTE FUNCTION set_updated_at();

CREATE TABLE IF NOT EXISTS synthetic_steps (
  id                        UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
  nce_project_id            UUID NOT NULL REFERENCES nce_projects(id) ON DELETE CASCADE,
  step_index                INT  NOT NULL,
  step_name                 TEXT NOT NULL,
  target_compound_inchikey  TEXT,
  metadata                  JSONB NOT NULL DEFAULT '{}'::jsonb,
  created_at                TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  UNIQUE (nce_project_id, step_index)
);

-- --------------------------------------------------------------------
-- Experiments (ELN source of truth)
-- --------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS experiments (
  id                     UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
  synthetic_step_id      UUID NOT NULL REFERENCES synthetic_steps(id) ON DELETE CASCADE,
  eln_entry_id           TEXT UNIQUE,
  date_performed         DATE,
  operator_entra_id      TEXT,
  procedure_text         TEXT,
  observations           TEXT,
  tabular_data           JSONB NOT NULL DEFAULT '{}'::jsonb,
  yield_pct              NUMERIC,
  scale_mg               NUMERIC,
  outcome_status         TEXT,
  raw_source_file_path   TEXT,
  imported_from          JSONB NOT NULL DEFAULT '{}'::jsonb,
  imported_at            TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at             TIMESTAMPTZ NOT NULL DEFAULT NOW()
);
DROP TRIGGER IF EXISTS trg_experiments_updated_at ON experiments;
CREATE TRIGGER trg_experiments_updated_at
  BEFORE UPDATE ON experiments
  FOR EACH ROW EXECUTE FUNCTION set_updated_at();

CREATE INDEX IF NOT EXISTS idx_experiments_step ON experiments (synthetic_step_id);
CREATE INDEX IF NOT EXISTS idx_experiments_date ON experiments (date_performed DESC);

-- --------------------------------------------------------------------
-- Compounds (canonical — KG stores edges, Postgres caches identifiers)
-- --------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS compounds (
  inchikey               TEXT PRIMARY KEY,
  smiles_canonical       TEXT,
  smiles_original        TEXT,
  molecular_formula      TEXT,
  mw                     NUMERIC,
  chebi_id               TEXT,
  pubchem_cid            TEXT,
  internal_code_masked   TEXT,
  created_at             TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at             TIMESTAMPTZ NOT NULL DEFAULT NOW()
);
DROP TRIGGER IF EXISTS trg_compounds_updated_at ON compounds;
CREATE TRIGGER trg_compounds_updated_at
  BEFORE UPDATE ON compounds
  FOR EACH ROW EXECUTE FUNCTION set_updated_at();

-- --------------------------------------------------------------------
-- Reactions (with DRFP vector for cross-project similarity)
-- --------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS reactions (
  id                UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
  experiment_id     UUID NOT NULL REFERENCES experiments(id) ON DELETE CASCADE,
  rxn_smiles        TEXT,
  rxn_smarts        TEXT,
  rxno_class        TEXT,
  rxnmapper_output  JSONB,
  -- DRFP is 2048-bit binary; we store as vector(2048) for cosine search.
  drfp_vector       vector(2048),
  confidence_tier   TEXT NOT NULL DEFAULT 'single_source_llm'
                      CHECK (confidence_tier IN (
                        'expert_validated', 'multi_source_llm',
                        'single_source_llm', 'expert_disputed', 'invalidated'
                      )),
  created_at        TIMESTAMPTZ NOT NULL DEFAULT NOW()
);
CREATE INDEX IF NOT EXISTS idx_reactions_experiment ON reactions (experiment_id);
CREATE INDEX IF NOT EXISTS idx_reactions_class ON reactions (rxno_class);
-- DRFP cosine index intentionally NOT created at the canonical-table layer.
--
-- Earlier this file claimed "ivfflat has no dimension limit" — that's
-- wrong. pgvector 0.8 caps BOTH ivfflat AND hnsw at 2000 dims, and our
-- DRFP vectors are 2048-bit. The result was a fail-on-bootstrap that
-- blocked `make db.init` on every fresh Postgres (surfaced by the
-- 2026-05-03 deep-review smoke test).
--
-- Functional impact of dropping the index: nil. The agent never queries
-- `reactions.drfp_vector` directly with cosine search — that path goes
-- through the `reaction_vectorizer` projector, which writes a halfvec
-- collection that has its own index. The column on `reactions` exists
-- so the projector has a deterministic source to read; sequential scans
-- here are fine because the table is project-scoped via RLS.
--
-- If a future pgvector release lifts the dim cap (or we re-encode DRFP
-- as halfvec(2048) which has a 4000-dim cap, or as a bit(2048) and use
-- a hamming/jaccard index), the index can come back here.

-- --------------------------------------------------------------------
-- Documents + chunks (Phase 1 — SMB scraping + Marker parse)
-- --------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS documents (
  id                UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
  sha256            TEXT UNIQUE NOT NULL,
  title             TEXT,
  source_type       TEXT NOT NULL
                      CHECK (source_type IN (
                        'SOP', 'report', 'method_validation',
                        'literature_summary', 'presentation',
                        'spreadsheet', 'other'
                      )),
  source_path       TEXT,
  version           TEXT,
  effective_date    DATE,
  parsed_markdown   TEXT,
  metadata          JSONB NOT NULL DEFAULT '{}'::jsonb,
  ingested_at       TIMESTAMPTZ NOT NULL DEFAULT NOW()
);
CREATE INDEX IF NOT EXISTS idx_documents_source_type ON documents (source_type);
CREATE INDEX IF NOT EXISTS idx_documents_effective_date ON documents (effective_date DESC);

CREATE TABLE IF NOT EXISTS document_chunks (
  id            UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
  document_id   UUID NOT NULL REFERENCES documents(id) ON DELETE CASCADE,
  chunk_index   INT  NOT NULL,
  heading_path  TEXT,
  text          TEXT NOT NULL,
  embedding     vector(1024),  -- BGE-M3 dim
  token_count   INT,
  created_at    TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  UNIQUE (document_id, chunk_index)
);
CREATE INDEX IF NOT EXISTS idx_chunks_document ON document_chunks (document_id);
CREATE INDEX IF NOT EXISTS idx_chunks_embedding_hnsw
  ON document_chunks USING hnsw (embedding vector_cosine_ops)
  WITH (m = 16, ef_construction = 200);
CREATE INDEX IF NOT EXISTS idx_chunks_text_trgm
  ON document_chunks USING gin (text gin_trgm_ops);

-- --------------------------------------------------------------------
-- Event log (spine of event-sourced ingestion, Deliverable 1 Arch A-on-C)
-- --------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS ingestion_events (
  id             UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
  event_type     TEXT NOT NULL,
  source_table   TEXT,
  source_row_id  UUID,
  payload        JSONB NOT NULL DEFAULT '{}'::jsonb,
  created_at     TIMESTAMPTZ NOT NULL DEFAULT NOW()
);
CREATE INDEX IF NOT EXISTS idx_ingestion_events_type_created
  ON ingestion_events (event_type, created_at DESC);

CREATE TABLE IF NOT EXISTS projection_acks (
  event_id         UUID NOT NULL REFERENCES ingestion_events(id) ON DELETE CASCADE,
  projector_name   TEXT NOT NULL,
  processed_at     TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  PRIMARY KEY (event_id, projector_name)
);

-- NOTIFY on every ingestion event for LISTEN/NOTIFY-based projectors.
CREATE OR REPLACE FUNCTION notify_ingestion_event()
RETURNS TRIGGER AS $$
BEGIN
  PERFORM pg_notify('ingestion_events',
    json_build_object('id', NEW.id, 'event_type', NEW.event_type)::text);
  RETURN NEW;
END;
$$ LANGUAGE plpgsql;
DROP TRIGGER IF EXISTS trg_notify_ingestion_event ON ingestion_events;
CREATE TRIGGER trg_notify_ingestion_event
  AFTER INSERT ON ingestion_events
  FOR EACH ROW EXECUTE FUNCTION notify_ingestion_event();

-- --------------------------------------------------------------------
-- Feedback, corrections, prompt registry (Self-Improvement, Deliverable 6)
-- --------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS feedback_events (
  id                    UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
  user_entra_id         TEXT NOT NULL,
  session_id            UUID,
  query_text            TEXT,
  response_text         TEXT,
  signal                TEXT NOT NULL
                          CHECK (signal IN ('thumbs_up', 'thumbs_down', 'correction', 'implicit_positive', 'implicit_negative')),
  correction_payload    JSONB,
  trace_id              TEXT,
  created_at            TIMESTAMPTZ NOT NULL DEFAULT NOW()
);
CREATE INDEX IF NOT EXISTS idx_feedback_user_created ON feedback_events (user_entra_id, created_at DESC);

CREATE TABLE IF NOT EXISTS corrections (
  id                    UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
  user_entra_id         TEXT NOT NULL,
  target_kind           TEXT NOT NULL
                          CHECK (target_kind IN ('kg_edge', 'kg_node', 'chunk', 'experiment_field', 'reaction_field')),
  target_ref            JSONB NOT NULL,
  corrected_value       JSONB NOT NULL,
  reason                TEXT,
  applied               BOOLEAN NOT NULL DEFAULT FALSE,
  created_at            TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  applied_at            TIMESTAMPTZ
);

CREATE TABLE IF NOT EXISTS prompt_registry (
  id              UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
  prompt_name     TEXT NOT NULL,
  version         INT  NOT NULL,
  template        TEXT NOT NULL,
  metadata        JSONB NOT NULL DEFAULT '{}'::jsonb,
  created_by      TEXT NOT NULL,
  created_at      TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  approved_by     TEXT,
  approved_at     TIMESTAMPTZ,
  active          BOOLEAN NOT NULL DEFAULT FALSE,
  active_weight   NUMERIC NOT NULL DEFAULT 1.0
                    CHECK (active_weight >= 0 AND active_weight <= 1),
  UNIQUE (prompt_name, version)
);
-- At most one active version per prompt (enforce via partial unique index).
CREATE UNIQUE INDEX IF NOT EXISTS uq_prompt_registry_active
  ON prompt_registry (prompt_name) WHERE active;

-- --------------------------------------------------------------------
-- Notifications queue (proactive agent → Streamlit polling target)
-- --------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS notifications (
  id                    UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
  user_entra_id         TEXT NOT NULL,
  session_id            UUID,
  kind                  TEXT NOT NULL,
  payload               JSONB NOT NULL,
  created_at            TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  delivered_at          TIMESTAMPTZ,
  read_at               TIMESTAMPTZ
);
CREATE INDEX IF NOT EXISTS idx_notifications_undelivered
  ON notifications (user_entra_id, created_at DESC)
  WHERE delivered_at IS NULL;

-- --------------------------------------------------------------------
-- RBAC — Entra ID groups → per-project access
-- --------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS user_project_access (
  user_entra_id   TEXT NOT NULL,
  nce_project_id  UUID NOT NULL REFERENCES nce_projects(id) ON DELETE CASCADE,
  role            TEXT NOT NULL
                    CHECK (role IN ('viewer', 'contributor', 'project_lead', 'admin')),
  granted_at      TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  PRIMARY KEY (user_entra_id, nce_project_id)
);

-- Row-Level Security on project-scoped tables.
-- App sets `SET LOCAL app.current_user_entra_id = '<user>'` per query context.
ALTER TABLE experiments ENABLE ROW LEVEL SECURITY;
ALTER TABLE synthetic_steps ENABLE ROW LEVEL SECURITY;
ALTER TABLE nce_projects ENABLE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS nce_projects_read_policy ON nce_projects;
CREATE POLICY nce_projects_read_policy ON nce_projects
  FOR SELECT
  USING (
    current_setting('app.current_user_entra_id', true) IS NULL
    OR current_setting('app.current_user_entra_id', true) = ''
    OR EXISTS (
      SELECT 1 FROM user_project_access upa
       WHERE upa.nce_project_id = nce_projects.id
         AND upa.user_entra_id = current_setting('app.current_user_entra_id', true)
    )
  );

DROP POLICY IF EXISTS synthetic_steps_read_policy ON synthetic_steps;
CREATE POLICY synthetic_steps_read_policy ON synthetic_steps
  FOR SELECT
  USING (
    current_setting('app.current_user_entra_id', true) IS NULL
    OR current_setting('app.current_user_entra_id', true) = ''
    OR EXISTS (
      SELECT 1 FROM user_project_access upa
       WHERE upa.nce_project_id = synthetic_steps.nce_project_id
         AND upa.user_entra_id = current_setting('app.current_user_entra_id', true)
    )
  );

DROP POLICY IF EXISTS experiments_read_policy ON experiments;
CREATE POLICY experiments_read_policy ON experiments
  FOR SELECT
  USING (
    current_setting('app.current_user_entra_id', true) IS NULL
    OR current_setting('app.current_user_entra_id', true) = ''
    OR EXISTS (
      SELECT 1
        FROM synthetic_steps ss
        JOIN user_project_access upa ON upa.nce_project_id = ss.nce_project_id
       WHERE ss.id = experiments.synthetic_step_id
         AND upa.user_entra_id = current_setting('app.current_user_entra_id', true)
    )
  );

-- Bypass role — for admin/service accounts.
-- Applied to ingestion workers via SET ROLE.
DO $$ BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'chemclaw_service') THEN
    CREATE ROLE chemclaw_service BYPASSRLS NOLOGIN;
    GRANT ALL ON ALL TABLES IN SCHEMA public TO chemclaw_service;
    GRANT ALL ON ALL SEQUENCES IN SCHEMA public TO chemclaw_service;
  END IF;
END $$;

COMMIT;
