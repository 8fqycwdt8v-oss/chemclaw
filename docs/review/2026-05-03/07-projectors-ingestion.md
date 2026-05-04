# Projectors & Ingestion Pipeline Audit — 2026-05-03

Read-only static analysis of `services/projectors/` (10 projectors + shared
base) and `services/ingestion/` (doc_ingester + eln_json_importer.legacy)
plus the mock-ELN seeding path. Cross-referenced against `db/init/01_schema.sql`
(canonical event log), `db/init/23_qm_results.sql` and `db/init/24_compound_fingerprints.sql`
(NOTIFY triggers), and the prior audit at
`docs/review/2026-04-29-codebase-audit/00-summary.md`.

## Executive Summary

The base abstraction (`services/projectors/common/base.py`) is solid: LISTEN
opens BEFORE catch-up to close the seam-race, the catch-up loop drains
without LIMIT truncation, the listen loop races shutdown so SIGTERM wakes
within `_NOTIFY_POLL_TIMEOUT_S`, and a transient `psycopg.OperationalError`
triggers an exponential-backoff reconnect that resumes from the durable
`projection_acks` cursor (`base.py:123-145`). Idempotency is real for
9/10 projectors (UPSERT or `WHERE col IS NULL` guards), the
`PermanentHandlerError` distinguishes data-permanent from transient
failures, and `dist`-vs-`src` symbol parity holds for the agent-claw
hooks that emit events.

What does NOT hold is the *event topology*. The four projectors that
subscribe to `experiment_imported`
(`reaction_vectorizer`, `kg_experiments`, `kg_hypotheses`,
`conditions_normalizer` — wait, kg_hypotheses subscribes to
`hypothesis_*`; the three are reaction_vectorizer / kg_experiments /
conditions_normalizer) have **no live emitter** in the build. The only
writer (`services/ingestion/eln_json_importer.legacy/importer.py:258`) is
import-broken (its imports still reference `services.ingestion.eln_json_importer`
without the `.legacy` package suffix; `python -m
services.ingestion.eln_json_importer.legacy.cli` fails with
`ModuleNotFoundError`), so the `make import.sample.legacy` target in the
Makefile is **non-functional**. The mock-ELN seeder writes only into the
`mock_eln` schema and does not touch canonical `experiments`/`reactions`,
so seeded dev data also never fans-out to projectors. Three projectors
are therefore live but starved.

The same audit found one production-path defect in agent-claw's source-cache
hook: `services/agent-claw/src/core/hooks/source-cache.ts:370-378` writes
`source_row_id` as `${source_system_id}:${subject_id}` (a string like
`hpc:sample_AB`) into a `UUID` column — this insert raises
`invalid input syntax for type uuid` at runtime; the unit test at
`tests/unit/hooks-source-cache.test.ts` mocks the DB client and never
exercises the type. `kg_source_cache` therefore receives **zero** events
in any environment whose Postgres actually validates the type. (The
`propose_hypothesis` builtin two files over does the right thing —
`$2::uuid` cast at builtin.ts:101.)

`qm_kg` runs the **synchronous** Neo4j driver
(`from neo4j import GraphDatabase`, `qm_kg/main.py:261`) and calls
`self._merge_into_neo4j(row, conformers)` from inside an `await` block
without `asyncio.to_thread` (`qm_kg/main.py:215`). Every QM job projection
blocks the event loop for the duration of the Neo4j round-trip, delaying
the `qm_job_succeeded` LISTEN loop and (under sustained load) dropping
NOTIFYs. `kg_hypotheses` does the right thing —
`AsyncGraphDatabase.driver` at line 38, `await session.run(...)` throughout.
On top of that, exceptions from `_project_job` are not caught inside
`_listen_loop_qm` (lines 152-153, no try/except), so a transient Neo4j
blip propagates up to `run()`'s `except Exception: raise` and kills the
process — restart-loop territory for the qm-kg container.

