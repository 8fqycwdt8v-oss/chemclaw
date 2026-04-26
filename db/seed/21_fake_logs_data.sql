-- Fake LOGS — bulk-load seed for the fake_logs schema.
--
-- Idempotent: every \copy is wrapped in a TRUNCATE first so re-running this
-- file produces a clean state. Gated by the psql variable `LOGS_BACKEND` —
-- pass `-v LOGS_BACKEND=fake-postgres` from the Makefile or a CI step.
--
-- Companion fixtures: test-fixtures/fake_logs/world-default/{persons,
-- datasets,tracks,dataset_files}.csv. Regenerate via:
--
--   python -m services.mock_eln.seed.fake_logs_generator
--
-- and check the four CSV files into git so CI is hermetic.

\set ON_ERROR_STOP on

-- --------------------------------------------------------------------
-- Backend gate. The seed only loads when LOGS_BACKEND=fake-postgres so
-- production deploys pointed at a live tenant don't accidentally pollute
-- the fake schema with fixtures.
-- --------------------------------------------------------------------
\if :{?LOGS_BACKEND}
  \if :{?_skip_fake_logs}
    -- noop
  \else
    \echo 'fake_logs seed: LOGS_BACKEND='':LOGS_BACKEND'''
  \endif
\else
  \set LOGS_BACKEND ''
\endif

DO $$
BEGIN
  IF current_setting('seed.logs_backend', true) IS NULL THEN
    -- Allow callers to override via psql -v; fall back to env-derived default.
    PERFORM set_config(
      'seed.logs_backend',
      coalesce(current_setting('seed.logs_backend', true), :'LOGS_BACKEND'),
      false
    );
  END IF;
END $$;

DO $$
DECLARE
  v_backend TEXT := coalesce(current_setting('seed.logs_backend', true), '');
BEGIN
  IF v_backend NOT IN ('fake-postgres', '') THEN
    RAISE NOTICE 'fake_logs seed skipped: LOGS_BACKEND=% (only loads when fake-postgres)', v_backend;
    -- Use a sentinel temp table so the rest of this script can short-circuit.
    CREATE TEMP TABLE _fake_logs_skip(_ INT);
  END IF;
END $$;

BEGIN;

TRUNCATE fake_logs.dataset_files RESTART IDENTITY CASCADE;
TRUNCATE fake_logs.tracks RESTART IDENTITY CASCADE;
TRUNCATE fake_logs.datasets RESTART IDENTITY CASCADE;
TRUNCATE fake_logs.persons RESTART IDENTITY CASCADE;

-- The CSVs use empty strings for NULL columns — `NULL ''` keeps optional
-- columns NULL after import. Resolution-wise the path here is relative to
-- where psql is invoked from (typically the repo root via `make db.seed`).
\copy fake_logs.persons (id, username, display_name, email, metadata) FROM 'test-fixtures/fake_logs/world-default/persons.csv' WITH (FORMAT csv, HEADER true, NULL '')

\copy fake_logs.datasets (uid, name, instrument_kind, instrument_serial, method_name, sample_id, sample_name, operator, measured_at, parameters_jsonb, project_code, citation_uri, metadata) FROM 'test-fixtures/fake_logs/world-default/datasets.csv' WITH (FORMAT csv, HEADER true, NULL '')

\copy fake_logs.tracks (id, dataset_uid, track_index, detector, unit, peaks_jsonb, metadata) FROM 'test-fixtures/fake_logs/world-default/tracks.csv' WITH (FORMAT csv, HEADER true, NULL '')

\copy fake_logs.dataset_files (id, dataset_uid, filename, mime_type, size_bytes, description, uri) FROM 'test-fixtures/fake_logs/world-default/dataset_files.csv' WITH (FORMAT csv, HEADER true, NULL '')

-- Sanity counts surface in psql output so a CI run can grep for them.
DO $$
DECLARE
  v_persons INT;
  v_datasets INT;
  v_tracks INT;
  v_files INT;
BEGIN
  SELECT count(*) INTO v_persons FROM fake_logs.persons;
  SELECT count(*) INTO v_datasets FROM fake_logs.datasets;
  SELECT count(*) INTO v_tracks FROM fake_logs.tracks;
  SELECT count(*) INTO v_files FROM fake_logs.dataset_files;
  RAISE NOTICE 'fake_logs seed loaded: persons=%, datasets=%, tracks=%, files=%',
    v_persons, v_datasets, v_tracks, v_files;
END $$;

COMMIT;
