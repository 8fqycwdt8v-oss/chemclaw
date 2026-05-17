# ChemClaw Skills Reference

Skills are domain-specific behavior packs that the agent activates either via `/skills enable <id>` or by explicit user invocation (e.g., `/retro <smiles>`). Each skill prepends its `prompt.md` to the system message and optionally restricts the available tool set. Skills are defined in `skills/<id>/SKILL.md` (metadata + workflow) and optionally `skills/<id>/prompt.md` (condensed system-prompt injection).

**Activation:** `POST /api/chat` body: `{ "skills": ["skill_id"] }` or conversational: `enable the retro skill`.

**Listing skills:** `GET /api/skills` returns all registered skills with their status and description.

**Skill-filtered tool set:** When a skill is active, only its declared tools plus internal builtins are available. The `apply-skills` hook at `pre_turn` enforces this.

---

### `aizynth_route`

**Description:** Retrosynthesis tree builder via AiZynthFinder — faster and cheaper than ASKCOS.

**Invocation:** When ASKCOS is unavailable or slow, for early-stage approximate routes, or explicit `/aizynth <smiles>`.

**Workflow:**
1. Canonicalize the target SMILES.
2. Call `propose_retrosynthesis` with `prefer_aizynth: true`.
3. Parse the tree to extract the synthetic sequence (leaf → root).
4. Search for known conditions and literature precedent via `search_knowledge`.
5. Use `query_kg` to flag known incompatibilities.

**Output:** Route summary with `in_stock_ratio` and score. Highlights routes with `in_stock_ratio >= 0.8` as commercially accessible.

**Tools:** `canonicalize_smiles`, `propose_retrosynthesis`, `search_knowledge`, `query_kg` | **max_steps:** 20 | **Latency:** ~20–40 s per `propose_retrosynthesis` call.

---

### `askcos_route`

**Description:** Multi-step retrosynthesis route proposal via ASKCOS v2 with AiZynthFinder fallback.

**Invocation:** When the user asks for a retrosynthesis plan or types `/route <smiles>`.

**Workflow:**
1. Canonicalize the target SMILES.
2. Call `propose_retrosynthesis` (ASKCOS preferred; AiZynthFinder auto-fallback on timeout/503).
3. For top-3 routes, expand conditions via `search_knowledge`.
4. Use `query_kg` to surface reagent incompatibilities, hazards, or vendor restrictions.
5. Compose a ranked route table ordered by descending `total_score`.
6. Call `propose_hypothesis` with cited `fact_ids` for mechanistic inferences.

**Output:** Ranked route table with step index, reaction SMILES, score, conditions, risks, references. States when AiZynthFinder fallback was used and why.

**Tools:** `canonicalize_smiles`, `propose_retrosynthesis`, `search_knowledge`, `query_kg`, `propose_hypothesis` | **max_steps:** 25 | **Latency:** ~30–60 s total.

---

### `chemprop_yield`

**Description:** Yield prediction over a reaction set using chemprop v2 MPNN with uncertainty quantification.

**Invocation:** When the user asks to predict yield for a reaction set or `/yield <rxn_smiles>`.

**Workflow:**
1. If reaction SMILES are provided directly, call `predict_reaction_yield`.
2. If predicting over similar reactions from the portfolio, call `find_similar_reactions` first, then pass the list to `predict_reaction_yield`.
3. For property prediction (logP, logS, mp, bp), use `predict_molecular_property`.
4. Flag predictions where `std / predicted_yield > 0.3` as low-confidence.
5. Use `statistical_analyze` to rank-order yield-affecting features across a reaction set.

**Output:** Predicted yield as `X% ± Y%`. Recommends condition optimization via `askcos_route` when predicted yield < 60%.

**Tools:** `predict_reaction_yield`, `predict_molecular_property`, `find_similar_reactions`, `statistical_analyze`, `search_knowledge` | **max_steps:** 20.

---

### `closed-loop-optimization`

**Description:** Closed-loop reaction-optimization campaign driven by BoFire Bayesian optimization.

**Invocation:** "Optimize this reaction", "propose next 8 wells", "start a BO campaign", or when measured results are fed back for the next proposal.

**Workflow (multi-turn, session-resumable via `manage_todos`):**

