-- Knowledge-wiki projection layer — the human-readable face of the bi-temporal
-- KG. See docs/adr/012-knowledge-wiki-projection.md and
-- docs/plans/knowledge-wiki-projection.md.
--
-- Why this layer exists:
--   * Knowledge today is shredded across :Compound edges, document_chunks,
--     reactions, hypotheses, artifacts and QM results. There is no single
--     artifact a chemist (or the agent) can READ.
--   * Synthesis is re-derived every query and evaporates into chat history
--     (research_reports is the closest persisted form, but write-once,
--     per-user, unlinked, never updated).
--   * The only curation primitive is the maturity tier — an attribute on rows,
--     not an editable document a human can correct.
--
-- This file (Phase 0) lands the data model only. It is intentionally inert
-- until the Phase-1 builtins and the Phase-2 wiki_pages projector arrive — the
-- tables, RLS, triggers and event-catalog entries are the load-bearing
-- foundation everything else hangs off.
--
-- A-on-C participation: edits to a wiki page emit ingestion_events
-- (knowledge_article_created / _revised / _archived) so the future wiki_kg
-- (Neo4j :WikiPage nodes) and wiki_search_index (pgvector) projectors stay in
-- sync. The wiki pages are themselves a derived view: full rebuild is
--   DELETE FROM projection_acks WHERE projector_name IN
--     ('wiki_pages','wiki_kg','wiki_search_index')
-- and the projectors re-derive from the event log.
--
-- RLS: org-wide pages (nce_project_id IS NULL) gate on an authenticated
--      session, same posture as `compounds` / `documents`. Project-scoped
--      pages (nce_project_id IS NOT NULL) use the EXISTS user_project_access
--      pattern, same as `synthesis_campaigns`. Revisions and citations inherit
--      visibility transitively through the parent article's own RLS.

BEGIN;

-- ────────────────────────────────────────────────────────────────────────────
-- knowledge_articles — the current ("head") version of each wiki page
-- ────────────────────────────────────────────────────────────────────────────
CREATE TABLE IF NOT EXISTS knowledge_articles (
  id                  uuid         PRIMARY KEY DEFAULT uuid_generate_v4(),

  -- Stable navigation key. Convention (not CHECK-enforced — kept flexible):
  --   compound/<inchikey>          reaction-family/<rxno>
  --   project/<internal_id>        campaign/<uuid>
  --   document/<sha256-prefix>     researcher/<masked-code>
  --   topic/<slug>                 contradiction/<slug>
  --   glossary | index | log       (singletons)
  slug                text         NOT NULL UNIQUE
                                    CHECK (char_length(slug) BETWEEN 1 AND 256),

  kind                text         NOT NULL
                                    CHECK (kind IN (
                                      'compound',
                                      'reaction_family',
                                      'nce_project',
                                      'synthesis_campaign',
                                      'document_digest',
                                      'researcher',
                                      'topic',
                                      'glossary',
                                      'index',
                                      'log',
                                      'contradiction'
                                    )),

  title               text         NOT NULL CHECK (char_length(title) BETWEEN 1 AND 400),
  summary             text,        -- one-line; rendered in the `index` page
  body_md             text         NOT NULL DEFAULT '',  -- '' ⇒ stub, not yet synthesised (pair with dirty=true)

  -- For entity-backed pages: a pointer to the KG node this page summarises.
  -- {label, id_property, id_value}, e.g. {"label":"Compound","id_property":"inchikey","id_value":"RYYVLZ..."}.
  -- NULL for synthesis pages (index / log / glossary / topic / contradiction).
  entity_ref          jsonb,

  -- NULL  ⇒ org-wide page (authenticated-session gate, like `compounds`).
  -- set   ⇒ project-scoped (RLS via user_project_access).
  nce_project_id      uuid         REFERENCES nce_projects(id) ON DELETE CASCADE,

  -- Neo4j RLS parity for the :WikiPage projection (mirrors KG edge group_id).
  group_id            text         NOT NULL DEFAULT '__system__',

  maturity            text         NOT NULL DEFAULT 'EXPLORATORY'
                                    CHECK (maturity IN ('EXPLORATORY','WORKING','FOUNDATION')),

  -- Derived aggregate over cited facts (recency/tier-weighted mean). NULL ⇒
  -- not yet computed.
  confidence_score    numeric(4,3) CHECK (confidence_score IS NULL OR (confidence_score >= 0 AND confidence_score <= 1)),

  status              text         NOT NULL DEFAULT 'current'
                                    CHECK (status IN ('current','archived')),

  -- Regeneration control. The wiki_pages projector / wiki_linter cron poll for
  -- dirty=true pages; this is internal state and deliberately does NOT emit an
  -- ingestion_event when it flips (the trigger below fires only on revision /
  -- status changes).
  dirty               boolean      NOT NULL DEFAULT true,
  dirty_reason        text,        -- last triggering event_type / 'manual:created' / 'human_edit' / 'lint:stale_citation' / …

  -- Once a human revises the page, the regenerator must preserve `human:*`
  -- fenced blocks verbatim (see ADR 012 "Human edits").
  has_human_edits     boolean      NOT NULL DEFAULT false,

  source_count        int          NOT NULL DEFAULT 0 CHECK (source_count >= 0),

  revision            int          NOT NULL DEFAULT 1 CHECK (revision > 0),
  etag                bigint       NOT NULL DEFAULT 1 CHECK (etag > 0),

  created_by          text         NOT NULL,   -- entra id, or '__system__' for projector-generated
  last_edited_by      text,                    -- entra id, or '__projector__' / '__linter__'

  created_at          timestamptz  NOT NULL DEFAULT NOW(),
  updated_at          timestamptz  NOT NULL DEFAULT NOW(),

  -- Bi-temporal (consistent with `artifacts`). superseded_at set on archive.
  valid_from          timestamptz  NOT NULL DEFAULT NOW(),
  superseded_at       timestamptz                          -- NULL ⇒ current
);