`kg_hypotheses` ack key is `"kg-hypotheses"` (hyphen) while every other
projector uses underscores (`reaction_vectorizer`, `chunk_embedder`,
`kg_experiments`, …). The replay runbook in CLAUDE.md says
`DELETE FROM projection_acks WHERE projector_name='X'`, and an operator
who follows the dominant convention will fail to clear hypothesis acks.
`kg_hypotheses` also calls `logging.basicConfig(...)` at startup
(line 167) instead of the centralised `configure_logging` —
this violates the CLAUDE.md "Logging" requirement
("Never use `console.log` / `print` in service code … structured JSON")
and the logs go out unstructured to stdout. `kg_source_cache` doesn't
configure logging at all (no call site for `configure_logging` or
`basicConfig`) — same violation. The `request_id` correlation feature in
`base.py:294-302` is dead in practice: no writer
(`doc_ingester/importer.py:144-151`, `propose_hypothesis.ts:99-107`,
`source-cache.ts:367-380`) includes `request_id` in the JSONB payload, so
the LoggerAdapter always falls back to event_id and the cross-boundary
trace never composes.

`hypothesis_status_changed` (subscribed by `kg_hypotheses` at line 31) has
zero emitters — neither the agent-claw codebase nor any DB trigger writes
that `event_type`. The branch at `_handle_status_changed` (`kg_hypotheses/main.py:132-162`)
is dead code today.

Six of ten projectors open a fresh `psycopg.AsyncConnection` per event
inside `handle()` instead of reusing `work_conn` from the loop:
`reaction_vectorizer:67`, `conditions_normalizer:91`, `chunk_embedder:65`,
`contextual_chunker:81`, `kg_experiments:117`, `kg_hypotheses:61,136`. At
department-scale ingest this is fine; at sustained load (Phase F.2 catch-up
on a fresh image) it is a connection-pool sink. None of the projectors
acquire row-level locks on `projection_acks` either, so two replicas of
the same projector will double-process a given event (the second replica's
ack INSERT just hits `ON CONFLICT DO NOTHING`). The intended deployment
model is **singleton replicas** — that constraint is not enforced or
documented but is load-bearing.

The two columns flagged in prior audit H5
(`document_chunks.byte_start`/`byte_end`) ARE now populated by
`doc_ingester/importer.py:121-140` — H5 is RESOLVED. M7 (the
`kg_hypotheses` `valid_to` idempotency drift on replay) is also resolved
by the `CASE WHEN h.valid_to IS NULL` guard in
`kg_hypotheses/main.py:151-156`.