**Round 0 (setup):**
1. Canonicalize inputs.
2. Call `find_similar_reactions` for prior data if `nce_project_internal_id` is set.
3. Define factor space from `design_plate` or explicit user input.
4. Call `start_optimization_campaign` with `factors`, `categorical_inputs`, `outputs`, `strategy: "SoboStrategy"`, `acquisition: "qLogEI"`.

**Round n+1 (iterative):**
1. Call `recommend_next_batch(campaign_id, n_candidates=8)`. Returns space-filling samples when `n_observations < 3`; BO-driven proposals when ≥ 3.
2. Optionally annotate with `predict_yield_with_uq`.
3. After chemist measures, call `ingest_campaign_results(round_id, measured_outcomes)`.

**Output:** Proposals as markdown table with `used_bo` flag. Cites campaign as `[campaign:<uuid>]` and round as `[round:<uuid>]`.

**Tools:** `canonicalize_smiles`, `recommend_conditions`, `design_plate`, `start_optimization_campaign`, `recommend_next_batch`, `ingest_campaign_results`, `predict_yield_with_uq`, `manage_todos`, `find_similar_reactions`, `query_kg` | **max_steps:** 30.

---

### `code_mode`

**Description:** Replaces 3+ sequential read-only tool calls with one Python script run inside the Monty sandbox.

**Invocation:** When a task requires 3+ sequential read-only tool calls with linear data flow (no branching on intermediate results), no state mutation, and no generative chemistry.

**When NOT to use:** Single or two-step queries; state-mutating operations; tasks requiring model reasoning between steps; generative chemistry or hypothesis formation.

**Output conventions:** Cites every result as `[rxn:<uuid>]`, `[fact:<uuid>]`, `[doc:<uuid>:<chunk_index>]`. If runtime returns `outcome: "runtime_disabled"`, falls back to sequential ReAct.

**Tools:** `run_orchestration_script`, plus all read-only retrieval tools | **max_steps:** 8.

---

### `condition-design`

**Description:** Propose forward reaction conditions anchored to historical analogs, with applicability-domain check and greenness-adjusted ranking.

**Invocation:** "What conditions for X", "propose conditions for this reaction", "Buchwald between A and B?", or `/conditions <reactants> >> <product>`.

**Workflow:**
1. Canonicalize inputs.
2. Call `recommend_conditions` (default `top_k=5`).
3. For each top recommendation, call `find_similar_reactions` to cite the nearest in-house analog.
4. Call `assess_applicability_domain` once for the query reaction (all recommendations share the same AD verdict).
5. Call `score_green_chemistry` on the union of solvents across all top-k recommendations.
6. Soft-penalty re-ranking: `final_rank_score = recommender_score * (1.0 - worst_hazard_penalty)` where `HighlyHazardous → 0.40`, `Hazardous → 0.20`, `Problematic → 0.10`, `Recommended → 0.00`.
7. Call `predict_reaction_yield` for top-3 post-re-ranking (informational).
8. Use `query_kg` for reagent hazards / incompatibilities.
9. If AD = `out_of_domain` or nearest in-house analog has cosine distance > 0.70, call `search_knowledge` + `fetch_original_document`.

**Output:** Table with catalyst(s), reagent(s), solvent(s), T (°C), recommender_score, final_rank_score, worst_solvent_class, predicted_yield ± std, AD verdict, nearest analog, risks.

**Tools:** `canonicalize_smiles`, `recommend_conditions`, `find_similar_reactions`, `assess_applicability_domain`, `score_green_chemistry`, `predict_reaction_yield`, `search_knowledge`, `query_kg`, `fetch_original_document` | **max_steps:** 25.

---

### `condition-design-from-literature`

**Description:** Cold-start condition design when in-house data is absent and the reaction is out-of-domain for the in-house recommender.

**Invocation:** User explicitly asks for literature precedent; upstream `condition-design` or `late-stage-functionalization` detected `out_of_domain`; no in-house hits or all hits at `drfp_similarity < 0.4`; reaction class is post-2016.

**Workflow:**
1. Canonicalize and re-confirm OOD via `assess_applicability_domain`.
2. Retrieve literature top-5 hits via `search_knowledge`.
3. Fetch verbatim procedures for top-3 via `fetch_original_document`.
4. Cross-check with `recommend_conditions` (ASKCOS output used for triangulation only, not as the source).
5. Score greenness for each literature condition set.
6. Check `query_kg` for hazards on the reagent set.

**Confidence tier policy:** Always `single_source_llm` or `exploratory`. Never `working` or `foundation` — those tiers require in-house data with multiple confirmations.