COMMENT ON TABLE knowledge_articles IS
  'Wiki pages — the human-readable, citation-traced face of the bi-temporal KG '
  '(ADR 012). Auto-generated by the wiki_pages projector from KG / document / '
  'hypothesis / campaign events, plus agent- and human-authored topic pages. '
  'A derived view: rebuild via DELETE FROM projection_acks WHERE projector_name '
  'IN (''wiki_pages'',''wiki_kg'',''wiki_search_index'').';
COMMENT ON COLUMN knowledge_articles.body_md IS
  'Markdown body. Inline citations: [fact:<uuid>] [chunk:<id>] [experiment:<id>] '
  '[reaction:<id>] [hypothesis:<id>] [artifact:<id>] [document:<sha>] [article:<slug>]. '
  'Human-authoritative prose is wrapped <!-- human:begin owner=<entra-id> name=<name> --> … <!-- human:end -->; '
  'the regenerator copies those blocks through verbatim.';
COMMENT ON COLUMN knowledge_articles.dirty IS
  'A backing fact / document / hypothesis changed (or the page is a brand-new '
  'stub) and the page needs (re)synthesis. Polled by the wiki_pages projector '
  'and the wiki_linter cron. Flipping this does NOT emit an ingestion_event.';
COMMENT ON COLUMN knowledge_articles.nce_project_id IS
  'NULL ⇒ org-wide page (authenticated-session RLS gate, like `compounds`). '
  'Set ⇒ project-scoped (RLS via user_project_access).';

CREATE INDEX IF NOT EXISTS idx_knowledge_articles_kind_status
  ON knowledge_articles (kind, status);
CREATE INDEX IF NOT EXISTS idx_knowledge_articles_dirty
  ON knowledge_articles (updated_at) WHERE dirty AND status = 'current';
CREATE INDEX IF NOT EXISTS idx_knowledge_articles_project
  ON knowledge_articles (nce_project_id) WHERE nce_project_id IS NOT NULL;
CREATE INDEX IF NOT EXISTS idx_knowledge_articles_maturity
  ON knowledge_articles (maturity, kind);
-- Reverse lookup by KG node ("does compound X have a page?").
CREATE INDEX IF NOT EXISTS idx_knowledge_articles_entity_ref
  ON knowledge_articles USING gin (entity_ref jsonb_path_ops)
  WHERE entity_ref IS NOT NULL;

