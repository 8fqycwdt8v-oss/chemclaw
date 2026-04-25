# Harness engineering for agentic pharma research assistants

**Harness engineering has emerged in the last twelve months as the dominant architectural pattern for production agentic AI**, displacing graph-based orchestration for open-ended, long-running work. The term crystallized between late 2025 and early 2026 — Viv Trivedy's "Agent = Model + Harness" at LangChain, Mitchell Hashimoto's "every mistake becomes a rule," OpenAI's `Harness engineering: leveraging Codex in an agent-first world`, and Anthropic's `Effective harnesses for long-running agents` all landing within months of each other. The core claim: **everything that is not the model is the harness**, and as model capability rises, the harness's job shifts from decision scaffolding toward execution scaffolding. For a pharma scientific research assistant — a proactive, multi-source, domain-expert agent that must pose its own sub-questions, reason across heterogeneous ELN/LIMS/CDS systems, and operate inside GxP constraints — this architectural choice is the single highest-leverage design decision. This report synthesizes ~40 primary sources across practitioner blogs, academic literature (Reflexion, ADAS, Voyager, Constitutional AI, MemGPT, GraphRAG), and regulatory doctrine (FDA CSA, PCCP, EMA Reflection Paper, EU Annex 22, GAMP 5 2nd ed. + AI Appendix) into a concrete harness design and a defended recommendation: **go harness-first, drop LangGraph only into deterministic subflows where regulation or SLA demands it, and confine self-evolution to a sandboxed, human-gated envelope**.

---

## 1. Harness engineering — foundations and theory

### Origin of the term

"Harness engineering" is a **practitioner-driven, 2026-era coinage** with no formal academic predecessor. The canonical definition comes from LangChain's Viv Trivedy: *"Agent = Model + Harness. If you're not the model, you're the harness. A harness is every piece of code, configuration, and execution logic that isn't the model itself. A raw model is not an agent. It becomes one when a harness gives it state, tool execution, feedback loops, and enforceable constraints."* HumanLayer narrows it to "the art of leveraging your coding agent's configuration points to improve output quality," positioning it as a subset of **context engineering**, itself a superset of prompt engineering. OpenAI frames it in outcomes: "when a software engineering team's primary job is no longer to write code, but to design environments, specify intent, and build feedback loops that allow agents to do reliable work." Anthropic's Claude Code docs use the term descriptively: *"Claude Code serves as the agentic harness around Claude."*

A striking datapoint: an arXiv design-space analysis of Claude Code's leaked source estimates **only ~1.6% of the codebase is AI decision logic; 98.4% is operational infrastructure** — the harness dominates the system.

### Core concepts

**System prompts as harnesses.** The system prompt is one of several harness levers, not the whole. Production harnesses assemble the live prompt per turn from a base provider prompt, injected `CLAUDE.md`/`AGENTS.md` files, skill and tool descriptions, dynamically loaded context, and a recency-weighted tail. The Chroma *context rot* research empirically validates aggressive pruning. Addy Osmani: *"the flat markdown rulebook at the root of your repo is still the single highest-leverage configuration point, because it lands in the system prompt every turn."*

**Tool schemas as harness gates.** Anthropic's *Writing effective tools for agents* treats tool descriptions and schemas as the primary mechanism by which the harness "constrains and guides" model behavior — tool names, namespacing (`asana_search` vs `asana_projects_search`), response shapes, and error messages materially shift choice distributions. The arXiv Claude Code analysis is precise: *"the model never directly accesses the filesystem, runs shell commands, or makes network requests. The model's only interface to the outside world is the structured tool_use protocol, which the harness validates before execution."*

**Context and memory as harness rails.** Four canonical primitives: compaction (summarize-and-drop on approach to the window limit), tool-call offloading (large outputs stored on filesystem, head/tail preserved), progressive disclosure via Anthropic's Agent Skills (only `SKILL.md` loaded until invoked), and context firewalls via sub-agents (intermediate state is discarded; only final response propagates). Anthropic's long-running harness uses an *initializer agent* writing `feature_list.json`, `claude-progress.txt`, `init.sh`, and an initial git commit; each subsequent *coding agent* reads these to reorient. Harrison Chase's formulation: **"Managing context, and therefore memory, is a core capability and responsibility of the agent harness."**

**Evaluation loops.** Harnesses encode back-pressure — machine-verified criteria that force the agent to keep working. `Stop` hooks running typecheck/lint on every halt. Structural-test and taste-invariant linters (OpenAI) that inject remediation through custom error messages. Mutation testing, code-coverage drops, LSP diagnostics, browser-automation screenshots as inferential sensors. This is the practical descendant of **Reflexion** (Shinn et al., NeurIPS 2023) and **Self-Refine** (Madaan et al. 2023): verbal/computational feedback closing a loop outside model weights.

**Self-modification and prompt evolution.** Observed patterns: background agents scanning for drift and opening cleanup PRs against `AGENTS.md`; skills/rulebooks edited by the agent mid-session and reloaded next turn; ratcheting (every novel failure codified as a new rule); Voyager-style skill libraries of executable code. ADAS (Hu, Lu, Clune, ICLR 2025) is the purest form in the literature: a meta-agent programs new agentic systems in code and iteratively improves an archive.

### How a harness differs from a static prompt or fixed pipeline

A **static prompt** is a string. A **harness is a runtime** — an executing loop that assembles prompts per turn, enforces permissions, streams and parses tool outputs, writes checkpoints, spawns sub-agents, and mutates context. A **fixed pipeline (LangGraph)** encodes control flow as nodes and edges; the model is a component *inside* pre-specified routing. In a harness, control flow is *emergent* from the model's tool-call choices inside a dumb loop — Anthropic's `queryLoop()`. The harness invests in deterministic infrastructure (context management, tool routing, recovery, permissions) and lets the model decide what to do; the graph invests in decision scaffolding and tells the model where it is. As models improve, **decision scaffolding shrinks while operational infrastructure persists**.

### Self-evolving harnesses

A maturity gradient, from today to frontier:

1. **Human-in-the-loop ratchet (mature).** Hashimoto's rule-per-mistake edits to `CLAUDE.md`, hooks, sub-agent definitions. The default.
2. **Agent-authored documentation/config (emerging).** OpenAI's background garbage-collection agents opening doc-drift PRs; Anthropic's coding agent updating progress files between sessions.
3. **Self-reflective trace analysis (experimental).** Trivedy lists as open: *"agents that analyze their own traces to identify and fix harness-level failure modes."*
4. **Automated design of agentic systems (research).** ADAS Meta Agent Search; Stanford IRIS Lab's reported Meta-Harness reaching 76.4% on Terminal-Bench 2.0 with Claude Opus 4.6 via meta-optimization.
5. **Model–harness co-training loop (structural).** Anthropic post-trains Claude on Claude Code; OpenAI post-trains GPT-5 Codex on the Codex harness's `apply_patch` tool. Harness primitive discovered → standardized → trained into the next model → harness re-derived for the new ceiling.

### Literature map

Primary practitioner sources are dense — Anthropic's *Building effective agents* (Dec 2024), *Effective context engineering*, *Effective harnesses for long-running agents*, *Writing effective tools*, *Building a C compiler with parallel Claudes*; OpenAI's *Harness engineering*; LangChain's *Anatomy of an Agent Harness* and *Your harness, your memory*; HumanLayer's *12-Factor Agents*; Martin Fowler / Birgitta Böckeler (cybernetic-governor framing); Mitchell Hashimoto; Simon Willison's *Designing Agentic Loops*. Academic substrate: Reflexion (arXiv:2303.11366), Self-Refine (2303.17651), Voyager (2305.16291), Generative Agents (2304.03442), Constitutional AI (2212.08073), ADAS (2408.08435), ReAct (2210.03629), Toolformer. **Papers explicitly using "harness"** are essentially all post-2025; the vocabulary is practitioner-first.

---

## 2. LangGraph vs harness engineering — architectural comparison

### LangGraph's architecture

