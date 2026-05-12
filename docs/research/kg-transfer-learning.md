# Cross-project KG transfer for ChemClaw

**Status:** research / pre-ADR. Maps existing infrastructure, surveys methods, recommends a phased plan.
**Author:** agent-claw research session (`claude/kg-transfer-learning-research-47oKT`).
**Scope:** transfer of *KG-level* knowledge (compounds, reactions, conditions, experimental outcomes) across project boundaries while preserving RLS guarantees, the bi-temporal validity contract, and confidence pedigree.

## 1. Problem statement

ChemClaw runs N pharmaceutical projects in a single Postgres + Neo4j deployment. Each project's reactions, experiments, hypotheses, and synthesis steps are gated at the row level by `app.current_user_entra_id` ↔ `user_project_access` (`db/init/12_security_hardening.sql:162-200`) and at the Neo4j layer by `group_id = project_id` filters (`services/projectors/kg_experiments/main.py:178,207`; `services/mcp_tools/mcp_kg/models.py:53-124`).

Knowledge gained inside one project does not currently propagate to another in any principled, policy-controlled way:

- A solvent / temperature window that worked for a Buchwald-Hartwig in project A is invisible to the agent operating in project B, even when project B is studying a structurally adjacent substrate.
- Negative results (failed conditions, refuted hypotheses) — which are the most valuable cross-project signal — are entirely siloed.
- The same compound appears as **two** Neo4j nodes when both projects import it (one under each `group_id`), even though Postgres treats it as a single canonical row keyed by `inchikey`.
- A skill or forged tool validated in one project cannot use the other projects' history as evidence for promotion to `WORKING` / `FOUNDATION` maturity.

The user-facing question is therefore: **how should ChemClaw transfer KG-level knowledge across project boundaries without breaking RLS, without leaking PII / IP, and without inventing a parallel data plane that bypasses A-on-C event sourcing?**

## 2. Constraints that shape the design

These are not opinions; they are inherited from the platform.

1. **RLS is non-negotiable** (`db/init/12_security_hardening.sql:162-200`). User-facing code must never connect as `chemclaw` (table owner) or `chemclaw_service` (BYPASSRLS). Cross-project transfer therefore cannot mean "let user U see project B's rows" — it has to mean "expose project-B-derived knowledge in a form that does not constitute project-B row access for U."
2. **A-on-C event sourcing.** Derived views are built only by projectors subscribed to `ingestion_events`. Any cross-project artifact must either be (a) emitted as its own event type, or (b) computed by a projector and cleanly replayable by deleting from `projection_acks`. No side-channel writes to derived state.
3. **Bi-temporal contract** (`db/init/17_unified_confidence_and_temporal.sql:18-84,32-47,89-106`). Every claim has `valid_from` / `valid_to`; reactions and artifacts have `confidence_score NUMERIC(4,3)`. Transferred knowledge must inherit a *defensible* validity window — not silently re-stamped to "now," and not blindly carrying the source project's window.
4. **Confidence is scalar, not attributed.** `confidence_score` does not record *which* sources contributed. Cross-project propagation cannot just copy the score; it has to re-score in the recipient's evidence frame or carry an explicit pedigree column.
5. **Graphiti / Neo4j Community.** GPL-3 server-side; no binary redistribution. Anything we pretrain and persist as Neo4j artifacts has to live in our own tables, not as model weights baked into the Graphiti container.
6. **LLM egress chokepoint** (`services/litellm_redactor/`). Redaction is the only line of defense against names / SMILES / NCE-IDs leaking to a model provider. Transfer infrastructure that surfaces project-B substrings to project-A's user (e.g., raw SMILES in a recommendation) re-opens the channel that egress redaction was built to close.

## 3. Three different things called "transfer"

This terminological tangle is the most common source of muddled designs. The doc separates them.

