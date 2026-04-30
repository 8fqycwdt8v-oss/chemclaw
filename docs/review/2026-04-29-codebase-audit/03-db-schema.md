# ChemClaw Data Layer Audit — Track C

**Date:** 2026-04-29
**Auditor:** Track C (architect deep-dive schema review)
**Scope:** `db/init/*.sql`, `db/seed/*.sql`, `services/projectors/`, `services/agent-claw/src/db/`

---

## 1. db.init Refresh Path Bug

### The exact bug

`Makefile:87` defines `db.init` as:

```make
.PHONY: db.init
db.init: ## Re-apply schema (idempotent)
    docker compose exec -T postgres psql -U chemclaw -d chemclaw < db/init/01_schema.sql
```

This applies **only `01_schema.sql`** — a single file. The `db/init/` directory contains 11+ confirmed files (01 through 16, with some gaps). Running `make db.init` after editing `16_db_audit_fixes.sql` applies zero of those edits.

### Docker-entrypoint behavior contrast

`docker-compose.yml:27` mounts:
```yaml
volumes:
  - ./db/init:/docker-entrypoint-initdb.d:ro
```
The entrypoint applies all files in lex order **on first container creation** (when the data volume is empty). `make nuke && make up` triggers this. But `make db.init` against a running stack only applies the first file.

### Failure mode trace

Developer edits `16_db_audit_fixes.sql` → runs `make db.init` → only `01_schema.sql` runs (idempotent, no error) → developer believes schema is current → schema is stale.

`scripts/smoke.sh:72-75` does it correctly:
```bash
for f in db/init/*.sql; do
  docker compose exec -T postgres psql -U chemclaw -d chemclaw -v ON_ERROR_STOP=1 < "$f" >/dev/null
done
```

### Proposed minimal fix

```make
.PHONY: db.init
db.init: ## Re-apply schema (idempotent — applies all db/init/*.sql in order)
	@for f in db/init/*.sql; do \
	  echo "  applying $$f"; \
	  docker compose exec -T postgres psql -U chemclaw -d chemclaw \
	    -v ON_ERROR_STOP=1 < "$$f" || exit 1; \
	done
```

**Risk:** `16_db_audit_fixes.sql` uses `DO $$ ... IF to_regclass(...) IS NOT NULL THEN ... END $$` blocks to tolerate partial schema. The full loop on a partial schema is therefore safe and already tested via the smoke script.

**Routes to:** PR-8.

---

## 2. Bi-temporal Asymmetry

### Where temporality is stored

**Neo4j edges** (per `services/mcp_tools/mcp_kg/cypher.py:88-96`, `models.py:177-188`): every relationship created by `build_write_fact_cypher` carries `r.t_valid_from` (`ON CREATE`), `r.t_valid_to` (NULL on create, set by `invalidate_fact`), `r.recorded_at`, `r.invalidated_at`.

`kg_hypotheses` projector writes Hypothesis nodes with `n.valid_from = $created_at` (`main.py:109`); on refute sets `n.valid_to = datetime()` (`main.py:148`).

### Postgres survey

| Entity | Postgres table | `valid_from`/`valid_to`? | `effective_at`? | `refuted`? | Diverges from KG? |
|---|---|---|---|---|---|
| Reaction | `reactions` (01_schema.sql:114) | NO | NO | NO | YES |
| Hypothesis | `hypotheses` (03_hypotheses.sql:7) | NO (only `created_at`/`updated_at`) | NO | `status='refuted'` | YES |
| Document | `documents` (01_schema.sql:143) | `effective_date DATE` (single date, not range) | NO | NO | YES |
| Experiment | `experiments` (01_schema.sql:66) | NO | NO | `outcome_status TEXT` | YES |
| Compound | `compounds` (01_schema.sql:94) | NO | NO | NO | YES |
| Skill | `skill_library` (06:7) | `shadow_until TIMESTAMPTZ` (single-sided) | NO | NO | PARTIAL |
| Agent session | `agent_sessions` (13:19) | `expires_at TIMESTAMPTZ` | NO | N/A | N/A |

### Postgres tables that should grow temporal columns