**Tools:** `canonicalize_smiles`, `assess_applicability_domain`, `find_similar_reactions`, `search_knowledge`, `fetch_original_document`, `recommend_conditions`, `score_green_chemistry`, `query_kg` | **max_steps:** 20.

---

### `cross_learning`

**Description:** Cross-project reaction learning — surface transferable insights from the full portfolio.

**Invocation:** `/learn` (skill induction) or `/skills enable cross_learning`.

**Workflow:**
1. Broad `find_similar_reactions` query across all accessible projects.
2. Group by project and reaction class; `expand_reaction_context` for top hits per group.
3. `statistical_analyze` across the pooled reaction set (requires ≥ 5 reactions).
4. `synthesize_insights` to compose transferable claims with `evidence_fact_ids`.
5. `propose_hypothesis` for mechanistic inferences.

**Output:** Transferable lessons with explicit project attribution; confidence reflects evidence count (thin portfolio → `EXPLORATORY`).

**Tools:** `find_similar_reactions`, `expand_reaction_context`, `statistical_analyze`, `synthesize_insights`, `propose_hypothesis`, `query_kg` | **max_steps:** 35.

---

### `deep_research`

**Description:** Multi-section research reports with full KG traversal, contradiction checking, and citation discipline.

**Invocation:** `/dr <question>` or `/skills enable deep_research`. For formal deliverables: landscape analyses, route comparisons, analytical method comparisons, risk assessments.

**Workflow:**
- Use all retrieval and KG tools iteratively before drafting.
- Check contradictions before asserting any disputed fact.
- Draft one section at a time with `draft_section`; no free-form sections outside the tool.
- Call `mark_research_done` exactly once at the end.

**Constraints:** `max_steps_override: 40` (raised from default). Never use `mark_research_done` for conversational answers. Every claim requires at least one cited fact or document chunk.

**Tools:** `search_knowledge`, `fetch_full_document`, `fetch_original_document`, `query_kg`, `check_contradictions`, `find_similar_reactions`, `expand_reaction_context`, `statistical_analyze`, `synthesize_insights`, `propose_hypothesis`, `draft_section`, `mark_research_done`, `analyze_csv` | **max_steps:** 40.

---

### `hplc-method-optimization`

**Description:** Closed-loop HPLC method-optimization campaign using BoFire BO with chromatography-aware factor encoding.

**Invocation:** "Develop an HPLC method for {compound}", "optimize chromatography for impurity profiling", "screen columns for separating {analyte set}", "propose next batch of methods for campaign {id}".

**Workflow:**

**Round 0:** Scout columns via `query_chrom_columns` → decide eluent system (binary/ternary) → choose gradient scheme (`hold_ramp_hold`, `linear`, or `multi_segment`) → choose objective mode (`single` Niezen-Desmet CRF, or `pareto` resolution × runtime × solvent-PMI) → optionally `simulate_chrom_retention` for LSS pre-screen → call `start_chrom_campaign`.

**Round n+1:** `recommend_next_chrom_batch` → `materialize_chrom_method` per proposal → chemist runs methods → pull peak data via `query_instrument_runs` / `fetch_instrument_run` → `ingest_chrom_results` (scores CRF + min-resolution + runtime + solvent-PMI) → next round.

**Wrap-up:** `extract_chrom_pareto_front` for multi-objective campaigns.

**Tools:** `canonicalize_smiles`, `query_chrom_columns`, `start_chrom_campaign`, `recommend_next_chrom_batch`, `materialize_chrom_method`, `ingest_chrom_results`, `extract_chrom_pareto_front`, `simulate_chrom_retention`, `query_instrument_runs`, `fetch_instrument_run`, `manage_todos`, `query_kg` | **max_steps:** 30.

---

### `hte-plate-design`

**Description:** Design an HTE plate (24/96/384/1536) via BoFire space-filling DoE with predicted yield annotations and optional ORD export.

**Invocation:** "Design a 96-well screen for X", "set up an HTE plate", `/plate <reactants> >> <product>`.

**Workflow:**
1. Canonicalize inputs.
2. Call `recommend_conditions` (`top_k=10`) to get candidate catalysts/bases/solvents.
3. Call `design_plate` with plate format, continuous factors, categorical inputs, optional yield annotation (`annotate_yield: true`), and CHEM21 floor applied automatically.
4. Surface `design_metadata.applied_chem21_floor` if any solvents were auto-dropped.
5. Render as markdown table ordered by well_id.
6. Optionally call `export_to_ord` if the user requests a robot-ready file.