### 3.1 Schema / ontology transfer
Type system (`Compound`, `Reaction`, `Condition`, `Experiment`, …) and predicate vocabulary (`PART_OF_PROJECT`, `PART_OF_STEP`, …) are defined **once** in `services/projectors/kg_experiments/main.py` and `services/mcp_tools/mcp_kg/models.py` and apply to every project. **Already done; trivial; no privacy concern.**

### 3.2 Entity-level transfer (canonicalization)
Same compound (same InChIKey) referenced by multiple projects. The right answer is **one canonical compound entity** with project-agnostic structural / public-knowledge properties (SMILES, InChI, MW, fingerprint, descriptors, public-source classifications) and **per-project edges** (`compound→experiment`, `compound→outcome`, …) that stay project-scoped.

In Postgres this is **already** the design: `compounds` is globally readable subject to an authenticated session (`db/init/12_security_hardening.sql:162-180`), `compound_smarts_catalog` / `compound_substructure_hits` / `compound_classes` / `compound_class_assignments` are global-with-auth-gate (`db/init/39_compound_catalog_rls.sql:14-16,44-45`), and the `compound_fingerprinter` (`services/projectors/compound_fingerprinter/main.py:1-15`) and `compound_classifier` (`services/projectors/compound_classifier/main.py:1-92`) projectors run as `chemclaw_service` to update them per-InChIKey regardless of which project triggered the change.

In Neo4j it is **mostly already** the design — earlier framing of this section was wrong and is corrected here. `kg_experiments/main.py:178` sets `scope_group_id = bundle["project_id"]` and reuses it for every `write_fact` call, but the generated Cypher (`services/mcp_tools/mcp_kg/cypher.py:118-122`) merges nodes by `(label, id_property: id_value)` ONLY — `group_id` lives on the **edge** (`r.group_id = $group_id`), not the node MERGE pattern. So two projects writing the same InChIKey share **one** Compound node; only the reaction edges (`HAS_REAGENT`, `HAS_PRODUCT`, …) are project-scoped. This invariant is locked by `tests/unit/mcp_kg/test_cypher.py::TestCompoundCanonicalizationInvariant`.

What does **not** yet work, and is the real Track A remainder:
- **Property-write attribution**: `ON CREATE SET o += $object_properties` fires only on the first write, so structural properties (SMILES, MW, …) are stamped by whichever project first ingested the compound and never refreshed. A `Compound.contributed_by_projects: UUID[]` property — appended on every write, not just CREATE — needs a new MERGE clause (`SET o.contributed_by_projects = coalesce(o.contributed_by_projects, []) + $project_id` with array-distinct logic) and an extension to `write_fact`'s contract.
- **The compound_catalog projectors** (`compound_fingerprinter`, `compound_classifier`) maintain the global Postgres catalog but don't write to Neo4j at all. Closing the loop would require either a new projector that materialises the public catalog into Neo4j or extending the existing pair.

This is the single highest-ROI fix, and it is not "transfer learning" in the ML sense — it is canonicalization.

### 3.3 Statistical / embedding transfer (the actual ML question)
Patterns inferred from project A's edges (yield distributions, condition success rates, motif → outcome statistics) inform an inference made on project B's compounds without exposing project A's rows.

This decomposes further:

| Sub-flavour | What moves | Privacy lever |
|---|---|---|
| **a. Public-pretrained features** | Public-only weights / embeddings | None needed; no private data ever entered training |
| **b. Federated / DP-SGD shared model** | Model parameters from pooled multi-tenant training | DP noise + secure aggregation |
| **c. Aggregate / motif transfer** | Low-dimensional summary statistics with k-anonymous filtering | k-thresholding + audit-logged reads |
| **d. Skill / tool promotion** | Validated reasoning routines, not data | Promotion gate + maturity tier |
| **e. KG embedding transfer (KGE)** | Entity / relation embeddings learned per-project | Either federated (b) or pretrained (a) |

