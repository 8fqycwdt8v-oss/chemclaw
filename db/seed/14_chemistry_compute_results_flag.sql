-- Seed: chemistry.compute_results.persist feature flag (Tranche 9).
--
-- Default OFF — the compute-result-writer post_tool hook is wired and ready,
-- but write-amplification on every chemistry tool call needs to be opted into
-- explicitly. Operators enable via:
--   PATCH /api/admin/feature-flags/chemistry.compute_results.persist
-- or per-project scope_rule once the KG fan-out projector lands.
--
-- Routes through bootstrap_feature_flag() (SECURITY DEFINER, defined in
-- db/init/22_admin_rls_bootstrap_helpers.sql) so a non-superuser migration
-- role can seed the row even though feature_flags is FORCE-RLS.

SELECT bootstrap_feature_flag(
  'chemistry.compute_results.persist',
  FALSE,
  'When true, the compute-result-writer post_tool hook persists every '
  'chemistry prediction tool output (propose_retrosynthesis, '
  'predict_yield_with_uq, predict_molecular_property, elucidate_mechanism, '
  'qm_single_point, qm_crest_screen, and friends) to the compute_results '
  'canonical store. The INSERT trigger emits a compute_result_observed '
  'ingestion event for downstream KG fan-out. Default OFF in Tranche 9 — '
  'enable per project or globally once a KG consumer projector lands.',
  '__bootstrap__'
);
UPDATE feature_flags
   SET description =
        'When true, the compute-result-writer post_tool hook persists every '
        'chemistry prediction tool output to the compute_results canonical '
        'store (compute_result_observed ingestion event). Default OFF.',
       updated_at  = NOW()
 WHERE key = 'chemistry.compute_results.persist';