**Tools:** `canonicalize_smiles`, `recommend_conditions`, `design_plate`, `predict_yield_with_uq`, `export_to_ord`, `find_similar_reactions`, `query_kg` | **max_steps:** 25.

---

### `late-stage-functionalization`

**Description:** Propose LSF conditions for Minisci C-H, photoredox, borylation, and directed C-H transformations on advanced intermediates. Defers to `condition-design` when no LSF context is detected.

**Invocation:** "C-H activation conditions for X", "Minisci on Y", "photoredox decarboxylative coupling", "Ir-borylation", `/lsf <substrate-smiles> <reagent-class>`.

**Workflow:**
1. Canonicalize and classify the transformation: `minisci`, `borylation`, `photoredox`, `directed_ch`, or `other`.
2. Run `recommend_conditions` and `assess_applicability_domain` in parallel (OOD is expected and informative for LSF, not blocking).
3. Class-specific re-rank (photoredox-Minisci priority over classical for oxidizable substrates; Ir-COD for borylation; mediator compatibility for photoredox; directing-group check for directed C-H).
4. `search_knowledge` + `fetch_original_document` for top-3 literature precedents (required for each recommendation).
5. `predict_yield_with_uq` and `score_green_chemistry` for informational context.
6. `query_kg` for known regio-selectivity issues and directing-group conflicts.
7. `find_similar_reactions` for in-house LSF data (rare; say so explicitly when absent).

**Output:** Top-3 table with mediator, oxidant/reductant, ligand, solvent, T, wavelength (photoredox), yield ± std, AD verdict, greenness, lit citation, expected regiochemistry, failure modes. At least one literature procedure is required per recommendation.

**Tools:** `canonicalize_smiles`, `recommend_conditions`, `assess_applicability_domain`, `score_green_chemistry`, `find_similar_reactions`, `predict_yield_with_uq`, `search_knowledge`, `fetch_original_document`, `query_kg` | **max_steps:** 24.

---

### `library_design_planner`

**Description:** Design and rank focused chemical libraries using the generative MCP (`mcp-genchem`) paired with QM scoring screens.

**Invocation:** "Propose 50 ligand variants of BINAP", "build a small library around this fragment", "what bioisosteres of this group are worth trying?"

**Generator types available via `generate_focused_library`:** `scaffold` (R-group attachment points), `rgroup` (explicit R-group lists), `bioisostere` (SMARTS rewrites), `grow` (BRICS extension), `link` (fragment linking).

**Workflow:**
1. Generate candidates with `generate_focused_library`.
2. Optionally filter by chemotype using `find_similar_compounds` or `match_smarts_catalog`.
3. Score via `run_chemspace_screen` with a pipeline (e.g., `qm_single_point` for quick triage, `qm_geometry_opt + qm_frequencies` for binding prediction, `qm_fukui` for reactive-site ranking).
4. For > 50 proposals or frequency calculations, confirm intent with `ask_user` before committing.
5. Wrap in a `workflow_define` + `workflow_run` definition for auditability.
6. Promote to a forged tool after a successful design+rank session.

**Tools:** `canonicalize_smiles`, `inchikey_from_smiles`, `generate_focused_library`, `find_matched_pairs`, `find_similar_compounds`, `substructure_search`, `match_smarts_catalog`, `classify_compound`, `run_chemspace_screen`, `enqueue_batch`, `inspect_batch`, `workflow_define`, `workflow_run`, `workflow_inspect`, `workflow_pause_resume`, `workflow_modify` | **max_steps:** 25.

---

### `pharma-process-readiness`

**Description:** Aggregate yield UQ, applicability domain, greenness, and safety signals into a tiered scale-up readiness verdict.

**Invocation:** "Is this ready for scale-up", "what's the pharma readiness of this campaign", "process-development assessment".

**Five evidence signals:**
1. `predict_yield_with_uq` — yield magnitude + uncertainty
2. `assess_applicability_domain` — AD verdict
3. `score_green_chemistry` — greenness / PMI
4. `score_green_chemistry /assess_reaction_safety` — Bretherick group flags for safety
5. `find_similar_reactions` — evidence of prior in-house runs at scale

**Verdict tiers:**