ChemClaw already has a fragmentary surface for (a), (d) — `chemprop` is globally pretrained (`services/mcp_tools/mcp_chemprop/main.py:1-95`) and `skill_library.maturity` exists (`db/init/17_unified_confidence_and_temporal.sql:111-123`). It has a partial surface for (c) — see §4.2. It has no (b) or (e).

## 4. What ChemClaw already has

These are the non-trivial existing primitives the recommendation should build on, not replace.

### 4.1 `cross_learning` skill pack
`skills/cross_learning/SKILL.md:1-37` defines the `/learn` activation. Bundles `find_similar_reactions`, `expand_reaction_context`, `statistical_analyze`, `synthesize_insights`, `propose_hypothesis`, `query_kg` with `max_steps_override: 35`. Workflow is "broad DRFP search → group by project → expand top-2 reactions per project → aggregate condition variables → synthesize claims with `evidence_fact_ids`." All reads ride the user's RLS scope.

What this is: **discovery within the user's portfolio**. If user U has access to projects A, B, C, the skill can find a Buchwald-Hartwig pattern that spans them. What this is not: a transfer mechanism. The skill never *creates a new edge* in project B that imports knowledge from project A.

### 4.2 AD conformal-calibration bootstrap fallback
`services/agent-claw/src/tools/builtins/assess_applicability_domain.ts:199-231` is the only place in the agent surface where the system explicitly falls back to a cross-project read. When `fetchCalibrationRows` returns < 30 rows for the requested project, it re-queries without the project filter (still under RLS) and tags the calibration as `project_id: "__cross_project_bootstrap__"` (line 231). The conformal bands are then computed against the user's accessible reaction history, not project B's private rows.

This is the existing, small-but-correct precedent: **shared statistical structure, not shared rows.** It is also unaudited and not policy-gated — there is no admin lever to disable the fallback for a sensitive project, and no log entry tying the bootstrap fact to a specific cross-project read.

### 4.3 Global compound catalog + projectors
`db/init/39_compound_catalog_rls.sql:14-16,22-24,44-45` makes compounds, smarts catalog, substructure hits, classes, and class assignments globally readable subject only to an authenticated session. `services/projectors/compound_fingerprinter/main.py` listens on `pg_notify('compound_changed', inchikey)` and computes Morgan/MACCS/AP fingerprints per-InChIKey via mcp-rdkit. `services/projectors/compound_classifier/main.py:1-92` listens on `pg_notify('compound_fingerprinted', inchikey)` and writes bi-temporal `compound_class_assignments`. **Both bypass `ingestion_events` and use custom NOTIFY channels** — documented as the DR-06 pattern in `CLAUDE.md`.

The hard part is already paid for: a global namespace keyed by InChIKey, projectors that maintain it idempotently, and a clear "global with auth gate" RLS posture. The gap is at the Neo4j layer (§3.2).

### 4.4 DRFP global vector space
`services/projectors/reaction_vectorizer/main.py:1-45` writes `reactions.drfp_vector` for every reaction with `rxn_smiles IS NOT NULL`. The vector space itself is unified across all projects, but `reactions` is project-scoped under RLS — so users see only their own DRFP rows. `find_similar_reactions` (`services/agent-claw/src/tools/builtins/find_similar_reactions.ts:99-120`) joins `reactions_current → experiments → synthetic_steps → nce_projects` and exposes `project_internal_id` per result. Cross-project similarity *within a user's accessible projects* is real today; cross-tenant similarity is not.

### 4.5 Bi-temporal confidence schema
`db/init/17_unified_confidence_and_temporal.sql:18-84,32-47,89-106,111-123` confirms `reactions.confidence_score NUMERIC(4,3)` + tier, `hypotheses.valid_from/valid_to/refuted_at`, `artifacts.valid_from/superseded_at/confidence_score`, and `skill_library.maturity TEXT CHECK IN ('EXPLORATORY','WORKING','FOUNDATION')`. The schema is uniform across projects — no project-local confidence column to fork on transfer.

