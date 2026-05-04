# Database Schema Integrity Audit — 2026-05-03

Auditor: Track 02 (DB schema integrity)
Scope: `db/init/00_schema_version.sql` … `db/init/31_fake_logs_schema.sql`,
`db/migrations/202604230001_research_reports.sql`, `db/seed/*.sql`,
projector wiring under `services/projectors/*/main.py`, agent writers under
`services/agent-claw/src/**` and `services/ingestion/*`.
Cross-reference: `docs/review/2026-04-29-codebase-audit/03-db-schema.md`.

The DB does not need to be running for static analysis — every finding below is
read-only against the SQL tree.

---

## Executive Summary

| Severity | # | Finding | File:line | Fix sketch |
| --- | --- | --- | --- | --- |
| P0 | 1 | `experiment_imported` events have NO live writer — all three projectors that depend on them (`reaction_vectorizer`, `conditions_normalizer`, `kg_experiments`) silently never run on real ingestion | `services/projectors/{reaction_vectorizer,conditions_normalizer,kg_experiments}/main.py:45/83/64` | Wire the live ELN paths (`mcp_eln_local`, `eln_json_importer` non-legacy) to emit `experiment_imported` per-experiment, OR rename to `eln_entry_observed` and have `kg_source_cache` synthesise downstream events. |
| P0 | 2 | Eight `qm_*` tables in `23_qm_results.sql` lack `ENABLE ROW LEVEL SECURITY` despite being documented as "global"; `chemclaw_app` has SELECT but no row-level gate. Other "global" catalogs (`model_cards`, `feature_flags`, `redaction_patterns`, `permission_policies`) have FORCE+authn-policy as the convention | `db/init/23_qm_results.sql:194-207` | Add `ALTER TABLE qm_* ENABLE/FORCE ROW LEVEL SECURITY` + an authenticated SELECT policy mirroring `model_cards_select_authenticated`. |
| P0 | 3 | Phase 4–8 catalog/work tables in `25–29` lack RLS entirely (`compound_smarts_catalog`, `compound_substructure_hits`, `compound_classes`, `compound_class_assignments`, `gen_runs`, `gen_proposals`, `bioisostere_rules`, `mmp_pairs`, `task_queue`, `task_batches`, `chemspace_screens`, `chemspace_results`, `workflows`, `workflow_runs`, `workflow_events`, `workflow_state`, `workflow_modifications`). Several carry `payload`/`scores` JSONB derived from per-user inputs | `db/init/25_compound_ontology.sql:60-70`, `db/init/26_genchem.sql:84-95`, `db/init/27_job_queue.sql:108-117`, `db/init/28_screens.sql:39-47`, `db/init/29_workflows.sql:115-131` | At minimum apply `ENABLE/FORCE` + an authn-only `USING (current_setting('app.current_user_entra_id', true) <> '')` for catalogs; project-scope the work tables (`workflow_runs`, `gen_runs`, `chemspace_screens`, `task_queue`) by joining `nce_project_id` or `created_by`. |
| P0 | 4 | `user_project_access` has no RLS and no FORCE — any authenticated `chemclaw_app` query (`SELECT user_entra_id FROM user_project_access`) returns the whole RBAC table, including foreign-team identifiers | `db/init/01_schema.sql:285-292` (table), nowhere | `ALTER TABLE user_project_access ENABLE/FORCE ROW LEVEL SECURITY; CREATE POLICY upa_self ON user_project_access FOR SELECT USING (user_entra_id = current_setting('app.current_user_entra_id', true) OR current_user_is_admin('global_admin'));` |
| P1 | 5 | Five new NOTIFY trigger functions added in `23/24/27/29` lack `SET search_path = public, pg_temp`. `16_db_audit_fixes.sql §4` only pinned `set_updated_at`, `notify_ingestion_event`, `agent_sessions_regen_etag`, `mock_eln.set_entry_modified_at` | `db/init/23_qm_results.sql:177`, `24_compound_fingerprints.sql:86`, `27_job_queue.sql:63,77`, `29_workflows.sql:76` | Add `SET search_path = pg_catalog, public` (matches the `notify_error_event` style at `19_observability.sql:112`) to each new function definition. |
| P1 | 6 | `audit_log` partitions are only bootstrapped for current month + 2; no partition-creator job exists in `services/optimizer/`. After ~90 days every audited write hits `EXCEPTION WHEN OTHERS` and the audit row is dropped (forwarded to `error_events` which itself can fail silently) | `db/init/19_observability.sql:239-262`, missing `services/optimizer/audit_partition_maintainer/` | Add an `optimizer/audit_partition_maintainer` daemon (or pg_cron job) that pre-creates `audit_log_yYYYYmMM` for `now() + 1 month`. Code already references the daemon by name in the comment but the package was never created. |
| P1 | 7 | `redaction_patterns` lacks the documented `is_pattern_safe()` enforcement: only `length(pattern_regex) <= 200` is enforced at DB layer. CLAUDE.md "Redaction patterns" claims a DB CHECK rejects unbounded `.*` constructs — the CHECK is not in the schema, only `length` is | `db/init/20_redaction_patterns.sql:37` | Add `CHECK (pattern_regex !~ '(?<!\\)\.\*' AND pattern_regex !~ '(?<!\\)\.\+' AND pattern_regex !~ '(?<!\\)\\S\+')` or move the existing TS-side `is_pattern_safe()` to a SQL function and CHECK against it. |
| P1 | 8 | `audit_row_change` trigger is wired only on 8 tables (`nce_projects`, `synthetic_steps`, `experiments`, `agent_sessions`, `agent_plans`, `agent_todos`, `skill_library`, `forged_tool_tests`); writes to `hypotheses`, `artifacts`, `paperclip_state`, `documents`, `reactions`, `feedback_events`, `corrections` are NOT row-audited despite carrying user-derived state | `db/init/19_observability.sql:368-402` | Extend the `audited_tables` array. `hypotheses`, `artifacts`, `reactions`, `corrections`, `feedback_events`, `paperclip_state` are the highest-value adds. |
| P1 | 9 | `db/migrations/202604230001_research_reports.sql` is a stale duplicate of `db/init/02_research_reports.sql` carrying the legacy fail-open `IS NULL OR = ''` policy. Not on the apply path (Makefile loops `db/init/*.sql`) but is misleading and may be applied by future tooling that walks `db/migrations/` | `db/migrations/202604230001_research_reports.sql:30-33` | Delete the file or rewrite it to match `16_db_audit_fixes.sql §2b`. |
| P1 | 10 | Confidence model still 3-way fragmented per Track C §3, only PARTIALLY remediated in PR-8. `reactions.confidence_score` is additive alongside `reactions.confidence_tier TEXT`, with no trigger to keep them in sync. A writer that updates `confidence_score` but not `confidence_tier` (or vice versa) silently desyncs | `db/init/17_unified_confidence_and_temporal.sql:55-69`, `db/init/01_schema.sql:123-128` | Either (a) make `reactions.confidence_tier` a STORED GENERATED column derived from `confidence_score` (matches `hypotheses.confidence_tier` shape; requires DROP+ADD which is a one-time schema rewrite), or (b) add a BEFORE INSERT/UPDATE trigger that recomputes one from the other. |
| P1 | 11 | `kg_hypotheses` projector advertises its name as `kg-hypotheses` (with hyphen) while the directory is `kg_hypotheses` (underscore). The replay command in CLAUDE.md (`DELETE FROM projection_acks WHERE projector_name='<name>'`) requires the exact hyphenated form — easy mis-replay foot-gun | `services/projectors/kg_hypotheses/main.py:30` | Standardise on `kg_hypotheses` (matches the 8 other projector names), with a one-shot `UPDATE projection_acks SET projector_name = 'kg_hypotheses' WHERE projector_name = 'kg-hypotheses'` migration. |
| P2 | 12 | `tools` and `mcp_tools` system catalog tables lack RLS, breaking the convention established by `model_cards`, `prompt_registry`, `feature_flags`, `permission_policies`, `redaction_patterns` (all FORCE+authn). Comment in `02_harness.sql:3` says "system metadata, not user-scoped" but the established pattern for catalog data is FORCE+authn | `db/init/02_harness.sql:13-40` | Apply `ENABLE/FORCE ROW LEVEL SECURITY` + an authn-only SELECT policy to bring this in line. Keep DML routed through admin endpoints. |
| P2 | 13 | `nce_projects`, `synthetic_steps`, `experiments` carry redundant policies after `12_security_hardening.sql §4` runs — both a `FOR SELECT` and a `FOR ALL` policy with identical predicates. Postgres OR-aggregates permissive policies, so the SELECT-only is dead code | `db/init/12_security_hardening.sql:260-354` | Drop the FOR SELECT policy (`*_read_policy`) and let the FOR ALL `*_modify_policy` cover all commands. |
| P2 | 14 | `enforce_user_context(p_table TEXT)` defined in `19_observability.sql:423-458` is dead code — no caller exists in `db/init`, projectors, or agent-claw routes. CLAUDE.md `19_observability.sql` header also references `log_rls_denial()` which doesn't exist in the file | `db/init/19_observability.sql:423`, `db/init/19_observability.sql:23-28` (header) | Either wire the function into write-path policies (intended use) or drop it. The header's `log_rls_denial()` reference is stale. |
| P2 | 15 | `kg_hypotheses._handle_status_changed` advances `valid_to = datetime()` without idempotency guard (still unfixed since 2026-04-29 audit §7) | `services/projectors/kg_hypotheses/main.py:148` (Cypher write) | Use `SET h.valid_to = CASE WHEN h.valid_to IS NULL THEN datetime() ELSE h.valid_to END`. |
| P2 | 16 | Three bi-temporal tables use slightly different column shapes: `reactions(valid_from, valid_to, invalidated BOOLEAN)`, `hypotheses(valid_from, valid_to, refuted_at)`, `artifacts(valid_from, superseded_at, NO valid_to)`. Cross-table queries (e.g. "give me everything live as of T") need three different predicates | `db/init/17_unified_confidence_and_temporal.sql:20-23,34-37,93-95` | Standardise: every fact-bearing table gets `(valid_from TIMESTAMPTZ NOT NULL DEFAULT NOW(), valid_to TIMESTAMPTZ)`. Domain-specific columns (`invalidated`, `refuted_at`, `superseded_at`) become reasons captured in a `valid_to_reason TEXT` rather than a structural divergence. |
| P2 | 17 | `compounds.confidence_score` does not exist — `confidence_tier` style is reserved for `reactions` only, but the cross-project compound similarity layer would benefit from a confidence column on `compound_class_assignments` (it has `confidence NUMERIC(4,3)` already — name diverges from `confidence_score` used elsewhere) | `db/init/25_compound_ontology.sql:44` | Rename `compound_class_assignments.confidence` → `confidence_score` for naming consistency, OR document the divergence. |
| P2 | 18 | `paperclip_state.session_id_shape` CHECK is `NOT VALID` — pre-existing legacy rows are skipped at validation. New rows are checked but a future bug-fix that re-validates (`ALTER ... VALIDATE CONSTRAINT`) could fail | `db/init/16_db_audit_fixes.sql:386-389` | Schedule a one-time `UPDATE paperclip_state SET session_id = ...` to canonicalise legacy rows, then `VALIDATE CONSTRAINT`. |
| P3 | 19 | `19_observability.sql §1` writes `error_events.id BIGSERIAL` (non-partitioned) while `audit_log` IS partitioned by month. Long-running deployments accumulate `error_events` rows without retention. CLAUDE.md "Partitions" guidance applies | `db/init/19_observability.sql:62-73` | Either partition `error_events` or document a retention policy that the operator must implement (e.g. `DELETE FROM error_events WHERE occurred_at < NOW() - INTERVAL '90 days'` cron). |
| P3 | 20 | `01_schema.sql` defines policies (lines 300-339) that include a `OR current_setting(...) IS NULL OR = ''` permissive bypass; `12_security_hardening.sql §4` overrides them. **On a partial-apply** (operator misses 12) the legacy permissive policies remain active, which is fail-open. `make db.init` is now fully ordered, so this is mostly historical, but the legacy DDL is still in `01_schema.sql` and will be re-installed before 12 runs on every fresh apply | `db/init/01_schema.sql:300-339` | Replace the permissive predicates in 01_schema.sql with the strict form (`EXISTS (SELECT 1 FROM upa ...)` only). The override-by-12 pattern is brittle. |
| P3 | 21 | `notify_qm_job_succeeded` triggers on `AFTER INSERT OR UPDATE OF status` and emits NOTIFY when transitioning to `succeeded`. The check `OLD.status <> 'succeeded'` is unsafe for the INSERT case where OLD doesn't exist (`OLD.status` is NULL). The `TG_OP = 'INSERT'` short-circuits ahead, so functionally OK, but a future refactor could regress | `db/init/23_qm_results.sql:178-181` | Reorder predicate to `IF NEW.status = 'succeeded' AND (TG_OP = 'INSERT' OR OLD.status IS DISTINCT FROM NEW.status)`. |
| P3 | 22 | `task_queue.idempotency_key` is `BYTEA` and PK on `(task_kind, idempotency_key)` is enforced via partial unique index. Callers must compute and pass a hash — there's no DB-side coercion (e.g. `sha256(payload)`). No bug, but documented obligation buried in `27_job_queue.sql:24-33` | `db/init/27_job_queue.sql:24-33` | Either enforce via trigger (`NEW.idempotency_key := digest(NEW.payload::text, 'sha256')`) or document explicitly in CLAUDE.md "When adding a new task." |
| P3 | 23 | Some files self-write to `schema_version` (e.g. `23_qm_results.sql:221`, `24_compound_fingerprints.sql:153`, `25–29`). Others (00–22, 30–31) rely on the Makefile loop. **Mixed pattern**: when the loop applies a self-writing file, two rows are inserted (`23_qm_results.sql` from the loop's `'$$f'` path, plus the file's own `'23_qm_results.sql'`). Note: `19_observability.sql:476-479` explicitly notes this and removed its own write — but 23–29 still have it | `db/init/23_qm_results.sql:221`, `24_compound_fingerprints.sql:153`, `25_compound_ontology.sql:125`, `26_genchem.sql:120`, `27_job_queue.sql:126`, `28_screens.sql:55`, `29_workflows.sql:148` | Drop the in-file `INSERT INTO schema_version` from 23–29; the Makefile loop is the single source of truth. |