| Tier | Criteria |
|---|---|
| `scale-ready` | `ensemble_mean ≥ 70%`, `ensemble_std ≤ 10%`, `AD = in_domain`, no `HighlyHazardous` solvents (or explicit waiver), no explosive/pyrophoric reagents OR ≥ 3 successful prior scale runs |
| `pilot-ready` | `ensemble_mean ≥ 50%`, `ensemble_std ≤ 20%`, `AD in_domain or borderline`, at most 1 `HighlyHazardous` solvent, no explosive Bretherick hits |
| `exploratory` | `ensemble_mean < 50%` OR `std > 20%` OR `AD = out_of_domain` OR explosive/pyrophoric reactant |

For campaigns, additionally calls `extract_pareto_front(campaign_id)` and evaluates each Pareto point.

**Tools:** `canonicalize_smiles`, `find_similar_reactions`, `predict_yield_with_uq`, `assess_applicability_domain`, `score_green_chemistry`, `extract_pareto_front`, `manage_todos` | **max_steps:** 20.

---

### `qc`

**Description:** Analytical question routing — HPLC, NMR, MS, KF data triage and method validation lookup.

**Invocation:** Questions about analytical data, method validation, instrument results, specifications, or `/qc`.

**Scope:** HPLC (purity, impurity profiling), NMR (structure confirmation, purity), MS (mass confirmation, fragmentation), KF (water content), dissolution, particle size, general method validation.

**Workflow:**
- Identify analytical technique from the question first.
- For data files (CSV): use `analyze_csv` to compute summary statistics and triage anomalies.
- For method validation/specification questions: use `search_knowledge` for SOPs, validation reports, pharmacopeial references.
- For structured entity queries: use `query_kg`.
- When sources disagree: use `check_contradictions`.
- For chromatogram images: use `fetch_original_document` with `format="pdf_pages"`.

**Output:** Numerical data includes mean, range, and out-of-spec flags. Never asserts "pass" or "fail" without citing a specification limit with a source ID.

**Tools:** `search_knowledge`, `query_kg`, `analyze_csv`, `check_contradictions`, `fetch_original_document`, `fetch_full_document` | **max_steps:** 25.

---

### `qm_pipeline_planner`

**Description:** Compose multi-step QM pipelines (conformer search → optimize → frequencies → descriptor) for screening, ranking, and chemistry decisions.

**Invocation:** "Rank these ligands by binding strength", "which conformer dominates", "what's the redox potential of X", "screen this fragment library by ΔG".

**Canonical pipeline templates:**

| Pipeline | Steps |
|---|---|
| Conformational free-energy ranking | `qm_crest_screen mode=conformers` → `qm_geometry_opt method=GFN2 threshold=tight` on lowest-energy conformer → `qm_frequencies method=GFN2` |
| Property screening | `qm_single_point` (cheap) → `qm_fukui` for reactive site → `qm_redox_potential` |

Uses `workflow_define` + `workflow_run` for multi-compound batches. QM results are cached in `qm_jobs` keyed by deterministic SHA-256 — repeat calls cost ~50 ms.

**Tools:** `canonicalize_smiles`, `inchikey_from_smiles`, `qm_single_point`, `qm_geometry_opt`, `qm_frequencies`, `qm_fukui`, `qm_redox_potential`, `qm_crest_screen`, `find_similar_compounds`, `classify_compound`, `run_chemspace_screen`, `enqueue_batch`, `inspect_batch`, `workflow_define`, `workflow_run`, `workflow_inspect`, `conformer_aware_kg_query` | **max_steps:** 30.

---

### `retro`

**Description:** Retrosynthesis route proposal — find similar reactions, expand context, propose routes.

**Invocation:** "How do I make X" or `/retro <smiles>`.

**Workflow:**
1. Canonicalize the target SMILES.
2. Search the user's portfolio via `find_similar_reactions`.
3. Expand top-3 hits with `expand_reaction_context` for reagents, conditions, outcomes, failures.
4. Look up SOPs and validations via `search_knowledge`.
5. Use `query_kg` for incompatibilities, hazard notes, vendor restrictions.
6. Compose a ranked route table (reaction ID, yield range, conditions, risks, references).
7. Call `propose_hypothesis` for any mechanistic inference not directly evidenced.

**Output:** Routes in descending expected-yield-confidence order; `EXPLORATORY`-tier facts explicitly flagged; note when fewer than 3 similar reactions exist.

