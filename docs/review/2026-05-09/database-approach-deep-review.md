# Database approach — deep review

Date: 2026-05-09. Branch: `claude/review-database-approach-4pp9P`.

Scope: `db/init/*.sql`, `db/seed/*.sql`, `db/migrations/`, `services/projectors/`, every Postgres consumer in `services/*`, the testcontainer fixture, the CI bootstrap path. Not in scope: Neo4j schema, pgvector tuning beyond what touches the canonical layer, Helm overrides.

Verdict at a glance: the design is coherent (event-sourced ingestion, FORCE-RLS on `chemclaw_app`, BYPASSRLS on `chemclaw_service`, bi-temporal evidence tables, projector replay via `projection_acks`), and the recent hardening waves closed most of the well-known holes. What remains is a mix of (a) **load-bearing but not-yet-tooled invariants** (lex-ordered idempotent SQL files standing in for a migration tool; only ~15 of 60 files self-record into `schema_version`), (b) **drift between policy and practice** (two optimizer services still default `POSTGRES_USER=chemclaw`; the testcontainer applies only 2 of 60 init files), and (c) **promised contracts without enforcement tests** (projector replay is documented as the recovery primitive but only one projector has a replay test).

There is no single critical bug. There are ~five places where a small change today would prevent a hard-to-recover incident later.

---

## 1. Migration tooling — load-bearing, not-tooled

`make db.init` (`Makefile:92-101`) globs `db/init/*.sql`, applies each file with `ON_ERROR_STOP=1`, then `INSERT INTO schema_version (filename) ON CONFLICT DO NOTHING`. There is no migration runner, no checksum, no down-migration, no dependency graph. Idempotency is hand-rolled per file via `IF NOT EXISTS` / `DROP … IF EXISTS` / DO-blocks. CI runs the suite **twice** in sequence to assert idempotency (`.github/workflows/ci.yml:223-232`); fresh-DB cold-start is only run by `scripts/smoke.sh`, which is **not wired into CI**.

Three concrete consequences:

1. **Same-prefix init files**: `02_*` (×2), `18_*` (×2), `19_*` (×4: `agent_todos_unique_ordering`, `config_settings`, `observability`, `reaction_optimization`), `20_*` (×2), `21_*` (×2), `22_*` (×2). Lex order is correct **today**. A future file landing as `19_aa_*.sql` would silently jump ahead of `19_agent_todos_unique_ordering.sql` — Postgres will not complain, the diff will not flag it, CI's idempotency loop will pass. The 22_ pair is the one with a real ordering dependency (`22_admin_rls_bootstrap_helpers.sql` defines `bootstrap_config_setting` and `22_feature_flags.sql` calls it; lex-order happens to be correct).
2. **`schema_version` provenance is incomplete**: only files 19_reaction_optimization, 21_optimization_campaigns, 23_qm_results, 24_compound_fingerprints, 25_compound_ontology, 26_genchem, 27_job_queue, 28_screens, 29_workflows, 32_rls_completeness, 39_compound_catalog_rls, 48_reactions_current_view, 49_mock_eln_fake_logs_rls, 50_redaction_patterns_notify, 51_synthesis_campaigns self-record. The Makefile loop fills the rest. Anyone applying a single file via `psql -f db/init/N_*.sql` skips the row — and that is the hot path during incident response. `CLAUDE.md` says `SELECT * FROM schema_version` is the canonical applied-migrations list; in practice it is not. Already in `BACKLOG.md:58, 123`.
3. **`db/migrations/202604230001_research_reports.sql`** is byte-identical-ish to `db/init/02_research_reports.sql` and is **not** executed by `make db.init`. Two sources of truth, no enforcement that they stay in sync. Pure footgun. Either delete the migrations file or commit to a real migration tool and delete the init suite.

**Recommendations** (small → large):