---

## Full Appendix

### P0-1: `experiment_imported` events have no live writer

**Evidence (writers):**
```bash
$ grep -rn "experiment_imported" services/ | grep -v "\.legacy" | grep -v test
services/projectors/reaction_vectorizer/main.py:45:    interested_event_types = ("experiment_imported",)
services/projectors/conditions_normalizer/main.py:83:    interested_event_types = ("experiment_imported",)
services/projectors/kg_experiments/main.py:64:    interested_event_types = ("experiment_imported",)
```
The only writer is at `services/ingestion/eln_json_importer.legacy/importer.py:258`,
flagged "retired from live path; preserved for one-shot bulk migrations from a
JSON dump" in CLAUDE.md.

**Why it matters:** the documented architecture (CLAUDE.md "The architectural
pattern that matters most: A-on-C event-sourced ingestion") says ingestion
emits events that derive every projection. Three downstream projections
(reaction DRFP vectors, condition normalization, KG experiment edges) silently
have no input. `mcp_eln_local` and `mcp_logs_sciy` MCPs are described in CLAUDE.md
as the live source-system adapters, but they go through the `kg_source_cache`
projector via `source_fact_observed` events — there is no fan-out from
`source_fact_observed` to `experiment_imported`.

**Fix sketch:** either (a) add a small projector that translates a subset of
`source_fact_observed` events into per-experiment `experiment_imported` events,
or (b) update the three downstream projectors to subscribe to
`source_fact_observed` directly with a payload-shape filter
(`payload->>'kind' = 'experiment'`).

**Blast radius:** any feature that depends on DRFP-based reaction similarity,
condition extraction, or KG experiment nodes is silently broken on real ELN
ingestion. Mock ingestion via `db/seed/20_mock_eln_data.sql` doesn't fire any
event-bus traffic at all.

**Suggested test:** integration test that imports one row through the live
adapter, polls `projection_acks` for each of the three projector names, and
asserts that the row is acked within 30 s.

### P0-2: `qm_*` tables (Phase 1) have no RLS

**Evidence (`db/init/23_qm_results.sql:191-207`):**
```sql
-- 10. RLS — chemistry is global; chemclaw_app reads, chemclaw_service writes
DO $$
BEGIN
  IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'chemclaw_app') THEN
    GRANT SELECT ON qm_jobs, qm_results, qm_conformers, qm_frequencies,
                    qm_thermo, qm_scan_points, qm_irc_points, qm_md_frames
      TO chemclaw_app;
  END IF;
  ...
END $$;
```
No `ALTER TABLE ... ENABLE ROW LEVEL SECURITY` anywhere in this file, and the
section header says "RLS" but only emits GRANTs.

**Why it matters:** every other "global" catalog (`model_cards`, `feature_flags`,
`prompt_registry`, `redaction_patterns`, `permission_policies`) follows the
same pattern: ENABLE+FORCE RLS + `current_setting('app.current_user_entra_id',
true) <> ''` SELECT policy. CLAUDE.md states "FORCE ROW LEVEL SECURITY is set
on every project-scoped table". `qm_jobs` may be tenant-agnostic chemistry, but
the convention for un-authenticated reads is fail-closed.

**Fix sketch:**
```sql
DO $$
DECLARE t TEXT;
BEGIN
  FOREACH t IN ARRAY ARRAY['qm_jobs','qm_results','qm_conformers',
                            'qm_frequencies','qm_thermo','qm_scan_points',
                            'qm_irc_points','qm_md_frames']
  LOOP
    EXECUTE format('ALTER TABLE %I ENABLE ROW LEVEL SECURITY', t);
    EXECUTE format('ALTER TABLE %I FORCE ROW LEVEL SECURITY', t);
    EXECUTE format(
      'CREATE POLICY %I_authn_select ON %I FOR SELECT USING (
         current_setting(''app.current_user_entra_id'', true) IS NOT NULL
         AND current_setting(''app.current_user_entra_id'', true) <> ''''
       )', t, t);
  END LOOP;
END $$;
```

**Suggested test:** pgTAP `policies_are('qm_jobs', ARRAY['qm_jobs_authn_select'])`
plus a connection check that an unauthenticated `chemclaw_app` SELECT returns
zero rows.

### P0-3: Phase 4-8 tables lack RLS

**Evidence (`db/init/27_job_queue.sql:108-117`):**
```sql
-- RLS / grants
DO $$
BEGIN
  IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'chemclaw_app') THEN
    GRANT SELECT, INSERT ON task_queue, task_batches TO chemclaw_app;
  END IF;
  ...
END $$;
```
The "RLS / grants" header is not followed by any `ENABLE ROW LEVEL SECURITY`.
Same shape in `25_compound_ontology.sql`, `26_genchem.sql`, `28_screens.sql`,
`29_workflows.sql`.

**Why it matters:** `task_queue.payload` carries arbitrary JSON for chemistry
sweeps; `chemspace_screens.candidate_source` and `scoring_pipeline` carry
user-derived input; `gen_runs.params` and `gen_proposals.scores` similarly.
A user who can query `chemspace_screens` can see every other tenant's screen
configurations and ranked candidates.

**Fix sketch:** apply a per-table ENABLE/FORCE + `current_setting('app.current_user_entra_id') <> ''`
authn policy, plus owner-scoped policies for tables that have a `created_by`
column (`chemspace_screens`, `gen_runs`, `task_batches`, `workflow_runs`).

**Blast radius:** cross-tenant data leak via any agent run that hits the
optimization / generation / chemspace / workflow surfaces.

### P0-4: `user_project_access` has no RLS

**Evidence (`db/init/01_schema.sql:285-292`):**
```sql
CREATE TABLE IF NOT EXISTS user_project_access (
  user_entra_id   TEXT NOT NULL,
  nce_project_id  UUID NOT NULL REFERENCES nce_projects(id) ON DELETE CASCADE,
  role            TEXT NOT NULL CHECK (role IN ('viewer', 'contributor', 'project_lead', 'admin')),
  granted_at      TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  PRIMARY KEY (user_entra_id, nce_project_id)
);
```
No subsequent `ALTER TABLE user_project_access ENABLE ROW LEVEL SECURITY` in
any of the 32 init files.

**Why it matters:** every project-scoped policy (`nce_projects_modify_policy`,
`experiments_modify_policy`, etc.) does an `EXISTS` subquery against
`user_project_access`. The subquery itself runs under the caller's RLS context
because no BYPASSRLS role applies. Today's policy on `user_project_access` is
"public" (no policy + no RLS = `chemclaw_app` reads everything by default
because `GRANT SELECT, INSERT, UPDATE, DELETE ON ALL TABLES IN SCHEMA public
TO chemclaw_app` from `12_security_hardening.sql:93`). A user `SELECT * FROM
user_project_access` returns the whole RBAC table — including cross-tenant
identifiers and roles.

**Fix sketch:**
```sql
ALTER TABLE user_project_access ENABLE ROW LEVEL SECURITY;
ALTER TABLE user_project_access FORCE ROW LEVEL SECURITY;

CREATE POLICY upa_self_select ON user_project_access FOR SELECT
USING (
  user_entra_id = current_setting('app.current_user_entra_id', true)
  OR current_user_is_admin('global_admin')
);

CREATE POLICY upa_admin_modify ON user_project_access FOR ALL
USING (current_user_is_admin('global_admin'))
WITH CHECK (current_user_is_admin('global_admin'));
```
WARNING: this changes the EXISTS subquery semantics. The subquery now runs
under RLS and only sees the caller's own row, which is exactly what the
predicate already requires (`upa.user_entra_id = current_setting(...)`). So the
project-scoped policies still function. But sanity-check every existing policy
for the assumption.

**Blast radius:** RBAC table contents leak today; after fix, project-scoped
policies still work because they were already filtering by `user_entra_id =
current_setting(...)`.

**Suggested test:** pgTAP `is_empty('SELECT * FROM user_project_access WHERE
user_entra_id <> ''alice''', 'alice cannot see bob''s access')`.

### P1-5: NOTIFY trigger functions without `SET search_path`

**Evidence (`db/init/23_qm_results.sql:177-184`):**
```sql
CREATE OR REPLACE FUNCTION notify_qm_job_succeeded() RETURNS TRIGGER AS $$
BEGIN
  IF NEW.status = 'succeeded' AND (TG_OP = 'INSERT' OR OLD.status <> 'succeeded') THEN
    PERFORM pg_notify('qm_job_succeeded', NEW.id::text);
  END IF;
  RETURN NEW;
END;
$$ LANGUAGE plpgsql;
```
Compare to `db/init/19_observability.sql:109-126`:
```sql
CREATE OR REPLACE FUNCTION notify_error_event()
RETURNS TRIGGER
LANGUAGE plpgsql
SET search_path = pg_catalog, public
AS $$ ...
```
`16_db_audit_fixes.sql §4` pinned search_path on the four functions known at
that time (`set_updated_at`, `notify_ingestion_event`,
`agent_sessions_regen_etag`, `mock_eln.set_entry_modified_at`). Five additions
in 23/24/27/29 are unguarded.

**Why it matters:** these are SECURITY INVOKER (default), so the impact is
small — the invoking SECURITY context already controls `search_path`. But
consistency means any audit comparing functions can rely on a single
inspection rule.

**Fix sketch:** for each of the five functions, replace the body with the
`SET search_path = pg_catalog, public` form shown above.

### P1-6: `audit_log` partition creator missing

**Evidence (`db/init/19_observability.sql:236-262`):**
```sql
-- Bootstrap partitions: current month + next 2 months. A monthly cron
-- job (see services/optimizer/audit_partition_maintainer if added later)
-- creates the next month's partition before it's needed.
DO $$
DECLARE
    v_start DATE := date_trunc('month', now())::DATE;
    ...
BEGIN
    FOR i IN 0 .. 2 LOOP
        ...
    END LOOP;
END;
$$;
```
`find services/optimizer/ -name 'audit_partition*'` returns nothing.

**Why it matters:** after the bootstrap window expires, every audited write
(INSERT/UPDATE/DELETE on `nce_projects`, `synthetic_steps`, `experiments`,
`agent_sessions`, `agent_plans`, `agent_todos`, `skill_library`,
`forged_tool_tests`) hits the `EXCEPTION WHEN OTHERS` wrapper at line 333-360
and the audit row is silently dropped (with a forward to `error_events` that
can also fail per the inner `EXCEPTION WHEN OTHERS`). The platform stays up,
but auditability degrades silently.

**Fix sketch:** add a small daemon `services/optimizer/audit_partition_maintainer/main.py`
that runs the same `CREATE TABLE IF NOT EXISTS audit_log_yYYYYmMM PARTITION OF
audit_log FOR VALUES FROM ('YYYY-MM-01') TO ('YYYY-MM+1-01')` for `now() + 1
month` on a daily schedule; or a `pg_cron` job (already pinned via
`19_observability.sql` patterns).

### P1-7: `redaction_patterns` lacks regex-safety CHECK

**Evidence (`db/init/20_redaction_patterns.sql:35-42`):**
```sql
  CHECK (length(pattern_regex) <= 200),
  CHECK (
    (scope = 'global' AND scope_id = '')
    OR (scope = 'org' AND scope_id <> '')
  )
```
No CHECK against unbounded `.*`/`.+`/`\S+` constructs — only length is
enforced. CLAUDE.md "Redaction patterns" claims:

> Two safety rails enforce bounded regex: a DB CHECK on `length ≤ 200` AND
> `is_pattern_safe()` rejecting unbounded `.*` / `.+` / `\S+` constructs.

The DB-side `is_pattern_safe()` is missing.

**Fix sketch:** either add the CHECK constraints listed in the executive
summary, or move enforcement to a SECURITY DEFINER `is_pattern_safe(TEXT)`
SQL function and reference it in the CHECK.

### P1-8: Audit trigger missing on user-state tables

**Evidence (`db/init/19_observability.sql:368-380`):**
```sql
DO $$
DECLARE
    audited_tables CONSTANT TEXT[] := ARRAY[
        'nce_projects',
        'synthetic_steps',
        'experiments',
        'agent_sessions',
        'agent_plans',
        'agent_todos',
        'skill_library',
        'forged_tool_tests'
    ];
```
Tables NOT audited: `hypotheses` (user proposes), `artifacts` (user produces),
`reactions` (canonical writes), `corrections` (user proposes), `feedback_events`
(user signal), `paperclip_state` (budget reservations), `documents`,
`prompt_registry` (admin writes), `admin_roles` (admin writes — this one is
covered separately by `admin_audit_log`).

**Fix sketch:** extend the `audited_tables` array. Highest value:
- `hypotheses` — KG state primitive
- `artifacts` — user-produced
- `reactions` — canonical fact
- `corrections` — supersedes facts
- `feedback_events` — RLHF input

### P1-9: stale duplicate `db/migrations/202604230001_research_reports.sql`

**Evidence:** the file exists and has the legacy fail-open policy (lines 30-33):
```sql
USING (
    current_setting('app.current_user_entra_id', true) IS NULL
    OR current_setting('app.current_user_entra_id', true) = ''
    OR user_entra_id = current_setting('app.current_user_entra_id', true)
);
```
Compare to the live source-of-truth (`db/init/02_research_reports.sql`, same
content) and the post-hardening shape (`db/init/16_db_audit_fixes.sql §2b`,
strict `IS NOT NULL AND <> ''`).

**Why it matters:** `make db.init` does not apply `db/migrations/`. But the
file is misleading and may be picked up by a future ad-hoc tool that walks the
directory. Two files diverging on RLS posture is an audit smell.

**Fix sketch:** delete or update the file to mirror `02_research_reports.sql`
(which is itself the legacy form, pre-hardened by `16_db_audit_fixes.sql`).
Cleaner: delete and let the init/ tree be the single source.

### P1-10: confidence model still partially fragmented

**Evidence (`db/init/17_unified_confidence_and_temporal.sql:55-69`):**
```sql
ALTER TABLE reactions
  ADD COLUMN IF NOT EXISTS confidence_score NUMERIC(4,3)
    CHECK (confidence_score IS NULL OR
           (confidence_score >= 0.000 AND confidence_score <= 1.000));

UPDATE reactions
   SET confidence_score = CASE confidence_tier
     WHEN 'expert_validated'  THEN 1.000
     ...
```
The existing `reactions.confidence_tier TEXT` column (from
`01_schema.sql:123-128`) remains mutable and is NOT recomputed from
`confidence_score`. So a writer that updates one without the other silently
desyncs.

**Fix sketch:** either drop+re-add `reactions.confidence_tier` as a STORED
GENERATED column (matches `hypotheses.confidence_tier`), OR add a BEFORE
INSERT/UPDATE trigger that derives one from the other:
```sql
CREATE OR REPLACE FUNCTION reactions_sync_confidence() RETURNS TRIGGER AS $$
BEGIN
  IF NEW.confidence_score IS DISTINCT FROM COALESCE(OLD.confidence_score, NULL)
     AND NEW.confidence_tier IS NOT DISTINCT FROM COALESCE(OLD.confidence_tier, 'single_source_llm') THEN
    NEW.confidence_tier := CASE
      WHEN NEW.confidence_score >= 0.85 THEN 'expert_validated'
      WHEN NEW.confidence_score >= 0.70 THEN 'multi_source_llm'
      WHEN NEW.confidence_score >= 0.40 THEN 'single_source_llm'
      WHEN NEW.confidence_score >  0.00 THEN 'expert_disputed'
      ELSE                                    'invalidated'
    END;
  END IF;
  RETURN NEW;
END;
$$ LANGUAGE plpgsql SET search_path = public, pg_temp;
```

### P1-11: `kg-hypotheses` projector name uses hyphen, not underscore

**Evidence (`services/projectors/kg_hypotheses/main.py:30`):**
```python
class KGHypothesesProjector(BaseProjector):
    name = "kg-hypotheses"
```
Compare to other projector names: `reaction_vectorizer`, `kg_experiments`,
`chunk_embedder`, `contextual_chunker`, `kg_source_cache`, `compound_classifier`,
`compound_fingerprinter`, `qm_kg`, `conditions_normalizer` — all underscored.

**Why it matters:** the documented operator action `DELETE FROM projection_acks
WHERE projector_name='<name>'` requires the exact name. `kg-hypotheses` is the
only one with a hyphen — easy to confuse with the directory name `kg_hypotheses`.

### P2-12: `tools` and `mcp_tools` lack the catalog-RLS pattern

**Evidence (`db/init/02_harness.sql:13-40`, no ENABLE/FORCE):**
```sql
CREATE TABLE IF NOT EXISTS tools (
  id           uuid        PRIMARY KEY DEFAULT uuid_generate_v4(),
  ...
);
-- No RLS.
```
Compare `model_cards` (`19_reaction_optimization.sql:56-64`):
```sql
ALTER TABLE model_cards ENABLE ROW LEVEL SECURITY;
ALTER TABLE model_cards FORCE ROW LEVEL SECURITY;

CREATE POLICY model_cards_select_authenticated ON model_cards FOR SELECT
  USING (
    current_setting('app.current_user_entra_id', true) IS NOT NULL
    AND current_setting('app.current_user_entra_id', true) <> ''
  );
```

**Fix sketch:** apply the same authn pattern. Tool catalog rows are not secret
but the principle of fail-closed reads is consistent.

### P2-13: redundant SELECT-only policies on project tables

**Evidence (`db/init/12_security_hardening.sql:260-269` vs `298-314`):**
Both `nce_projects_read_policy` (FOR SELECT) and `nce_projects_modify_policy`
(FOR ALL) exist with identical USING predicates. PG aggregates permissive
policies by OR — the SELECT-only is dead code.

**Fix sketch:** drop the SELECT-only policies. FOR ALL covers SELECT.

### P2-14: `enforce_user_context` is dead code

**Evidence:** `grep -rn enforce_user_context services/` returns only the SQL
definition. CLAUDE.md `19_observability.sql:23` mentions a sibling
`log_rls_denial()` function that doesn't exist in the file.

**Fix sketch:** either wire `enforce_user_context()` into the WITH CHECK clauses
of the project-scoped policies (as the comment on line 419 envisions), or drop
the function. Update the file header to remove the `log_rls_denial` reference.

### P2-15: `kg_hypotheses._handle_status_changed` not idempotent

Persistent finding from 2026-04-29 audit §7. Not fixed.

**Evidence (`services/projectors/kg_hypotheses/main.py:148`):**
```python
SET h.valid_to = datetime()
```
Re-running on the same event advances `valid_to` slightly each time.

**Fix:**
```cypher
SET h.valid_to = CASE WHEN h.valid_to IS NULL THEN datetime() ELSE h.valid_to END
```

### P2-16: bi-temporal column shapes diverge

**Evidence:**
| Table | valid_from | valid_to | Domain marker |
|---|---|---|---|
| `reactions` | NOT NULL DEFAULT NOW() | nullable | `invalidated BOOLEAN` |
| `hypotheses` | NOT NULL DEFAULT NOW() | nullable | `refuted_at TIMESTAMPTZ` |
| `artifacts` | NOT NULL DEFAULT NOW() | (no `valid_to` — has `superseded_at`) | — |
| `bioisostere_rules` | NOT NULL DEFAULT NOW() | nullable | — |
| `compound_class_assignments` | NOT NULL DEFAULT NOW() | nullable | — |
| `workflows` | NOT NULL DEFAULT NOW() | nullable | — |
| `qm_jobs` | NOT NULL DEFAULT NOW() | nullable | — |

`artifacts` is the outlier — `superseded_at` plays the role of `valid_to` but a
"give me the latest live artifacts" query needs `superseded_at IS NULL`, while
"give me latest live reactions" needs `valid_to IS NULL AND invalidated = false`.

**Fix sketch:** standardise on `valid_from / valid_to`. Move `invalidated` /
`refuted_at` / `superseded_at` to a single `valid_to_reason TEXT` column or
keep both forms in lockstep via a trigger.

### P2-17: `compound_class_assignments.confidence` naming

**Evidence (`db/init/25_compound_ontology.sql:44`):**
```sql
confidence     NUMERIC(4,3) NOT NULL CHECK (confidence >= 0.000 AND confidence <= 1.000),
```
Other tables use `confidence_score`. Minor naming consistency.

### P2-18: `paperclip_state_session_id_shape` is `NOT VALID`

**Evidence (`db/init/16_db_audit_fixes.sql:386-389`):**
```sql
ALTER TABLE paperclip_state
  ADD CONSTRAINT paperclip_state_session_id_shape
  CHECK (...) NOT VALID;
```
Pre-existing rows are not validated; a future re-run of `VALIDATE CONSTRAINT`
might fail.

### P3-19: `error_events` retention

`19_observability.sql:62-73` defines `error_events` as a non-partitioned
BIGSERIAL table. No retention. Long-running deployments fill it.

### P3-20: legacy `IS NULL OR = ''` policies in 01_schema.sql

The first-pass policies in `01_schema.sql:300-339` are fail-open. They are
unconditionally replaced by `12_security_hardening.sql §4`. On a fresh apply
they exist briefly between the lex-ordered application of 01 and 12 — not
reachable by app traffic during init, but the legacy DDL remains in the source
of truth. Fixing it makes 01 internally fail-closed without depending on 12.

### P3-21: `notify_qm_job_succeeded` predicate ordering

`OLD.status` is referenced before the `TG_OP = 'INSERT'` short-circuit. PG's
short-circuit evaluation makes this safe today, but the form
`(TG_OP = 'INSERT' OR OLD.status IS DISTINCT FROM NEW.status)` is more
defensive against future edits.

### P3-22: `task_queue.idempotency_key` is caller's burden

No DB-side coercion of a payload-hash idempotency key. By design but should
be documented in CLAUDE.md "When adding a new task."

### P3-23: split `schema_version` write pattern

Files 23-29 each emit `INSERT INTO schema_version (filename, applied_at)
VALUES ('NN_xxx.sql', NOW()) ON CONFLICT DO NOTHING` while files 00-22 and
30-31 don't. The Makefile loop ALSO emits an INSERT keyed by `'$$f'` (relative
path `db/init/NN_xxx.sql`). Result on a fresh apply: 23-29 produce two rows
each (`'23_qm_results.sql'` from the file, `'db/init/23_qm_results.sql'` from
the loop). The CLAUDE.md tracker query `SELECT * FROM schema_version` shows
duplicate-looking rows. `19_observability.sql:476-479` explicitly notes this
and removed its own write — but 23-29 still have it.