**Tools:** `find_similar_reactions`, `expand_reaction_context`, `canonicalize_smiles`, `search_knowledge`, `query_kg`, `propose_hypothesis` | **max_steps:** 30.

---

### `sirius_id`

**Description:** MS-based unknown identification using SIRIUS 6 + CSI:FingerID + CANOPUS.

**Invocation:** User uploads MS2 data, asks to identify an unknown compound, `/identify`, or `/ms-id`. Typical use cases: unknown impurity ID from LC-MS/MS, metabolite ID, biosynthetic intermediate structure elucidation.

**Workflow:**
1. Extract `ms2_peaks` ({m_z, intensity} pairs) and `precursor_mz`. Assume `positive` ionization if not stated.
2. Call `identify_unknown_from_ms` — latency ~60–120 s; communicate this before calling.
3. Report top-5 candidates by CSI:FingerID score with ClassyFire classification.
4. Canonicalize the top candidate SMILES.
5. `search_knowledge` for the candidate in project documents/SOPs.
6. `query_kg` to check if the candidate is already a known impurity or metabolite.
7. `propose_hypothesis` connecting the MS ID to a KG fact if a match is found.

**Confidence levels:** `score > 0` = High confidence, `0 to -0.5` = Tentative, `< -0.5` = Low confidence.

**Tools:** `identify_unknown_from_ms`, `canonicalize_smiles`, `search_knowledge`, `query_kg`, `propose_hypothesis` | **max_steps:** 20.

---

### `synthegy_feasibility`

**Description:** Score retrosynthesis-route feasibility (yield expectation, side reactions, byproducts, redundant steps) aligned with the Synthegy paper by Bran et al., *Matter* 2026.

**Invocation:** "Rank these candidate routes by feasibility", "which is most likely to give high overall yield?", "is this route practical?"

**Workflow:**
1. Canonicalize target.
2. Generate candidates via `propose_retrosynthesis` or work with user-provided routes.
3. Score one route at a time using the feasibility criteria (overall yield expectation, side-reaction management, redundancy avoidance, precedented transformations, functional-group compatibility).
4. Ground specific claims with `expand_reaction_context`, `search_knowledge`, `query_kg`.

**Output format (paper-compatible):**
```
<analysis>[step-by-step analysis]</analysis>
<score>[0–10]</score>
```

**Limitation:** Synthegy shows bias toward optimistic feasibility; scores routes one at a time to avoid positional bias. Score is a screen, not a yield prediction.

**Tools:** `canonicalize_smiles`, `propose_retrosynthesis`, `expand_reaction_context`, `search_knowledge`, `query_kg` | **max_steps:** 25.

---

### `synthegy_retro`

**Description:** Strategy-aware retrosynthesis: reranks ASKCOS/AiZynthFinder routes against a natural-language strategic query, aligned with Synthegy (Bran et al., *Matter* 2026).

**Invocation:** User expresses a strategic preference ("plan a route to X with early imidazole ring formation", "find a convergent strategy", "avoid protecting groups"), or `/synthegy <smiles> "<query>"`.

**Workflow:**
1. Canonicalize target.
2. Generate ≥ 5 candidate routes via `propose_retrosynthesis`.
3. Optionally augment with `find_similar_reactions`.
4. Score each route **one at a time** (paper documents positional bias with multiple routes in one prompt).
5. Ground claims with `expand_reaction_context`, `search_knowledge`, `query_kg`.

**Output format (paper-compatible):**
```
<analysis>[stepwise analysis in retrosynthetic order, per-step alignment with query]</analysis>
<score>[0–10]</score>
```

**Limitations:** Routes longer than ~20 reactions degrade in scoring quality; SMILES misinterpretation is a documented failure mode; scores are strategic alignment estimates, not yield predictions.

**Tools:** `canonicalize_smiles`, `propose_retrosynthesis`, `find_similar_reactions`, `expand_reaction_context`, `search_knowledge`, `query_kg`, `propose_hypothesis` | **max_steps:** 30.

---

### `synthesis_campaign_orchestrator`

**Description:** Drive an autonomous synthesis campaign end-to-end. Classifies intent into one of 5 campaign kinds, creates a `synthesis_campaigns` row with a per-kind step DAG, and advances the DAG across sessions.

**Invocation:** `/synthesize <description>`, "synthesize molecule X", "build a library around scaffold Y", "screen these conditions", "run a BO campaign", "run a BO-or-die optimisation".

