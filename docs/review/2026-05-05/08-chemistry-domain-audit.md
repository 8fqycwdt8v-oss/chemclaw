# Chemistry / scientific tool builtins audit (Tier 3 / A08)

Date: 2026-05-05
Branch: main
Scope: chemistry-domain builtins under `services/agent-claw/src/tools/builtins/`
Method: re-verified each finding against current `main` HEAD; only fixes that
are still applicable were applied. Cross-referenced server-side counterparts
under `services/mcp_tools/mcp_*` for contract drift; flagged-only (out of
scope per A08 rules).

## Summary

- Tools edited: 3 (`design_plate.ts`, `recommend_next_batch.ts`, `extract_pareto_front.ts`)
- Tests added: 2 (capacity-overflow, capacity-equal-OK in `design_plate.test.ts`)
- Fixes-by-category:
  - Zod cross-validation refine: 1 (`design_plate` plate_format ↔ n_wells)
  - Local shape-sanity for DB JSONB: 2 (`recommend_next_batch`, `extract_pareto_front` bofire_domain)
  - Annotations sweep: 0 missing (all 78 real builtins already declare `annotations.readOnly`)
  - SMILES pre-validation: 0 added (every SMILES path forwards to an MCP that
    validates server-side; redundant validation explicitly out of scope)
  - Stale timeout literals: 0 (synthegy-mech 270 s server vs 300 s agent confirmed correct)
- Deferrals (logged to `BACKLOG.md`):
  - etag read-and-check across recommend_next_batch's two-transaction window
  - full BoFire `Domain.model_validate` shape on the agent-side

## Per-tool status

| Tool | Status | Input-validation surface | Contract drift |
|---|---|---|---|
| `canonicalize_smiles` | clean | `smiles ≤ 10_000`, optional `kekulize`. Forwards to mcp-rdkit which canonicalizes (the validation step itself); no pre-validation needed. | none |
| `inchikey_from_smiles` | clean | `smiles ≤ 10_000`. Untracked (new file in git status); annotations + Zod schema present. | none |
| `run_xtb_workflow` | clean | Operation-tagged union; per-op SMILES limits. `ABSOLUTE_TIMEOUT_MS = (SERVER_CEILING_S + NETWORK_SLACK_S) * 1000`. Server-ceiling-aware. | none |
| `qm_single_point` / `qm_geometry_opt` / `qm_frequencies` / `qm_fukui` / `qm_redox_potential` / `qm_crest_screen` | clean | All use `_qm_base.QmRequestBase` (smiles ≤ 10k, method enum, charge int, multiplicity ≥ 1, solvent_model enum). Timeouts: 30k / 120k / 300k / 60k / 120k / 600k ms. mcp-xtb validates SMILES + xTB parameters server-side. | none |
| `compute_conformer_ensemble` | clean | `smiles ≤ 10k`, conformer caps. TIMEOUT 1830 s (CREST is slow). | none |
| `conformer_aware_kg_query` | clean | KG query; no SMILES on the hot path. | none |
| `design_plate` | **fixed** | Added `.refine()` enforcing `n_wells ≤ PLATE_CAPACITY[plate_format]` (24/96/384/1536). Server-side `designer.plate_capacity` enforces the same; we now fail fast with a Zod error instead of a 422 round-trip. Also added 2 unit tests (overflow rejected; equal-to-capacity accepted). | none |
| `start_optimization_campaign` | clean | UUID + named-fields validation; writes `bofire_domain` JSONB. | none |
| `recommend_next_batch` | **fixed** | Added `BofireDomainShape = z.record(z.unknown())` parse on the row read from `optimization_campaigns.bofire_domain`. Throws `bofire_domain_corrupt` on non-object JSONB before forwarding to the MCP. Existing tests (bofire_domain `{}` / `{type:'Domain'}`) still pass. | etag race remains (deferred: cross-txn etag check). |
| `extract_pareto_front` | **fixed** | Same `BofireDomainShape` parse; tightened `CampaignRow.bofire_domain: unknown`. Locally verified `outputs.features` extraction still typechecks. | none |
| `ingest_campaign_results` | clean | UUID + numeric outputs. | none |
| `elucidate_mechanism` | clean | SMILES limits, max_nodes ≤ 400, model enum. Description states "Ionic chemistry only — radicals and pericyclic mechanisms are not supported" (matches CLAUDE.md F.1). Agent-side `TIMEOUT_SYNTHEGY_MECH_MS = 300_000`; server-side `_SERVER_SEARCH_TIMEOUT_S = 270.0` — server fires first as required. | none |
| `score_green_chemistry` | clean | `smiles ≤ MAX_SMILES_LEN` optional. | none |
| `assess_applicability_domain` | clean | `rxn_smiles ∈ [3, MAX_RXN_SMILES_LEN]`. | none |
| `predict_yield_with_uq` | clean | Batch ≤ MAX_BATCH_SMILES, per-item ≤ MAX_RXN_SMILES_LEN. Per-project XGBoost via `_train` is RLS-scoped via `withUserContext`. | none |
| `predict_reaction_yield` | clean | Same SMILES limits. | none |
| `predict_molecular_property` | clean | Property enum, batch limit. | none |
| `identify_unknown_from_ms` | clean | MS2 peaks structure, ionization enum. | none |
| `find_similar_compounds` / `find_similar_reactions` | clean | SMILES limits + fingerprint enum. | none |
| `find_matched_pairs` | clean | `smiles ≤ 10k`. | none |
| `match_smarts_catalog` | clean | `smiles ≤ 10k`; SMARTS pulled from a catalog row. | none |
| `substructure_search` | clean | SMILES + filter limits. | none |
| `classify_compound` | clean | `smiles ≤ 10k`. | none |
| `generate_focused_library` | clean | `seed_smiles ≤ 10k` + strategy enum. | none |
| `export_to_ord` | clean | `rxn_smiles | (reactants_smiles + product_smiles)` shape. | none |
| `recommend_conditions` | clean | SMILES limits, `top_k ∈ [1, 20]`. | none |
| `propose_retrosynthesis` | clean | `smiles ≤ 10k` + iter cap. | none |

