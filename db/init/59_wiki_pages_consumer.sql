-- ADR 012 Phase 2a: register the `wiki_pages` projector as a consumer of the
-- canonical-knowledge events it reacts to.
--
-- The wiki_pages projector (services/projectors/wiki_pages/main.py) keeps
-- knowledge_articles in sync with "which pages exist / need (re)synthesis":
-- on each of these events it ensures the affected entity has a page (creating
-- a `dirty` stub if missing) and marks it dirty so the Phase-2b regen loop
-- and the Phase-4 wiki_linter pick it up; on fact_invalidated it walks the
-- citation reverse-index and marks every citing page dirty.
--
-- This file runs after 35/36/38/51 (which seed/refresh these catalog rows) so
-- it appends `wiki_pages` to the existing consumer arrays without dropping
-- anyone. Idempotent: the `NOT ('wiki_pages' = ANY(consumed_by))` guard makes
-- a re-run a no-op even though 35/38/51 re-set the base arrays each `make
-- db.init` pass.

BEGIN;

UPDATE ingestion_event_catalog
   SET consumed_by = array_append(consumed_by, 'wiki_pages')
 WHERE event_type IN (
         'document_ingested',
         'experiment_imported',
         'hypothesis_proposed',
         'hypothesis_status_changed',
         'synthesis_campaign_created',
         'synthesis_campaign_state_changed',
         'fact_invalidated'
       )
   AND NOT ('wiki_pages' = ANY(consumed_by));

INSERT INTO schema_version (filename, applied_at)
  VALUES ('59_wiki_pages_consumer.sql', NOW())
  ON CONFLICT (filename) DO NOTHING;

COMMIT;