- Delete `db/migrations/202604230001_research_reports.sql` or rebrand `db/migrations/` as a one-shot maintenance-script directory and document that.
- Add `scripts/smoke.sh` to a CI job (cold-start postgres → `make db.init` → assert non-zero `schema_version` row count). This is what would have caught the three bootstrap bugs cited in `BACKLOG.md:49`.
- Consolidate same-prefix files by renaming or by introducing an explicit ordering manifest. A `db/init/MANIFEST` plain-text file the Makefile reads is enough; lex order on filenames is not a stable contract.
- Plan the move to a real migration tool (Alembic / sqitch / dbmate). The current setup will get more painful as the number of files grows. `BACKLOG.md:33, 49` already track this.

---

## 2. Connection-role drift — two services bypass RLS by default

The role posture is well-designed and well-documented (`db/init/12_security_hardening.sql`, `CLAUDE.md` "Row-Level Security"): app traffic uses `chemclaw_app` (NOBYPASSRLS, FORCE RLS applies); workers use `chemclaw_service` (BYPASSRLS); migrations use `chemclaw` (owner, superuser-by-entrypoint).

`services/projectors/common/base.py:65-261` enforces this for projectors: `postgres_user` defaults to `chemclaw_service` and `_assert_bypass_rls` refuses to start if the connected role lacks `rolbypassrls`. Other workers follow the same pattern (`session_purger/main.py:53`, `session_reanimator/main.py:55`, `audit_partition_maintainer/main.py:38`, `queue/worker.py:45`, `workflow_engine/main.py:53`, `gepa_runner/runner.py:102`).

**Two services are out of step:**

- `services/optimizer/skill_promoter/promoter.py:273` and `services/optimizer/skill_promoter/runner.py:32` build their DSN with `f"user={os.environ.get('POSTGRES_USER', 'chemclaw')}"`.
- `services/optimizer/forged_tool_validator/runner.py:37` does the same.

Default is `chemclaw` — the table-owner role, which is `POSTGRES_USER` in `docker-compose.yml` and therefore superuser-by-entrypoint, therefore implicit `BYPASSRLS`. If `POSTGRES_USER` is unset in the deployment, these services run with full cross-tenant access **and** without the `_assert_bypass_rls` guard's tripwire. Inconsistent with every other worker in the repo and not in `BACKLOG.md`. Trivial fix:

```python
postgres_user: str = "chemclaw_service"
```

…and adopt the projector base's `_assert_bypass_rls` shape.

**Lower-priority drift in the same area:**

- `services/agent-claw/src/db/with-user-context.ts:33-106` is the right primitive, but `withSystemContext` (line 130-135) sets `app.current_user_entra_id = '__system__'` and **no CHECK constraint anywhere prevents a user_entra_id column from literally containing `'__system__'`**. The owner-equality policies (`feedback_events`, `corrections`, `notifications`, `artifacts`, `paperclip_state`) would silently match such a row. Already in `BACKLOG.md:87`. Cost to fix is one DO-block emitting per-table `CHECK (col <> '__system__')`.

---

## 3. Testcontainer coverage — narrow, claims to be representative

`services/agent-claw/tests/helpers/postgres-container.ts:128-145` applies exactly two init files: `13_agent_sessions.sql` and `14_agent_session_extensions.sql`. The fixture does correctly create both `chemclaw_app` and `chemclaw_service` roles (lines 113-126) and exposes a real `chemclaw_app` pool (lines 153-164), so tests that touch agent_sessions / agent_todos / agent_plans **do** exercise FORCE RLS.

But the rest of the schema is invisible to integration tests. Any test asserting "RLS protects table X" for X ∉ {agent_sessions, agent_todos, agent_plans} is asserting against a non-existent table or a different table created by an inline test setup. The integration suite cannot, in its current form, exercise:

- The cross-tenant `reactions_project_policy` join (`12_security_hardening.sql:176-201`).
- The `task_queue_insert_self` RESTRICTIVE policy (`46_task_queue_tenant_scope.sql:54-62`).
- The `mock_eln`/`fake_logs` known-roles policy (`49_mock_eln_fake_logs_rls.sql:27-66`).
- The `42_session_policy_empty_user_guard.sql` empty-user guards (only on session tables, but a regression elsewhere is not catchable here).