DROP TRIGGER IF EXISTS trg_knowledge_articles_updated_at ON knowledge_articles;
CREATE TRIGGER trg_knowledge_articles_updated_at
  BEFORE UPDATE ON knowledge_articles
  FOR EACH ROW EXECUTE FUNCTION set_updated_at();

-- ────────────────────────────────────────────────────────────────────────────
-- knowledge_article_revisions — append-only history (one row per body change)
-- ────────────────────────────────────────────────────────────────────────────
CREATE TABLE IF NOT EXISTS knowledge_article_revisions (
  id                  uuid         PRIMARY KEY DEFAULT uuid_generate_v4(),
  article_id          uuid         NOT NULL REFERENCES knowledge_articles(id) ON DELETE CASCADE,
  revision            int          NOT NULL CHECK (revision > 0),

  title               text         NOT NULL,
  summary             text,
  body_md             text         NOT NULL,

  author_kind         text         NOT NULL CHECK (author_kind IN ('agent','human','projector','linter')),
  author_entra_id     text,        -- NULL for projector / linter / agent-system authors
  agent_session_id    uuid         REFERENCES agent_sessions(id) ON DELETE SET NULL,

  change_note         text,        -- terse: 'regenerated after fact_invalidated', 'human edit', 'lint: removed stale claim'
  created_at          timestamptz  NOT NULL DEFAULT NOW(),

  CONSTRAINT knowledge_article_revision_unique UNIQUE (article_id, revision)
);

COMMENT ON TABLE knowledge_article_revisions IS
  'Append-only revision history for knowledge_articles. Never deleted (except '
  'by ON DELETE CASCADE if the parent article is hard-deleted, which the app '
  'never does — pages are archived in place).';

CREATE INDEX IF NOT EXISTS idx_knowledge_article_revisions_article
  ON knowledge_article_revisions (article_id, revision DESC);
CREATE INDEX IF NOT EXISTS idx_knowledge_article_revisions_session
  ON knowledge_article_revisions (agent_session_id) WHERE agent_session_id IS NOT NULL;

-- ────────────────────────────────────────────────────────────────────────────
-- knowledge_article_citations — per-revision citation set (provenance backbone)
-- ────────────────────────────────────────────────────────────────────────────
CREATE TABLE IF NOT EXISTS knowledge_article_citations (
  id                  uuid         PRIMARY KEY DEFAULT uuid_generate_v4(),
  article_id          uuid         NOT NULL REFERENCES knowledge_articles(id) ON DELETE CASCADE,
  revision            int          NOT NULL CHECK (revision > 0),

  cite_kind           text         NOT NULL
                                    CHECK (cite_kind IN (
                                      'fact','chunk','experiment','reaction',
                                      'hypothesis','artifact','document','article'
                                    )),
  cite_ref            text         NOT NULL CHECK (char_length(cite_ref) BETWEEN 1 AND 512),
  anchor              text,        -- optional in-body section / heading where the citation appears
  note                text,        -- optional

  created_at          timestamptz  NOT NULL DEFAULT NOW(),

  CONSTRAINT knowledge_article_citation_unique UNIQUE (article_id, revision, cite_kind, cite_ref)
);

COMMENT ON TABLE knowledge_article_citations IS
  'What each revision of a wiki page cites. The (cite_kind, cite_ref) index is '
  'the reverse lookup that lets a fact_invalidated event mark every citing page '
  'dirty, and lets query_provenance answer "which page asserts this fact".';

CREATE INDEX IF NOT EXISTS idx_knowledge_article_citations_article_rev
  ON knowledge_article_citations (article_id, revision);
-- Reverse: "which articles cite this fact / chunk / experiment / …".
CREATE INDEX IF NOT EXISTS idx_knowledge_article_citations_ref
  ON knowledge_article_citations (cite_kind, cite_ref);