### 4.6 Project / org / global admin scoping
`services/agent-claw/src/middleware/require-admin.ts:19` defines `global_admin`, `org_admin <scope_id>`, `project_admin <scope_id>`. Every `/api/admin/*` mutation passes through `guardAdmin` and writes via `appendAudit` (`services/agent-claw/src/routes/admin/audit-log.ts`). This is the natural admin surface for any new "enable cross-project transfer for project X" toggle.

### 4.7 What does **not** exist
- **Per-write Compound property updates / project contribution tracking.** Node-level canonicalization works (§3.2 corrected), but `ON CREATE SET` semantics mean only the first write's properties stick. `Compound.contributed_by_projects` requires a write_fact extension.
- **Public catalog → Neo4j projection.** `compound_fingerprinter` / `compound_classifier` write to the Postgres global catalog but not to Neo4j, so the canonical compound nodes lack the fingerprint / classification properties that Postgres already maintains.
- Confidence pedigree (which projects' evidence contributed to a score).
- Audit log of cross-project bootstrap reads.
- Federated / DP-SGD anything.
- Per-project fine-tuning of `chemprop` or any other shared model.
- Maturity tiers tracking which projects have validated a skill (skill_library has `maturity` but no `validated_in_projects`).
- Aggregate / motif transfer projector with explicit k-anonymity.

## 5. Method survey

### 5.1 Foundation-model embeddings (no row transfer)
- **Chemprop v2 / DMPNN** — already deployed at port 8009 globally pretrained; the `(mean, std)` interface plugs into the confidence ensemble. Per-project fine-tune would require an MCP endpoint we don't have.
- **MoLFormer / ChemBERTa / Mol2Vec / GROVER / GraphCL** — SMILES- or graph-level SSL on PubChem-scale public corpora. Output: per-compound vector. Project-private fine-tune is *optional* (often unnecessary): pretrained vectors as features in a small downstream model frequently match purpose-built training.
- **RXN / MolBART / RXNFP** — reaction-aware encoders for reaction representations distinct from DRFP. DRFP is a strong, deterministic, license-clean baseline; learned reaction encoders are the candidate "next step."
- **DRFP** — already in the stack (`services/mcp_tools/mcp_drfp/`), 2048-bit, deterministic, project-agnostic.

These are the safest transfer surface: no private data ever participates in training, and the resulting features can be cached per InChIKey / per reaction template hash.

### 5.2 Knowledge graph embeddings (KGE)

| Family | Examples | Strengths | Weaknesses for ChemClaw |
|---|---|---|---|
| Translational | TransE, TransH, TransR, RotatE | Cheap, well-understood, strong on link prediction | Doesn't model bi-temporal validity natively |
| Bilinear | DistMult, ComplEx | Strong on relation-symmetry types | Same temporal limitation |
| Relational GCN | R-GCN, CompGCN | Captures graph structure beyond triples | Many parameters; small-data overfitting; harder to maintain |
| Temporal | TTransE, TA-TransE, TeMP, TeLM, ChronoR | Native (h, r, t, time) tuples | Less mature library support; few off-the-shelf implementations |
| Geometric / hyperbolic | HAKE, BoxE, RotH | Strong recent benchmarks | Marginal gains at the cost of complexity |

For ChemClaw the natural pre-train target is the **public** subgraph: compounds + reactions from public sources (USPTO, ORD, ChEMBL, public DrugBank), no project nodes. Train RotatE or CompGCN on this; persist `(entity_id → vector)` and `(relation → vector)` keyed by InChIKey + canonical relation name in a global `kg_embeddings` table. **Per-project fine-tune** then becomes a projector: when a project's reaction edges land, freeze entity embeddings, fine-tune relation embeddings on the project sub-graph, and persist project-scoped fine-tuned weights in a project-RLS-protected table. A new MCP tool `predict_kg_link` blends the pretrained-only score and the project-fine-tuned score.

This is the clean, well-scoped formalisation of "KG transfer learning" inside the existing A-on-C / RLS / Graphiti architecture.

### 5.3 Federated and DP-style learning
FedAvg / FedProx (FedSGD is the `local_epochs=1` degenerate case of FedAvg), DP-SGD, secure aggregation, split learning. **All assume the projects are trust-isolated tenants on different infrastructure**. ChemClaw runs all projects on a single operator-trusted Postgres + Neo4j. The host is already inside the trust boundary (it bypasses RLS via `chemclaw_service` for projector workloads). Adding FedAvg-style protocols imposes a substantial implementation tax with no marginal privacy benefit — every "remote party" is the same database.

DP noise on aggregate releases (§5.4) *is* warranted; full federated training is not, until / unless the deployment model becomes genuinely multi-tenant in the operator-trust sense.

### 5.4 Aggregate / motif transfer (k-anonymity)
Most pragmatic write-direction transfer. A scheduled projector aggregates over the **full multi-project pool** (running as `chemclaw_service`, BYPASSRLS) and emits **only** rows that:

1. Pass a k-anonymity threshold: `HAVING COUNT(DISTINCT project_id) >= K AND COUNT(*) >= M` (typical K=5, M=20).
2. Project keys do not appear in the output — only the aggregate (motif → success rate, motif → mean yield, motif → typical condition window).
3. Are written to a `kg_motif_aggregates` table that is globally readable subject to authenticated session, like the compound catalog.

Motifs are functional-group / leaving-group / coupling-class buckets — *not* InChIKey or NCE-ID. The granularity is chosen specifically so that even with an adversary who has access to one project, the released aggregate doesn't permit re-identification of which other project contributed a row.

This is the only mechanism in this doc that actually moves *private observation evidence* across project boundaries.

### 5.5 Skill / forged-tool promotion
Already partially implemented via `skill_library.maturity` (`db/init/17_unified_confidence_and_temporal.sql:111-123`) and the D.5 forged-tool pipeline. The gap (§4.7) is that maturity doesn't track *which* projects validated a skill. A small extension — `skill_library.validated_in_projects UUID[]` plus a promotion criterion "must have ≥3 projects validating before EXPLORATORY → WORKING" — turns the existing pipeline into a defensible cross-project promotion loop.

This is a low-risk, high-leverage extension; it transfers *reasoning routines*, not data.

## 6. Recommendation

A four-track plan: tracks A–C ordered by risk-adjusted ROI, plus Track D as a low-effort parallel improvement. Each track ends in a merged ADR + working code + runbook.

### Track A — Compound canonicalization (lowest risk; partially landed)

**Goal.** One `Compound` Neo4j node per InChIKey, shared across all projects, carrying public-knowledge properties refreshed across writes.

**Status (corrected from earlier draft):** node-level canonicalization is already correct — see §3.2 and `tests/unit/mcp_kg/test_cypher.py::TestCompoundCanonicalizationInvariant`. The remaining work is property attribution and Postgres-catalog projection.

**Remaining concrete changes:**
1. Extend `WriteFactRequest` / `build_write_fact_cypher` to support an `ON MATCH` property merge with array-distinct semantics, then add `contributed_by_projects: UUID[]` to the Compound writes in `services/projectors/kg_experiments/main.py:305-329`. Track C will read this for k-anonymity gating.
2. New projector (or extension to `compound_fingerprinter`) that materialises the Postgres `compounds` + `compound_class_assignments` rows into the canonical `Compound` Neo4j node — fingerprint vectors omitted (they live in Postgres), but `inchi`, `smiles`, `mw`, and `compound_class` labels become Neo4j properties.
3. (Already done) Regression test that locks the canonical-node invariant so a future refactor adding `group_id` to the node MERGE pattern fails loud.

**Effort:** 1–2 weeks (down from the original estimate now that the node-level work is verified done).

**Success criteria:** in a two-project test fixture, the same InChIKey produces a single Neo4j node whose `contributed_by_projects` lists both project IDs; reaction edges remain isolated under their per-project `group_id`.

### Track B — Public-pretrained KGE for the confidence ensemble (medium risk, high research value)

**Goal.** Plug a pretrained KGE score into `compute_confidence_ensemble` as a third or fourth signal alongside chemprop std and existing signals.

**Concrete changes:**
1. New ADR proposing `kg_embeddings` (global) and `kg_embeddings_project` (project-scoped, RLS) tables.
2. New training service `services/training/kg_pretrain/` (offline, run as `chemclaw_service`) that consumes a public-corpus snapshot and writes RotatE embeddings keyed by `(entity_kind, canonical_id)`.
3. New projector `services/projectors/kg_finetune/` that, on each project's KG-edge change, performs an incremental fine-tune with frozen entity vectors and writes `kg_embeddings_project` rows.
4. New MCP tool `services/mcp_tools/mcp_kg_predict/` with `/predict_link (project_id, head_inchikey, relation, tail_candidates) → scores`.
5. Wire into `compute_confidence_ensemble` (`services/agent-claw/src/tools/builtins/compute_confidence_ensemble.ts`).

**Effort:** 4–6 weeks of ML + integration time. **Risk:** medium; needs disciplined eval (hold-out projects for the fine-tune step) to avoid leakage between fine-tune and evaluation. Public-corpus licensing must be cleared.

**Success criteria:** ablation on a held-out project shows the KGE signal adds a measurable lift to top-1 link prediction over the existing ensemble (a ≥3pp target is illustrative — the real bar should be set after a baseline-only ablation against the existing chemprop-std signal); fine-tune is bi-temporally consistent (predictions made at time T do not depend on edges with `valid_from > T`).

### Track C — k-anonymous motif aggregator (medium-high risk; require security review)

**Goal.** A single explicit write-direction cross-project transfer surface, with k-anonymity enforced in SQL and admin audit on every read.

**Concrete changes:**
1. New ADR + security-review document. This track is the only one that crosses RLS deliberately, and it deserves the friction.
2. New table `kg_motif_aggregates (motif_key TEXT, condition_class TEXT, n_projects INT, n_observations INT, success_rate NUMERIC(4,3), mean_yield NUMERIC(5,2), std_yield NUMERIC(5,2), last_refreshed TIMESTAMPTZ)` — `NUMERIC(4,3)` for success rate matches the precision used for `confidence_score` in `db/init/17_unified_confidence_and_temporal.sql`.
3. New scheduled projector `services/projectors/motif_aggregator/` (cron, `chemclaw_service`) that recomputes the table with `HAVING COUNT(DISTINCT project_id) >= 5 AND COUNT(*) >= 20`. No project-of-origin columns; output is purely aggregate.
4. New MCP tool `services/mcp_tools/mcp_motif_lookup/` with `/lookup (motif_key) → row | null`. Reads run under the user's session and are audited via `appendAudit`.
5. Admin endpoint `POST /api/admin/motif-transfer/disable-for-project/:project_id` to opt a project out of contributing to the aggregator (needed for projects with stricter contractual constraints).

**Effort:** 1–2 weeks of code + 1–2 weeks of security-review + admin runbook work. **Risk:** medium-high; gets the legal / GxP framing right or it shouldn't ship.

**Success criteria:** a red-team review confirms (a) no single-project re-identification possible from the aggregate output, (b) opt-out is honored on the next refresh cycle, (c) every motif lookup is audited.

### Track D (parallel, low effort) — Skill promotion now tracks projects

**Goal.** Skill maturity becomes a portfolio-validated quantity.

**Concrete changes:**
1. Add `skill_library.validated_in_projects UUID[]` and `skill_library.evidence_count INT`.
2. Update the skill promotion criteria (in the optimizer's promotion loop) to require ≥3 distinct projects' validation before promoting `EXPLORATORY → WORKING`, and ≥6 for `WORKING → FOUNDATION`.
3. Audit the existing promotion writers to populate the new column.

**Effort:** 1–3 days. **Risk:** trivial. **Where it lives:** existing `services/optimizer/` skill-promotion path.

### What this plan deliberately does not do

- **No FedAvg / FedProx / DP-SGD.** The single-Postgres trust model doesn't justify the implementation tax. Reconsider only if the deployment topology becomes genuinely multi-tenant.
- **No "share project A's raw rows with project B's user."** The cross-project bootstrap fallback already does the *only* version of this that's defensible (statistical-frame sharing under the user's own RLS).
- **No KG-embedding sharing across project sub-graphs without canonicalization-as-pivot.** Embedding the project A sub-graph and then using the embedding inside project B reads exactly like a side-channel for row content. Track B avoids this by pretraining only on public data and fine-tuning per project.
- **No new opinionated model framework.** Reuse chemprop, DRFP, and add KGE as a separate offline-trained service; do not couple them.

## 7. Open questions for follow-up ADRs

1. Does the operator-side trust boundary tolerate Track C? Each project owner needs to consent to contribution. Is consent default-on or default-off? (Recommend default-off; opt-in via admin endpoint.)
2. What public reaction corpus is licensable for Track B pretraining? USPTO + ORD are the safe baseline; Reaxys is contractually variable.
3. Graphiti GPL-3 footprint — is it acceptable to keep KGE artifacts in our own Postgres tables (recommended) versus baking into Neo4j as node properties?
4. Track B fine-tune cadence — per-event (expensive), per-night, or on-demand?
5. Is there a PHI / regulated-data carve-out where even Track A canonicalization should be opt-in (e.g., compounds in a confidential clinical pipeline)?
6. The cross-project bootstrap fallback in `assess_applicability_domain.ts:199-231` should be retrofitted to write an audit row (via `appendAudit`) for every fallback trip, regardless of the rest of this plan. This is a small change with immediate value; track as a sibling micro-task to Track A rather than waiting for the full transfer roadmap.

## 8. References

- `services/projectors/kg_experiments/main.py:178` (`scope_group_id` derivation), `:207` (first `write_fact` with `group_id=scope_group_id`), `:310` (explicit `Compound` write) — `group_id` scoping pattern.
- `services/mcp_tools/mcp_kg/models.py:73` (`SYSTEM_GROUP_ID = "__system__"`), `:124,189,211,240` (default `group_id` on each request model) — `group_id` enforcement at the KG read/write boundary.
- `services/agent-claw/src/tools/builtins/assess_applicability_domain.ts:199-231` — cross-project bootstrap fallback precedent.
- `services/agent-claw/src/tools/builtins/find_similar_reactions.ts:99-120` — DRFP cross-project similarity within RLS.
- `services/projectors/compound_fingerprinter/main.py:38-39` (NOTIFY channel constants), `:274` (emit `compound_fingerprinted`) — global fingerprint projector.
- `services/projectors/compound_classifier/main.py:35` (`_NOTIFY_CHANNEL = "compound_fingerprinted"`), `:58` (LISTEN) — global classification projector with bi-temporal `valid_to`.
- `services/projectors/reaction_vectorizer/main.py` — DRFP global vector space.
- `services/optimizer/session_reanimator/main.py` — only existing optimizer surface; no cross-project signal today.
- `services/mcp_tools/mcp_chemprop/main.py` — globally pretrained yield predictor.
- `services/mcp_tools/common/redaction_filter.py` — log-side redaction; not a transfer-boundary control.
- `services/mcp_tools/common/app.py` — MCP Bearer-token middleware (Track A item 3).
- `db/init/12_security_hardening.sql:162-200` — RLS architecture for compounds / reactions / experiments.
- `db/init/17_unified_confidence_and_temporal.sql:18-123` — bi-temporal + confidence schema.
- `db/init/39_compound_catalog_rls.sql` — global compound catalog RLS posture.
- `services/agent-claw/src/middleware/require-admin.ts:19` — admin role definitions.
- `skills/cross_learning/SKILL.md` — existing portfolio-pattern-mining skill.
