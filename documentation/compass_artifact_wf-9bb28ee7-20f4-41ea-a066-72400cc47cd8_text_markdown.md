# Harness engineering for a non-GxP pharma R&D agent

A research-velocity harness for an agentic scientific assistant in chemical/analytical development looks fundamentally different from a GxP harness: **the dominant failure mode is not non-compliance, it is slow or shallow science.** Remove Part-11 signatures, ALCOA+ locking, and validated-system change control, and the remaining load-bearing structure is (1) a scientific-rigor constitution with explicit maturity tiers, (2) deterministic chemistry tools wrapped behind typed schemas, (3) playbooks that encode disciplined reasoning for retrosynthesis / mechanism / impurity / HPLC / NMR / MS / DoE / stability, (4) gates that *annotate rather than block* except on safety and reproducibility, (5) proactive sensors filtered by a reward model to prevent notification fatigue, and (6) a carefully scoped "foundation artifact" pipeline that scaffolds — never authors — CTD Module 3 content. The sections below are written for a computational chemist / software architect and are concrete enough to build from. Where a claim is vendor-reported or comes from a non-peer-reviewed source, it is flagged.

---

## 1. Constitution and identity: a scientific-peer, not an executor-of-record

The harness constitution is best framed as **Constitutional AI adapted to scientific rigor** (Bai et al., arXiv:2212.08073; Bai et al., 2023 arXiv:2310.13798 on specific-vs-general principles). The constitution replaces "harmlessness" with hypothesis-driven reasoning, quantified uncertainty, reproducibility, and FAIR-by-default, and replaces "refusal" with *maturity labeling*. Keep the rule list small, specific, and human-readable; bench scientists must be able to read it.

**Core constitution snippet (production-ready text):**

```
# ROLE
You are a chemistry/biology research assistant for an internal, non-GxP
pharma R&D team. You accelerate discovery velocity. You are a scientific
peer, not an executor-of-record.

# SCIENTIFIC NORMS
1. Hypothesis-driven: state hypothesis, null, and falsification criterion
   BEFORE analysis.
2. Quantify uncertainty on every numeric claim:
   (a) point estimate, (b) 95% interval or label in
       {speculative | plausible | well-supported | foundation-quality},
   (c) evidence basis.
3. Reproducibility-first: emit runnable artifacts (SMILES, seed, git SHA,
   notebook cell, DOI) sufficient for a colleague to reproduce in
   one working day.
4. FAIR by default: tag outputs with {project+compound ID, ELN link,
   SMILES/InChIKey/UniProt, license+provenance chain}.
5. Orthogonal corroboration: a claim is "well-supported" only when
   backed by ≥2 independent methods (e.g., chromatographic +
   spectroscopic + computational).

# ASSERTIVENESS
CONFIDENT when: ≥2 orthogonal methods AND tools in-domain.
HEDGE when: single-source, out-of-domain tool, or contradictory literature.
DEFER when: safety-relevant, bench cost >$5k or >1 week, cross-project IP,
         or conflict with a pre-registered hypothesis.
ASK when: ambiguous AND cheap clarification (≤2 questions) materially
         changes the plan; otherwise act and surface assumptions.

# OUTPUT TIERS (required label on every artifact)
[EXPLORATORY]   brainstorm/speculation; free to be wrong; no reproducibility
                guarantee.
[WORKING]       cited, method-tagged, uncertainty-quantified, internally
                reviewable; not yet orthogonally corroborated.
[FOUNDATION]    intended to seed (not be) a regulatory document or external
                publication. Full provenance DAG, orthogonal corroboration,
                human sign-off field left blank for a named scientist.

# NON-GxP LATITUDE
You MAY: run speculative analyses labeled [EXPLORATORY] without full audit
trail; propose hypotheses you cannot yet cite; iterate playbooks without
change control; delete/overwrite your own notes (but keep a git-style
history).
You MUST: flag safety-relevant items; preserve raw experimental data
untouched; never fabricate citations.
```

**Agent identity** should be assertive-but-calibrated. The worst R&D assistant is the one that hedges everything; the next-worst is the one that commits to a single route when three are equally plausible. The ambiguity gate (§3) codifies the cutoff. The exploratory↔foundation distinction is the **key design primitive that replaces GxP controls**: speculation is welcome, but it is never silently mixed with data meant to scaffold a regulatory submission. Every artifact carries a `maturity` field, and promotion between tiers is explicit and auditable (git-like history, not Part 11).

---

## 2. Scientific reasoning playbooks

Playbooks are typed, versioned skills — a Voyager-style growing library (Wang et al., TMLR 2023, arXiv:2305.16291) — each one a deterministic template that plans tool calls, emits a reasoning trace, and produces a structured artifact. The LLM's job is *planning, disambiguation, and narrative*; all quantitative chemistry delegates to tools.

### 2a. Retrosynthetic and forward synthesis

Four engines cover the space and are best used together: **AiZynthFinder** (Genheden et al., *J. Cheminformatics* 12:70, 2020; v4.x with Chemformer expansion, broken-bonds scoring, eUCT/dUCT MCTS variants per Fuller et al., *JCIM* 65:6537, 2025), **ASKCOS v2** (Tu et al., *Acc. Chem. Res.* 58:1764, 2025), **IBM RXN / Molecular Transformer** (Schwaller et al., *ACS Cent. Sci.* 5:1572, 2019), and the rule-based **Synthia** (Mikulak-Klucznik et al., *Nature* 588:83, 2020). Biocatalysis sits alongside via **RetroBioCat / BioNavi-NP** (Finnigan et al., *Nat. Catal.* 2021; BioNavi-NP *JACS Au* 2024).

**Reconciliation pattern.** No single engine is SOTA across chemistry. Default to *union with weighted voting* plus *forward round-trip validation*: every proposed step must round-trip to the product in the top-3 of an *independent* forward model (RXN Molecular Transformer or ASKCOS WLN). Reject steps that fail. Use *intersection consensus* (routes proposed by ≥2 engines) for high-risk advancements. PaRoutes (Genheden 2022) is the relevant public benchmark for route quality.

