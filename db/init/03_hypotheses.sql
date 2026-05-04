-- ChemClaw — hypotheses tables for Phase 5A cross-project learning.
-- Canonical state for hypotheses the agent proposes; projected to Neo4j
-- by kg_hypotheses. Re-applicable (IF NOT EXISTS everywhere).

BEGIN;

CREATE TABLE IF NOT EXISTS hypotheses (
    id                        UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
    hypothesis_text           TEXT NOT NULL
        CHECK (length(hypothesis_text) BETWEEN 10 AND 4000),
    confidence                NUMERIC(4,3) NOT NULL
        CHECK (confidence BETWEEN 0.0 AND 1.0),
    confidence_tier           TEXT GENERATED ALWAYS AS (
        CASE WHEN confidence >= 0.85 THEN 'high'
             WHEN confidence >= 0.60 THEN 'medium'
             ELSE                          'low'
        END
    ) STORED,
    scope_nce_project_id      UUID REFERENCES nce_projects(id),
    proposed_by_user_entra_id TEXT NOT NULL,
    agent_trace_id            TEXT,
    status                    TEXT NOT NULL DEFAULT 'proposed'
        CHECK (status IN ('proposed','confirmed','refuted','archived')),
    created_at                TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    updated_at                TIMESTAMPTZ NOT NULL DEFAULT NOW()
);
DROP TRIGGER IF EXISTS trg_hypotheses_updated_at ON hypotheses;
CREATE TRIGGER trg_hypotheses_updated_at
  BEFORE UPDATE ON hypotheses
  FOR EACH ROW EXECUTE FUNCTION set_updated_at();

CREATE TABLE IF NOT EXISTS hypothesis_citations (
    hypothesis_id UUID NOT NULL REFERENCES hypotheses(id) ON DELETE CASCADE,
    fact_id       UUID NOT NULL,
    citation_note TEXT CHECK (length(citation_note) <= 500),
    PRIMARY KEY (hypothesis_id, fact_id)
);

CREATE INDEX IF NOT EXISTS idx_hypotheses_scope
  ON hypotheses(scope_nce_project_id) WHERE status = 'proposed';
CREATE INDEX IF NOT EXISTS idx_hypotheses_user
  ON hypotheses(proposed_by_user_entra_id);
CREATE INDEX IF NOT EXISTS idx_hypotheses_created
  ON hypotheses(created_at DESC);

ALTER TABLE hypotheses          ENABLE ROW LEVEL SECURITY;
ALTER TABLE hypothesis_citations ENABLE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS hypotheses_owner_or_scope ON hypotheses;
CREATE POLICY hypotheses_owner_or_scope ON hypotheses FOR SELECT
USING (
    proposed_by_user_entra_id = current_setting('app.current_user_entra_id', true)
    OR (
        scope_nce_project_id IS NOT NULL
        AND EXISTS (
            SELECT 1 FROM user_project_access upa
            WHERE upa.nce_project_id = hypotheses.scope_nce_project_id
              AND upa.user_entra_id  = current_setting('app.current_user_entra_id', true)
        )
    )
);

DROP POLICY IF EXISTS hypotheses_owner_insert ON hypotheses;
CREATE POLICY hypotheses_owner_insert ON hypotheses FOR INSERT
WITH CHECK (
    proposed_by_user_entra_id = current_setting('app.current_user_entra_id', true)
);

DROP POLICY IF EXISTS hypotheses_owner_update ON hypotheses;
CREATE POLICY hypotheses_owner_update ON hypotheses FOR UPDATE
USING (
    proposed_by_user_entra_id = current_setting('app.current_user_entra_id', true)
)
WITH CHECK (
    proposed_by_user_entra_id = current_setting('app.current_user_entra_id', true)
);

-- Citations inherit visibility from their parent hypothesis. PostgreSQL
-- applies RLS recursively: this policy's EXISTS subquery against
-- `hypotheses` is evaluated with the caller's RLS rules, so a citation
-- is visible iff the user can SELECT its parent hypothesis.
DROP POLICY IF EXISTS hypothesis_citations_via_parent ON hypothesis_citations;
CREATE POLICY hypothesis_citations_via_parent ON hypothesis_citations FOR ALL
USING (
    EXISTS (SELECT 1 FROM hypotheses h WHERE h.id = hypothesis_citations.hypothesis_id)
);

COMMIT;