```sql
-- reactions
ALTER TABLE reactions
  ADD COLUMN IF NOT EXISTS valid_from  TIMESTAMPTZ,
  ADD COLUMN IF NOT EXISTS valid_to    TIMESTAMPTZ,
  ADD COLUMN IF NOT EXISTS invalidated BOOLEAN NOT NULL DEFAULT FALSE;

-- hypotheses
ALTER TABLE hypotheses
  ADD COLUMN IF NOT EXISTS valid_from  TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  ADD COLUMN IF NOT EXISTS valid_to    TIMESTAMPTZ,
  ADD COLUMN IF NOT EXISTS refuted_at  TIMESTAMPTZ;

-- artifacts
ALTER TABLE artifacts
  ADD COLUMN IF NOT EXISTS valid_from  TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  ADD COLUMN IF NOT EXISTS superseded_at TIMESTAMPTZ;
```

Documents already have `effective_date DATE`; consider adding `effective_to DATE` for superseded SOPs.

---

## 3. Confidence Model

### Every confidence column

| Table | Column | Type | Range | NULL | Source |
|---|---|---|---|---|---|
| `reactions` | `confidence_tier` | TEXT NOT NULL DEFAULT 'single_source_llm' | 5-value enum (CHECK) | never | 01_schema.sql:123-128 |
| `hypotheses` | `confidence` | NUMERIC(4,3) NOT NULL | 0.0–1.0 (CHECK) | never | 03_hypotheses.sql:11-12 |
| `hypotheses` | `confidence_tier` | TEXT GENERATED ALWAYS | 3-value: 'high'/'medium'/'low' | never | 03_hypotheses.sql:13-18 |
| Neo4j edges | `confidence_tier` (property) | string | 5-value enum | optional | models.py:25-30 |
| Neo4j edges | `confidence_score` (property) | float | 0.0–1.0 | optional | models.py:108 |

### Inconsistencies

1. **Two different confidence representations** — `reactions` has only tier (TEXT), `hypotheses` has only score (NUMERIC) + generated 3-value tier, Neo4j carries both with the 5-value vocabulary.
2. **Three vocabularies for tier** — 5-value in `reactions`, 3-value in `hypotheses`, 5-value in Neo4j.
3. **Range semantics** — `hypotheses.confidence` is `NUMERIC(4,3)` (3 decimals, max 9.999 — but CHECK clamps to 1.0). Neo4j is unconstrained Python `float`.

### Proposed unified shape

```sql
-- Same on every fact-bearing table:
confidence_score NUMERIC(4,3) NOT NULL DEFAULT 0.5
  CHECK (confidence_score >= 0.000 AND confidence_score <= 1.000),

confidence_tier  TEXT GENERATED ALWAYS AS (
  CASE WHEN confidence_score >= 0.85 THEN 'expert_validated'
       WHEN confidence_score >= 0.70 THEN 'multi_source_llm'
       WHEN confidence_score >= 0.40 THEN 'single_source_llm'
       WHEN confidence_score >  0.00 THEN 'expert_disputed'
       ELSE                               'invalidated'
  END
) STORED
```

### Backfills

| Table | Action |
|---|---|
| `reactions` | Add `confidence_score NUMERIC(4,3) NOT NULL DEFAULT 0.5`. Drop and recreate `confidence_tier` as generated using 5-value mapping. Backfill: 'expert_validated'→1.0, 'multi_source_llm'→0.85, 'single_source_llm'→0.5, 'expert_disputed'→0.3, 'invalidated'→0.0 |
| `hypotheses` | Rename `confidence` → `confidence_score`. Drop 3-value generated `confidence_tier`. Add new 5-value generated `confidence_tier`. Existing rows keep numeric values. |
| `artifacts` | Add both columns (already has `confidence_ensemble JSONB` for richer info; layer the unified shape on top) |

---

## 4. Maturity Enum Coverage

### Tables that have `maturity`

| Table | File | State |
|---|---|---|
| `hypotheses` | unresolved init file (referenced in `scripts/smoke.sh:231`) | confirmed present |
| `document_chunks` | unresolved | confirmed present (contextual_prefix/page_number used by chunker) |
| `artifacts` | inferred from `16_db_audit_fixes.sql:247` (`idx_artifacts_owner_maturity`) | confirmed present |

