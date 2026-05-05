# 14 — Concurrency, idempotency, lease, race audit

Tier 4 / A14. Re-verified against current `main` HEAD; A09's queue/workflow_engine
work (PR #95, #87) untouched per scope.

## Per-component verdict

### `services/projectors/common/base.py` — ack pattern, replay safety

**Verdict: PASS.**

- `projection_acks` PK is `(event_id, projector_name)` (db/init/01_schema.sql:206-210).
- Ack INSERT (line 358-366) is `INSERT INTO projection_acks ... ON CONFLICT DO NOTHING`.
  Replay-safe: a duplicate NOTIFY for the same `event_id` is a no-op.
- Handler raises -> `should_ack=False` -> ack skipped -> event re-delivers on the
  next NOTIFY (or catch-up). Verified at lines 343-356.
- `PermanentHandlerError` is acked on purpose so malformed data doesn't loop.
- LISTEN-before-catch-up ordering closes the seam where a NOTIFY firing during
  catch-up would otherwise be lost (lines 162-178).

### Per-projector idempotency

| Projector | Verdict | Mechanism |
|---|---|---|
| `kg_experiments` | PASS | `_kg.write_fact` -> mcp-kg `MERGE` keyed on deterministic UUIDv5 `fact_id`. Re-projection is a no-op. |
| `kg_hypotheses` | PASS | MERGE on `fact_id`. `valid_to`/`refuted_at` use `CASE WHEN ... IS NULL` guard so replay does not advance the timestamp. |
| `kg_documents` | PASS | MERGE on deterministic `fact_id` for both Document and Chunk nodes plus the HAS_CHUNK edge. |
| `reaction_vectorizer` | PASS (mild) | SELECT filters `drfp_vector IS NULL`; the UPDATE itself does not re-assert the guard, so two concurrent invocations both write — same vector either way. Last-write-wins on a deterministic value; no correctness issue. |
| `chunk_embedder` | PASS (mild) | Same shape as reaction_vectorizer — deterministic embeddings, last-write-wins. |
| `conditions_normalizer` | PASS | UPDATE uses `COALESCE(col, %(col)s)` plus JSONB `||` merge on `extraction_status`; replay never overwrites a non-null column. |
| `qm_kg` | PASS | All MERGEs keyed on `fact_id` / `(method,task,job_id)`. Tranche 2/C7 added `CASE WHEN edge.valid_to IS NULL` so closure timestamps are frozen on replay. |
| `kg_source_cache` | PASS | MERGE on UUIDv5 `fact_id` derived from `(event_id, source_system, predicate, subject_id, object_value)`. |
| `contextual_chunker` | PASS | UPDATE has explicit `AND contextual_prefix IS NULL` guard at line 191 — confirmed against the audit spec. Empty string is the "processed" sentinel so retry-storms on bad data do not occur. |
| `compound_classifier` | **FIXED** | See below. |
| `compound_fingerprinter` | PASS | UPSERT on `compound_substructure_hits (inchikey, smarts_id)` via `ON CONFLICT ... DO UPDATE`; `compounds` UPDATE keyed by InChIKey is deterministic. |

### `compound_classifier` — race fix applied

**Race scenario (pre-fix):** Two replicas of the projector receive
`pg_notify('compound_fingerprinted', <inchikey>)` (or one replica processes
catch-up while another handles a live NOTIFY). Both run `_classify(inchikey)`.

The INSERT pattern at lines 200-212 is:

```sql
INSERT INTO compound_class_assignments (...)
SELECT %s, %s::uuid, %s, '{}'::jsonb, NOW(), NULL
WHERE NOT EXISTS (
  SELECT 1 FROM compound_class_assignments a
   WHERE a.inchikey = %s AND a.class_id = %s::uuid AND a.valid_to IS NULL
)
```

Under READ COMMITTED, the `WHERE NOT EXISTS` subquery does not lock against a
concurrent INSERT. The PRIMARY KEY of `compound_class_assignments` is
`(inchikey, class_id, valid_from)` (db/init/25_compound_ontology.sql:48), and
`valid_from` defaults to `NOW()` at microsecond resolution — two concurrent
inserts get distinct PKs and **both succeed**, leaving duplicate live rows
visible to readers filtering on `valid_to IS NULL`.

**Fix:** added a transaction-scoped advisory lock keyed on `hashtext(inchikey)`
at the top of `_classify`. classid=24 (per-projector namespace). The lock is
released on commit/rollback. This serializes per-inchikey classification across
replicas with one extra round-trip and zero schema migration. The architectural
fix (a partial unique index `(inchikey, class_id) WHERE valid_to IS NULL`) is
deferred to BACKLOG because it requires backfill-aware migration.

### `services/queue/worker.py` — lease + retry

**Verdict: PASS.** A09's PR #87/#95 fixes stand.

- `_lease_one` CTE wraps `SELECT ... FOR UPDATE SKIP LOCKED` then UPDATEs the
  same row in one statement — no TOCTOU between SELECT and UPDATE. (lines 217-244)
- `_sweep_all` reclaims expired leases before each dispatch round
  (`status='leased' AND lease_expires_at < NOW()`). (lines 188-197)
- `attempts = attempts + 1` is atomic inside the CTE UPDATE — no read-then-write
  TOCTOU. `_maybe_retry` reads the post-increment value via RETURNING and uses
  it as the backoff exponent only; it does NOT re-increment. (lines 298-323)
- The retry UPDATE doesn't filter by `leased_by`, so if a lease expired while a
  worker held it, two workers could double-execute. Same applies to `_succeed`
  / `_fail` clobbering each other. **Defer:** larger lease-fencing change;
  acceptable for QM/genchem idempotent tasks.

### `session_reanimator` — concurrent replicas

**Verdict: PASS.**

The reanimator (Python) doesn't increment `auto_resume_count` directly. It POSTs
`/api/internal/sessions/:id/resume` (or the legacy public route in dev) which
calls `tryIncrementAutoResumeCount` (services/agent-claw/src/core/session-store.ts:409-426).
That function is:

```sql
UPDATE agent_sessions
   SET auto_resume_count = auto_resume_count + 1
 WHERE id = $1::uuid
   AND auto_resume_count < auto_resume_cap
   AND (last_finish_reason IS NULL OR last_finish_reason <> 'awaiting_user_input')
RETURNING auto_resume_count
```

Atomic — Postgres holds the row-level lock for the duration of the UPDATE;
two concurrent replicas hitting the same session race in Postgres, and only
one wins. The loser sees `r.rows[0]` undefined and the route returns
`auto_resume_cap_reached`. **Verified.**

The reanimator's own `find_resumable` SELECT does not lock rows — two replicas
might both try to resume the same session, but the agent-side atomic UPDATE
serialises that to one increment. No double-increment surface.

### `services/agent-claw/src/db/qm-cache.ts` — lookup vs insert race

**Verdict: PASS, no fix needed.**

`lookupQmCache` is read-only (lines 124-175) and currently has no callers in
agent-claw. The canonical write path is Python:
`services/mcp_tools/common/qm_cache_db.py:record_qm_job` already uses
`INSERT INTO qm_jobs ... ON CONFLICT DO NOTHING` (line 225) and matching ON
CONFLICT clauses on `qm_results (job_id)` and `qm_conformers (job_id, ensemble_index)`.
The unique partial index `idx_qm_jobs_cache_key_live ... WHERE valid_to IS NULL`
(db/init/23_qm_results.sql:59-61) is the storage-layer guarantee.

The "two callers compute then both INSERT" scenario the audit hypothesised is
moot because:
1. Compute happens in the MCP service (xtb / crest), not in TS.
2. The MCP service writes once with `ON CONFLICT DO NOTHING`.
3. Two concurrent computes for the same cache_key are wasteful but
   correctness-safe — one INSERT wins the unique index, the other no-ops.

### `services/agent-claw/src/core/session-store.ts` — etag

**Verdict: PASS.**

- `saveSession` with `expectedEtag` set (lines 305-315) appends `AND etag = $N::uuid`
  to the WHERE clause. Mismatch -> `RETURNING` yields no row -> `OptimisticLockError`
  is thrown (line 314).
- The error propagates back to callers. In `chat.ts:487-489` it's caught and
  logged WARN; the route continues without persisting that turn. This is a
  conscious lossy-write trade-off: the alternative is a reload+retry loop that
  could spin under contention. The error is not silently swallowed — it lands
  in observability logs.
- Callers without `expectedEtag` opt out of the check intentionally
  (e.g., `tryIncrementAutoResumeCount` is its own atomic UPDATE that doesn't
  need an etag bump).

### `services/agent-claw/src/core/plan-store-db.ts` — contention

**Verdict: PASS.**

- All operations (`savePlanForSession`, `loadActivePlanForSession`, `advancePlan`)
  go through `withUserContext` which scopes a single `BEGIN/COMMIT` per call.
- No global locks; concurrent reads share row-level locks; concurrent writes to
  the same plan_id serialise on Postgres's row lock.
- `loadActivePlanForSession` uses `ORDER BY created_at DESC LIMIT 1` to pick the
  most recent active plan; if a route races with a `savePlanForSession`, the
  reader sees either the old plan or the new one — both are valid points-in-time.

## What was fixed

- `services/projectors/compound_classifier/main.py`: added
  `pg_advisory_xact_lock(24, hashtext(inchikey))` at the top of `_classify` to
  serialise per-inchikey classification across replicas. Prevents duplicate
  live rows in `compound_class_assignments` when two NOTIFYs (or NOTIFY +
  catch-up) hit the same compound concurrently.

## Deferred to BACKLOG

- `[projectors/compound_class_assignments]` add a partial unique index
  `(inchikey, class_id) WHERE valid_to IS NULL` so the storage layer enforces
  the no-duplicate-live invariant the advisory lock currently provides at
  application level. Requires a backfill-aware migration that closes existing
  duplicates before creating the index.
- `[queue/worker]` lease fencing: `_succeed`/`_fail`/`_maybe_retry` UPDATEs
  don't filter by `leased_by`, so a worker whose lease expired mid-execution
  can clobber the row a second worker is now processing. Tasks are idempotent
  on the MCP side, so the user-visible blast radius is small (an extra MCP
  call), but the result row may flip between the two completions.
