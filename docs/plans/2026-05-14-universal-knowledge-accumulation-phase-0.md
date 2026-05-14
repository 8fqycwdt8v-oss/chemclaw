# Universal Knowledge Accumulation — Phase 0 Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Spec:** [`docs/plans/2026-05-14-universal-knowledge-accumulation.md`](2026-05-14-universal-knowledge-accumulation.md) (commit `2dfbb3f`).

**Goal:** Land the foundational schema, registry, feature flags, and a *gated, default-off* universal post-tool extraction hook + empty `tool_result_extractor` projector. After Phase 0 the loop is wired end-to-end but emits **zero** facts (no extractors registered yet).

**Architecture:** Six new SQL migrations (`62_…` through `67_…`), one feature flag, ~12 `config_settings` rows, one new TypeScript hook + YAML, one new Python projector with the same Dockerfile / compose / helm shape as existing projectors, and two new agent builtins (`promote_to_kg`, `request_investigation`). Nothing changes behavior until Phase 1 lands the first extractor and `kg.auto_extraction.enabled` is flipped on per-project.

**Tech stack:** Postgres 16, Python 3.12 (psycopg, FastAPI patterns shared via `services/projectors/common/`), TypeScript / Node 22 (agent-claw), Pino logging, pytest + vitest.

**Phases beyond this plan (each gets its own plan when Phase 0 lands):**

- **Phase 1** — Chemistry MCP extractors (xtb, aizynth, askcos, chemprop, applicability, yield_baseline, sirius, crest, synthegy, tabicl, ord_io, plate, chrom_method, reaction_optimizer, genchem).
- **Phase 2** — Document LLM extraction; ELN/LOGS direct extractors; external feeds (CrossRef, PubMed, USPTO, ORD).
- **Phase 3** — Investigation scorer + anomaly detector + interpreter LLM projector.
- **Phase 4** — Pattern detector + auto-hypothesis-formation + budget enforcement.
- **Phase 5** — Test planner + workflow_engine integration.
- **Phase 6** — Agent-internal conclusion extraction + meta-facts.
- **Phase 7** — Wiki anomaly/pattern/pending-hypotheses sections + contradiction page automation.

---

## File structure (this phase)

**Created:**

```
db/init/62_facts_table.sql
db/init/63_extraction_registry.sql
db/init/64_investigation_queue.sql
db/init/65_derivation_class_columns.sql
db/init/66_investigation_event_catalog.sql
db/init/67_investigation_budget_usage.sql
db/seed/09_universal_extraction_config.sql

hooks/tool-invocation-emitter.yaml
services/agent-claw/src/core/hooks/tool-invocation-emitter.ts
services/agent-claw/tests/unit/hooks/tool-invocation-emitter.test.ts

services/agent-claw/src/tools/builtins/promote_to_kg.ts
services/agent-claw/src/tools/builtins/request_investigation.ts
services/agent-claw/tests/unit/builtins/promote_to_kg.test.ts
services/agent-claw/tests/unit/builtins/request_investigation.test.ts

services/projectors/tool_result_extractor/__init__.py
services/projectors/tool_result_extractor/Dockerfile
services/projectors/tool_result_extractor/main.py
services/projectors/tool_result_extractor/requirements.txt
services/projectors/tool_result_extractor/extractor_loader.py
services/projectors/tool_result_extractor/tests/__init__.py
services/projectors/tool_result_extractor/tests/test_dispatch.py
services/projectors/tool_result_extractor/tests/test_no_op_when_disabled.py
```

**Modified:**

```
services/agent-claw/src/bootstrap/start.ts                # bump MIN_EXPECTED_HOOKS 26 → 27
services/agent-claw/src/core/hook-loader.ts                # +1 BUILTIN_REGISTRARS entry
services/agent-claw/src/tools/builtins/index.ts            # +2 builtin registrations
docker-compose.yml                                         # +1 service: tool-result-extractor
infra/helm/values.yaml                                     # +1 projector toggle
Makefile                                                   # +run.tool-result-extractor target
```

---

## Task 1: SQL migration — `facts` table

**Files:**
- Create: `db/init/62_facts_table.sql`
- Test: `tests/unit/db/test_facts_table_schema.py`

- [ ] **Step 1: Write the failing test**

```python
# tests/unit/db/test_facts_table_schema.py
import psycopg
import pytest


@pytest.fixture
def conn():
    with psycopg.connect("dbname=chemclaw_test") as c:
        yield c


def test_facts_table_exists(conn):
    with conn.cursor() as cur:
        cur.execute("SELECT to_regclass('public.facts')")
        assert cur.fetchone()[0] == "facts"


def test_facts_required_columns(conn):
    expected = {
        "id", "project_id", "subject_label", "subject_id_value",
        "predicate", "object_label", "object_id_value", "object_value",
        "unit", "polarity", "derivation_class", "confidence",
        "confidence_tier", "source_table", "source_row_id",
        "source_fact_ids", "extractor_name", "derivation_depth",
        "valid_from", "valid_to", "invalidated_by",
        "invalidation_reason", "created_at", "group_id",
    }
    with conn.cursor() as cur:
        cur.execute(
            "SELECT column_name FROM information_schema.columns "
            "WHERE table_schema='public' AND table_name='facts'"
        )
        actual = {r[0] for r in cur.fetchall()}
    missing = expected - actual
    assert not missing, f"missing columns: {missing}"


def test_facts_derivation_class_check(conn):
    with conn.cursor() as cur, pytest.raises(psycopg.errors.CheckViolation):
        cur.execute(
            "INSERT INTO facts (subject_label, subject_id_value, predicate, "
            "derivation_class, confidence, confidence_tier, extractor_name) "
            "VALUES ('Compound', 'A', 'p', 'GARBAGE', 0.5, 'low', 'test')"
        )


def test_facts_polarity_check(conn):
    with conn.cursor() as cur, pytest.raises(psycopg.errors.CheckViolation):
        cur.execute(
            "INSERT INTO facts (subject_label, subject_id_value, predicate, "
            "polarity, derivation_class, confidence, confidence_tier, "
            "extractor_name) VALUES ('Compound', 'A', 'p', 'maybe', "
            "'OBSERVED', 0.5, 'low', 'test')"
        )


def test_facts_rls_enabled(conn):
    with conn.cursor() as cur:
        cur.execute(
            "SELECT relrowsecurity, relforcerowsecurity FROM pg_class "
            "WHERE relname='facts'"
        )
        rls_enabled, rls_forced = cur.fetchone()
        assert rls_enabled is True
        assert rls_forced is True
```

- [ ] **Step 2: Run test to verify it fails**

Run: `.venv/bin/pytest tests/unit/db/test_facts_table_schema.py -v`
Expected: FAIL — relation `facts` does not exist.

- [ ] **Step 3: Write the migration**

```sql
-- db/init/62_facts_table.sql
--
-- Universal Knowledge Accumulation — Phase 0
-- Canonical, RLS-enforced fact store. Mirrors :Fact nodes in Neo4j via the
-- (future) kg_facts_sync projector. Every fact carries provenance back to
-- its source row (via source_table + source_row_id) and to its parent facts
-- (via source_fact_ids[]). Bi-temporal via valid_from / valid_to.

BEGIN;

CREATE TABLE IF NOT EXISTS facts (
  id                  UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  project_id          UUID,
  subject_label       TEXT NOT NULL,
  subject_id_value    TEXT NOT NULL,
  predicate           TEXT NOT NULL,
  object_label        TEXT,
  object_id_value     TEXT,
  object_value        JSONB,
  unit                TEXT,
  polarity            TEXT NOT NULL DEFAULT 'positive'
                      CHECK (polarity IN ('positive', 'negative', 'anomaly')),
  derivation_class    TEXT NOT NULL
                      CHECK (derivation_class IN
                             ('OBSERVED', 'COMPUTED', 'INTERPRETED',
                              'HYPOTHESIZED', 'ABSTRACTED')),
  confidence          NUMERIC(4,3) NOT NULL
                      CHECK (confidence BETWEEN 0 AND 1),
  confidence_tier     TEXT NOT NULL
                      CHECK (confidence_tier IN
                             ('foundational', 'high', 'medium', 'low',
                              'exploratory')),
  source_table        TEXT,
  source_row_id       TEXT,
  source_fact_ids     UUID[] NOT NULL DEFAULT ARRAY[]::UUID[],
  extractor_name      TEXT NOT NULL,
  derivation_depth    INT  NOT NULL DEFAULT 0
                      CHECK (derivation_depth BETWEEN 0 AND 10),
  valid_from          TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  valid_to            TIMESTAMPTZ,
  invalidated_by      UUID REFERENCES facts(id),
  invalidation_reason TEXT,
  created_at          TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  group_id            TEXT NOT NULL DEFAULT '__system__'
);

COMMENT ON TABLE facts IS
  'Canonical fact store for the universal knowledge-accumulation pipeline. '
  'Source of truth; Neo4j :Fact nodes are mirrored by kg_facts_sync. '
  'Every row is fully traceable to a source row (source_table/source_row_id) '
  'or to parent facts (source_fact_ids[]). Bi-temporal via valid_from / valid_to.';

-- Hot indexes
CREATE INDEX IF NOT EXISTS idx_facts_subject_active
  ON facts (subject_label, subject_id_value) WHERE valid_to IS NULL;
CREATE INDEX IF NOT EXISTS idx_facts_predicate_active
  ON facts (predicate) WHERE valid_to IS NULL;
CREATE INDEX IF NOT EXISTS idx_facts_class_polarity_active
  ON facts (derivation_class, polarity) WHERE valid_to IS NULL;
CREATE INDEX IF NOT EXISTS idx_facts_project_active
  ON facts (project_id) WHERE valid_to IS NULL;
CREATE INDEX IF NOT EXISTS idx_facts_source
  ON facts (source_table, source_row_id);
CREATE INDEX IF NOT EXISTS idx_facts_extractor
  ON facts (extractor_name, created_at DESC);

-- RLS: project scope visibility for chemclaw_app; chemclaw_service bypasses.
ALTER TABLE facts ENABLE ROW LEVEL SECURITY;
ALTER TABLE facts FORCE  ROW LEVEL SECURITY;

-- Lift the existing project-access pattern used by hypotheses / artifacts.
-- We use user_project_access; if it ever centralises into a SECURITY DEFINER
-- helper, drop and recreate this policy in the same migration that introduces
-- the helper.
DROP POLICY IF EXISTS facts_project_visibility ON facts;
CREATE POLICY facts_project_visibility ON facts
  FOR SELECT
  USING (
    project_id IS NULL
    OR EXISTS (
      SELECT 1 FROM user_project_access upa
      WHERE upa.project_id = facts.project_id
        AND upa.user_entra_id = current_setting('app.current_user_entra_id', true)
    )
  );

-- Writes only via chemclaw_service. No app-role insert policy.
DROP POLICY IF EXISTS facts_service_write ON facts;
CREATE POLICY facts_service_write ON facts
  FOR ALL
  TO chemclaw_service
  USING (true) WITH CHECK (true);

-- Grants
DO $$
BEGIN
  IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'chemclaw_app') THEN
    GRANT SELECT ON facts TO chemclaw_app;
  END IF;
  IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'chemclaw_service') THEN
    GRANT ALL ON facts TO chemclaw_service;
  END IF;
END $$;

INSERT INTO schema_version (filename)
VALUES ('62_facts_table.sql')
ON CONFLICT DO NOTHING;

COMMIT;
```

- [ ] **Step 4: Run migrations + test to verify it passes**