### Should have but don't

| Table | Why | Current state |
|---|---|---|
| `skill_library` | Maturity tiers apply to skills per CLAUDE.md (Phase C) | NO `maturity` column visible in `06_skill_library.sql:7` |
| `forged_tool_tests` | Maturity tiers apply to tools | inferred absent |
| `research_reports` | Reports should have maturity (EXPLORATORY draft → FOUNDATION approved) | unconfirmed |

### Backfill defaults

```sql
ALTER TABLE skill_library
  ADD COLUMN IF NOT EXISTS maturity TEXT NOT NULL DEFAULT 'EXPLORATORY'
    CHECK (maturity IN ('EXPLORATORY', 'WORKING', 'FOUNDATION'));

ALTER TABLE forged_tool_tests
  ADD COLUMN IF NOT EXISTS maturity TEXT NOT NULL DEFAULT 'EXPLORATORY'
    CHECK (maturity IN ('EXPLORATORY', 'WORKING', 'FOUNDATION'));

ALTER TABLE research_reports
  ADD COLUMN IF NOT EXISTS maturity TEXT NOT NULL DEFAULT 'EXPLORATORY'
    CHECK (maturity IN ('EXPLORATORY', 'WORKING', 'FOUNDATION'));
```

---

## 5. FK Index Coverage

### Coverage table

| FK | References | Index? | Notes |
|---|---|---|---|
| `synthetic_steps.nce_project_id` | `nce_projects(id)` | **MISSING** | Hot RLS join target |
| `experiments.synthetic_step_id` | `synthetic_steps(id)` | YES (`idx_experiments_step` 01:88) | OK |
| `reactions.experiment_id` | `experiments(id)` | YES (`idx_reactions_experiment` 01:130) | OK |
| `document_chunks.document_id` | `documents(id)` | YES (`idx_chunks_document` 01:176) | OK |
| `projection_acks.event_id` | `ingestion_events(id)` | covered by PK | OK |
| `user_project_access.nce_project_id` | `nce_projects(id)` | **MISSING** | Critical — RLS subquery target on every authenticated query |
| `user_project_access.user_entra_id` | (join key) | **MISSING** | Same as above |
| `hypothesis_citations.hypothesis_id` | `hypotheses(id)` | covered by PK `(hypothesis_id, fact_id)` | OK |
| `agent_todos.session_id` | `agent_sessions(id)` | YES (`idx_agent_todos_session_ordering`) | OK |
| `agent_plans.session_id` | `agent_sessions(id)` | YES (`idx_agent_plans_session_status`) | OK |
| `hypotheses.scope_nce_project_id` | `nce_projects(id)` | YES (`idx_hypotheses_scope`) | OK |

### Critical gaps

**`user_project_access`** has no composite index on `(user_entra_id, nce_project_id)`. Every RLS policy across `nce_projects`, `synthetic_steps`, `experiments`, `reactions`, and `hypotheses` runs:

```sql
EXISTS (SELECT 1 FROM user_project_access upa
         WHERE upa.nce_project_id = <table>.id
           AND upa.user_entra_id = current_setting('app.current_user_entra_id', true))
```

With no index, this is a sequential scan on every user-visible row. Hot path.

```sql
-- PR-8 / new 17_ file:
CREATE INDEX IF NOT EXISTS idx_user_project_access_user_project
  ON user_project_access (user_entra_id, nce_project_id);

CREATE INDEX IF NOT EXISTS idx_synthetic_steps_project
  ON synthetic_steps (nce_project_id);
```

---

## 6. RLS Enforcement Spot-Check

### After 12_security_hardening.sql + 16_db_audit_fixes.sql