| Severity | Finding | Projector | File:line | Fix sketch |
|---|---|---|---|---|
| H | `kg_source_cache` receives zero events because the source-cache hook writes a non-UUID string into `ingestion_events.source_row_id UUID` | n/a (writer side) | `services/agent-claw/src/core/hooks/source-cache.ts:370-378` | drop `source_row_id` from the INSERT (it's a hook-derived event with no canonical row), set it to `NULL`, and let the projector key off the JSONB payload instead |
| H | `experiment_imported` has no live emitter; three projectors (reaction_vectorizer / kg_experiments / conditions_normalizer) starve | reaction_vectorizer, kg_experiments, conditions_normalizer | only emitter is `services/ingestion/eln_json_importer.legacy/importer.py:258` (import-broken) | restore a live emitter — either add an INSERT-into-`experiments` path that fires the event from one of the source-system MCPs, or fix legacy importer's import paths and seed via `make import.sample.legacy` |
| H | `make import.sample.legacy` target dies with `ModuleNotFoundError: services.ingestion.eln_json_importer` | n/a (ingestion) | `Makefile:136`, `services/ingestion/eln_json_importer.legacy/cli.py:15`, `importer.py:23,27` | rewrite the imports to `services.ingestion.eln_json_importer.legacy.{schemas,importer,settings}`, OR drop the broken target |
| H | `qm_kg` runs sync Neo4j driver inside async event loop — every projection blocks LISTEN | qm_kg | `services/projectors/qm_kg/main.py:215, 261-268` | switch to `from neo4j import AsyncGraphDatabase` (matches `kg_hypotheses` pattern) and `await sess.run(...)`; OR wrap each `_merge_into_neo4j` call in `await asyncio.to_thread(...)` |
| H | `qm_kg._listen_loop_qm` does not catch exceptions from `_project_job`; a transient Neo4j outage exits the loop, propagates to `run()`, and crashes the container into a restart loop | qm_kg | `services/projectors/qm_kg/main.py:152-153` | add `try/except Exception: log.exception(...); continue` around `await self._project_job(work_conn, job_id)` (transient) and `try/except` in `_catch_up_qm:118-121` |
| M | `kg_hypotheses` ack key is `"kg-hypotheses"` (hyphen) — diverges from all other projectors and from CLAUDE.md replay runbook | kg_hypotheses | `services/projectors/kg_hypotheses/main.py:30` | rename to `"kg_hypotheses"`; one-shot migration to relabel ack rows |
| M | `kg_hypotheses` uses `logging.basicConfig(...)` instead of `configure_logging` — CLAUDE.md violation, unstructured log output | kg_hypotheses | `main.py:167` | replace with `configure_logging(settings.projector_log_level, service="kg_hypotheses")` |
| M | `kg_source_cache` never configures logging — output is unstructured | kg_source_cache | `services/projectors/kg_source_cache/main.py:163-166` (top-level `if __name__`) | add `from services.mcp_tools.common.logging import configure_logging` and call before `projector.run()` |
| M | `hypothesis_status_changed` has zero emitters; `_handle_status_changed` is dead | kg_hypotheses | `main.py:132-162` (subscriber); no emitter exists | either wire a DB trigger on `hypotheses.status` updates, or remove the subscription branch + handler |
| M | `qm_kg` writes a synthetic `ingestion_events` row whose `id` collides with `qm_jobs.id`, broadcasting on `ingestion_events` channel; every other projector then catch-ups, ignores, and acks — pollutes `projection_acks` | qm_kg | `qm_kg/main.py:240-245` | use the natural ack-row pattern (real `ingestion_events.id` separate from job_id) — or accept the trade and document |
| M | Six projectors open fresh `AsyncConnection` per `handle()` rather than reusing loop's `work_conn` — connection-pool churn at scale | reaction_vectorizer, conditions_normalizer, chunk_embedder, contextual_chunker, kg_experiments, kg_hypotheses | see "Findings" §F.10 | reuse `work_conn` from the listen loop; only open ad-hoc when transactional isolation is needed |
| M | `request_id` correlation feature in `base.py:294-302` is dead — no writer includes it in payload | all projectors | `doc_ingester/importer.py:144-151`, `propose_hypothesis.ts:99-107`, `source-cache.ts:367-380` | thread `request_id` through writers (or delete the LoggerAdapter scaffolding) |
| L | `compound_classifier` imports `PermanentHandlerError` but never uses it (dead import) | compound_classifier | `main.py:29` | drop the import |
| L | `kg_source_cache` imports `psycopg`/`dict_row` but uses neither directly | kg_source_cache | `main.py:23-24` | drop unused imports |
| L | `compound_fingerprinter._fingerprint` does not gate on `fp_version IS NULL OR fp_version <> _FP_VERSION` at handle-time; duplicate NOTIFYs re-do full work (still idempotent, just wasteful) | compound_fingerprinter | `main.py:159-241` | early-return when `fp_version = _FP_VERSION` and SMARTS rules unchanged |
| L | Multi-replica deployment model not enforced — two replicas would double-process events; only saving grace is `projection_acks` PK collision after both write | all projectors | `base.py:347-356` | document the singleton expectation, OR add `pg_try_advisory_lock` per-`projector_name` at `_connect_and_run` start |

## Per-projector Scorecard

| Projector | name | event_types | idempotent | failure-handled | signal-handled | DB role | replay-safe |
|---|---|---|---|---|---|---|---|
| chunk_embedder | `chunk_embedder` | `("document_ingested",)` | yes — `WHERE embedding IS NULL` re-query gate | 4xx skip; 5xx propagates | inherited base | `chemclaw_service` (compose) | yes |
| compound_classifier | `compound_classifier` | `()` (drives off `compound_fingerprinted` channel) | yes — close-old-then-insert-if-not-exists, deterministic confidence by priority | broad `except: log.exception` swallows | inherited base | `chemclaw_service` | yes |
| compound_fingerprinter | `compound_fingerprinter` | `()` (drives off `compound_changed` channel) | yes — UPDATE compounds is full-row replace; SMARTS hits ON CONFLICT DO UPDATE | per-rule try/except continues; `PermanentHandlerError` raised on 4xx but caught by `except Exception` in catch-up loop | inherited base | `chemclaw_service` | yes |
| conditions_normalizer | `conditions_normalizer` | `("experiment_imported",)` | yes — `COALESCE(col, %s)` and `extraction_status \|\| %s::jsonb` merge | inherits base behaviour | inherited base | `chemclaw_service` | yes — but starved (no emitter) |
| contextual_chunker | `contextual_chunker` | `("document_ingested",)` | yes — `WHERE contextual_prefix IS NULL` guard on the UPDATE itself | 4xx writes empty-string sentinel to prevent retry storms; 5xx propagates | inherited base | `chemclaw_service` | yes |
| kg_experiments | `kg_experiments` | `("experiment_imported",)` | yes — UUIDv5 deterministic `fact_id` ensures KG MERGE collapses | RDKit failures degrade to ungrounded fallback; KG write_fact failures propagate | inherited base | `chemclaw_service` | yes — but starved (no emitter) |
| kg_hypotheses | **`kg-hypotheses`** (HYPHEN; inconsistent) | `("hypothesis_proposed", "hypothesis_status_changed")` | yes — UUIDv5 fact_id; `valid_to = CASE WHEN IS NULL` guard for refuted | inherits base; `_handle_status_changed` second branch is dead | inherited; **`SET LOCAL ROLE chemclaw_service`** is no-op since connection is already that role | yes |
| kg_source_cache | `kg_source_cache` | `("source_fact_observed",)` | yes — UUIDv5 fact_id derived from `(event_id, source_system_id, predicate, subject_id, object_value)` | inherits base | `chemclaw_service` | yes — but receives zero events (UUID-cast bug in writer) |
| qm_kg | `qm_kg` | `("qm_job_succeeded",)` (custom channel, NOT `ingestion_events`) | yes — bi-temporal close-old then MERGE | **NO** try/except in listen loop → transient Neo4j blip crashes container | inherited; sync neo4j driver blocks event loop | yes |
| reaction_vectorizer | `reaction_vectorizer` | `("experiment_imported",)` | yes — `WHERE drfp_vector IS NULL` query gate | 4xx WARN+skip; 5xx propagates | inherited base | `chemclaw_service` | yes — but starved (no emitter) |

## Event Topology Map

| Event type | Emitters (file:line) | Subscribers (projector) |
|---|---|---|
| `document_ingested` | `services/ingestion/doc_ingester/importer.py:144-151` (live) | `chunk_embedder`, `contextual_chunker` |
| `experiment_imported` | `services/ingestion/eln_json_importer.legacy/importer.py:258` (**broken — import path mismatch; not callable**) | `reaction_vectorizer`, `kg_experiments`, `conditions_normalizer` |
| `hypothesis_proposed` | `services/agent-claw/src/tools/builtins/propose_hypothesis.ts:99-107` (live, with `$2::uuid` cast) | `kg_hypotheses` |
| `hypothesis_status_changed` | **NONE** | `kg_hypotheses` (orphan subscription; `_handle_status_changed` is dead) |
| `source_fact_observed` | `services/agent-claw/src/core/hooks/source-cache.ts:370-378` (live, **but UUID-cast bug — every insert raises**) | `kg_source_cache` |
| `qm_job_succeeded` | DB trigger `notify_qm_job_succeeded` on `qm_jobs` (`db/init/23_qm_results.sql:177-189`) — fires on `pg_notify('qm_job_succeeded', NEW.id::text)`; ALSO synthetically inserted into `ingestion_events` by `qm_kg._ack` (`qm_kg/main.py:240-245`) which echoes onto the main `ingestion_events` channel | `qm_kg` (custom channel; NOT `ingestion_events`) |
| `compound_changed` | DB trigger on `compounds` (`db/init/24_compound_fingerprints.sql:86-101`) | `compound_fingerprinter` (custom channel) |
| `compound_fingerprinted` | `compound_fingerprinter._fingerprint` step 5: `pg_notify('compound_fingerprinted', inchikey)` (`compound_fingerprinter/main.py:240`) | `compound_classifier` (custom channel) |

**Orphan event types (no subscriber):** none.

**Orphan subscriptions (no emitter):**
- `hypothesis_status_changed` — `kg_hypotheses/main.py:31`
- `experiment_imported` (effectively orphan since the only emitter is import-broken) — `reaction_vectorizer/main.py:45`, `kg_experiments/main.py:64`, `conditions_normalizer/main.py:83`

**Cross-channel coupling:** `qm_kg._ack` writes a synthetic `ingestion_events`
row to satisfy the `projection_acks(event_id)` FK, which fires the
`notify_ingestion_event` trigger and broadcasts on the main channel. Every
other projector picks it up, sees `event_type='qm_job_succeeded'` is not
in their `interested_event_types`, falls through the silent-skip branch
(`base.py:307-313`), and writes an ack anyway. Net effect: every QM job
generates `N` ack rows where `N` = total number of `BaseProjector`-derived
projectors LISTENing on `ingestion_events` (currently 6). Pollution, not
correctness.

## Findings (Full Appendix)

### F.1 (HIGH) `kg_source_cache` is silently dead — UUID cast bug in writer

`db/init/01_schema.sql:184-191` defines `ingestion_events.source_row_id` as
`UUID`. `services/agent-claw/src/core/hooks/source-cache.ts:370-378`
inserts `${fact.source_system_id}:${fact.subject_id}` (a string like
`"hpc:sample_AB"`) into that column. Postgres rejects with
`invalid input syntax for type uuid`. The unit test at
`tests/unit/hooks-source-cache.test.ts:30-36` mocks `withUserContext` so
the type check never happens in CI.

Two-files-over (`propose_hypothesis.ts:99-107`) the same pattern is
correct: `'$2::uuid'` cast on a real UUID. The hook's `subject_id` is a
foreign-system identifier, not a chemclaw UUID — drop the column from
the INSERT (the projector keys off `payload.predicate` + `payload.subject_id`
anyway) and let `source_row_id` default to NULL.

### F.2 (HIGH) Three projectors starve — `experiment_imported` has no live emitter

```
$ grep -rn "INSERT INTO experiments" services/ scripts/
(no matches outside services/ingestion/eln_json_importer.legacy/)
```

The legacy importer is the only writer. Its imports
(`services/ingestion/eln_json_importer.legacy/{cli.py:15,importer.py:23,27}`)
reference `services.ingestion.eln_json_importer.{cli,importer,schemas,settings}`
without the `.legacy` suffix, and the package directory is named
`eln_json_importer.legacy`. Verified with a real interpreter:

```
$ python3 -c "import services.ingestion.eln_json_importer.legacy.cli"
ModuleNotFoundError: No module named 'services.ingestion.eln_json_importer'
```

The Makefile target `import.sample.legacy:136` will fail with
`ModuleNotFoundError`. The mock-ELN seeder writes only into the `mock_eln`
schema; it never touches canonical `experiments`/`reactions`. `mcp_eln_local`
is read-only (`grep "INSERT" services/mcp_tools/mcp_eln_local/queries.py routes.py` →
no matches). Net effect: in a fresh environment with `make up` + `make db.seed` +
ingest of mock ELN data, `reaction_vectorizer`, `kg_experiments`, and
`conditions_normalizer` all sit on idle LISTENs forever.

### F.3 (HIGH) `qm_kg` blocks event loop with sync Neo4j driver

```py
# qm_kg/main.py:261-268
from neo4j import GraphDatabase  # sync
self._neo4j_driver = GraphDatabase.driver(...)

# qm_kg/main.py:215
self._merge_into_neo4j(row, conformers)  # sync, called inside async _project_job
```

For each succeeded job, every `sess.run(...)` (lines 277, 291, 329)
blocks the asyncio event loop for the Neo4j round-trip. The `_listen_loop_qm`
co-routine is therefore stalled and a NOTIFY arriving during the merge
sits in the kernel buffer until the merge returns. Under sustained QM
throughput (Phase F.2 batch jobs) this serialises projector work and
under-utilises the connection.

`kg_hypotheses` shows the right pattern: `from neo4j import AsyncGraphDatabase`
(line 16), `await session.run(...)` throughout. Replace the sync driver
with the async one, OR wrap `_merge_into_neo4j` in
`await asyncio.to_thread(self._merge_into_neo4j, row, conformers)`.

### F.4 (HIGH) `qm_kg` exits the listen loop on transient Neo4j errors

`qm_kg/main.py:152-153`:

```py
if job_id:
    await self._project_job(work_conn, job_id)
```

No try/except. `_project_job` raises on transient Neo4j errors (line 218,
`raise`). The `RuntimeError` propagates out of `_listen_loop_qm`,
out of `_connect_and_run`, into `run()`'s outer reconnect loop. That loop
catches **`psycopg.OperationalError | OSError`** only (`base.py:130`) —
RuntimeError falls through to the `except Exception: raise` branch
(line 143-145) and the process exits. Container restarts via
`restart: unless-stopped`, but every Neo4j blip costs a clean restart and
all in-flight events.

Catch-up has the same exposure (`_catch_up_qm:118-121`).

### F.5 (MEDIUM) `kg_hypotheses` ack key inconsistency

```
$ grep "name = " services/projectors/*/main.py
compound_fingerprinter:48: name = "compound_fingerprinter"
…
kg_hypotheses:30: name = "kg-hypotheses"   # ONLY hyphen
…
```

CLAUDE.md says
`DELETE FROM projection_acks WHERE projector_name='<name>'`. An operator
following the snake_case convention (every other projector) and running
`projector_name='kg_hypotheses'` will DELETE zero rows and silently fail.

### F.6 (MEDIUM) `kg_hypotheses` and `kg_source_cache` violate the centralised-logging contract

`kg_hypotheses/main.py:167`: `logging.basicConfig(level=settings.projector_log_level)`
— produces unformatted text logs.

`kg_source_cache/main.py:163-166`: top-level `if __name__ == "__main__":`
calls `Settings()` and `projector.run()` with no logging configuration at
all — root logger fires through Python's default WARNING handler.

CLAUDE.md "Logging" section: "Both layers structure-log; never concatenate
user input into the message format string"; the canonical helper is
`services.mcp_tools.common.logging.configure_logging`. Compare to
`compound_classifier/main.py:213` which is correct:
`configure_logging(settings.projector_log_level, service="compound_classifier")`.

### F.7 (MEDIUM) `hypothesis_status_changed` is an orphan subscription

```
$ grep -rn "hypothesis_status_changed" services/ db/
services/projectors/kg_hypotheses/main.py:31, 56  # subscriber + dispatch
# nothing else
```

There is no DB trigger on `hypotheses.status` and no agent-claw builtin
that emits this event. The `_handle_status_changed` branch
(`kg_hypotheses/main.py:132-162`) is dead today.

If the intent is to project status changes, the right fix is a DB
AFTER-UPDATE trigger on `hypotheses` that inserts an `ingestion_events`
row when `OLD.status IS DISTINCT FROM NEW.status` — the `notify_ingestion_event`
trigger (`db/init/01_schema.sql:202-214`) handles fan-out automatically.

### F.8 (MEDIUM) `qm_kg` synthetic-event channel pollution

`qm_kg._ack` (`main.py:237-254`) writes:

```sql
INSERT INTO ingestion_events (id, event_type, source_table, source_row_id, payload)
VALUES (%s::uuid, 'qm_job_succeeded', 'qm_jobs', %s::uuid, '{}'::jsonb)
ON CONFLICT (id) DO NOTHING
```

This collides `ingestion_events.id` with `qm_jobs.id`. UUIDv4 collision
probability is negligible, but the structural smell is that one ID space
is being repurposed. The `notify_ingestion_event` trigger
(`db/init/01_schema.sql:202-214`) fires, broadcasting on the main
`ingestion_events` channel. Every base-projector then does:

1. catches the NOTIFY in `_handle_notify` (`base.py:246-279`)
2. SELECTs the event, finds `event_type='qm_job_succeeded'` not in
   `interested_event_types`
3. silent-skip (`base.py:307-312`) and writes an ack
   (`base.py:347-356`)

Six projectors × every QM job = 6 spurious ack rows per QM success. Not
a correctness issue but does pollute `projection_acks` and causes catch-up
SQL (`base.py:175-191`) to scan more rows than necessary on cold start.

### F.9 (MEDIUM) `request_id` correlation feature is dead

`base.py:294-302` builds a `LoggerAdapter` with `request_id` from
`payload.get("request_id")`. Every writer:

- `services/ingestion/doc_ingester/importer.py:144-151` — payload is
  `{"sha256", "chunk_count", "source_type"}` only
- `services/agent-claw/src/tools/builtins/propose_hypothesis.ts:104-107` —
  payload is `{"hypothesis_id"}` only
- `services/agent-claw/src/core/hooks/source-cache.ts:368-380` — payload
  is the typed `SourceFactPayload` only

`payload.get("request_id")` is always None, so the LoggerAdapter falls
back to event_id. Either thread `request_id` through the writers
(`request.state.request_id` is on every FastAPI / Express request already)
or delete the scaffolding. This was added with intent — the comment block
at `base.py:289-296` is explicit — but is currently load-bearing of
nothing.

### F.10 (MEDIUM) Six projectors open fresh DB connections per event

| Projector | File:line | Pattern |
|---|---|---|
| reaction_vectorizer | main.py:67 | new `AsyncConnection` per `handle()` call |
| conditions_normalizer | main.py:91 | `_open_work_conn` is called per `handle` |
| chunk_embedder | main.py:65 | new connection per event |
| contextual_chunker | main.py:81 | new connection per event |
| kg_experiments | main.py:117 | `_load_experiment_bundle` opens its own conn |
| kg_hypotheses | main.py:61, 136 | `_load_hypothesis` and `_handle_status_changed` each open their own |

`BaseProjector` already supplies a `work_conn` to `handle()` via
`_process_row` (visible because `_handle_notify` and `_catch_up` both call
`await self._process_row(work_conn, row)`). The contract was for the
handler to use that connection. Six projectors ignore the contract and
open a new one. At department scale this is fine; at Phase F.2 scale
(catch-up backlog of thousands of events on a fresh image) it sinks the
connection pool.

The base class signature does not actually expose `work_conn` to
`handle()` — `_process_row` does not pass it through (see the abstract
`handle` in `base.py:94-103`). This may explain the pattern. The fix is
either to thread `work_conn` into `handle` (signature change) or to give
each projector a long-lived `httpx.AsyncClient` plus a single shared
`AsyncConnection` opened in `__init__`-style at `_connect_and_run` and
released at shutdown.

### F.11 (LOW) Dead imports

- `services/projectors/compound_classifier/main.py:29` —
  `from services.projectors.common.base import (BaseProjector,
  PermanentHandlerError, ProjectorSettings,)`. `PermanentHandlerError`
  is never raised in this file.
- `services/projectors/kg_source_cache/main.py:23-24` —
  `import psycopg` and `from psycopg.rows import dict_row` are never
  referenced (the projector only uses the inherited base machinery).

### F.12 (LOW) `compound_fingerprinter` re-fingerprints on duplicate NOTIFYs

`_fingerprint` (`main.py:159-241`) does NOT gate at handle-time on
`fp_version = _FP_VERSION`. A burst of `compound_changed` NOTIFYs for the
same inchikey re-issues all five RDKit POSTs and re-walks the SMARTS
catalog. The DB writes are idempotent (UPDATE replaces, ON CONFLICT
upserts) so the final state is correct, but the work is wasted.

Add at the top of `_fingerprint`:

```py
async with work_conn.cursor() as cur:
    await cur.execute(
        "SELECT fp_version FROM compounds WHERE inchikey = %s", (inchikey,))
    row = await cur.fetchone()
if row and row["fp_version"] == _FP_VERSION:
    return  # already fingerprinted at this version
```

### F.13 (LOW) Multi-replica safety not enforced

`base.py:347-356` writes `INSERT INTO projection_acks ... ON CONFLICT DO
NOTHING`. If two replicas of `reaction_vectorizer` run, both will
catch the same NOTIFY, both will SELECT the event (`_handle_notify`'s
filter `NOT EXISTS … projection_acks` is racy), both will run `handle()`,
and the second `INSERT` will collide. The handler is idempotent so this
is "correct" — but every event is processed twice and external side
effects (HTTP POSTs to mcp-drfp / mcp-rdkit / Neo4j writes) are
duplicated.

Production should pin `replicas: 1` per projector container, but neither
`docker-compose.yml` nor `infra/helm/` documents this expectation.
A defensive `pg_try_advisory_lock(hashtext('projector:'||name))` at
`_connect_and_run` start would block the second replica, but is
intrusive.

### F.14 (LOW) `eln_json_importer.legacy` directory is not excluded from coverage / typecheck

`Makefile:226` excludes the path from at least one tooling pass via
`--exclude='services/ingestion/eln_json_importer.legacy/**'`, but the
directory is still scanned by `pytest`'s default discovery (no
`pytest.ini` ignore for the `.legacy` suffix). The schemas.py and
importer.py would surface as collection errors if any test ever runs
there. Today they don't, but the import-broken state is a tripwire.

