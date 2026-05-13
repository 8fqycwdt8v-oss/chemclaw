# Chemistry Agent Feature Gap Analysis & Roadmap (2026-05-10)

Authoritative gap analysis comparing the shipped ChemClaw v1.0.0-claw +
Phases A–F.2 + 2026-05-08 synthesis-campaign cluster against the
state-of-the-art for autonomous small-molecule pharma chemistry agents
(early 2026).

The intent is to seed work-cards for the next 2–3 cycles, not to commit
implementation. Every recommendation calls out (a) what's already in
ChemClaw to avoid duplication, (b) the concrete tool/model/standard to
adopt, (c) the integration cost and dependency on existing primitives,
(d) at least one citation. Backlog entries at the end are append-ready.

## Methodology

- **Codebase inventory** — single Explore-agent pass over `services/`,
  `skills/`, `db/init/`, `hooks/`, `docs/`, `BACKLOG.md`, last 50
  commits. Confirmed 24 MCP services, 91 builtins, 20 skills, 12
  projectors, 16 lifecycle hook points, BoFire-backed BO already wired
  through `mcp_reaction_optimizer`, ORD I/O via `mcp_ord_io`, plate
  designer, synthesis-campaign DAG, forge_tool, DSPy GEPA optimizer,
  bi-temporal KG with confidence tiers and maturity gates.
- **External landscape** — 6 parallel research streams:
  chemistry foundation models, lab informatics + analytical
  ecosystem, process chemistry / DoE / PAT, ADMET / PK / HTE /
  PROTACs / SDLs, SOTA chemistry agents, analytical-chemistry
  deep-dive. Each stream targeted ≥15 web searches plus targeted
  fetches against arxiv / RSC / Nature / vendor docs. May 2026 cutoff.
- **De-duplication pass** — every external candidate cross-checked
  against the inventory. Items already shipped (BoFire, ORD I/O,
  green_chemistry, plate_designer, synthesis-campaign DAG, ChemProp,
  AskCos, AiZynth, SIRIUS, synthegy, ELN/LOGS adapters, deep_research
  + cross_learning skills, DSPy GEPA, forged tools) are explicitly
  *not* re-proposed.

## What's already strong (do not re-propose)

| Capability | Where it lives | Why it counts |
|---|---|---|
| Bi-temporal KG with explicit confidence tiers | `db/init/17_unified_confidence_and_temporal.sql`, `mcp_kg`, projectors | Beats Phoenix/Coscientist on "facts that can change over time" |
| A-on-C event-sourced ingestion | trigger on `ingestion_events`, `BaseProjector` | Replayable, audit-friendly, multi-projector — already the right substrate for everything below |
| Synthesis-campaign DAG with `bo_or_die` gate | `db/init/51_synthesis_campaigns.sql`, 7 builtins, `synthesis_campaign_orchestrator` skill | Covers single_experiment / library / screening / bo_campaign / bo_or_die — the right umbrella for autonomous loops |
| Bayesian optimization | `mcp_reaction_optimizer` (BoFire), `optimization_campaigns` | Already ships closed-loop campaigns; gaps are in *which* BO variant, not *whether* BO |
| Forged tools with validation runs | `forge_tool`, `induce_forged_tool_from_trace`, `forged_tool_validation_runs` | The right substrate for tenant-specific chemistry tools |
| Multi-model routing through LiteLLM with redaction | `services/litellm/`, `litellm_redactor` + `redaction_patterns` table | Single egress, defense-in-depth redaction, tenant-overridable |
| Persistent agent sessions + plans + todos + ask_user + reanimator | `agent_sessions`, `agent_plans`, `agent_todos`, `session_reanimator` | Cross-turn memory and human-in-the-loop already plumbed |
| RBAC + audit + RLS + admin endpoints | `admin_roles`, `audit_log`, `error_events`, `current_user_is_admin()` | Compliance scaffolding mostly done; the remaining gap is GxP attestation, not access control |
| MCP Bearer-token auth, fail-closed in dev | `mcp-tokens.ts`, `mcp_tools/common/app.py` | Phase-7 auth is solid; resume path uses signed claims, not header forgery |
| Lifecycle hooks (16 points) with permission aggregator | `core/hook-loader.ts`, `core/permissions/resolver.ts` | The natural place to attach every guardrail/gate proposed below |

## High-level findings

The **engineering foundations are mature**; the gaps are mostly in
**chemistry-domain breadth** (modalities, analytical depth, regulatory
output) and in **agent-engineering polish** (uncertainty propagation,
tool-RAG, reflexion, cross-session memory). Three structural themes
recur across all 6 research streams:

1. **Boltz-2 has changed the SBDD/FEP cost equation.** A single MIT-licensed
   model gives joint protein-ligand structure + binding affinity at near
   FEP-quality, ~20 s/GPU. Almost every proposed downstream design loop
   benefits. Single biggest leverage point.
2. **The "automated impurity ID + automated structure verification" pair
   is the highest-value pharma analytical workflow** that ChemClaw can
   ship. Open SOTA exists for both (SEISMiQ + SIRIUS for impurity ID;
   CASCADE-2.0 + DP4-AI + NMR-Solver for structure verification).
   Neither is in the platform today.
3. **Regulatory-grade outputs need a small, focused investment.** ICH M7
   classification, GHS gating, CWC/DEA/EAR pre-screen, eCTD M3 mapping,
   and a human-attestation event layer would make ChemClaw deployable
   into GxP-adjacent contexts that competitors aren't ready for.

## Roadmap by horizon

Cost rubric: **S** ≤ 1 sprint (mostly Python wrapper or hook), **M** =
1–2 sprints (new MCP service + projector), **L** = ≥ 1 quarter (vendor
license, GPU cluster, or new product surface).

### Horizon 0 — quick wins (≤ 1 sprint each)