-- ────────────────────────────────────────────────────────────────────────────
-- Trigger: emit ingestion_events on page create / revise / archive.
-- Fires only on revision/status changes — NOT on `dirty` toggles (which happen
-- constantly and carry no knowledge). The notify_ingestion_event trigger on
-- ingestion_events fires NOTIFY automatically.
-- ────────────────────────────────────────────────────────────────────────────
CREATE OR REPLACE FUNCTION emit_knowledge_article_event()
RETURNS TRIGGER AS $$
BEGIN
  IF TG_OP = 'INSERT' THEN
    INSERT INTO ingestion_events (event_type, source_table, source_row_id, payload)
    VALUES (
      'knowledge_article_created',
      'knowledge_articles',
      NEW.id,
      jsonb_build_object(
        'article_id',       NEW.id::text,
        'slug',             NEW.slug,
        'kind',             NEW.kind,
        'revision',         NEW.revision,
        'nce_project_id',   NEW.nce_project_id::text,
        'group_id',         NEW.group_id,
        'entity_ref',       NEW.entity_ref,
        'has_human_edits',  NEW.has_human_edits,
        'created_by',       NEW.created_by
      )
    );
  ELSIF TG_OP = 'UPDATE' THEN
    IF OLD.status = 'current' AND NEW.status = 'archived' THEN
      INSERT INTO ingestion_events (event_type, source_table, source_row_id, payload)
      VALUES (
        'knowledge_article_archived',
        'knowledge_articles',
        NEW.id,
        jsonb_build_object(
          'article_id',     NEW.id::text,
          'slug',           NEW.slug,
          'kind',           NEW.kind,
          'nce_project_id', NEW.nce_project_id::text,
          'group_id',       NEW.group_id
        )
      );
    ELSIF OLD.revision IS DISTINCT FROM NEW.revision THEN
      INSERT INTO ingestion_events (event_type, source_table, source_row_id, payload)
      VALUES (
        'knowledge_article_revised',
        'knowledge_articles',
        NEW.id,
        jsonb_build_object(
          'article_id',       NEW.id::text,
          'slug',             NEW.slug,
          'kind',             NEW.kind,
          'revision',         NEW.revision,
          'old_revision',     OLD.revision,
          'nce_project_id',   NEW.nce_project_id::text,
          'group_id',         NEW.group_id,
          'entity_ref',       NEW.entity_ref,
          'has_human_edits',  NEW.has_human_edits,
          'last_edited_by',   NEW.last_edited_by
        )
      );
    END IF;
  END IF;
  RETURN NEW;
END;
$$ LANGUAGE plpgsql;

DROP TRIGGER IF EXISTS trg_knowledge_article_event ON knowledge_articles;
CREATE TRIGGER trg_knowledge_article_event
  AFTER INSERT OR UPDATE OF revision, status ON knowledge_articles
  FOR EACH ROW EXECUTE FUNCTION emit_knowledge_article_event();

-- ────────────────────────────────────────────────────────────────────────────
-- RLS
-- ────────────────────────────────────────────────────────────────────────────
ALTER TABLE knowledge_articles            ENABLE ROW LEVEL SECURITY;
ALTER TABLE knowledge_articles            FORCE  ROW LEVEL SECURITY;
ALTER TABLE knowledge_article_revisions   ENABLE ROW LEVEL SECURITY;
ALTER TABLE knowledge_article_revisions   FORCE  ROW LEVEL SECURITY;
ALTER TABLE knowledge_article_citations   ENABLE ROW LEVEL SECURITY;
ALTER TABLE knowledge_article_citations   FORCE  ROW LEVEL SECURITY;

-- Articles: org-wide pages need an authenticated session; project-scoped pages
-- need user_project_access. FOR ALL so writes inherit the read gate.
DROP POLICY IF EXISTS knowledge_articles_access ON knowledge_articles;
CREATE POLICY knowledge_articles_access ON knowledge_articles
  FOR ALL
  USING (
    ( knowledge_articles.nce_project_id IS NULL
      AND current_setting('app.current_user_entra_id', true) IS NOT NULL
      AND current_setting('app.current_user_entra_id', true) <> '' )
    OR
    ( knowledge_articles.nce_project_id IS NOT NULL
      AND EXISTS (
        SELECT 1 FROM user_project_access upa
         WHERE upa.nce_project_id = knowledge_articles.nce_project_id
           AND upa.user_entra_id = current_setting('app.current_user_entra_id', true)
      ) )
  )
  WITH CHECK (
    ( knowledge_articles.nce_project_id IS NULL
      AND current_setting('app.current_user_entra_id', true) IS NOT NULL
      AND current_setting('app.current_user_entra_id', true) <> '' )
    OR
    ( knowledge_articles.nce_project_id IS NOT NULL
      AND EXISTS (
        SELECT 1 FROM user_project_access upa
         WHERE upa.nce_project_id = knowledge_articles.nce_project_id
           AND upa.user_entra_id = current_setting('app.current_user_entra_id', true)
      ) )
  );