**Route-scoring pseudocode:**
```
for r in routes:
    r.yield_est     = product_of_step_yields(r)              # RXN/GNN yield model
    r.step_count    = len(r.steps)
    r.atom_economy  = sum(P_MW / sum_reactant_MW)
    r.PMI           = total_mass_in / mass_product_out
    r.E_factor      = waste_kg / product_kg
    r.cost          = sum(SM_price * moles) + step_cost(r)
    r.greenness     = CHEM21_metric(r)                       # solvent/reagent class
    r.convergence   = 1 - LLS / total_steps                  # Hendrickson LLS
    r.precedent     = kNN_Tanimoto(substrate, template_train, k=5)
    r.score         = Σ wᵢ·normalize(metricᵢ)
pareto_top = pareto_front(routes, [yield, steps, cost, greenness])
```
Substrate-scope audit is a hard requirement: if a template's precedent has Tanimoto_max < 0.5 **or** <3 literature examples, flag `LOW_PRECEDENT` and auto-propose a model-reaction DoE before committing to a linear plan. Protecting-group logic should be handled by an LLM strategic-evaluator pass (Bran et al., arXiv:2503.08537, Mar 2025 — "Chemical reasoning in LLMs unlocks strategy-aware synthesis planning"), which has been shown to correctly flag unnecessary PGs where pure-SMILES models do not.

**Condition reasoning** is dual-sourced: ASKCOS Context Recommender (Gao et al., *ACS Cent. Sci.* 4:1465, 2018) for literature-median solvent/catalyst/T, paired with an LLM first-principles justification ("amine + ArBr → Pd(OAc)₂/XPhos/Cs₂CO₃/dioxane/100 °C; 2 mol% loading typical for electron-rich; check protodehalogenation if water present"). Class-specific models (Buchwald-Hartwig, Suzuki) outperform the general recommender when they exist.

### 2b. Mechanism and impurity prediction

Encode mechanism as a typed reasoning scaffold with class-specific reasoning hooks: **polar ionic** (Nu/E, pKa, HSAB; Hammett ρ), **pericyclic** (FMO, endo/exo), **radical** (BDE tables, persistent-radical effect), **organometallic** (d-count, ligand cone angle, OA/TM/RE), **photoredox/EnT** (triplet energy, E½, Stern-Volmer), **enzymatic** (EC class, cofactor, pocket polarity).

**Impurity playbook.** Enumerate exhaustively across three axes: *process-related* (SM carryover, reagent adducts — HATU→tetramethylurea, HOBt esters; chloroformate→carbamate on amine impurities; solvent adducts — DMF→formylation; over-reaction like bis-acylation; dimers/oligomers; work-up artifacts), *degradation* (oxidation, hydrolysis, photo per ICH Q1B 1.2 M lux·h vis + 200 Wh/m² UVA, thermal — all with mechanistic rationalization), and *genotoxic* (ICH M7 structural alerts via **Derek Nexus** v6.5 with CPCA for N-nitrosamines + **Sarah Nexus** statistical SONN; rule-based AND statistical per ICH M7; TTC = 1.5 µg/day).

**Cascade impurity prediction** (impurities-of-impurities) runs the ASKCOS impurity predictor (`top_k=10, threshold=0.01` — default 0.1 is too conservative) on each step, feeding step-n impurities as inputs to step-n+1, producing a DAG annotated with mechanistic class and cumulative probability. Every structure emitted passes through Derek/Sarah; Class 1–3 hits trigger an LC-HRMS/MS analytical method with LOQ < TTC-equivalent *before* lab execution.

### 2c. Analytical method development

**HPLC.** Encode Snyder–Dolan Linear Solvent Strength theory: `ln k = ln k_w − Sφ`; aim for `k* ∈ 2–5`; pH ≥2 units from pKa of ionizables. Stationary-phase decision tree takes MW, logP, pKa, ionization state → {C18 default; C4/C8 wide-pore for peptides >1500 Da; HILIC/BEH-amide or PFP for very polar; phenyl-hexyl/PFP when π–π selectivity needed; BEH/CSH high-coverage endcapped for basic amines; mixed-mode (Primesep/Scherzo) for zwitterions; Chiralpak IA/IB/IC/ID or Lux Cellulose for chiral}. Scouting: two gradients at different tG (e.g., 20 and 60 min) or 4-run tG×T, fit LSS, compute resolution map. MS-compatible buffers: 5–10 mM ammonium formate/acetate, 0.1% FA, 0.05% TFA. **DryLab 4** (Molnár-Institute), **ACD/AutoChrom**, and **S-Matrix Fusion QbD** are production; the Alves et al. critical review (*Crit. Rev. Anal. Chem.*, 2025, DOI 10.1080/10408347.2025.2575352) is the current landscape reference for AI-HPLC.

**NMR structure elucidation.** Systematic 1H/13C assignment → DEPT/HSQC multiplicity → COSY spin systems → HMBC bridges across quaternary C → NOESY/ROESY for stereochemistry. **CASE** tools: **ACD/Structure Elucidator** (industry benchmark, Elyashberg et al.), **Mnova SE**, **LSD/pyLSD** + **Sherlock** (open). For ambiguous structures use **DP4+** (Grimblat/Zanardi/Sarotti, *J. Org. Chem.* 2015; DP4+App *J. Nat. Prod.* 86:2360, 2023), **DP4-AI** (Howarth/Ermanis/Goodman *Chem. Sci.* 11:4351, 2020), and **DP5** (Howarth & Goodman *Chem. Sci.* 13:3507, 2022). DFT-NMR SOP: conformer search (ETKDG → filter <3 kcal/mol via GFN2-xTB) → B3LYP/6-31G(d,p) opt → **GIAO mPW1PW91/6-31G(d,p)** shielding → M06-2X conformer energies → Boltzmann-averaged DP4+. **The agent must never return a single structure when DP5 confidence <70% or top-2 DP4+ candidates are within ~10×**; it must emit an alternative-hypotheses block with the specific disambiguating experiment (e.g., "selective 1D-NOE on H-3; expect contact with H-8 if 3β").

**Mass spectrometry.** Formula generation with nitrogen rule, RDBE ≥0, Senior's rule, isotope-pattern match (Cl 3:1 M/M+2, Br 1:1, S ~4.4%, 2Cl 9:6:1). Adduct disambiguation by mass-difference to sibling peaks ([M+H]⁺, [M+Na]⁺, [M+NH₄]⁺, [M+HCOO]⁻). Fragmentation rules: even-electron rule, McLafferty, retro-Diels-Alder, common losses (18, 17, 28, 44, 46, 60, 79/81, 162, 176). Toolchain: **SIRIUS 6** + CSI:FingerID + ZODIAC + CANOPUS + COSMIC + MSNovelist (Böcker lab, >70% ID on metabolomics benchmarks), **MZmine 3** (Schmid et al., *Nat. Protoc.* 19, 2024), **MetFrag**, **MS-DIAL/MS-FINDER**, **pyOpenMS**, **CFM-ID 4**, **GNPS** for molecular networking.

### 2d. Physicochemical and ADMET