| # | Capability | What to add | Cost | Why now |
|---|---|---|---|---|
| 0.1 | Multi-objective BO in BoFire campaign | qNEHVI + qParEGO across (yield, impurity, PMI, cost) on `optimization_campaigns`; add `objective_directions[]` column | S | BoFire is already wired; single-objective is the only missing knob; every existing campaign benefits |
| 0.2 | Route-scoring vector | Combine SAScore (RDKit-built-in) + SCScore + RAscore + iGAL + PMI on every retrosynth result; new column on `synthesis_campaign_steps` | S | Currently retrosynth is yield-only-ranked; no green/synthesizability signal at decision time |
| 0.3 | Solvent-greenness builtin | Merged CHEM21+GSK+Pfizer table + Hansen δ nearest-neighbour green-substitute via HSPiPy | S | Existing `mcp_green_chemistry` covers Bretherick hazard; greenness selection is the missing complement |
| 0.4 | PubChem GHS pre-screen | `pubchem_ghs_lookup` builtin → tool returns hazard-statement codes for any compound; wire into `pre_tool` so dangerous syntheses flag | S | Free, public, deterministic; turns into the easiest win for safety review |
| 0.5 | OPSIN name → structure builtin | Wrap OPSIN (Java jar via py4j or REST microservice) — closes the literature-name → SMILES gap | S | Currently agent struggles when a paper cites a compound by name only |
| 0.6 | Conformal prediction wrapper for numeric tools | Decorator around `predict_yield_with_uq` / `predict_molecular_property` / `qm_*` outputs that emits calibrated `prediction_interval` at user-chosen coverage | S | Replaces the ordinal `confidence_tier` with statistically composable intervals; needed for SAUP-style propagation through `manage_todos` chains |
| 0.7 | Reflexion `post_turn` hook | Single `post_turn` registrar that asks an LLM judge to write a critique into `agent_sessions.scratchpad`; gated by config_settings | S | Documented +3-8pt accuracy uplift on multi-step tasks; trivial to ship; subsumes the future `/check` slash verb's intent |
| 0.8 | Tool-RAG over MCP registry | Embed every tool's `description` once at startup; `pre_turn` hook returns top-k tools per turn instead of full registry | S | 30+ tools today bloat every prompt; documented 3× accuracy + ½ prompt cost lift |
| 0.9 | CWC + DEA + EAR Cat 1C SMARTS gate | `pre_tool` permission policy that intercepts SMILES against CWC Schedule-1 substructures + DEA + EAR Cat 1C lists | S | One week to ship, hard checkbox requirement for pharma sales, no competitor bundles it |
| 0.10 | Atlas / EDBO+ as alternate optimizer backend | New backend behind `mcp_reaction_optimizer` for mixed continuous/categorical/constrained spaces (catalysts, ligands) | S | BoFire's BoTorch backend mis-fits categorical reaction-condition spaces; EDBO+ is the documented winner there |
| 0.11 | Chemprop v2 + ADMET-AI 41-endpoint upgrade | Bump existing `mcp_chemprop` to v2 (~2× speed, 3× memory) and add ADMET-AI weights for the full TDC panel | S | Existing tool, version bump unlocks a whole panel of properties |
| 0.12 | Hardcoded ICH Q3A/Q3B/M7 thresholds in `config_settings` | Make ICH thresholds tenant-overridable rather than hardcoded; agent reads from the registry | S | Same pattern as the existing config registry; needed for any impurity work |

Horizon-0 collectively lands the "agent-engineering polish" backlog and
the cheap chemistry-data hooks.

### Horizon 1 — strategic wins (4–8 weeks each)