Several tests in `BACKLOG.md` line 111 onward are explicitly waiting on this — *Concurrent withUserContext: two parallel calls against the same RLS-protected table assert each user sees only their own rows. The single primitive standing between multi-tenant agent and cross-user data leakage.*

**Recommendation**: extend the `filesToApply` allowlist in `postgres-container.ts:130-133` to the full set of files the test wants to use. Better: derive it from the test's declared dependencies. Best: stop maintaining a parallel allowlist and apply the entire suite (only viable once `01_schema.sql` no longer trips on missing pgvector — currently it does, per the comment at line 137-145 of postgres-container.ts).

---

## 4. Projector replay — the contract is not tested

`CLAUDE.md` says: "Full KG / vector rebuild = `DELETE FROM projection_acks WHERE projector_name=X` and the projector re-derives from the event log." The replay primitive is the recovery story for the entire derived layer.

`services/projectors/common/base.py` makes it work: catch-up loops (`_catch_up`, lines 268-296) drain in 1000-row batches; ack inserts use `ON CONFLICT DO NOTHING`; transient handler errors short-circuit the ack so the row replays on next NOTIFY (lines 420-474). The handlers themselves are idempotent: Neo4j `MERGE` on deterministic UUIDv5 fact_ids (kg_documents, kg_experiments, kg_hypotheses, kg_source_cache), Postgres-side `WHERE col IS NULL` guards (chunk_embedder, reaction_vectorizer, contextual_chunker), or `ON CONFLICT DO NOTHING` (compound_classifier, qm_kg).

**One projector has an explicit replay test**: `tests/integration/test_kg_hypotheses_projector.py::test_replay_is_idempotent` (lines 92-133). It inserts a row, catches up, deletes the ack, catches up again, asserts a single Neo4j node. That is the right shape — and it is the only one. `chunk_embedder`, `contextual_chunker`, `kg_documents`, `kg_source_cache`, `qm_kg`, `compound_classifier`, `compound_fingerprinter`, `reaction_vectorizer`, `conditions_normalizer` have no replay-idempotency assertion. `BACKLOG.md:112` flags this; nothing has happened.

**Custom NOTIFY channels** (`DR-06`) compound the gap. `compound_fingerprinter` LISTENs on `compound_changed` (payload = inchikey, not event_id) and emits `compound_fingerprinted`; `compound_classifier` LISTENs on the latter. The base class's catch-up logic does not apply — both override `_connect_and_run` and set `interested_event_types = ()`. The docstring contract is documented (`compound_fingerprinter/main.py:1-58`, `compound_classifier/main.py:1-58`), but **no test asserts the cross-projector handoff or the payload schema**. A future change to the `compound_changed` payload format breaks the chain silently.

**Recommendation**: add a parametrized replay test in `tests/integration/` that, for each projector, performs the delete-acks → restart → byte-equality check the runbook promises. The compound chain needs a dedicated test that emits a `compound_changed` notify and asserts both downstream Neo4j writes appear.

---

## 5. Bi-temporal layer — three loose ends

`db/init/17_unified_confidence_and_temporal.sql` adds `valid_from`/`valid_to`/`invalidated` (or `refuted_at`/`superseded_at`) plus `confidence_score`/`confidence_tier` to `reactions`, `hypotheses`, `artifacts`. `db/init/33_bitemporal_current_indexes.sql` adds the matching partial indexes. `db/init/48_reactions_current_view.sql` exposes `reactions_current` and migrates 8 callers off the raw `reactions` table.

What is missing or quietly inconsistent:

1. **No `hypotheses_current` / `artifacts_current` view**. Single-row mutations (e.g. `update_hypothesis_status.ts`, `kg_hypotheses/main.py`'s `SELECT status FROM hypotheses WHERE id = $1`) deliberately don't filter on `refuted_at`, which is correct semantically. But there is no equivalent view to gate aggregation/list reads. New callers can copy the wrong pattern. The bi-temporal audit confirmed callers today are filtering correctly (`compute_confidence_ensemble.ts`, `routes/artifacts.ts`); a view would make it the path of least resistance.
2. **`audit_row_change` is not attached to `reactions` / `hypotheses` / `artifacts`** (`19_observability.sql:381-390` lists the 8 attachments; `BACKLOG.md:160`). The intent is "bi-temporal columns are the audit trail for evidence tables; row-level audit is for non-temporal user-state tables". That intent is real but **undocumented at the trigger source**. A future maintainer attaches the trigger thinking they are closing a gap, gets duplicate change records, has to back it out. Add a comment block in `19_observability.sql` line 275 or alongside the `audit_row_change` definition explaining the carve-out.
3. **`fact_invalidated` is emitted but un-consumed**. `db/init/36_fact_invalidated_emitter.sql` registers the event_type with `consumers = ARRAY[]::TEXT[]`. `services/projectors/kg_hypotheses/main.py` emits it; nothing reads it. This is fine **for now**, but the catalog row is the ground truth for "who consumes what" and an empty consumer list is easy to read as "this is stale". Either wire a consumer (the planned vector-cache evictor; `BACKLOG.md:44`) or change the catalog row to flag explicitly that emitter-without-consumer is intentional.
4. **`qm_job_succeeded` dual-write is still active** (`db/init/37_qm_ingestion_events.sql:36-44`). Writes both the legacy `pg_notify('qm_job_succeeded', …)` and the new `INSERT INTO ingestion_events`. `BACKLOG.md:40` says "after one release, remove the legacy NOTIFY." That cleanup is overdue and the `qm_kg` projector still has the `INSERT … ON CONFLICT DO NOTHING` defensive fallback. Date the cleanup; tracking a "remove after release" without a release identifier is not a plan.

---

## 6. Event-log surface — three small things

`ingestion_events` and `projection_acks` are FORCE'd with admin-only SELECT (`db/init/41_event_log_rls.sql`) — correct. The trigger `notify_ingestion_event` (`db/init/01_schema.sql:214-225`) emits `pg_notify('ingestion_events', json_build_object('id', NEW.id, 'event_type', NEW.event_type)::text)` on AFTER INSERT.

1. **`pg_notify` payload is uncapped at the trigger level**. The current payload is `id` + `event_type`, fits trivially under the 8000-byte default limit. The next emitter who decides to include a small piece of context in the NOTIFY payload (and there have been requests for this — `compound_fingerprinted` carries the inchikey precisely to avoid a follow-up SELECT) can blow the cap. Add an explicit length check in the trigger or document the cap in a comment at `01_schema.sql:217`.
2. **`event_type_vocabulary`** (`db/init/35_event_type_vocabulary.sql`) lists registered event types with their consumers. The catalog and the projectors are aligned today, but there is no CI guard that asserts "every projector's `interested_event_types` is in the catalog and every catalog entry has at least one declared consumer (or an explicit `intentional_orphan` flag)". A drift test would close the contract.
3. **`mock_eln`/`fake_logs` policy uses `current_user IN (...)`** (`db/init/49_mock_eln_fake_logs_rls.sql:58-63`) — Postgres role check, not the `app.current_user_entra_id` GUC. This is intentional (these schemas are role-gated test fixtures) but **inconsistent with every other table's policy shape**. A reader who assumes "all RLS is GUC-driven" gets surprised. Add a one-line comment in 49 explaining why this one is different.

---

## 7. Indexes & performance — known and lived-with

- **DRFP vector index dropped at the canonical layer** (`db/init/01_schema.sql:132-150`). pgvector 0.8 caps both `ivfflat` and `hnsw` at 2000 dims; DRFP is 2048-bit. The agent never queries `reactions.drfp_vector` directly; cosine search goes through the `reaction_vectorizer` projector's halfvec(2048) collection. This is correct **today** and correctly documented. There is no test or lint that prevents an agent builtin from hitting `reactions.drfp_vector` directly and getting a sequential scan — `BACKLOG.md:48` tracks the structural fix (halfvec or pgvector ≥ 0.9). A simple guard: comment-tag the column with a sentinel and add a test that greps for `drfp_vector` outside the projector + scripts.
- **`audit_log` retention** (`db/init/19_observability.sql:212-269`) is monthly partitioned and the `audit_partition_maintainer` daemon adds new partitions. Nothing drops old ones. `BACKLOG.md:52` already flags this; expect bloat in 12-18 months.
- **`ingestion_events.payload jsonb_path_ops`** GIN index (`16_db_audit_fixes.sql:213-214`) is correct and matches projector containment queries.
- **`feedback_events`/`corrections`/`notifications`** RLS policies (`12_security_hardening.sql:206-228`) lack the `IS NOT NULL AND <> ''` guard the session-scoped tables got in `42_session_policy_empty_user_guard.sql`. Currently safe because `user_entra_id` is `NOT NULL` in the schema and FORCE RLS catches the no-GUC path, but the guard would make the policy self-documenting and consistent.

---

## 8. What I'd actually do, in order

Smallest cost, largest payoff first.

1. **Fix the optimizer connection-role drift**: change `skill_promoter/{promoter,runner}.py` and `forged_tool_validator/runner.py` defaults from `chemclaw` to `chemclaw_service`, mirror the `_assert_bypass_rls` check from `services/projectors/common/base.py:218-261`. <30 LOC, prevents a footgun.
2. **Add the `'__system__'` CHECK constraints** (`BACKLOG.md:87`) on `feedback_events.user_entra_id`, `corrections.user_entra_id`, `notifications.user_entra_id`, `artifacts.owner_entra_id`, `paperclip_state.user_entra_id`. One DO-block migration.
3. **Wire `scripts/smoke.sh` into CI** as a fresh-DB test. Catches bootstrap regressions at PR time instead of on the next release.
4. **Delete `db/migrations/202604230001_research_reports.sql`** or document explicitly why it exists. Two-source-of-truth is worse than either.
5. **Document the audit-trigger carve-out** at `db/init/19_observability.sql:275` and the `pg_notify` payload-size implicit cap at `db/init/01_schema.sql:217`. Five lines of comment each. Saves the next maintainer a half-day.
6. **Backfill the `INSERT INTO schema_version` in every init file** that lacks one (~45 files), or change the Makefile loop to be the canonical authority and remove the per-file inserts. Pick one. `BACKLOG.md:58, 123`.
7. **Add a parametrized projector replay test** under `tests/integration/`, parametrized over every projector. The kg_hypotheses test (`test_replay_is_idempotent`) is the template. Closes the recovery contract.
8. **Land the `qm_job_succeeded` legacy-channel cleanup** (`BACKLOG.md:40`). Drop the legacy `pg_notify` from the trigger, drop the `qm_kg` defensive fallback, document the assumption that the canonical `ingestion_events` row is now the only path.
9. **Bigger lift, plan it now**: pick a migration tool (Alembic is the path of least resistance given the Python services already vendoring SQLAlchemy is not the case here — sqitch or dbmate may be lighter). Convert `db/init/*.sql` once, freeze the suite, switch CI's idempotency loop to a real migration history check.

---

## What's working well

The list of things to keep doing rather than change:

- The **A-on-C event-sourcing pattern** is clean and the projector base class is genuinely re-usable. The one-shot `_assert_bypass_rls` startup check and the catch-up-then-listen ordering are both correct.
- The **role / RLS layering** is right: app on `chemclaw_app` with FORCE RLS, workers on `chemclaw_service` with BYPASSRLS, migrations on `chemclaw`, and the `withUserContext` helper is the only blessed entry point. The recent `client.release(err)` fix in `services/agent-claw/src/db/with-user-context.ts:104` is the kind of detail that distinguishes a serious posture from a security-theater one.
- The **dual hardcoded-baseline + DB-table pattern** for redaction patterns (`services/litellm_redactor/redaction.py` + `redaction_patterns` table + `is_pattern_safe()` rejecting unbounded quantifiers) is the right separation of safety vs. tenancy.
- The **bi-temporal-current view + partial indexes** for `reactions` is the right shape. Apply it more (hypotheses, artifacts) rather than less.
- The CI **idempotency loop** catches a real class of bug. Keep it; add cold-start to it.
- The **runbook coverage** is unusually good (`docs/runbooks/`) — the audit gaps are not from lack of operator awareness.

The sum of unfinished work here is small relative to a typical backlog of this size. The biggest structural risk is the migration tool itself; everything else is in the "afternoon's work" range.

---

## Implementation status (2026-05-09 follow-up commits)

The above review's punch list was implemented in this branch. Commits, in order:

1. **`fix(optimizer): close connection-role drift on three workers`** — `services/optimizer/common/db.py` with `get_dsn()` defaulting to `chemclaw_service` + `assert_bypass_rls()` mirroring the projector base. `skill_promoter/{promoter,runner}.py` and `forged_tool_validator/runner.py` rewired through it. 18 unit tests covering the env-var matrix and the BYPASSRLS check states.
2. **`feat(db): add hypotheses_current and artifacts_current bi-temporal views`** — `db/init/52_bitemporal_current_views.sql` with `security_invoker = true`, mirroring `reactions_current`.
3. **`feat(db): reject '__system__' sentinel in real owner-identity columns`** — `db/init/53_system_sentinel_checks.sql` adds CHECK constraints on `agent_sessions`, `feedback_events`, `corrections`, `notifications`, `paperclip_state`, `research_reports`, `user_project_access`, `hypotheses.proposed_by_user_entra_id`, `artifacts.owner_entra_id`. System-mutable bookkeeping columns left unconstrained.
4. **`fix(qm_kg): retire qm_job_succeeded legacy NOTIFY channel`** — `db/init/54_qm_legacy_notify_cleanup.sql` backfills `ingestion_events` for legacy succeeded `qm_jobs`, replaces the trigger with a single-write canonical version. `services/projectors/qm_kg/main.py` drops the custom `_connect_and_run` / `_catch_up_qm` / `_listen_loop_qm` overrides and the defensive `_ack` INSERT — now follows the standard BaseProjector path. Deletes the orphan `db/migrations/202604230001_research_reports.sql`.
5. **`feat(db): pg_notify oversize guard + empty-user guards on owner policies`** — `db/init/55_ingestion_event_notify_hardening.sql` octet-length-guards the trigger payload (forwards `NOTIFY_PAYLOAD_OVERSIZE` to `record_error_event` + falls back to id-only NOTIFY) and replaces the bare owner-equality on `feedback_events`/`corrections`/`notifications` with the IS NOT NULL / <> '' guarded form. `19_observability.sql` gains a comment block at `audit_row_change` documenting the bi-temporal-evidence carve-out.
6. **`feat(db,ci): backfill schema_version self-record + cold-start lints`** — every `db/init/*.sql` now self-records into `schema_version`. `scripts/check_init_self_record.sh` enforces it. `scripts/check_event_vocabulary.sh` asserts every projector's `interested_event_types` is in `ingestion_event_catalog`. CI schema job runs both lints and asserts post-apply `schema_version` row count ≥ file count.
7. **`test(projectors): replay-idempotency contract for BaseProjector + matrix`** — `tests/unit/projectors/test_base_replay_contract.py` pins the universal replay contract via mocked work_conn (six tests: first-pass, replay-after-delete, concurrent-double-pass, transient-no-ack, permanent-acks, uninterested-event-still-acks). `tests/integration/test_projector_replay_idempotency.py` is the parametrized scaffold gated on `PG_DSN`+`NEO4J_URI`.

Deferred (now in `BACKLOG.md`):

- Wiring the full `scripts/smoke.sh` into CI requires docker-compose + 10+ services and is operationally too expensive. The cold-start invariants (`schema_version` row count + lints) cover the regression mode that prompted the recommendation.
- Real migration tool (Alembic / sqitch / dbmate). The schema_version backfill + lints close the immediate gap; the underlying lex-ordered idempotent-SQL pattern is still load-bearing without a real history check or down-migration story.
- Extending the projector replay matrix (`PROJECTOR_CASES`) to cover chunk_embedder / contextual_chunker / reaction_vectorizer / kg_documents / kg_experiments / kg_source_cache / qm_kg as their fixtures stabilise.