---

## Tables Inventory

Project-scoped (= reads must be RLS-gated by `user_project_access`):

| Table | RLS | FORCE | Audit trigger | Policies | Indexed RLS subquery cols |
| --- | :-: | :-: | :-: | :-: | :-: |
| `nce_projects` | Y | Y | Y | 2 (read+modify; redundant) | Y (PK) |
| `synthetic_steps` | Y | Y | Y | 2 | Y (`idx_synthetic_steps_project` 17_) |
| `experiments` | Y | Y | Y | 2 | Y (`idx_experiments_step` 01_) |
| `reactions` | Y | Y | **N** | 1 | Y (`idx_reactions_experiment`) |
| `documents` | Y | Y | **N** | 1 (authn-only) | n/a |
| `document_chunks` | Y | Y | **N** | 1 (authn-only) | Y |
| `compounds` | Y | Y | **N** | 1 (authn-only) | n/a |
| `optimization_campaigns` | Y | Y | **N** | 1 | Y (`idx_user_project_access_user_project` 17_) |
| `optimization_rounds` | Y | Y | **N** | 1 | Y |
| `hypotheses` | Y | Y (16_) | **N** | 4 | Y (`idx_hypotheses_scope`) |
| `hypothesis_citations` | Y | Y (16_) | **N** | 1 | n/a (PK) |
| `artifacts` | Y | Y | **N** | 4 | n/a |

