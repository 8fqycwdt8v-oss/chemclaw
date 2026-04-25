# eln_json_importer (legacy — not in live path)

This directory contains the original ELN JSON bulk importer that was used during
Phases 0–2 to replicate structured ELN data into the local Postgres `experiments`
table.

## Status: Retired from live ingest path (Phase F.2)

As of Phase F.2, new ELN entries flow through `mcp_eln_benchling` (read on-demand,
cache-and-project semantics). This importer is **no longer started by Docker Compose**
and is **not in the active CI path**.

The code is preserved for one-shot bulk migrations only — for example, backfilling
historical data before a new deployment.

## When to use this

Use `make import.sample.legacy` (or invoke the CLI directly) only when you need to
bulk-load historical ELN JSON data that pre-dates the mcp_eln_benchling integration.

```bash
make import.sample.legacy
# or directly:
.venv/bin/python -m services.ingestion.eln_json_importer.legacy.cli \
  --input path/to/eln-export.json
```

## Why it was retired

Under the GxP-exit architecture revision (plan: go-through-the-three-vivid-sunset.md),
raw ELN/LIMS/instrument data is read on-demand via source-system MCP adapters rather
than replicated wholesale. The KG opportunistically caches what the agent observes
(with TTL-based invalidation). Full replication is maintained only for what ChemClaw
computes: KG event log, hypotheses, vectors, skill library.

Existing rows in `experiments` from pre-migration imports are preserved; they are not
removed. New entries discovered via `query_eln_experiments` / `fetch_eln_entry` are
projected into the KG via the `kg_source_cache` projector.
