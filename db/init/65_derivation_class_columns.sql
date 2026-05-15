-- db/init/65_derivation_class_columns.sql
--
-- Universal Knowledge Accumulation — Phase 0
-- Adds derivation_class TEXT (nullable) to existing fact-bearing tables so
-- they participate in the universal capability model. CHECK constraints are
-- created NOT VALID so historical rows don't trip the migration; new rows
-- are validated.
--
-- Also adds hypotheses.confirmed_by UUID REFERENCES facts(id). When a
-- HYPOTHESIZED claim is later confirmed by an OBSERVED measurement, a NEW
-- OBSERVED fact is emitted and the hypothesis is annotated via confirmed_by
-- (we never upgrade the hypothesis's class — bi-temporal honesty).

BEGIN;

-- reactions
ALTER TABLE reactions
  ADD COLUMN IF NOT EXISTS derivation_class TEXT;
ALTER TABLE reactions
  DROP CONSTRAINT IF EXISTS reactions_derivation_class_chk;
ALTER TABLE reactions
  ADD CONSTRAINT reactions_derivation_class_chk
  CHECK (derivation_class IS NULL OR derivation_class IN
         ('OBSERVED', 'COMPUTED', 'INTERPRETED', 'HYPOTHESIZED', 'ABSTRACTED'))
  NOT VALID;

-- hypotheses
ALTER TABLE hypotheses
  ADD COLUMN IF NOT EXISTS derivation_class TEXT;
ALTER TABLE hypotheses
  ADD COLUMN IF NOT EXISTS confirmed_by UUID REFERENCES facts(id);
ALTER TABLE hypotheses
  DROP CONSTRAINT IF EXISTS hypotheses_derivation_class_chk;
ALTER TABLE hypotheses
  ADD CONSTRAINT hypotheses_derivation_class_chk
  CHECK (derivation_class IS NULL OR derivation_class IN
         ('OBSERVED', 'COMPUTED', 'INTERPRETED', 'HYPOTHESIZED', 'ABSTRACTED'))
  NOT VALID;

-- artifacts
ALTER TABLE artifacts
  ADD COLUMN IF NOT EXISTS derivation_class TEXT;
ALTER TABLE artifacts
  DROP CONSTRAINT IF EXISTS artifacts_derivation_class_chk;
ALTER TABLE artifacts
  ADD CONSTRAINT artifacts_derivation_class_chk
  CHECK (derivation_class IS NULL OR derivation_class IN
         ('OBSERVED', 'COMPUTED', 'INTERPRETED', 'HYPOTHESIZED', 'ABSTRACTED'))
  NOT VALID;

-- compute_results (added in db/init/56_compute_results.sql)
ALTER TABLE compute_results
  ADD COLUMN IF NOT EXISTS derivation_class TEXT;
ALTER TABLE compute_results
  DROP CONSTRAINT IF EXISTS compute_results_derivation_class_chk;
ALTER TABLE compute_results
  ADD CONSTRAINT compute_results_derivation_class_chk
  CHECK (derivation_class IS NULL OR derivation_class IN
         ('OBSERVED', 'COMPUTED', 'INTERPRETED', 'HYPOTHESIZED', 'ABSTRACTED'))
  NOT VALID;

INSERT INTO schema_version (filename, applied_at)
VALUES ('65_derivation_class_columns.sql', NOW())
ON CONFLICT (filename) DO NOTHING;

COMMIT;