User-scoped:

| Table | RLS | FORCE | Audit trigger | Policies |
| --- | :-: | :-: | :-: | :-: |
| `feedback_events` | Y | Y | **N** | 1 |
| `corrections` | Y | Y | **N** | 1 |
| `notifications` | Y | Y | **N** | 1 |
| `paperclip_state` | Y | Y | **N** | 1 |
| `agent_sessions` | Y | Y | Y | 1 |
| `agent_todos` | Y | Y | Y | 1 |
| `agent_plans` | Y | Y | Y | 1 |
| `research_reports` | Y | Y | **N** | 1 |
| `skill_library` | Y | Y | Y | 4 (own SELECT, own INSERT, own UPDATE, own DELETE) |
| `forged_tool_tests` | Y | Y | Y | 2 |
| `forged_tool_validation_runs` | Y | Y | **N** | 1 |
| `admin_roles` | Y | Y | **N** | 2 |
| `admin_audit_log` | Y | Y | **N** | 2 |
| `shadow_run_scores` | Y | Y (16_) | **N** | 1 |
| `skill_promotion_events` | Y | Y (16_) | **N** | 1 |

Catalog (FORCE+authn-only is the established convention):

| Table | RLS | FORCE | Audit trigger | Policies | Convention compliance |
| --- | :-: | :-: | :-: | :-: | :-: |
| `prompt_registry` | Y | Y | **N** | 1 | OK |
| `model_cards` | Y | Y | **N** | 1 | OK |
| `feature_flags` | Y | Y | **N** | 2 | OK |
| `redaction_patterns` | Y | Y | **N** | 2 | OK |
| `permission_policies` | Y | Y | **N** | 2 | OK |
| `config_settings` | Y | Y | **N** | 2 (admin-only) | OK |
| `tools` | **N** | **N** | **N** | 0 | **VIOLATES** convention (P2-12) |
| `mcp_tools` | **N** | **N** | **N** | 0 | **VIOLATES** convention (P2-12) |
| `compound_smarts_catalog` | **N** | **N** | **N** | 0 | **VIOLATES** (P0-3) |
| `compound_classes` | **N** | **N** | **N** | 0 | **VIOLATES** (P0-3) |
| `bioisostere_rules` | **N** | **N** | **N** | 0 | **VIOLATES** (P0-3) |

