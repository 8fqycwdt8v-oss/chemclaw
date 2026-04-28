# ADR 001: Core architecture

**Status:** Accepted (2026-04-22)
**Author:** Plan session with Claude Opus 4.7
**Plan file:** `~/.claude/plans/chemos-knowledge-intelligence-tranquil-marshmallow.md`

## Context

ChemClaw is the knowledge-intelligence use case of a broader chemistry
platform. Key requirements: bi-temporal KG with confidence + contradictions,
hybrid retrieval, proactive autonomous behavior, autonomous scientific tool
use, code-generation for plots, external-LLM egress, OpenShift target.

## Decision (summary)

- **Architecture shape**: A-on-C hybrid. LangGraph/Mastra agent on top;
  event-sourced ingestion core. Ingestion events → projectors (KG, vectors,
  DRFP) → derived views that the agent reads.
- **Backend runtime**: TypeScript (Mastra + Fastify) for orchestration;
  Python MCP servers for every scientific tool. MCP is the cross-language
  boundary.
- **Orchestration**: Paperclip (MIT, Node.js) adopted for issues / approvals
  / budgets / heartbeats, with documented workarounds for known issues.
- **Control flow**: Autonomous (model-driven) at the reasoning layer;
  graph-coded (deterministic) at plumbing (ingestion, projection, correction
  propagation, approvals).
- **Vector store**: pgvector + pgvectorscale on the app Postgres.
- **Knowledge graph**: Neo4j Community + Graphiti for bi-temporal edges.
- **Reaction encoder**: DRFP (MIT, data-independent, beats RXNFP on yield
  prediction).
- **Egress**: LiteLLM proxy + PII/IP redactor. Single outbound path.
- **Identity**: Azure AD / Entra ID via oauth2-proxy sidecar.
- **Frontend**: ~~Streamlit~~ (removed 2026-04-27 — being rebuilt in a
  separate repository; the in-tree client during the interim is the
  Python CLI at `tools/cli/`).

## Rejected alternatives

- **Hermes Agent as runtime** — single-user CLI harness, multi-user fit
  poor. Patterns (SKILL.md, DSPy GEPA, trajectory export) adopted instead.
- **NemoClaw** — alpha, NVIDIA-coupled, OpenShift primitives + gVisor
  deliver equivalent isolation. Revisit at Phase 9+ when robot writes land.
- **OpenClaw ecosystem** — ClawHavoc supply-chain incident + 137 CVEs in 62
  days. No dependency.
- **LangGraph.js** — Mastra's 2026 ergonomics preferred.
- **Full Python backend** — considered and rejected after user relaxed the
  Python-first constraint; TS orchestration + Python MCP tools picked for
  team fit. Scientific tools still Python-native behind MCP.

## Consequences

- Two runtimes to operate (Node for orchestrator + Paperclip, Python for
  MCP tools). Observability unified via OpenTelemetry → Langfuse.
- Paperclip pre-production status is a known risk; capped at 250 concurrent
  issues per company (well within department scale).
- Neo4j Community is GPL-3.0 — server-side use only, no binary redistribution.

## Full detail

See the plan file.
