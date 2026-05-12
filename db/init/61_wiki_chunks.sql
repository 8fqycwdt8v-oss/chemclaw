-- Knowledge-wiki search-index chunks (ADR 012 Phase 3b).
--
-- A sibling of `document_chunks` for knowledge_articles bodies: the
-- wiki_search_index projector re-chunks each article's body on every
-- knowledge_article_created/_revised event, embeds the chunks via mcp-embedder
-- (BGE-M3, 1024-dim, same as document_chunks), and DELETE-then-INSERTs them
-- here keyed to the article. Only the *current* revision's chunks are kept
-- (the projector clears the article's old chunks first), so `search_knowledge`
-- can query this table directly without a revision filter; `revision` is
-- recorded for debugging / staleness checks. `knowledge_article_archived`
-- deletes the article's chunks (drops it from the search index).
--
-- Sibling table (not a `source_type` discriminator on document_chunks) so
-- doc-only searches stay clean and the wiki backlink (article_id / slug) is
-- first-class.
--
-- RLS: visible iff the parent knowledge_articles row is visible — transitive,
-- like knowledge_article_revisions / _citations. The wiki_search_index
-- projector writes as chemclaw_service (BYPASSRLS); the agent's
-- search_knowledge reads as chemclaw_app under the caller's RLS.

BEGIN;

CREATE TABLE IF NOT EXISTS wiki_chunks (
  id            uuid         PRIMARY KEY DEFAULT uuid_generate_v4(),
  article_id    uuid         NOT NULL REFERENCES knowledge_articles(id) ON DELETE CASCADE,
  slug          text         NOT NULL,
  revision      int          NOT NULL CHECK (revision > 0),
  chunk_index   int          NOT NULL CHECK (chunk_index >= 0),
  heading_path  text,        -- e.g. "Synthetic route > Step 1 — Buchwald amination"
  text          text         NOT NULL,
  embedding     vector(1024),  -- BGE-M3 dim; NULL until the embedder fills it
  token_count   int,
  created_at    timestamptz  NOT NULL DEFAULT NOW(),

  CONSTRAINT wiki_chunk_unique UNIQUE (article_id, chunk_index)
);

COMMENT ON TABLE wiki_chunks IS
  'Search-index chunks of knowledge_articles bodies (ADR 012). Only the '
  'current revision per article is kept; the wiki_search_index projector '
  'DELETEs the article''s chunks then re-INSERTs on each revision.';

CREATE INDEX IF NOT EXISTS idx_wiki_chunks_article ON wiki_chunks (article_id);
CREATE INDEX IF NOT EXISTS idx_wiki_chunks_slug ON wiki_chunks (slug);
CREATE INDEX IF NOT EXISTS idx_wiki_chunks_embedding_hnsw
  ON wiki_chunks USING hnsw (embedding vector_cosine_ops)
  WITH (m = 16, ef_construction = 200);
CREATE INDEX IF NOT EXISTS idx_wiki_chunks_text_trgm
  ON wiki_chunks USING gin (text gin_trgm_ops);

-- ────────────────────────────────────────────────────────────────────────────
-- RLS — transitive through the parent article (FORCE-RLS'd, so the EXISTS
-- subquery is itself RLS-filtered).
-- ────────────────────────────────────────────────────────────────────────────
ALTER TABLE wiki_chunks ENABLE ROW LEVEL SECURITY;
ALTER TABLE wiki_chunks FORCE  ROW LEVEL SECURITY;

DROP POLICY IF EXISTS wiki_chunks_access ON wiki_chunks;
CREATE POLICY wiki_chunks_access ON wiki_chunks
  FOR ALL
  USING (EXISTS (SELECT 1 FROM knowledge_articles ka WHERE ka.id = wiki_chunks.article_id))
  WITH CHECK (EXISTS (SELECT 1 FROM knowledge_articles ka WHERE ka.id = wiki_chunks.article_id));

-- ────────────────────────────────────────────────────────────────────────────
-- Grants
-- ────────────────────────────────────────────────────────────────────────────
DO $$
BEGIN
  IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'chemclaw_app') THEN
    -- The app role only reads wiki_chunks (search_knowledge); the
    -- wiki_search_index projector owns the writes.
    GRANT SELECT ON wiki_chunks TO chemclaw_app;
  END IF;
  IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'chemclaw_service') THEN
    GRANT ALL ON wiki_chunks TO chemclaw_service;
  END IF;
END $$;

INSERT INTO schema_version (filename, applied_at)
  VALUES ('61_wiki_chunks.sql', NOW())
  ON CONFLICT (filename) DO NOTHING;

COMMIT;
