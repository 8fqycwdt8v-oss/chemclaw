# ADR 004 — Harness Engineering: Custom Loop Over Framework

**Status:** Accepted  
**Date:** 2026-04-23  
**Context:** ChemClaw Claw Code — Phases A–F

---

## Context

ChemClaw Phase 5A shipped a working autonomous agent on Mastra's ReAct loop. The
system was correct, but the harness was opaque. Adding per-step context compaction,
plan-mode preview, slash-command routing, or fine-grained token budgeting required
monkeypatching Mastra internals or wrapping every lifecycle point with middleware
that the framework was not designed to support.

Benchmarks (TerminalBench-2, Pi Research SWE-bench) showed that harness-quality
changes now dominate model-choice differences at the frontier — a single tool I/O
reformatting moved SWE-bench from 6.7% to 68.3%. This made harness engineering the
highest-leverage investment, not chemistry domain tools.

The user explicitly granted greenfield permission for the TypeScript agent layer.

---

## Decision

Build a ~500-LOC custom while-loop harness (`services/agent-claw/`) instead of
extending Mastra. The harness has **hooks as a first-class primitive**: five named
lifecycle points (`pre_turn`, `pre_tool`, `post_tool`, `pre_compact`, `post_turn`)
where YAML-defined plugins run without touching the core loop.

Keep everything else:
- Python MCP tool services (RDKit, DRFP, KG, embedder, etc.)
- Postgres-canonical → NOTIFY → projector → Neo4j/pgvector data layer
- `prompt_registry` table (now bound to the GEPA loop)
- LiteLLM egress gateway + redactor

---

## Rationale

**Why a custom loop, not Mastra?** Mastra's hook surface was insufficient for
plan-mode preview (requires structured output from the pre-tool step) and per-step
compaction (requires access to the accumulated message list between tool calls). A
~500-LOC custom loop gives full lifecycle control at lower complexity than wrapping
Mastra for the same hooks.

**Why hooks-first?** Every recurring cross-cutting concern (redaction, maturity
tagging, budget enforcement, stale-fact warnings, anti-fabrication) is a hook, not
bespoke code in a tool. This keeps `core/harness.ts` below 500 lines and makes the
concern list auditable from YAML files without reading TypeScript.

**Why skills?** Skills (filesystem `skills/<pack>/SKILL.md`) express domain knowledge
as loadable context, not code. They are JIT-loaded (only the matching pack's content
enters the system prompt), capped at 8 active simultaneously, and promotable via
Voyager-style success-rate gating. This mirrors the finding that 30+ tools degrade
performance while 8 focused tools maximise it.

**Why forged tools?** Inspired by El Agente Forjador (Aspuru-Guzik et al., 2025),
tools the agent generates are persistent, cross-project-shareable, validated nightly,
and promotable from `private` to `org` scope. Weaker (cheaper) models can reuse
tools forged by stronger ones without paying the original LLM cost. This compounds
over time.

**Why we kept the data layer's A-on-C pattern?** The Postgres canonical → NOTIFY →
projector → KG/pgvector event-sourced architecture is correct and load-bearing.
Re-derivable views (KG nodes, vector embeddings, maturity tiers) are rebuilt from
the event log by deleting projection acks. This turns any corruption into a
replayable state rather than a data loss incident.

---

## Consequences

- `services/agent-claw/` is the only agent service. `services/agent/` deleted in
  Phase F.2.
- Adding a new hook requires: one YAML file in `hooks/`, one `.ts` file in
  `services/agent-claw/src/core/hooks/`, and optionally a test. No harness changes.
- Adding a new tool requires: one `.ts` file in `tools/builtins/`, one SQL UPSERT
  in `db/seed/05_harness_tools.sql`, and optionally a skill pack.
- The GEPA loop (`services/optimizer/`) optimises `prompt_registry` prompts nightly
  against the golden set. The harness self-improves between releases without code
  changes.
