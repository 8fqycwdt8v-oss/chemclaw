-- ChemClaw — sample data for local dev smoke test.
-- Idempotent: uses ON CONFLICT DO NOTHING.

BEGIN;

-- Two sample projects
INSERT INTO nce_projects (internal_id, name, therapeutic_area, phase, status) VALUES
  ('NCE-001', 'Sample Pyridine Kinase Inhibitor', 'Oncology', 'Discovery', 'active'),
  ('NCE-002', 'Sample CNS Agent',                 'Neurology', 'Preclinical', 'active')
ON CONFLICT (internal_id) DO NOTHING;

-- Dev user access
INSERT INTO user_project_access (user_entra_id, nce_project_id, role)
SELECT 'dev@local.test', p.id, 'admin'
  FROM nce_projects p
 WHERE p.internal_id IN ('NCE-001', 'NCE-002')
ON CONFLICT DO NOTHING;

COMMIT;