**Campaign kinds:**

| Kind | When | Goal payload |
|---|---|---|
| `single_experiment` | One target molecule | `{target_smiles, max_routes, max_steps}` |
| `library_synthesis` | N analogues around a scaffold | `{scaffold_smiles, library_size, design_strategy}` |
| `screening` | HTE plate of one reaction | `{reaction_smiles, factor_space, plate_format}` |
| `bo_campaign` | Closed-loop BO, no death gate | `{reaction_smiles, objectives, factors, max_rounds}` |
| `bo_or_die` | BO with hard budget cap | `bo_campaign + {budget_max_experiments, die_after_no_improvement_rounds}` |

**Operating loop:**
1. Call `list_synthesis_campaigns` to check for in-flight campaigns first.
2. Classify intent; call `ask_user` once if ambiguous.
3. Call `start_synthesis_campaign({ seed_playbook: true })`.
4. Advance loop: `advance_synthesis_campaign` → dispatch tools for the current step → `update_synthesis_campaign_step` → repeat.
5. Cap autonomous dispatches at `max_concurrent_steps` (default 4) per turn; yield to user on `awaiting_measurement` steps.

**Step kinds:** `retrosynthesis`, `literature_pull`, `condition_design`, `library_design`, `hte_plate_design`, `bo_round`, `forward_prediction`, `qm_screen`, `mechanism_check`, `feasibility_assessment`, `submit_batch`, `measurement_wait`, `ingest_results`, `readiness_gate`, `die_check`, `summary`.

**Tools:** 40+ tools across all chemistry domains | **max_steps:** 60.

---

### `wiki-curator`

**Description:** Curate the knowledge wiki — find the right page, read it, and draft agent-authorable pages (topic / glossary / contradiction) when none exists.

**Invocation:** `/wiki <query>`.

**Hard rules:**
- Never author or overwrite entity-backed pages (`compound/…`, `reaction_family/…`, etc.) — use `request_article` and let the `wiki_regen` daemon generate them.
- Never author or edit `<!-- human:begin … -->` blocks (the `wiki-human-block-guard` hook enforces this).
- Cite every concrete claim with the bracket forms (`[fact:<uuid>]`, `[experiment:<id>]`, etc.).

**Operating loop:**
1. `list_articles({ query })` first; construct slug directly for entities (SMILES → InChIKey, project code, document sha).
2. If page is stale (`dirty=true`), note it but still read and present.
3. If entity-backed page is missing, call `request_article`.
4. For conceptual queries (methods, definitions, disagreements): gather facts via `search_knowledge`, `query_kg`, `retrieve_related` → write with `upsert_article({ kind: "topic" | "glossary" | "contradiction" })`.

**Tools:** `list_articles`, `read_article`, `upsert_article`, `request_article`, `search_knowledge`, `retrieve_related`, `query_kg`, `synthesize_insights`, `fetch_original_document`, `canonicalize_smiles`, `inchikey_from_smiles`, `manage_todos`, `ask_user` | **max_steps:** 30.

---

### `xtb_conformer`

**Description:** GFN2-xTB + CREST conformer ensemble for stereo, atropisomerism, or ring-flip questions.

**Invocation:** Questions about conformational flexibility, atropisomerism, ring geometry, or `/conformer <smiles>`.

**Use cases:** Diastereomer stability, atropisomeric rotational barrier, chair conformation, macrolactam ring closure geometry.

**Workflow:**
1. Canonicalize SMILES.
2. Call `compute_conformer_ensemble` with `n_conformers` (default 20; use 50+ for macrocycles). Method: `GFN2-xTB` for drug-like molecules, `GFN-FF` for large macrocycles.
3. Report top-5 by Boltzmann weight; energy span in kcal/mol (Hartree × 627.509); flag if lowest-energy weight > 0.8 (single dominant conformer).
4. `search_knowledge` for documented crystal structures or NMR data.
5. `propose_hypothesis` for mechanistic inferences with cited `fact_ids`.

**Output:** Energies in kcal/mol relative to global minimum; Boltzmann weights as percentages; method and `n_conformers` stated.

**Tools:** `canonicalize_smiles`, `compute_conformer_ensemble`, `search_knowledge`, `propose_hypothesis` | **max_steps:** 15 | **Latency:** ~30–60 s for MW < 500; 2–5 min for MW > 800.

---