LangGraph is a stateful directed-graph orchestration framework executed via a Pregel-inspired BSP runtime. **State** is a typed dict where each field has a reducer (`LastValue`, `BinaryOperatorAggregate`, `Topic`). **Nodes** are Python functions returning state updates. **Edges** are static or conditional (routing functions). A compiled `StateGraph` is a `Pregel` instance; execution proceeds in discrete supersteps where active nodes run in parallel, and their writes become visible only at the next superstep start. **Checkpointing** (`BaseCheckpointSaver` with SQLite/Postgres/in-memory/custom backends) persists full state after each superstep under a `thread_id`, enabling time-travel, resumable execution, forking, and human-in-the-loop via `interrupt()`/`Command(resume=…)`. Streaming exposes `values`, `updates`, `messages`, `tasks`, `checkpoints`, `debug` event classes.

### Strengths

LangGraph is genuinely strong where it fits: explicit low-level control flow ("LangGraph primitives are fully descriptive and can scale beyond prototyping"); reducer-based parallel-safe state merging; pluggable persistence with LangSmith tracing; schema-evolution tolerance for graphs at `END`; first-class HITL via interrupts; production deployments at **Klarna, Elastic, Uber, Replit, Box**. It is an excellent fit for compliance-heavy, deterministic-flow workloads: approval gates, audit trails, financial pipelines, pharmacovigilance case intake.

### Limitations (sourced)

**Durability is checkpoint-based, not truly durable-execution.** Diagrid: *"LangGraph has no built-in mechanism to detect that a workflow has stopped running. A crashed process sits silently until an engineer notices… If two processes try to resume the same thread_id at the same time, LangGraph has no coordination to prevent both from executing."* Cordum recommends pairing with Temporal for side-effecting production agents. **Weak native observability** absent LangSmith. **No in-framework security boundary** (no mTLS, no cryptographic node identity). **Single-region deployment.** **Looping pathologies** (Hajebi): token-consumption inefficiency, execution-time expansion, reinforcement of hallucinations when agents reprocess their own outputs. **Abstraction leakiness** — Anthropic's *Building effective agents*: *"frameworks often create extra layers of abstraction that can obscure the underlying prompts and responses, making them harder to debug."* **Steep learning curve**, acknowledged even by LangChain.

The deepest structural limitation is **brittleness under novelty**. If a task requires a step the graph's author did not anticipate, the agent hits an un-anticipated edge and either errors, stalls, or defaults. Maxim Fateev (Temporal) calls the visual graph a "lie" because real control flow depends on runtime expressions hidden inside nodes; graphs cannot represent dynamic step sets (an LLM-emitted list of tool calls unknown at design time); error-handling blows up node counts combinatorially. Sajal Sharma: *"Every edge case requires a new branch. Workflows become brittle and expensive. The workflow is the intelligence; the model just fills in blanks. That's the deeper problem: workflows cap agent autonomy."* An FME analysis: adding sentiment analysis to an existing LangGraph bot "usually requires updating the schema across six to eight graph nodes, revising ten to twelve conditional edges, and restructuring checkpoint logic."

### Axis-by-axis

| Axis | LangGraph | Harness-style |
|---|---|---|
| Novel/unanticipated tasks | Poor — only author-drawn paths exist | Strong — model picks tool calls; bash+filesystem acts as universal fallback |
| Self-evolution | Topology static per deploy | `CLAUDE.md`/skills editable; background PR agents; no training needed |
| Graceful degradation | Good for anticipated errors; poor for novel ones | Errors return to model as observations; model retries or reroutes |
| Debuggability | LangSmith trace excellent for graph-shaped bugs; weak when model "goes off-graph" | Session logs + streaming events; no enumerable "map" |
| State management | Explicit, typed, reducer-driven, checkpointed — audit-friendly | Conversation log + filesystem + git + managed memory |
| Tool integration | Tools are typed node inputs | Uniform tool interface; MCP as open plug; bash as universal |
| Scalability | Limited without durable backend (Temporal/Dapr); no failover | Sandboxed workers per task; sub-agent parallelism (Anthropic ran 16 in parallel on a C compiler) |

### Hybrids are the production norm

**LangChain's own Deep Agents** is a harness built on LangGraph primitives — the clearest evidence the two are complementary rather than alternatives. Chase: *"in order to own your memory, you need to be using an Open Harness."* Other hybrids: **LangGraph for reasoning + Temporal for durable orchestration**; LangGraph deterministic top-level + Claude Agent SDK sub-agents for unconstrained tasks; Cursor/Devin-style top-level planning graphs hosting Claude-Code-style tool loops inside each node. Salesforce's Agentforce Agent Graph is a "hybrid reasoning" approach using explicit graphs to prevent agent drop-off while reasoning with LLMs inside nodes.

### Real-world evidence

Suggestive but uneven. **Terminal-Bench 2.0**: Claude Opus 4.6 inside Claude Code placed ~#33; the same model weights inside LangChain's custom harness jumped to #5 — *"we only changed the harness."* **OpenAI's 1M-line Codex experiment**: five months, ~1,500 merged PRs, zero human-written source, harness-first methodology. **Anthropic's C-compiler project**: 16 parallel Claude agents, ~2,000 sessions, ~$20K, 100K-line Rust compiler building Linux 6.9. **HumanLayer internal A/B**: Claude Sonnet 4.6 code-review task, 58% → 81% pass rate after harness edits (vendor-reported). **ChemCrow, Coscientist, Manus, Cursor, Devin, Factory, Replit Agent, Sourcegraph Cody** are all harness-pattern — none ship a public stateful graph of their reasoning. **Direction of migration in public writing is overwhelmingly graphs → harnesses** as model capability grew, not the reverse.

---

## 3. Harness architecture for a pharma scientific research assistant

### Layered onion model

A harness for a regulated-industry agent should be an onion where each layer is more volatile than the one inside it, so updates (a new SOP) don't destabilize the constitution.

| Layer | Contents | Mutability |
|---|---|---|
| L0 Constitution/Identity | Mission, values, non-negotiable prohibitions, escalation axioms | Quarterly, governance board |
| L1 Domain Ontology | CQA/CPP/DS/DP/OOS/OOT/COA/RSD, UCUM/UNII/CDISC/MedDRA | On schema change |
| L2 Regulatory Rails | GxP, ICH Q-series, ALCOA+ hooks, 21 CFR Part 11/Annex 11, FDA COU framework | On regulatory update |
| L3 Tool Catalog | MCP/OpenAPI schemas for ELN, LIMS, CDS, Gantt, DMS, literature, cheminformatics | Weekly |
| L4 Reasoning Playbooks | HEA, DoE/QbD, peak interpretation, structure elucidation, stability trending | Monthly |
| L5 Gates | Conditional decision points (data-quality, compliance, uncertainty, HITL, EHS) | Continuous |
| L6 Sensors/Triggers | Event/time/threshold/cross-project subscriptions, proactive-behavior policy | Continuous |
| L7 Output Contracts | Report templates, JSON schemas, citation policy, audit-log writer | Weekly |

The system prompt is assembled as: constitution → domain primer → regulatory rails → currently loaded playbook(s) → tool catalog summary → current-turn context, with the constitution echoed near the context-window tail to reduce instruction drift on long sessions.

### Constitution (draft text)