## Verifications cross-referenced (server-side, read-only)

- `mcp-yield-baseline` Bearer fan-out (services/mcp_tools/mcp_yield_baseline/main.py): `_encode_drfp_batch` and `_call_chemprop_batch` both attach `auth_headers(<service>)` from `services.mcp_tools.common.mcp_token_cache`. PR #87 fix confirmed in tree.
- `mcp-synthegy-mech` server cap: `_SERVER_SEARCH_TIMEOUT_S = 270.0` in `services/mcp_tools/mcp_synthegy_mech/main.py:64`. Agent-side TIMEOUT_SYNTHEGY_MECH_MS = 300_000 ms = 300 s. Server > 270, agent > 300 — server fires first; truncated response surfaces with a `timeout` warning. Correct ordering.
- `mcp-plate-designer` capacity: `services/mcp_tools/mcp_plate_designer/designer.py` raises `n_wells={n} exceeds plate {fmt} capacity {rows*cols}`. Agent-side refine now mirrors this, so callers get a Zod error before the request is sent.

## Annotations (DR-08) sweep

All 78 builtins under `services/agent-claw/src/tools/builtins/*.ts` excluding the
three `_*.ts` shared-helper files (`_eln_shared`, `_logs_schemas`, `_qm_base`)
declare `annotations: { readOnly: <bool> }`. No additions needed.

## Deferred (logged to BACKLOG.md)

- `[agent-claw/optim] recommend_next_batch — etag-protect campaign+rounds across the two-transaction window so a concurrent ingest_campaign_results between read and write doesn't surface a stale-snapshot surrogate.`
- `[agent-claw/optim] bofire_domain — emit a Python-side companion validator (Domain.model_validate) and call it from the optimizer MCP, returning a typed 422 instead of relying on the agent-side z.record(z.unknown()) shape check.`

## Verification

```
$ npx tsc --noEmit -p services/agent-claw
(clean)

$ npm test --workspace services/agent-claw -- tests/unit/builtins/design_plate.test.ts tests/unit/builtins/extract_pareto_front.test.ts tests/unit/builtins/optimization_campaign.test.ts
Test Files  3 passed (3)
     Tests  18 passed (18)
```

## Hard constraints honoured

- No edits outside the listed scope.
- Minimum-viable-fix; no abstractions added.
- No commits / pushes.
- No `services/mcp_tools/*` edits (Tier 4 territory).