Consensus logP (average ≥3 methods — XlogP3, Crippen, MlogP, GNN); flag when they disagree by >0.7 log units (out-of-domain indicator for zwitterions, macrocycles, permanent charges). pKa: **QupKake** (Abarbanel & Hutchison, *JCTC* 2024, RMSE 0.54–0.79) or **BCL-XpKa** (DeCorte/Brown/Meiler *JCIM* 2025) for highest open-model fidelity; **MolGpKa** is fast but carries ACD-teacher noise. Always report both micro- and macro-pKa for zwitterions (Zheng/Leito/Green, *JCIM* 64:8838, 2024). Solubility: flag **brick dust** if `logS < −5 AND Tm_pred > 200 °C AND HBD ≥ 2 AND aromatic_rings ≥ 3`; **grease ball** if `clogP > 5 AND TPSA < 75 AND logS < −4`. BCS class reasoning from predicted Caco-2/MDCK Papp plus dose/solubility ratio. ADMET platform: **ADMETlab 3.0** (Fu et al., *NAR* 52:W422, 2024 — 119 endpoints, evidential uncertainty, REST API) is the best free hosted oracle; for internal production, retrain **chemprop v2** (Heid et al., *JCIM* 2024/2025) on curated internal + ChEMBL with AD flags.

**Early-formulation red-flag template** always runs: grease ball, brick dust, pH-dependent solubility, chemical-instability hotspots (ester/amide/β-lactam/N-oxide/hemiaminal/α-carbonyl-H), hERG liability (Jamieson rule: basic pKa >7, logP >3.7, TPSA <75), Ro5/bRo5 violations, poor-absorption + Pgp-substrate combinations.

### 2e. DoE and statistical reasoning

Design selection is deterministic by phase, factor count, and budget: **Plackett-Burman** for main-effects screening with >6 quantitative factors; **Definitive Screening Design** (Jones & Nachtsheim, *J. Qual. Technol.* 43, 2011; 45, 2013; *Technometrics* 58, 2016) when curvature may matter and budget is `2k+1`; **full factorial 2^k + center points** for k ≤ 5 with interactions; **CCD or Box-Behnken** for RSM optimization. RSM interpretation must emit alias structure, VIFs, lack-of-fit p-value, R²_adj and R²_pred, and a design-space contour with uncertainty bounds.

**Switch to Bayesian optimization** when factors >6, experiments >$500 or >4 h each, categorical chemistry variables >10 levels, multi-objective, or prior data available for warm-start. Toolchain in order of preference for pharma: **BoFire** (Dürholt et al., BASF/Bayer/Boehringer/Evonik consortium, JMLR 2024) for enterprise DoE+BO+constraints with chemistry kernels; **BayBE** (Merck KGaA) for chemical encodings and transfer learning; **EDBO+** (Garrido Torres, Doyle et al.) for multi-objective reaction optimization; **GAUCHE** (Griffiths/Schwaller/Aspuru-Guzik, NeurIPS 2023) for GP-on-molecules; **Atlas/Dragonfly/Phoenics/Gryffin** for specialty cases. Canonical pharma wins: Shields/Doyle *Nature* 590:89 (2021); Braconi & Godineau *ACS Sust. Chem. Eng.* 2023 (Cu C–N in ~15 runs).

### 2f. Stability and forced degradation

Standard ICH Q1A/Q1B stress matrix (acid, base, oxidative, thermal dry + wet, photolytic, humidity), target 5–20% degradation, stop before 20% to avoid secondary products. Kinetic analysis auto-classifies zero/first/second-order, Arrhenius Ea (typical drugs 12–24 kcal/mol; outside → suspect phase change), t₉₀ = 0.105/k for first-order. **Mass-balance reasoning is the agent's sharpest degradation sensor**: if MB <95% hypotheses are {volatile degradant; UV-silent degradant; container adsorption; polymeric insoluble; co-eluting with API}; if MB >105% {quantitation error; higher-response-factor degradant; co-eluting cluster}. Always pair HPLC-UV with LC-MS and CAD/ELSD; run an orthogonal column or HILIC-after-RPLC 2D-LC when MB fails to close.

---

## 3. Gates: annotate, don't block (except safety)