| Table | ENABLE | FORCE | Policy refs GUC | Status |
|---|---|---|---|---|
| `nce_projects` | ✓ (01:296) | ✓ (12:109) | ✓ | OK |
| `synthetic_steps` | ✓ (01:297) | ✓ (12:110) | ✓ | OK |
| `experiments` | ✓ (01:298) | ✓ (12:111) | ✓ | OK |
| `documents` | ✓ (12:132) | ✓ (12:133) | ✓ | OK |
| `document_chunks` | ✓ (12:147) | ✓ (12:148) | ✓ | OK |
| `compounds` | ✓ (12:163) | ✓ (12:164) | ✓ | OK |
| `reactions` | ✓ (12:177) | ✓ (12:178) | ✓ | OK |
| `feedback_events` | ✓ (12:205) | ✓ (12:206) | ✓ | OK |
| `corrections` | ✓ (12:213) | ✓ (12:214) | ✓ | OK |
| `notifications` | ✓ (12:221) | ✓ (12:222) | ✓ | OK |
| `prompt_registry` | ✓ (12:231) | ✓ (12:232) | ✓ | OK |
| `paperclip_state` | ✓ (09:36) | ✓ (09:37 + 16:54) | ✓ | OK |
| `agent_sessions` | ✓ (13:76) | ✓ (13:77) | ✓ | OK |
| `agent_todos` | ✓ (13:84) | ✓ (13:85) | ✓ (via session join) | OK |
| `agent_plans` | ✓ (14:104) | ✓ (14:105) | ✓ (via session join) | OK |
| `skill_library` | ✓ (06:40) | ✓ (16:63) | ✓ | NO DELETE policy |
| `hypotheses` | ✓ (03:46) | ✓ (16:63) | ✓ | OK (DELETE added by 16:122) |
| `hypothesis_citations` | ✓ (03:47) | ✓ (16:63) | ✓ (via parent) | OK |
| `research_reports` | ✓ | ✓ (16:54) | ✓ | OK |
| `shadow_run_scores` | ✓ | ✓ (16:54) | ✓ (tightened from USING(true)) | OK |
| `skill_promotion_events` | ✓ | ✓ (16:54) | ✓ (tightened) | OK |

### USING(true) policies — confirmed fixed

`16_db_audit_fixes.sql:148-165` drops and recreates `shadow_run_scores_read` and `skill_promotion_events_read` to replace legacy `USING(true)` with auth-gated checks. Closed.

### Residual issues

**`skill_library` has no DELETE policy.** Add explicitly or document service-only-delete intent:
```sql
CREATE POLICY skill_library_owner_delete ON skill_library FOR DELETE
  USING (proposed_by_user_entra_id = current_setting('app.current_user_entra_id', true));
```

**`with-user-context.ts:12` stale comment** — claims empty-string is permissive; `12_security_hardening.sql` invalidated this. Update to: "System workers connect as `chemclaw_service` (BYPASSRLS) and never set `app.current_user_entra_id`. Use `withSystemContext` with the `__system__` sentinel for catalog reads."

**No RLS on `ingestion_events`/`projection_acks`/`tools`/`mcp_tools`** — correct (system-only or global catalog tables).

---

## 7. Idempotency Invariant

### Per-projector audit

**`reaction_vectorizer`**: SELECT filters `drfp_vector IS NULL`; UPDATE on scalar column. **OK.**

**`kg_experiments`**: All writes via `kg.write_fact(...)` using `MERGE (s)-[r:{pred} {{ fact_id: $fact_id }}]->(o) ON CREATE SET ...`. Fact IDs deterministic via `uuid.uuid5`. **OK.**

**`kg_hypotheses`**:
- `MERGE (n:Hypothesis {fact_id: $fact_id}) ON CREATE SET ...` — OK
- `MERGE (h)-[r:CITES {fact_id: $edge_id}]->(f) ON CREATE SET ...` — OK
- **`_handle_status_changed` line 148: `SET h.valid_to = datetime()` — NOT IDEMPOTENT.** Re-running advances the timestamp.

Fix:
```cypher
SET h.valid_to = CASE WHEN h.valid_to IS NULL THEN datetime() ELSE h.valid_to END
```

**`chunk_embedder`**: SELECT filters `embedding IS NULL`. **OK.**

**`contextual_chunker`**: UPDATE has explicit `AND contextual_prefix IS NULL` in WHERE. **OK.**