### F.15 (INFO) `qm_kg.handle()` is a no-op pragma

`qm_kg/main.py:162-171` declares `async def handle(...) -> None: return None`
as a `pragma: no cover` because the projector overrides `_connect_and_run`
to drive everything off the `qm_job_succeeded` channel. Same pattern in
`compound_classifier:119-122` and `compound_fingerprinter:140-143`. The
abstract requirement is satisfied, but the silent contract is "if you
override `_connect_and_run`, your `handle()` is dead." That's fine but
worth a docstring on `BaseProjector.handle` explicitly stating it.

## Cross-Reference: Prior Audit (`docs/review/2026-04-29-codebase-audit/00-summary.md`)

| Prior finding | Status today | Evidence |
|---|---|---|
| H5 (`document_chunks.byte_start`/`byte_end` read but never written) | **RESOLVED** | `services/ingestion/doc_ingester/importer.py:121-140` now passes `c.byte_start`/`c.byte_end` to executemany; `chunking.py:75-81` populates them per chunk |
| M7 (`kg_hypotheses._handle_status_changed` advances `valid_to` on every replay) | **RESOLVED** | `kg_hypotheses/main.py:151-156` now uses `valid_to = CASE WHEN h.valid_to IS NULL THEN datetime() ELSE h.valid_to END` |
| M16 (`services/projectors/common/base.py` at 26% coverage) | not re-measured here, but the base path is exercised by integration of every projector in the docker-compose smoke run; the new `_connect_and_run` reconnect loop (`base.py:123-145`) added since the prior audit is uncovered by unit tests |
| Generic statement "projector idempotency holds" | **CONFIRMED** for the 10 projectors in scope (UPSERT or `WHERE col IS NULL` guards everywhere); see Per-projector Scorecard |

New findings since the prior audit:
- F.1 (UUID cast bug in source-cache hook — affects `kg_source_cache`)
  was not flagged.
- F.2 (`experiment_imported` has no live emitter and the legacy importer
  is import-broken) was not flagged. The prior audit listed
  "eln_json_importer retired from the live path; preserved for one-shot
  bulk migrations" as a Phase F.2 status note, but did not verify the
  preserved package is actually importable.
- F.3 / F.4 (`qm_kg` sync driver + listen-loop crash) — `qm_kg` was
  added in QM Phases 1–9 between the prior audit and now.
- F.5 (`kg-hypotheses` hyphen ack key) — pre-existed but was not noticed.