Fact / data:

| Table | RLS | FORCE | Notes |
| --- | :-: | :-: | --- |
| `qm_jobs` ... `qm_md_frames` (8 tables) | **N** | **N** | P0-2 — granted to `chemclaw_app` SELECT but no row gate |
| `gen_runs` | **N** | **N** | P0-3 |
| `gen_proposals` | **N** | **N** | P0-3 |
| `mmp_pairs` | **N** | **N** | P0-3 |
| `compound_substructure_hits` | **N** | **N** | P0-3 |
| `compound_class_assignments` | **N** | **N** | P0-3 |
| `task_queue` | **N** | **N** | P0-3 — payload may carry user data |
| `task_batches` | **N** | **N** | P0-3 |
| `chemspace_screens` | **N** | **N** | P0-3 — has `created_by` |
| `chemspace_results` | **N** | **N** | P0-3 |
| `workflows` | **N** | **N** | P0-3 — has `created_by` |
| `workflow_runs` | **N** | **N** | P0-3 |
| `workflow_events` | **N** | **N** | P0-3 |
| `workflow_state` | **N** | **N** | P0-3 |
| `workflow_modifications` | **N** | **N** | P0-3 |

System:

| Table | RLS | FORCE | Notes |
| --- | :-: | :-: | --- |
| `ingestion_events` | **N** | **N** | Designed system-only; OK |
| `projection_acks` | **N** | **N** | Designed system-only; OK |
| `error_events` | Y | Y | OK |
| `audit_log` | Y | Y | OK; partitioned (P1-6 retention concern) |
| `schema_version` | **N** | **N** | OK (catalog of applied files) |
| `user_project_access` | **N** | **N** | **P0-4** — RBAC base table without RLS |