| # | Capability | What to add | Cost | Why this cycle |
|---|---|---|---|---|
| 1.1 | **Boltz-2 MCP** (`mcp_boltz`) | New chemistry-profile service running Boltz-2 with `cofold_and_score(target, ligand)` returning complex + affinity + confidence; GPU container | M | Single biggest leverage point identified across all six research streams; replaces hours of FEP per perturbation |
| 1.2 | **Automated impurity-ID skill** (`impurity_id_agent`) | New skill packaging SIRIUS (existing) + new `mcp_seismiq` + `mcp_cfmid` + Lhasa Derek/Sarah ICH-M7 wrap; orchestrates parallel formula+structure inference, votes, runs M7 | M | The #1 named pharma analytical pain point; SEISMiQ is open and explicitly designed for ≤0.1% drug-substance impurity ID |
| 1.3 | **Automated structure verification skill** (`verify_structure`) | New skill: `mcp_nmr_predict` (CASCADE-2.0 + DP4-AI scoring) + NMR-Solver fallback for de novo + LLM-as-judge re-rank on HSQC images; consumes 1H/13C/HSQC/HRMS | M | The #2 named pharma analytical pain point; CASCADE-2.0 is sub-ppm and 1 s/molecule |
| 1.4 | **Allotrope ASM ingest** | Hard-pin `allotropy` (MIT, Benchling-Open-Source) inside `mcp_logs_sciy`; parse vendor outputs to ASM JSON; new `asm_lc_runs` / `asm_ms_runs` / `asm_nmr_runs` projector chain | M | Strategic data-shape bet; replaces per-vendor parsers; lets future Benchling Connect / Empower / Chromeleon data feed the same projectors |
| 1.5 | **Reaction calorimetry + thermal hazard pre-screen** | `mcp_thermal_hazard` ingesting RC1mx export → MTSR / T_D24 / Stoessel criticality 1-5; CHETAH + Bretherick + CAMEO rule layer; wired into `pre_tool` for `start_synthesis_campaign` (block on red) | M | Required for any agent that proposes a scale-up; CHETAH-style group-additivity is well-bounded ML |
| 1.6 | **PAT in-situ ingest + closed loop** | `mcp_pat` adapter for ReactIR / MATRIX-MF FT-IR via OPC-UA; new `pat_events` partitioned table + `pat_spectrum` projector; closed loop into `advance_synthesis_campaign` | M | Currently `mcp_logs_sciy` covers offline analytics only; streaming spectra are the missing PAT primitive |
| 1.7 | **MERMaid PDF mining → ORD reactions projector** | Run MERMaid (87% end-to-end accuracy on chemistry PDFs) over Marker output; emit ORD-shaped reactions via existing `mcp_ord_io`; projector populates KG | M | Marker only gives text/figures today; getting structured reactions out of PDFs multiplies KG enrichment value per paper |
| 1.8 | **Forced-degradation pathway prediction** | Open `mcp_degradant_proposer` (~200 RDKit reaction SMARTS for canonical pathways) + Lhasa Zeneth REST adapter as the regulated-output path | M | Complements 1.2 (predicted degradants narrow SEISMiQ search dramatically); ICH Q1 stability work needs this |
| 1.9 | **Reaction-monitoring / MVDA model service** | `mcp_chemometrics` exposing `build_chemometric_model(method, target)` and `score_batch_against_golden(batch_id, golden_id)` returning Hotelling T² + DModX + contribution plot; scikit-learn + pyChemometrics initially | M | Companion to 1.6; PAT streams are useless without chemometric models on top |
| 1.10 | **Mem0-style cross-session memory projector** | New projector consuming `ingestion_events` + agent turn outcomes; emits compact memory chunks into a `agent_memories` table that the harness retrieves at `pre_turn` | M | 91% latency / 90% token reduction documented; fits the event-sourced pattern verbatim; closes the missing "what we tried last week" recall |
| 1.11 | **OpenChemIE + DECIMER 2.5 reaction-figure extraction** | Post-processor on `mcp_doc_fetcher` that walks paper figures with DECIMER (structures) and RxnScribe (reaction diagrams); feeds 1.7 | M | Often paired with MERMaid; DECIMER 2.5 is the modern OSCR front-runner |
| 1.12 | **Polymorph-risk pack** | `mcp_polymorph` wrapping CCDC CSD Python API for HBP + scaffold lookup; FastCSP integration as opt-in heavy track via UMA NNP container | M (CSD), L (FastCSP) | Late-stage pharma failure mode (ritonavir Form II); CSD covers the cheap retrieval tier first, FastCSP later |
| 1.13 | **REINVENT 4 un-stub** | The currently 501-stubbed REINVENT endpoint in `mcp_genchem` is Apache-2.0; bundle the model + scoring-plugin contract | S/M | Already 80% in place (scaffold_decorate / bioisostere / fragment_grow are wired); just the RL-mode endpoint is missing |
| 1.14 | **g-xTB un-stub or remove** | Either bundle Grimme g-xTB binary (license dependency) or delete the placeholder endpoint to avoid silent fallback to GFN2 | S | Existing 501 stub is a product surface that promises functionality the platform can't deliver |

### Horizon 2 — quarter-scale bets (2026-Q3 → Q4)

| # | Capability | Why this cycle, not later |
|---|---|---|
| 2.1 | OpenFE alchemical-FEP MCP | Open-source FEP+ replacement (1.73 kcal/mol blinded RMSE on 15-pharma 1700-ligand benchmark, 2025); needed for Boltz-2 confirmation tier |
| 2.2 | MACE-OFF23 / MACE-MP-0 / AIMNet2 NNP service | Replace GFN2-xTB hot-path for organic conformer search and NNP-MD; AIMNet2 covers the salt/charged-species regime where MACE-OFF doesn't |
| 2.3 | Syntheseus + Chimera retrosynth router | Wraps a dozen single-step models behind one Python API; instant ensembling alongside AskCos/AiZynth; the right pattern is "router" not "more models" |
| 2.4 | SynFormer (synthesizable-by-construction generator) | Replaces several REINVENT modes with output that's by-construction synthesizable; complement to the existing AskCos/AiZynth path |
| 2.5 | Uni-pKa + AIMNet2-charged for ionization-aware predictions | Foundation for ionization-aware logD, formulation, dissolution prediction |
| 2.6 | Open MS/MS de novo skill stack (MIST + MIST-CF + DreaMS) | Redundancy + fallback for SIRIUS; useful when SIRIUS underperforms |
| 2.7 | Stability-modeller (`mcp_stability`) | Open ASAPprime-style isoconversion-time + moisture-modified Arrhenius; ~2 weeks of scipy work, immediate fit with stability campaigns |
| 2.8 | GNINA covalent docking + warhead reactivity QM/ML hybrid + LRE metric | Covalent inhibitors are strategically central (KRAS, BTK, EGFR-TKI); medchem teams currently lack dock + reactivity + LRE in one place |
| 2.9 | PROTAC workflow (DiffPROTACs / SynPROTAC + PRosettaC + oral-rule gate) | Modality-specific; full pipeline currently fragmented across 4+ separate tools/papers |
| 2.10 | DEL projector (deldenoiser) | If a tenant brings DEL data, projector pattern is the right substrate; ML-on-raw-counts misclassifies > 90% of "binders" without it |
| 2.11 | Powder XRD / Rietveld driver (Spotlight + GSAS-II) | Solid-form characterization gap; agent can autonomously call Rietveld during polymorph screens |
| 2.12 | CMC evidence-pack generator | Q8 design-space contour + Q9 FMEA + impurity rationale + PAT/RTRT bundle into a `cmc_evidence_packs` table; new `agent.cmc_author` prompt mode |
| 2.13 | Human-attestation event + signed audit row | FDA/EMA Joint AI principles (Jan 2026) require a responsible person to confirm AI-aided decisions; trivial schema add, hard new requirement |
| 2.14 | POPPER-style sequential-falsification skill with FDR control | Closes the missing "abductive verification" leg for the existing `hypotheses` table |
| 2.15 | Phoenix-equivalent skill pack (prior-art / cost / outcome) | Direct competitive parity with FutureHouse Phoenix + Owl; small wrapper around tools the platform mostly already has |

### Horizon 3 — watch list

These are credible but currently lower leverage than the H0–H2 set; revisit each release.