-- Revisions / citations: visible iff the parent article is visible. The
-- EXISTS subquery on knowledge_articles is itself RLS-filtered (FORCE), so this
-- transitively enforces the article policy without re-deriving the project
-- logic — and naturally handles both org-wide (NULL project) and project rows.
DROP POLICY IF EXISTS knowledge_article_revisions_access ON knowledge_article_revisions;
CREATE POLICY knowledge_article_revisions_access ON knowledge_article_revisions
  FOR ALL
  USING (EXISTS (
    SELECT 1 FROM knowledge_articles ka WHERE ka.id = knowledge_article_revisions.article_id
  ))
  WITH CHECK (EXISTS (
    SELECT 1 FROM knowledge_articles ka WHERE ka.id = knowledge_article_revisions.article_id
  ));

DROP POLICY IF EXISTS knowledge_article_citations_access ON knowledge_article_citations;
CREATE POLICY knowledge_article_citations_access ON knowledge_article_citations
  FOR ALL
  USING (EXISTS (
    SELECT 1 FROM knowledge_articles ka WHERE ka.id = knowledge_article_citations.article_id
  ))
  WITH CHECK (EXISTS (
    SELECT 1 FROM knowledge_articles ka WHERE ka.id = knowledge_article_citations.article_id
  ));

-- ────────────────────────────────────────────────────────────────────────────
-- Grants
-- ────────────────────────────────────────────────────────────────────────────
DO $$
BEGIN
  IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'chemclaw_app') THEN
    -- App role: read + create + revise pages; append revisions + citations.
    -- No DELETE — pages are archived in place; revisions / citations are
    -- append-only.
    GRANT SELECT, INSERT, UPDATE ON knowledge_articles          TO chemclaw_app;
    GRANT SELECT, INSERT         ON knowledge_article_revisions TO chemclaw_app;
    GRANT SELECT, INSERT         ON knowledge_article_citations TO chemclaw_app;
  END IF;
  IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'chemclaw_service') THEN
    -- Projectors (wiki_pages / wiki_kg / wiki_search_index) and the
    -- wiki_linter cron run as chemclaw_service (BYPASSRLS).
    GRANT ALL ON knowledge_articles          TO chemclaw_service;
    GRANT ALL ON knowledge_article_revisions TO chemclaw_service;
    GRANT ALL ON knowledge_article_citations TO chemclaw_service;
  END IF;
END $$;

-- ────────────────────────────────────────────────────────────────────────────
-- Event-vocabulary catalog entries
-- ────────────────────────────────────────────────────────────────────────────
INSERT INTO ingestion_event_catalog (event_type, description, emitted_by, consumed_by) VALUES
  ('knowledge_article_created',
   'A new knowledge_articles row was inserted (a stub created by wiki_pages / '
   'request_article, or a topic page authored by the agent / a human).',
   'db/init/58_knowledge_wiki.sql (trigger trg_knowledge_article_event)',
   ARRAY['wiki_kg','wiki_search_index']),
  ('knowledge_article_revised',
   'A knowledge_articles body changed (regeneration by wiki_pages, a human '
   'PATCH, or a linter fix) — the revision counter incremented.',
   'db/init/58_knowledge_wiki.sql (trigger trg_knowledge_article_event)',
   ARRAY['wiki_kg','wiki_search_index']),
  ('knowledge_article_archived',
   'A knowledge_articles row transitioned status current → archived (the '
   'backing entity was retired). Row + revisions are retained.',
   'db/init/58_knowledge_wiki.sql (trigger trg_knowledge_article_event)',
   ARRAY['wiki_kg','wiki_search_index'])
ON CONFLICT (event_type) DO NOTHING;

-- ────────────────────────────────────────────────────────────────────────────
-- schema_version
-- ────────────────────────────────────────────────────────────────────────────
INSERT INTO schema_version (filename, applied_at)
  VALUES ('58_knowledge_wiki.sql', NOW())
  ON CONFLICT (filename) DO NOTHING;

COMMIT;
