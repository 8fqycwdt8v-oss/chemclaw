-- 2026-05-10 review §1.6: ingestion_event_catalog.consumed_by used hyphen-cased
-- projector names ('kg-experiments', 'chunk-embedder', 'kg-documents', ...)
-- but every projector class declares an underscore-cased `name` attribute,
-- which is the value written to projection_acks.projector_name. The catalog
-- was therefore inaccurate documentation: the documented `DELETE FROM
-- projection_acks WHERE projector_name='kg-documents'` replay recipe
-- silently no-ops.
--
-- This migration normalises `consumed_by` to underscore-cased names that
-- match the projector classes' `name` attribute exactly. Re-applicable.

BEGIN;

UPDATE ingestion_event_catalog
   SET consumed_by = ARRAY(
     SELECT REPLACE(name, '-', '_')
       FROM unnest(consumed_by) AS t(name)
   )
 WHERE EXISTS (
   SELECT 1 FROM unnest(consumed_by) AS t(name)
    WHERE name LIKE '%-%'
 );

COMMIT;
