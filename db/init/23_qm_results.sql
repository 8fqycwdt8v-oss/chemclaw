-- Phase 1 — QM result persistence + cache substrate.
--
-- Foundation for the Phase 2 xTB capability expansion. Every xTB / CREST /
-- sTDA-xTB / IPEA-xTB / g-xTB invocation goes through `qm_jobs` keyed by a
-- deterministic `cache_key = sha256(method | smiles_canonical | charge |
-- multiplicity | solvent_model | canonical_json(params))`. Repeat invocations
-- short-circuit to the cached row. A trigger emits `qm_job_succeeded` so the
-- `qm_kg` projector can mint `:CalculationResult` and `:Conformer` nodes in
-- Neo4j with bi-temporal validity (`valid_from` / `valid_to`).
--
-- Chemistry is tenant-agnostic: `qm_*` rows are global-readable to
-- `chemclaw_app`; only `chemclaw_service` writes (projectors / queue workers).
-- A single permission policy `qm.recompute` allows the agent to force-bust the
-- cache on demand.
--
-- All statements are idempotent (`IF NOT EXISTS`).

BEGIN;

-- ────────────────────────────────────────────────────────────────────────────
-- 1. qm_jobs — the cache + audit log of every QM invocation
-- ────────────────────────────────────────────────────────────────────────────
CREATE TABLE IF NOT EXISTS qm_jobs (
  id                 UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
  cache_key          BYTEA NOT NULL,
  method             TEXT NOT NULL CHECK (method IN (
                       'GFN0', 'GFN1', 'GFN2', 'GFN-FF', 'g-xTB',
                       'sTDA-xTB', 'IPEA-xTB', 'CREST'
                     )),
  task               TEXT NOT NULL CHECK (task IN (
                       'sp', 'opt', 'freq', 'ts', 'irc', 'scan',
                       'md', 'metad', 'solv_sp', 'pka', 'nci', 'nmr',
                       'exstates', 'fukui', 'charges', 'redox',
                       'conformers', 'tautomers', 'protomers'
                     )),
  smiles_canonical   TEXT,
  inchikey           TEXT REFERENCES compounds(inchikey) ON DELETE SET NULL,
  charge             INTEGER NOT NULL DEFAULT 0,
  multiplicity       INTEGER NOT NULL DEFAULT 1 CHECK (multiplicity >= 1),
  solvent_model      TEXT CHECK (solvent_model IS NULL OR solvent_model IN
                       ('none', 'alpb', 'gbsa', 'cpcmx')),
  solvent_name       TEXT,
  params             JSONB NOT NULL DEFAULT '{}'::jsonb,
  status             TEXT NOT NULL DEFAULT 'queued'
                       CHECK (status IN ('queued', 'running', 'succeeded', 'failed', 'cached')),
  error              JSONB,
  started_at         TIMESTAMPTZ,
  finished_at        TIMESTAMPTZ,
  runtime_ms         INTEGER,
  host               TEXT,
  version_xtb        TEXT,
  version_crest      TEXT,
  valid_from         TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  valid_to           TIMESTAMPTZ,
  recorded_at        TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

-- Cache lookup: only one live (valid_to IS NULL) job per cache_key.
CREATE UNIQUE INDEX IF NOT EXISTS idx_qm_jobs_cache_key_live
  ON qm_jobs (cache_key)
  WHERE valid_to IS NULL;

CREATE INDEX IF NOT EXISTS idx_qm_jobs_inchikey
  ON qm_jobs (inchikey) WHERE inchikey IS NOT NULL;

CREATE INDEX IF NOT EXISTS idx_qm_jobs_method_task
  ON qm_jobs (method, task);

CREATE INDEX IF NOT EXISTS idx_qm_jobs_pending
  ON qm_jobs (recorded_at) WHERE status IN ('queued', 'running');

-- ────────────────────────────────────────────────────────────────────────────
-- 2. qm_results — per-job scalar / vector outputs
-- ────────────────────────────────────────────────────────────────────────────
CREATE TABLE IF NOT EXISTS qm_results (
  job_id             UUID PRIMARY KEY REFERENCES qm_jobs(id) ON DELETE CASCADE,
  energy_hartree     DOUBLE PRECISION,
  gnorm              DOUBLE PRECISION,
  converged          BOOLEAN,
  geometry_xyz       TEXT,
  hessian            BYTEA,
  dipole             DOUBLE PRECISION[],
  charges            JSONB,
  fukui              JSONB,
  descriptors        JSONB,
  raw_artifact_oid   OID,
  summary_md         TEXT,
  created_at         TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

-- ────────────────────────────────────────────────────────────────────────────
-- 3. qm_conformers — per-conformer rows (CREST ensembles, tautomer/protomer screens)
-- ────────────────────────────────────────────────────────────────────────────
CREATE TABLE IF NOT EXISTS qm_conformers (
  id                 UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
  job_id             UUID NOT NULL REFERENCES qm_jobs(id) ON DELETE CASCADE,
  ensemble_index     INTEGER NOT NULL,
  xyz                TEXT NOT NULL,
  energy_hartree     DOUBLE PRECISION,
  boltzmann_weight   NUMERIC(6,5),
  rmsd_to_min        NUMERIC(8,4),
  fingerprint        BYTEA,
  UNIQUE (job_id, ensemble_index)
);

CREATE INDEX IF NOT EXISTS idx_qm_conformers_job
  ON qm_conformers (job_id);

-- ────────────────────────────────────────────────────────────────────────────
-- 4. qm_frequencies — vibrational analysis output
-- ────────────────────────────────────────────────────────────────────────────
CREATE TABLE IF NOT EXISTS qm_frequencies (
  job_id             UUID NOT NULL REFERENCES qm_jobs(id) ON DELETE CASCADE,
  mode_index         INTEGER NOT NULL,
  freq_cm1           DOUBLE PRECISION,
  ir_intensity       DOUBLE PRECISION,
  raman_intensity    DOUBLE PRECISION,
  PRIMARY KEY (job_id, mode_index)
);

-- ────────────────────────────────────────────────────────────────────────────
-- 5. qm_thermo — thermochemistry summary (one row per freq job)
-- ────────────────────────────────────────────────────────────────────────────
CREATE TABLE IF NOT EXISTS qm_thermo (
  job_id             UUID PRIMARY KEY REFERENCES qm_jobs(id) ON DELETE CASCADE,
  zpe_hartree        DOUBLE PRECISION,
  h298               DOUBLE PRECISION,
  g298               DOUBLE PRECISION,
  s298               DOUBLE PRECISION,
  cv                 DOUBLE PRECISION
);

-- ────────────────────────────────────────────────────────────────────────────
-- 6. qm_scan_points — relaxed-scan output (1D / 2D)
-- ────────────────────────────────────────────────────────────────────────────
CREATE TABLE IF NOT EXISTS qm_scan_points (
  job_id             UUID NOT NULL REFERENCES qm_jobs(id) ON DELETE CASCADE,
  point_index        INTEGER NOT NULL,
  coord_value        DOUBLE PRECISION,
  energy             DOUBLE PRECISION,
  geometry_xyz       TEXT,
  PRIMARY KEY (job_id, point_index)
);

-- ────────────────────────────────────────────────────────────────────────────
-- 7. qm_irc_points — IRC trajectory (forward + reverse)
-- ────────────────────────────────────────────────────────────────────────────
CREATE TABLE IF NOT EXISTS qm_irc_points (
  job_id             UUID NOT NULL REFERENCES qm_jobs(id) ON DELETE CASCADE,
  branch             TEXT NOT NULL CHECK (branch IN ('forward', 'reverse')),
  step_index         INTEGER NOT NULL,
  coord_arc          DOUBLE PRECISION,
  energy             DOUBLE PRECISION,
  geometry_xyz       TEXT,
  PRIMARY KEY (job_id, branch, step_index)
);

-- ────────────────────────────────────────────────────────────────────────────
-- 8. qm_md_frames — molecular-dynamics / metadynamics trajectory frames (thin)
--    Heavy trajectories are stored in raw_artifact_oid on qm_results;
--    this table holds sparse summary frames for indexing + KG projection.
-- ────────────────────────────────────────────────────────────────────────────
CREATE TABLE IF NOT EXISTS qm_md_frames (
  job_id             UUID NOT NULL REFERENCES qm_jobs(id) ON DELETE CASCADE,
  frame_index        INTEGER NOT NULL,
  time_fs            DOUBLE PRECISION,
  energy             DOUBLE PRECISION,
  temperature_k      DOUBLE PRECISION,
  geometry_xyz       TEXT,
  cv_value           DOUBLE PRECISION,
  PRIMARY KEY (job_id, frame_index)
);

-- ────────────────────────────────────────────────────────────────────────────
-- 9. NOTIFY trigger: qm_job_succeeded on terminal success transition
-- ────────────────────────────────────────────────────────────────────────────
CREATE OR REPLACE FUNCTION notify_qm_job_succeeded() RETURNS TRIGGER AS $$
BEGIN
  IF NEW.status = 'succeeded' AND (TG_OP = 'INSERT' OR OLD.status <> 'succeeded') THEN
    PERFORM pg_notify('qm_job_succeeded', NEW.id::text);
  END IF;
  RETURN NEW;
END;
$$ LANGUAGE plpgsql;

DROP TRIGGER IF EXISTS trg_notify_qm_job_succeeded ON qm_jobs;
CREATE TRIGGER trg_notify_qm_job_succeeded
  AFTER INSERT OR UPDATE OF status ON qm_jobs
  FOR EACH ROW EXECUTE FUNCTION notify_qm_job_succeeded();

-- ────────────────────────────────────────────────────────────────────────────
-- 10. RLS — chemistry is global; chemclaw_app reads, chemclaw_service writes
-- ────────────────────────────────────────────────────────────────────────────
DO $$
BEGIN
  IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'chemclaw_app') THEN
    GRANT SELECT ON qm_jobs, qm_results, qm_conformers, qm_frequencies,
                    qm_thermo, qm_scan_points, qm_irc_points, qm_md_frames
      TO chemclaw_app;
  END IF;
  IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'chemclaw_service') THEN
    GRANT SELECT, INSERT, UPDATE ON qm_jobs, qm_results, qm_conformers,
                    qm_frequencies, qm_thermo, qm_scan_points,
                    qm_irc_points, qm_md_frames
      TO chemclaw_service;
  END IF;
END $$;

-- ────────────────────────────────────────────────────────────────────────────
-- 11. Permission policy — qm.recompute (force cache bust)
-- ────────────────────────────────────────────────────────────────────────────
INSERT INTO permission_policies (scope, scope_id, decision, tool_pattern, argument_pattern, reason, created_by)
  VALUES ('global', '', 'ask', 'qm_*', '"force_recompute":true',
          'Force-recompute QM results — asks for confirmation since cache busts cost CPU.',
          '__system__')
  ON CONFLICT DO NOTHING;

-- ────────────────────────────────────────────────────────────────────────────
-- 12. Schema version row
-- ────────────────────────────────────────────────────────────────────────────
INSERT INTO schema_version (filename, applied_at)
  VALUES ('23_qm_results.sql', NOW())
  ON CONFLICT (filename) DO NOTHING;

COMMIT;