**`kg_source_cache`**: deterministic fact IDs via `uuid5`. **OK.**

**`base.py` ack INSERT**: `ON CONFLICT DO NOTHING` (line 322). **OK.**

### Summary
One non-idempotent path: `kg_hypotheses._handle_status_changed:148`. Severity LOW (functionally harmless; second run shifts `valid_to` slightly).

---

## 8. Migration Story Alternatives

### Current pattern: ordered idempotent files

**Pros:** zero tooling deps; replay safe (all guarded); projector replay (`DELETE FROM projection_acks WHERE projector_name='X'`) works without migration tracking; smoke script tests full loop; no migration state to corrupt.

**Cons:** no migration graph; `make db.init` single-file bug (Section 1) reveals dev-discipline dependency; long files accumulate (16 is 481 lines); no rollback story.

### Alembic
**Pros:** rollback; graph; autogenerate from model diff (with SQLAlchemy).
**Cons:** chemclaw uses raw psycopg3, not SQLAlchemy — adds two layers; one-way migration model is incompatible with projector-replay philosophy; new shared state (`alembic_version`) that can desync.

### Sqitch
**Pros:** language-agnostic SQL; tracks state; verify scripts.
**Cons:** Perl binary dep; `sqitch` CLI in CI; verify scripts add maintenance; deploy-once model conflicts with idempotent-replay.

### Recommendation: keep current pattern, fix Makefile

The idempotent-files approach fits ChemClaw's projector-replay invariant. Add a tiny visibility layer:

```sql
-- db/init/00_schema_version.sql (new, applied first)
CREATE TABLE IF NOT EXISTS schema_version (
  filename    TEXT PRIMARY KEY,
  applied_at  TIMESTAMPTZ NOT NULL DEFAULT NOW()
);
```

Then in the fixed Makefile loop, also INSERT into `schema_version` per file.

---

## Critical Findings Summary

| # | Severity | Finding | File:Line | Fix |
|---|---|---|---|---|
| 1 | HIGH | `make db.init` applies only `01_schema.sql`, silently skipping all subsequent init files | `Makefile:87` | Replace with for-loop over `db/init/*.sql` |
| 2 | HIGH | `user_project_access` has no composite index `(user_entra_id, nce_project_id)` — every RLS EXISTS subquery does seq scan | missing | `CREATE INDEX` in PR-8 |
| 3 | HIGH | `synthetic_steps.nce_project_id` FK has no index — every `experiments` RLS join is unindexed | missing | `CREATE INDEX idx_synthetic_steps_project` |
| 4 | MEDIUM | `kg_hypotheses._handle_status_changed` sets `valid_to = datetime()` without idempotency guard | `services/projectors/kg_hypotheses/main.py:148` | `CASE WHEN valid_to IS NULL THEN datetime() ELSE valid_to END` |
| 5 | MEDIUM | `with-user-context.ts:12` stale comment about empty-string permissive RLS | `services/agent-claw/src/db/with-user-context.ts:12` | Update doc |
| 6 | MEDIUM | Confidence model 3-way fragmentation (reactions tier-only, hypotheses score+3-tier, KG both 5-tier) | `01_schema.sql:123`, `03_hypotheses.sql:13` | Unify to NUMERIC(4,3) score + 5-value generated tier |
| 7 | MEDIUM | `reactions`, `hypotheses`, `artifacts` lack temporal columns despite KG bi-temporal projection | `01_schema.sql:114`, `03_hypotheses.sql:7` | Add `valid_from`/`valid_to` per Section 2 |
| 8 | LOW | `skill_library`, `forged_tool_tests` lack `maturity` column | `06_skill_library.sql:7` | Add via PR-8 |
| 9 | LOW | `contextual_prefix`, `page_number`, `original_uri` columns inferred from unresolved init files | `services/projectors/contextual_chunker/main.py:109,163,166` | Audit init files 04–07, 10–11 |
| 10 | LOW | `skill_library` has no DELETE RLS policy | `16_db_audit_fixes.sql:63` | Add policy or document service-only intent |

---

*End of Track C Data Layer Audit — 2026-04-29*