```markdown
# CONSTITUTION — "Helix", Scientific Research Assistant v1.0
# IMMUTABLE EXCEPT BY GOVERNANCE BOARD

## 1. Identity
I am Helix, an AI research assistant inside <Company> Pharmaceutical Development.
I support chemists, analytical scientists, and project leads across discovery
hand-off, process chemistry, analytical development, formulation, stability,
and tech transfer. I am NOT a decision-maker of record; I am a science-aware
copilot whose outputs are advisory unless a qualified human reviewer signs
them off inside a validated system.

## 2. Mission
Accelerate sound scientific decisions while preserving data integrity, patient
safety, and regulatory compliance.

## 3. Core Values (priority order — ties break UPWARD)
 1. Patient safety.
 2. Data integrity (ALCOA+).
 3. Regulatory compliance (GxP, ICH, 21 CFR Part 11, EU Annex 11).
 4. Scientific rigor (reproducibility, quantified uncertainty, falsifiability).
 5. Scientist productivity.
 6. Cost/time efficiency.

## 4. Non-Negotiable Prohibitions
- I MUST NOT alter, back-date, or delete raw records. I write only to
  designated, audit-logged "AI annotation" fields.
- I MUST NOT issue a final disposition (release/reject), close a deviation,
  sign a batch record, approve a change control, or submit regulatory content.
- I MUST NOT propose or execute synthesis of Schedule I/II controlled
  substances, CWC Schedule 1 chemicals, explosives, or precursors without
  EHS + Legal + Security approval (hard gate §G-SAFE-01).
- I MUST NOT bypass a failed system-suitability test, nor re-integrate
  chromatograms to change OOS/OOT outcomes.
- I MUST NOT fabricate citations, instrument readings, or experimental values.

## 5. Epistemic Rules
- Every quantitative claim cites its source (ELN ID, LIMS sample ID, DOI,
  SOP number) and timestamp.
- I quantify uncertainty (confidence band, %RSD, n, or H/M/L) on any numeric
  recommendation.
- If sources disagree, I surface the disagreement rather than resolving silently.
- I distinguish Observation / Inference / Speculation with explicit tags.

## 6. Escalation Axioms
- When in doubt, I ASK a human before I ACT.
- When an action is irreversible, I REQUIRE human confirmation.
- When I detect a GxP anomaly (OOS, OOT, data-integrity signal, safety signal),
  I notify the accountable function within <SLA> and freeze downstream automated
  actions on the affected object.
```

Crucially, the constitution lexicographically scopes the agent **outside** regulatory-decision-of-record Context-of-Use under the FDA 2025 Draft Guidance — keeping GxP validation tractable. Attempts to pull it across that line are routed to a HITL gate.

### Encoding scientific reasoning

Scientific reasoning is encoded as **playbook macros** the model is prompted to invoke explicitly, each with preconditions, reasoning steps, required outputs, and gate hooks.

**Hypothesis–Experiment–Analyze (HEA)** — state falsifiable hypotheses with prior plausibility H/M/L and cost-to-test; choose minimum cost × (1 − discriminating_power); predefine analysis with acceptance criteria and stop rules; require uncertainty gate.

**Design of Experiments (DoE)** — maps to ICH Q8(R2) QbD: fractional factorial/Plackett-Burman for screening ≥5 factors, CCD/Box-Behnken near optimum; explicit design-space definition; ANCOVA power analysis; randomized blocks for day/operator/lot effects; ≥3 replicate center-points for lack-of-fit.

**Analytical interpretation playbooks.** HPLC: compute USP tailing T = W₀.₀₅/2f, flag T>2.0, N below method spec, k<2, Rs<1.5, RSD>method-defined (typical 2.0% for assay); diagnose per Waters/LCGC trees (tailing of basic analytes → silanol activity near pKa; all-peak fronting → column void; sudden tailing → guard-column build-up); require system-suitability pass before any quantitative conclusion. NMR: parse multiplicity and coupling constants; cross-check against predicted spectrum (Mnova/nmrglue) and flag Δδ>0.1 ppm or |ΔJ|>0.5 Hz; handle second-order roofing, exchange broadening, solvent residuals. MS: isotope-pattern matching (Cl/Br M+2), accurate-mass DBE, McLafferty/α-cleavage/neutral-loss logic, adduct checks; enforce ICH Q3A/B reporting (0.05%), identification (0.10%), qualification (0.15%) thresholds. Every interpretation returns `{peak_id, identity_hypothesis[], confidence, supporting_evidence[], contradicting_evidence[], next_experiment}`.

### Encoding GxP/ICH/data-integrity norms

**ALCOA+** is enforced as middleware on every write: Attributable (`user_on_whose_behalf`, `agent_id`, `agent_version`, `model_hash`); Legible (UCUM SI units); Contemporaneous (reject retroactive timestamps; NTP-synced monotone clock); Original (raw data never modified; annotations append to a shadow table); Accurate (round-trip re-read verification); Complete (atomic transactions); Consistent (controlled vocabulary); Enduring (WORM storage with S3 Object Lock); Available (RBAC audit-trail read API).

**21 CFR Part 11 / EU Annex 11.** The agent never performs a Part-11-signature-equivalent act. Any signature-equivalent event (approval, release, sign-off) is emitted as an *intent event* that a human enacts in the validated system of record; the agent writes supporting rationale to the non-signature annotation channel.

**ICH bindings** carried as a compact rules table the planner consults before emitting any recommendation: Q1A stability pulls and conditions; Q2(R2) validation elements; Q3A/B impurity thresholds; Q6A specifications; Q8(R2) QbD concepts; Q9(R1) risk tools (FMEA/HACCP/HAZOP); Q10 PQS; Q11 starting-material justification; Q12 ECs and PACMPs; Q14 AQbD.

**SOPs** are retrieved by RAG bound to their effective version; every citation carries `{sop_id, effective_version, retrieved_at}`. A change-control sensor invalidates cached reasoning on supersession.

---

## 4. Gates in a pharma research harness

A **gate** is a named, versioned, audit-logged conditional decision point branching into {PROCEED, PAUSE_FOR_INFO, ESCALATE, BLOCK}. Gates differ from plain tool-call conditionals in that they have owners (QA, EHS, RA, PM), their verdicts are written to the audit log regardless of outcome, and they are the agent-control analogue of ICH Q9 risk-control points.

### Taxonomy

| Category | Purpose | Example triggers |
|---|---|---|
| Data-quality | Don't reason on garbage | SST fail, missing metadata, unit mismatch, n<3, RSD>limit |
| Regulatory-compliance | Don't violate GxP/ICH/Part 11 | Writing to validated field, superseded SOP reference, missing Part-11 attribution |
| Uncertainty/confidence | Don't overclaim | Model confidence <θ, contradictory sources, extrapolation beyond trained range |
| HITL | Require human judgment | Before intent events, release-like recommendations, first use of a new tool |
| Cross-functional escalation | Route to right function | QA for deviation, RA for filing impact, EHS for safety, IP for novelty |
| Safety (EHS) | Don't harm | Energetic reagents, ΔT_ad>50K, Bretherick incompatibility, controlled substances |
| Cost/compute | Don't burn budget | >$X API/robot time, >N tool calls in a loop |
| Ethical/IP | Don't leak | External LLM call with confidential structure |

### Implementation: three styles, used in combination

**(a) Harness-level prose** — flexible and cheap but probabilistic; appropriate for "good-taste" gates ("explain uncertainty," "ask before irreversible action"). **(b) LangGraph conditional edge** — deterministic, introspectable, supports checkpoint/resume and multi-month pause via `interrupt()`; appropriate for workflow-shaping gates at milestones. **(c) Middleware/interceptor around tool calls** — wraps every tool invocation and every model generation, consulting the gate catalog; **correct home for cross-cutting concerns: Part 11 attribution, PII redaction, cost ceilings, safety filters**, because middleware runs regardless of which playbook or graph node is active.

The defensible recommendation is layered: **middleware for compliance/cost/safety (universal); LangGraph edges for workflow-shaping HITL; harness prose for good-taste gates** — consistent with ISPE GAMP 5 2nd ed. Appendix D11 risk-based assurance for AI.

### Worked examples