- **OPC-UA LADS** as a SiLA 2 successor for instrument wire format (gaining vendor traction; not winning yet).
- **CMC Process Ontology Phase 3 (Pistoia, 2026)** — the place a real cross-pharma CMC vocabulary will land; align vocabulary cheap, late re-alignment expensive.
- **Helicone proxy in front of LiteLLM** as observability fallback + per-tenant tracer routing (defense-in-depth; useful for EU/CN data-residency tenants).
- **Code-acting harness mode (smolagents-style)** — composes tools in single Python blocks, gated behind `harness_mode` config; orthogonal to the current ReAct loop.
- **Vision anomaly + reaction-state CV** ingestion pipeline for SDL deployments; differentiates from desk-only agents but only matters once a tenant has cameras on the bench.
- **OpenAlex expert-finder + Owl-style prior-art gate** before launching costly campaigns.
- **ChemReasoner-style QM/GNN reward loop** — couple `mcp_xtb` and `mcp_synthegy_mech` to the optimizer as reward sources, not just query-time tools.
- **Sakana-style "write-it-up" output mode** for synthesis campaigns; the audit trail already collected is most of what's needed.
- **Voice + multimodal interface (LabVoice-style)** for bench scientists.
- **FedLLM cross-tenant federated learning** for CRO ↔ sponsor IP separation.

## Cross-cutting architectural recommendations

These transcend any single capability and should be decided once.

1. **Adopt ASM (Allotrope Simple Model) JSON as the canonical analytical-data shape inside ChemClaw**, not just on the wire. Bi-temporal KG should have first-class projectors for `ASM-LC`, `ASM-MS`, `ASM-NMR`, `ASM-PlateReader`. Vendor-specific schemas live as adapters at the ingestion edge only. Consequence: every analytical MCP added below targets ASM as its native output shape.
2. **Keep ORD as the canonical reaction shape for export/import** (already shipped via `mcp_ord_io`); add ASM as the analytical companion. The two together cover ~95% of FAIR-publishable chemistry artifacts.
3. **Keep RDKit `MolStandardize` + Standard InChIKey as the canonical compound key** (already the codebase convention). When integrating an external registry (CDD Vault, ChemAxon, Dotmatics Register), the agent should *propose* a structure and let the registry's own rules decide acceptance — never overwrite a tenant's corporate ID logic.
4. **Treat ICH thresholds (Q3A/Q3B/M7), CWC schedules, DEA controls, and EAR Cat 1C lists as data, not code.** Push them into `config_settings` so they're auditable and tenant-overridable. Same model already used for runtime config and feature flags.
5. **Add a `gpu-chemistry` docker-compose profile** above the existing `chemistry` profile. Boltz-2, GenMol, REINVENT 4, FastCSP, MACE-OFF23, NNP-MD, PocketGen all need GPU containers; the existing `chemistry` profile mixes CPU and GPU which fights resource limits.
6. **Confidence tier → conformal prediction interval transition.** The 5-tier ordinal (`EXPERT_VALIDATED`/`MULTI_SOURCE_LLM`/`SINGLE_SOURCE_LLM`/`EXPERT_DISPUTED`) is great for KG facts but useless for numeric tool outputs. Wrap every numeric MCP tool with conformal-prediction calibration so the agent can compose intervals through `manage_todos` chains. Keep the tier system for evidence-class facts.
7. **Tool-registry → tool-RAG.** With 91 builtins and ~30 active MCPs, every prompt currently lists too many tools. Tool-RAG over the registry (item 0.8 above) should land before Horizon 1 lands more tools, not after — otherwise the new chemistry MCPs make the prompt explosion worse.
8. **Lifecycle-telemetry → lifecycle-instrumentation.** The 9 stub telemetry handlers added in Cluster F (2026-05-08) are placeholders. Replace each in turn with the right substantive behaviour as it becomes the bottleneck (Langfuse session emit, OTel span event, audit row, Slack notification, etc.). Don't add a new lifecycle point without a concrete handler.
9. **Boltz-2 should land alongside, not after, OpenFE.** Boltz-2 is the cheap-and-fast triage tier; OpenFE is the FEP-grade confirmation tier. Shipping only one yields a strictly worse design loop than shipping both staggered by one cycle. H1.1 → H2.1 is the right order.
10. **CMC evidence-pack generator (H2.12) should reuse existing audit/permission infrastructure.** A new `cmc_evidence_packs` canonical table + `agent.cmc_author` prompt-registry mode + `appendAudit` on every state-mutating branch. Do not invent a new RBAC surface for it.

## Detailed feature cards

For each Horizon-0 / Horizon-1 item, the work-card to draft into a real plan when scheduled.

### H0.1 — Multi-objective BO in BoFire
- **Already**: `mcp_reaction_optimizer` exposes BoFire single-objective campaigns; `optimization_campaigns` and `optimization_rounds` tables in place.
- **Add**: `objective_directions[]` column on `optimization_campaigns`; backend selects qNEHVI for ≥2 objectives; PROD-grade defaults from BoFire MO docs.
- **Test surface**: 1 unit test per acquisition function, 1 integration test that runs a 3-round 2-objective campaign on a hermetic simulator.
- **Risk**: per-step latency rises; cap to 3 active objectives initially.

### H0.4 — PubChem GHS pre-screen
- **Already**: `mcp_rdkit` for InChIKey computation.
- **Add**: `pubchem_ghs_lookup(inchikey | smiles)` builtin that GETs `/rest/pug_view/data/compound/{cid}/JSON?heading=GHS+Classification`; cache hits in a `pubchem_ghs_cache` table.
- **Hook**: `pre_tool` for `start_synthesis_campaign` — if any compound carries H300/H310/H330/H350/H360 codes, surface as a hard `ask` decision (not deny — agent may legitimately work with such compounds with attestation).
- **Risk**: rate-limit on the public PubChem API; cache-first.