mock_eln + fake_logs schemas: deliberately NOT under public RLS; gated by
`chemclaw_mock_eln_reader` role membership only. OK for testbed.

---

## Cross-Reference: Prior Audit (`docs/review/2026-04-29-codebase-audit/03-db-schema.md`)

### Fixed since 2026-04-29

| Prior finding | Status |
| --- | --- |
| §1 `make db.init` applies only `01_schema.sql` | **FIXED** (`Makefile` now loops `db/init/*.sql` with `ON_ERROR_STOP=1` and writes `schema_version`). |
| §2 missing temporal columns on `reactions`, `hypotheses`, `artifacts` | **FIXED** (`17_unified_confidence_and_temporal.sql §1-4`). |
| §3 confidence model 3-way fragmentation | **PARTIALLY FIXED** — `reactions.confidence_score` added (additive), but `confidence_tier` still mutable TEXT and not auto-derived. See P1-10. |
| §4 `skill_library`, `forged_tool_tests` lack `maturity` | **FIXED** (`17_unified_confidence_and_temporal.sql §5`). |
| §5 missing FK indexes (`user_project_access`, `synthetic_steps`) | **FIXED** (`17_unified_confidence_and_temporal.sql §6`). |
| §6 `skill_library` no DELETE policy | **FIXED** (`17_unified_confidence_and_temporal.sql §7`). |
| §6 `with-user-context.ts:12` stale comment | Out of scope for this DB audit. |