Run: `make db.init && .venv/bin/pytest tests/unit/db/test_facts_table_schema.py -v`
Expected: PASS — all 5 tests green.

- [ ] **Step 5: Commit**

```bash
git add db/init/62_facts_table.sql tests/unit/db/test_facts_table_schema.py
git commit -m "feat(db): facts canonical table (Phase 0)"
```

---

## Task 2: SQL migration — `extraction_registry` table

**Files:**
- Create: `db/init/63_extraction_registry.sql`
- Test: `tests/unit/db/test_extraction_registry_schema.py`

- [ ] **Step 1: Write the failing test**

```python
# tests/unit/db/test_extraction_registry_schema.py
import psycopg
import pytest


@pytest.fixture
def conn():
    with psycopg.connect("dbname=chemclaw_test") as c:
        yield c


def test_extraction_registry_exists(conn):
    with conn.cursor() as cur:
        cur.execute("SELECT to_regclass('public.extraction_registry')")
        assert cur.fetchone()[0] == "extraction_registry"


def test_extraction_registry_pk_is_composite(conn):
    with conn.cursor() as cur:
        cur.execute(
            "SELECT a.attname FROM pg_index i "
            "JOIN pg_attribute a ON a.attrelid = i.indrelid "
            "  AND a.attnum = ANY(i.indkey) "
            "WHERE i.indrelid = 'extraction_registry'::regclass "
            "  AND i.indisprimary ORDER BY a.attnum"
        )
        cols = [r[0] for r in cur.fetchall()]
    assert cols == ["source_kind", "source_name", "result_schema_id"]


def test_extraction_registry_enabled_default_true(conn):
    with conn.cursor() as cur:
        cur.execute(
            "INSERT INTO extraction_registry "
            "(source_kind, source_name, result_schema_id, extractor_module) "
            "VALUES ('mcp_tool', 'test.dummy', 'v1', 'noop.module') "
            "RETURNING enabled, promote_default"
        )
        enabled, promote = cur.fetchone()
    assert enabled is True
    assert promote is True
    conn.rollback()
```

- [ ] **Step 2: Run test to verify it fails**

Run: `.venv/bin/pytest tests/unit/db/test_extraction_registry_schema.py -v`
Expected: FAIL — relation `extraction_registry` does not exist.

- [ ] **Step 3: Write the migration**

```sql
-- db/init/63_extraction_registry.sql
--
-- Universal Knowledge Accumulation — Phase 0
-- Dispatch table: maps (source_kind, source_name, result_schema_id) to the
-- Python module that implements `extract(result, ctx) -> list[FactDraft]`.
-- Phase 1+ populates rows here via db/seed/. promote_default=false for
-- volume-bombing sources (genchem); the agent can still force-promote via
-- the per-call `promote_to_kg=true` flag.

BEGIN;

CREATE TABLE IF NOT EXISTS extraction_registry (
  source_kind       TEXT NOT NULL,
  source_name       TEXT NOT NULL,
  result_schema_id  TEXT NOT NULL,
  extractor_module  TEXT NOT NULL,
  enabled           BOOLEAN NOT NULL DEFAULT TRUE,
  promote_default   BOOLEAN NOT NULL DEFAULT TRUE,
  created_at        TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at        TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  PRIMARY KEY (source_kind, source_name, result_schema_id),
  CHECK (source_kind IN ('mcp_tool', 'ingestion', 'workflow', 'external'))
);

COMMENT ON TABLE extraction_registry IS
  'Dispatch table for the tool_result_extractor projector. Adding KG support '
  'for a new source = (1) write extract() in a Python module, (2) INSERT a '
  'row here. No code change in the projector itself.';

-- Global read; chemclaw_service write. No RLS — registry is metadata.
DO $$
BEGIN
  IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'chemclaw_app') THEN
    GRANT SELECT ON extraction_registry TO chemclaw_app;
  END IF;
  IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'chemclaw_service') THEN
    GRANT ALL ON extraction_registry TO chemclaw_service;
  END IF;
END $$;

INSERT INTO schema_version (filename)
VALUES ('63_extraction_registry.sql')
ON CONFLICT DO NOTHING;

COMMIT;
```

- [ ] **Step 4: Run migrations + test to verify it passes**

Run: `make db.init && .venv/bin/pytest tests/unit/db/test_extraction_registry_schema.py -v`
Expected: PASS — all 3 tests green.

- [ ] **Step 5: Commit**

```bash
git add db/init/63_extraction_registry.sql tests/unit/db/test_extraction_registry_schema.py
git commit -m "feat(db): extraction_registry dispatch table (Phase 0)"
```

---

## Task 3: SQL migration — `investigation_queue` + `investigation_budget_usage`

**Files:**
- Create: `db/init/64_investigation_queue.sql`
- Create: `db/init/67_investigation_budget_usage.sql`
- Test: `tests/unit/db/test_investigation_tables.py`

