# ADR 005 — Data Layer: On-Demand Structured-Source Reads

**Status:** Accepted (partially superseded — see note below)
**Date:** 2026-04-23
**Context:** ChemClaw Claw Code — Phase F.2

> **2026-04-26 update — adapter implementations removed.** The three reference adapters described in this ADR (`mcp_eln_benchling`, `mcp_lims_starlims`, `mcp_instrument_waters`) have been removed from the build. The architectural decision — *on-demand reads + cache-and-project rather than bulk replication* — still stands and is preserved end-to-end (the `source-cache` post-tool hook and the `kg_source_cache` projector are still wired). Any future ELN/LIMS/instrument adapter that registers a builtin matching `/^(query|fetch)_(eln|lims|instrument)_/` inherits the pipeline; see `services/mcp_tools/mcp_instrument_template/README.md` for a starting point.

---

## Context

The original ChemClaw design replicated raw ELN/LIMS/instrument data wholesale into
local Postgres (canonical source of truth). This served the GxP audit model: every
fact needed a local immutable copy with a timestamp and operator attribution.

Following the GxP exit (Phase A), that model earns its keep only for what ChemClaw
*computes*. Replicating raw ELN entries, LIMS results, and instrument runs to serve
on-the-fly queries is unnecessary infrastructure cost with no scientific payoff.

---

## Decision

Local Postgres owns (canonical, persistent): the KG event log + projection acks,
hypotheses, research reports, prompt registry, feedback events, skill library,
vector embeddings, reaction DRFP vectors, and computed maturity/confidence fields.

Source systems own (read on-demand, not replicated): raw ELN entries, LIMS test
results, instrument runs, registered compounds, project metadata.

Source-system MCP services (`mcp_eln_benchling`, `mcp_lims_starlims`,
`mcp_instrument_waters`) expose typed read endpoints. The agent calls them
on-demand. When it does, the `source-cache` post-tool hook writes
`ingestion_events` rows with `event_type='source_fact_observed'` and provenance
fields (`source_system_id`, `source_system_timestamp`, `fetched_at`, `valid_until`).
The `kg_source_cache` projector converts these into `:Fact` nodes.

One exception: reactions (with DRFP vectors and KG nodes) stay replicated because
the agent runs cross-project similarity search over them and that must be cheap.

---

## Rationale

**On-demand reads** eliminate the dual-write consistency problem. The source system
is always the authority; ChemClaw is always reading a recent view.

**Cache-and-project** means the agent's second question about the same ELN entry
hits the KG rather than the external API, keeping latency low.

**TTL invalidation** (default 7 days, per-predicate override) handles freshness
without webhooks. When stale facts are detected (valid_until < now), the pre-turn
hook injects a warning into working memory; the agent decides whether to re-fetch.

**`eln_json_importer` is preserved as `.legacy`** for one-shot bulk migrations.
Existing rows in `experiments` are not removed.

---

## Consequences

- New ELN data enters the system via `query_eln_experiments` / `fetch_eln_entry`
  tool calls, not batch imports.
- The `kg_source_cache` projector handles idempotency via deterministic UUIDv5
  `fact_id`s (same event → same node, no duplicates on replay).
- `make import.sample` is renamed to `make import.sample.legacy` with a deprecation
  warning.
- Source-system MCP adapters are templated: forking `mcp_instrument_waters` for a
  new vendor requires <1 day of work (see the template README).