### H0.6 — Conformal prediction wrapper
- **Already**: `predict_yield_with_uq` returns yield + uncertainty; `assess_applicability_domain` exists.
- **Add**: a Python decorator `@with_conformal(coverage=0.9)` in `services/mcp_tools/common/`. Calibration set is the projector-derived `prediction_calibration` table populated nightly from validated experiments.
- **Surface**: every numeric tool returns `{value, ci_low, ci_high, coverage}` instead of `{value, std}`.
- **Composition**: SAUP-style propagation across `manage_todos` chains is a follow-up; landing the wrapper first is the prerequisite.

### H0.9 — CWC + DEA + EAR Cat 1C SMARTS gate
- **Already**: `permission_policies` table + `permission` aggregator.
- **Add**: `services/agent-claw/src/security/scheduled-substances.ts` carrying SMARTS for CWC Schedule-1 substructures (curated from public OPCW Schedule-1 list), DEA Schedule I-V controlled substances (curated), EAR Cat 1C exports (chemicals/microorganisms/toxins).
- **Hook**: `pre_tool` policy for `start_synthesis_campaign`, `propose_retrosynthesis`, `generate_focused_library`. Decision is `deny` for Schedule-1 by default; tenant policy can override to `ask` with attestation.
- **Risk**: false-positive denials block legitimate chemistry. Mitigation: every denial logs to `error_events` with the matched SMARTS so policies can be tuned.

### H1.1 — Boltz-2 MCP
- **Already**: `chemistry` docker-compose profile; `mcp_xtb` and `mcp_sirius` are the closest neighbours architecturally.
- **Add**: `services/mcp_tools/boltz/` with `cofold_and_score(target_seq | target_pdb, ligand_smiles | ligand_sdf)` returning `{complex_pdb, predicted_kd_nm, confidence, atom_level_attention}`. New `gpu-chemistry` compose profile gates the service by GPU presence.
- **Builtins**: `cofold_target_ligand`, `score_ligand_affinity_boltz2`.
- **Skill**: extend `closed-loop-optimization` to call Boltz-2 for affinity prediction in design-make-test loops where binding is the objective.
- **Risk**: GPU-only; first deployment requires a real GPU host. License (MIT) is permissive but model weights pull is large (~5 GB).

### H1.2 — Automated impurity-ID skill (`impurity_id_agent`)
- **Already**: `mcp_sirius` for MS structure ID; `identify_unknown_from_ms` builtin; `sirius_id` skill.
- **Add**:
  - `services/mcp_tools/seismiq/` wrapping the open SEISMiQ transformer with `identify_drug_substance_impurity(ms2_spectrum, parent_smiles, formula_hint?, substructure_hints?)`.
  - `services/mcp_tools/cfmid/` wrapping CFM-ID 4 for in-silico MS/MS reference spectra.
  - `services/mcp_tools/lhasa_nexus/` adapter for Derek + Sarah (file-drop interface; vendor license required).
  - `skills/impurity_id_agent/` orchestrating: SIRIUS → CFM-ID re-rank → SEISMiQ de novo → Derek+Sarah ICH-M7 → LLM judge → final SMILES + uncertainty.
- **Storage**: new `impurities` canonical table linked to `reactions` and `mock_eln.entries`.
- **Risk**: vendor license latency for Lhasa; ship the open-source path (SEISMiQ + SIRIUS + CFM-ID) standalone first.

### H1.3 — Automated structure verification skill (`verify_structure`)
- **Already**: `mcp_xtb` for QM conformers; `compute_conformer_ensemble`; `query_instrument_runs`/`fetch_instrument_run` for NMR data via `mcp_logs_sciy`.
- **Add**:
  - `services/mcp_tools/nmr_predict/` exposing CASCADE-2.0 forward shift prediction + DP4-AI scoring.
  - `services/mcp_tools/nmr_solver/` for the de novo fallback (Docker image already published; large DB so set up object storage).
  - `skills/verify_structure/` orchestrating: extract NMR/HRMS from `mcp_logs_sciy` → run CASCADE-2.0 forward → compute DP4 against proposed structure → if DP4 < threshold, fall back to NMR-Solver de novo → LLM-as-judge HSQC re-rank.
- **Output**: `structure_verifications` table with `(reaction_id, proposed_smiles, dp4_score, verdict, evidence_chunk_ids)` consumable by the existing `confidence_score` machinery.
- **Risk**: NMR-Solver needs ~373 GB FAISS index in object storage; for first deployment limit to CASCADE+DP4 only and queue NMR-Solver as a follow-up.

### H1.4 — Allotrope ASM ingest
- **Already**: `mcp_logs_sciy` with `fake-postgres` and `real` (NotImplementedError) backends.
- **Add**: `allotropy` (MIT, Benchling-Open-Source) as a hard dependency in `mcp_logs_sciy`; converters wired for the priority adapters (Chromeleon LC, Empower beta, AppliedBio QuantStudio, Roche Cedex). New canonical tables `asm_lc_runs`, `asm_ms_runs`, `asm_nmr_runs`, `asm_plate_reader_runs` with JSON columns + key-extracted indexed fields.
- **Projector**: `asm_kg_projector` derives KG nodes/edges per ASM model; idempotent on `(adapter, ext_id, ingestion_time)`.
- **Risk**: schema-version mismatches between vendor outputs and ASM publishers — validate every ingest, route mismatches to backlog, never silently coerce.

### H1.5 — Reaction calorimetry + thermal hazard pre-screen
- **Already**: `mcp_green_chemistry` covers solvent guides + Bretherick hazard data.
- **Add**:
  - `services/mcp_tools/thermal_hazard/` wrapping a CHETAH-style group-additivity predictor for `T_onset` / `ΔH_decomp` / `oxygen_balance`; ingests RC1mx CSV exports for measured calorimetry.
  - Builtins: `screen_thermal_hazard(smiles)`, `compute_safety_indicators(rc1_trace)`.
  - Hook: `pre_tool` for `start_synthesis_campaign` — block (deny) on red-tier predicted hazard until an attested override.