(Two migrations grouped because they're trivially related and a single test file covers both.)

- [ ] **Step 1: Write the failing test**

```python
# tests/unit/db/test_investigation_tables.py
import psycopg
import pytest


@pytest.fixture
def conn():
    with psycopg.connect("dbname=chemclaw_test") as c:
        yield c


def test_investigation_queue_exists(conn):
    with conn.cursor() as cur:
        cur.execute("SELECT to_regclass('public.investigation_queue')")
        assert cur.fetchone()[0] == "investigation_queue"


def test_investigation_queue_pending_index(conn):
    with conn.cursor() as cur:
        cur.execute(
            "SELECT indexname FROM pg_indexes "
            "WHERE tablename='investigation_queue'"
        )
        names = {r[0] for r in cur.fetchall()}
    assert "idx_investigation_queue_pending" in names


def test_investigation_budget_usage_exists(conn):
    with conn.cursor() as cur:
        cur.execute("SELECT to_regclass('public.investigation_budget_usage')")
        assert cur.fetchone()[0] == "investigation_budget_usage"


def test_investigation_budget_usage_pk(conn):
    with conn.cursor() as cur:
        cur.execute(
            "SELECT a.attname FROM pg_index i "
            "JOIN pg_attribute a ON a.attrelid = i.indrelid "
            "  AND a.attnum = ANY(i.indkey) "
            "WHERE i.indrelid = 'investigation_budget_usage'::regclass "
            "  AND i.indisprimary ORDER BY a.attnum"
        )
        cols = [r[0] for r in cur.fetchall()]
    assert cols == ["scope", "scope_id", "date_utc"]
```

- [ ] **Step 2: Run test to verify it fails**

Run: `.venv/bin/pytest tests/unit/db/test_investigation_tables.py -v`
Expected: FAIL — relations do not exist.

- [ ] **Step 3: Write the migrations**

```sql
-- db/init/64_investigation_queue.sql
BEGIN;

CREATE TABLE IF NOT EXISTS investigation_queue (
  id            UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  fact_id       UUID NOT NULL REFERENCES facts(id),
  project_id    UUID,
  score         NUMERIC(4,3) NOT NULL CHECK (score BETWEEN 0 AND 1),
  reason_codes  TEXT[] NOT NULL,
  queued_at     TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  picked_at     TIMESTAMPTZ,
  completed_at  TIMESTAMPTZ,
  outcome       TEXT
                CHECK (outcome IS NULL OR outcome IN
                       ('interpreted', 'no_action', 'budget_exhausted',
                        'extractor_error'))
);

COMMENT ON TABLE investigation_queue IS
  'Scored deferred work for the investigation_scorer/interpreter chain. '
  'High-score facts (>= investigation.score_threshold_sync) bypass the '
  'queue; low-score facts land here for the periodic sweep.';

CREATE INDEX IF NOT EXISTS idx_investigation_queue_pending
  ON investigation_queue (score DESC) WHERE picked_at IS NULL;

DO $$
BEGIN
  IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'chemclaw_app') THEN
    GRANT SELECT ON investigation_queue TO chemclaw_app;
  END IF;
  IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'chemclaw_service') THEN
    GRANT ALL ON investigation_queue TO chemclaw_service;
  END IF;
END $$;

INSERT INTO schema_version (filename)
VALUES ('64_investigation_queue.sql')
ON CONFLICT DO NOTHING;

COMMIT;
```

```sql
-- db/init/67_investigation_budget_usage.sql
BEGIN;

CREATE TABLE IF NOT EXISTS investigation_budget_usage (
  scope               TEXT NOT NULL CHECK (scope IN
                        ('global', 'org', 'project', 'user')),
  scope_id            TEXT NOT NULL,
  date_utc            DATE NOT NULL,
  llm_usd_spent       NUMERIC(8,3) NOT NULL DEFAULT 0,
  cpu_hours_spent     NUMERIC(8,3) NOT NULL DEFAULT 0,
  facts_extracted     INT NOT NULL DEFAULT 0,
  hypotheses_proposed INT NOT NULL DEFAULT 0,
  PRIMARY KEY (scope, scope_id, date_utc)
);

COMMENT ON TABLE investigation_budget_usage IS
  'Daily-window budget consumption for the investigation loop. '
  'Resolution mirrors config_settings (user/project/org/global). '
  'Phase 4 enforces the budgets; this table is populated from Phase 0.';

DO $$
BEGIN
  IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'chemclaw_service') THEN
    GRANT ALL ON investigation_budget_usage TO chemclaw_service;
  END IF;
END $$;

INSERT INTO schema_version (filename)
VALUES ('67_investigation_budget_usage.sql')
ON CONFLICT DO NOTHING;

COMMIT;
```

- [ ] **Step 4: Run migrations + test to verify it passes**

Run: `make db.init && .venv/bin/pytest tests/unit/db/test_investigation_tables.py -v`
Expected: PASS — all 4 tests green.

- [ ] **Step 5: Commit**

```bash
git add db/init/64_investigation_queue.sql db/init/67_investigation_budget_usage.sql \
        tests/unit/db/test_investigation_tables.py
git commit -m "feat(db): investigation_queue + budget_usage tables (Phase 0)"
```

---

## Task 4: SQL migration — `derivation_class` columns on existing tables

**Files:**
- Create: `db/init/65_derivation_class_columns.sql`
- Test: `tests/unit/db/test_derivation_class_columns.py`

- [ ] **Step 1: Write the failing test**

```python
# tests/unit/db/test_derivation_class_columns.py
import psycopg
import pytest


@pytest.fixture
def conn():
    with psycopg.connect("dbname=chemclaw_test") as c:
        yield c


TARGET_TABLES = ["reactions", "hypotheses", "artifacts", "compute_results"]


def test_derivation_class_column_present(conn):
    for table in TARGET_TABLES:
        with conn.cursor() as cur:
            cur.execute(
                "SELECT column_name FROM information_schema.columns "
                "WHERE table_schema='public' AND table_name=%s "
                "  AND column_name='derivation_class'",
                (table,),
            )
            assert cur.fetchone() is not None, f"{table}.derivation_class missing"


def test_hypotheses_confirmed_by_present(conn):
    with conn.cursor() as cur:
        cur.execute(
            "SELECT column_name FROM information_schema.columns "
            "WHERE table_schema='public' AND table_name='hypotheses' "
            "  AND column_name='confirmed_by'"
        )
        assert cur.fetchone() is not None
```

- [ ] **Step 2: Run test to verify it fails**

Run: `.venv/bin/pytest tests/unit/db/test_derivation_class_columns.py -v`
Expected: FAIL — columns do not exist.

- [ ] **Step 3: Write the migration**

```sql
-- db/init/65_derivation_class_columns.sql
--
-- Adds derivation_class to existing fact-bearing tables so they participate
-- in the new capability model. CHECK constraints are deferred (NOT VALID) so
-- historical rows don't block the migration; new rows are validated.

BEGIN;

ALTER TABLE reactions
  ADD COLUMN IF NOT EXISTS derivation_class TEXT;

ALTER TABLE reactions
  DROP CONSTRAINT IF EXISTS reactions_derivation_class_chk;
ALTER TABLE reactions
  ADD CONSTRAINT reactions_derivation_class_chk
  CHECK (derivation_class IS NULL OR derivation_class IN
         ('OBSERVED', 'COMPUTED', 'INTERPRETED', 'HYPOTHESIZED', 'ABSTRACTED'))
  NOT VALID;

ALTER TABLE hypotheses
  ADD COLUMN IF NOT EXISTS derivation_class TEXT;
ALTER TABLE hypotheses
  ADD COLUMN IF NOT EXISTS confirmed_by UUID REFERENCES facts(id);

ALTER TABLE hypotheses
  DROP CONSTRAINT IF EXISTS hypotheses_derivation_class_chk;
ALTER TABLE hypotheses
  ADD CONSTRAINT hypotheses_derivation_class_chk
  CHECK (derivation_class IS NULL OR derivation_class IN
         ('OBSERVED', 'COMPUTED', 'INTERPRETED', 'HYPOTHESIZED', 'ABSTRACTED'))
  NOT VALID;

ALTER TABLE artifacts
  ADD COLUMN IF NOT EXISTS derivation_class TEXT;
ALTER TABLE artifacts
  DROP CONSTRAINT IF EXISTS artifacts_derivation_class_chk;
ALTER TABLE artifacts
  ADD CONSTRAINT artifacts_derivation_class_chk
  CHECK (derivation_class IS NULL OR derivation_class IN
         ('OBSERVED', 'COMPUTED', 'INTERPRETED', 'HYPOTHESIZED', 'ABSTRACTED'))
  NOT VALID;

-- compute_results was added in 56_compute_results.sql
ALTER TABLE compute_results
  ADD COLUMN IF NOT EXISTS derivation_class TEXT;
ALTER TABLE compute_results
  DROP CONSTRAINT IF EXISTS compute_results_derivation_class_chk;
ALTER TABLE compute_results
  ADD CONSTRAINT compute_results_derivation_class_chk
  CHECK (derivation_class IS NULL OR derivation_class IN
         ('OBSERVED', 'COMPUTED', 'INTERPRETED', 'HYPOTHESIZED', 'ABSTRACTED'))
  NOT VALID;

INSERT INTO schema_version (filename)
VALUES ('65_derivation_class_columns.sql')
ON CONFLICT DO NOTHING;

COMMIT;
```

- [ ] **Step 4: Run migrations + test to verify it passes**

Run: `make db.init && .venv/bin/pytest tests/unit/db/test_derivation_class_columns.py -v`
Expected: PASS — both tests green.

- [ ] **Step 5: Commit**

```bash
git add db/init/65_derivation_class_columns.sql tests/unit/db/test_derivation_class_columns.py
git commit -m "feat(db): derivation_class columns on existing fact tables (Phase 0)"
```

---

## Task 5: SQL migration — ingestion event catalog rows

**Files:**
- Create: `db/init/66_investigation_event_catalog.sql`
- Test: `tests/unit/db/test_investigation_event_catalog.py`

- [ ] **Step 1: Write the failing test**

```python
# tests/unit/db/test_investigation_event_catalog.py
import psycopg
import pytest


REQUIRED_EVENTS = [
    "tool_invocation_complete",
    "extracted_fact",
    "anomaly_observed",
    "pattern_detected",
    "interpretation_proposed",
    "investigation_requested",
    "test_planned",
    "external_data_fetched",
]


@pytest.fixture
def conn():
    with psycopg.connect("dbname=chemclaw_test") as c:
        yield c


def test_all_new_events_cataloged(conn):
    with conn.cursor() as cur:
        cur.execute("SELECT event_type FROM ingestion_event_catalog")
        cataloged = {r[0] for r in cur.fetchall()}
    missing = set(REQUIRED_EVENTS) - cataloged
    assert not missing, f"missing event_types: {missing}"
```

- [ ] **Step 2: Run test to verify it fails**

Run: `.venv/bin/pytest tests/unit/db/test_investigation_event_catalog.py -v`
Expected: FAIL — events not in catalog.

- [ ] **Step 3: Write the migration**

```sql
-- db/init/66_investigation_event_catalog.sql
--
-- Registers the new ingestion event types for the universal knowledge
-- accumulation pipeline. ingestion_event_catalog is documentation only
-- (no FK / CHECK on event_type), but it's the canonical vocabulary list
-- and is referenced from code reviews and the design spec.

BEGIN;

INSERT INTO ingestion_event_catalog (event_type, description, emitted_by, consumed_by) VALUES
  ('tool_invocation_complete',
   'Universal post-tool hook fires once per MCP / builtin call (success or '
   'failure). Payload carries tool_name + redacted args/result + result_schema_id '
   'for extractor dispatch. Failures emit with ok=false.',
   'services/agent-claw/src/core/hooks/tool-invocation-emitter.ts',
   ARRAY['tool_result_extractor']),
  ('extracted_fact',
   'A new row landed in the canonical facts table. Carries the fact_id in '
   'the payload. Downstream projectors load context from facts directly.',
   'services/projectors/tool_result_extractor/main.py and every per-source extractor',
   ARRAY['investigation_scorer', 'kg_facts_sync', 'wiki_pages']),
  ('anomaly_observed',
   'investigation_scorer detected an anomalous fact (z-score over threshold). '
   'Always routed to interpreter regardless of base score.',
   'services/projectors/investigation_scorer/main.py (Phase 3)',
   ARRAY['interpreter', 'hypothesis_former']),
  ('pattern_detected',
   'pattern_detector cron daemon clustered facts across entities and surfaced '
   'a significant cluster. Payload carries the cluster summary.',
   'services/optimizer/pattern_detector/main.py (Phase 4)',
   ARRAY['interpreter', 'hypothesis_former', 'wiki_regen']),
  ('interpretation_proposed',
   'LLM interpreter emitted a derived claim from a source fact + KG context. '
   'Class is always INTERPRETED.',
   'services/projectors/interpreter/main.py (Phase 3)',
   ARRAY['investigation_scorer', 'wiki_regen']),
  ('investigation_requested',
   'investigation_scorer flagged a fact for sync interpretation (score >= '
   'investigation.score_threshold_sync). The interpreter consumes this directly '
   'rather than polling the queue.',
   'services/projectors/investigation_scorer/main.py (Phase 3)',
   ARRAY['interpreter']),
  ('test_planned',
   'test_planner identified a discriminating test for an active hypothesis. '
   'Payload carries either a task_queue enqueue, a workflow_runs row, or a '
   'synthesis-campaign step proposal.',
   'services/projectors/test_planner/main.py (Phase 5)',
   ARRAY['workflow_engine', 'queue']),
  ('external_data_fetched',
   'An external feed (CrossRef, PubMed, USPTO, ORD) fetched a new record. '
   'Routes through doc_ingester or the per-feed direct extractor.',
   'services/optimizer/external_feeds/* (Phase 2)',
   ARRAY['doc_ingester', 'crossref_extractor', 'pubmed_extractor',
         'uspto_extractor', 'ord_extractor'])
ON CONFLICT (event_type) DO UPDATE SET
  description = EXCLUDED.description,
  emitted_by  = EXCLUDED.emitted_by,
  consumed_by = EXCLUDED.consumed_by;

INSERT INTO schema_version (filename)
VALUES ('66_investigation_event_catalog.sql')
ON CONFLICT DO NOTHING;

COMMIT;
```

- [ ] **Step 4: Run migrations + test to verify it passes**

Run: `make db.init && .venv/bin/pytest tests/unit/db/test_investigation_event_catalog.py -v`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add db/init/66_investigation_event_catalog.sql tests/unit/db/test_investigation_event_catalog.py
git commit -m "feat(db): investigation event_type catalog (Phase 0)"
```

---

## Task 6: Seed — feature flag + config_settings + prompt_registry

**Files:**
- Create: `db/seed/09_universal_extraction_config.sql`
- Test: `tests/unit/db/test_universal_extraction_seed.py`

- [ ] **Step 1: Write the failing test**

```python
# tests/unit/db/test_universal_extraction_seed.py
import psycopg
import pytest


REQUIRED_CONFIG_KEYS = [
    "kg.auto_extraction.enabled",
    "kg.extractor_reliability.computed",
    "kg.extractor_reliability.interpreted",
    "kg.extractor_reliability.hypothesized",
    "kg.extractor_reliability.abstracted",
    "investigation.score_threshold_sync",
    "investigation.score_anomaly_weight",
    "investigation.score_novelty_weight",
    "investigation.score_priority_weight",
    "investigation.sweep_interval_minutes",
    "investigation.pattern_sweep_interval_hours",
    "investigation.max_active_hypotheses_per_project",
    "investigation.daily_llm_budget_usd",
    "investigation.daily_cpu_hours_budget",
    "investigation.max_derivation_depth",
]


@pytest.fixture
def conn():
    with psycopg.connect("dbname=chemclaw_test") as c:
        yield c


def test_feature_flag_seeded_off_by_default(conn):
    with conn.cursor() as cur:
        cur.execute(
            "SELECT enabled_default FROM feature_flags "
            "WHERE flag_key='kg.auto_extraction.enabled'"
        )
        row = cur.fetchone()
    assert row is not None
    assert row[0] is False, "feature flag must default to OFF in Phase 0"


def test_all_config_keys_seeded(conn):
    with conn.cursor() as cur:
        cur.execute(
            "SELECT key FROM config_settings WHERE scope='global'"
        )
        actual = {r[0] for r in cur.fetchall()}
    missing = set(REQUIRED_CONFIG_KEYS) - actual
    assert not missing, f"missing config keys: {missing}"


def test_reliability_factors_sane(conn):
    with conn.cursor() as cur:
        cur.execute(
            "SELECT key, value FROM config_settings "
            "WHERE scope='global' AND key LIKE 'kg.extractor_reliability.%'"
        )
        vals = {k: float(v) for k, v in cur.fetchall()}
    assert vals["kg.extractor_reliability.computed"] == 0.95
    assert vals["kg.extractor_reliability.interpreted"] == 0.75
    assert vals["kg.extractor_reliability.hypothesized"] == 0.60
    assert vals["kg.extractor_reliability.abstracted"] == 0.50
    # Strict monotonic decay required by the design spec §3.2.
    assert (vals["kg.extractor_reliability.computed"] >
            vals["kg.extractor_reliability.interpreted"] >
            vals["kg.extractor_reliability.hypothesized"] >
            vals["kg.extractor_reliability.abstracted"])
```

- [ ] **Step 2: Run test to verify it fails**

Run: `.venv/bin/pytest tests/unit/db/test_universal_extraction_seed.py -v`
Expected: FAIL — feature flag / config rows not present.

- [ ] **Step 3: Write the seed**

```sql
-- db/seed/09_universal_extraction_config.sql
--
-- Universal Knowledge Accumulation — Phase 0 seeds.
-- Feature flag is OFF by default; flip per-project via the admin endpoint.

BEGIN;

-- Feature flag (off by default)
INSERT INTO feature_flags (flag_key, description, enabled_default, env_var_fallback)
VALUES (
  'kg.auto_extraction.enabled',
  'Master switch for the universal knowledge-accumulation pipeline. '
  'When OFF the tool-invocation-emitter hook short-circuits and emits no events. '
  'Default OFF in Phase 0 — flip per project as extractors land in Phase 1+.',
  FALSE,
  'KG_AUTO_EXTRACTION_ENABLED'
)
ON CONFLICT (flag_key) DO UPDATE SET
  description      = EXCLUDED.description,
  enabled_default  = EXCLUDED.enabled_default,
  env_var_fallback = EXCLUDED.env_var_fallback;

-- Config knobs (global defaults; resolution chain user → project → org → global).
INSERT INTO config_settings (scope, scope_id, key, value, description) VALUES
  ('global', '__global__', 'kg.extractor_reliability.computed',     '0.95',
   'Multiplicative decay factor for COMPUTED derivation_class facts.'),
  ('global', '__global__', 'kg.extractor_reliability.interpreted',  '0.75',
   'Multiplicative decay factor for INTERPRETED derivation_class facts.'),
  ('global', '__global__', 'kg.extractor_reliability.hypothesized', '0.60',
   'Multiplicative decay factor for HYPOTHESIZED derivation_class facts.'),
  ('global', '__global__', 'kg.extractor_reliability.abstracted',   '0.50',
   'Multiplicative decay factor for ABSTRACTED derivation_class facts.'),
  ('global', '__global__', 'investigation.score_threshold_sync',         '0.70',
   'Facts with investigation score >= this threshold trigger sync interpretation.'),
  ('global', '__global__', 'investigation.score_anomaly_weight',         '0.45',
   'Weight of anomaly_score in the composite investigation score.'),
  ('global', '__global__', 'investigation.score_novelty_weight',         '0.35',
   'Weight of novelty_score in the composite investigation score.'),
  ('global', '__global__', 'investigation.score_priority_weight',        '0.20',
   'Weight of project priority in the composite investigation score.'),
  ('global', '__global__', 'investigation.sweep_interval_minutes',       '15',
   'How often the investigation_queue sweep runs (Phase 3).'),
  ('global', '__global__', 'investigation.pattern_sweep_interval_hours', '24',
   'How often the pattern_detector cron daemon runs (Phase 4).'),
  ('global', '__global__', 'investigation.max_active_hypotheses_per_project', '12',
   'Cap on concurrent HYPOTHESIZED facts per project to bound LLM cost.'),
  ('global', '__global__', 'investigation.daily_llm_budget_usd',          '50',
   'Daily LLM-spend cap for the investigation loop, per scope.'),
  ('global', '__global__', 'investigation.daily_cpu_hours_budget',        '100',
   'Daily compute-hours cap for the test planner / external feeds, per scope.'),
  ('global', '__global__', 'investigation.max_derivation_depth',          '4',
   'Hard cap on derivation_depth; beyond this facts land as ABSTRACTED.')
ON CONFLICT (scope, scope_id, key) DO UPDATE SET
  value       = EXCLUDED.value,
  description = EXCLUDED.description;

-- Prompt registry stubs (full prompts seeded by Phase 3+, but the rows
-- are reserved here so the schema is stable).
INSERT INTO prompt_registry (mode, prompt_text, version, active) VALUES
  ('kg.fact_interpretation',
   '-- placeholder; populated in Phase 3 with the full interpretation prompt',
   1, FALSE),
  ('kg.hypothesis_formation',
   '-- placeholder; populated in Phase 4',
   1, FALSE),
  ('kg.test_planning',
   '-- placeholder; populated in Phase 5',
   1, FALSE),
  ('kg.pattern_summary',
   '-- placeholder; populated in Phase 4',
   1, FALSE)
ON CONFLICT (mode, version) DO UPDATE SET
  prompt_text = EXCLUDED.prompt_text,
  active      = EXCLUDED.active;

COMMIT;
```

- [ ] **Step 4: Run migrations + test to verify it passes**

Run: `make db.seed && .venv/bin/pytest tests/unit/db/test_universal_extraction_seed.py -v`
Expected: PASS — all 3 tests green.

- [ ] **Step 5: Commit**

```bash
git add db/seed/09_universal_extraction_config.sql \
        tests/unit/db/test_universal_extraction_seed.py
git commit -m "feat(db): seed feature flag + config + prompt stubs (Phase 0)"
```

---

## Task 7: Universal post-tool hook — TypeScript implementation

**Files:**
- Create: `services/agent-claw/src/core/hooks/tool-invocation-emitter.ts`
- Create: `hooks/tool-invocation-emitter.yaml`
- Test: `services/agent-claw/tests/unit/hooks/tool-invocation-emitter.test.ts`

- [ ] **Step 1: Write the failing test**

```typescript
// services/agent-claw/tests/unit/hooks/tool-invocation-emitter.test.ts
import { describe, it, expect, beforeEach, vi } from "vitest";
import type { Pool } from "pg";
import { Lifecycle } from "../../../src/core/lifecycle.js";
import { registerToolInvocationEmitterHook } from "../../../src/core/hooks/tool-invocation-emitter.js";

function makePool(): Pool {
  return {
    query: vi.fn(async () => ({ rows: [], rowCount: 0 })),
  } as unknown as Pool;
}

const baseInput = {
  tool: { name: "mcp-xtb.compute_barrier", is_internal: false, result_schema_id: "v1" },
  ctx: { user: "user-1", project: "proj-1" },
  invocation_id: "inv-1",
  redacted_args: { smiles: "[redacted]" },
  redacted_result: { barrier_kj_mol: 92.3 },
  duration_ms: 1234,
  ok: true,
  error: null,
};

describe("tool-invocation-emitter hook", () => {
  let pool: Pool;
  let lifecycle: Lifecycle;
  let isFeatureEnabled: ReturnType<typeof vi.fn>;

  beforeEach(() => {
    pool = makePool();
    lifecycle = new Lifecycle();
    isFeatureEnabled = vi.fn(async () => true);
    registerToolInvocationEmitterHook(lifecycle, { pool, isFeatureEnabled });
  });

  it("emits tool_invocation_complete on post_tool when flag is enabled", async () => {
    await lifecycle.dispatch("post_tool", baseInput);
    expect(pool.query).toHaveBeenCalledOnce();
    const sql = (pool.query as any).mock.calls[0][0] as string;
    const args = (pool.query as any).mock.calls[0][1] as unknown[];
    expect(sql).toContain("INSERT INTO ingestion_events");
    expect(args).toContain("mcp-xtb.compute_barrier");
    expect(args).toContain("user-1");
  });

  it("short-circuits when feature flag is disabled", async () => {
    isFeatureEnabled.mockResolvedValueOnce(false);
    await lifecycle.dispatch("post_tool", baseInput);
    expect(pool.query).not.toHaveBeenCalled();
  });

  it("skips internal tools (manage_todos, ask_user, etc.)", async () => {
    await lifecycle.dispatch("post_tool", {
      ...baseInput,
      tool: { ...baseInput.tool, is_internal: true },
    });
    expect(pool.query).not.toHaveBeenCalled();
  });

  it("emits with ok=false on post_tool_failure", async () => {
    await lifecycle.dispatch("post_tool_failure", {
      ...baseInput,
      ok: false,
      error: "SCF did not converge",
      redacted_result: null,
    });
    expect(pool.query).toHaveBeenCalledOnce();
    const args = (pool.query as any).mock.calls[0][1] as unknown[];
    expect(args).toContain(false);
    expect(args).toContain("SCF did not converge");
  });

  it("never logs raw args/result (defense-in-depth — must be pre-redacted)", async () => {
    // The hook contract is that callers MUST pass already-redacted payloads.
    // We don't re-redact here, but we assert the hook reads from the
    // redacted_* fields, not any potential raw_args/raw_result.
    const inputWithRaw: any = {
      ...baseInput,
      raw_args: { secret_smiles: "REAL_SECRET" },
    };
    await lifecycle.dispatch("post_tool", inputWithRaw);
    const args = (pool.query as any).mock.calls[0][1] as unknown[];
    const argsJson = JSON.stringify(args);
    expect(argsJson).not.toContain("REAL_SECRET");
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `cd services/agent-claw && npm test -- tests/unit/hooks/tool-invocation-emitter.test.ts`
Expected: FAIL — module not found.

- [ ] **Step 3: Write the hook**

```typescript
// services/agent-claw/src/core/hooks/tool-invocation-emitter.ts
//
// Phase 0 — Universal post-tool extraction surface.
//
// Fires on every tool call (success or failure) when the feature flag
// `kg.auto_extraction.enabled` is on. Emits ONE `tool_invocation_complete`
// ingestion event per call, carrying the redacted args + redacted result +
// metadata (tool name, duration, ok flag, error string). The
// `tool_result_extractor` projector consumes these events and dispatches
// to the per-source extractor module declared in `extraction_registry`.
//
// Defense-in-depth: the hook reads only from `redacted_args` / `redacted_result`,
// never from any raw_* field. Callers MUST pre-redact via the existing
// agent-claw redaction stack before invoking lifecycle.dispatch.

import type { Pool } from "pg";
import type { Lifecycle } from "../lifecycle.js";
import { getLogger } from "../../observability/logger.js";

interface ToolInvocationContext {
  user: string;
  project: string | null;
}

interface ToolInvocationInput {
  tool: { name: string; is_internal?: boolean; result_schema_id?: string };
  ctx: ToolInvocationContext;
  invocation_id: string;
  redacted_args: unknown;
  redacted_result: unknown;
  duration_ms: number;
  ok: boolean;
  error: string | null;
}

interface Deps {
  pool: Pool;
  isFeatureEnabled: (
    key: string,
    ctx: { user: string; project: string | null }
  ) => Promise<boolean>;
}

export function registerToolInvocationEmitterHook(
  lifecycle: Lifecycle,
  deps: Deps
): void {
  const log = getLogger("tool-invocation-emitter");

  async function handle(input: ToolInvocationInput): Promise<Record<string, never>> {
    try {
      if (input.tool.is_internal) return {};
      const enabled = await deps.isFeatureEnabled(
        "kg.auto_extraction.enabled",
        input.ctx
      );
      if (!enabled) return {};

      await deps.pool.query(
        `INSERT INTO ingestion_events (event_type, source_table, source_row_id, payload)
         VALUES ('tool_invocation_complete', 'tool_invocations', $1,
                 jsonb_build_object(
                   'tool_name', $2::text,
                   'user_entra_id', $3::text,
                   'project_id', $4::uuid,
                   'args', $5::jsonb,
                   'result', $6::jsonb,
                   'result_schema_id', $7::text,
                   'duration_ms', $8::int,
                   'ok', $9::boolean,
                   'error', $10::text
                 ))`,
        [
          input.invocation_id,
          input.tool.name,
          input.ctx.user,
          input.ctx.project,
          JSON.stringify(input.redacted_args ?? null),
          JSON.stringify(input.redacted_result ?? null),
          input.tool.result_schema_id ?? null,
          input.duration_ms,
          input.ok,
          input.error,
        ]
      );
    } catch (err) {
      // Hook must never fail the agent turn.
      log.warn({ err, tool: input.tool.name }, "tool-invocation-emitter failed");
    }
    return {};
  }

  lifecycle.on("post_tool", async (input, _toolUseId, _opts) =>
    handle(input as ToolInvocationInput)
  );
  lifecycle.on("post_tool_failure", async (input, _toolUseId, _opts) =>
    handle(input as ToolInvocationInput)
  );
}
```

- [ ] **Step 4: Write the YAML**

```yaml
# hooks/tool-invocation-emitter.yaml
name: tool-invocation-emitter
lifecycle:
  - post_tool
  - post_tool_failure
enabled: true
order: 80
definition: |
  Universal post-tool extraction surface. Emits one `tool_invocation_complete`
  ingestion event per non-internal tool call when the feature flag
  `kg.auto_extraction.enabled` resolves to true for the current
  (user, project) context. Source of truth: services/agent-claw/src/core/hooks/tool-invocation-emitter.ts
condition:
  setting_key: kg.auto_extraction.enabled
  env_var: KG_AUTO_EXTRACTION_ENABLED
  default: false
```

- [ ] **Step 5: Run test to verify it passes**

Run: `cd services/agent-claw && npm test -- tests/unit/hooks/tool-invocation-emitter.test.ts`
Expected: PASS — all 5 tests green.

- [ ] **Step 6: Commit**

```bash
git add services/agent-claw/src/core/hooks/tool-invocation-emitter.ts \
        services/agent-claw/tests/unit/hooks/tool-invocation-emitter.test.ts \
        hooks/tool-invocation-emitter.yaml
git commit -m "feat(agent-claw): tool-invocation-emitter universal post-tool hook (Phase 0)"
```

---

## Task 8: Wire the new hook into BUILTIN_REGISTRARS + bump MIN_EXPECTED_HOOKS

**Files:**
- Modify: `services/agent-claw/src/core/hook-loader.ts`
- Modify: `services/agent-claw/src/bootstrap/start.ts`
- Test: `services/agent-claw/tests/unit/bootstrap/hook-loader.test.ts` (existing — update assertions)

- [ ] **Step 1: Inspect the existing files**

Run: `grep -n 'BUILTIN_REGISTRARS\|MIN_EXPECTED_HOOKS' services/agent-claw/src/core/hook-loader.ts services/agent-claw/src/bootstrap/start.ts`

Expected output: shows the current registrar map and the `MIN_EXPECTED_HOOKS = 26` line.

- [ ] **Step 2: Add the import + map entry to `hook-loader.ts`**

Open `services/agent-claw/src/core/hook-loader.ts`. After the existing import block, add:

```typescript
import { registerToolInvocationEmitterHook } from "./hooks/tool-invocation-emitter.js";
```

Locate the `BUILTIN_REGISTRARS` object literal. Add an entry (keep alphabetical-ish ordering with neighbours):

```typescript
  "tool-invocation-emitter": registerToolInvocationEmitterHook,
```

The registrar signature differs from many others (it takes `{ pool, isFeatureEnabled }` rather than `(lifecycle, ...positional deps)`). Follow the deps-object pattern already used by `source-cache` if present; otherwise add a small adapter in `hook-loader.ts`:

```typescript
// Inside loadHooks, when dispatching to register*:
case "tool-invocation-emitter":
  registerToolInvocationEmitterHook(lifecycle, {
    pool: deps.pool,
    isFeatureEnabled: deps.isFeatureEnabled,
  });
  break;
```

(Match the surrounding switch / map structure exactly — read 50 lines around `source-cache` registration first.)

- [ ] **Step 3: Bump `MIN_EXPECTED_HOOKS`**

Open `services/agent-claw/src/bootstrap/start.ts`. Change:

```typescript
const MIN_EXPECTED_HOOKS = 26;
```

to:

```typescript
const MIN_EXPECTED_HOOKS = 27;
```

- [ ] **Step 4: Update the hook-loader test**

Open `services/agent-claw/tests/unit/bootstrap/hook-loader.test.ts` (or whichever existing test asserts the loaded-hook count) and bump the expected count from 26 to 27. If the existing test parses the YAML directory dynamically rather than asserting a hardcoded count, no change needed.

- [ ] **Step 5: Run the bootstrap tests**

Run: `cd services/agent-claw && npm test -- tests/unit/bootstrap/`
Expected: PASS — all bootstrap tests green; new hook registered.

- [ ] **Step 6: Run the full unit suite to catch regressions**

Run: `cd services/agent-claw && npm test`
Expected: PASS — full suite green (previously 1497 + new tests in this PR).

- [ ] **Step 7: Commit**

```bash
git add services/agent-claw/src/core/hook-loader.ts \
        services/agent-claw/src/bootstrap/start.ts \
        services/agent-claw/tests/unit/bootstrap/hook-loader.test.ts
git commit -m "feat(agent-claw): register tool-invocation-emitter; bump MIN_EXPECTED_HOOKS"
```

---

## Task 9: `tool_result_extractor` projector scaffold (Python)

**Files:**
- Create: `services/projectors/tool_result_extractor/__init__.py` (empty)
- Create: `services/projectors/tool_result_extractor/main.py`
- Create: `services/projectors/tool_result_extractor/extractor_loader.py`
- Create: `services/projectors/tool_result_extractor/Dockerfile`
- Create: `services/projectors/tool_result_extractor/requirements.txt`
- Create: `services/projectors/tool_result_extractor/tests/__init__.py` (empty)
- Create: `services/projectors/tool_result_extractor/tests/test_no_op_when_disabled.py`
- Create: `services/projectors/tool_result_extractor/tests/test_dispatch.py`

- [ ] **Step 1: Write the failing test (no-op behavior)**

```python
# services/projectors/tool_result_extractor/tests/test_no_op_when_disabled.py
"""
Phase 0 guarantee: the projector starts cleanly and processes
`tool_invocation_complete` events as no-ops when the extraction_registry
has no matching row. Zero facts must be emitted; the event must be acked.
"""
from __future__ import annotations

import asyncio
import json
import uuid
from unittest.mock import AsyncMock, MagicMock

import pytest

from services.projectors.tool_result_extractor.main import ToolResultExtractor


@pytest.mark.asyncio
async def test_no_op_when_registry_empty():
    projector = ToolResultExtractor()
    # Mock the work_conn used by handle()
    work_conn = MagicMock()
    cur = MagicMock()
    cur.fetchone = MagicMock(return_value=None)  # registry miss
    cur.execute = MagicMock()
    work_conn.cursor.return_value.__enter__.return_value = cur

    payload = {
        "tool_name": "mcp-xtb.compute_barrier",
        "user_entra_id": "u1",
        "project_id": str(uuid.uuid4()),
        "result_schema_id": "v1",
        "args": {"smiles": "[redacted]"},
        "result": {"barrier_kj_mol": 92.3},
        "duration_ms": 1234,
        "ok": True,
        "error": None,
    }
    await projector.handle(
        work_conn=work_conn,
        event_id=1,
        event_type="tool_invocation_complete",
        source_table="tool_invocations",
        source_row_id="inv-1",
        payload=payload,
    )

    # No INSERT INTO facts should have run.
    sql_calls = [c.args[0] for c in cur.execute.call_args_list]
    assert not any("INSERT INTO facts" in s for s in sql_calls), \
        f"Unexpected fact insertion in no-op path: {sql_calls}"
```

- [ ] **Step 2: Write the dispatch test**

```python
# services/projectors/tool_result_extractor/tests/test_dispatch.py
"""
Phase 0 wires the dispatcher; Phase 1+ writes the actual extractors.
This test pins the dispatch contract: registry HIT → extractor module is
imported and called with (result, ctx); returned FactDrafts are INSERTed.
"""
from __future__ import annotations

import uuid
from unittest.mock import MagicMock

import pytest

from services.projectors.tool_result_extractor.main import (
    ToolResultExtractor, FactDraft,
)
from services.projectors.tool_result_extractor import extractor_loader


@pytest.mark.asyncio
async def test_dispatch_invokes_registered_module(monkeypatch):
    # Fake extractor module that returns a single deterministic FactDraft.
    fake_module = MagicMock()
    fake_module.extract = MagicMock(return_value=[
        FactDraft(
            subject_label="Compound",
            subject_id_value="ABC",
            predicate="has_barrier_kJ_mol",
            object_value={"v": 92.3},
            unit="kJ/mol",
            derivation_class="COMPUTED",
            confidence=0.95,
            confidence_tier="high",
            extractor_name="xtb_extractor",
        )
    ])
    monkeypatch.setattr(
        extractor_loader, "load_extractor",
        lambda module_path: fake_module
    )

    projector = ToolResultExtractor()
    work_conn = MagicMock()
    cur = MagicMock()
    # Registry HIT
    cur.fetchone = MagicMock(return_value=(
        "services.projectors.fact_extractor.xtb", True, True,
    ))
    cur.execute = MagicMock()
    work_conn.cursor.return_value.__enter__.return_value = cur

    payload = {
        "tool_name": "mcp-xtb.compute_barrier",
        "user_entra_id": "u1",
        "project_id": str(uuid.uuid4()),
        "result_schema_id": "v1",
        "args": {"smiles": "[redacted]"},
        "result": {"barrier_kj_mol": 92.3},
        "duration_ms": 1234,
        "ok": True,
        "error": None,
    }
    await projector.handle(
        work_conn=work_conn,
        event_id=1,
        event_type="tool_invocation_complete",
        source_table="tool_invocations",
        source_row_id="inv-1",
        payload=payload,
    )

    sql_calls = [c.args[0] for c in cur.execute.call_args_list]
    assert any("INSERT INTO facts" in s for s in sql_calls), \
        f"Expected fact insertion; got SQL: {sql_calls}"
    assert any("'extracted_fact'" in s or "extracted_fact" in str(c.args)
               for c in cur.execute.call_args_list), \
        "Expected `extracted_fact` ingestion event emission"
```

- [ ] **Step 3: Run tests to verify they fail**

Run: `.venv/bin/pytest services/projectors/tool_result_extractor/tests/ -v`
Expected: FAIL — module not found.

- [ ] **Step 4: Write the extractor_loader**

```python
# services/projectors/tool_result_extractor/extractor_loader.py
"""
Dynamic loader for per-source extractor modules. Each module must expose:

    def extract(result: dict, ctx: ExtractionContext) -> list[FactDraft]: ...

The module path is read from extraction_registry.extractor_module.
"""
from __future__ import annotations

import importlib
import threading
from typing import Any

_cache: dict[str, Any] = {}
_cache_lock = threading.Lock()


def load_extractor(module_path: str) -> Any:
    """Import (and cache) the named module. Raises ImportError on failure."""
    with _cache_lock:
        if module_path in _cache:
            return _cache[module_path]
        module = importlib.import_module(module_path)
        if not hasattr(module, "extract"):
            raise AttributeError(
                f"{module_path} does not expose `extract(result, ctx)`"
            )
        _cache[module_path] = module
        return module


def clear_cache() -> None:
    """For tests; never call in production."""
    with _cache_lock:
        _cache.clear()
```

- [ ] **Step 5: Write the projector**

```python
# services/projectors/tool_result_extractor/main.py
"""
Universal Knowledge Accumulation — Phase 0
tool_result_extractor projector.

Subscribes to `ingestion_events` with event_type='tool_invocation_complete'.
For each event:
  1. Look up (source_kind='mcp_tool', source_name=tool_name, result_schema_id)
     in extraction_registry.
  2. On registry miss → ack and return (no-op; expected before Phase 1).
  3. On registry hit (enabled + (promote_default OR explicit promote)) →
     dynamically import the extractor_module and call
     extract(result, ctx) -> list[FactDraft].
  4. INSERT each FactDraft into the facts table.
  5. Emit one `extracted_fact` ingestion event per inserted fact.

All steps run inside a single transaction so a crash mid-dispatch retries
cleanly on next NOTIFY.
"""
from __future__ import annotations

import asyncio
import json
import logging
from dataclasses import dataclass, field
from typing import Any
from uuid import UUID

from services.mcp_tools.common.logging import configure_logging
from services.projectors.common.base import BaseProjector, ProjectorSettings
from services.projectors.tool_result_extractor import extractor_loader

log = logging.getLogger(__name__)


@dataclass
class ExtractionContext:
    tool_name: str
    user_entra_id: str
    project_id: str | None
    args: dict[str, Any]
    invocation_id: str
    duration_ms: int


@dataclass
class FactDraft:
    subject_label: str
    subject_id_value: str
    predicate: str
    derivation_class: str  # one of OBSERVED|COMPUTED|INTERPRETED|HYPOTHESIZED|ABSTRACTED
    confidence: float
    confidence_tier: str  # foundational|high|medium|low|exploratory
    extractor_name: str
    object_label: str | None = None
    object_id_value: str | None = None
    object_value: dict[str, Any] | None = None
    unit: str | None = None
    polarity: str = "positive"
    source_table: str | None = None
    source_row_id: str | None = None
    source_fact_ids: list[UUID] = field(default_factory=list)
    derivation_depth: int = 0


class ToolResultExtractor(BaseProjector):
    name = "tool_result_extractor"
    interested_event_types = ("tool_invocation_complete",)

    async def handle(
        self,
        work_conn: Any,
        event_id: int,
        event_type: str,
        source_table: str,
        source_row_id: str,
        payload: dict[str, Any],
    ) -> None:
        tool_name = payload.get("tool_name")
        result_schema_id = payload.get("result_schema_id")
        ok = payload.get("ok", True)

        if not tool_name:
            log.warning(
                "tool_invocation_complete event %s has no tool_name; skipping",
                event_id,
            )
            return

        # Phase 0: failures do not yet trigger negative-result extraction
        # (handled by Phase 1's per-tool negative extractor). Acknowledge
        # and move on so events don't pile up.
        if not ok:
            log.debug(
                "tool_invocation_complete %s ok=false; deferred to Phase 1",
                event_id,
            )
            return

        with work_conn.cursor() as cur:
            cur.execute(
                "SELECT extractor_module, enabled, promote_default "
                "FROM extraction_registry "
                "WHERE source_kind=%s AND source_name=%s AND result_schema_id=%s",
                ("mcp_tool", tool_name, result_schema_id),
            )
            row = cur.fetchone()
            if row is None:
                # Expected before Phase 1 — no extractor registered yet.
                log.debug(
                    "no extractor registered for %s:%s; skipping",
                    tool_name, result_schema_id,
                )
                return
            extractor_module, enabled, promote_default = row
            if not enabled:
                log.debug("extractor for %s is disabled; skipping", tool_name)
                return
            promote = bool(promote_default) or bool(
                (payload.get("args") or {}).get("promote_to_kg", False)
            )
            if not promote:
                log.debug(
                    "extractor for %s is registered but promote=false; skipping",
                    tool_name,
                )
                return

            try:
                module = extractor_loader.load_extractor(extractor_module)
            except Exception as exc:  # noqa: BLE001 — extractor import failure is non-fatal
                log.warning(
                    "failed to load extractor %s for %s: %s",
                    extractor_module, tool_name, exc,
                )
                return

            ctx = ExtractionContext(
                tool_name=tool_name,
                user_entra_id=payload.get("user_entra_id", ""),
                project_id=payload.get("project_id"),
                args=payload.get("args") or {},
                invocation_id=source_row_id,
                duration_ms=int(payload.get("duration_ms", 0)),
            )
            try:
                facts: list[FactDraft] = module.extract(payload.get("result") or {}, ctx)
            except Exception as exc:  # noqa: BLE001 — extractor error is recorded, not raised
                log.warning(
                    "extractor %s raised on tool=%s event=%s: %s",
                    extractor_module, tool_name, event_id, exc,
                )
                return

            for fact in facts:
                cur.execute(
                    """
                    INSERT INTO facts (
                      project_id, subject_label, subject_id_value, predicate,
                      object_label, object_id_value, object_value, unit,
                      polarity, derivation_class, confidence, confidence_tier,
                      source_table, source_row_id, source_fact_ids,
                      extractor_name, derivation_depth
                    ) VALUES (
                      %s, %s, %s, %s, %s, %s, %s, %s, %s, %s, %s, %s,
                      %s, %s, %s, %s, %s
                    )
                    RETURNING id
                    """,
                    (
                        ctx.project_id,
                        fact.subject_label, fact.subject_id_value, fact.predicate,
                        fact.object_label, fact.object_id_value,
                        json.dumps(fact.object_value) if fact.object_value is not None else None,
                        fact.unit, fact.polarity,
                        fact.derivation_class, fact.confidence, fact.confidence_tier,
                        fact.source_table or "tool_invocations",
                        fact.source_row_id or source_row_id,
                        fact.source_fact_ids,
                        fact.extractor_name,
                        fact.derivation_depth,
                    ),
                )
                new_fact_id = cur.fetchone()[0]
                cur.execute(
                    """
                    INSERT INTO ingestion_events (event_type, source_table, source_row_id, payload)
                    VALUES ('extracted_fact', 'facts', %s,
                            jsonb_build_object(
                              'fact_id', %s::text,
                              'extractor', %s::text,
                              'derivation_class', %s::text,
                              'predicate', %s::text
                            ))
                    """,
                    (str(new_fact_id), str(new_fact_id), fact.extractor_name,
                     fact.derivation_class, fact.predicate),
                )


def main() -> None:
    settings = ProjectorSettings()
    configure_logging(level=settings.projector_log_level)
    asyncio.run(ToolResultExtractor().run(settings))


if __name__ == "__main__":
    main()
```

- [ ] **Step 6: Write the requirements**

```text
# services/projectors/tool_result_extractor/requirements.txt
psycopg[binary]>=3.2
pydantic>=2.6
pydantic-settings>=2.2
```

- [ ] **Step 7: Write the Dockerfile**

```dockerfile
# services/projectors/tool_result_extractor/Dockerfile
FROM python:3.12-slim AS base
WORKDIR /app

# OpenShift SCC: run as UID 1001
RUN useradd -u 1001 -ms /bin/bash app

COPY services/projectors/common /app/services/projectors/common
COPY services/projectors/tool_result_extractor /app/services/projectors/tool_result_extractor
COPY services/mcp_tools/common /app/services/mcp_tools/common
COPY pyproject.toml /app/

RUN pip install --no-cache-dir -r services/projectors/tool_result_extractor/requirements.txt

USER 1001
ENV PYTHONPATH=/app
CMD ["python", "-m", "services.projectors.tool_result_extractor.main"]
```

- [ ] **Step 8: Run tests to verify they pass**

Run: `.venv/bin/pytest services/projectors/tool_result_extractor/tests/ -v`
Expected: PASS — both tests green.

- [ ] **Step 9: Commit**

```bash
git add services/projectors/tool_result_extractor/
git commit -m "feat(projector): tool_result_extractor scaffold (Phase 0)"
```

---

## Task 10: Compose + helm + Makefile wiring

**Files:**
- Modify: `docker-compose.yml`
- Modify: `infra/helm/values.yaml`
- Modify: `infra/helm/templates/projectors.yaml` (if it exists; otherwise the per-projector deployment template the chart uses)
- Modify: `Makefile`

- [ ] **Step 1: Inspect existing projector compose entries**

Run: `grep -A 12 'kg_documents:\|wiki_pages:' docker-compose.yml | head -40`

Expected: shows the shape of an existing projector entry, including `image`, `build`, `depends_on`, `environment`, `profiles`, `security_opt`, `healthcheck`.

- [ ] **Step 2: Add the tool-result-extractor service to `docker-compose.yml`**

Insert under `services:`, matching the shape and ordering of `kg_documents`:

```yaml
  tool-result-extractor:
    build:
      context: .
      dockerfile: services/projectors/tool_result_extractor/Dockerfile
    image: chemclaw/tool-result-extractor:dev
    depends_on:
      postgres:
        condition: service_healthy
    environment:
      POSTGRES_HOST: postgres
      POSTGRES_PORT: "5432"
      POSTGRES_DB: ${POSTGRES_DB:-chemclaw}
      POSTGRES_USER: ${POSTGRES_SERVICE_USER:-chemclaw_service}
      POSTGRES_PASSWORD: ${POSTGRES_SERVICE_PASSWORD:-changeme_service}
      PROJECTOR_LOG_LEVEL: ${PROJECTOR_LOG_LEVEL:-INFO}
      LOG_USER_SALT: ${LOG_USER_SALT:?must be set}
    profiles: ["full"]
    security_opt:
      - no-new-privileges:true
    restart: unless-stopped
```

- [ ] **Step 3: Add the helm toggle**

In `infra/helm/values.yaml`, under `projectors:`, add:

```yaml
projectors:
  # ... existing entries ...
  toolResultExtractor:
    enabled: false   # Phase 0 lands the scaffold off; flip when Phase 1 lands.
    image:
      repository: chemclaw/tool-result-extractor
      tag: dev
    resources:
      limits:
        cpu: 500m
        memory: 512Mi
      requests:
        cpu: 100m
        memory: 128Mi
```

Add the corresponding deployment template entry if the chart uses per-projector templates (mirror the `kg-documents` deployment shape).

- [ ] **Step 4: Add the Makefile target**

In `Makefile`, near other `run.*` projector targets:

```makefile
.PHONY: run.tool-result-extractor
run.tool-result-extractor:  ## Run the tool_result_extractor projector locally
	PYTHONPATH=. .venv/bin/python -m services.projectors.tool_result_extractor.main
```

- [ ] **Step 5: Smoke-test the compose build**

Run: `docker compose --profile full build tool-result-extractor`
Expected: Image builds without error.

Then: `docker compose --profile full up -d tool-result-extractor`
Expected: Container starts and stays up; `docker compose logs tool-result-extractor` shows the LISTEN startup line from `BaseProjector` with no error.

Then: `docker compose stop tool-result-extractor`

- [ ] **Step 6: Commit**

```bash
git add docker-compose.yml infra/helm/values.yaml infra/helm/templates/projectors.yaml Makefile
git commit -m "feat(infra): wire tool-result-extractor into compose + helm + Makefile"
```

---

## Task 11: `promote_to_kg` agent builtin

**Files:**
- Create: `services/agent-claw/src/tools/builtins/promote_to_kg.ts`
- Test: `services/agent-claw/tests/unit/builtins/promote_to_kg.test.ts`

- [ ] **Step 1: Write the failing test**

```typescript
// services/agent-claw/tests/unit/builtins/promote_to_kg.test.ts
import { describe, it, expect, vi } from "vitest";
import type { Pool } from "pg";
import { promoteToKgTool } from "../../../src/tools/builtins/promote_to_kg.js";

function makePool(): Pool {
  return {
    query: vi.fn(async () => ({
      rows: [{ id: "00000000-0000-0000-0000-000000000123" }],
      rowCount: 1,
    })),
    connect: vi.fn(),
  } as unknown as Pool;
}

const ctx = {
  user: "u1",
  project: "00000000-0000-0000-0000-0000000000aa",
  pool: makePool(),
};

describe("promote_to_kg builtin", () => {
  it("inserts a single OBSERVED fact and emits extracted_fact", async () => {
    const result = await promoteToKgTool.handler(
      {
        subject_label: "Compound",
        subject_id_value: "INCHI=ABC",
        predicate: "agent_concluded_property",
        object_value: { property: "soluble_in_DMSO", verdict: true },
        confidence: 0.85,
        derivation_class: "INTERPRETED",
      },
      ctx
    );
    expect(result).toMatchObject({ ok: true, fact_id: expect.any(String) });
    expect(ctx.pool.query).toHaveBeenCalled();
    // First call: INSERT INTO facts ; Second call: INSERT INTO ingestion_events
    const calls = (ctx.pool.query as any).mock.calls;
    expect(calls[0][0]).toContain("INSERT INTO facts");
    expect(calls[1][0]).toContain("INSERT INTO ingestion_events");
  });

  it("rejects derivation_class=OBSERVED from the agent", async () => {
    await expect(
      promoteToKgTool.handler(
        {
          subject_label: "Compound",
          subject_id_value: "ABC",
          predicate: "x",
          object_value: {},
          confidence: 0.9,
          derivation_class: "OBSERVED",
        },
        ctx
      )
    ).rejects.toThrow(/OBSERVED.*reserved/);
  });

  it("rejects confidence > 0.95 from the agent (capped at INTERPRETED tier)", async () => {
    await expect(
      promoteToKgTool.handler(
        {
          subject_label: "Compound",
          subject_id_value: "ABC",
          predicate: "x",
          object_value: {},
          confidence: 0.99,
          derivation_class: "INTERPRETED",
        },
        ctx
      )
    ).rejects.toThrow(/confidence/);
  });

  it("rejects empty subject / predicate", async () => {
    await expect(
      promoteToKgTool.handler(
        {
          subject_label: "Compound",
          subject_id_value: "",
          predicate: "x",
          object_value: {},
          confidence: 0.8,
          derivation_class: "INTERPRETED",
        },
        ctx
      )
    ).rejects.toThrow(/subject_id_value/);
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `cd services/agent-claw && npm test -- tests/unit/builtins/promote_to_kg.test.ts`
Expected: FAIL — module not found.

- [ ] **Step 3: Write the builtin**

```typescript
// services/agent-claw/src/tools/builtins/promote_to_kg.ts
//
// Phase 0 — Explicit fact-promotion builtin.
//
// The agent calls this when it wants a reasoning conclusion (or a piece of
// otherwise-unstructured knowledge) to enter the KG. Class is restricted to
// INTERPRETED / HYPOTHESIZED / ABSTRACTED — only the deterministic
// extractors and the source-cache hook are allowed to emit OBSERVED /
// COMPUTED.
//
// Confidence is capped to mirror the multiplicative-decay reliability of
// the chosen class (so an agent can't promote at 0.99 confidence). The
// cap is sourced from kg.extractor_reliability.* config_settings — the
// in-code defaults match db/seed/09_universal_extraction_config.sql so
// the unit test stays deterministic without DB access.

import { z } from "zod";
import type { Pool } from "pg";
import { withUserContext } from "../../db/with-user-context.js";

const ALLOWED_CLASSES = ["INTERPRETED", "HYPOTHESIZED", "ABSTRACTED"] as const;
type AllowedClass = (typeof ALLOWED_CLASSES)[number];

const CLASS_CAPS: Record<AllowedClass, number> = {
  INTERPRETED: 0.95,
  HYPOTHESIZED: 0.80,
  ABSTRACTED: 0.70,
};

const TIER_FROM_CONF = (c: number): string => {
  if (c >= 0.85) return "high";
  if (c >= 0.65) return "medium";
  if (c >= 0.40) return "low";
  return "exploratory";
};

const Args = z.object({
  subject_label: z.string().min(1),
  subject_id_value: z.string().min(1),
  predicate: z.string().min(1),
  object_label: z.string().optional(),
  object_id_value: z.string().optional(),
  object_value: z.unknown(),
  unit: z.string().optional(),
  polarity: z.enum(["positive", "negative", "anomaly"]).default("positive"),
  derivation_class: z.enum(ALLOWED_CLASSES),
  confidence: z.number().min(0).max(1),
  source_fact_ids: z.array(z.string().uuid()).default([]),
});

interface Ctx {
  user: string;
  project: string | null;
  pool: Pool;
}

export const promoteToKgTool = {
  name: "promote_to_kg",
  description:
    "Promote an agent-derived conclusion to the canonical fact store. " +
    "Class is restricted to INTERPRETED/HYPOTHESIZED/ABSTRACTED. " +
    "Confidence is capped per class.",
  inputSchema: Args,
  is_internal: false,
  result_schema_id: "v1",

  async handler(rawArgs: unknown, ctx: Ctx): Promise<{ ok: true; fact_id: string }> {
    const args = Args.parse(rawArgs);
    const cap = CLASS_CAPS[args.derivation_class];
    if (args.confidence > cap) {
      throw new Error(
        `confidence ${args.confidence} exceeds cap ${cap} for class ${args.derivation_class}`
      );
    }
    // Reject OBSERVED defensively (already excluded by the schema).
    if ((args.derivation_class as string) === "OBSERVED") {
      throw new Error("OBSERVED is reserved for measurements; cannot be promoted by the agent");
    }
    const tier = TIER_FROM_CONF(args.confidence);

    return withUserContext(ctx.pool, ctx.user, async (client) => {
      const insert = await client.query<{ id: string }>(
        `INSERT INTO facts (
            project_id, subject_label, subject_id_value, predicate,
            object_label, object_id_value, object_value, unit,
            polarity, derivation_class, confidence, confidence_tier,
            source_table, source_row_id, source_fact_ids, extractor_name,
            derivation_depth
         ) VALUES (
            $1, $2, $3, $4, $5, $6, $7::jsonb, $8, $9, $10, $11, $12,
            'agent_promotion', $13, $14, 'promote_to_kg', $15
         ) RETURNING id`,
        [
          ctx.project,
          args.subject_label,
          args.subject_id_value,
          args.predicate,
          args.object_label ?? null,
          args.object_id_value ?? null,
          JSON.stringify(args.object_value ?? null),
          args.unit ?? null,
          args.polarity,
          args.derivation_class,
          args.confidence,
          tier,
          ctx.user, // source_row_id for agent-originated facts: the entra id
          args.source_fact_ids,
          args.source_fact_ids.length > 0 ? 1 : 0,
        ]
      );
      const fact_id = insert.rows[0].id;
      await client.query(
        `INSERT INTO ingestion_events (event_type, source_table, source_row_id, payload)
         VALUES ('extracted_fact', 'facts', $1,
                 jsonb_build_object(
                   'fact_id', $1::text,
                   'extractor', 'promote_to_kg',
                   'derivation_class', $2::text,
                   'predicate', $3::text
                 ))`,
        [fact_id, args.derivation_class, args.predicate]
      );
      return { ok: true as const, fact_id };
    });
  },
};
```

- [ ] **Step 4: Register the builtin**

Open `services/agent-claw/src/tools/builtins/index.ts`. Add the import + map entry alongside neighbouring builtins:

```typescript
import { promoteToKgTool } from "./promote_to_kg.js";
// ...
export const BUILTIN_TOOLS = [
  // ... existing ...
  promoteToKgTool,
  // ...
];
```

Bump the builtin-count gate (mirrors the hook gate). Check `services/agent-claw/src/bootstrap/start.ts` for `MIN_EXPECTED_BUILTINS` or equivalent; if present, +1.

- [ ] **Step 5: Run test to verify it passes**

Run: `cd services/agent-claw && npm test -- tests/unit/builtins/promote_to_kg.test.ts`
Expected: PASS — all 4 tests green.

- [ ] **Step 6: Commit**

```bash
git add services/agent-claw/src/tools/builtins/promote_to_kg.ts \
        services/agent-claw/src/tools/builtins/index.ts \
        services/agent-claw/tests/unit/builtins/promote_to_kg.test.ts
git commit -m "feat(agent-claw): promote_to_kg builtin (Phase 0)"
```

---

## Task 12: `request_investigation` agent builtin

**Files:**
- Create: `services/agent-claw/src/tools/builtins/request_investigation.ts`
- Test: `services/agent-claw/tests/unit/builtins/request_investigation.test.ts`

- [ ] **Step 1: Write the failing test**

```typescript
// services/agent-claw/tests/unit/builtins/request_investigation.test.ts
import { describe, it, expect, vi } from "vitest";
import type { Pool } from "pg";
import { requestInvestigationTool } from "../../../src/tools/builtins/request_investigation.js";

function makePool(): Pool {
  return {
    query: vi.fn(async () => ({
      rows: [{ id: "00000000-0000-0000-0000-000000000456" }],
      rowCount: 1,
    })),
  } as unknown as Pool;
}

const ctx = { user: "u1", project: "00000000-0000-0000-0000-0000000000aa", pool: makePool() };

describe("request_investigation builtin", () => {
  it("enqueues an investigation_queue row with max score", async () => {
    const result = await requestInvestigationTool.handler(
      {
        fact_id: "00000000-0000-0000-0000-000000000111",
        reason: "this looks anomalous, please dig deeper",
      },
      ctx
    );
    expect(result).toMatchObject({ ok: true, queue_id: expect.any(String) });
    const calls = (ctx.pool.query as any).mock.calls;
    expect(calls[0][0]).toContain("INSERT INTO investigation_queue");
    // Manual request → score=1.0 so the periodic sweep picks it up first.
    expect(calls[0][1]).toContain(1.0);
  });

  it("rejects empty reason", async () => {
    await expect(
      requestInvestigationTool.handler(
        { fact_id: "00000000-0000-0000-0000-000000000111", reason: "" },
        ctx
      )
    ).rejects.toThrow(/reason/);
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `cd services/agent-claw && npm test -- tests/unit/builtins/request_investigation.test.ts`
Expected: FAIL — module not found.

- [ ] **Step 3: Write the builtin**

```typescript
// services/agent-claw/src/tools/builtins/request_investigation.ts
//
// Phase 0 — Manual investigation-queue enqueue.
//
// The agent calls this when it wants the (Phase 3+) interpreter to take a
// deeper look at a fact. In Phase 0 the queue table exists but the
// interpreter isn't deployed yet — the row sits with picked_at=NULL until
// Phase 3 lands. The builtin is wired now so the agent's mental model is
// stable across phases.

import { z } from "zod";
import type { Pool } from "pg";
import { withUserContext } from "../../db/with-user-context.js";

const Args = z.object({
  fact_id: z.string().uuid(),
  reason: z.string().min(3),
});

interface Ctx { user: string; project: string | null; pool: Pool; }

export const requestInvestigationTool = {
  name: "request_investigation",
  description:
    "Request a manual deep-dive investigation on a specific fact. Enqueues a " +
    "high-priority row in investigation_queue; the interpreter (Phase 3+) " +
    "picks it up on the next sweep.",
  inputSchema: Args,
  is_internal: false,
  result_schema_id: "v1",

  async handler(rawArgs: unknown, ctx: Ctx): Promise<{ ok: true; queue_id: string }> {
    const args = Args.parse(rawArgs);
    return withUserContext(ctx.pool, ctx.user, async (client) => {
      const r = await client.query<{ id: string }>(
        `INSERT INTO investigation_queue
           (fact_id, project_id, score, reason_codes)
         VALUES ($1, $2, $3, $4)
         RETURNING id`,
        [args.fact_id, ctx.project, 1.0, ["manual_request", args.reason.slice(0, 64)]]
      );
      return { ok: true as const, queue_id: r.rows[0].id };
    });
  },
};
```

- [ ] **Step 4: Register the builtin**

Open `services/agent-claw/src/tools/builtins/index.ts` and add the entry (same pattern as Task 11):

```typescript
import { requestInvestigationTool } from "./request_investigation.js";
// ...
export const BUILTIN_TOOLS = [
  // ... existing ...
  requestInvestigationTool,
];
```

Bump `MIN_EXPECTED_BUILTINS` again (if present) by 1.

- [ ] **Step 5: Run test to verify it passes**

Run: `cd services/agent-claw && npm test -- tests/unit/builtins/request_investigation.test.ts`
Expected: PASS — both tests green.

- [ ] **Step 6: Commit**

```bash
git add services/agent-claw/src/tools/builtins/request_investigation.ts \
        services/agent-claw/src/tools/builtins/index.ts \
        services/agent-claw/tests/unit/builtins/request_investigation.test.ts
git commit -m "feat(agent-claw): request_investigation builtin (Phase 0)"
```

---

## Task 13: End-to-end smoke (flag flip ON; no extractor registered)

**Files:**
- Create: `tests/integration/test_phase_0_end_to_end.py`

- [ ] **Step 1: Write the smoke test**

```python
# tests/integration/test_phase_0_end_to_end.py
"""
Phase 0 end-to-end smoke: with kg.auto_extraction.enabled=true and no
extractors registered, every tool call must produce exactly one
tool_invocation_complete event and zero facts. This pins the
"foundation does not crash and does not silently extract anything"
property before Phase 1 starts wiring per-tool extractors.

Requires docker-compose to be running locally (testcontainers fallback
skips otherwise — mirroring the existing integration-test pattern in
services/agent-claw/tests/integration/).
"""
from __future__ import annotations

import json
import os
import time
import uuid

import pytest

pytestmark = pytest.mark.integration


@pytest.mark.skipif(
    not os.environ.get("CHEMCLAW_INTEGRATION_DB_DSN"),
    reason="CHEMCLAW_INTEGRATION_DB_DSN not set; run via `make test.integration`",
)
def test_phase_0_no_extraction_when_no_registry_entry():
    import psycopg
    dsn = os.environ["CHEMCLAW_INTEGRATION_DB_DSN"]

    with psycopg.connect(dsn) as conn:
        # Enable the feature flag globally.
        with conn.cursor() as cur:
            cur.execute(
                "INSERT INTO feature_flags_scopes (scope, scope_id, flag_key, enabled) "
                "VALUES ('global', '__global__', 'kg.auto_extraction.enabled', TRUE) "
                "ON CONFLICT (scope, scope_id, flag_key) DO UPDATE SET enabled = TRUE"
            )
        conn.commit()

        # Simulate a tool invocation by inserting the event the hook would emit.
        inv_id = str(uuid.uuid4())
        with conn.cursor() as cur:
            cur.execute(
                """
                INSERT INTO ingestion_events
                  (event_type, source_table, source_row_id, payload)
                VALUES ('tool_invocation_complete', 'tool_invocations', %s,
                        %s::jsonb)
                """,
                (inv_id, json.dumps({
                    "tool_name": "mcp-xtb.compute_barrier",
                    "user_entra_id": "smoke-user",
                    "project_id": None,
                    "result_schema_id": "v1",
                    "args": {"smiles": "[redacted]"},
                    "result": {"barrier_kj_mol": 92.3},
                    "duration_ms": 1234,
                    "ok": True,
                    "error": None,
                })),
            )
        conn.commit()

        # Wait for the projector to consume.
        deadline = time.monotonic() + 10.0
        while time.monotonic() < deadline:
            with conn.cursor() as cur:
                cur.execute(
                    "SELECT 1 FROM projection_acks "
                    "WHERE projector_name='tool_result_extractor' "
                    "  AND event_id = (SELECT id FROM ingestion_events "
                    "                  WHERE source_row_id=%s)",
                    (inv_id,),
                )
                if cur.fetchone():
                    break
            time.sleep(0.5)
        else:
            pytest.fail("tool_result_extractor did not ack the event within 10s")

        # Zero facts should have been emitted (no registry entry).
        with conn.cursor() as cur:
            cur.execute(
                "SELECT COUNT(*) FROM facts WHERE source_row_id = %s", (inv_id,)
            )
            assert cur.fetchone()[0] == 0, "no extractor was registered; expected 0 facts"
```

- [ ] **Step 2: Run the smoke test**

Run: `make up && CHEMCLAW_INTEGRATION_DB_DSN=postgresql://chemclaw_service:changeme_service@localhost:5432/chemclaw .venv/bin/pytest tests/integration/test_phase_0_end_to_end.py -v`
Expected: PASS.

- [ ] **Step 3: Commit**

```bash
git add tests/integration/test_phase_0_end_to_end.py
git commit -m "test(phase-0): end-to-end smoke for flag-on, no-extractor path"
```

---

## Task 14: Documentation — CLAUDE.md addendum + BACKLOG entries

**Files:**
- Modify: `CLAUDE.md`
- Modify: `BACKLOG.md`

- [ ] **Step 1: Add a Phase 0 status entry to `CLAUDE.md`**

In `CLAUDE.md`, find the `## Status` section. Append a new bullet at the end of the list:

```markdown
- **Universal knowledge accumulation — Phase 0** (`docs/plans/2026-05-14-universal-knowledge-accumulation.md`): foundational schema (`facts`, `extraction_registry`, `investigation_queue`, `investigation_budget_usage`, `derivation_class` columns), `tool_result_extractor` projector scaffold, universal `tool-invocation-emitter` post-tool hook (gated by `kg.auto_extraction.enabled`, default OFF), `promote_to_kg` + `request_investigation` builtins. Phase 1 (per-MCP extractors) is the next plan. Hook count: `MIN_EXPECTED_HOOKS = 27`.
```

- [ ] **Step 2: Add `BACKLOG.md` entries for the deferred work**

In `BACKLOG.md`, append:

```markdown
- [kg/phase-1] write per-MCP extractors (xtb, aizynth, askcos, chemprop, applicability, yield_baseline, sirius, crest, synthegy, tabicl, ord_io, plate, chrom_method, reaction_optimizer, genchem) — separate plan
- [kg/phase-2] document LLM fact extraction; ELN/LOGS direct extractors; external feeds (CrossRef, PubMed, USPTO, ORD)
- [kg/phase-3] investigation_scorer + anomaly_detector + interpreter projector + kg.fact_interpretation prompt
- [kg/phase-4] pattern_detector cron + hypothesis_former + budget enforcement
- [kg/phase-5] test_planner + workflow_engine integration
- [kg/phase-6] agent_conclusion_extractor + meta-fact extractors (forged_tool_validation, skill_promotion)
- [kg/phase-7] wiki anomaly/pattern/pending-hypotheses sections; contradiction-page automation
- [kg/migration] backfill derivation_class on historical reactions/hypotheses/artifacts/compute_results rows
- [kg/migration] migrate existing direct-driver projectors (kg_hypotheses, kg_documents, qm_kg, wiki_kg) to write to facts first then mirror to Neo4j
- [kg/observability] Grafana panels for facts/extractor/derivation_class rates + investigation_queue depth + budget usage
```

- [ ] **Step 3: Commit**

```bash
git add CLAUDE.md BACKLOG.md
git commit -m "docs(claude-md,backlog): record Phase 0 status + deferred phases"
```

---

## Task 15: Open the PR

**Files:** none

- [ ] **Step 1: Push the branch**

Run: `git push -u origin spec/universal-knowledge-accumulation`

- [ ] **Step 2: Create the PR**

Run:

```bash
gh pr create --title "Universal knowledge accumulation — Phase 0 (foundation)" --body "$(cat <<'EOF'
## Summary

Phase 0 of the universal knowledge accumulation design ([spec](docs/plans/2026-05-14-universal-knowledge-accumulation.md)). Lands the foundational schema (`facts`, `extraction_registry`, `investigation_queue`, `investigation_budget_usage`, `derivation_class` columns on existing fact-bearing tables), a *gated, default-off* universal `tool-invocation-emitter` post-tool hook, the `tool_result_extractor` projector scaffold, and the `promote_to_kg` + `request_investigation` agent builtins.

No behavior change in default config: the feature flag `kg.auto_extraction.enabled` is OFF. Flip per-project once Phase 1 lands the first chemistry-MCP extractor.

## Test plan

- [x] Unit: schema migrations (5 files; `tests/unit/db/test_*_schema.py`)
- [x] Unit: feature flag + config seeds (`tests/unit/db/test_universal_extraction_seed.py`)
- [x] Unit: tool-invocation-emitter hook (vitest)
- [x] Unit: tool_result_extractor projector dispatch + no-op (pytest)
- [x] Unit: promote_to_kg + request_investigation builtins (vitest)
- [x] Integration smoke: flag-on, no-extractor path produces 0 facts + 1 ack
- [ ] CI green (full suite)
- [ ] Self-review via `/review`

🤖 Generated with [Claude Code](https://claude.com/claude-code)
EOF
)"
```

- [ ] **Step 3: Wait for CI + run `/review`**

Per CLAUDE.md hard requirement #2:

```bash
gh pr checks --watch  # wait for CI
```

Then in Claude Code: run `/review` on the PR, address findings via fixup commits to the same branch, repeat until clean.

- [ ] **Step 4: Merge + cleanup**

Once CI is green AND `/review` returns clean:

```bash
gh pr merge --merge --delete-branch
git checkout main && git pull origin main
git branch -D spec/universal-knowledge-accumulation 2>/dev/null || true
```

---

## Self-review checklist (run after writing all tasks)

- [x] **Spec coverage:** every Phase 0 deliverable in spec §6 is covered:
  - Schema: Tasks 1–5 ✓
  - Empty `tool_result_extractor` projector: Task 9 ✓
  - Universal post-tool hook gated by feature flag: Tasks 7 + 8 ✓
  - Feature flag + config knobs seeded: Task 6 ✓
  - Builtins (`promote_to_kg`, `request_investigation`): Tasks 11 + 12 ✓
  - Compose / helm / Makefile wiring: Task 10 ✓
  - End-to-end smoke: Task 13 ✓
  - Documentation + PR: Tasks 14 + 15 ✓
- [x] **No placeholders:** every step has either complete code or an exact command + expected output. No "TBD" / "TODO" / "similar to" references.
- [x] **Type consistency:** `FactDraft` shape in Task 9 is consumed by the test in Task 9; `derivation_class` enum values match across SQL migrations, TS builtins, Python dataclass, and test assertions; `confidence_tier` strings (`foundational | high | medium | low | exploratory`) match SQL CHECK and TS `TIER_FROM_CONF`; SQL placeholder counts in INSERT statements match the bound-parameter array lengths.
- [x] **Phase-boundary discipline:** every Phase-1+ behavior (anomaly detection, interpretation, hypothesis formation, test planning, document LLM extraction, external feeds) is explicitly *not* implemented in Phase 0 — only the substrates are. No Phase 0 task is gated on a Phase 1 deliverable.

---

## Execution handoff

Plan complete and saved to `docs/plans/2026-05-14-universal-knowledge-accumulation-phase-0.md`.

**Two execution options:**

**1. Subagent-Driven (recommended)** — dispatch a fresh subagent per task (Tasks 1–15), review between tasks, fast iteration. Tasks 1–6 are pure SQL and can run in parallel; Tasks 7–8 are TypeScript and depend on Task 6; Tasks 9–10 are Python and depend on Tasks 1–6; Tasks 11–12 depend on Tasks 1–6 + the agent-claw build green from Task 8; Task 13 depends on Tasks 1–12; Tasks 14–15 close out.

**2. Inline Execution** — run tasks in this session using `superpowers:executing-plans`, batch execution with checkpoints (e.g., checkpoint after Task 6 to verify schema + seeds before touching application code; checkpoint after Task 10 to verify compose starts cleanly; checkpoint after Task 13 to verify the end-to-end smoke).