```python
def gate_data_completeness(evidence) -> GateVerdict:
    reasons = []
    if evidence.n_replicates < 3: reasons.append("n<3")
    if evidence.rsd_area_pct > 2.0: reasons.append("RSD>2%")
    if not evidence.system_suitability_passed: reasons.append("SST fail")
    if evidence.calibration.r2 < 0.995: reasons.append("linearity")
    if evidence.sample_chain_of_custody_gaps: reasons.append("CoC gap")
    if evidence.method.validation_status != "validated_for_intended_use":
        reasons.append("method not validated for COU (Q2(R2))")
    if not reasons: return GateVerdict("G-DATA-COMPLETE","PASS")
    return GateVerdict("G-DATA-COMPLETE","PAUSE",
                       msg=f"Cannot conclude: {', '.join(reasons)}",
                       route_to="analyst")

def gate_safety_review(proposal) -> GateVerdict:
    hz = reactive_hazard_score(proposal.reagents)
    adT = adiabatic_temperature_rise(proposal)
    incompat = bretherick_check(proposal.reagents)
    energetic = any(r.has_group(ENERGETIC_GROUPS) for r in proposal.reagents)
    triggers = []
    if hz >= 3: triggers.append("reactivity≥3")
    if adT > 50: triggers.append(f"ΔTad={adT}K")
    if incompat: triggers.append("Bretherick incompatibility")
    if energetic: triggers.append("energetic functional group")
    if proposal.pressure_bar > 5 or proposal.temp_C > 150:
        triggers.append("high P/T")
    if triggers:
        return GateVerdict("G-SAFE-REACTIVE","ESCALATE",
                           route_to=["ehs","process_safety"],
                           sla_min=60, payload={"triggers":triggers})
    return GateVerdict("G-SAFE-REACTIVE","PASS")

def gate_inventory(route) -> GateVerdict:
    approved = inventory_api.approved_set(site=route.site)
    restricted = inventory_api.restricted_set()  # DEA CI/II, CWC Sched 1, ITAR
    banned = [r for r in route.reagents if r.cas in restricted]
    missing = [r for r in route.reagents if r.cas not in approved]
    if banned: return GateVerdict("G-CHEM-INVENTORY","BLOCK",
                                  route_to=["security","legal","ehs"],
                                  payload={"banned":banned})
    if missing: return GateVerdict("G-CHEM-INVENTORY","PAUSE",
                                   route_to="procurement", payload={"missing":missing})
    return GateVerdict("G-CHEM-INVENTORY","PASS")

def gate_qa_milestone(ms) -> GateVerdict:
    if ms.type in {"tox_readout","GLP_report","DS_release","CS_release",
                   "reg_submission_component","design_space_change"}:
        qa = qms_api.get_review(ms.id)
        if qa is None or qa.status != "Approved":
            return GateVerdict("G-QA-MILESTONE","PAUSE",
                               route_to="qa_project_lead",
                               msg="QA review required (ICH Q10 §3.2.4)")
    return GateVerdict("G-QA-MILESTONE","PASS")
```

### Gate evolution — three tiers of autonomy

**Tier 1 — Passive outcome telemetry (low-risk).** Every verdict is joined in a read-only warehouse with downstream outcomes; weekly offline analysis computes per-gate **false-block rate**, **miss rate**, **time-cost**. Dashboards surface candidates. **No automatic change is made.**

**Tier 2 — Governed threshold tuning (medium-risk).** For gates with numeric thresholds, a governance committee can re-baseline quarterly via formal change control with pre/post A/B on a shadow corpus. Mirrors FDA's 2025 PCCP concept extended to internal agents.

**Tier 3 — Agent-proposed gate changes (⚠️ frontier).** The agent proposes new gates based on pattern detection — *"in 14 of 17 OOS cases over 90 days, root cause was sample-prep contamination not visible to current gate; propose adding a gate requiring sample-prep chromatogram review when %LC deviates >5% from prior lots."* **Never auto-applied in GxP** — routed to the same governance board as human SOP changes. Consistent with EU Draft Annex 22 prohibition on dynamic/continuously-learning models in critical GMP applications.

Practical pattern: gates as **versioned code**, deployed via same CI/CD + CSA change control as validated software, with verdict history training a shadow "gate-recommender" that humans review.

---

## 5. Tool design for a pharma research harness

### Design philosophy

Anthropic's Sept 2025 guidance sets the frame: tools are **contracts between deterministic systems and non-deterministic agents**, not thin API wrappers. Choose high-leverage tools that consolidate workflows. Namespace (`eln_*`, `lims_*`, `hplc_*`). Return meaningful context — natural-language identifiers over cryptic IDs, pagination defaults, responses <~25K tokens. Treat tool descriptions as prompts; small refinements yielded SOTA on SWE-bench Verified. Prefer **just-in-time** context: tools return handles (file paths, sample IDs, cursors) the agent expands later rather than dumping full spectra. **Programmatic Tool Calling** (Anthropic, Nov 2025) — agent writes Python orchestrating many tool calls in a sandbox with only final outputs entering the window — is essential for HPLC/NMR batch processing.

### Tool catalog

**ELN (Benchling, IDBS E-WorkBook, Dotmatics).** Canonical operations: `eln_search_entities(query, entity_types, schema_id?, limit)` → IDs + handles; `eln_get_notebook_entry(entry_id, include)`; `eln_list_entries(project_id?, modified_since?, mentions?, review_status?)`; `eln_register_compound(structure_smiles, schema_id, fields)`; `eln_create_results(schema_id, results[])`; `eln_attach_file(entry_id, blob_id)`; `eln_warehouse_sql(query, params)` as escape hatch to Benchling's read-only Postgres warehouse. Benchling ships an **official remote MCP server** (`<tenant>.mcp.benchling.com`, OAuth DCR, Claude 1-click); IDBS and Dotmatics must be wrapped as FastMCP servers.

**LIMS (LabWare, LabVantage, STARLIMS, SampleManager).** `lims_query_samples`, `lims_get_results`, `lims_get_instrument_runs`, `lims_get_stability_study`, `lims_generate_coa`, `lims_list_oos`. No first-party MCPs as of April 2026 — wrap internally. Read-heavy via MCP with role-based scoping; **writes behind explicit HITL** since Part 11 applies.

**Analytical parsers.** HPLC (Empower/Chromeleon/OpenLab via vendor APIs or Allotrope AnIML/ASM): `hplc_get_peak_table`, `hplc_impurity_profile` vs ICH Q3A/B, `hplc_check_system_suitability`, `hplc_compare_runs`. NMR (Mnova, MestReNova, JCAMP-DX, Bruker TopSpin): `nmr_get_spectrum_metadata`, `nmr_get_peak_list`, `nmr_structure_verification(smiles, peak_list)` via nmrium/nmrglue. MS (mzML/mzXML via pyOpenMS/pymzML): `ms_get_scans`, `ms_formula_matcher`, `ms_fragment_match` against NIST/mzCloud/MoNA. **Stability (ICH Q1E/Q1A(R2)):** `stability_get_trending`, `stability_fit_shelf_life(model=["linear","arrhenius","first_order"])` with 95% lower confidence bound, never extrapolating beyond 2× long-term period without flagging; `stability_oos_classifier`.

**Literature.** `pubmed_search` (E-utilities), `semantic_scholar_search`/`get_paper` (official MCP exists), `reaxys_search`/`scifinder_search` (enterprise APIs), `patent_search` across USPTO/EPO/WIPO, `paperqa2_query` as a meta-tool (used inside ChemCrow) that runs chunk-and-retrieve with cited answers.

**Retrosynthesis/reaction prediction.** AiZynthFinder (AstraZeneca, MCTS + policy NN, ~55–65% drug-like solve rate); ASKCOS (MIT, separate tree builder / context recommender / forward / impurity prediction); IBM RXN for Chemistry (Molecular Transformer); Molecule.one; Chematica/Synthia. Return `{route, steps[{reactants, conditions, product, confidence, literature_refs}], overall_feasibility_score}`.

**Regulatory.** `ich_guideline_lookup` (semantic search across Q/S/E/M); `ectd_navigate(submission_id, module_path)` — CTD Modules 1-5 with specific paths (3.2.S.1–7 drug substance, 3.2.P.1–8 drug product, 3.2.P.8.1-2 stability); `fda_orange_book_query`; `dailymed_search`; `ema_epar_search`; `fda_warning_letter_search`; `drug_safety_check` (ChEMBL, Tox21, DrugBank bundle).

**Project management.** `project_get_timeline`, `project_get_milestones`, `project_get_raci`, `veeva_rim_get_submission`.

**Visualization.** `render_structure(smiles)` (RDKit/Cairo), `plot_chromatogram`, `plot_stability_trend`, `plot_spectrum`, `structure_editor_widget` (Ketcher/marvin.js).

### Tool-level harness engineering

Each tool schema is a **mini-harness with its own constitution** — the tool carries inside its description the portion of system prompt governing correct use. Concrete pattern:

```json
{
  "name": "eln_search_entities",
  "description": "Search Benchling for compounds, batches, samples, or projects by name, alias, or SMILES substructure. Prefer this over eln_warehouse_sql for entity lookup. Returns entity IDs (e.g. 'bfi_abc123') you can pass to eln_get_notebook_entry or eln_get_batch. Do NOT use to enumerate >500 items; use pagination cursor instead.",
  "input_schema": {
    "type":"object",
    "properties":{
      "query":{"type":"string","description":"Free-text name, alias, registry ID, or SMILES"},
      "entity_types":{"type":"array","items":{"enum":["compound","batch","sample","project","entry"]}},
      "schema_id":{"type":"string","description":"Optional Benchling schema ID (assaysch_* or ts_*)"},
      "limit":{"type":"integer","default":25,"maximum":100}
    },
    "required":["query"]
  },
  "input_examples":[
    {"query":"AZ-12345","entity_types":["compound","batch"]},
    {"query":"c1ccc(CN)cc1","entity_types":["compound"],"limit":10}
  ]
}
```

Each spec contains: **identity/purpose** (one line), **selection policy** ("when to use vs. sibling tools" — resolves Anthropic's #1 failure mode), **pre-conditions**, **post-conditions**, **invariants/guardrails** ("never call with unvalidated user-supplied SQL"), **few-shot examples** via `input_examples`, **cost/latency profile** ($, seconds), **provenance contract** (what metadata returned to enable citation). This is a per-function Constitutional AI rule set: policy changes by editing the description, no retraining.

### MCP scale problem

Five MCP servers can consume ~55K tokens of tool definitions. Use **tool-search** / **defer_loading** / **dynamic tool discovery** — load `hplc_*` only after the agent enters an analytical subtask. MCP spec update (Nov 2025) added async Tasks, stateless mode, server identity verification, and an official community registry (`registry.modelcontextprotocol.io`).

---

## 6. Knowledge and context management

### Context window — layered strategy

```
┌────────────────────────────────────────────────────────┐
│ SYSTEM/CONSTITUTION (~3-6K, pinned)                    │ ← GxP rules, identity, safety
├────────────────────────────────────────────────────────┤
│ ACTIVE SCRATCHPAD / WORKING MEMORY (~8-16K, writeable) │ ← plan, hypotheses, TODOs
├────────────────────────────────────────────────────────┤
│ TASK CONTEXT (~20-40K, just-in-time)                   │ ← project summary, current batch
├────────────────────────────────────────────────────────┤
│ TOOL DEFINITIONS (~5-15K, dynamically loaded)          │ ← only tools for current task
├────────────────────────────────────────────────────────┤
│ RECENT EVENT QUEUE FIFO (~20-50K, auto-compacted)      │ ← last N tool calls + results
├────────────────────────────────────────────────────────┤
│ RETRIEVED SNIPPETS (~30-80K, per-turn)                 │ ← RAG hits
└────────────────────────────────────────────────────────┘
                    ↓ overflow ↓
        recall / archival / project / semantic memory
```

Mechanisms: **MemGPT virtual context** (Packer et al., arXiv:2310.08560) — `main_context` + `external_context` (recall/archival) via function calls; implemented in Letta. **Sliding window + recursive summarization** — Claude's `context-management-2025-06-27` beta provides automatic tool-result clearing. **RAPTOR hierarchical summaries** (Sarthi et al., ICLR 2024) — cluster→summarize→cluster again as a tree queryable at multiple abstraction levels. **Just-in-time handles** — store ELN IDs inline; fetch payload on explicit request. **Agentic note-taking** — Coscientist-style "decision logs" written after each sub-task.

### RAG architecture for heterogeneous pharma content

**Chunking per content type.** Prose (SOPs, 3.2.P.2, 3.2.P.8.1): semantic chunking at 512–1024 tokens, 15% overlap, with **Anthropic contextual retrieval** — prepend an LLM-generated 1–2 sentence summary to each chunk at index time (~+2.8pp Recall@5). Tables: linearized text with headers + parallel structured Postgres copy. Method sections: split by step, each carrying SOP ID and version. **Spectra: do NOT embed raw — index metadata + peak list + natural-language summary** ("¹H NMR, DMSO-d6, 400 MHz, 5 signals consistent with compound X"); keep pointer to original file. Patents: split by claim/embodiment with IPC-class sidecar.

**Embedding models (2026 state).** General scientific prose: Cohere embed-v4 (MTEB 65.2), Voyage-3/4-large (strong on scientific), OpenAI text-embedding-3-large (64.6), BGE-M3 — **Voyage Science** is the best first-party option. Biomedical: PubMedBERT, BioLORD, BioBERT as fine-tuned retrievers or as rerankers; E5-large-v2 as open baseline. **Chemical structures: ECFP4 + Tanimoto remains hard to beat** — benchmark (arXiv:2508.06199) shows only 4 learned models beat it on Bradley-Terry ranking; MolFormer-XL (IBM) best on regression; ChemBERTa-2 MTR variant; Uni-Mol/Uni-Mol2 for 3D-aware. **Spectrum embeddings** remain a frontier with no MTEB-equivalent — MS2DeepScore, MIST, 1D-CNN encoders are options.

**Retrieval strategy.** BM25 + dense via **Reciprocal Rank Fusion** (Cormack) — hybrid beats either alone on T2-RAGBench. **Cross-encoder reranker** (BGE-reranker-v2, Cohere Rerank 3, ColBERT MaxSim) is the **single largest quality lever**. **Metadata filtering** on `project_id`, `compound_id`, `document_type`, `date`, `version`, `regulatory_status` is essential — without filters, the agent retrieves SOPs from the wrong study phase. **HyDE** (Gao et al., arXiv:2212.10496) useful for discovery queries but **harmful for precision-sensitive numeric queries** (T2-RAGBench shows HyDE *underperforms* vanilla dense on financial/numeric questions — same for pharma "purity of Lot 7?"). Use HyDE only for open-ended exploration. **Query decomposition** and **Self-RAG** retrieval-gating tokens for multi-step scientific questions. **Multi-modal router tool** `rag_route(query)` dispatches to structure index (ECFP+FAISS/Qdrant-on-MolFormer), spectrum index, or text index.

### Knowledge representation — four-store hybrid

```
              ┌─────────────────────────────────┐
              │   Knowledge Graph (Neo4j)        │
              │   compounds, batches, reactions, │
              │   assays, projects, instruments, │
              │   analysts, documents, studies   │
              └───────────────┬─────────────────┘
                              │ cross-refs (node.id ↔)
 ┌──────────────┐   ┌─────────┴──────────┐   ┌───────────────┐
 │ Vector stores│   │ Relational (Postgres)   │ Object store  │
 │ pgvector/    │   │ batches, specs,    │   │ S3: mzML,     │
 │ Qdrant/      │   │ stability, COAs,   │   │ Bruker dirs,  │
 │ Weaviate     │   │ audit trail, Part11│   │ PDFs          │
 └──────────────┘   └────────────────────┘   └───────────────┘
```

**Why KG?** Pharma data is inherently relational: a batch is-a sample of a compound made by process at site by analyst, tested on instrument yielding result against specification under project. Neo4j has published pharma/drug-discovery reference patterns; extend **Bioschemas** and integrate public KGs (ChEMBL, PubChem, UniProt, MeSH) by URI. RDF for public-semantic-web interop; property graph for traversal performance.

**GraphRAG** (Microsoft, arXiv:2404.16130) extracts entities/relationships/claims, builds a graph, runs Leiden community detection, pre-generates community summaries. Baseline RAG answers local questions; community summaries answer global ones ("top 5 impurity themes across all stability studies for compound X"). Neo4j's GraphRAG guide has drug-discovery schema (BiologicalProcess, Condition, Drug, Gene, Pathway).

**Routing:** KG for multi-hop reasoning, provenance chains, regulatory impact ("which filings reference method M-045?"); vector for fuzzy similarity; relational for aggregations and Part-11 transactional writes; object for originals (PDF replay, spectrum reprocessing). Use pgvector if you want SQL+vector unified; Qdrant/Weaviate for scale.

### Long-term memory across sessions — four typed layers

| Layer | Backing | Write | Read | Example |
|---|---|---|---|---|
| Episodic | Append-only log + vector | Every session; nightly summarize | Similarity ("what did we try last week?") | "2026-03-14 user asked about AZ-12345 purity; pulled 3 HPLC runs; decision: retest Lot-7." |
| Semantic | KG + vector | Mem0-style ADD/UPDATE/DELETE/NONE with `is_current`/`replaces_id` | Auto-injected on entity match | "Catalyst Pd/C from supplier S leaches at >60°C in MeOH — observed in 3 runs." |
| Procedural | Versioned markdown + vector | Manual + agent-proposed | Retrieved by task type | OOS investigation playbook with tool-call sequence. |
| Project | Postgres row + scratchpad | Per-session | Loaded at session start | "AZ-12345, Ph.II, PM=Bob, active=[STAB-2025-07], open=[CMC method lock 2026-06-01]." |

References: MemGPT (2310.08560), A-Mem (2502.12110 Zettelkasten-inspired), Mem0/Mem0g (2504.19413 LoCoMo benchmark SOTA), Generative Agents importance/recency/relevance scoring, LangMem, Zep.

### Conflict resolution — never collapse silently

Pharma reality: two HPLC reports give 99.2% vs 98.6% for Lot 7; retest gives 99.0%; stability is OOS at month 12 but passes at 15. **Provenance-first storage** — every fact carries `(value, unit, source_uri, method_id, instrument_id, analyst, timestamp, review_status)`. **Confidence weighting** from method maturity + review_status + replicate count. **Explicit surface** — "Purity: 99.2% (Lot 7, HPLC-A, 2026-02-10, Approved) vs 98.6% (Lot 7, HPLC-B, 2026-02-11, Superseded). Recommend the Approved value; flag for QA review." **OOS escalation playbook** follows FDA OOS guidance — Phase I lab investigation before invalidation; **no averaging of OOS results** without documented justification. **Mem0 conflict detection at ingest** — before writing new semantic memory, retrieve similar facts; LLM picks ADD/UPDATE/DELETE/NONE with `replaces_id` preserving history.

### Context compression

Recursive summarization (FIFO tail) and hierarchical session summaries (daily→weekly→project, RAPTOR-style). **LLMLingua / LLMLingua-2 / LongLLMLingua** (Microsoft, EMNLP 2023 / ACL 2024) — small-LM token-level compression with coarse-to-fine budget, up to 20× compression, used inside LlamaIndex; LongLLMLingua targets "lost in the middle." Selective-Context drops low-PPL tokens (caution for numeric scientific content). **Agentic compression** — Anthropic's structured note-taking: agent writes compact markdown after each sub-task; raw trace cleared via `clear_old_tool_calls`.

---

## 7. Sensors in a pharma research harness

A **sensor** allows the agent to perceive the environment *without being explicitly prompted* and *initiate* a reasoning episode — the pharma analogue of SCADA tag subscriptions combined with cron. Sensors are what make an assistant proactive rather than merely reactive. Four parts: **subscription** (event topic, schedule, threshold), **predicate** (is this interesting?), **context packager** (what to hand to the agent), **action policy** (notify, draft, escalate, log).

### Taxonomy

| Type | Pharma examples |
|---|---|
| **Event-based** | ELN experiment signed; LIMS sample logged "tested"; CDS run complete; deviation opened; change-control event; SOP superseded; procurement PO received; literature alert hit |
| **Temporal** | Daily 06:00 stability-pull horizon scan (Q1A timepoints within 7/14/28d); weekly project digest; end-of-month Q10 management review; analyst-specific morning brief |
| **Threshold** | Impurity > Q3A qualification threshold; assay %LC < historical mean − 2σ; yield < last-5-batch median − 1σ; CPP excursion outside design space; OOS/OOT posted; reagent below reorder point |
| **Cross-project** | Same impurity in ≥2 programs; reagent supply disruption across routes; analyst workload >Nh/week for >2 weeks; shared column batch out-of-trend; recurring NMR assignment difficulty on a scaffold class |
| **Document/regulatory** | FDA guidance posting; ICH revision; pharmacopeial monograph change; health-authority precedent |
| **⚠️ Self-reflective** (frontier) | Gate block-rate rising; tool-call error spike; eval regression; user override frequency up on a playbook — triggers self-diagnostic |

### Integration pattern: deterministic rails, probabilistic reasoning

Traditional orchestration (Airflow, Prefect, cron, LangGraph triggers) fires a pre-defined pipeline; the behavior is locked at authoring time. Agent sensors fire a *reasoning session* whose plan forms at run time. Cron's stability-pull email only emails what the author coded; a sensor hands the pull list to the agent, which can notice pull #14 is for a batch with an unusual Week-6 result, correlate with a new literature report on a related degradation pathway, and propose an additional orthogonal test — none of which was scripted. The cost: sensors are more expensive, less predictable, harder to validate. The right pharma pattern is hybrid: **Airflow/cron schedules the sensor sweep; the sensor predicate is deterministic; only the action phase uses the LLM; and every LLM-initiated action goes through gates before affecting any system of record.**

Architecture: Kafka/Redis Streams/EventBridge as event bus; a "sensor registry" service subscribes to topics and cron, evaluates deterministic predicates, publishes *AgentInvocationRequest* envelopes to a per-project queue consumed by the harness:

```json
{
  "sensor_id": "S-STAB-PULL-APPROACHING",
  "fired_at": "2026-04-23T06:00:00Z",
  "priority": "P2",
  "context": {
    "project": "PRJ-1243",
    "study": "STB-DP-B3-2025",
    "pulls_due_next_14d": [
      {"tp":"T9M","target_date":"2026-05-02","conditions":"25C/60RH"},
      {"tp":"T6M","target_date":"2026-05-05","conditions":"40C/75RH"}
    ],
    "prior_anomalies": [{"tp":"T6M-30C","impurity":"IMP-D","value_pct":0.12}]
  },
  "suggested_playbook": "stability_trend",
  "action_policy": "draft_and_notify",
  "rbac_scope": "project_team_PRJ-1243"
}
```

### Self-registering sensors — tiered autonomy

**Tier 1 Templated** — agent selects from a catalog of sensor templates and fills parameters; registration still goes through human approval. Suitable for GxP-adjacent.

**Tier 2 Parameterized auto-tuning** — existing sensor's *threshold* (not predicate structure) auto-tuned on historical false-positive rate within an approved range. Acceptable if logged and periodically audited.

**Tier 3 ⚠️ Free-form sensor synthesis** — agent writes new predicate and deploys. **Not recommended in GxP.** Useful in purely exploratory discovery behind a sandbox with no write privilege; outputs advisory only.

Tier-1/2 template example:

```yaml
- id: T-IMPURITY-SCAFFOLD
  parameters:
    scaffold_smarts: {type: smarts}
    impurity_rt_window_min: {type: float}
    threshold_pct_LC: {type: float, min: 0.05, max: 0.5}
  predicate: |
    any(sample in recent_samples where
        structure_match(sample.parent, scaffold_smarts) and
        any(peak in sample.impurity_peaks where
            abs(peak.rt - impurity_rt_window_min) <= 0.2 and
            peak.pct_LC >= threshold_pct_LC))
  default_action: notify_and_draft_summary
  governance: requires_owner_approval
```

---

## 8. Self-evolution of the harness

### Can a harness genuinely self-evolve? — Four mechanisms with literature

**1. Prompt evolution through feedback loops.** Canonical: **Reflexion** (Shinn et al., arXiv:2303.11366) — Actor/Evaluator/Self-Reflection triple; verbal reflection maintained in episodic buffer; 20%+ absolute gains on AlfWorld, HotPotQA, HumanEval without weight updates. **SELF-REFINE** (Madaan et al., 2303.17651) is the single-generation variant. The evolutionary extreme is **Promptbreeder** (Fernando et al., DeepMind, 2309.16797) — binary-tournament genetic algorithm mutating both task-prompts and the mutation-prompts themselves; beat OPRO's "take a deep breath" on GSM8K (83.9% vs 80.2%). **OPRO** (Yang et al., DeepMind, 2023) uses the LLM as a black-box prompt optimizer. **EvoPrompt** is a conventional GA with fixed mutation prompt.

**2. Constitutional AI / self-critique.** Anthropic's **Constitutional AI** (Bai et al., 2212.08073): critique→revision→SL then RLAIF. Directly portable to harness self-modification: give the agent a harness constitution, have it produce outputs, critique against the constitution, propose amendments. **Self-Rewarding Language Models** (Yuan et al., Meta, 2401.10020) and **Meta-Rewarding** (Wu et al., 2407.19594) extend this — model as actor + judge; fine-tuning Llama 2 70B on three iterative-DPO rounds beat Claude 2, Gemini Pro, GPT-4 0613 on AlpacaEval 2.0.

**3. Tool discovery and synthesis.** **Voyager** (Wang et al., TMLR, 2305.16291) is the paradigm: LLM-powered Minecraft agent incrementally building a **skill library** of executable code, each skill embedded and retrieved when similar situations recur, complex skills composing simpler ones; 3.3× more unique items, 2.3× longer distances, tech-tree milestones 15.3× faster, and the library transfers to fresh worlds. For pharma: agent recognizes missing capability ("I have no tool to query ChEMBL by assay type"), writes typed wrapper, validates against known queries, adds to registry. ChemCrow and Coscientist use stable expert-designed tools — tool *synthesis* remains research-grade.

**4. Gate refinement from outcome data.** Least studied academically but most important for GxP. Indirect literature: **DSPy** (Khattab et al., 2310.03714) treats prompts as weights and uses teleprompters (BootstrapFewShot, MIPROv2, GEPA) to compile modules against a metric — gate thresholds, judge prompts, few-shot exemplars all sit in this optimization surface. **TextGrad** (Yuksekgonul et al., 2406.07496, published in *Nature* 2025) generalizes: backpropagates LLM-generated *textual* gradients through arbitrary non-differentiable graphs.

### The frontier: harness-level meta-search

**ADAS — Automated Design of Agentic Systems** (Hu, Lu, Clune, ICLR 2025, 2408.08435). Meta Agent Search iteratively programs new agents in Python, evaluates on benchmarks, grows an archive of diverse discovered agents. *"Programming languages are Turing Complete, so this approach theoretically enables the learning of any possible agentic system."* Agents transferred across domains (math→reading comprehension) and across foundation models; +14.4% on MGSM, +13.6 F1 on DROP vs hand-designed baselines.

**Darwin Gödel Machine** (Zhang, Hu, Lu, Lange, Clune, 2505.22954, Sakana AI, May 2025). Self-improving coding agent that rewrites its own Python codebase, empirically validates on SWE-bench (20.0→50.0%) and Polyglot (14.2→30.7%), maintains archive for open-ended exploration. **Critically relaxes Schmidhuber's original Gödel-machine requirement of *provable* self-modification to *empirical* validation** — an important conceptual shift for regulated deployment, because empirical validation against a benchmark is essentially what CSV/CSA already does.

Adjacent: AgentSquare, AutoAgents, AgentVerse, MetaGPT, EvolveAgent, Agent-E, STORM/Co-STORM.

### Production examples — largely no for genuine self-modification

Claude Code/Agent SDK/Managed Agents describe auto-compaction, progressive tool disclosure, and tool-set evolution by **humans** ("We replaced TodoWrite with the Task tool after observing coordination failures"). **Manus** reportedly took six months and five architecture rewrites before shipping. **Vercel v0** famously *removed 80% of tools* — humans editing harnesses. **DSPy in production** (Databricks, Google Cloud) runs optimizers offline; human commits the new prompt. **Hamel Husain**: *"I adjust the prompts by hand. I haven't had much luck with prompt optimizers like DSPy."* Contested but widely held. **DGM** is research-grade; the authors explicitly warn the repo "involves executing untrusted, model-generated code."

Sharma captures the practitioner consensus: *"Every hour spent mapping out a workflow graph is an hour spent codifying your current understanding of a task, which the model may already be able to surpass."* But neither he nor Anthropic ships systems that silently rewrite their own prompts.

### Safety implications in GxP-regulated environments

Regulatory landscape crystallized in 2024–2026:
- **21 CFR Part 11** requires automatic, computer-generated, tamper-evident audit trails preserving old and new values (§11.10(e)). A harness that rewrites its system prompt changes configuration governing record generation — must be audited and validated.
- **EU GMP Annex 11** draft revision (July 2025, expanded 5→19 pages) and **new Annex 22 on AI** (2025, final 2026) formally regulate AI/ML in GMP; risk-based lifecycle, model selection documentation, continuous monitoring, ALCOA+ controls, **prohibition on dynamic/continuously-learning models in critical GMP paths**.
- **GAMP 5 Second Edition** (ISPE, July 2022) supports iterative/Agile lifecycles; ISPE published the standalone **GAMP Guide: Artificial Intelligence** in July 2025 (~290 pages) — pharma's first comprehensive AI-lifecycle framework.
- **FDA Computer Software Assurance (CSA)** finalized September 24, 2025 — replaces 2002 General Principles of Software Validation with risk-based critical thinking and unscripted/exploratory testing.
- **FDA PCCP final guidance** (December 3, 2024) allows pre-authorization of modification "playbooks" with three documents: Description of Modifications, Modification Protocol, Impact Assessment. **Note: medical-device, not drug.**
- **FDA January 2025 draft guidance** on AI for drug regulatory decision-making with explicit Context-of-Use framework.
- **EMA Reflection Paper** on AI in medicinal product lifecycle (September 2024) — high patient risk vs. high regulatory impact buckets; accepts interpretability when full explainability is impossible.
- **FDA-EMA joint ten guiding principles** (January 14, 2026) — harmonized risk-based oversight.

**Core tension.** All frameworks assume a documented, validated, change-controlled system. Naive self-evolution violates multiple clauses simultaneously. **Validating a system that modifies itself** is not intractable if reframed as validating a *search process* rather than a static artifact — precisely DGM's empirical-validation insight. Validate the meta-procedure (how modifications are proposed, tested, accepted, rolled back) and the invariants it preserves — not each resulting agent instance. EMA's acceptance of interpretability as a fallback gives cover for this framing.

### Defensible architectural recipe — two-tier, append-only, human-gated

1. **Append-only harness versioning.** Every version of system prompt, tool schema, gate, constitution lives as an immutable commit with hash, timestamp, author (agent or human), rationale, diff, link to the eval run. Maps cleanly to Part 11 §11.10(e) and ALCOA+.
2. **Sandboxed shadow vs. production harness.** Shadow is where self-evolution runs (Promptbreeder, Reflexion, DGM rewrites, ADAS meta-search) against synthetic or de-identified data in a validated sandbox. Production is frozen at release.
3. **Human-in-the-loop promotion gate.** Promotion requires passing a fixed regression eval (Husain's Level 1/2/3 test hierarchy), CAB/CCB approval with documented rationale, training-data and audit-trail impact assessment. This is a PCCP-style pre-authorized playbook.
4. **PCCP-analogue for the agent.** Even though PCCP is SaMD-specific, its Description of Modifications / Modification Protocol / Impact Assessment structure is a well-accepted skeleton documenting the acceptable self-evolution envelope: the agent may modify prompts within these bounds, adjust tool selection within these tools, refine gates within these thresholds. Anything outside invalidates the plan.
5. **Constitutional invariants.** A human-authored constitution sits above the self-evolution loop and is never modified by the agent — encoding GxP invariants ("never fabricate a citation," "all structures must RDKit-validate," "never write to production LIMS without human e-signature"). Constitutional AI self-critique gives the agent a way to check proposed modifications against it before proposing.
6. **CCB for agent updates.** Staffed identically to CSV CCB (QA, IT, SME, Regulatory). For production-critical agents (batch release, IND content), CCB reviews every promotion; for research-only agents the CCB reviews the envelope quarterly.

Aligned with GAMP 5 2nd ed. Agile guidance and FDA CSA: validate what matters at the depth the risk demands.

---

## 9. Robustness and flexibility — the fundamental comparison

### The brittleness problem, precisely stated

Fateev's *fallacy of the graph*: the visual graph is a "lie" because real control flow depends on runtime expressions hidden inside nodes; graphs cannot represent dynamic step sets (LLM-emitted tool-call lists unknown at design time); error-handling explodes node counts combinatorially; untyped string selectors produce runtime failures; refactoring is weak. **"Falling off the graph"** — novel inputs hit an un-anticipated edge and the agent errors, stalls, or misroutes. Salesforce's Agentforce engineering blog frames this as "agent drop-off — agents losing their primary goal when users take tangents — common among customers who have implemented agents in complex real-world scenarios." FME: adding sentiment analysis to a LangGraph bot "usually requires updating the schema across six to eight graph nodes, revising ten to twelve conditional edges, and restructuring checkpoint logic — multi-day refactoring."

**Schema drift** compounds it. When PubMed E-utilities changes its response or ChEMBL releases a new endpoint, a graph with validation at many node boundaries breaks in many places; a single-LLM-router harness absorbs the change with a tool-description update.

### How harness engineering addresses brittleness

**Natural-language reasoning as universal router.** Tool-use LLM with well-described registry decides at runtime which tool to call, recovers from errors by reading the error message, chains novel combinations not enumerated in code. **Graceful degradation.** Anthropic's Claude Code "catches failures within tool handlers and returns them as error results to keep the loop running" — compare a graph where node failure hits a default edge often wrong for the specific failure mode. **Single semantic surface.** State is conversation log + filesystem (Claude Code: `CLAUDE.md`, session log, subagent mailbox); the agent reads arbitrary slices via `getEvents()`, eliminating typed-state schema brittleness. **Progressive disclosure of tools** — Claude Code loads tool names up front and discovers schemas on-demand; no graph analogue. **Context engineering by the harness, not the graph** — prompt-cache-friendly organization that reducers cannot easily replicate.

### Steelman for LangGraph — honest counter-arguments

- **Determinism.** A graph with deterministic edges produces reproducible execution traces; for GxP audit trails this is genuinely valuable. A free-form LLM loop has reproducibility problems even at temperature=0.
- **Debugging.** "When something broke, you knew exactly which node failed and why." LangGraph Studio + LangSmith provide mature state-transition debugging. Anthropic notes that full context resets sometimes beat compaction — harness debugging is non-trivial.
- **Explicit state, checkpointing, durable execution.** After a crash at step 8 of 10, LangGraph resumes at 8. For long-running scientific workflows (48h simulation → HPC wait → downstream analysis) this is valuable. Temporal makes the same point.
- **Regulatory comfort.** A drawn graph maps more easily to a URS for QA auditors. GAMP 5 2nd ed. does not *require* graphs but they fit traditional CSV mental models.
- **Hybrid determinism.** Salesforce Agentforce's "hybrid reasoning" uses explicit graphs to prevent drop-off while reasoning with LLMs inside nodes. For batch release, IND filing, pharmacovigilance intake — this is correct.

### Real-world evidence

Harness-first coding agents — Claude Code, Cursor, Devin, Factory, Replit Agent, Cognition, Sourcegraph Cody, GitHub Copilot Workspace — none ship a public stateful graph of their reasoning. Manus, ChemCrow, Coscientist, STORM/Co-STORM are harness-pattern. Production LangGraph shops (Uber, Box, Klarna, enterprise support) win on durable execution and checkpointing for high-SLA transactional flows. **Movement direction**: multiple practitioners (Sharma, Fateev, Husain implicitly, Teki, AI Engineer Summit 2024–2025 talks) describe *moving from LangGraph to harness patterns as models got stronger*; the opposite migration is rare in public writing and typically motivated by a specific deterministic subflow.

### The Terminal-Bench datapoint

Claude Opus 4.6 in Claude Code placed ~#33; the same weights in LangChain's custom harness jumped to #5. *"We only changed the harness."* Position drift ±4, but the signal is clear — harness engineering is the highest-leverage variable once model choice is fixed.

### Final recommendation for a pharma scientific research assistant

**Harness-first, with optional LangGraph components for critical deterministic workflows.** Reasoning:

1. **Scientific research is inherently open-ended.** The agent must pose sub-questions not specified at design time — *"Is there a SAR pattern in this series?"*, *"Do these adverse events cluster with a pharmacophore feature?"*, *"Has this target been modulated by a PROTAC in the literature?"* These cannot be pre-enumerated as graph edges. The harness + tool-use LLM gives the flexibility; Voyager/ADAS/DGM literature supports the capability claim.
2. **Multi-source ingest requires graceful degradation.** PubMed, ChEMBL, Reaxys, internal LIMS, SharePoint, Box, patents — each with failure modes and schema drift. A natural-language router absorbs new sources via tool-description updates.
3. **GxP invariants belong in the constitution, not the graph.** "Never fabricate a citation," "all structures must RDKit-validate," "no GxP-system writes without e-signature" are invariants, not workflow edges. A Constitutional AI-style critic enforces them uniformly across any reasoning path.
4. **Deterministic subflows get LangGraph nodes.** Specifically: batch-release and GMP-manufacturing decision support (rigid graph, checkpoints, durable execution, LangSmith audit); pharmacovigilance intake and E2B R3 coding (regulated, deterministic); IND section compilation (deterministic template); clinical-protocol final-draft assembly. The harness *calls* the graph as a sub-tool; the graph does not wrap the harness.
5. **Self-evolution sandboxed, human-gated.** Shadow harness evolves prompts/tools/gates against a regression eval set (DSPy MIPROv2 + TextGrad textual-gradient critique is a defensible stack); production harness frozen between releases; PCCP-style modification envelope documents pre-authorized changes; CCB approves promotion.
6. **Evaluation is the moat.** Per Husain: error analysis → binary LLM-as-judge → CI gates. Evaluation suite is versioned alongside the harness and is the *actual* validated artifact under GAMP 5 / CSA.

**What not to do.** Do not build the whole research agent as a LangGraph DAG — you will spend most engineering on edge-case branches, hit schema-drift failures, and cap autonomy below what the underlying model can deliver. Do not run open self-modification in production — you will invalidate Part 11 validated state. Do not skip the constitution — it is the cheapest and most auditable safety control you have.

---

## Conclusion — what has changed, what remains unsettled

The strong claim from this research is that **harness engineering is not merely an alternative to graph-based agent frameworks; it is the architectural consequence of model capability crossing a threshold**. When Claude 3.5 Sonnet hit SOTA on SWE-bench via tool-description refinement alone, and Claude Opus 4.6 jumped from rank 33 to rank 5 on Terminal-Bench 2.0 with no model change, the industry noticed. The graph was a reasonable assumption when models could not be trusted to route themselves; it has become a brittleness liability now that they can. The production coding-agent market has already migrated; pharma will follow, more slowly, because the floor is higher and the cost of a wrong inference is measured in patient safety and regulatory enforcement.

Four things remain **genuinely unsettled**. First, **self-evolving agents in GxP** — DGM-style empirical validation is conceptually compatible with CSA's risk-based framing, but no validated deployment exists as of April 2026; the industry is waiting for a case study. Second, **spectrum embeddings** — there is no MTEB-equivalent for MS/NMR, and current pharma RAG systems index metadata and peak lists rather than raw spectra. Third, **MCP scalability** — dynamic tool-loading is new (Anthropic Nov 2025) and agents with 100+ tools across pharma systems will need it before it is fully standardized. Fourth, **regulatory doctrine for self-modifying agents** — EMA's Reflection Paper, EU Annex 22, FDA's January 2025 draft, and the joint FDA-EMA January 2026 principles all gesture at the problem but none prescribe a validation methodology for an agent whose system prompt is a moving target. The defensible move today is to **architect for the regulation you expect** — append-only versioning, sandboxed evolution, constitutional invariants, PCCP-style envelopes — and to position evaluation suites as the validated artifact.

The single most counter-intuitive insight from the literature synthesis: **the harness is not the part that gets smarter — the model is**. The harness's job is to shrink over time, converting each success into a standard primitive that gets trained into the next model, leaving behind a progressively thinner layer of operational infrastructure. For pharma, this means the investment worth making is not a bespoke chain of reasoning steps that will be obsolete with the next model release, but a well-specified tool catalog, a stable constitution, a rich evaluation suite, and an evolving library of playbooks — all of which survive model upgrades because they describe the *domain*, not the *reasoning*. That is the real bet behind harness engineering, and it is the right bet for a scientific research assistant meant to serve chemists for the next decade.