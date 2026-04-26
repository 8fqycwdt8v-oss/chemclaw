# Plan: Mock ELN (Postgres) + LOGS-by-SciY MCP

## Context

The previous round deleted four vendor MCP adapters (`mcp_eln_benchling`, `mcp_lims_starlims`, `mcp_instrument_waters`, `mcp_admetlab`). The user wants to replace two of those slots with new services that match their actual stack:

1. **A local Postgres-backed mock ELN** for testing — ≥ 2000 protocols/experiments, mixed structured-ORD-schema + freetext (mostly mixed-per-entry, ~10–15% pure-extremes), realistic data quality variance, multiple projects, multiple chemistry families, and deliberate *process-development OFAT campaigns* where one canonical reaction has 100+ child entries varying solvent/base/ligand/temp/etc.
2. **A LOGS-by-SciY MCP** for analytical data — research confirmed LOGS is an SDMS from SciY (Bruker's vendor-agnostic software arm) that already extracts and normalizes metadata across HPLC/NMR/MS instruments and exposes it via REST + a Python SDK (`logs-python`). One MCP serves two backends: a live LOGS tenant *or* a local Postgres "fake LOGS" schema for hermetic testing.

The cache-and-project pipeline (`source-cache` post-tool hook regex `/^(query|fetch)_(eln|lims|instrument)_/` + `kg_source_cache` projector) was deliberately preserved when the old adapters were deleted; both new MCPs slot into it without changes.

## Architecture

```
┌──────────────────────────────────────────────────────────┐
│ agent-claw                                               │
│   tools (regex-matched into source-cache hook):          │
│     query_eln_experiments / fetch_eln_entry              │
│     query_eln_canonical_reactions  (OFAT-aware)          │
│     fetch_eln_canonical_reaction   (OFAT-aware)          │
│     fetch_eln_sample                                     │
│     query_instrument_runs / fetch_instrument_run         │
│     query_instrument_datasets (LOGS-aware filter shape)  │
└──────┬─────────────────────────────────┬─────────────────┘
       │                                 │
       ▼                                 ▼
┌──────────────────┐           ┌─────────────────────────┐
│ mcp_eln_local    │           │ mcp_logs_sciy           │
│ port 8013        │           │ port 8016               │
│ FastAPI          │           │ FastAPI                 │
└──────┬───────────┘           │  backend=fake-postgres  │
       │                       │  backend=real           │
       ▼                       └─────┬─────────────┬─────┘
┌──────────────────┐                 │             │
│ Postgres schema  │                 ▼             ▼
│ mock_eln         │           ┌──────────┐  ┌──────────────┐
│ ≥ 2000 entries   │           │ Postgres │  │ <tenant>.logs│
│ 4 projects       │           │ schema   │  │ -sciy.com    │
│ 10 OFAT campaigns│           │ fake_logs│  │ via REST     │
└──────────────────┘           │ ~3000 ds │  │ + logs-python│
                               └──────────┘  └──────────────┘
```

## Mock ELN — schema and data

### Schema (`db/init/30_mock_eln_schema.sql`)
Separate Postgres schema `mock_eln` in the existing `chemclaw` DB. Dedicated read-only role `chemclaw_mock_eln_reader` for the MCP.

Tables:
- `projects` (4 rows) — `code`, `name`, `therapeutic_area`, `started_at`, `ended_at`, `pi_email`
- `notebooks` (~30) — `project_id`, `name`, `kind` ∈ {discovery, process-dev, analytical}
- `compounds` (~600) — `smiles_canonical`, `inchikey`, `mw`, `external_id`, `project_id`
- `reactions` (~150 canonical) — `canonical_smiles_rxn`, `family`, `step_number`, `project_id`
- `entries` (≥ 2000) — `notebook_id`, `schema_kind`, `title`, `author_email`, `created_at`, `modified_at`, `signed_at`, `status`, `reaction_id` (nullable), `fields_jsonb`, `freetext` (text), `freetext_length_chars`, `entry_shape`, `data_quality_tier`, `signed_by`
- `entry_attachments` (~3500)
- `samples` (~3000)
- `results` (~5000)
- `methods` (~30) — analytical method registry
- `audit_trail` (~12000) — mutation history

Indexes: `(project_id, modified_at DESC)`, `(reaction_id)`, `(status)`, `(entry_shape)`, GIN on `fields_jsonb`, GIN on `freetext`.

View `mock_eln.canonical_reactions_with_ofat` precomputes `(reaction_id, ofat_count, mean_yield, last_activity_at)` for OFAT-aware queries.

### OFAT modeling (load-bearing decision)
**One canonical row per reaction in `reactions`; OFAT variants live in `entries` with the same `reaction_id` and per-entry condition variation in `fields_jsonb.conditions`.** Reaction-similarity treats canonical reactions as the unit (200 OFAT entries → 1 hit with `ofat_count=200`), not 200 near-duplicates.

### Structured-vs-freetext mix (per user direction "Both — mostly mixed, some extremes")

`entries.entry_shape` ∈ {`mixed`, `pure-structured`, `pure-freetext`} with distribution:

| Shape | % | Description |
|---|---|---|
| `mixed` | 80% | Both ORD-shape `fields_jsonb` AND `freetext` populated. Structured fields may be partial/messy (per `data_quality_tier`). Freetext is short narrative (50–500 chars typical) |
| `pure-structured` | 7% | High-throughput export rows: complete ORD `fields_jsonb`, `freetext` empty/null. Tests the "machine-generated" extreme |
| `pure-freetext` | 8% | Lab-notebook scribbles: `fields_jsonb` is empty/null, `freetext` carries everything (yield, conditions, observations free-form). Tests the "human-only" extreme |

`freetext_length_chars` distribution (across all entries that have any freetext):
- 30–80 chars (one-sentence notes): 35%
- 80–400 chars (paragraph observations): 40%
- 400–1500 chars (multi-paragraph experimental write-up): 20%
- 1500–6000 chars (full procedure narrative + analysis discussion): 5%

Freetext quality tiers (independent of length):
- Clean prose: 60%
- Abbreviated/jargon-heavy with chemist shorthand: 25%
- Typos, broken sentences, partial entries: 10%
- Contains OCR-style noise (simulating dictated/transcribed entries): 5%

`data_quality_tier` (independent dimension applying to structured fields):
- `clean` 50% / `partial` 25% / `noisy` 15% / `failed` 10%

### Project mix (≥ 2000 entries)

| Project code | Theme | Entries | OFAT campaigns | Reactions |
|---|---|---|---|---|
| NCE-1234 | Kinase inhibitor: discovery → process dev | 600 | 4 (~100 each) | 35 |
| NCE-5678 | Hit-to-lead, no PD | 250 | 0 | 25 |
| GEN-9999 | Pure process dev | 800 | 5 (200/180/160/140/120) | 50 |
| FOR-1111 | Formulation + analytical | 350 | 1 (60) + DoE | 40 |
| **Total** | | **2000** | **10** | **150** |

10 chemistry families across the OFAT campaigns: amide coupling, Suzuki, Buchwald–Hartwig, SNAr, ester hydrolysis, reductive amination, Boc-deprotection, hydrogenation, oxidation, alkylation.

### Time evolution
12–18 month spans per project; bursty around milestones; weekend/holiday gaps; 10–20 entries/chemist/month.

### Seed generator (`services/mock_eln/seed/generator.py`)
Deterministic (`WORLD_SEED=42`). Pipeline:
1. Generate compounds via SMARTS-templated reaction families (RDKit `AllChem.ReactionFromSmarts` over fragment pools).
2. Generate canonical reactions per family × step.
3. Sweep OFAT conditions per campaign spec; yield drawn from a noisy regression so TabPFN/Chemprop ground truth holds.
4. Generate non-OFAT discovery entries.
5. Stamp `entry_shape` + `data_quality_tier` per the distributions above.
6. Compose freetext via templates seeded from each entry's structured fields (so freetext is *consistent* with structured data when both are present in `mixed` shape — the agent must reconcile, not contradict).
7. Emit Postgres COPY files + a single idempotent `seed.sql`.

Generated fixtures checked into `test-fixtures/mock_eln/world-default/` (compressed) so CI is hermetic.

Feature flag: `MOCK_ELN_ENABLED=false` keeps the MCP unhealthy in production.

## LOGS MCP — design

### Two backends, one MCP

`mcp_logs_sciy` (port 8016) routes by `LOGS_BACKEND={fake-postgres|real}`:

- `fake-postgres` — reads `fake_logs` Postgres schema (seeded with ~3000 datasets across HPLC/NMR/MS) directly. Used in dev + CI.
- `real` — calls live LOGS via the `logs-python` SDK against `<tenant>.logs-sciy.com`. OAuth/API-key per LOGS docs. Used only when a tenant is configured.

### Dataset shape (canonical, same in both backends)

```python
class LogsDataset(BaseModel):
    backend: Literal["fake-postgres", "real"]
    uid: str                       # LOGS UID
    name: str
    instrument_kind: Literal["HPLC", "NMR", "MS", "GC-MS", "LC-MS", "IR"]
    instrument_serial: str | None
    method_name: str | None
    sample_id: str | None
    sample_name: str | None
    operator: str | None
    measured_at: datetime
    parameters: dict                # vendor-shape parameters, JSONB-flat
    tracks: list[Track]             # multi-detector or multi-FID support
    project_code: str | None        # for cross-source linkage to mock_eln.projects.code
    citation_uri: str               # LOGS web URL (real) or "local-mock-logs://..." (fake)
```

`Track` carries summary peak data for HPLC/MS (rt, area, height, name, m/z) — extraction left to a Phase 2 stretch; MVP returns metadata only and ranks the agent's "I need peaks" calls into a follow-up via the doc-fetcher's binary fetch path.

### Endpoints

```
POST /healthz
POST /readyz                         # 503 if fake DB unreachable / real tenant unauth
POST /datasets/query                 # filters: instrument_kind, since, project_code, sample_name
POST /datasets/fetch                 # one dataset by UID
POST /datasets/by_sample             # all datasets for a given sample_id
POST /persons/query                  # LOGS Person API parity (operators)
```

### Tool surface (agent-claw side, regex-compliant)

- `query_instrument_runs` → `/datasets/query` (route by instrument_kind filter)
- `fetch_instrument_run` → `/datasets/fetch`
- `query_instrument_datasets` → `/datasets/by_sample`

These three names match `/^(query|fetch)_instrument_/` so the source-cache hook fires automatically.

### Fake-postgres seed

`db/init/31_fake_logs_schema.sql` + `db/seed/21_fake_logs_data.sql`.

~3000 datasets seeded with project_code matching `mock_eln.projects.code` so cross-source scenarios work end-to-end (the agent can ask "find HPLC results for samples from NCE-1234 OFAT campaign 2" and traverse from `mock_eln.entries` → `mock_eln.samples` → `fake_logs.datasets` via `sample_id`).

Distribution: 60% HPLC, 20% NMR, 15% MS, 5% other.

## Source-cache + KG projector

**No changes.** Existing regex `/^(query|fetch)_(eln|lims|instrument)_/` in `services/agent-claw/src/core/hooks/source-cache.ts:20` catches all new tool names. `services/projectors/kg_source_cache/main.py` consumes ingestion events agnostically. Predicate maps in `source-cache.ts` (ELN_FIELD_PREDICATES, INSTRUMENT_RUN_PREDICATES) may want extension after seeing seeded data — incremental.

## Critical files to create / modify

### Create
- `db/init/30_mock_eln_schema.sql` — full DDL (idempotent)
- `db/init/31_fake_logs_schema.sql` — full DDL (idempotent)
- `db/seed/20_mock_eln_data.sql` — seed loader (gated by `MOCK_ELN=on`)
- `db/seed/21_fake_logs_data.sql` — seed loader (gated by `LOGS_BACKEND=fake-postgres`)
- `services/mock_eln/seed/generator.py` + `world.yaml`
- `services/mock_eln/seed/freetext_templates.py` — narrative templates per entry shape
- `services/mcp_tools/mcp_eln_local/{__init__.py,main.py,Dockerfile,requirements.txt}` + `tests/`
- `services/mcp_tools/mcp_logs_sciy/{__init__.py,main.py,backends/{fake_postgres.py,real_logs_sdk.py},Dockerfile,requirements.txt}` + `tests/`
- `services/agent-claw/src/tools/builtins/{query,fetch}_eln_*.ts` + tests (5 files)
- `services/agent-claw/src/tools/builtins/{query,fetch}_instrument_*.ts` + tests (3 files)
- `test-fixtures/mock_eln/world-default/` — generated artefacts checked in

### Modify
- `services/agent-claw/src/index.ts` — register 8 builtins
- `services/agent-claw/src/config.ts` — `MCP_ELN_LOCAL_URL`, `MCP_LOGS_SCIY_URL`, `LOGS_BACKEND` env
- `services/agent-claw/src/security/mcp-token-cache.ts` — JWT scopes for two new services
- `db/seed/05_harness_tools.sql` — UPSERT mcp_tools rows + tool catalog rows
- `docker-compose.yml` — add `mcp-eln-local` (testbed profile) + `mcp-logs-sciy` (sources profile)
- `infra/helm/{values.yaml,templates/sources-deployments.yaml}` — Helm wiring
- `AGENTS.md` — replace the "no source-system MCP adapters" note with sections describing both new MCPs + OFAT-aware tool guidance
- `CLAUDE.md` — Phase F.2 status line referring to this plan

## Existing utilities to reuse

- `services.mcp_tools.common.app.create_app(...)` — gives both MCPs `/healthz` `/readyz` request-ID middleware + standard `{error, detail}` envelope. (`services/mcp_tools/common/app.py`)
- `services/agent-claw/src/db/with-user-context.ts` — `withUserContext` for any pool-backed builtin reads (re-use for `fetch_eln_sample` if it joins audit_trail).
- `services/agent-claw/src/core/hooks/source-cache.ts` — the regex (line 20) and predicate maps (lines 26–46). Probably extend `INSTRUMENT_RUN_PREDICATES` after seeing seeded LOGS data.
- `services/projectors/kg_source_cache/main.py` — unchanged.
- `services/agent-claw/src/security/mcp-tokens.ts` + `mcp-token-cache.ts` — outbound JWT minting; just add the two scope entries.
- `services/agent-claw/src/streaming/sse.ts` — n/a (no streaming for these tools, but consistent with the rest of the harness).
- `tests/helpers/mock-pool.ts` — the test pool helper for the new builtin unit tests.

## Build order

| Phase | Scope | Effort |
|---|---|---|
| 1 | mock_eln schema + seed generator producing ≥ 2000 entries deterministically; checked-in fixtures | 1.5 weeks (data design dominates) |
| 2 | `mcp_eln_local` MCP + 5 agent-claw builtins + tests | 1 week |
| 3 | fake_logs schema + seed; `mcp_logs_sciy` MCP with `fake-postgres` backend + 3 agent-claw builtins + tests | 1 week |
| 4 | `mcp_logs_sciy` `real` backend (logs-python SDK) + cassette tests | 0.5 week — gated on a real LOGS tenant being available |
| 5 | docs, helm, compose, CLAUDE.md update | 0.5 week |

**Total: ~4 weeks** (Phase 4 deferred until real LOGS access lands).

## Verification

1. **Schema applies cleanly:** `make db.init` then `make db.seed MOCK_ELN=on LOGS_BACKEND=fake-postgres` succeeds twice in a row (idempotency).
2. **Seed produces target counts:** `psql -c "SELECT count(*) FROM mock_eln.entries;"` returns ≥ 2000; `SELECT entry_shape, count(*) FROM mock_eln.entries GROUP BY 1;` matches the 80/7/8/5 distribution within ±2pp; `SELECT data_quality_tier, count(*) FROM mock_eln.entries GROUP BY 1;` matches 50/25/15/10 ±2pp.
3. **OFAT view works:** `SELECT * FROM mock_eln.canonical_reactions_with_ofat ORDER BY ofat_count DESC LIMIT 5;` shows the 5 largest OFAT campaigns with `ofat_count ≥ 100`.
4. **MCPs come up:** `docker compose --profile testbed up mcp-eln-local mcp-logs-sciy` → both `/readyz` return 200.
5. **Agent end-to-end (mock):** with both MCPs running, ask the agent *"Find amide couplings in NCE-1234 with yield > 80% and show their HPLC purity"*. Expected: agent calls `query_eln_canonical_reactions` (filters family=amide_coupling, project=NCE-1234), then `fetch_eln_canonical_reaction` for the OFAT children, then `query_instrument_runs` for the linked samples. Final answer cites both `mock_eln` entries and `fake_logs` datasets.
6. **Source-cache fires:** `SELECT count(*) FROM ingestion_events WHERE event_type='source_fact_observed' AND payload->>'source_system_id' LIKE 'mock-eln-%' OR payload->>'source_system_id' LIKE 'fake-logs-%';` returns > 0 after the test run.
7. **Tests:** `npm test --workspace services/agent-claw` (≥ 650 passing; 8 new builtin tests added) + `pytest services/mcp_tools/mcp_eln_local/tests services/mcp_tools/mcp_logs_sciy/tests services/mock_eln/seed/tests` (~30 cases).
8. **Real LOGS smoke (Phase 4 only):** with a tenant configured, `mcp-logs-sciy` `/datasets/query` returns the expected dataset count and `/datasets/fetch` returns a known UID.

## Open questions (to confirm before/during implementation)

| # | Question | Default if not answered |
|---|---|---|
| 1 | Real LOGS-by-SciY tenant access for Phase 4? | Defer Phase 4; ship Phases 1–3 with `fake-postgres` only |
| 2 | mGears integration (read processed results / trigger Bricks) — in scope? | Out of scope for v1; revisit after Phases 1–3 land |
| 3 | Postgres location — same DB different schema (recommended) or separate DB? | Same DB, separate schema, separate read-only role |
| 4 | OFAT realism source — synthetic SMARTS-templated (recommended) or anchored to a published dataset (Doyle/Reisman/Sigman cross-coupling)? | Synthetic; use published datasets only as condition-distribution priors |
| 5 | Mock auth — soft-RLS via JWT user → project allow-list, or unrestricted? | Soft-RLS (exercises multi-project isolation tests; matches `mock-source-testbed.md` plan §12) |
| 6 | Demo readiness as explicit goal — polished project names, narrative entries, exec-summary attachments? | Yes — the seeded data also serves as live-demo material; small extra polish in Phase 1 |
| 7 | Agilent OpenLAB CDS — truly out of scope going forward? | Yes; LOGS-by-SciY supersedes it (LOGS ingests OpenLAB CDS data anyway when configured) |
