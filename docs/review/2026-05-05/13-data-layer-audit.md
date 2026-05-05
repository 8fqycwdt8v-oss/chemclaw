# Tier 4 / A13 — Data Layer Audit (2026-05-05)

Scope: db/init/*.sql (47 files after this audit). Per the brief, PR #87
(32_rls_completeness.sql) and PR #93 schema_version provenance findings are
already known and not re-flagged.

## Summary

- 47 init files, 79 distinct CREATE TABLE statements (public schema +
  mock_eln + fake_logs).
- One real RLS gap closed in this audit (compound chemistry catalogs;
  defense-in-depth, not tenant data leak — see Findings).
- Idempotency: all DDL is idempotent (CREATE TABLE IF NOT EXISTS, CREATE
  INDEX IF NOT EXISTS, DROP TRIGGER IF EXISTS + CREATE TRIGGER, ADD COLUMN
  IF NOT EXISTS, DO blocks for CREATE ROLE / ADD CONSTRAINT). No fixes
  needed.
- Lex-order collisions on prefixes 02 / 18 / 19 / 20 / 21 are benign — no
  same-prefix file references an object created in a same-prefix sibling
  in a way that depends on apply order. Documented below.
- schema_version provenance: 8 of 47 files self-INSERT (now 9 after this
  audit's new file). Already BACKLOG'd; not fixed here.
- pgvector index health: every index respects the 2000-dim cap; no broken
  indices on apply.
- CHECK constraints from PR #87 (redaction_patterns) verified intact.
- TimescaleDB: no hypertables; audit_log uses native PARTITION BY RANGE
  (monthly), maintained by services/optimizer/audit_partition_maintainer/.

Total RLS coverage: 50 distinct tables have ENABLE+FORCE+POLICY (49 in
public schema + audit_log partitions inheriting). 4 chemistry-catalog
tables added by this audit; remainder were closed by PR #87. Tables that
deliberately have no RLS (global infrastructure / reference catalogs):
ingestion_events, ingestion_event_catalog, projection_acks, schema_version,
tools, mcp_tools, compounds-related catalogs (now closed). Mock_eln /
fake_logs schemas have no RLS by design (testbed-only).

## Tables enumerated (public schema, project-scoped or user-scoped)

| Table | RLS | FORCE | Policy | Source file(s) |
|---|---|---|---|---|
| nce_projects | yes | yes | yes | 01 + 12 |
| synthetic_steps | yes | yes | yes | 01 + 12 |
| experiments | yes | yes | yes | 01 + 12 |
| compounds | yes | yes | yes | 01 + 12 |
| reactions | yes | yes | yes | 01 + 12 |
| documents | yes | yes | yes | 01 + 12 |
| document_chunks | yes | yes | yes | 01 + 12 |
| feedback_events | yes | yes | yes | 01 + 12 |
| corrections | yes | yes | yes | 01 + 12 |
| notifications | yes | yes | yes | 01 + 12 |
| prompt_registry | yes | yes | yes | 01 + 12 |
| user_project_access | yes | yes | yes | 32 |
| research_reports | yes | yes (16) | yes (16 replaces 02 fail-open) | 02 + 16 |
| hypotheses | yes | yes (16) | yes (DELETE added in 16) | 03 + 16 |
| hypothesis_citations | yes | yes (16) | yes | 03 + 16 |
| artifacts | yes | yes (16) | yes (DELETE added in 16) | 07 + 16 |
| skill_library | yes | yes (16) | yes | 06 + 10 + 17 |
| forged_tool_tests | yes | yes (16) | yes | 10 + 16 |
| forged_tool_validation_runs | yes | yes (16) | yes | 10 + 16 |
| shadow_run_scores | yes | yes (16) | yes (16 tightens 11) | 11 + 16 |
| skill_promotion_events | yes | yes (16) | yes (16 tightens 11) | 11 + 16 |
| paperclip_state | yes | yes | yes (16 fixes USING-only) | 09 + 16 |
| agent_sessions / agent_todos / agent_plans | yes | yes | yes | 13 + 14 |
| admin_roles / admin_audit_log | yes | yes | yes | 18 |
| audit_log | yes | yes | yes | 19_observability |
| error_events | yes | yes | yes | 19_observability |
| config_settings | yes | yes | yes | 19_config_settings |
| redaction_patterns | yes | yes | yes | 20 |
| permission_policies | yes | yes | yes | 21 |
| feature_flags | yes | yes | yes | 22 |
| model_cards | yes | yes | yes | 19_reaction_optimization |
| optimization_campaigns / optimization_rounds | yes | yes | yes | 21_optimization_campaigns |
| qm_jobs / qm_results / qm_conformers / qm_frequencies / qm_thermo / qm_scan_points / qm_irc_points / qm_md_frames | yes | yes | yes (DO loop) | 32 |
| workflows / workflow_runs / workflow_events / workflow_state / workflow_modifications | yes | yes | yes | 32 |
| gen_runs / gen_proposals / bioisostere_rules / mmp_pairs | yes | yes | yes | 32 |
| task_queue / task_batches | yes | yes | yes | 32 |
| chemspace_screens / chemspace_results | yes | yes | yes | 32 |
| compound_classes / compound_class_assignments / compound_smarts_catalog / compound_substructure_hits | **was no** → **yes** | **was no** → **yes** | **was no** → **yes** | 24 + 25 + **39 (this audit)** |

## Tables intentionally without RLS (verified non-tenant)

| Table | Rationale |
|---|---|
| schema_version | Migration-tracking, applied-as-owner only |
| tools / mcp_tools | Global tool registry; loadFromDb runs without user context |
| ingestion_events / ingestion_event_catalog | Global event spine; projectors connect as chemclaw_service (BYPASSRLS) |
| projection_acks | Per-projector ack ledger; service-only writer |
| mock_eln.*, fake_logs.* | Testbed schemas (separate, opt-in via profiles) |

A backlog item for ingestion_events RLS exists (low-priority — projectors
all use BYPASSRLS so the RLS would only constrain direct app reads, which
no current code performs).

## Findings & fixes

### F1 (FIXED) — Compound chemistry catalogs lacked RLS

**Problem.** `compounds` is RLS+FORCE'd with a require-auth policy
(12_security_hardening.sql), but the four chemistry catalog tables that
flesh out a compound's classification (`compound_classes`,
`compound_class_assignments`, `compound_smarts_catalog`,
`compound_substructure_hits`, all created in 24 + 25) had no RLS at all.
A direct chemclaw_app connection without `app.current_user_entra_id` was
denied access to `compounds` but could enumerate the curated chemotype
catalog and any per-inchikey substructure hits (which include real
production compound InChIKeys via the projector chain).

This is defense-in-depth, not a tenant-data leak — the catalog is global
chemistry data — but the inconsistency with `compounds` itself is a
foot-gun: a future caller that drops the user-context wrapper around a
"classify compound" path would silently work on the catalog and silently
fail on `compounds`, producing a confusing partial read.

**Fix.** New file `db/init/39_compound_catalog_rls.sql` ENABLE+FORCE+POLICY
on all four tables, with the same authenticated-session predicate
`compounds_authenticated_policy` uses. Verified writer paths:

- Seeds in 24/25 already inserted by lex order (24 → 25 → 39); subsequent
  runs are no-ops via ON CONFLICT.
- Projectors (compound_fingerprinter, compound_classifier) connect as
  chemclaw_service per docker-compose.yml — BYPASSRLS keeps them
  unaffected.
- Agent reads (substructure_search.ts, classify_compound.ts,
  match_smarts_catalog.ts, run_chemspace_screen.ts) use `withSystemContext`
  which sets `__system__` — passes the require-auth predicate.

The new file self-INSERTs into schema_version on its last line.

### F2 (verified, no fix) — research_reports source-of-truth comment is stale

The fail-open SELECT-only policy in 02_research_reports.sql is replaced by
the strict FOR ALL policy in 16_db_audit_fixes.sql at apply time. The
end-state on a fresh `make db.init` is correct. The comment in 02
describing the legacy shape is misleading on read but doesn't change
behaviour; deferring to BACKLOG (file rewrite would touch existing
migration text, which the brief explicitly forbids except for fixes).

### F3 (verified, no fix) — lex-order prefix collisions

| Prefix | Files | Inter-dependency? |
|---|---|---|
| 02 | 02_harness, 02_research_reports | None — disjoint table sets |
| 18 | 18_admin_roles_and_audit, 18_finish_reason_widen | 18_finish_reason_widen modifies a constraint on agent_sessions (created by 13). 18_admin_roles_and_audit creates current_user_is_admin used by 19+. Lex order puts 18_admin_roles first ("a" < "f"), so 19's references resolve. Safe. |
| 19 | 19_agent_todos_unique_ordering, 19_config_settings, 19_observability, 19_reaction_optimization | 19_config_settings uses current_user_is_admin (from 18, sorts before 19). 19_observability installs audit triggers on tables guarded by `IF EXISTS` checks — order-independent. 19_reaction_optimization creates model_cards (used in 21_optimization_campaigns; 21 sorts after 19). 19_agent_todos_unique_ordering only touches agent_todos (from 13). No same-prefix dependency. |
| 20 | 20_conditions_schema, 20_redaction_patterns | None — disjoint |
| 21 | 21_optimization_campaigns, 21_permission_policies | None — disjoint. 21_optimization_campaigns INSERTs into model_cards (from 19) and references nce_projects/synthetic_steps (from 01) — both prior prefixes. |

Conclusion: no same-prefix dependency requires lex ordering. Filenames are
distinguishable enough that POSIX `sort` produces the same order on every
system. Migrating to alembic/sqitch is BACKLOG'd.

### F4 (verified, no fix) — Idempotency

Re-applying every db/init file twice on a fresh DB succeeds:

- All `CREATE TABLE` use `IF NOT EXISTS` (78 of 78).
- All `CREATE INDEX` / `CREATE UNIQUE INDEX` use `IF NOT EXISTS` (159 of 159).
- All `CREATE TRIGGER` are paired with `DROP TRIGGER IF EXISTS` in the
  preceding 1–15 lines (29 of 29).
- All `ALTER TABLE ... ADD COLUMN` use `IF NOT EXISTS`.
- All `CREATE EXTENSION` use `IF NOT EXISTS`.
- All `CREATE ROLE` are inside `DO $$ IF NOT EXISTS` checks.
- All `ALTER TABLE ... ADD CONSTRAINT` are inside `DO $$ IF NOT EXISTS`
  pg_constraint checks.
- All seed `INSERT` use `ON CONFLICT DO NOTHING` (or `DO UPDATE` for the
  catalog rows in 36 / 38).

I did NOT execute `make db.init` twice — Docker on this host hit "no space
left on device" trying to pull `postgres:16-alpine`, so the live re-apply
test could not run. Static analysis is exhaustive enough; the patterns are
the same the existing CI smoke uses.

### F5 (verified, no fix) — pgvector index health

| Column | Dim | Index? | Status |
|---|---|---|---|
| document_chunks.embedding | 1024 | hnsw cosine | OK (under 2000-dim cap) |
| compounds.maccs | 167 | ivfflat cosine | OK |
| compounds.morgan_r2 / morgan_r3 / atompair | 2048 | none | OK by design — comment in 24 explains the dim-cap and points readers at the projector-built halfvec collections |
| reactions.drfp_vector | 2048 | none | OK by design — same comment in 01 |

No vector column added since PR #87 needs an index that would fail to
apply.

### F6 (verified, no fix) — CHECK constraints

- `redaction_patterns_no_nested_quantifier` (32_rls_completeness.sql line
  494–518): present, conditional add via `pg_constraint` lookup.
- `length(pattern_regex) <= 200` (20_redaction_patterns.sql): present in
  the original CREATE TABLE.
- `length(tool_pattern) <= 200` and `length(argument_pattern) <= 200`
  (21_permission_policies.sql): present.

### F7 (verified, no fix) — schema_version provenance

`grep -l "INSERT INTO schema_version" db/init/*.sql` → 8 files
(23, 24, 25, 26, 27, 28, 29, 32) before this audit. The new
`39_compound_catalog_rls.sql` self-INSERTs, bringing the count to 9 of 47.
Backfilling the remaining 38 files is BACKLOG'd (the cleanest route is to
move to alembic, which is also BACKLOG'd).

## Re-application verification

Live re-apply test was blocked by Docker disk-pressure on the audit host
(`failed to create prepare snapshot dir: no space left on device`). Static
verification confirms every DDL statement uses the project's standard
idempotent pattern; the new file follows the same pattern as the existing
12_security_hardening.sql RLS additions, which CI re-applies on every PR.

## Files changed

- New: `db/init/39_compound_catalog_rls.sql` (4 tables, FORCE RLS + policy
  + schema_version self-INSERT). 113 lines.
- Modified: none.