In a non-GxP harness, most gates **WARN and annotate maturity tier** rather than BLOCK. The exceptions are safety (CW, explosive, controlled substance — hard refusal à la ChemCrow's `ChemicalWeaponCheck` and `ExplosiveCheck`) and calibration-failure on quantitative claims. The shift is from "can I prove nothing happened wrong?" to **"did I maximize decision quality per scientist-hour?"**

**Gate catalog (Python-style pseudocode):**

```python
def data_quality_gate(run):
    checks = dict(
      replicates_n   = run.n >= run.protocol.min_n,
      rsd_ok         = run.rsd <= run.protocol.rsd_max,
      baseline_ok    = run.baseline_drift <= 0.02,
      calibration_ok = run.cal_r2 >= 0.995 and run.cal_age_days <= 7,
      blank_clean    = run.blank_signal <= 3 * run.noise)
    status = "BLOCK" if not checks["calibration_ok"] else (
             "WARN"  if not all(checks.values()) else "PASS")
    return Gate("data_quality", status, evidence=checks)   # WARN → tier-downgrade

def confidence_gate(claim):
    p_llm  = verbalized_confidence(claim, n_samples=5)
    agree  = ensemble_agreement(claim, models=[Claude, Gemini, GPT])
    p_bayes= bayesian_posterior(claim.data, claim.prior)  # or None
    score  = geomean([s for s in (p_llm, agree, p_bayes) if s is not None])
    return ("foundation-quality" if score>=0.85 else
            "well-supported"     if score>=0.65 else
            "plausible"          if score>=0.40 else "speculative")

def novelty_gate(claim, compound):
    lit   = paperqa2.search(claim.text, k=25)
    struct= chembl.similarity(compound.smiles, tanimoto=0.85)
    if lit.has_direct_match():           return "KNOWN"
    if struct and not lit:               return "ANALOGOUS_SCAFFOLD"
    if not lit and not struct:           return "CANDIDATE_NOVEL"   # IP review

def ambiguity_gate(hypotheses):
    p = sorted([h.posterior for h in hypotheses], reverse=True)
    if p[0] - p[1] < 0.15:
        return PRESENT_ALTERNATIVES(hypotheses[:3],
                                    suggest_disambiguating_experiment=True)
    return COMMIT_TO(hypotheses[0])

def cost_gate(task):                            # EIG / $
    roi = expected_information_gain(task) / max(estimate(task).dollars, 1)
    if task.type == "DFT"          and roi < 0.01: return DEFER
    if task.type == "retrosynth"   and cost_dollars > 50: return ASK_USER
    if task.type == "lit_search"   and roi < 0.001: return SKIP
    return RUN

def triangulation_gate(claim):
    axes = orthogonality_classes(claim.supporting_methods)  # chrom/spec/comp
    if len(axes) >= 2 and concordant(claim, axes): return "CORROBORATED"
    if len(axes) >= 2 and not concordant(claim, axes): return "CONFLICTING"
    return "SINGLE_METHOD"   # downgrade confidence

FOUNDATION_REQUIREMENTS = {
  "identity_proof":      ["HRMS", "1H_NMR", "13C_NMR"],
  "purity_quant":        ["HPLC ≥ 98%", "qNMR optional"],
  "stereochem_if_chiral":["chiral_HPLC", "VCD_or_ECD_optional"],
  "provenance":          ["batch_id","ELN_link","operator","instrument_SN","method_ID"],
  "uncertainty":         ["replicate_n≥3","RSD","LOD","LOQ"]}

def reg_scaffold_gate(package):
    missing = [k for k,req in FOUNDATION_REQUIREMENTS.items()
               if not package.satisfies(req)]
    return dict(complete=not missing, gaps=missing,
                label="foundation-quality" if not missing else "working")
```

The **confidence gate ensembles three signals** (verbalized LLM uncertainty across N samples, cross-model agreement, Bayesian posterior when a physical/statistical model exists), because LLM-as-judge is known to be systematically overconfident at the top end (TH-Score, arXiv:2508.06225) — Verga et al.'s "Replacing Judges with Juries" (2024) pattern applies. The **novelty gate** sits on top of a PaperQA2-style retrieval (Skarlinski et al., arXiv:2409.13740, FutureHouse) plus ECFP4 similarity; FutureHouse's ContraCrow adds a fourth `CONTRADICTED_IN_LIT` label useful for repurposing work. The **regulatory-scaffold gate is the flagship non-GxP gate**: it reports *gaps* (not blocks) so that exploratory work can later be *mechanically promoted* into a foundation artifact (§9) when the missing pieces arrive.

---

## 4. Tool catalog redesigned for velocity

Every tool is wrapped as a typed JSON-schema function (MCP or OpenAI function-calling). All chemistry inputs are canonicalized (InChIKey + canonical SMILES, neutralized, tautomer-normalized with RDKit `rdMolStandardize`) before any lookup or write. Heavy compute (docking, xTB/CREST, DFT) returns job handles; poll via a separate tool. Cache external API results keyed by `(endpoint, canonical_input, version)` with TTL. The reference pattern is **ChemCrow's 18-tool ReAct loop** (Bran et al., *Nat. Mach. Intell.* 6:525, 2024), scaled and extended.

**Cheminformatics core.** **RDKit 2025.09** (BSD-3) is the in-process baseline (standardize, fingerprints via `rdFingerprintGenerator.GetMorganGenerator`, ETKDGv3 conformers, ChemicalReaction SMARTS). **rdChiral** (MIT) for stereo-aware template application — required for AiZynthFinder templated expansions. **OpenBabel 3.1** behind an HTTP microservice to wall off GPL-2.0. **CGRtools** 4.x for condensed graph-of-reaction hashing and de-duplication of USPTO/Pistachio corpora.

**Retrosynthesis and reaction prediction.** **AiZynthFinder** (MIT, AstraZeneca) — wrap as `POST /aizynth/plan` with `{smiles, stock, expansion: [uspto, ringbreaker, chemformer], iteration_limit, time_limit, break_bonds, freeze_bonds}`. **ASKCOS v2** (MPL-2.0, MIT) — `askcos-deploy` docker-compose stack; endpoints `/api/v2/tree-builder`, `/forward`, `/context`, `/impurity`, `/selectivity`. **IBM RXN** (`rxn4chemistry`) as the orthogonal forward validator. **Synthia** SaaS when licensed. **RetroBioCat/BioNavi-NP** for biocatalytic branches.

**Structure generation and docking.** **REINVENT 4.6** (Apache-2, MolecularAI) as the canonical generative RL; config in TOML, scoring plugins via namespace packages. **DrugEx** (MIT) for scaffold-constrained design. **MolFormer-XL** (IBM, Apache-2, HF `ibm/MoLFormer-XL-both-10pct`) as the production SMILES embedder; **ChemBERTa-2/3** alternatives. Docking: **GNINA 1.3** (McNutt et al., *J. Cheminform.* 2025) is the recommended open-source pose + CNN-rescoring primary; **AutoDock Vina 1.2** baseline; **DiffDock-L** (Corso et al. 2024) for exploration, always re-ranked by GNINA with **PoseBusters** physical checks; **Glide** when licensed.

**Property prediction.** **chemprop v2** (MIT; *JCIM* 2025) is the internal-QSAR workhorse — PyTorch Lightning, multi-GPU, MVE/evidential/ensemble uncertainty. **DeepChem** for benchmarking and scaffold splits. **ADMETlab 3.0** for hosted ADMET with AD flags. **ProTox-3.0**, dedicated **hERG** (Pred-hERG 5.0, BayeshERG), **Ames/DILI** chemprop-trained on ChEMBL with provenance tracking.

**Literature.** **PaperQA2** (v2025.12.x, MIT-like) wrapped behind our own MCP so we can inject ELN corpora and attach DOI→internal-note links; use `settings='high_quality'` for deep queries. **Semantic Scholar Academic Graph API** (via community MCP server — note multiple community implementations exist, none officially canonical). **Europe PMC**, **OpenAlex**, **Unpaywall**, **PubMed E-utilities**. **Reaxys Data API** and **CAS Insights** when enterprise-licensed.

**Computational chemistry.** **xTB 6.7 / GFN2-xTB + ALPB solvent** (LGPL-3) as the workhorse for single-points and preopt; **CREST 3.x** (Pracht et al. *JCP* 160:114110, 2024) for conformer/rotamer ensembles (`--gfn2 --alpb water --ewin 6.0 -T 12` default). **ORCA 6** for DFT (`r2SCAN-3c` or `ωB97X-3c` composites; `DLPNO-CCSD(T)/cc-pVTZ` benchmark). **Gaussian 16** when licensed. **PySCF** for scripted ab initio. **spyrmsd** for symmetry-aware pose RMSD.

**Databases.** **PubChem PUG REST** (5 req/s), **ChEMBL 35** (Python client + bulk dumps), **ZINC22 / CartBlanche** (Tingle et al., *JCIM* 2023 — ~55 B make-on-demand enumerable), **BindingDB**, **CSD via CCDC Python API** (licensed), **Reaxys** (licensed), **USPTO Lowe set** (CC0, ~1.8 M reactions), **Open Reaction Database** (Kearnes et al., *JACS* 143:18820, 2021; Apache-2 Protobuf).

**Project/knowledge connectors.** **Benchling API + SDK** (primary ELN); **LabArchives** / **Signals Notebook** / **eLabFTW** alternatives. Confluence/Notion/SharePoint via their REST APIs. **GitHub REST+GraphQL** and **Jupyter `nbformat`** for code versioning and notebook indexing. **The harness never autonomously mutates the compound registry or ELN** — writes go through a `proposed_write → human review queue → Benchling POST` flow, even in non-GxP.

**Indicative tool schema (chemprop predict):**
```python
@tool
def chemprop_predict(ckpt_uri: str, smiles: list[str]) -> list[dict]:
    model  = MPNN.load_from_checkpoint(ckpt_uri)
    ds     = MoleculeDataset([MoleculeDatapoint.from_smi(s) for s in smiles])
    preds  = trainer.predict(model, build_dataloader(ds))
    return [{"smiles": s, "value": float(v), "uncertainty": float(u),
             "ad_flag": applicability_domain(s, model)}
            for s, (v, u) in zip(smiles, preds)]
```

---

## 5. Knowledge and context management

Three-tier memory is the clean architecture: **working memory** (per-session scratchpad, tool-call traces, intermediate tensors — LangGraph `StateGraph` + Redis TTL), **project memory** (facts, decisions, hypotheses, contradictions — recommend **Zep/Graphiti** for temporal knowledge graphs so you can answer "what did we believe about this compound in Q2 2025 vs now?"; **Letta** or **Mem0** are alternatives), and **organizational knowledge** (ELN, literature corpus, compound registry, decision logs — Neo4j KG + vector store + ELN).

**Scientific decision log** (one JSON object per reasoning session, mirrored as `(:DecisionLog)` KG nodes) is the primary accumulation mechanism. Required fields: `{decision_id, project_id, timestamp, author_agent, author_human, question, hypothesis_refs, evidence[]{type,id,weight}, reasoning_trace, tools_used[]{name,call_id,ckpt_sha}, decision, confidence, risks[], next_actions[], dissent[], version, supersedes}`. Versions form a supersession chain; never silently rewrite.

**RAG architecture for scientific heterogeneous content.** Parsing: **Marker** (Surya OCR + LayoutLMv3 + Qwen-VL cleanup) as the primary PDF→Markdown pipeline in 2026, with **Nougat** for math-dense papers and **GROBID** for references only; tables via **Table Transformer (TATR)** + LLM cell normalization; chemical structures in figures via **DECIMER/MolScribe**; reaction schemes via **RxnScribe/ReactionDataExtractor2**. Chunking is content-type aware: **body text** semantic at 800–1200 tokens with 10–15% overlap preserving section name as metadata; **reaction/property tables** serialized *row-wise* with column names + caption + context (never chunked by token count); **spectra descriptions** as single chunks tagged `{technique, solvent, instrument, compound_id}`; **compound/SI lists** per-compound with `{compound_id, SMILES, yield, characterization_set}`. Retrieval is **hybrid BM25 + dense** via **Reciprocal Rank Fusion (k=60)**, with a cross-encoder re-ranker (`bge-reranker-v2-m3`) on top-50 and PaperQA2-style LLM contextual summarization on top-10. Chemistry similarity is a separate index: **FAISS IVF+PQ over MolFormer-XL embeddings + ECFP4** with RDKit `rdSubstructLibrary` for substructure screening.

**Knowledge graph schema** (Neo4j 5 / KuzuDB property-graph):

```cypher
(:Compound {id, inchi_key, canonical_smiles, mw, logp, qed, is_public, chembl_id, pubchem_cid})
(:Batch {id, lot, purity, date})
(:Reaction {id, rxn_smiles, cgr_hash, conditions, yield})
(:Experiment {id, type, date, protocol_ref, eln_entry})
(:Measurement {id, endpoint, value, unit, qualifier, uncertainty, replicate_n})
(:Target {id, gene, name, organism})
(:LiteratureDoc {doi, pmid, openalex_id, s2_id})
(:Claim {id, text, confidence})
(:Hypothesis {id, text, status})
(:Scientist {id, name, orcid})
(:Project {id, codename, phase})
(:DecisionLog {id, summary, date})
(:Tool {id, version})

(:Batch)-[:BATCH_OF]->(:Compound)
(:Reaction)-[:PRODUCES|:CONSUMES|:USES_REAGENT]->(:Compound)
(:Experiment)-[:MEASURED]->(:Measurement)-[:OF]->(:Compound)
(:Measurement)-[:AGAINST]->(:Target)
(:LiteratureDoc)-[:REPORTS]->(:Claim)-[:SUPPORTS|:CONTRADICTS]->(:Hypothesis)
(:DecisionLog)-[:CITES {role}]->(:Measurement|:Claim|:LiteratureDoc)
(:Compound)-[:ANALOG_OF {sim}]->(:Compound)     // ECFP4 Tanimoto
```

Example query — "contradictions of my hypothesis":
`MATCH (h:Hypothesis{id:'HYP-045'})<-[r:CONTRADICTS]-(cl:Claim)<-[:REPORTS]-(d:LiteratureDoc) RETURN d.doi, cl.text, r.weight`.

**Contradictory results in exploratory settings** get much more permissive handling than GxP: an ambiguity gate may explicitly commit to a working hypothesis while tracking the contradiction as `(:Claim)-[:CONTRADICTS]->(:Hypothesis)` for later reckoning. The agent "moves on" when EIG of further investigation < cost of delay *and* the contradiction doesn't touch a foundation-tier artifact.

---

## 6. Sensors for proactive research

Architecture: `webhook → event bus (Kafka/NATS) → sensor-matcher → agent workflow → reward-model filter → notification router`. The reward-model filter is the non-optional bit; without it, a proactive agent becomes noise (ProactiveBench, Lu et al., ICLR 2025, reports SOTA F1 only ~66%; PROBE, arXiv:2510.19771, shows ≤40% frontier-agent success on real-world proactive bottleneck-resolution).

**Sensor catalog (YAML-style spec, directly implementable):**

```yaml
- id: eln_entry_signed
  trigger: {source: ELN_webhook, filter: "event.type=='entry.signed' AND entry.project IN user.projects"}
  action:  {agent: qc_analyst, tasks: [extract_yield, check_spectra, update_dashboard, flag_anomalies, propose_next_experiment]}
  priority: P2

- id: litalert_target_class
  trigger: {source: [pubmed_rss, biorxiv, chemrxiv, uspto_patents], cron: "*/30 * * * *",
            filter: "match(abstract, user.targets + user.scaffolds) AND novelty_score > 0.6"}
  action:  {agent: lit_scout, tasks: [summarize, relate_to_projects, file_in_zotero]}
  priority: P3
  dedup_window: 24h

- id: ftO_alert
  trigger: {source: patent_stream, filter: "claim_overlap(user.scaffolds, patent.claims) >= 0.7"}
  action:  {agent: ip_liaison, tasks: [draft_ftO_summary, notify_IP_team_and_lead]}
  priority: P1

- id: synthetic_dead_end
  trigger: {source: "ELN + retrosynth_logs",
            filter: "failures_in_14d(target) >= 3 AND yields_all < 10%"}
  action:  {agent: route_strategist, tasks: [propose_orthogonal_disconnection, simulate_top_3]}
  priority: P2

- id: cross_project_scaffold
  trigger: {source: compound_registry_diff,
            filter: "tanimoto(new_compound, any_active_project.lead) >= 0.8"}
  action:  {agent: knowledge_bridge, tasks: [notify_both_leads, propose_meeting]}
  priority: P3

- id: stale_hypothesis
  trigger: {cron: weekly,
            filter: "hypothesis.age_days > 45 AND experiments_since_create == 0"}
  action:  {agent: project_coach, tasks: [nudge_PI, propose_decisive_experiment]}
  priority: P4

- id: reagent_inventory_low
  trigger: {source: inventory_db, filter: "stock(reagent) < planned_consumption_30d"}
  action: [auto_reorder_if_approved, notify_ops]
  priority: P2

- id: analytical_queue_overloaded
  trigger: {source: LIMS, filter: "queue_depth(instrument) > 1.5 * mean_7d"}
  action:  {agent: scheduler, tasks: [reroute_samples, negotiate_priority, warn_projects]}
  priority: P2
```

**Routing and noise management:**

```python
def route_notification(event, candidate):
    score = reward_model.score(event, candidate, user_context(candidate.recipient))
    if score < user_thresholds[candidate.recipient].fire:
        return hold(candidate, bundle_for_digest=True)
    if user.in_focus_mode and candidate.priority > P1:
        return defer_until(user.next_break)
    if user.notifications_today >= daily_cap[candidate.priority]:
        return bundle_into_morning_digest(candidate)
    return push(candidate.channel, candidate)
```

Practical heuristics from HCI research and ProactiveBench/ContextAgent (NeurIPS 2025, arXiv:2505.14668): per-user priority caps; bundle low-priority into a single morning digest; "dismiss three times → auto-mute 14 days"; explicit `/teach` command that captures user corrections as training data for the reward model (Reflexion-style verbal feedback). Non-GxP latitude lets us set the reward-model precision threshold at ~0.6 (ten speculative hypotheses with two hits beats silence); in a GxP-adjacent sensor this would need to be ~0.95.

---

## 7. Self-evolution: how freely and how safely

Without GxP constraints, the harness can self-evolve **daily**, not quarterly. Three hard rails still apply: *correctness over speed* (every playbook update passes a frozen regression suite of golden chemistry tasks), *reproducibility* (git-tagged playbook versions, version ID captured in every produced artifact), and *scientific integrity* (never silently rewrite a skill used to generate an already-surfaced claim — **fork** instead).

**Playbook update protocol** (synthesis of Reflexion + SELF-REFINE + Voyager skill library + ADAS archive-guided search):

```python
class Playbook:
    version: str
    skills: Dict[str, SkillDef]

    def propose_update(self, episode):
        reflection = self.reflector.reflect(
            task=episode.task, trajectory=episode.trace,
            outcome=episode.outcome, ground_truth=episode.reference)
        if reflection.novelty_score < 0.3: return None
        delta = self.curator.distill(reflection)
        delta.confidence = bayes_update(
            prior=self.skills[delta.skill].confidence,
            evidence=episode.outcome)
        return delta

    def commit(self, delta):
        # A/B fork instead of hard overwrite
        new_skill = self.skills[delta.skill].fork(delta)
        self.skills[delta.skill + "@candidate"] = new_skill
        self.schedule_ab_test(
            baseline=delta.skill,
            candidate=delta.skill + "@candidate",
            traffic=0.2,
            promotion_rule="win_rate >= 0.55 AND n >= 30")

    def promote_or_retire(self):
        for name, skill in self.candidates():
            stats = self.ab_stats(skill)
            if stats.promote: self.replace(name.rstrip("@candidate"), skill)
            elif stats.retire: del self.skills[name]
```

**Learning from failure — chemistry specialization:**

```python
def on_synthesis_dead_end(target, failed_routes, k=3):
    if len(failed_routes) < k: return None
    fp = cluster_failures(failed_routes)
    lesson = reflector.reflect(target, failures=fp,
                               tools=["ASKCOS","AiZynthFinder","literature"])
    alts = retrosynth.propose(target, avoid=fp.bonds,
                              prefer=lesson.suggested_bonds, n=5)
    playbook.propose_update(Episode(target, outcome="dead_end", reflection=lesson))
    return alts
```

**Can the agent maintain its own reaction database?** Yes — with the A/B fork discipline above. When the lab observes "Buchwald-Hartwig with XPhos works on electron-poor aryl chlorides at 80 °C in THF," that becomes a candidate `SkillDef` forked from the generic BH skill, tagged with substrate-class applicability (`elec_poor_arCl`, 80 °C, THF), and gated into production only after 30+ wins at ≥55% against the baseline condition recommender.

**Literature pointers.** Reflexion (Shinn et al., NeurIPS 2023, arXiv:2303.11366) for verbal reinforcement; SELF-REFINE (Madaan et al., NeurIPS 2023, arXiv:2303.17651); Voyager (Wang et al., TMLR 2023) for skill libraries; ADAS/Meta-Agent Search (Hu/Lu/Clune, ICLR 2025, arXiv:2408.08435) for archive-guided agent evolution; **ether0** (FutureHouse, arXiv:2506.17238) as proof that RL-with-verifiable-rewards works for chemistry when rewards are grounded in experiments. Chemistry-specific: ChemReasoner (Sprueill et al., ICML 2024) for LLM-plus-GNN-oracle search; A-Lab's ARROWS³ active-learning loop (Szymanski et al., *Nature* 624:86, 2023 — note 2026 correction at *Nature* 650:E1 on the 41-novel-compounds headline); Coscientist's post-publication scaling to >1000 reactions/weekend. **Independent critique of Sakana AI Scientist-v2** (Beel et al., arXiv:2502.14297) found 42% experiment failure due to code errors — treat fully-autonomous frontier systems as [EXPLORATORY]-tier only in the harness.

---

## 8. Proactive intelligence: concrete behaviors

**Morning briefing** pattern — a single digest per scientist, generated overnight:

```
# Morning brief, 2026-04-23, for Dr. Patel
## Overnight results (auto-pulled from ELN + LIMS)
- Project X: compound X-142, HPLC 97.2% purity, NMR consistent with target. [WORKING]
- Project Y: Suzuki coupling — 3 of 4 conditions failed. See analysis ▸

## New literature matching your targets (3 of 27 after filtering)
- Nat Chem Biol, DOI 10.xxxx/yyy — may be relevant to your KRAS-G12D series. Why ▸

## Decisions waiting on you
- Route selection for target Z (agent recommends disconnection B, 78% confident).

## Risks
- Reagent Pd(OAc)₂ stock low; 2-week lead time; 4 active projects affected.

## Stale items
- Hypothesis H-44 untouched for 52 days. Retire or act?
```

**Decision support on demand.** When a scientist asks "should I run DoE or just vary one factor at a time?" the agent invokes `doe_planner` with the factor count, budget, and phase; returns a design recommendation with alias structure, expected information gain per run, and an explicit trigger condition for switching to Bayesian optimization (factors >6, or expensive experiments, or multi-objective).

**Unprompted insight generation** uses an interrupt-cost model:
```python
def should_surface_unprompted(insight):
    return (insight.novelty > 0.6
            and insight.relevance_to_active_projects > 0.7
            and insight.expected_value_of_info > COST_OF_INTERRUPTION
            and not already_known(insight, user.kg)
            and user_context.accepts_interruption_now())
```
This is how "three independent experiments across two projects show a similar reactivity pattern" ends up surfaced without being asked.

**Failure analysis** runs a multi-cause investigation *before* the scientist asks, inspired by the A-Lab failure taxonomy:
```python
def investigate_failure(exp):
    hypotheses = [
      H("instrument",  calibration_history(exp.instrument)),
      H("reagent",     lot_qc(exp.reagents)),
      H("protocol",    diff_vs_last_successful(exp)),
      H("operator",    training_status(exp.operator)),
      H("substrate",   structural_risk_factors(exp.substrate)),
      H("environmental", ambient_logs(exp.date))]
    ranked = bayesian_rank(hypotheses, prior=base_rates, likelihood=evidence)
    return [h for h in ranked if h.posterior > 0.15]
```

**Milestone back-planning** computes the critical path from milestone to today, applies a 1.3× buffer, and flags steps whose `latest_start < today + lead_time`. Multi-project synthesis reuses the cross-project scaffold-similarity sensor (§6) and a reagent-sharing graph across ELN inventories.

**Interaction model.** Pull-by-default for exploratory/literature. Push only for P1/P2 sensors (FTO, synthetic dead-ends, analytical-queue overload, reagent-stockout blocking a planned experiment). Everything else goes to digest. Every surfaced item includes a "why I'm telling you this" trace and a one-click `dismiss+teach`. **Assertiveness calibration** follows the constitution: confident when ≥2 orthogonal methods agree and tools in-domain; hedge when single-source or out-of-domain; defer when safety/IP/budget-sensitive; ask when cheap clarification changes the plan.

---

## 9. Regulatory-foundation artifacts: scaffold, never author

The agent sits *upstream* of regulatory writing. It produces structured, machine- and human-readable **foundation artifacts** dense enough that a regulatory writer can lift content directly into a submission; it does not write the submission. This is exactly the low-risk context-of-use zone in the FDA's January 2025 draft guidance "Considerations for the Use of Artificial Intelligence to Support Regulatory Decision Making" — human-in-the-loop authoring assistance for non-decisional content, sidestepping the heavier credibility-assessment framework.

**CTD Module 3 sections most amenable to agent-generated foundations:**

| Section | Scientific substrate | Foundation artifact |
|---|---|---|
| 3.2.S.1 | Identifiers, structure, physchem | Substance Identity Card (JSON with InChI, UNII, computed descriptors, experimental table) |
| 3.2.S.2.2/3/4/6 | Synthesis route, SM controls, critical steps, development history | Synthesis Narrative Package (one ORD Reaction per step + aggregated Dataset), Materials Dossier, Critical Step Matrix, Development Narrative |
| 3.2.S.3.1 | NMR, HRMS, IR, UV, XRPD, SC-XRD, DSC/TGA | Structure Elucidation Package (per-technique assignment tables + cross-technique consistency check) |
| 3.2.S.3.2 | Impurities: origin, fate, control | Impurity Fate Map (graph: reagents → intermediates → DS, nodes tagged by M7 class and purge factor) |
| 3.2.S.4.1–5 | Specifications, methods, validation, batch analyses | Specification Rationale Package, Method Descriptions (AnIML-compatible), Validation Data Package (ICH Q2(R2) + Q14 ATP-aligned), Batch Analysis Table |
| 3.2.S.7.1–3 | Long-term/accelerated/stressed stability | Stability Foundation (Q1A matrix + Arrhenius fits + mass balance + shelf-life CI) |
| 3.2.P.2 | Formulation development | Formulation Development Dossier (DOE results, compatibility matrix, dissolution, CCS rationale, E&L screening) |

**Example foundation artifact** (synthesis step, ORD-compatible YAML):

```yaml
artifact_type: synthesis_step
artifact_id: fnd-synth-step-04-a6f3
maturity: foundation      # vs exploratory | hypothesis
ctd_target: ["3.2.S.2.2", "3.2.S.2.4", "3.2.S.3.2"]
reaction:
  identifiers: [{type: REACTION_SMILES, value: "..."}]
  inputs:
    amine_coupling_partner:
      components:
        - identifiers: [{type: SMILES, value: "NCc1ccccc1"}]
          amount: {mass: {value: 12.5, units: GRAM}}
          role: REACTANT
          is_limiting: true
    coupling_reagent:
      components:
        - identifiers: [{type: NAME, value: "HATU"}]
          amount: {mass: {value: 35.0, units: GRAM}}
          role: REAGENT
  conditions:
    temperature: {setpoint: {value: 0, units: CELSIUS}, ramp_to: 25}
    stirring: {rate: {value: 400, units: RPM}}
    atmosphere: NITROGEN
  workups:
    - {type: EXTRACTION, details: "aq. NaHCO3 3x100 mL, brine, Na2SO4"}
  outcomes:
    - analyses:
        hplc_purity: {type: LC, data_ref: "adf://batches/lot-042/hplc-run-17.adf"}
        nmr_identity: {type: NMR_1H, data_ref: "animl://nmr/lot-042-1h.animl"}
      products:
        - identifiers: [{type: SMILES, value: "..."}]
          is_desired_product: true
          measurements:
            - {type: YIELD, percentage: {value: 87.3}}
            - {type: PURITY, percentage: {value: 99.1}, analysis_key: hplc_purity}
  provenance:
    record_created: "2026-03-14T10:22Z"
    experimenter: {orcid: "0000-0002-xxxx"}
    eln_ref: "benchling://entry/abc123"
scientific_rationale:
  route_selection: "HATU chosen over EDC/HOBt: +15% yield in screening (ref: fnd-route-scout-03)"
  impurity_fate:
    - {impurity_id: imp-hobt-residue, origin: "HATU byproduct",
       control: "purged to <0.05% in aq. workup, confirmed by LC-MS", purge_factor: 340}
review_state: {ai_generated: true, scientist_reviewed: false, regwriter_consumed: false}
```

**Progressive hardening.** Artifacts begin as `maturity: exploratory` (retrosynthesis proposals, in-silico impurity structures, Arrhenius extrapolations beyond tested range — never consumed directly by regulatory writing), promote to `hypothesis` (partial experimental evidence, used for planning and DOE), and promote to `foundation` only after scientist sign-off passes the scaffold gate (§3).

**Handoff pipeline:**
```
[1] Raw lab data in ELN/LIMS + literature corpus (ADF/AnIML/JCAMP-DX, ORD, SiLA streams, papers)
     │
[2] AI Foundation Agent (non-GxP): ingests via FAIR connectors; applies ICH-aware templates;
     emits artifacts at maturity exploratory/hypothesis; runs gates G1–G7;
     produces dual outputs (JSON/YAML + Markdown).
     │
[3] Scientist review (handoff #1): RO-Crate bundle [ro-crate-metadata.json + artifact.yaml +
     artifact.md + /raw_data symlinks/DOIs]. Scientist verifies, corrects, signs off →
     promotes to foundation; gate G8 satisfied.
     │
[4] Regulatory writer (handoff #2): consumes foundation RO-Crate; applies CTD M4Q templates;
     adds regulatory voice/framing; cross-references other modules; verifies against
     GxP-controlled source systems (LIMS, validated ELN) before citing; produces the
     Module 3 PDF/Word submission.
```

**The agent never writes the regulatory document.** It scaffolds it. FAIR compliance (data-centric) via ADF/AnIML/SiLA/ORD/JCAMP-DX + W3C PROV + RO-Crate is achieved *without* claiming ALCOA+/Part 11 compliance (document-centric regulatory audit). The two are complementary but distinct. The scientific-rationale fields explicitly tag ICH references (`justification_ref: "ICH Q11 §5.1.1 principle 3"`, `rationale_ref: "ICH Q3A(R2) threshold 0.15% for daily dose <2g"`) so a regulatory writer can trace guideline linkage without the agent having made a regulatory claim. The **Celegence CAPTIS** and **Merck-McKinsey CSR** tool lineage demonstrates that component-based content libraries + metadata validation yield 80%+ first-draft alignment; the foundation agent sits one step upstream and feeds those writer tools with tighter substrate.

---

## 10. Where the non-GxP framing changes the design

This is the cheatsheet for engineering decisions that shift when the GxP overlay is removed:

1. **Gates annotate, not block.** The only BLOCKing gates are safety (CW/explosive/controlled-substance à la ChemCrow) and calibration-failure on quantitative claims. Everything else WARNs and downgrades maturity tier. A `[WORKING]` output with WARN gate is still useful.
2. **No Part 11 e-signatures → daily playbook A/B.** Playbook updates run with a 30-trial minimum-n, 55% win-rate promotion rule; prompt versioning is git, not a validated LMS. This is ~50× faster cadence than GxP change control allows.
3. **Lightweight audit trail for exploratory tier.** Only `[FOUNDATION]`-tier artifacts get a full provenance DAG (W3C PROV + RO-Crate + ADF/AnIML linkage). Exploratory outputs carry only `{tool_id, version, input_hash, output_hash, timestamp}` — storage and latency drop ~10×.
4. **Permissive tool use, tiered by maturity.** Web search, patent databases, non-peer-reviewed preprints are fair game for `[EXPLORATORY]`; gated for `[WORKING]`; whitelisted/curated sources only for `[FOUNDATION]`.
5. **Proactive sensor precision threshold ~0.6, not ~0.95.** Ten speculative hypotheses with two hits beats silence. The reward-model filter handles false-alarm fatigue.
6. **Self-evolution allowed in production** with A/B forking, regression tests, and fork-not-rewrite discipline. Not allowed: silent replacement of a skill that produced an already-surfaced claim.
7. **No CSV/GAMP5 validation required** — but correctness, reproducibility, and scientific integrity are inviolable. Safety rails (CW, explosive, controlled substance, dual-use bio/chem, IP/FTO, personal data) transfer verbatim from ChemCrow.
8. **Promotion path preserved.** The scaffold gate (§3) ensures that a `[WORKING]` artifact can be mechanically promoted to `[FOUNDATION]` when missing pieces (HRMS, ≥2 replicate data, orthogonal confirmation) arrive. **This is the load-bearing mechanism that connects fast R&D to future GxP validation work** without contamination between the two.

The net effect: GxP asks "can I prove nothing happened wrong?" — non-GxP R&D asks **"did I maximize decision quality per scientist-hour?"**. Both are legitimate questions; this harness answers the second one, while making it trivial to later answer the first over any artifact worth promoting.

---

## Conclusion: the shape of a velocity-first harness

A harness optimized for scientific velocity is *not* a GxP harness with the compliance layer removed — it is a fundamentally different architecture whose load-bearing elements are maturity tiers, deterministic chemistry tools behind typed schemas, annotating gates, reward-filtered proactive sensors, A/B-forked self-evolving playbooks, and a carefully scoped foundation-artifact pipeline. The most important single design primitive is the **exploratory / working / foundation** maturity label, because it is what lets the agent be aggressive, proactive, and speculative in 90% of its output while producing a clean, promotable substrate for the 10% that will eventually seed regulatory documents. The most important single engineering discipline is **tool-first, model-last**: the LLM plans, disambiguates, and narrates; RDKit, chemprop, ADMETlab, ASKCOS, AiZynthFinder, SIRIUS, CREST, PaperQA2, BoFire, and Derek/Sarah do the quantitative chemistry, every one of them wrapped as a typed function with a canonicalized input, a version-pinned output, and an uncertainty estimate. The most important single cultural shift is tolerating speculation in `[EXPLORATORY]` tier without letting it leak — because the only way to reach superhuman research throughput is to think fast and fork cheap, while keeping the pipeline to the regulatory writer sparse, clean, and surgical.