- **Storage**: `thermal_hazard_assessments` table linked to compounds + reactions + (optional) calorimetry runs.
- **Risk**: false-positive hazard predictions block legitimate chemistry; surface the underlying predicted ΔH and let agent reason about whether DSC is the right next step.

### H1.6 — PAT in-situ ingest + closed loop
- **Already**: `mcp_logs_sciy` covers offline analytics.
- **Add**:
  - `services/mcp_tools/pat/` adapter speaking OPC-UA to ReactIR / MATRIX-MF FT-IR. `subscribe_pat_stream(probe_id, callback_event)` builtin.
  - New canonical `pat_events` partitioned table (1-Hz downsample policy) + `pat_spectrum_classifier` projector emitting `pat_alert` events when conversion endpoints / off-spec excursions trigger.
  - `advance_synthesis_campaign` reads `pat_alert` rows to decide step transition.
- **Risk**: streaming-spectra cardinality stresses Postgres; partition by day, downsample raw to 1 Hz, keep raw JSONL in object storage with table pointer.

### H1.7 — MERMaid PDF mining → ORD reactions projector
- **Already**: `mcp_doc_fetcher` runs Marker on PDFs → text + figures; `mcp_ord_io` for ORD I/O.
- **Add**: new `mermaid_extractor` projector that consumes `document_chunk_created` events with `kind='figure'`, runs MERMaid (VisualHeist + DataRaider + KGWizard) → ORD-shaped reactions → `mcp_ord_io.import_reaction(...)`.
- **Storage**: existing `reactions` canonical table; provenance via `kg_source_cache` projector.
- **Risk**: 87% end-to-end accuracy means 13% of figures produce wrong reactions; carry a `confidence_score` ≤ 0.7 by default and require human/agent attestation before promoting to FOUNDATION.

### H1.10 — Mem0-style cross-session memory projector
- **Already**: `agent_sessions` carries scratchpad; no cross-session recall.
- **Add**: new `agent_memories` table with `(memory_id, user, project, kind, summary_text, embedding, source_session_id, created_at)`; new `memory_projector` that consumes `session_end` + `task_completed` events, summarizes via LLM, embeds via `mcp_embedder`, persists.
- **Hook**: `pre_turn` retrieval — top-k similar memories for the current user's project injected into the system prompt; respects RLS.
- **Risk**: memory bloat; cap per-user/per-project memory count via `config_settings` knob; nightly compaction job collapses similar memories.

## Items to delete or finish, not add

- **g-xTB 501 stub** (`mcp_xtb`) — either bundle the binary or delete the placeholder. Currently a product-surface lie. (H1.14)
- **REINVENT 4 501 stub** (`mcp_genchem`) — Apache-2.0; un-stub. (H1.13)
- **`mcp_logs_sciy` real backend NotImplementedError** — finish the real adapter once a tenant brings a LOGS account; until then mark explicitly "fake-only" in the README.
- **`mcp_instrument_template` 501 endpoints** — keep as skeleton only; document as such in the README, not as a ship-ready service.
- **`/check` and `/learn` slash verbs** — Phase C placeholders. `/check` should land via H0.6 (conformal wrapper) + H0.7 (reflexion hook); `/learn` should land via H1.10 (memory projector). Remove the placeholder stubs once those land.
- **`hypothesis_status_changed` projector hook stub** — Phase 6 follow-up; finish in H2.14 (POPPER falsification skill) or delete.
- **`eln_json_importer.legacy/`** — open BACKLOG item; either delete or document as a one-shot bulk migrator.

## Risks and decisions still owed

| # | Decision | Options | Recommendation |
|---|---|---|---|
| R1 | License posture for non-MIT/Apache foundation models | (a) accept ASL/CC-BY-NC for research only and gate via `permission_policies`; (b) refuse anything non-permissive | (a) — already the right pattern; tag every weight in `mcp_tools` registry with a `license` field |
| R2 | Vendor licenses for ICH-M7 (Lhasa Derek + Sarah) | (a) hard dependency; (b) optional tier with open AmesNet fallback; (c) skip | (b) — open AmesNet is research-grade only; ship both paths and let tenant configure |
| R3 | GPU host for Boltz-2 / NNP / GenMol / FastCSP | (a) tenant brings GPU; (b) bundle a default GPU compose profile; (c) cloud-only | (b) — `gpu-chemistry` profile, document GPU spec in `docs/runbooks/local-dev.md` |
| R4 | Migration tool replacement for `db/init/*.sql` | Already in BACKLOG; Alembic vs sqitch vs Flyway | Alembic — Python-native, matches existing stack, supports model-driven migrations |
| R5 | When to add a real "supervisor" multi-agent topology vs keep one-deep sub-agents | Trigger when sub-agents need to share scratchpad | Hold until 3+ skill packs need cross-skill state; revisit in H3 |
| R6 | Whether to add a code-acting harness mode now | (a) ship in H0; (b) defer to H3 | (b) — the existing ReAct loop is well-tested; opt-in code mode is a new failure surface and best deferred |
| R7 | Boltz-2 vs RoseTTAFold-AA-2 vs Boltz-1 | All three credible | Boltz-2 only; revisit in 2026-Q3 if Boltz-3 / IsoDDE-class open ships |
| R8 | Whether `verify_structure` should also call IR/Raman | Multiplicative confidence boost per Goodman 2025 | Yes, but as a follow-up after CASCADE+DP4 lands; gate on `mcp_chemometrics` (H1.9) being present |

## Backlog additions (append-ready)

