# A09 — Workflow + Queue End-to-End Trace

Scope: `services/agent-claw/src/tools/builtins/workflow_*.ts`,
`promote_workflow_to_tool.ts`, `enqueue_batch.ts`, `inspect_batch.ts`,
`run_chemspace_screen.ts`, `services/agent-claw/src/db/queue.ts`,
`services/agent-claw/src/core/workflows/{client,types,validator}.ts`,
`services/workflow_engine/main.py`, `services/queue/worker.py`.

PR #87 prerequisite items (psycopg `$N`→`%s`, `FOR UPDATE OF r SKIP LOCKED`
on the run sweep, `NotImplementedError` for unimplemented step kinds,
queue worker exponential backoff, `task_queue.retry_after` column +
index) were re-verified against current main HEAD and not re-flagged.

## Workflow define → run → engine evaluation path

| Step | File | Status |
| --- | --- | --- |
| `workflow_define` Zod parse + cap (256 KB) | `tools/builtins/workflow_define.ts` | OK |
| `validateWorkflowDefinition` (schema + duplicate-id walk) | `core/workflows/validator.ts` | OK |
| `defineWorkflow` (version bump + bi-temporal close) | `core/workflows/client.ts` | OK |
| `workflow_run` → `startRun` (`status='running'`, scope='{}', cursor='{}') | `core/workflows/client.ts` | OK |
| Engine LISTEN `workflow_event` + 30 s poll fallback | `workflow_engine/main.py` | OK |
| `_sweep` (`FOR UPDATE OF r SKIP LOCKED`, LIMIT 100) | `workflow_engine/main.py:118` | OK |
| `_advance_run` (commit per step) | `workflow_engine/main.py:158` | OK |
| `_finish` (status + outputs UPDATE + finish event) | `workflow_engine/main.py:329` | **fixed** — emits `ingestion_events.workflow_run_succeeded` |

## Per-step-kind engine status

| Kind | Engine | Define-time | Run-time |
| --- | --- | --- | --- |
| `tool_call` | `_exec_tool_call` (httpx + JWT) | accepted | executes |
| `wait` (`for.batch_id`) | `_exec_wait` (poll `task_batches`) | accepted | executes |
| `conditional` | none | **accepted** (Zod) | `NotImplementedError` |
| `loop` | none | **accepted** (Zod) | `NotImplementedError` |
| `parallel` | none | **accepted** (Zod) | `NotImplementedError` |
| `sub_agent` | none | **accepted** (Zod) | `NotImplementedError` |

The accept-at-define / reject-at-run gap is intentional and now documented
in both `types.ts` and `validator.ts`. Tightening Zod would invalidate
already-persisted workflow definitions and break existing validator tests
that explicitly assert acceptance of `conditional` / `loop` / `parallel`
(see `tests/unit/workflows/validator.test.ts`). Engine-side
`NotImplementedError` already surfaces the gap with a precise message
("add an `_exec_<kind>` handler before defining workflows that use it").

## Queue worker invariants verified

- `_lease_one` (`services/queue/worker.py:216`): `FOR UPDATE SKIP LOCKED`
  in the CTE; clause `(retry_after IS NULL OR retry_after <= NOW())`
  honoured.
- Expired-lease reclaim (`worker.py:189`): `UPDATE … WHERE status='leased'
  AND lease_expires_at < NOW()` runs at every sweep, before per-kind
  dispatch.
- Idempotency: `enqueueRows` uses `ON CONFLICT (task_kind, idempotency_key)
  DO NOTHING` — the schema-side partial UNIQUE INDEX
  `uq_task_queue_idempotency` (db/init/27_job_queue.sql:31) is the source
  of truth.
- `_maybe_retry` (`worker.py:298`): exponential backoff `30 * 2^(attempts-1)`
  capped at 3600 s, written into `retry_after`. `attempts` was already
  incremented by `_lease_one`, so each retry strictly follows the prior.
- Connection-per-finalise pattern (`_succeed`/`_fail`/`_maybe_retry` open
  a fresh `psycopg.AsyncConnection` for every terminal write): a known
  gap, kept out of scope here — it parallels the `_exec_wait` issue but
  the per-task work is short and the connect overhead is dwarfed by the
  MCP HTTP round-trip. Already covered by general worker scope in
  BACKLOG.

## Fixes applied (engine)

1. **`workflow_run_succeeded` ingestion event emit**
   `_finish` now executes `INSERT INTO ingestion_events (event_type,
   source_table, source_row_id, payload) VALUES
   ('workflow_run_succeeded', 'workflow_runs', run_id, {run_id, outputs})`
   on the same `work_conn` cursor as the `workflow_runs` UPDATE, so the
   row commits atomically with the run finalisation. Failed runs
   intentionally do not emit (they already surface via
   `workflow_events.kind='step_failed'/'finish'` and we don't want to
   trigger downstream KG materialisation off failures). The
   `notify_ingestion_event` trigger in `db/init/01_schema.sql:214` will
   broadcast on commit so projectors pick it up.
2. **`_exec_wait` connection reuse**
   Added a dedicated lazy `_poll_conn` (`autocommit=True`,
   `dict_row`) on the engine. Used only for `_exec_wait`'s 5-second
   polling loop, distinct from `work_conn` so a long-running wait
   (timeouts up to 1 h) does not pin an open transaction against the
   run-state cursor. Closed in the `run()` `finally` block. Fewer than
   one connect per run instead of `timeout/5` per run.
3. **`_resolve_jmespath` → `_resolve_dotted_path` rename**
   The implementation has always been a hand-rolled dotted-path walker;
   the JMESPath name was misleading. Renamed both definitions and call
   sites; behaviour is byte-identical (leading `scope.` skipped, missing
   keys yield `None`). Comment clarifies that adding the `jmespath`
   dependency remains BACKLOG'd.

## Fixes applied (agent-side)

4. **Runtime-rejection contract documented** in
   `services/agent-claw/src/core/workflows/types.ts` and
   `services/agent-claw/src/core/workflows/validator.ts`. Explains why
   Zod accepts `conditional`/`loop`/`parallel`/`sub_agent` while the
   engine raises `NotImplementedError`, and what to change if a future
   contributor adds an `_exec_<kind>` handler.

## Deferred to BACKLOG

- Adding the `jmespath` Python dependency to the workflow engine so the
  DSL field name matches behaviour (already on BACKLOG line 63).
- Tightening the agent-side Zod schema to reject `conditional`/`loop`/
  `parallel`/`sub_agent` at define time. Requires (a) updating
  `tests/unit/workflows/validator.test.ts` to assert rejection and (b)
  a migration plan for any persisted workflow definitions in
  `workflows.definition` that already use those kinds. Not done here
  because the audit task explicitly allowed the comment-only path and
  the engine-side `NotImplementedError` is already precise.
- `_succeed`/`_fail`/`_maybe_retry` open a fresh psycopg connection per
  finalise. The per-task body is short enough that this is not a hot
  path, but a long-lived per-worker write connection would be cleaner.
- Adding a `workflow_run_succeeded` row to `ingestion_event_catalog`
  (`db/init/35_event_type_vocabulary.sql`) so the catalog stays
  authoritative. Schema files are out of A09 scope (Tier 4 / A13).

## Verification

```
python3 -m py_compile services/workflow_engine/main.py services/queue/worker.py
npx tsc --noEmit -p services/agent-claw
```

Both clean.
