-- Phase Z2 — first-class condition columns on `reactions`.
--
-- Z0 wired the ASKCOS recommender; Z1 added AD + green-chemistry signals.
-- Both layers presume the agent can read historical reaction conditions out of
-- in-house data, but until now `reactions` has no condition columns: conditions
-- live as freetext in `experiments.procedure_text` and as flexible JSONB in
-- `experiments.tabular_data`. This migration promotes them to first-class
-- columns, populated by the new `conditions_normalizer` projector.
--
-- All columns are nullable + additive — no readers broken. Existing JSONB-backed
-- callers continue to work via COALESCE fallback in the consumer SQL.
--
-- Re-applicable: IF NOT EXISTS guards everywhere; the projector backfills via
-- `DELETE FROM projection_acks WHERE projector_name='conditions_normalizer'`.

BEGIN;

ALTER TABLE reactions
  ADD COLUMN IF NOT EXISTS solvent              TEXT,
  ADD COLUMN IF NOT EXISTS solvent_smiles       TEXT,
  ADD COLUMN IF NOT EXISTS catalyst_smiles      TEXT,
  ADD COLUMN IF NOT EXISTS ligand_smiles        TEXT,
  ADD COLUMN IF NOT EXISTS base                 TEXT,
  ADD COLUMN IF NOT EXISTS temperature_c        NUMERIC(5,2),
  ADD COLUMN IF NOT EXISTS time_min             NUMERIC(8,2),
  ADD COLUMN IF NOT EXISTS pressure_atm         NUMERIC(6,2),
  ADD COLUMN IF NOT EXISTS atmosphere           TEXT,
  ADD COLUMN IF NOT EXISTS stoichiometry_json   JSONB,
  ADD COLUMN IF NOT EXISTS conditions_extracted_from TEXT,
  ADD COLUMN IF NOT EXISTS extraction_status    JSONB NOT NULL DEFAULT '{}'::jsonb;

-- conditions_extracted_from is a closed enum; add the CHECK separately so
-- IF NOT EXISTS column-add is idempotent.
DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint
     WHERE conname  = 'reactions_conditions_extracted_from_check'
       AND conrelid = 'reactions'::regclass
  ) THEN
    ALTER TABLE reactions
      ADD CONSTRAINT reactions_conditions_extracted_from_check
      CHECK (conditions_extracted_from IS NULL OR
             conditions_extracted_from IN
             ('tabular_data','mock_eln_fields_jsonb','regex','llm','none'));
  END IF;
END $$;

CREATE INDEX IF NOT EXISTS idx_reactions_solvent
  ON reactions (solvent) WHERE solvent IS NOT NULL;
CREATE INDEX IF NOT EXISTS idx_reactions_temp
  ON reactions (temperature_c) WHERE temperature_c IS NOT NULL;
CREATE INDEX IF NOT EXISTS idx_reactions_extracted
  ON reactions (conditions_extracted_from);

COMMIT;