```
- [agent-claw/optimizer] qNEHVI/qParEGO multi-objective in BoFire (H0.1)
- [agent-claw/skills/retro] route-scoring vector (SAScore + SCScore + RAscore + iGAL + PMI) on every retrosynth result (H0.2)
- [mcp_green_chemistry] HSPiPy nearest-neighbour green-substitute via merged CHEM21+GSK+Pfizer table (H0.3)
- [agent-claw/builtins] pubchem_ghs_lookup builtin + pre_tool gate on H300/H310/H330/H350/H360 (H0.4)
- [agent-claw/builtins] OPSIN name-to-structure builtin (H0.5)
- [mcp_tools/common] @with_conformal decorator for numeric tool outputs + prediction_calibration projector (H0.6)
- [agent-claw/hooks] reflexion post_turn hook with config_settings gate (H0.7)
- [agent-claw/core] tool-RAG over MCP registry — embed tool descriptions, top-k per turn (H0.8)
- [agent-claw/permissions] CWC Schedule-1 + DEA + EAR Cat 1C SMARTS pre_tool gate (H0.9)
- [mcp_reaction_optimizer] Atlas / EDBO+ alternate backends for mixed-categorical campaigns (H0.10)
- [mcp_chemprop] upgrade to Chemprop v2 + bundle ADMET-AI 41-endpoint weights (H0.11)
- [config_settings] migrate ICH Q3A/Q3B/M7 thresholds + CWC/DEA/EAR lists from code to config_settings (H0.12)
- [mcp_boltz] new GPU MCP service with cofold_and_score(target, ligand) (H1.1)
- [mcp_seismiq] new MCP for drug-substance impurity ID transformer (H1.2)
- [mcp_cfmid] new MCP for CFM-ID 4 in-silico MS/MS (H1.2)
- [mcp_lhasa_nexus] vendor adapter for Derek + Sarah (H1.2)
- [skills] impurity_id_agent skill orchestrating SIRIUS + SEISMiQ + CFM-ID + Lhasa (H1.2)
- [mcp_nmr_predict] new MCP for CASCADE-2.0 + DP4-AI (H1.3)
- [mcp_nmr_solver] new MCP for NMR-Solver de novo fallback with FAISS index in object storage (H1.3)
- [skills] verify_structure skill (CASCADE + DP4 + NMR-Solver fallback + LLM HSQC re-rank) (H1.3)
- [mcp_logs_sciy] hard-pin allotropy library; ASM-LC / ASM-MS / ASM-NMR / ASM-PlateReader projector chain (H1.4)
- [mcp_thermal_hazard] new MCP wrapping CHETAH group-additivity + RC1mx CSV ingest; pre_tool block on red-tier (H1.5)
- [mcp_pat] new MCP adapter for ReactIR / MATRIX-MF FT-IR via OPC-UA; pat_events partitioned table + projector (H1.6)
- [projectors/mermaid_extractor] new projector consuming figure chunks → MERMaid → mcp_ord_io reaction import (H1.7)
- [mcp_degradant_proposer] new MCP with ~200 RDKit reaction SMARTS for forced-degradation pathways (H1.8)
- [mcp_lhasa_zeneth] vendor adapter for Lhasa Zeneth 10.1 (H1.8)
- [mcp_chemometrics] new MCP exposing build_chemometric_model + score_batch_against_golden (H1.9)
- [projectors/memory_projector] Mem0-style cross-session memory projector + agent_memories table + pre_turn retrieval hook (H1.10)
- [mcp_doc_fetcher] OpenChemIE + DECIMER 2.5 reaction-figure post-processor (H1.11)
- [mcp_polymorph] new MCP wrapping CCDC CSD Python API for HBP + scaffold lookup; FastCSP track later (H1.12)
- [mcp_genchem] un-stub REINVENT 4 endpoint (Apache-2.0) (H1.13)
- [mcp_xtb] either bundle g-xTB binary or delete the 501 placeholder (H1.14)
- [infra/compose] add gpu-chemistry profile separate from chemistry (cross-cutting #5)
- [agent-claw/audit] human_attestation table + signed event per agent-aided decision (H2.13)
- [skills] POPPER sequential-falsification skill with FDR control over hypotheses (H2.14)
- [skills] Phoenix-equivalent skill pack (prior-art / cost / outcome) (H2.15)
```

## Sources

Per-stream exhaustive citations are in the underlying research transcripts; the consolidated short-list:

- Foundation models: Boltz-2 (MIT) https://github.com/jwohlwend/boltz · MACE-OFF23 https://github.com/ACEsuit/mace · AIMNet2 https://pubs.rsc.org/en/content/articlehtml/2025/sc/d4sc08572h · Chemprop v2 https://chemrxiv.org/doi/10.26434/chemrxiv-2025-4p1nr · TabPFN-2.5 https://arxiv.org/abs/2511.08667 · GenMol https://github.com/NVIDIA-Digital-Bio/genmol · SynFormer https://www.pnas.org/doi/10.1073/pnas.2415665122 · OpenFE https://github.com/OpenFreeEnergy/openfe · FastCSP https://arxiv.org/html/2508.02641v1
- Lab informatics: Allotrope ASM https://www.allotrope.org/asm · allotropy https://github.com/Benchling-Open-Source/allotropy · Benchling Connect https://help.benchling.com/hc/en-us/articles/22558210727565 · CDD Vault https://support.collaborativedrug.com/hc/en-us/categories/115001259423 · SciY LOGS https://logs.sciy.com/platform · OptiHPLCHandler https://github.com/novonordisk-research/OptiHPLCHandler · ChemAxon Compound Registration https://docs.chemaxon.com/display/docs/Compound+Registration+History+of+Changes · Bruker TopSpin Python https://www.bruker.com/en/products-and-solutions/mr/nmr-software/topspin/topspin-python-interface.html · Pistoia CMC Process Ontology Phase 3 https://pistoiaalliance.org/news/pistoia-alliance-launches-third-phase-of-cmc-process-ontology/
- Process chemistry: BoTorch qNEHVI https://botorch.org/docs/tutorials/multi_objective_bo/ · EDBO+ https://github.com/doyle-lab-ucla/edboplus · pyDOE3 + DSD https://www.statease.com/docs/v25.0/contents/response-surface-designs/definitive-screening-design-dsd-analysis-methods/ · Mettler ReactIR https://www.mt.com/us/en/home/products/L1_AutochemProducts/ftir-and-raman-spectrometers/ftir-spectrometers/ReactIR-702L.html · CHETAH https://www.chetah.org/ · CCDC CSD Python API https://downloads.ccdc.cam.ac.uk/documentation/API/release_notes.html · Mettler RC1mx https://www.mt.com/us/en/home/products/L1_AutochemProducts/reaction-calorimeters/RC1mx-Reaction-Calorimeter.html · ICH Q9 R1 https://www.ema.europa.eu/en/documents/regulatory-procedural-guideline/ich-guideline-q8-q9-q10-questions-answers-r5_en.pdf · PharmaPy https://pmc.ncbi.nlm.nih.gov/articles/PMC10765421/ · IDAES https://github.com/IDAES/idaes-pse · SCScore/SAScore/RAscore https://link.springer.com/article/10.1186/s13321-023-00678-z
- ADMET / HTE / PROTACs: ADMET-AI https://github.com/swansonk14/admet_ai · OpenADMET https://github.com/OpenADMET/openadmet-models · TDC reassessment https://www.biorxiv.org/content/10.64898/2026.02.26.708193v1 · DeepDelta https://github.com/RekerLab/DeepDelta · OSPSuite https://github.com/Open-Systems-Pharmacology · PROTAC-DB 3.0 https://academic.oup.com/nar/article/53/D1/D1510/7748092 · MolGlueDB https://academic.oup.com/nar/article/54/D1/D1510/8239508 · DiffPROTACs https://academic.oup.com/bib · SynPROTAC https://www.biorxiv.org/content/10.64898/2025.12.10.693572v1 · CovalentInDB 2.0 https://academic.oup.com/nar/article/53/D1/D1322/7832349 · LRE metric https://pubs.acs.org/doi/10.1021/acs.jmedchem.5c01803 · A-Lab + critique https://www.chemistryworld.com/news/new-analysis-raises-doubts-over-autonomous-labs-materials-discoveries/4018791.article · MERMaid https://www.sciencedirect.com/science/article/pii/S2590238525003741 · Atlas BO https://pubs.rsc.org/en/content/articlehtml/2025/dd/d4dd00115j · GNINA https://github.com/gnina/gnina · OpenFE blinded benchmark https://chemrxiv.org/doi/10.26434/chemrxiv-2025-7sthd · deldenoiser npj 2025 https://www.nature.com/articles/s44386-025-00007-4 · OPSIN https://github.com/dan2097/opsin · SureChEMBL 2.0 http://chembl.blogspot.com/2025/05/surechembl20-announcement.html
- SOTA agents: Onepot.AI https://cen.acs.org/business/start-ups/Molecule-maker-OnepotAI-launches-13/103/web/2025/11 · ChemAgent HE-MCTS https://arxiv.org/html/2506.07551v1 · ChemHAS https://arxiv.org/pdf/2505.21569 · ChemDFM https://github.com/OpenDFM/ChemDFM · ChemReasoner https://arxiv.org/abs/2402.10980 · FutureHouse Phoenix/Owl https://www.futurehouse.org/research-announcements/launching-futurehouse-platform-ai-agents · POPPER https://arxiv.org/abs/2502.09858 · Mem0 https://arxiv.org/abs/2504.19413 · Letta/MemGPT https://www.letta.com/blog/memgpt-and-letta · Tool RAG https://next.redhat.com/2025/11/26/tool-rag-the-next-breakthrough-in-scalable-ai-agents/ · ToolACE https://proceedings.iclr.cc/paper_files/paper/2025/file/663865ea167425c6c562cb0b6bcf76c7-Paper-Conference.pdf · Reflexion https://arxiv.org/abs/2303.11366 · LATS https://www.andyzhou.ai/pdfs/lats.pdf · ChemBench https://chembench.lamalab.org/ · ChemSafetyBench https://arxiv.org/abs/2411.16736 · Mol-Hallu https://arxiv.org/html/2504.12314v1 · CWC https://www.opcw.org/chemical-weapons-convention · FDA/EMA Joint AI principles https://intuitionlabs.ai/articles/21-cfr-part-11-electronic-records-signatures-ai-gxp-compliance · OpenChemIE https://github.com/CrystalEye42/OpenChemIE · DECIMER https://www.nature.com/articles/s41467-023-40782-0 · OpenAlex https://openalex.org/
- Analytical chemistry: CASCADE-2.0 https://github.com/patonlab/CASCADE · DP4-AI https://pmc.ncbi.nlm.nih.gov/articles/PMC8152620/ · NMR-Solver https://github.com/YongqiJin/NMR-Solver · LLM-as-judge for HSQC https://pubs.rsc.org/en/content/articlehtml/2026/dd/d5dd00359h · MIST + MIST-CF https://github.com/samgoldman97/mist · MSNovelist + SIRIUS 6 https://v6.docs.sirius-ms.io/ · SEISMiQ https://pubs.rsc.org/en/content/articlehtml/2025/dd/d5dd00115c · CFM-ID 4 https://academic.oup.com/nar/article/50/W1/W165/6591530 · Lhasa Zeneth 10.1 https://www.lhasalimited.org/news/zeneth-10-1-released/ · Lhasa Derek + Sarah https://www.lhasalimited.org/news/lhasa-limited-introduces-genotoxicity-prediction-across-derek-nexus-and-sarah-nexus/ · Spotlight + GSAS-II https://www.nature.com/articles/s41598-025-92452-4 · pkynetics https://github.com/PPeitsch/pkynetics · FreeThink ASAPprime https://freethinktech.com/stability-modeling-software/ · GNPS https://gnps.ucsd.edu/ · ChromAlignNet https://github.com/mili7522/ChromAlignNet · Goodman 1H + IR joint scoring https://pubs.rsc.org/en/content/articlehtml/2025/sc/d5sc06866e
