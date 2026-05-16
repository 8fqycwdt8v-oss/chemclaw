-- Register kg_optimization_campaign as a consumer of BO round events.
-- Idempotent: the NOT (... = ANY(consumed_by)) guard prevents duplicates.
UPDATE ingestion_event_catalog
   SET consumed_by = array_append(consumed_by, 'kg_optimization_campaign')
 WHERE event_type IN (
         'optimization_round_proposed',
         'optimization_results_ingested'
       )
   AND NOT ('kg_optimization_campaign' = ANY(consumed_by));