### Persistent (still open from 2026-04-29)

| Prior finding | This-audit ref | Note |
| --- | --- | --- |
| §3 confidence model fragmentation | P1-10 | partially fixed; `confidence_tier` still TEXT not GENERATED on `reactions` |
| §7 `kg_hypotheses._handle_status_changed:148` not idempotent | P2-15 | unchanged |

### New in 2026-05-03

| Finding | Severity | Note |
| --- | --- | --- |
| `experiment_imported` events have no live writer | P0-1 | only `eln_json_importer.legacy/` emits the type the three projectors subscribe to |
| `qm_*` tables lack RLS | P0-2 | new with `23_qm_results.sql` (Phase 1) |
| Phase 4–8 tables lack RLS | P0-3 | new with `25–29_*.sql` |
| `user_project_access` lacks RLS | P0-4 | pre-existing in `01_schema.sql` but cross-tenant exposure not previously identified |
| 5 new NOTIFY trigger functions without `SET search_path` | P1-5 | new with `23/24/27/29` |
| `audit_log` partition creator missing | P1-6 | new with `19_observability.sql` |
| `redaction_patterns` lacks `is_pattern_safe()` CHECK | P1-7 | new with `20_redaction_patterns.sql` |
| `audit_row_change` not attached to `hypotheses`, `artifacts`, `reactions`, etc. | P1-8 | new with `19_observability.sql` |
| Stale `db/migrations/202604230001_research_reports.sql` | P1-9 | pre-existing artefact |
| `kg-hypotheses` projector name uses hyphen | P1-11 | pre-existing — not surfaced by prior audit |
| `tools`/`mcp_tools` violate catalog-RLS convention | P2-12 | pre-existing but convention only solidified after PR-8 |
| Redundant SELECT-only policies on project tables | P2-13 | pre-existing |
| `enforce_user_context` dead code | P2-14 | new with `19_observability.sql` |
| Bi-temporal column shapes diverge | P2-16 | new with `17_unified_confidence_and_temporal.sql` adding 3 different shapes |
| `compound_class_assignments.confidence` vs `confidence_score` | P2-17 | new with `25_compound_ontology.sql` |
| `paperclip_state_session_id_shape` `NOT VALID` | P2-18 | new with `16_db_audit_fixes.sql` |
| `error_events` retention | P3-19 | new with `19_observability.sql` |
| Legacy permissive RLS in 01_schema | P3-20 | pre-existing — re-installed on every fresh init before 12_ overrides |
| `notify_qm_job_succeeded` predicate ordering | P3-21 | new with `23_qm_results.sql` |
| `task_queue.idempotency_key` is caller's burden | P3-22 | new with `27_job_queue.sql` |
| Split `schema_version` write pattern | P3-23 | new with `23–29_*.sql` |

---

*End of Database Schema Integrity Audit — 2026-05-03*
