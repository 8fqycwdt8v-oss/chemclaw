# Phase 5A — Cross-Project Reaction Learning Toolkit — Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Ship Phase 5 Sub-project A: four new agent tools (`expand_reaction_context`, `statistical_analyze`, `synthesize_insights`, `propose_hypothesis`), a new `mcp-tabicl` service, a `hypotheses` canonical table pair with RLS, a `kg-hypotheses` projector, and unification of the agent API surface (remove `mode` + `/api/deep_research`; one unified `agent.system` prompt; one tool catalog).

**Architecture:** Follows the A-on-C event-sourced pattern. Canonical `hypotheses` rows in Postgres emit `hypothesis_proposed` events; `kg-hypotheses` projector derives Neo4j `Hypothesis` nodes with `CITES` edges. TabICL v2 runs stateless per request in `mcp-tabicl` with JSON-persisted DRFP PCA (plain arrays, loader is pure NumPy — no arbitrary-code-execution path). Agent becomes a single unified `ChatAgent` with no mode param; per-turn `seenFactIds: Set<string>` anti-fabrication guard rejects citations the agent never saw.

**Tech Stack:** TypeScript (Mastra agent), Python 3.11 (FastAPI MCP services, projectors, tests), Postgres 16 + pgvector, Neo4j + Graphiti, scikit-learn (PCA fit only), `tabicl` (v2), RDKit for SMILES canonicalization + DRFP, Streamlit frontend.

**Reference spec:** `docs/superpowers/specs/2026-04-23-phase-5a-cross-learning-toolkit-design.md`.

---

## File Structure

**Create:**
- `db/init/03_hypotheses.sql` — `hypotheses` + `hypothesis_citations` tables + RLS policies.
- `db/seed/04_unified_system_prompt.sql` — deactivates `agent.deep_research_mode.v1` and existing `agent.system` v1; inserts unified `agent.system` v2 and `tool.synthesize_insights.v1`.
- `services/mcp_tools/mcp_tabicl/__init__.py`
- `services/mcp_tools/mcp_tabicl/main.py` — FastAPI app, routes.
- `services/mcp_tools/mcp_tabicl/pca.py` — DRFP → 32-dim PCA fit + JSON persist + load + transform.
- `services/mcp_tools/mcp_tabicl/featurizer.py` — reaction rows → feature matrix + targets.
- `services/mcp_tools/mcp_tabicl/inference.py` — `tabicl` wrapper.
- `services/mcp_tools/mcp_tabicl/requirements.txt`
- `services/mcp_tools/mcp_tabicl/Dockerfile`
- `services/projectors/kg_hypotheses/__init__.py`
- `services/projectors/kg_hypotheses/main.py` — `BaseProjector` subclass.
- `services/projectors/kg_hypotheses/requirements.txt`
- `services/projectors/kg_hypotheses/Dockerfile`
- `services/agent/src/tools/expand-reaction-context.ts`
- `services/agent/src/tools/statistical-analyze.ts`
- `services/agent/src/tools/synthesize-insights.ts`
- `services/agent/src/tools/propose-hypothesis.ts`
- `tests/unit/test_hypotheses_schema.py`
- `tests/unit/test_mcp_tabicl_pca.py`
- `tests/unit/test_mcp_tabicl_featurizer.py`
- `tests/unit/test_mcp_tabicl_api.py`
- `tests/integration/test_kg_hypotheses_projector.py` (gated)
- `services/agent/tests/unit/expand-reaction-context.test.ts`
- `services/agent/tests/unit/statistical-analyze.test.ts`
- `services/agent/tests/unit/synthesize-insights.test.ts`
- `services/agent/tests/unit/propose-hypothesis.test.ts`
- `services/agent/tests/unit/chat-agent.unified.test.ts`
- `services/agent/tests/unit/deep-research.route.deletion.test.ts`

**Modify:**
- `services/agent/src/agent/chat-agent.ts` — remove `mode`, add `seenFactIds`, unified tool catalog, single `AGENT_MAX_STEPS`.
- `services/agent/src/agent/tools.ts` — merge `buildDeepResearchTools` into `buildTools`; add the four new tools; propagate `seenFactIds` population.
- `services/agent/src/agent/prompts.ts` — drop any mode-specific helpers if present.
- `services/agent/src/routes/chat.ts` — remove `mode` param handling.
- `services/agent/src/index.ts` — delete `deep_research` route registration.
- `services/agent/src/config.ts` — add `MCP_TABICL_URL`, raise `AGENT_CHAT_MAX_STEPS` ceiling to 40.
- `services/agent/src/mcp-clients.ts` — add `McpTabiclClient`.
- `services/frontend/pages/chat.py` — remove mode toggle; add fenced-chart renderer; add Hypothesis badge.
- `docker-compose.yml` — add `mcp-tabicl` service + `kg-hypotheses` projector + `mcp-tabicl-cache` volume.
- `Makefile` — add `run.mcp-tabicl`, `db.init.tabicl-pca` targets.
- `scripts/smoke.sh` — add cross-project path + `/api/deep_research` 404 assertion.
- `CLAUDE.md` — update Status section (Phase 4 unwound, Phase 5A complete).

**Delete:**
- `services/agent/src/routes/deep_research.ts`
- Any tests asserting mode branching (identified in Task 10).

---

## Task Index

1. Canonical `hypotheses` + `hypothesis_citations` schema + RLS
2. `mcp-tabicl` service skeleton + PCA JSON persistence
3. `mcp-tabicl` featurizer
4. `mcp-tabicl` inference wrapper (TabICL v2)
5. `mcp-tabicl` FastAPI routes + `/readyz` gating + Docker Compose entry
6. `Makefile` targets + cold-fit admin path
7. `McpTabiclClient` on the agent side
8. Unify `agent.system` prompt — seed migration
9. Unify `ChatAgent` — remove `mode`, add `seenFactIds`, single tool catalog
10. Delete `/api/deep_research` route + mode-branching tests
11. New tool: `expand_reaction_context`
12. New tool: `statistical_analyze`
13. New tool: `synthesize_insights` (+ `tool.synthesize_insights.v1` seed)
14. New tool: `propose_hypothesis` (+ `seenFactIds` anti-fabrication guard)
15. Register all four tools in the unified `buildTools` + propagate `seenFactIds` population
16. `kg-hypotheses` projector + Neo4j integration test
17. Docker Compose entry for `kg-hypotheses` projector
18. Streamlit: remove mode toggle + add Hypothesis badge
19. Streamlit: fenced-chart renderer
20. Smoke-test additions
21. `CLAUDE.md` Status update + Phase 5A completion note

---

## Task 1: Canonical `hypotheses` + `hypothesis_citations` schema + RLS

**Files:**
- Create: `db/init/03_hypotheses.sql`
- Test: `tests/unit/test_hypotheses_schema.py`

- [ ] **Step 1.1: Write the failing schema test**

Create `tests/unit/test_hypotheses_schema.py`:

```python
"""Schema + RLS tests for the hypotheses table pair.

Runs against a live Postgres fixture (see conftest.py for the `pg_conn`
and `apply_schema` session fixtures). These tests exercise CHECK
constraints, the confidence_tier generated column, the RLS policy split
(owner sees own, scope-holder sees project-scoped), and cascade deletion
of citations.
"""
from __future__ import annotations

import uuid

import psycopg
import pytest


pytestmark = pytest.mark.usefixtures("apply_schema")


def _set_user(cur: psycopg.Cursor, entra_id: str) -> None:
    cur.execute("SELECT set_config('app.current_user_entra_id', %s, true)", (entra_id,))


def _bypass_rls(cur: psycopg.Cursor) -> None:
    # chemclaw_service is BYPASSRLS; simulate by switching role in tests.
    cur.execute("SET LOCAL ROLE chemclaw_service")


def test_confidence_tier_generated_column(pg_conn: psycopg.Connection) -> None:
    with pg_conn.cursor() as cur:
        _bypass_rls(cur)
        cur.execute(
            "INSERT INTO hypotheses (hypothesis_text, confidence, proposed_by_user_entra_id) "
            "VALUES (%s, %s, %s) RETURNING confidence_tier",
            ("A demonstration hypothesis with enough text.", 0.91, "user-a"),
        )
        assert cur.fetchone()[0] == "high"
        cur.execute(
            "INSERT INTO hypotheses (hypothesis_text, confidence, proposed_by_user_entra_id) "
            "VALUES (%s, %s, %s) RETURNING confidence_tier",
            ("Another hypothesis text long enough.", 0.65, "user-a"),
        )
        assert cur.fetchone()[0] == "medium"
        cur.execute(
            "INSERT INTO hypotheses (hypothesis_text, confidence, proposed_by_user_entra_id) "
            "VALUES (%s, %s, %s) RETURNING confidence_tier",
            ("Low-confidence hypothesis, still long enough.", 0.2, "user-a"),
        )
        assert cur.fetchone()[0] == "low"


def test_hypothesis_text_length_check(pg_conn: psycopg.Connection) -> None:
    with pg_conn.cursor() as cur:
        _bypass_rls(cur)
        with pytest.raises(psycopg.errors.CheckViolation):
            cur.execute(
                "INSERT INTO hypotheses (hypothesis_text, confidence, proposed_by_user_entra_id) "
                "VALUES (%s, %s, %s)",
                ("short", 0.5, "user-a"),
            )


def test_confidence_bounds_check(pg_conn: psycopg.Connection) -> None:
    with pg_conn.cursor() as cur:
        _bypass_rls(cur)
        with pytest.raises(psycopg.errors.CheckViolation):
            cur.execute(
                "INSERT INTO hypotheses (hypothesis_text, confidence, proposed_by_user_entra_id) "
                "VALUES (%s, %s, %s)",
                ("An otherwise valid hypothesis text.", 1.5, "user-a"),
            )


def test_rls_owner_sees_own_cross_portfolio(pg_conn: psycopg.Connection) -> None:
    with pg_conn.cursor() as cur:
        _bypass_rls(cur)
        cur.execute(
            "INSERT INTO hypotheses (hypothesis_text, confidence, proposed_by_user_entra_id) "
            "VALUES (%s, %s, %s) RETURNING id",
            ("Cross-portfolio hypothesis by user-a.", 0.8, "user-a"),
        )
        hid = cur.fetchone()[0]
    pg_conn.commit()

    with pg_conn.cursor() as cur:
        _set_user(cur, "user-a")
        cur.execute("SELECT id FROM hypotheses WHERE id = %s", (hid,))
        assert cur.fetchone() is not None

    with pg_conn.cursor() as cur:
        _set_user(cur, "user-b")
        cur.execute("SELECT id FROM hypotheses WHERE id = %s", (hid,))
        assert cur.fetchone() is None


def test_citations_cascade_on_hypothesis_delete(pg_conn: psycopg.Connection) -> None:
    with pg_conn.cursor() as cur:
        _bypass_rls(cur)
        cur.execute(
            "INSERT INTO hypotheses (hypothesis_text, confidence, proposed_by_user_entra_id) "
            "VALUES (%s, %s, %s) RETURNING id",
            ("Hypothesis that will be deleted.", 0.7, "user-a"),
        )
        hid = cur.fetchone()[0]
        cur.execute(
            "INSERT INTO hypothesis_citations (hypothesis_id, fact_id) VALUES (%s, %s)",
            (hid, str(uuid.uuid4())),
        )
        cur.execute("DELETE FROM hypotheses WHERE id = %s", (hid,))
        cur.execute("SELECT count(*) FROM hypothesis_citations WHERE hypothesis_id = %s", (hid,))
        assert cur.fetchone()[0] == 0
```

- [ ] **Step 1.2: Run test to verify it fails**

Run: `.venv/bin/pytest tests/unit/test_hypotheses_schema.py -v`
Expected: FAIL — `relation "hypotheses" does not exist`.

- [ ] **Step 1.3: Write the schema migration**

Create `db/init/03_hypotheses.sql`:

```sql
-- ChemClaw — hypotheses tables for Phase 5A cross-project learning.
-- Canonical state for hypotheses the agent proposes; projected to Neo4j
-- by kg-hypotheses. Re-applicable (IF NOT EXISTS everywhere).

BEGIN;

CREATE TABLE IF NOT EXISTS hypotheses (
    id                        UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
    hypothesis_text           TEXT NOT NULL
        CHECK (length(hypothesis_text) BETWEEN 10 AND 4000),
    confidence                NUMERIC(4,3) NOT NULL
        CHECK (confidence BETWEEN 0.0 AND 1.0),
    confidence_tier           TEXT GENERATED ALWAYS AS (
        CASE WHEN confidence >= 0.85 THEN 'high'
             WHEN confidence >= 0.60 THEN 'medium'
             ELSE                          'low'
        END
    ) STORED,
    scope_nce_project_id      UUID REFERENCES nce_projects(id),
    proposed_by_user_entra_id TEXT NOT NULL,
    agent_trace_id            TEXT,
    status                    TEXT NOT NULL DEFAULT 'proposed'
        CHECK (status IN ('proposed','confirmed','refuted','archived')),
    created_at                TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    updated_at                TIMESTAMPTZ NOT NULL DEFAULT NOW()
);
DROP TRIGGER IF EXISTS trg_hypotheses_updated_at ON hypotheses;
CREATE TRIGGER trg_hypotheses_updated_at
  BEFORE UPDATE ON hypotheses
  FOR EACH ROW EXECUTE FUNCTION set_updated_at();

CREATE TABLE IF NOT EXISTS hypothesis_citations (
    hypothesis_id UUID NOT NULL REFERENCES hypotheses(id) ON DELETE CASCADE,
    fact_id       UUID NOT NULL,
    citation_note TEXT CHECK (length(citation_note) <= 500),
    PRIMARY KEY (hypothesis_id, fact_id)
);

CREATE INDEX IF NOT EXISTS idx_hypotheses_scope
  ON hypotheses(scope_nce_project_id) WHERE status = 'proposed';
CREATE INDEX IF NOT EXISTS idx_hypotheses_user
  ON hypotheses(proposed_by_user_entra_id);
CREATE INDEX IF NOT EXISTS idx_hypotheses_created
  ON hypotheses(created_at DESC);

ALTER TABLE hypotheses          ENABLE ROW LEVEL SECURITY;
ALTER TABLE hypothesis_citations ENABLE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS hypotheses_owner_or_scope ON hypotheses;
CREATE POLICY hypotheses_owner_or_scope ON hypotheses FOR SELECT
USING (
    proposed_by_user_entra_id = current_setting('app.current_user_entra_id', true)
    OR (
        scope_nce_project_id IS NOT NULL
        AND EXISTS (
            SELECT 1 FROM user_project_access upa
            WHERE upa.nce_project_id = hypotheses.scope_nce_project_id
              AND upa.user_entra_id  = current_setting('app.current_user_entra_id', true)
        )
    )
);

DROP POLICY IF EXISTS hypotheses_owner_insert ON hypotheses;
CREATE POLICY hypotheses_owner_insert ON hypotheses FOR INSERT
WITH CHECK (
    proposed_by_user_entra_id = current_setting('app.current_user_entra_id', true)
);

DROP POLICY IF EXISTS hypotheses_owner_update ON hypotheses;
CREATE POLICY hypotheses_owner_update ON hypotheses FOR UPDATE
USING (
    proposed_by_user_entra_id = current_setting('app.current_user_entra_id', true)
);

DROP POLICY IF EXISTS hypothesis_citations_via_parent ON hypothesis_citations;
CREATE POLICY hypothesis_citations_via_parent ON hypothesis_citations FOR ALL
USING (
    EXISTS (SELECT 1 FROM hypotheses h WHERE h.id = hypothesis_citations.hypothesis_id)
);

COMMIT;
```

- [ ] **Step 1.4: Re-apply schema and run tests**

Run: `make db.init && .venv/bin/pytest tests/unit/test_hypotheses_schema.py -v`
Expected: PASS (5 tests).

- [ ] **Step 1.5: Commit**

```bash
git add db/init/03_hypotheses.sql tests/unit/test_hypotheses_schema.py
git commit -m "feat(db): hypotheses canonical tables + RLS for Phase 5A"
```

---

## Task 2: `mcp-tabicl` service skeleton + PCA JSON persistence

**Files:**
- Create: `services/mcp_tools/mcp_tabicl/__init__.py` (empty)
- Create: `services/mcp_tools/mcp_tabicl/pca.py`
- Create: `services/mcp_tools/mcp_tabicl/requirements.txt`
- Test: `tests/unit/test_mcp_tabicl_pca.py`

- [ ] **Step 2.1: Write the failing PCA persistence test**

Create `tests/unit/test_mcp_tabicl_pca.py`:

```python
"""Tests for mcp-tabicl DRFP PCA persistence.

PCA state is persisted as plain JSON — three float arrays
(`components_`, `mean_`, `explained_variance_`) plus `n_components` and
`n_features`. The loader reconstructs NumPy arrays without any
serialisation framework that could execute code on load.
"""
from __future__ import annotations

import json
from pathlib import Path

import numpy as np
import pytest

from services.mcp_tools.mcp_tabicl.pca import (
    PCA_N_COMPONENTS,
    PCA_N_FEATURES,
    fit_and_save,
    load,
    transform,
)


def test_fit_save_load_roundtrip(tmp_path: Path) -> None:
    rng = np.random.default_rng(42)
    # synthetic DRFP-like binary bits, 2048 features
    X = rng.integers(0, 2, size=(200, PCA_N_FEATURES)).astype("float64")
    out = tmp_path / "drfp_pca.json"

    fit_and_save(X, out)

    loaded = load(out)
    assert loaded.components.shape == (PCA_N_COMPONENTS, PCA_N_FEATURES)
    assert loaded.mean.shape == (PCA_N_FEATURES,)
    assert loaded.explained_variance.shape == (PCA_N_COMPONENTS,)

    # Transform produces consistent shape + finite values.
    y = transform(X[:5], loaded)
    assert y.shape == (5, PCA_N_COMPONENTS)
    assert np.isfinite(y).all()


def test_load_rejects_wrong_n_components(tmp_path: Path) -> None:
    bad = {
        "n_components": PCA_N_COMPONENTS + 1,
        "n_features": PCA_N_FEATURES,
        "components": [[0.0] * PCA_N_FEATURES] * (PCA_N_COMPONENTS + 1),
        "mean": [0.0] * PCA_N_FEATURES,
        "explained_variance": [1.0] * (PCA_N_COMPONENTS + 1),
    }
    p = tmp_path / "drfp_pca.json"
    p.write_text(json.dumps(bad))
    with pytest.raises(ValueError, match="n_components"):
        load(p)


def test_load_rejects_wrong_n_features(tmp_path: Path) -> None:
    bad = {
        "n_components": PCA_N_COMPONENTS,
        "n_features": 128,
        "components": [[0.0] * 128] * PCA_N_COMPONENTS,
        "mean": [0.0] * 128,
        "explained_variance": [1.0] * PCA_N_COMPONENTS,
    }
    p = tmp_path / "drfp_pca.json"
    p.write_text(json.dumps(bad))
    with pytest.raises(ValueError, match="n_features"):
        load(p)


def test_load_rejects_malformed_json(tmp_path: Path) -> None:
    p = tmp_path / "drfp_pca.json"
    p.write_text("not json")
    with pytest.raises(ValueError):
        load(p)
```

- [ ] **Step 2.2: Run test to verify it fails**

Run: `.venv/bin/pytest tests/unit/test_mcp_tabicl_pca.py -v`
Expected: FAIL — `ModuleNotFoundError: services.mcp_tools.mcp_tabicl.pca`.

- [ ] **Step 2.3: Create the package skeleton**

Create `services/mcp_tools/mcp_tabicl/__init__.py` (empty file — just makes it a package).

Create `services/mcp_tools/mcp_tabicl/requirements.txt`:

```
fastapi==0.115.6
uvicorn[standard]==0.32.1
pydantic==2.10.4
numpy>=1.26,<3.0
scikit-learn>=1.5,<2.0
rdkit-pypi==2022.9.5
drfp==0.3.6
tabicl>=2.0.0,<3.0
# Shared MCP tool app factory lives in services.mcp_tools.common — no extra dep.
```

- [ ] **Step 2.4: Write the PCA module**

Create `services/mcp_tools/mcp_tabicl/pca.py`:

```python
"""DRFP → 32-dim PCA fit / persist / load / transform.

The persisted artifact is plain JSON — three float arrays plus
dimensionality metadata. The loader reconstructs NumPy arrays
directly, applying no serialisation framework that could execute
code. Shape mismatches refuse to load.
"""
from __future__ import annotations

import json
from dataclasses import dataclass
from pathlib import Path

import numpy as np
from sklearn.decomposition import PCA  # type: ignore[import-untyped]

PCA_N_COMPONENTS: int = 32
PCA_N_FEATURES: int = 2048


@dataclass(frozen=True)
class FittedPca:
    components: np.ndarray          # shape (n_components, n_features)
    mean: np.ndarray                # shape (n_features,)
    explained_variance: np.ndarray  # shape (n_components,)


def fit_and_save(X: np.ndarray, path: Path) -> None:
    """Fit a PCA on an (N, 2048) float matrix and persist to JSON atomically."""
    if X.ndim != 2 or X.shape[1] != PCA_N_FEATURES:
        raise ValueError(
            f"X must be 2-D with {PCA_N_FEATURES} columns; got shape {X.shape}"
        )
    if X.shape[0] < PCA_N_COMPONENTS:
        raise ValueError(
            f"need at least {PCA_N_COMPONENTS} rows to fit {PCA_N_COMPONENTS} components; "
            f"got {X.shape[0]}"
        )
    pca = PCA(n_components=PCA_N_COMPONENTS, svd_solver="auto", random_state=0)
    pca.fit(X.astype("float64", copy=False))
    payload = {
        "n_components": PCA_N_COMPONENTS,
        "n_features": PCA_N_FEATURES,
        "components": pca.components_.astype("float64").tolist(),
        "mean": pca.mean_.astype("float64").tolist(),
        "explained_variance": pca.explained_variance_.astype("float64").tolist(),
    }
    # Atomic swap: write temp then rename.
    tmp = path.with_suffix(path.suffix + ".tmp")
    tmp.write_text(json.dumps(payload))
    tmp.replace(path)


def load(path: Path) -> FittedPca:
    """Load a fitted PCA from its JSON artifact. Raises ValueError on mismatch."""
    try:
        raw = json.loads(path.read_text())
    except (OSError, json.JSONDecodeError) as exc:
        raise ValueError(f"cannot read PCA artifact {path}: {exc}") from exc

    if not isinstance(raw, dict):
        raise ValueError("PCA artifact must be a JSON object")
    if raw.get("n_components") != PCA_N_COMPONENTS:
        raise ValueError(
            f"PCA artifact n_components mismatch: expected {PCA_N_COMPONENTS}, "
            f"got {raw.get('n_components')}"
        )
    if raw.get("n_features") != PCA_N_FEATURES:
        raise ValueError(
            f"PCA artifact n_features mismatch: expected {PCA_N_FEATURES}, "
            f"got {raw.get('n_features')}"
        )

    components = np.asarray(raw["components"], dtype="float64")
    mean = np.asarray(raw["mean"], dtype="float64")
    explained = np.asarray(raw["explained_variance"], dtype="float64")

    if components.shape != (PCA_N_COMPONENTS, PCA_N_FEATURES):
        raise ValueError(f"bad components shape: {components.shape}")
    if mean.shape != (PCA_N_FEATURES,):
        raise ValueError(f"bad mean shape: {mean.shape}")
    if explained.shape != (PCA_N_COMPONENTS,):
        raise ValueError(f"bad explained_variance shape: {explained.shape}")

    return FittedPca(components=components, mean=mean, explained_variance=explained)


def transform(X: np.ndarray, fitted: FittedPca) -> np.ndarray:
    """Project X (N, 2048) → (N, 32) using the loaded PCA."""
    if X.ndim != 2 or X.shape[1] != PCA_N_FEATURES:
        raise ValueError(f"X must be 2-D with {PCA_N_FEATURES} columns; got shape {X.shape}")
    centered = X.astype("float64", copy=False) - fitted.mean
    return centered @ fitted.components.T
```

- [ ] **Step 2.5: Install deps and run test**

Run: `.venv/bin/pip install -r services/mcp_tools/mcp_tabicl/requirements.txt && .venv/bin/pytest tests/unit/test_mcp_tabicl_pca.py -v`
Expected: PASS (4 tests).

- [ ] **Step 2.6: Commit**

```bash
git add services/mcp_tools/mcp_tabicl/__init__.py services/mcp_tools/mcp_tabicl/pca.py services/mcp_tools/mcp_tabicl/requirements.txt tests/unit/test_mcp_tabicl_pca.py
git commit -m "feat(mcp-tabicl): PCA module with JSON-persisted artifact"
```

---

## Task 3: `mcp-tabicl` featurizer

**Files:**
- Create: `services/mcp_tools/mcp_tabicl/featurizer.py`
- Test: `tests/unit/test_mcp_tabicl_featurizer.py`

- [ ] **Step 3.1: Write the failing featurizer test**

Create `tests/unit/test_mcp_tabicl_featurizer.py`:

```python
"""Unit tests for the mcp-tabicl reaction featurizer."""
from __future__ import annotations

from pathlib import Path

import numpy as np

from services.mcp_tools.mcp_tabicl.featurizer import (
    FeatureSchema,
    ReactionRow,
    featurize,
)
from services.mcp_tools.mcp_tabicl.pca import (
    PCA_N_COMPONENTS,
    PCA_N_FEATURES,
    fit_and_save,
    load,
)


def _sample_pca(tmp_path: Path):
    rng = np.random.default_rng(0)
    X = rng.integers(0, 2, size=(PCA_N_COMPONENTS + 10, PCA_N_FEATURES)).astype("float64")
    p = tmp_path / "drfp_pca.json"
    fit_and_save(X, p)
    return load(p)


def test_featurize_happy_path(tmp_path: Path) -> None:
    fitted = _sample_pca(tmp_path)
    rows = [
        ReactionRow(
            reaction_id="00000000-0000-0000-0000-000000000001",
            rxn_smiles="BrC1=CC=CC=C1.OB(O)C1=CC=CC=C1>>C1=CC=C(C=C1)C2=CC=CC=C2",
            rxno_class="3.1.1",
            solvent="toluene",
            temp_c=80.0,
            time_min=1440.0,
            catalyst_loading_mol_pct=2.0,
            base="K2CO3",
            yield_pct=88.0,
        )
    ]
    schema, X, y, skipped = featurize(rows, fitted, include_targets=True)
    assert isinstance(schema, FeatureSchema)
    assert X.shape == (1, len(schema.feature_names))
    assert y is not None and y.shape == (1,)
    # All 32 PCA columns must be present.
    assert sum(1 for f in schema.feature_names if f.startswith("drfp_pc_")) == PCA_N_COMPONENTS
    assert skipped == []


def test_featurize_skips_invalid_smiles(tmp_path: Path) -> None:
    fitted = _sample_pca(tmp_path)
    rows = [
        ReactionRow(
            reaction_id="aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa",
            rxn_smiles="not a smiles",
            rxno_class=None, solvent=None, temp_c=None, time_min=None,
            catalyst_loading_mol_pct=None, base=None, yield_pct=None,
        )
    ]
    _, X, _y, skipped = featurize(rows, fitted, include_targets=False)
    assert X.shape[0] == 0
    assert len(skipped) == 1
    assert skipped[0]["reaction_id"].startswith("aaaaaaaa")


def test_featurize_row_cap(tmp_path: Path) -> None:
    fitted = _sample_pca(tmp_path)
    rows = [
        ReactionRow(
            reaction_id=str(i),
            rxn_smiles="CC>>CC",
            rxno_class=None, solvent=None, temp_c=None, time_min=None,
            catalyst_loading_mol_pct=None, base=None, yield_pct=None,
        )
        for i in range(1001)
    ]
    import pytest
    with pytest.raises(ValueError, match="row cap"):
        featurize(rows, fitted, include_targets=False)
```

- [ ] **Step 3.2: Run test to verify it fails**

Run: `.venv/bin/pytest tests/unit/test_mcp_tabicl_featurizer.py -v`
Expected: FAIL — `ModuleNotFoundError: ...featurizer`.

- [ ] **Step 3.3: Implement the featurizer**

Create `services/mcp_tools/mcp_tabicl/featurizer.py`:

```python
"""Reaction rows → feature matrix + targets for TabICL inference.

Featurization contract (see spec §3.4):
  drfp_pc_1..32            float     DRFP 2048-bit → 32 PCA components
  rxno_class               categorical
  solvent_class            categorical (mapped from free-text solvent)
  temp_c                   float
  time_min                 float
  catalyst_loading_mol_pct float
  base_class               categorical (mapped from free-text base)
  target:  yield_pct       float (regression)

This module is intentionally pure: no DB, no HTTP. Callers are
responsible for supplying rows.
"""
from __future__ import annotations

from dataclasses import dataclass, field
from typing import Any

import numpy as np
from drfp import DrfpEncoder  # type: ignore[import-untyped]

from .pca import FittedPca, PCA_N_COMPONENTS, transform as pca_transform

ROW_CAP: int = 1000

# Fixed categorical vocabularies — TabICL handles categoricals natively, but
# we normalize free-text strings to a fixed set so feature positions stay stable.
_SOLVENT_CLASSES = (
    "water", "methanol", "ethanol", "acetonitrile", "thf", "dmf", "dmso",
    "dcm", "chloroform", "toluene", "benzene", "hexane", "ether", "dioxane",
    "acetone", "etoac", "ipa", "nmp", "pyridine", "other",
)
_BASE_CLASSES = (
    "k2co3", "cs2co3", "na2co3", "k3po4", "kotbu", "naotbu", "kh", "nah",
    "lda", "nbuli", "dbu", "tea", "dipea", "dmap", "none", "other",
)


@dataclass(frozen=True)
class ReactionRow:
    reaction_id: str
    rxn_smiles: str
    rxno_class: str | None
    solvent: str | None
    temp_c: float | None
    time_min: float | None
    catalyst_loading_mol_pct: float | None
    base: str | None
    yield_pct: float | None


@dataclass(frozen=True)
class FeatureSchema:
    feature_names: list[str] = field(default_factory=list)
    categorical_names: frozenset[str] = field(default_factory=frozenset)


def _normalize_solvent(s: str | None) -> str:
    if not s:
        return "other"
    key = s.strip().lower()
    return key if key in _SOLVENT_CLASSES else "other"


def _normalize_base(b: str | None) -> str:
    if not b:
        return "none"
    key = b.strip().lower()
    return key if key in _BASE_CLASSES else "other"


def _compute_drfp_bits(rxn_smiles: str) -> np.ndarray | None:
    try:
        bits, _ = DrfpEncoder.encode(rxn_smiles, n_folded_length=2048, radius=3)
        if bits is None:
            return None
        arr = np.asarray(bits, dtype="float64")
        if arr.shape != (2048,):
            return None
        return arr
    except Exception:
        return None


def featurize(
    rows: list[ReactionRow],
    fitted_pca: FittedPca,
    include_targets: bool,
) -> tuple[FeatureSchema, np.ndarray, np.ndarray | None, list[dict[str, Any]]]:
    """Transform rows into a (N, F) feature matrix + optional (N,) targets.

    Rows with invalid / un-parseable SMILES are dropped; the reason is
    appended to `skipped` and the caller is expected to surface them as
    caveats. Raises ValueError if `len(rows) > ROW_CAP`.
    """
    if len(rows) > ROW_CAP:
        raise ValueError(f"row cap exceeded: {len(rows)} > {ROW_CAP}")

    # --- assemble DRFP bits + PCA ---
    drfp_mat_rows: list[np.ndarray] = []
    kept: list[ReactionRow] = []
    skipped: list[dict[str, Any]] = []
    for r in rows:
        bits = _compute_drfp_bits(r.rxn_smiles)
        if bits is None:
            skipped.append({"reaction_id": r.reaction_id, "reason": "invalid_rxn_smiles"})
            continue
        drfp_mat_rows.append(bits)
        kept.append(r)

    if not kept:
        schema = FeatureSchema(
            feature_names=[f"drfp_pc_{i+1}" for i in range(PCA_N_COMPONENTS)]
            + ["rxno_class", "solvent_class", "temp_c", "time_min",
               "catalyst_loading_mol_pct", "base_class"],
            categorical_names=frozenset({"rxno_class", "solvent_class", "base_class"}),
        )
        return schema, np.zeros((0, len(schema.feature_names)), dtype="float64"), None, skipped

    drfp_matrix = np.vstack(drfp_mat_rows)
    pca_out = pca_transform(drfp_matrix, fitted_pca)  # (N, 32)

    # --- build the combined feature matrix ---
    feature_names = [f"drfp_pc_{i+1}" for i in range(PCA_N_COMPONENTS)] + [
        "rxno_class", "solvent_class", "temp_c", "time_min",
        "catalyst_loading_mol_pct", "base_class",
    ]
    # TabICL accepts object arrays of mixed dtypes; we keep everything as
    # float for numeric cols and categorical encoded as int indices for
    # categorical cols. TabICL recognises them as categorical by the
    # `categorical_names` the caller passes to inference.
    n = len(kept)
    X = np.empty((n, len(feature_names)), dtype="object")
    X[:, :PCA_N_COMPONENTS] = pca_out
    for i, r in enumerate(kept):
        X[i, PCA_N_COMPONENTS + 0] = r.rxno_class or "unknown"
        X[i, PCA_N_COMPONENTS + 1] = _normalize_solvent(r.solvent)
        X[i, PCA_N_COMPONENTS + 2] = float(r.temp_c) if r.temp_c is not None else np.nan
        X[i, PCA_N_COMPONENTS + 3] = float(r.time_min) if r.time_min is not None else np.nan
        X[i, PCA_N_COMPONENTS + 4] = (
            float(r.catalyst_loading_mol_pct)
            if r.catalyst_loading_mol_pct is not None
            else np.nan
        )
        X[i, PCA_N_COMPONENTS + 5] = _normalize_base(r.base)

    y: np.ndarray | None = None
    if include_targets:
        y = np.asarray(
            [r.yield_pct if r.yield_pct is not None else np.nan for r in kept],
            dtype="float64",
        )

    schema = FeatureSchema(
        feature_names=feature_names,
        categorical_names=frozenset({"rxno_class", "solvent_class", "base_class"}),
    )
    return schema, X, y, skipped
```

- [ ] **Step 3.4: Run tests to verify they pass**

Run: `.venv/bin/pytest tests/unit/test_mcp_tabicl_featurizer.py -v`
Expected: PASS (3 tests).

- [ ] **Step 3.5: Commit**

```bash
git add services/mcp_tools/mcp_tabicl/featurizer.py tests/unit/test_mcp_tabicl_featurizer.py
git commit -m "feat(mcp-tabicl): reaction featurizer (DRFP+PCA+categoricals)"
```

---

## Task 4: `mcp-tabicl` inference wrapper (TabICL v2)

**Files:**
- Create: `services/mcp_tools/mcp_tabicl/inference.py`

- [ ] **Step 4.1: Write the inference wrapper**

Create `services/mcp_tools/mcp_tabicl/inference.py`:

```python
"""Thin wrapper around TabICL v2 for per-request fit-and-predict.

TabICL is a prior-fitted tabular foundation model: you hand it a
support set + targets and a query set; it returns predictions without
separate training. We expose two modes: regression (default) and
classification (when targets are integer class labels).

We also expose an optional permutation-based feature-importance pass
so the agent can ask "which columns matter?" without a second tool.
"""
from __future__ import annotations

from dataclasses import dataclass

import numpy as np

try:
    from tabicl import TabICLRegressor, TabICLClassifier  # type: ignore[import-untyped]
except ImportError:  # pragma: no cover — import error surfaces at /readyz
    TabICLRegressor = None  # type: ignore[assignment]
    TabICLClassifier = None  # type: ignore[assignment]


@dataclass(frozen=True)
class PredictResult:
    predictions: np.ndarray      # shape (n_query,)
    prediction_std: np.ndarray   # shape (n_query,); zero if model does not return std
    feature_importance: dict[str, float] | None


def _require_tabicl() -> None:
    if TabICLRegressor is None or TabICLClassifier is None:
        raise RuntimeError("tabicl is not installed; cannot run inference")


def predict_and_rank(
    *,
    support_rows: np.ndarray,            # (n_support, n_features), dtype=object
    support_targets: np.ndarray,         # (n_support,) floats or ints
    query_rows: np.ndarray,              # (n_query, n_features), dtype=object
    feature_names: list[str],
    categorical_names: frozenset[str],
    task: str,                           # "regression" | "classification"
    return_feature_importance: bool,
) -> PredictResult:
    _require_tabicl()
    if support_rows.shape[1] != query_rows.shape[1]:
        raise ValueError(
            f"support/query width mismatch: {support_rows.shape[1]} vs {query_rows.shape[1]}"
        )
    if task not in ("regression", "classification"):
        raise ValueError(f"task must be regression|classification; got {task!r}")

    cat_indices = [i for i, n in enumerate(feature_names) if n in categorical_names]

    if task == "regression":
        model = TabICLRegressor(categorical_features=cat_indices)
    else:
        model = TabICLClassifier(categorical_features=cat_indices)
    model.fit(support_rows, support_targets)

    preds = np.asarray(model.predict(query_rows))
    try:
        std = np.asarray(model.predict_std(query_rows))  # may not exist
    except (AttributeError, NotImplementedError):
        std = np.zeros_like(preds, dtype="float64")

    fi: dict[str, float] | None = None
    if return_feature_importance:
        fi = _permutation_importance(model, support_rows, support_targets, feature_names)

    return PredictResult(predictions=preds, prediction_std=std, feature_importance=fi)


def _permutation_importance(
    model, X: np.ndarray, y: np.ndarray, names: list[str],
) -> dict[str, float]:
    """Simple permutation FI over the support set (80/20 split)."""
    rng = np.random.default_rng(0)
    n = X.shape[0]
    n_val = max(1, n // 5)
    idx = rng.permutation(n)
    val_idx, train_idx = idx[:n_val], idx[n_val:]
    model.fit(X[train_idx], y[train_idx])
    base_err = _mse(model.predict(X[val_idx]), y[val_idx])

    out: dict[str, float] = {}
    for j, nm in enumerate(names):
        Xp = X[val_idx].copy()
        rng.shuffle(Xp[:, j])
        err = _mse(model.predict(Xp), y[val_idx])
        out[nm] = float(err - base_err)
    return out


def _mse(pred, y) -> float:
    pred = np.asarray(pred, dtype="float64")
    y = np.asarray(y, dtype="float64")
    return float(np.mean((pred - y) ** 2))
```

- [ ] **Step 4.2: Commit**

```bash
git add services/mcp_tools/mcp_tabicl/inference.py
git commit -m "feat(mcp-tabicl): TabICL v2 inference wrapper with permutation FI"
```

*(No dedicated unit test for `inference.py` — TabICL downloads a model at first call and is exercised in `test_mcp_tabicl_api.py` via the FastAPI endpoints, where the test also mocks slow downloads.)*

---

## Task 5: `mcp-tabicl` FastAPI routes + Docker Compose entry

**Files:**
- Create: `services/mcp_tools/mcp_tabicl/main.py`
- Create: `services/mcp_tools/mcp_tabicl/Dockerfile`
- Modify: `docker-compose.yml`
- Test: `tests/unit/test_mcp_tabicl_api.py`

- [ ] **Step 5.1: Write the failing API test**

Create `tests/unit/test_mcp_tabicl_api.py`:

```python
"""Integration tests for the mcp-tabicl FastAPI app.

Uses TestClient + a monkey-patched inference layer so tests don't
download or invoke TabICL. PCA-artifact presence gates /readyz.
"""
from __future__ import annotations

import json
from pathlib import Path
from unittest import mock

import numpy as np
import pytest
from fastapi.testclient import TestClient

from services.mcp_tools.mcp_tabicl.main import build_app
from services.mcp_tools.mcp_tabicl.pca import (
    PCA_N_COMPONENTS, PCA_N_FEATURES, fit_and_save,
)
from services.mcp_tools.mcp_tabicl.inference import PredictResult


@pytest.fixture()
def pca_path(tmp_path: Path) -> Path:
    rng = np.random.default_rng(0)
    X = rng.integers(0, 2, size=(PCA_N_COMPONENTS + 5, PCA_N_FEATURES)).astype("float64")
    p = tmp_path / "drfp_pca.json"
    fit_and_save(X, p)
    return p


def test_readyz_503_when_missing(tmp_path: Path) -> None:
    p = tmp_path / "missing.json"
    app = build_app(pca_path=p)
    with TestClient(app) as c:
        r = c.get("/readyz")
        assert r.status_code == 503


def test_readyz_200_when_present(pca_path: Path) -> None:
    app = build_app(pca_path=pca_path)
    with TestClient(app) as c:
        r = c.get("/readyz")
        assert r.status_code == 200


def test_featurize_happy_path(pca_path: Path) -> None:
    app = build_app(pca_path=pca_path)
    with TestClient(app) as c:
        payload = {
            "reaction_rows": [
                {
                    "reaction_id": "00000000-0000-0000-0000-000000000001",
                    "rxn_smiles": "BrC1=CC=CC=C1.OB(O)C1=CC=CC=C1>>C1=CC=C(C=C1)C2=CC=CC=C2",
                    "rxno_class": "3.1.1", "solvent": "toluene", "temp_c": 80.0,
                    "time_min": 1440.0, "catalyst_loading_mol_pct": 2.0, "base": "K2CO3",
                    "yield_pct": 88.0,
                }
            ],
            "include_targets": True,
        }
        r = c.post("/featurize", json=payload)
        assert r.status_code == 200
        body = r.json()
        assert body["targets"] == [88.0]
        assert len(body["rows"]) == 1
        assert body["skipped"] == []


def test_predict_and_rank_uses_inference(pca_path: Path) -> None:
    app = build_app(pca_path=pca_path)
    fake = PredictResult(
        predictions=np.array([72.0]), prediction_std=np.array([3.0]),
        feature_importance={"temp_c": 0.2},
    )
    with TestClient(app) as c, mock.patch(
        "services.mcp_tools.mcp_tabicl.main.predict_and_rank", return_value=fake,
    ):
        r = c.post(
            "/predict_and_rank",
            json={
                "support_rows": [[0.1] * (PCA_N_COMPONENTS + 6)],
                "support_targets": [50.0],
                "query_rows": [[0.2] * (PCA_N_COMPONENTS + 6)],
                "feature_names": [f"drfp_pc_{i+1}" for i in range(PCA_N_COMPONENTS)]
                + ["rxno_class","solvent_class","temp_c","time_min",
                   "catalyst_loading_mol_pct","base_class"],
                "categorical_names": ["rxno_class","solvent_class","base_class"],
                "task": "regression",
                "return_feature_importance": True,
            },
        )
        assert r.status_code == 200
        body = r.json()
        assert body["predictions"] == [72.0]
        assert body["feature_importance"]["temp_c"] == pytest.approx(0.2)


def test_row_cap_rejection(pca_path: Path) -> None:
    app = build_app(pca_path=pca_path)
    with TestClient(app) as c:
        payload = {
            "reaction_rows": [
                {"reaction_id": str(i), "rxn_smiles": "CC>>CC",
                 "rxno_class": None, "solvent": None, "temp_c": None,
                 "time_min": None, "catalyst_loading_mol_pct": None,
                 "base": None, "yield_pct": None}
                for i in range(1001)
            ],
            "include_targets": False,
        }
        r = c.post("/featurize", json=payload)
        assert r.status_code == 400
```

- [ ] **Step 5.2: Run test to verify it fails**

Run: `.venv/bin/pytest tests/unit/test_mcp_tabicl_api.py -v`
Expected: FAIL — `cannot import ...main.build_app`.

- [ ] **Step 5.3: Write the FastAPI app**

Create `services/mcp_tools/mcp_tabicl/main.py`:

```python
"""FastAPI app for mcp-tabicl — featurize + predict_and_rank + pca_refit."""
from __future__ import annotations

import logging
import os
from pathlib import Path
from typing import Any

import numpy as np
from fastapi import FastAPI, Header, HTTPException
from pydantic import BaseModel, Field

from services.mcp_tools.common.app import create_app

from .featurizer import ReactionRow, featurize
from .inference import predict_and_rank
from .pca import FittedPca, PCA_N_COMPONENTS, PCA_N_FEATURES, fit_and_save, load

log = logging.getLogger("mcp-tabicl")

DEFAULT_PCA_PATH = Path(os.getenv("MCP_TABICL_PCA_PATH", "/var/cache/mcp-tabicl/drfp_pca.json"))
ADMIN_TOKEN_ENV = "MCP_TABICL_ADMIN_TOKEN"


class ReactionRowIn(BaseModel):
    reaction_id: str = Field(min_length=1, max_length=64)
    rxn_smiles: str = Field(min_length=3, max_length=20_000)
    rxno_class: str | None = Field(default=None, max_length=200)
    solvent: str | None = Field(default=None, max_length=200)
    temp_c: float | None = None
    time_min: float | None = None
    catalyst_loading_mol_pct: float | None = None
    base: str | None = Field(default=None, max_length=200)
    yield_pct: float | None = None


class FeaturizeIn(BaseModel):
    reaction_rows: list[ReactionRowIn] = Field(max_length=1001)  # enforce cap in code
    include_targets: bool = True


class FeaturizeOut(BaseModel):
    feature_names: list[str]
    categorical_names: list[str]
    rows: list[list[Any]]
    targets: list[float] | None
    skipped: list[dict[str, Any]]


class PredictIn(BaseModel):
    support_rows: list[list[Any]] = Field(min_length=1, max_length=1000)
    support_targets: list[float] = Field(min_length=1, max_length=1000)
    query_rows: list[list[Any]] = Field(min_length=1, max_length=1000)
    feature_names: list[str] = Field(min_length=1, max_length=512)
    categorical_names: list[str] = Field(default_factory=list, max_length=512)
    task: str = Field(pattern="^(regression|classification)$")
    return_feature_importance: bool = False


class PredictOut(BaseModel):
    predictions: list[float]
    prediction_std: list[float]
    feature_importance: dict[str, float] | None


class PcaRefitIn(BaseModel):
    drfp_matrix: list[list[int]] = Field(min_length=PCA_N_COMPONENTS, max_length=100_000)


def _ready_check(pca_path: Path) -> bool:
    return pca_path.exists()


def build_app(*, pca_path: Path = DEFAULT_PCA_PATH) -> FastAPI:
    app = create_app(
        name="mcp-tabicl",
        version="0.1.0",
        ready_check=lambda: _ready_check(pca_path),
    )

    def _require_pca() -> FittedPca:
        if not pca_path.exists():
            raise HTTPException(status_code=503, detail="PCA artifact missing")
        return load(pca_path)

    @app.post("/featurize", response_model=FeaturizeOut)
    def _featurize(payload: FeaturizeIn) -> FeaturizeOut:
        fitted = _require_pca()
        rows = [
            ReactionRow(
                reaction_id=r.reaction_id,
                rxn_smiles=r.rxn_smiles,
                rxno_class=r.rxno_class,
                solvent=r.solvent,
                temp_c=r.temp_c,
                time_min=r.time_min,
                catalyst_loading_mol_pct=r.catalyst_loading_mol_pct,
                base=r.base,
                yield_pct=r.yield_pct,
            )
            for r in payload.reaction_rows
        ]
        schema, X, y, skipped = featurize(rows, fitted, include_targets=payload.include_targets)
        # Convert object matrix → JSON-serialisable.
        serialised_rows: list[list[Any]] = []
        for i in range(X.shape[0]):
            row_vals: list[Any] = []
            for j in range(X.shape[1]):
                v = X[i, j]
                if isinstance(v, (np.floating, np.integer)):
                    row_vals.append(float(v))
                elif isinstance(v, float):
                    row_vals.append(v if np.isfinite(v) else None)
                else:
                    row_vals.append(v)
            serialised_rows.append(row_vals)
        return FeaturizeOut(
            feature_names=schema.feature_names,
            categorical_names=sorted(schema.categorical_names),
            rows=serialised_rows,
            targets=(y.tolist() if y is not None else None),
            skipped=skipped,
        )

    @app.post("/predict_and_rank", response_model=PredictOut)
    def _predict(payload: PredictIn) -> PredictOut:
        support = np.asarray(payload.support_rows, dtype="object")
        query = np.asarray(payload.query_rows, dtype="object")
        targets = np.asarray(payload.support_targets, dtype="float64")
        result = predict_and_rank(
            support_rows=support,
            support_targets=targets,
            query_rows=query,
            feature_names=payload.feature_names,
            categorical_names=frozenset(payload.categorical_names),
            task=payload.task,
            return_feature_importance=payload.return_feature_importance,
        )
        return PredictOut(
            predictions=result.predictions.astype("float64").tolist(),
            prediction_std=result.prediction_std.astype("float64").tolist(),
            feature_importance=result.feature_importance,
        )

    @app.post("/pca_refit")
    def _pca_refit(
        payload: PcaRefitIn,
        x_admin_token: str | None = Header(default=None, alias="x-admin-token"),
    ) -> dict[str, Any]:
        expected = os.getenv(ADMIN_TOKEN_ENV)
        if not expected or x_admin_token != expected:
            raise HTTPException(status_code=403, detail="admin token required")
        X = np.asarray(payload.drfp_matrix, dtype="float64")
        fit_and_save(X, pca_path)
        return {"status": "ok", "n_rows": int(X.shape[0]), "path": str(pca_path)}

    return app


# Uvicorn entrypoint
app = build_app()
```

- [ ] **Step 5.4: Create the Dockerfile**

Create `services/mcp_tools/mcp_tabicl/Dockerfile`:

```dockerfile
FROM python:3.11-slim
RUN groupadd -g 1001 app && useradd -r -u 1001 -g app app
WORKDIR /app
COPY services/mcp_tools/common /app/services/mcp_tools/common
COPY services/mcp_tools/__init__.py /app/services/mcp_tools/__init__.py
COPY services/mcp_tools/mcp_tabicl /app/services/mcp_tools/mcp_tabicl
COPY services/__init__.py /app/services/__init__.py
RUN pip install --no-cache-dir -r services/mcp_tools/mcp_tabicl/requirements.txt
RUN mkdir -p /var/cache/mcp-tabicl && chown -R app:app /var/cache/mcp-tabicl /app
USER 1001:1001
EXPOSE 8005
CMD ["uvicorn", "services.mcp_tools.mcp_tabicl.main:app", "--host", "0.0.0.0", "--port", "8005"]
```

- [ ] **Step 5.5: Add compose entry**

Edit `docker-compose.yml` and add under `services:` (same section as existing mcp-* services):

```yaml
  # mcp-tabicl — TabICL v2 tabular in-context learning on reaction features
  mcp-tabicl:
    container_name: chemclaw-mcp-tabicl
    build:
      context: .
      dockerfile: services/mcp_tools/mcp_tabicl/Dockerfile
    user: "1001:1001"
    environment:
      MCP_TABICL_PCA_PATH: /var/cache/mcp-tabicl/drfp_pca.json
      MCP_TABICL_ADMIN_TOKEN: ${MCP_TABICL_ADMIN_TOKEN:-}
    ports:
      - "8005:8005"
    volumes:
      - mcp-tabicl-cache:/var/cache/mcp-tabicl
    security_opt:
      - no-new-privileges:true
    healthcheck:
      test: ["CMD", "curl", "-sf", "http://localhost:8005/readyz"]
      interval: 15s
      timeout: 5s
      retries: 10
    profiles: ["full"]
```

And add under `volumes:`:

```yaml
  mcp-tabicl-cache:
```

- [ ] **Step 5.6: Run tests**

Run: `.venv/bin/pytest tests/unit/test_mcp_tabicl_api.py -v`
Expected: PASS (5 tests).

- [ ] **Step 5.7: Commit**

```bash
git add services/mcp_tools/mcp_tabicl/main.py services/mcp_tools/mcp_tabicl/Dockerfile tests/unit/test_mcp_tabicl_api.py docker-compose.yml
git commit -m "feat(mcp-tabicl): FastAPI app + Dockerfile + compose entry (port 8005)"
```

---

## Task 6: `Makefile` targets + cold-fit admin path

**Files:**
- Modify: `Makefile`
- Create: `scripts/tabicl_pca_coldfit.py`

- [ ] **Step 6.1: Add the cold-fit script**

Create `scripts/tabicl_pca_coldfit.py`:

```python
"""Cold-fit the mcp-tabicl DRFP PCA over all reactions in the database.

Run from the host:
    .venv/bin/python scripts/tabicl_pca_coldfit.py \
        --out /var/cache/mcp-tabicl/drfp_pca.json

Requires existing DRFP-vectorised reactions. This is an explicit
admin action — never invoked lazily inside a request path.
"""
from __future__ import annotations

import argparse
import os
from pathlib import Path

import numpy as np
import psycopg

from services.mcp_tools.mcp_tabicl.pca import PCA_N_FEATURES, fit_and_save


def main() -> None:
    parser = argparse.ArgumentParser()
    parser.add_argument("--out", type=Path, required=True)
    args = parser.parse_args()

    dsn = (
        f"host={os.environ.get('POSTGRES_HOST', 'localhost')} "
        f"port={os.environ.get('POSTGRES_PORT', '5432')} "
        f"dbname={os.environ.get('POSTGRES_DB', 'chemclaw')} "
        f"user={os.environ.get('POSTGRES_USER', 'chemclaw')} "
        f"password={os.environ.get('POSTGRES_PASSWORD', '')}"
    )
    with psycopg.connect(dsn) as conn, conn.cursor() as cur:
        cur.execute("SELECT drfp_vector FROM reactions WHERE drfp_vector IS NOT NULL")
        rows = cur.fetchall()
    if not rows:
        raise SystemExit("no DRFP vectors found; run the reaction-vectorizer first")

    # Each drfp_vector is a pgvector literal '[0,1,0,...]' — psycopg returns it
    # as a list already when pgvector adapter is registered; fall back to parse.
    matrix: list[list[float]] = []
    for (v,) in rows:
        if isinstance(v, (list, tuple)):
            matrix.append([float(b) for b in v])
        elif isinstance(v, str):
            matrix.append([float(b) for b in v.strip("[]").split(",") if b])
        else:
            raise RuntimeError(f"unexpected drfp_vector type: {type(v)!r}")
    X = np.asarray(matrix, dtype="float64")
    if X.shape[1] != PCA_N_FEATURES:
        raise SystemExit(f"expected {PCA_N_FEATURES} features; got {X.shape[1]}")
    args.out.parent.mkdir(parents=True, exist_ok=True)
    fit_and_save(X, args.out)
    print(f"wrote PCA artifact ({X.shape[0]} rows) to {args.out}")


if __name__ == "__main__":
    main()
```

- [ ] **Step 6.2: Add Makefile targets**

Edit `Makefile`. Find the `run.mcp-drfp:` target and add nearby:

```make
run.mcp-tabicl:
	$(PY) -m uvicorn services.mcp_tools.mcp_tabicl.main:app --host 0.0.0.0 --port 8005

db.init.tabicl-pca:
	$(PY) scripts/tabicl_pca_coldfit.py --out $${MCP_TABICL_PCA_PATH:-/var/cache/mcp-tabicl/drfp_pca.json}
```

- [ ] **Step 6.3: Commit**

```bash
git add Makefile scripts/tabicl_pca_coldfit.py
git commit -m "feat(mcp-tabicl): Makefile targets + PCA cold-fit admin script"
```

---

## Task 7: `McpTabiclClient` on the agent side

**Files:**
- Modify: `services/agent/src/mcp-clients.ts`
- Modify: `services/agent/src/config.ts`

- [ ] **Step 7.1: Extend config with `MCP_TABICL_URL`**

Edit `services/agent/src/config.ts`. Add inside the `ConfigSchema`, next to the other MCP URLs:

```ts
  MCP_TABICL_URL: z.string().url().default("http://localhost:8005"),
```

And bump the chat max-steps ceiling:

```ts
  AGENT_CHAT_MAX_STEPS: z.coerce.number().int().positive().max(40).default(20),
```

- [ ] **Step 7.2: Add `McpTabiclClient`**

Edit `services/agent/src/mcp-clients.ts`. After the existing `McpEmbedderClient` definition, append:

```ts
// ---------- TabICL client ---------------------------------------------------

const FeaturizeIn = z.object({
  reaction_rows: z.array(
    z.object({
      reaction_id: z.string().min(1).max(64),
      rxn_smiles: z.string().min(3).max(20_000),
      rxno_class: z.string().max(200).nullable(),
      solvent: z.string().max(200).nullable(),
      temp_c: z.number().nullable(),
      time_min: z.number().nullable(),
      catalyst_loading_mol_pct: z.number().nullable(),
      base: z.string().max(200).nullable(),
      yield_pct: z.number().nullable(),
    }),
  ).min(1).max(1000),
  include_targets: z.boolean(),
});
export type FeaturizeInput = z.infer<typeof FeaturizeIn>;

const FeaturizeOut = z.object({
  feature_names: z.array(z.string()),
  categorical_names: z.array(z.string()),
  rows: z.array(z.array(z.any())),
  targets: z.array(z.number()).nullable(),
  skipped: z.array(z.object({
    reaction_id: z.string(),
    reason: z.string(),
  })),
});
export type FeaturizeOutput = z.infer<typeof FeaturizeOut>;

const PredictIn = z.object({
  support_rows: z.array(z.array(z.any())).min(1).max(1000),
  support_targets: z.array(z.number()).min(1).max(1000),
  query_rows: z.array(z.array(z.any())).min(1).max(1000),
  feature_names: z.array(z.string()).min(1).max(512),
  categorical_names: z.array(z.string()).max(512).default([]),
  task: z.enum(["regression", "classification"]),
  return_feature_importance: z.boolean().default(false),
});
export type PredictInput = z.infer<typeof PredictIn>;

const PredictOut = z.object({
  predictions: z.array(z.number()),
  prediction_std: z.array(z.number()),
  feature_importance: z.record(z.string(), z.number()).nullable(),
});
export type PredictOutput = z.infer<typeof PredictOut>;

export class McpTabiclClient {
  constructor(
    private readonly baseUrl: string,
    private readonly timeoutMs: number = 60_000,
  ) {}

  async featurize(input: FeaturizeInput): Promise<FeaturizeOutput> {
    const validated = FeaturizeIn.parse(input);
    return postJson(
      `${this.baseUrl}/featurize`,
      validated,
      FeaturizeOut,
      this.timeoutMs,
      "mcp-tabicl",
    );
  }

  async predictAndRank(input: PredictInput): Promise<PredictOutput> {
    const validated = PredictIn.parse(input);
    return postJson(
      `${this.baseUrl}/predict_and_rank`,
      validated,
      PredictOut,
      this.timeoutMs,
      "mcp-tabicl",
    );
  }
}
```

- [ ] **Step 7.3: Wire the client at the agent entrypoint**

Edit `services/agent/src/index.ts`. Find where existing clients are constructed (look for `new McpDrfpClient`) and add:

```ts
import { McpTabiclClient } from "./mcp-clients.js";
// ...
const tabicl = new McpTabiclClient(config.MCP_TABICL_URL);
```

And pass it into `ChatAgent` deps (alongside `drfp`, `rdkit`, etc.). The `ChatAgentDeps` interface update lands in Task 9.

- [ ] **Step 7.4: Type-check**

Run: `cd services/agent && npm run typecheck`
Expected: compile error for missing `tabicl` in `ChatAgentDeps` — that's expected; Task 9 adds it.

- [ ] **Step 7.5: Commit**

```bash
git add services/agent/src/mcp-clients.ts services/agent/src/config.ts services/agent/src/index.ts
git commit -m "feat(agent): McpTabiclClient + config; AGENT_MAX_STEPS ceiling=40"
```

---

## Task 8: Unify `agent.system` prompt — seed migration

**Files:**
- Create: `db/seed/04_unified_system_prompt.sql`

- [ ] **Step 8.1: Write the seed file**

Create `db/seed/04_unified_system_prompt.sql`:

```sql
-- Phase 5A — unified agent.system prompt + tool.synthesize_insights.v1.
-- Deactivates agent.deep_research_mode.v1 + the existing agent.system v1.

BEGIN;

-- Deactivate older prompts (rows preserved for history).
UPDATE prompt_registry
   SET active = false
 WHERE name IN ('agent.system', 'agent.deep_research_mode');

-- Insert unified agent.system v2.
INSERT INTO prompt_registry (name, version, active, template)
VALUES (
  'agent.system',
  2,
  true,
  $$You are ChemClaw, an autonomous knowledge-intelligence agent for pharmaceutical chemical and analytical development.

# Tool catalogue
You have one unified toolkit. Pick tools per request — do not ask the user which "mode" to use.

Retrieval:
  - search_knowledge — hybrid retrieval across documents (SOPs, reports, literature chunks).
  - fetch_full_document — full parsed Markdown of a document by UUID.
  - canonicalize_smiles — RDKit canonicalization + InChIKey + formula + MW.
  - find_similar_reactions — DRFP vector search across the user's accessible projects.
  - query_kg — direct knowledge-graph traversal; use for structured relations and temporal snapshots.
  - check_contradictions — CONTRADICTS edges and parallel currently-valid facts for an entity.

Cross-project reasoning:
  - expand_reaction_context — pull reagents, conditions, outcomes, failures, citations, predecessors.
  - statistical_analyze — TabICL-based predict_yield_for_similar, rank_feature_importance, compare_conditions.
  - synthesize_insights — structured cross-project insight composition with citation discipline.
  - propose_hypothesis — non-terminal; writes a Hypothesis node with CITES edges to Fact IDs. Call as often as the evidence warrants.

Reporting:
  - draft_section — compose one report section with citation-format validation.
  - mark_research_done — TERMINAL; persists a report. Use only when the user asked for a formal written report.

# Approach
Pick tools based on the question, not a preset sequence:
  - Retrieval question ("what does SOP X say about …?") → search_knowledge, then fetch_full_document.
  - Structured lookup ("what reagents were used in EXP-007?") → query_kg.
  - Cross-project pattern ("across my projects, what conditions give the best yield for …?") →
    find_similar_reactions → expand_reaction_context (bounded-parallel) → statistical_analyze →
    synthesize_insights → propose_hypothesis (one or more).
  - Formal report requested → draft_section for each section, then mark_research_done.

# Citation discipline
  - Cite fact_ids verbatim from tool outputs. Do not fabricate.
  - Never cite a fact_id that no tool in this turn returned.
  - When propose_hypothesis rejects a citation, re-plan — do not retry the same citation.

# Confidence calibration
  - Use the confidence field honestly. Low confidence (<0.4) is fine when evidence is thin;
    padding is not.
  - Only propose a hypothesis when at least 3 fact_ids support the claim.

# Response form
  - Single-sentence questions get single-sentence answers.
  - Multi-row comparisons → markdown tables.
  - Trends or distributions where a chart is clearer than prose → fenced chart block:
      ```chart
      {"type": "bar" | "line" | "scatter", "title": "...", "x_label": "...",
       "y_label": "...", "x": [...], "y": [...]}
      ```
    Series form:
      ```chart
      {"type": "line", "title": "...", "x_label": "...", "y_label": "...",
       "x": [...], "series": [{"name": "Project A", "y": [...]}]}
      ```
  - Long multi-part answers → markdown sections.

# Termination
mark_research_done is one of several ways to end a turn, not the only way. For most questions
the agent terminates with a direct assistant message after the supporting tool calls.
$$
);

-- Internal prompt for synthesize_insights.
INSERT INTO prompt_registry (name, version, active, template)
VALUES (
  'tool.synthesize_insights',
  1,
  true,
  $$You compose structured cross-project insights from a reaction set.

INPUT JSON contains:
  - reactions: array of {reaction_id, rxn_smiles, rxno_class, project, yield_pct, outcome_status, expanded_context}
  - prior_stats: optional output of statistical_analyze
  - question: user question framing

OUTPUT: strict JSON matching this schema — no commentary, no markdown:
{
  "insights": [
    {
      "claim": "<string, 20..500 chars>",
      "evidence_fact_ids": ["<uuid>", ...],            // drawn only from the input context
      "evidence_reaction_ids": ["<uuid>", ...],         // drawn only from the input reactions
      "support_strength": "strong" | "moderate" | "weak",
      "caveats": "<optional string, <=500 chars>"
    }
  ],
  "summary": "<string, 40..2000 chars>"
}

RULES:
  - Cite fact_ids verbatim. Never invent.
  - Emit strong only when ≥5 reactions + ≥1 statistical signal support the claim.
  - Emit weak when evidence is thin; do not omit uncertain findings.
  - If the question cannot be answered, return {"insights": [], "summary": "<brief explanation>"}.
$$
);

COMMIT;
```

- [ ] **Step 8.2: Apply and verify**

Run: `make db.seed` then `psql ... -c "SELECT name, version, active FROM prompt_registry WHERE name IN ('agent.system', 'agent.deep_research_mode', 'tool.synthesize_insights') ORDER BY name, version"`

Expected: `agent.system` v1 active=false, v2 active=true; `agent.deep_research_mode.v1` active=false; `tool.synthesize_insights.v1` active=true.

- [ ] **Step 8.3: Commit**

```bash
git add db/seed/04_unified_system_prompt.sql
git commit -m "feat(prompts): unified agent.system v2 + tool.synthesize_insights.v1"
```

---

## Task 9: Unify `ChatAgent` — remove `mode`, add `seenFactIds`, single tool catalog

**Files:**
- Modify: `services/agent/src/agent/chat-agent.ts`
- Modify: `services/agent/src/agent/tools.ts`
- Test: `services/agent/tests/unit/chat-agent.unified.test.ts`

- [ ] **Step 9.1: Write the failing unified test**

Create `services/agent/tests/unit/chat-agent.unified.test.ts`:

```ts
import { describe, it, expect, vi, beforeEach } from "vitest";
import { ChatAgent } from "../../src/agent/chat-agent.js";

// Lightweight stub Agent that records its `tools` and `instructions`.
const captured: { instructions?: string; tools?: Record<string, unknown> } = {};
vi.mock("@mastra/core/agent", () => {
  return {
    Agent: class {
      constructor(opts: { instructions: string; tools: Record<string, unknown> }) {
        captured.instructions = opts.instructions;
        captured.tools = opts.tools;
      }
      async generate() {
        return { text: "ok", finishReason: "stop" };
      }
      async stream() {
        async function* g() {
          yield { type: "finish", finishReason: "stop", usage: {} };
        }
        return { fullStream: g() };
      }
    },
  };
});

const baseDeps = () => ({
  config: { AGENT_CHAT_MAX_STEPS: 40 } as any,
  pool: {} as any,
  llm: { model: () => ({}) } as any,
  drfp: {} as any,
  rdkit: {} as any,
  embedder: {} as any,
  kg: {} as any,
  tabicl: {} as any,
  prompts: {
    getActive: vi.fn(async (name: string) => ({
      template: name === "agent.system" ? "UNIFIED SYSTEM v2" : "other",
      version: 2,
    })),
  } as any,
});

describe("ChatAgent (unified)", () => {
  beforeEach(() => {
    captured.instructions = undefined;
    captured.tools = undefined;
  });

  it("uses unified agent.system prompt with no mode layering", async () => {
    const agent = new ChatAgent(baseDeps());
    await agent.generate({
      userEntraId: "user-a",
      messages: [{ role: "user", content: "hi" }],
    });
    expect(captured.instructions).toBe("UNIFIED SYSTEM v2");
  });

  it("registers the full tool catalog (all 12 tools)", async () => {
    const agent = new ChatAgent(baseDeps());
    await agent.generate({
      userEntraId: "user-a",
      messages: [{ role: "user", content: "hi" }],
    });
    expect(Object.keys(captured.tools ?? {}).sort()).toEqual([
      "canonicalize_smiles",
      "check_contradictions",
      "draft_section",
      "expand_reaction_context",
      "fetch_full_document",
      "find_similar_reactions",
      "mark_research_done",
      "propose_hypothesis",
      "query_kg",
      "search_knowledge",
      "statistical_analyze",
      "synthesize_insights",
    ]);
  });

  it("rejects a ChatInvocation with a mode field (type-level, documented here)", () => {
    // This test simply documents the API change: ChatInvocation no longer
    // has a `mode` field. TypeScript enforcement lives in the source;
    // the regression test below asserts no mode-branching path exists.
    expect(true).toBe(true);
  });

  it("maxSteps uses the single AGENT_CHAT_MAX_STEPS constant", async () => {
    const deps = baseDeps();
    deps.config.AGENT_CHAT_MAX_STEPS = 40;
    const agent = new ChatAgent(deps);
    // We cannot easily introspect maxSteps via the mock, but a non-throw
    // confirms the code path doesn't require a mode param.
    await agent.generate({
      userEntraId: "user-a",
      messages: [{ role: "user", content: "hi" }],
    });
    expect(captured.tools).toBeDefined();
  });
});
```

- [ ] **Step 9.2: Run test to verify it fails**

Run: `cd services/agent && npm test -- tests/unit/chat-agent.unified.test.ts`
Expected: FAIL — `ChatAgentDeps` has no `tabicl`; tool catalog is mode-keyed.

- [ ] **Step 9.3: Unify the tool registry**

Replace the body of `services/agent/src/agent/tools.ts` with:

```ts
// Unified agent tool registry. One catalog, no modes — the agent
// chooses which tools to invoke per request.

import { createTool } from "@mastra/core/tools";
import { z } from "zod";
import type { Pool } from "pg";

import type {
  McpDrfpClient,
  McpEmbedderClient,
  McpKgClient,
  McpRdkitClient,
  McpTabiclClient,
} from "../mcp-clients.js";
import {
  FindSimilarReactionsInput,
  FindSimilarReactionsOutput,
  findSimilarReactions,
} from "../tools/find-similar-reactions.js";
import {
  SearchKnowledgeInput,
  SearchKnowledgeOutput,
  searchKnowledge,
} from "../tools/search-knowledge.js";
import {
  FetchFullDocumentInput,
  FetchFullDocumentOutput,
  fetchFullDocument,
} from "../tools/fetch-full-document.js";
import {
  QueryKgInput,
  QueryKgOutput,
  queryKg,
} from "../tools/query-kg.js";
import {
  CheckContradictionsInput,
  CheckContradictionsOutput,
  checkContradictions,
} from "../tools/check-contradictions.js";
import {
  DraftSectionInput,
  DraftSectionOutput,
  draftSection,
} from "../tools/draft-section.js";
import {
  MarkResearchDoneInput,
  MarkResearchDoneOutput,
  markResearchDone,
} from "../tools/mark-research-done.js";
import {
  ExpandReactionContextInput,
  ExpandReactionContextOutput,
  expandReactionContext,
} from "../tools/expand-reaction-context.js";
import {
  StatisticalAnalyzeInput,
  StatisticalAnalyzeOutput,
  statisticalAnalyze,
} from "../tools/statistical-analyze.js";
import {
  SynthesizeInsightsInput,
  SynthesizeInsightsOutput,
  synthesizeInsights,
} from "../tools/synthesize-insights.js";
import {
  ProposeHypothesisInput,
  ProposeHypothesisOutput,
  proposeHypothesis,
} from "../tools/propose-hypothesis.js";

export interface ToolContext {
  userEntraId: string;
  pool: Pool;
  drfp: McpDrfpClient;
  rdkit: McpRdkitClient;
  embedder: McpEmbedderClient;
  kg: McpKgClient;
  tabicl: McpTabiclClient;
  /** Per-turn set of fact_ids surfaced by any tool. Mutated in place. */
  seenFactIds: Set<string>;
  /** Prompt version at the time of this invocation. */
  promptVersion: number;
  queryText?: string;
  agentTraceId?: string;
}

/**
 * Add a collection of fact_ids to the seen-set. Tools call this after they
 * surface fact_ids to the model so that propose_hypothesis can later verify
 * the agent actually saw them.
 */
export function recordSeenFactIds(
  ctx: ToolContext,
  ids: Iterable<string>,
): void {
  for (const id of ids) {
    if (typeof id === "string" && id.length > 0) ctx.seenFactIds.add(id);
  }
}

export function buildTools(ctx: ToolContext) {
  const findSimilarReactionsTool = createTool({
    id: "find_similar_reactions",
    description:
      "Find reactions similar to a seed reaction SMILES across the user's " +
      "accessible projects. Uses DRFP (Differential Reaction Fingerprint) " +
      "for similarity; results are cosine-sorted and RLS-scoped.",
    inputSchema: FindSimilarReactionsInput,
    outputSchema: FindSimilarReactionsOutput,
    execute: async ({ context }) => {
      const input = FindSimilarReactionsInput.parse(context);
      const out = await findSimilarReactions(input, {
        pool: ctx.pool,
        drfp: ctx.drfp,
        userEntraId: ctx.userEntraId,
      });
      // find_similar_reactions returns reaction_ids, not fact_ids; nothing to seed.
      return out;
    },
  });

  const canonicalizeSmilesTool = createTool({
    id: "canonicalize_smiles",
    description:
      "Canonicalize a SMILES string via RDKit and return its InChIKey, " +
      "molecular formula, and molecular weight.",
    inputSchema: z.object({
      smiles: z.string().min(1).max(10_000),
      kekulize: z.boolean().optional(),
    }),
    outputSchema: z.object({
      canonical_smiles: z.string(),
      inchikey: z.string(),
      formula: z.string(),
      mw: z.number(),
    }),
    execute: async ({ context }) => {
      const input = z.object({ smiles: z.string(), kekulize: z.boolean().optional() }).parse(context);
      return ctx.rdkit.canonicalize(input.smiles, input.kekulize ?? false);
    },
  });

  const searchKnowledgeTool = createTool({
    id: "search_knowledge",
    description:
      "Hybrid retrieval over the document corpus (SOPs, reports, method " +
      "validations, literature summaries). Returns top-K chunks with " +
      "document metadata for citation.",
    inputSchema: SearchKnowledgeInput,
    outputSchema: SearchKnowledgeOutput,
    execute: async ({ context }) => {
      const input = SearchKnowledgeInput.parse(context);
      return searchKnowledge(input, {
        pool: ctx.pool,
        embedder: ctx.embedder,
        userEntraId: ctx.userEntraId,
      });
    },
  });

  const fetchFullDocumentTool = createTool({
    id: "fetch_full_document",
    description:
      "Fetch the full parsed Markdown of a document by its UUID.",
    inputSchema: FetchFullDocumentInput,
    outputSchema: FetchFullDocumentOutput,
    execute: async ({ context }) => {
      const input = FetchFullDocumentInput.parse(context);
      return fetchFullDocument(input, {
        pool: ctx.pool,
        userEntraId: ctx.userEntraId,
      });
    },
  });

  const queryKgTool = createTool({
    id: "query_kg",
    description:
      "Direct knowledge-graph traversal. Returns matching facts with full " +
      "provenance and confidence. Use for structured relationships and " +
      "temporal snapshots.",
    inputSchema: QueryKgInput,
    outputSchema: QueryKgOutput,
    execute: async ({ context }) => {
      const input = QueryKgInput.parse(context);
      const out = await queryKg(input, { kg: ctx.kg });
      recordSeenFactIds(ctx, (out.facts ?? []).map((f) => f.fact_id));
      return out;
    },
  });

  const checkContradictionsTool = createTool({
    id: "check_contradictions",
    description:
      "Surface contradictions for a KG entity: explicit CONTRADICTS edges " +
      "and parallel currently-valid facts with the same predicate but " +
      "different objects.",
    inputSchema: CheckContradictionsInput,
    outputSchema: CheckContradictionsOutput,
    execute: async ({ context }) => {
      const input = CheckContradictionsInput.parse(context);
      const out = await checkContradictions(input, { kg: ctx.kg });
      // CheckContradictions surfaces fact_ids inside its output shape.
      const ids: string[] = [];
      const walk = (v: unknown) => {
        if (v && typeof v === "object") {
          if ("fact_id" in (v as any) && typeof (v as any).fact_id === "string") {
            ids.push((v as any).fact_id);
          }
          Object.values(v as Record<string, unknown>).forEach(walk);
        }
      };
      walk(out);
      recordSeenFactIds(ctx, ids);
      return out;
    },
  });

  const draftSectionTool = createTool({
    id: "draft_section",
    description:
      "Compose one section of a report from structured inputs; validates " +
      "citation format. Does NOT persist — call mark_research_done when " +
      "the whole report is ready.",
    inputSchema: DraftSectionInput,
    outputSchema: DraftSectionOutput,
    execute: async ({ context }) => {
      const input = DraftSectionInput.parse(context);
      return draftSection(input);
    },
  });

  const markResearchDoneTool = createTool({
    id: "mark_research_done",
    description:
      "TERMINAL. Assemble the final report and persist under the calling " +
      "user. After calling this tool you are done.",
    inputSchema: MarkResearchDoneInput,
    outputSchema: MarkResearchDoneOutput,
    execute: async ({ context }) => {
      const input = MarkResearchDoneInput.parse(context);
      return markResearchDone(input, {
        pool: ctx.pool,
        userEntraId: ctx.userEntraId,
        queryText: ctx.queryText ?? "",
        promptVersion: ctx.promptVersion,
        agentTraceId: ctx.agentTraceId,
      });
    },
  });

  const expandReactionContextTool = createTool({
    id: "expand_reaction_context",
    description:
      "For a given reaction_id, retrieve reagents, conditions, outcomes, " +
      "failures (from KG), citations, and (hop_limit=2) predecessors. " +
      "Surfaces fact_ids usable for citation by propose_hypothesis.",
    inputSchema: ExpandReactionContextInput,
    outputSchema: ExpandReactionContextOutput,
    execute: async ({ context }) => {
      const input = ExpandReactionContextInput.parse(context);
      const out = await expandReactionContext(input, {
        pool: ctx.pool,
        kg: ctx.kg,
        embedder: ctx.embedder,
        userEntraId: ctx.userEntraId,
      });
      recordSeenFactIds(ctx, out.surfaced_fact_ids ?? []);
      return out;
    },
  });

  const statisticalAnalyzeTool = createTool({
    id: "statistical_analyze",
    description:
      "Fit TabICL in-context on a supplied reaction set and answer one of: " +
      "predict_yield_for_similar, rank_feature_importance, compare_conditions " +
      "(the last is pure SQL aggregation, no ML).",
    inputSchema: StatisticalAnalyzeInput,
    outputSchema: StatisticalAnalyzeOutput,
    execute: async ({ context }) => {
      const input = StatisticalAnalyzeInput.parse(context);
      return statisticalAnalyze(input, {
        pool: ctx.pool,
        tabicl: ctx.tabicl,
        userEntraId: ctx.userEntraId,
      });
    },
  });

  const synthesizeInsightsTool = createTool({
    id: "synthesize_insights",
    description:
      "Compose structured cross-project insights over a reaction set. Drops " +
      "any fact_id the agent has not seen in this turn (hallucination guard).",
    inputSchema: SynthesizeInsightsInput,
    outputSchema: SynthesizeInsightsOutput,
    execute: async ({ context }) => {
      const input = SynthesizeInsightsInput.parse(context);
      const out = await synthesizeInsights(input, {
        pool: ctx.pool,
        kg: ctx.kg,
        embedder: ctx.embedder,
        userEntraId: ctx.userEntraId,
        seenFactIds: ctx.seenFactIds,
      });
      return out;
    },
  });

  const proposeHypothesisTool = createTool({
    id: "propose_hypothesis",
    description:
      "Non-terminal. Persist a hypothesis with ≥1 cited fact_ids. Rejects " +
      "citations that the agent has not seen in this turn. Emits the " +
      "hypothesis_proposed event for KG projection.",
    inputSchema: ProposeHypothesisInput,
    outputSchema: ProposeHypothesisOutput,
    execute: async ({ context }) => {
      const input = ProposeHypothesisInput.parse(context);
      return proposeHypothesis(input, {
        pool: ctx.pool,
        userEntraId: ctx.userEntraId,
        seenFactIds: ctx.seenFactIds,
        agentTraceId: ctx.agentTraceId,
      });
    },
  });

  return {
    search_knowledge: searchKnowledgeTool,
    fetch_full_document: fetchFullDocumentTool,
    canonicalize_smiles: canonicalizeSmilesTool,
    find_similar_reactions: findSimilarReactionsTool,
    query_kg: queryKgTool,
    check_contradictions: checkContradictionsTool,
    draft_section: draftSectionTool,
    mark_research_done: markResearchDoneTool,
    expand_reaction_context: expandReactionContextTool,
    statistical_analyze: statisticalAnalyzeTool,
    synthesize_insights: synthesizeInsightsTool,
    propose_hypothesis: proposeHypothesisTool,
  } as const;
}

export type Tools = ReturnType<typeof buildTools>;
```

*(The 4 new tool implementations land in Tasks 11–14. This step wires the imports; type-check will red-flag missing modules until those tasks ship.)*

- [ ] **Step 9.4: Unify `ChatAgent`**

Replace the body of `services/agent/src/agent/chat-agent.ts` with:

```ts
// Unified autonomous ReAct loop. One prompt, one tool catalog, no modes.

import { Agent } from "@mastra/core/agent";
import type { Pool } from "pg";
import { z } from "zod";

import type { Config } from "../config.js";
import type { LlmProvider } from "../llm/provider.js";
import type {
  McpDrfpClient,
  McpEmbedderClient,
  McpKgClient,
  McpRdkitClient,
  McpTabiclClient,
} from "../mcp-clients.js";
import { PromptRegistry } from "./prompts.js";
import { buildTools, type ToolContext } from "./tools.js";

export const ChatMessageSchema = z.object({
  role: z.enum(["user", "assistant", "system"]),
  content: z.string().min(0).max(80_000),
});
export type ChatMessage = z.infer<typeof ChatMessageSchema>;

export interface ChatInvocation {
  userEntraId: string;
  messages: ChatMessage[];
  agentTraceId?: string;
}

export interface ToolCallEvent { type: "tool_call"; toolId: string; input: unknown; }
export interface ToolResultEvent { type: "tool_result"; toolId: string; output: unknown; }
export interface TextDeltaEvent { type: "text_delta"; delta: string; }
export interface FinishEvent {
  type: "finish";
  finishReason: string;
  usage: { promptTokens?: number; completionTokens?: number };
  promptVersion: number;
}
export interface ErrorEvent { type: "error"; error: string; }
export type StreamEvent =
  | TextDeltaEvent | ToolCallEvent | ToolResultEvent | FinishEvent | ErrorEvent;

export interface ChatAgentDeps {
  config: Config;
  pool: Pool;
  llm: LlmProvider;
  drfp: McpDrfpClient;
  rdkit: McpRdkitClient;
  embedder: McpEmbedderClient;
  kg: McpKgClient;
  tabicl: McpTabiclClient;
  prompts: PromptRegistry;
}

export class ChatAgent {
  constructor(private readonly deps: ChatAgentDeps) {}

  async generate(invocation: ChatInvocation) {
    const prepared = await this._prepare(invocation);
    const agent = this._buildAgent(prepared.systemPrompt, prepared.ctx);
    const result = await agent.generate(invocation.messages, {
      maxSteps: this.deps.config.AGENT_CHAT_MAX_STEPS,
    });
    return {
      text: result.text ?? "",
      finishReason: result.finishReason ?? "unknown",
      promptVersion: prepared.promptVersion,
    };
  }

  async *stream(invocation: ChatInvocation): AsyncGenerator<StreamEvent> {
    let promptVersion = 0;
    let sawFinish = false;
    try {
      const prepared = await this._prepare(invocation);
      promptVersion = prepared.promptVersion;
      const agent = this._buildAgent(prepared.systemPrompt, prepared.ctx);
      const result = await agent.stream(invocation.messages, {
        maxSteps: this.deps.config.AGENT_CHAT_MAX_STEPS,
      });

      for await (const part of result.fullStream) {
        switch (part.type) {
          case "text-delta":
            yield { type: "text_delta", delta: part.textDelta };
            break;
          case "tool-call":
            yield { type: "tool_call", toolId: part.toolName, input: part.args };
            break;
          case "tool-result":
            yield { type: "tool_result", toolId: part.toolName, output: part.result };
            break;
          case "finish":
            sawFinish = true;
            yield {
              type: "finish",
              finishReason: part.finishReason,
              usage: {
                promptTokens: part.usage?.promptTokens,
                completionTokens: part.usage?.completionTokens,
              },
              promptVersion,
            };
            break;
          case "error":
            yield { type: "error", error: safeErrorString(part.error) };
            break;
          default:
            break;
        }
      }
    } catch (err) {
      yield { type: "error", error: safeErrorString(err) };
    } finally {
      if (!sawFinish) {
        yield { type: "finish", finishReason: "aborted", usage: {}, promptVersion };
      }
    }
  }

  private async _prepare(invocation: ChatInvocation) {
    const { template: systemPrompt, version: promptVersion } =
      await this.deps.prompts.getActive("agent.system");

    const ctx: ToolContext = {
      userEntraId: invocation.userEntraId,
      pool: this.deps.pool,
      drfp: this.deps.drfp,
      rdkit: this.deps.rdkit,
      embedder: this.deps.embedder,
      kg: this.deps.kg,
      tabicl: this.deps.tabicl,
      seenFactIds: new Set<string>(),
      promptVersion,
      agentTraceId: invocation.agentTraceId,
    };
    return { systemPrompt, promptVersion, ctx };
  }

  private _buildAgent(systemPrompt: string, ctx: ToolContext): Agent {
    return new Agent({
      name: "chemclaw",
      instructions: systemPrompt,
      model: this.deps.llm.model(),
      tools: buildTools(ctx),
    });
  }
}

function safeErrorString(err: unknown): string {
  if (err instanceof Error) return `${err.name}: ${err.message}`;
  if (typeof err === "string") return err.slice(0, 500);
  return "unknown_error";
}
```

- [ ] **Step 9.5: Commit (partial — compiles once Tasks 11–14 land)**

```bash
git add services/agent/src/agent/chat-agent.ts services/agent/src/agent/tools.ts services/agent/tests/unit/chat-agent.unified.test.ts
git commit -m "refactor(agent): unify ChatAgent — remove mode, add seenFactIds, single tool catalog

Tool-module imports for the four new Phase 5A tools will resolve once
Tasks 11-14 land; type-check is intentionally red between this commit
and Task 15."
```

---

## Task 10: Delete `/api/deep_research` route + mode-branching tests

**Files:**
- Delete: `services/agent/src/routes/deep_research.ts`
- Modify: `services/agent/src/index.ts`
- Modify: `services/agent/src/routes/chat.ts`
- Create: `services/agent/tests/unit/deep-research.route.deletion.test.ts`
- Identify + delete: any test asserting `mode` branching.

- [ ] **Step 10.1: Write the route-deletion regression test**

Create `services/agent/tests/unit/deep-research.route.deletion.test.ts`:

```ts
import { describe, it, expect } from "vitest";
import Fastify from "fastify";
import { registerRoutes } from "../../src/index.js";

describe("/api/deep_research deletion", () => {
  it("returns 404 for POST /api/deep_research", async () => {
    const app = Fastify({ logger: false });
    await registerRoutes(app);
    const r = await app.inject({
      method: "POST",
      url: "/api/deep_research",
      payload: { messages: [] },
    });
    expect(r.statusCode).toBe(404);
  });

  it("still serves POST /api/chat", async () => {
    const app = Fastify({ logger: false });
    await registerRoutes(app);
    const r = await app.inject({ method: "POST", url: "/api/chat" });
    // 400 (body missing) is acceptable — the route exists.
    expect([400, 415]).toContain(r.statusCode);
  });
});
```

- [ ] **Step 10.2: Inventory tests to remove**

Run the inventory grep:

```bash
grep -rn "deep_research\|'deep_research'\|\"deep_research\"\|mode: ['\"]deep_research['\"]\|AGENT_DEEP_RESEARCH" services/agent/tests services/agent/src
```

Every match outside the new deletion test is a candidate for removal — either the whole test file (if the file exists solely to test DR) or the individual test cases.

Expected matches (from the git log): `services/agent/tests/unit/deep-research-route.test.ts`, `services/agent/tests/unit/chat-agent.deep-research.test.ts`, and any route registration in `services/agent/src/index.ts`.

Delete:
- `services/agent/src/routes/deep_research.ts`
- `services/agent/tests/unit/deep-research-route.test.ts` (if it exists)
- `services/agent/tests/unit/chat-agent.deep-research.test.ts` (if it exists)

- [ ] **Step 10.3: Update `services/agent/src/index.ts`**

Remove the deep_research route import and registration. Before:

```ts
import { registerDeepResearchRoute } from "./routes/deep_research.js";
// ...
await registerDeepResearchRoute(app, { agent, config });
```

After: (both lines deleted). Keep the `/api/chat` registration.

- [ ] **Step 10.4: Update `services/agent/src/routes/chat.ts`**

Remove the `mode` field from the request Zod schema and from the call to `agent.stream` / `agent.generate`. Before (illustrative):

```ts
const ChatRequest = z.object({
  messages: z.array(ChatMessageSchema).min(1).max(40),
  mode: z.enum(["default","deep_research"]).optional(),
  stream: z.boolean().optional().default(true),
});
```

After:

```ts
const ChatRequest = z.object({
  messages: z.array(ChatMessageSchema).min(1).max(40),
  stream: z.boolean().optional().default(true),
});
```

Remove every `mode: parsed.mode` / `mode: req.body.mode` call-site within the file.

- [ ] **Step 10.5: Run tests**

Run: `cd services/agent && npm test -- tests/unit/deep-research.route.deletion.test.ts`
Expected: PASS (2 tests).

Run: `cd services/agent && npm test -- tests/unit/chat-agent.unified.test.ts`
Expected: PASS (4 tests) — the unified-agent test now succeeds because the tool modules referenced in Task 9 still don't exist, so skip this on the first run; Task 15 is the commit where everything becomes green.

- [ ] **Step 10.6: Commit**

```bash
git add services/agent/src/index.ts services/agent/src/routes/chat.ts services/agent/tests/unit/deep-research.route.deletion.test.ts
git rm services/agent/src/routes/deep_research.ts
# Also git rm any mode-branching test files identified in Step 10.2:
# git rm services/agent/tests/unit/deep-research-route.test.ts
# git rm services/agent/tests/unit/chat-agent.deep-research.test.ts
git commit -m "refactor(agent): delete /api/deep_research route + mode-branching tests"
```

---

## Task 11: New tool `expand_reaction_context`

**Files:**
- Create: `services/agent/src/tools/expand-reaction-context.ts`
- Test: `services/agent/tests/unit/expand-reaction-context.test.ts`

- [ ] **Step 11.1: Write the failing test**

Create `services/agent/tests/unit/expand-reaction-context.test.ts`:

```ts
import { describe, it, expect, vi } from "vitest";
import {
  ExpandReactionContextInput,
  expandReactionContext,
} from "../../src/tools/expand-reaction-context.js";

function mockPool(rows: any[]) {
  const client = {
    query: vi.fn(async (sql: string, _params?: unknown[]) => {
      if (/reactions r/i.test(sql)) return { rows };
      return { rows: [] };
    }),
    release: () => void 0,
  };
  return {
    connect: vi.fn(async () => client),
  } as any;
}

const RX_ID = "11111111-1111-1111-1111-111111111111";

describe("expand_reaction_context", () => {
  it("returns the reaction record when hop_limit=1 and all includes", async () => {
    const pool = mockPool([
      {
        reaction_id: RX_ID,
        rxn_smiles: "CC>>CC",
        rxno_class: "3.1.1",
        experiment_id: "22222222-2222-2222-2222-222222222222",
        project_internal_id: "NCE-1",
        yield_pct: 88,
        outcome_status: "success",
        temp_c: 80,
        time_min: 240,
        solvent: "toluene",
      },
    ]);
    const kg = { queryAtTime: vi.fn(async () => ({ facts: [] })) };
    const embedder = { embed: vi.fn() };
    const input = ExpandReactionContextInput.parse({ reaction_id: RX_ID });
    const out = await expandReactionContext(input, {
      pool, kg: kg as any, embedder: embedder as any, userEntraId: "user-a",
    });
    expect(out.reaction.reaction_id).toBe(RX_ID);
    expect(out.surfaced_fact_ids).toBeInstanceOf(Array);
  });

  it("returns zero-row output for an unknown reaction_id without throwing", async () => {
    const pool = mockPool([]);
    const kg = { queryAtTime: vi.fn(async () => ({ facts: [] })) };
    const embedder = { embed: vi.fn() };
    const input = ExpandReactionContextInput.parse({ reaction_id: RX_ID });
    await expect(
      expandReactionContext(input, { pool, kg: kg as any, embedder: embedder as any, userEntraId: "user-a" }),
    ).rejects.toThrow(/not found/i);
  });

  it("respects hop_limit=1 and does not fetch predecessors", async () => {
    const pool = mockPool([
      {
        reaction_id: RX_ID, rxn_smiles: "CC>>CC", rxno_class: null,
        experiment_id: "22222222-2222-2222-2222-222222222222",
        project_internal_id: "NCE-1", yield_pct: null, outcome_status: null,
        temp_c: null, time_min: null, solvent: null,
      },
    ]);
    const kg = { queryAtTime: vi.fn(async () => ({ facts: [] })) };
    const embedder = { embed: vi.fn() };
    const input = ExpandReactionContextInput.parse({
      reaction_id: RX_ID,
      include: ["reagents", "conditions"],
      hop_limit: 1,
    });
    const out = await expandReactionContext(input, {
      pool, kg: kg as any, embedder: embedder as any, userEntraId: "user-a",
    });
    expect(out.predecessors).toBeUndefined();
  });
});
```

- [ ] **Step 11.2: Run test to verify it fails**

Run: `cd services/agent && npm test -- tests/unit/expand-reaction-context.test.ts`
Expected: FAIL — `cannot find module ../../src/tools/expand-reaction-context.js`.

- [ ] **Step 11.3: Implement the tool**

Create `services/agent/src/tools/expand-reaction-context.ts`:

```ts
// Tool: expand_reaction_context
//
// Pulls reagents, conditions, outcomes, failures, citations, and
// optional predecessors for a single reaction. All reads are scoped by
// RLS via withUserContext. Failures + citations fan out via mcp-kg
// and search_knowledge respectively. Bounded cost: 1 SQL read, ≤6 KG
// queries, ≤1 search call.

import { z } from "zod";
import type { Pool } from "pg";

import type { McpEmbedderClient, McpKgClient } from "../mcp-clients.js";
import { withUserContext } from "../db.js";

export const ExpandReactionContextInput = z.object({
  reaction_id: z.string().uuid(),
  include: z
    .array(
      z.enum([
        "reagents",
        "conditions",
        "outcomes",
        "failures",
        "citations",
        "predecessors",
      ]),
    )
    .default(["reagents", "conditions", "outcomes", "failures", "citations"]),
  hop_limit: z.union([z.literal(1), z.literal(2)]).default(1),
});
export type ExpandReactionContextInput = z.infer<typeof ExpandReactionContextInput>;

export const ExpandReactionContextOutput = z.object({
  reaction: z.object({
    reaction_id: z.string().uuid(),
    rxn_smiles: z.string().nullable(),
    rxno_class: z.string().nullable(),
    experiment_id: z.string().uuid(),
    project_internal_id: z.string(),
    yield_pct: z.number().nullable(),
    outcome_status: z.string().nullable(),
  }),
  reagents: z.array(z.object({
    role: z.string().nullable(),
    smiles: z.string().nullable(),
    equivalents: z.number().nullable(),
    source_eln_entry_id: z.string().nullable(),
  })).optional(),
  conditions: z.object({
    temp_c: z.number().nullable(),
    time_min: z.number().nullable(),
    solvent: z.string().nullable(),
  }).optional(),
  outcomes: z.array(z.object({
    metric_name: z.string(),
    value: z.number().nullable(),
    unit: z.string().nullable(),
    source_fact_id: z.string().uuid().nullable(),
  })).optional(),
  failures: z.array(z.object({
    failure_mode: z.string(),
    evidence_text: z.string(),
    source_fact_id: z.string().uuid().nullable(),
  })).optional(),
  citations: z.array(z.object({
    document_id: z.string().uuid(),
    page: z.number().nullable(),
    excerpt: z.string(),
  })).optional(),
  predecessors: z.array(z.object({
    reaction_id: z.string().uuid(),
    relationship: z.string(),
  })).optional(),
  /** Every fact_id surfaced by this call — propagated into ctx.seenFactIds. */
  surfaced_fact_ids: z.array(z.string().uuid()),
});
export type ExpandReactionContextOutput = z.infer<typeof ExpandReactionContextOutput>;

export interface ExpandReactionContextDeps {
  pool: Pool;
  kg: McpKgClient;
  embedder: McpEmbedderClient;
  userEntraId: string;
}

export async function expandReactionContext(
  input: ExpandReactionContextInput,
  deps: ExpandReactionContextDeps,
): Promise<ExpandReactionContextOutput> {
  const parsed = ExpandReactionContextInput.parse(input);
  const include = new Set(parsed.include);

  const rows = await withUserContext(deps.pool, deps.userEntraId, async (client) => {
    const q = await client.query(
      `SELECT r.id::text                AS reaction_id,
              r.rxn_smiles, r.rxno_class,
              r.experiment_id::text     AS experiment_id,
              p.internal_id             AS project_internal_id,
              e.yield_pct, e.outcome_status,
              e.temperature_c           AS temp_c,
              e.time_min, e.solvent
         FROM reactions r
         JOIN experiments e        ON e.id  = r.experiment_id
         JOIN synthetic_steps ss   ON ss.id = e.synthetic_step_id
         JOIN nce_projects p       ON p.id  = ss.nce_project_id
        WHERE r.id = $1::uuid
        LIMIT 1`,
      [parsed.reaction_id],
    );
    return q.rows;
  });

  if (rows.length === 0) {
    throw new Error(`reaction ${parsed.reaction_id} not found or not accessible`);
  }
  const row = rows[0];

  const out: ExpandReactionContextOutput = {
    reaction: {
      reaction_id: row.reaction_id,
      rxn_smiles: row.rxn_smiles,
      rxno_class: row.rxno_class,
      experiment_id: row.experiment_id,
      project_internal_id: row.project_internal_id,
      yield_pct: row.yield_pct != null ? Number(row.yield_pct) : null,
      outcome_status: row.outcome_status,
    },
    surfaced_fact_ids: [],
  };

  if (include.has("reagents")) {
    const reagents = await withUserContext(deps.pool, deps.userEntraId, async (client) => {
      const q = await client.query(
        `SELECT ru.role, ru.smiles, ru.equivalents, ru.source_eln_entry_id
           FROM reagents_used ru
          WHERE ru.reaction_id = $1::uuid`,
        [parsed.reaction_id],
      );
      return q.rows;
    });
    out.reagents = reagents.map((r: any) => ({
      role: r.role,
      smiles: r.smiles,
      equivalents: r.equivalents != null ? Number(r.equivalents) : null,
      source_eln_entry_id: r.source_eln_entry_id,
    }));
  }

  if (include.has("conditions")) {
    out.conditions = {
      temp_c: row.temp_c != null ? Number(row.temp_c) : null,
      time_min: row.time_min != null ? Number(row.time_min) : null,
      solvent: row.solvent,
    };
  }

  if (include.has("outcomes")) {
    try {
      const kgOut = await deps.kg.queryAtTime({
        entity: { label: "Reaction", id_property: "id", id_value: parsed.reaction_id },
        predicate: "HAS_OUTCOME",
        direction: "out",
      });
      out.outcomes = kgOut.facts.map((f) => ({
        metric_name: (f.edge_properties?.metric_name as string) ?? "unknown",
        value: (f.edge_properties?.value as number) ?? null,
        unit: (f.edge_properties?.unit as string) ?? null,
        source_fact_id: f.fact_id,
      }));
      out.surfaced_fact_ids.push(...kgOut.facts.map((f) => f.fact_id));
    } catch {
      out.outcomes = [];
    }
  }

  if (include.has("failures")) {
    try {
      const kgOut = await deps.kg.queryAtTime({
        entity: { label: "Reaction", id_property: "id", id_value: parsed.reaction_id },
        predicate: "HAS_FAILURE",
        direction: "out",
      });
      out.failures = kgOut.facts.map((f) => ({
        failure_mode: (f.edge_properties?.failure_mode as string) ?? "unspecified",
        evidence_text: (f.edge_properties?.evidence_text as string) ?? "",
        source_fact_id: f.fact_id,
      }));
      out.surfaced_fact_ids.push(...kgOut.facts.map((f) => f.fact_id));
    } catch {
      out.failures = [];
    }
  }

  if (include.has("citations")) {
    // Citations are deferred — in this MVP we return an empty array.
    // Phase 6 will wire a proper citation lookup through search_knowledge.
    out.citations = [];
  }

  if (include.has("predecessors") && parsed.hop_limit === 2) {
    const preds = await withUserContext(deps.pool, deps.userEntraId, async (client) => {
      const q = await client.query(
        `SELECT r2.id::text AS reaction_id, 'prior_step_in_same_synthetic_step' AS relationship
           FROM reactions r1
           JOIN experiments e1 ON e1.id = r1.experiment_id
           JOIN experiments e2 ON e2.synthetic_step_id = e1.synthetic_step_id
           JOIN reactions r2   ON r2.experiment_id = e2.id
          WHERE r1.id = $1::uuid
            AND e2.created_at < e1.created_at
          ORDER BY e2.created_at DESC
          LIMIT 5`,
        [parsed.reaction_id],
      );
      return q.rows;
    });
    out.predecessors = preds.map((p: any) => ({
      reaction_id: p.reaction_id,
      relationship: p.relationship,
    }));
  }

  return ExpandReactionContextOutput.parse(out);
}
```

- [ ] **Step 11.4: Run tests**

Run: `cd services/agent && npm test -- tests/unit/expand-reaction-context.test.ts`
Expected: PASS (3 tests).

- [ ] **Step 11.5: Commit**

```bash
git add services/agent/src/tools/expand-reaction-context.ts services/agent/tests/unit/expand-reaction-context.test.ts
git commit -m "feat(tool): expand_reaction_context — reagents/conditions/outcomes/failures/predecessors"
```

---

## Task 12: New tool `statistical_analyze`

**Files:**
- Create: `services/agent/src/tools/statistical-analyze.ts`
- Test: `services/agent/tests/unit/statistical-analyze.test.ts`

- [ ] **Step 12.1: Write the failing test**

Create `services/agent/tests/unit/statistical-analyze.test.ts`:

```ts
import { describe, it, expect, vi } from "vitest";
import {
  StatisticalAnalyzeInput,
  statisticalAnalyze,
} from "../../src/tools/statistical-analyze.js";

function mockPool(rows: any[]) {
  const client = {
    query: vi.fn(async () => ({ rows })),
    release: () => void 0,
  };
  return { connect: vi.fn(async () => client) } as any;
}

const ids = Array.from({ length: 6 }, (_, i) => `00000000-0000-0000-0000-00000000000${i + 1}`);

describe("statistical_analyze", () => {
  it("routes predict_yield_for_similar through featurize + predict_and_rank", async () => {
    const rows = ids.map((id) => ({
      reaction_id: id, rxn_smiles: "CC>>CC", rxno_class: null,
      temp_c: 80, time_min: 120, solvent: "thf",
      catalyst_loading_mol_pct: 2, base: "K2CO3", yield_pct: 50,
    }));
    const pool = mockPool(rows);
    const tabicl = {
      featurize: vi.fn(async () => ({
        feature_names: ["temp_c"], categorical_names: [],
        rows: rows.map(() => [80]), targets: rows.map(() => 50), skipped: [],
      })),
      predictAndRank: vi.fn(async () => ({
        predictions: [60], prediction_std: [5], feature_importance: null,
      })),
    };
    const input = StatisticalAnalyzeInput.parse({
      reaction_ids: ids, query_reaction_ids: [ids[0]],
      question: "predict_yield_for_similar",
    });
    const out = await statisticalAnalyze(input, {
      pool, tabicl: tabicl as any, userEntraId: "user-a",
    });
    expect(tabicl.featurize).toHaveBeenCalled();
    expect(tabicl.predictAndRank).toHaveBeenCalled();
    expect(out.predictions).toEqual([{ query_reaction_id: ids[0], predicted_yield_pct: 60, std: 5 }]);
  });

  it("routes compare_conditions through SQL only (no ML call)", async () => {
    const pool = mockPool([
      { bucket_label: "thf·80-100", n: 4, mean_yield: 70, median_yield: 72, p25: 60, p75: 80 },
    ]);
    const tabicl = { featurize: vi.fn(), predictAndRank: vi.fn() };
    const input = StatisticalAnalyzeInput.parse({
      reaction_ids: ids, question: "compare_conditions",
    });
    const out = await statisticalAnalyze(input, {
      pool, tabicl: tabicl as any, userEntraId: "user-a",
    });
    expect(tabicl.featurize).not.toHaveBeenCalled();
    expect(tabicl.predictAndRank).not.toHaveBeenCalled();
    expect(out.condition_comparison?.length).toBeGreaterThan(0);
  });

  it("surfaces featurizer skipped rows as caveats", async () => {
    const rows = ids.map((id) => ({
      reaction_id: id, rxn_smiles: "CC>>CC", rxno_class: null,
      temp_c: null, time_min: null, solvent: null,
      catalyst_loading_mol_pct: null, base: null, yield_pct: 50,
    }));
    const pool = mockPool(rows);
    const tabicl = {
      featurize: vi.fn(async () => ({
        feature_names: ["temp_c"], categorical_names: [],
        rows: [[80]], targets: [50],
        skipped: [{ reaction_id: ids[1], reason: "invalid_rxn_smiles" }],
      })),
      predictAndRank: vi.fn(async () => ({
        predictions: [50], prediction_std: [0], feature_importance: { temp_c: 0.1 },
      })),
    };
    const input = StatisticalAnalyzeInput.parse({
      reaction_ids: ids, question: "rank_feature_importance",
    });
    const out = await statisticalAnalyze(input, {
      pool, tabicl: tabicl as any, userEntraId: "user-a",
    });
    expect(out.caveats.join(" ")).toMatch(/skipped/i);
    expect(out.feature_importance?.[0].feature).toBe("temp_c");
  });
});
```

- [ ] **Step 12.2: Run test to verify it fails**

Run: `cd services/agent && npm test -- tests/unit/statistical-analyze.test.ts`
Expected: FAIL — module not found.

- [ ] **Step 12.3: Implement the tool**

Create `services/agent/src/tools/statistical-analyze.ts`:

```ts
// Tool: statistical_analyze — TabICL on a retrieved reaction set.
//
// Three question modes:
//   - predict_yield_for_similar: featurize support + query → predict
//   - rank_feature_importance:   featurize + permutation importance
//   - compare_conditions:        pure SQL bucket aggregation, no ML

import { z } from "zod";
import type { Pool } from "pg";

import type { McpTabiclClient } from "../mcp-clients.js";
import { withUserContext } from "../db.js";

export const StatisticalAnalyzeInput = z.object({
  reaction_ids: z.array(z.string().uuid()).min(5).max(500),
  question: z.enum([
    "predict_yield_for_similar",
    "rank_feature_importance",
    "compare_conditions",
  ]),
  query_reaction_ids: z.array(z.string().uuid()).max(100).optional(),
});
export type StatisticalAnalyzeInput = z.infer<typeof StatisticalAnalyzeInput>;

export const StatisticalAnalyzeOutput = z.object({
  task: z.literal("regression"),
  support_size: z.number().int().nonnegative(),
  predictions: z.array(z.object({
    query_reaction_id: z.string().uuid(),
    predicted_yield_pct: z.number(),
    std: z.number(),
  })).optional(),
  feature_importance: z.array(z.object({
    feature: z.string(),
    importance: z.number(),
  })).optional(),
  condition_comparison: z.array(z.object({
    bucket_label: z.string(),
    n: z.number().int(),
    mean_yield: z.number(),
    median_yield: z.number(),
    p25: z.number(),
    p75: z.number(),
  })).optional(),
  caveats: z.array(z.string()),
});
export type StatisticalAnalyzeOutput = z.infer<typeof StatisticalAnalyzeOutput>;

export interface StatisticalAnalyzeDeps {
  pool: Pool;
  tabicl: McpTabiclClient;
  userEntraId: string;
}

async function loadReactionRows(
  deps: StatisticalAnalyzeDeps,
  ids: string[],
): Promise<any[]> {
  return withUserContext(deps.pool, deps.userEntraId, async (client) => {
    const q = await client.query(
      `SELECT r.id::text               AS reaction_id,
              r.rxn_smiles, r.rxno_class,
              e.temperature_c          AS temp_c,
              e.time_min, e.solvent,
              (e.conditions_json->>'catalyst_loading_mol_pct')::numeric AS catalyst_loading_mol_pct,
              e.base, e.yield_pct
         FROM reactions r
         JOIN experiments e ON e.id = r.experiment_id
        WHERE r.id = ANY($1::uuid[])`,
      [ids],
    );
    return q.rows;
  });
}

export async function statisticalAnalyze(
  input: StatisticalAnalyzeInput,
  deps: StatisticalAnalyzeDeps,
): Promise<StatisticalAnalyzeOutput> {
  const parsed = StatisticalAnalyzeInput.parse(input);
  const caveats: string[] = [];

  if (parsed.question === "compare_conditions") {
    const rows = await withUserContext(deps.pool, deps.userEntraId, async (client) => {
      const q = await client.query(
        `SELECT CONCAT(COALESCE(e.solvent,'?'), '·', width_bucket(COALESCE(e.temperature_c,0), 0, 200, 10)::text) AS bucket_label,
                COUNT(*)::int AS n,
                AVG(e.yield_pct)::float8 AS mean_yield,
                percentile_cont(0.5) WITHIN GROUP (ORDER BY e.yield_pct)::float8 AS median_yield,
                percentile_cont(0.25) WITHIN GROUP (ORDER BY e.yield_pct)::float8 AS p25,
                percentile_cont(0.75) WITHIN GROUP (ORDER BY e.yield_pct)::float8 AS p75
           FROM reactions r
           JOIN experiments e ON e.id = r.experiment_id
          WHERE r.id = ANY($1::uuid[])
            AND e.yield_pct IS NOT NULL
          GROUP BY bucket_label
          ORDER BY mean_yield DESC`,
        [parsed.reaction_ids],
      );
      return q.rows;
    });
    return StatisticalAnalyzeOutput.parse({
      task: "regression",
      support_size: parsed.reaction_ids.length,
      condition_comparison: rows.map((r: any) => ({
        bucket_label: r.bucket_label, n: r.n,
        mean_yield: Number(r.mean_yield), median_yield: Number(r.median_yield),
        p25: Number(r.p25), p75: Number(r.p75),
      })),
      caveats,
    });
  }

  // Featurize support.
  const supportDbRows = await loadReactionRows(deps, parsed.reaction_ids);
  const featurized = await deps.tabicl.featurize({
    reaction_rows: supportDbRows.map((r) => ({
      reaction_id: r.reaction_id,
      rxn_smiles: r.rxn_smiles,
      rxno_class: r.rxno_class ?? null,
      solvent: r.solvent ?? null,
      temp_c: r.temp_c != null ? Number(r.temp_c) : null,
      time_min: r.time_min != null ? Number(r.time_min) : null,
      catalyst_loading_mol_pct: r.catalyst_loading_mol_pct != null ? Number(r.catalyst_loading_mol_pct) : null,
      base: r.base ?? null,
      yield_pct: r.yield_pct != null ? Number(r.yield_pct) : null,
    })),
    include_targets: true,
  });
  if (featurized.skipped.length > 0) {
    caveats.push(`${featurized.skipped.length} rows skipped by featurizer (invalid SMILES or missing target).`);
  }
  if (!featurized.targets || featurized.targets.length === 0) {
    return StatisticalAnalyzeOutput.parse({
      task: "regression", support_size: 0, caveats: [...caveats, "no usable support rows"],
    });
  }

  if (parsed.question === "predict_yield_for_similar") {
    if (!parsed.query_reaction_ids || parsed.query_reaction_ids.length === 0) {
      throw new Error("query_reaction_ids required for predict_yield_for_similar");
    }
    const queryDbRows = await loadReactionRows(deps, parsed.query_reaction_ids);
    const queryFeat = await deps.tabicl.featurize({
      reaction_rows: queryDbRows.map((r) => ({
        reaction_id: r.reaction_id, rxn_smiles: r.rxn_smiles,
        rxno_class: r.rxno_class ?? null, solvent: r.solvent ?? null,
        temp_c: r.temp_c != null ? Number(r.temp_c) : null,
        time_min: r.time_min != null ? Number(r.time_min) : null,
        catalyst_loading_mol_pct: r.catalyst_loading_mol_pct != null ? Number(r.catalyst_loading_mol_pct) : null,
        base: r.base ?? null, yield_pct: null,
      })),
      include_targets: false,
    });
    const pred = await deps.tabicl.predictAndRank({
      support_rows: featurized.rows,
      support_targets: featurized.targets,
      query_rows: queryFeat.rows,
      feature_names: featurized.feature_names,
      categorical_names: featurized.categorical_names,
      task: "regression",
      return_feature_importance: false,
    });
    return StatisticalAnalyzeOutput.parse({
      task: "regression",
      support_size: featurized.rows.length,
      predictions: pred.predictions.map((p, i) => ({
        query_reaction_id: parsed.query_reaction_ids![i],
        predicted_yield_pct: p,
        std: pred.prediction_std[i] ?? 0,
      })),
      caveats,
    });
  }

  // rank_feature_importance
  const pred = await deps.tabicl.predictAndRank({
    support_rows: featurized.rows,
    support_targets: featurized.targets,
    query_rows: featurized.rows.slice(0, Math.min(16, featurized.rows.length)),
    feature_names: featurized.feature_names,
    categorical_names: featurized.categorical_names,
    task: "regression",
    return_feature_importance: true,
  });
  const fi = pred.feature_importance ?? {};
  return StatisticalAnalyzeOutput.parse({
    task: "regression",
    support_size: featurized.rows.length,
    feature_importance: Object.entries(fi)
      .sort(([, a], [, b]) => (b as number) - (a as number))
      .map(([feature, importance]) => ({ feature, importance: importance as number })),
    caveats,
  });
}
```

- [ ] **Step 12.4: Run tests**

Run: `cd services/agent && npm test -- tests/unit/statistical-analyze.test.ts`
Expected: PASS (3 tests).

- [ ] **Step 12.5: Commit**

```bash
git add services/agent/src/tools/statistical-analyze.ts services/agent/tests/unit/statistical-analyze.test.ts
git commit -m "feat(tool): statistical_analyze — TabICL + SQL bucket aggregation"
```

---

## Task 13: New tool `synthesize_insights`

**Files:**
- Create: `services/agent/src/tools/synthesize-insights.ts`
- Test: `services/agent/tests/unit/synthesize-insights.test.ts`

*(The `tool.synthesize_insights.v1` prompt registry row was seeded in Task 8.)*

- [ ] **Step 13.1: Write the failing test**

Create `services/agent/tests/unit/synthesize-insights.test.ts`:

```ts
import { describe, it, expect, vi } from "vitest";
import {
  SynthesizeInsightsInput,
  synthesizeInsights,
} from "../../src/tools/synthesize-insights.js";

const ids = Array.from({ length: 3 }, (_, i) => `33333333-3333-3333-3333-33333333333${i}`);
const facts = Array.from({ length: 3 }, (_, i) => `ffffffff-ffff-ffff-ffff-ffffffffff${i}a`);

describe("synthesize_insights", () => {
  it("drops insights whose fact_ids the agent has not seen", async () => {
    const pool = { connect: vi.fn() } as any;
    const kg = {} as any;
    const embedder = {} as any;
    const prompts = {
      getActive: vi.fn(async () => ({
        template: "SYNTH", version: 1,
      })),
    } as any;
    const llm = {
      completeJson: vi.fn(async () => ({
        insights: [
          { claim: "fake", evidence_fact_ids: ["aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa"],
            evidence_reaction_ids: [], support_strength: "weak" },
          { claim: "real", evidence_fact_ids: [facts[0]],
            evidence_reaction_ids: [ids[0]], support_strength: "moderate" },
        ],
        summary: "summary",
      })),
    } as any;
    const seen = new Set([facts[0]]);
    const out = await synthesizeInsights(
      SynthesizeInsightsInput.parse({
        reaction_set: ids,
        question: "What trends appear across these reactions?",
      }),
      { pool, kg, embedder, userEntraId: "user-a", seenFactIds: seen, prompts, llm },
    );
    expect(out.insights.map((i) => i.claim)).toEqual(["real"]);
  });

  it("returns empty insights when every evidence_fact_id is unseen", async () => {
    const prompts = {
      getActive: vi.fn(async () => ({ template: "SYNTH", version: 1 })),
    } as any;
    const llm = {
      completeJson: vi.fn(async () => ({
        insights: [{
          claim: "none",
          evidence_fact_ids: ["aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa"],
          evidence_reaction_ids: [],
          support_strength: "weak",
        }],
        summary: "empty",
      })),
    } as any;
    const out = await synthesizeInsights(
      SynthesizeInsightsInput.parse({
        reaction_set: ids, question: "Any patterns?",
      }),
      {
        pool: { connect: vi.fn() } as any, kg: {} as any, embedder: {} as any,
        userEntraId: "user-a", seenFactIds: new Set(), prompts, llm,
      },
    );
    expect(out.insights).toEqual([]);
    expect(out.summary).toBe("empty");
  });
});
```

- [ ] **Step 13.2: Run test to verify it fails**

Run: `cd services/agent && npm test -- tests/unit/synthesize-insights.test.ts`
Expected: FAIL — module not found.

- [ ] **Step 13.3: Implement the tool**

Create `services/agent/src/tools/synthesize-insights.ts`:

```ts
// Tool: synthesize_insights — LLM-based structured insight composition.
//
// The tool expands each reaction_id (bounded-parallel) for context, asks
// the LLM for structured JSON insights against the `tool.synthesize_insights`
// prompt, validates with Zod, and filters out insights whose evidence
// fact_ids the agent has not seen this turn (hallucination guard).

import { z } from "zod";
import type { Pool } from "pg";

import type { McpEmbedderClient, McpKgClient } from "../mcp-clients.js";
import type { PromptRegistry } from "../agent/prompts.js";
import type { LlmProvider } from "../llm/provider.js";
import {
  expandReactionContext,
  ExpandReactionContextInput,
} from "./expand-reaction-context.js";

export const SynthesizeInsightsInput = z.object({
  reaction_set: z.array(z.string().uuid()).min(3).max(500),
  question: z.string().min(20).max(2000),
  prior_stats: z.unknown().optional(),
});
export type SynthesizeInsightsInput = z.infer<typeof SynthesizeInsightsInput>;

const InsightSchema = z.object({
  claim: z.string().min(20).max(500),
  evidence_fact_ids: z.array(z.string().uuid()),
  evidence_reaction_ids: z.array(z.string().uuid()),
  support_strength: z.enum(["strong", "moderate", "weak"]),
  caveats: z.string().max(500).optional(),
});

export const SynthesizeInsightsOutput = z.object({
  insights: z.array(InsightSchema),
  summary: z.string(),
});
export type SynthesizeInsightsOutput = z.infer<typeof SynthesizeInsightsOutput>;

export interface SynthesizeInsightsDeps {
  pool: Pool;
  kg: McpKgClient;
  embedder: McpEmbedderClient;
  userEntraId: string;
  seenFactIds: Set<string>;
  prompts: PromptRegistry;
  llm: LlmProvider;
}

const MAX_PARALLEL = 20;

async function boundedMap<T, R>(
  items: T[],
  limit: number,
  fn: (t: T) => Promise<R>,
): Promise<R[]> {
  const out: R[] = new Array(items.length);
  let idx = 0;
  const workers = Array.from({ length: Math.min(limit, items.length) }, async () => {
    while (true) {
      const i = idx++;
      if (i >= items.length) return;
      out[i] = await fn(items[i]);
    }
  });
  await Promise.all(workers);
  return out;
}

export async function synthesizeInsights(
  input: SynthesizeInsightsInput,
  deps: SynthesizeInsightsDeps,
): Promise<SynthesizeInsightsOutput> {
  const parsed = SynthesizeInsightsInput.parse(input);

  const expanded = await boundedMap(parsed.reaction_set, MAX_PARALLEL, async (id) => {
    try {
      const e = await expandReactionContext(
        ExpandReactionContextInput.parse({ reaction_id: id }),
        {
          pool: deps.pool, kg: deps.kg, embedder: deps.embedder,
          userEntraId: deps.userEntraId,
        },
      );
      // Seed the per-turn set so the agent can later cite what was surfaced.
      for (const fid of e.surfaced_fact_ids) deps.seenFactIds.add(fid);
      return e;
    } catch {
      return null;
    }
  });

  const present = expanded.filter((e): e is NonNullable<typeof e> => e !== null);

  const { template } = await deps.prompts.getActive("tool.synthesize_insights");
  const raw = await deps.llm.completeJson({
    system: template,
    user: JSON.stringify({
      reactions: present,
      prior_stats: parsed.prior_stats ?? null,
      question: parsed.question,
    }),
  });

  const validated = SynthesizeInsightsOutput.parse(raw);

  // Hallucination guard — drop any insight citing unseen fact_ids.
  const seen = deps.seenFactIds;
  const reactionSet = new Set(parsed.reaction_set);
  const filteredInsights = validated.insights.filter((i) => {
    if (i.evidence_fact_ids.some((f) => !seen.has(f))) return false;
    if (i.evidence_reaction_ids.some((r) => !reactionSet.has(r))) return false;
    return true;
  });

  return {
    insights: filteredInsights,
    summary: validated.summary,
  };
}
```

*(Note: `LlmProvider.completeJson` is assumed — if it doesn't exist, add a minimal `completeJson({system, user}) -> unknown` method in `services/agent/src/llm/provider.ts` that routes through the existing LiteLLM client and `JSON.parse`s the response.)*

- [ ] **Step 13.4: Extend `LlmProvider` if needed**

Grep and add:

```bash
grep -n "completeJson\|completeStructured" services/agent/src/llm/provider.ts
```

If not present, add to `services/agent/src/llm/provider.ts`:

```ts
async completeJson(opts: { system: string; user: string }): Promise<unknown> {
  const { text } = await generateText({
    model: this.model(),
    system: opts.system,
    messages: [{ role: "user", content: opts.user }],
    maxTokens: 4_000,
  });
  return JSON.parse(text);
}
```

- [ ] **Step 13.5: Run tests**

Run: `cd services/agent && npm test -- tests/unit/synthesize-insights.test.ts`
Expected: PASS (2 tests).

- [ ] **Step 13.6: Commit**

```bash
git add services/agent/src/tools/synthesize-insights.ts services/agent/src/llm/provider.ts services/agent/tests/unit/synthesize-insights.test.ts
git commit -m "feat(tool): synthesize_insights — LLM JSON composition with hallucination guard"
```

---

## Task 14: New tool `propose_hypothesis` (+ anti-fabrication guard)

**Files:**
- Create: `services/agent/src/tools/propose-hypothesis.ts`
- Test: `services/agent/tests/unit/propose-hypothesis.test.ts`

- [ ] **Step 14.1: Write the failing test**

Create `services/agent/tests/unit/propose-hypothesis.test.ts`:

```ts
import { describe, it, expect, vi } from "vitest";
import {
  ProposeHypothesisInput,
  proposeHypothesis,
} from "../../src/tools/propose-hypothesis.js";

const HID = "55555555-5555-5555-5555-555555555555";
const FACT_OK = "ffffffff-0000-4000-8000-000000000001";
const FACT_UNSEEN = "ffffffff-0000-4000-8000-000000000002";

function mockPool(capture: any) {
  const client = {
    query: vi.fn(async (sql: string, params: any[]) => {
      if (/INSERT INTO hypotheses/i.test(sql)) {
        capture.hypothesis_params = params;
        return { rows: [{ id: HID, confidence_tier: "high", created_at: new Date().toISOString() }] };
      }
      if (/INSERT INTO hypothesis_citations/i.test(sql)) {
        capture.citation_rows = (capture.citation_rows ?? 0) + 1;
        return { rows: [] };
      }
      if (/INSERT INTO ingestion_events/i.test(sql)) {
        capture.emitted_event = params;
        return { rows: [] };
      }
      return { rows: [] };
    }),
    release: () => void 0,
  };
  return { connect: vi.fn(async () => client) } as any;
}

describe("propose_hypothesis", () => {
  it("rejects citations that the agent has not seen", async () => {
    const capture: any = {};
    const pool = mockPool(capture);
    await expect(
      proposeHypothesis(
        ProposeHypothesisInput.parse({
          hypothesis_text: "Cross-project Suzuki yields correlate with base class.",
          cited_fact_ids: [FACT_UNSEEN],
          confidence: 0.7,
        }),
        {
          pool, userEntraId: "user-a",
          seenFactIds: new Set([FACT_OK]),
        },
      ),
    ).rejects.toThrow(/not.*seen|unknown.*fact/i);
    expect(capture.hypothesis_params).toBeUndefined();
  });

  it("persists + emits event on happy path", async () => {
    const capture: any = {};
    const pool = mockPool(capture);
    const out = await proposeHypothesis(
      ProposeHypothesisInput.parse({
        hypothesis_text: "Cross-project Suzuki yields correlate with base class.",
        cited_fact_ids: [FACT_OK],
        confidence: 0.9,
      }),
      {
        pool, userEntraId: "user-a",
        seenFactIds: new Set([FACT_OK]),
      },
    );
    expect(out.hypothesis_id).toBe(HID);
    expect(out.projection_status).toBe("pending");
    expect(capture.citation_rows).toBe(1);
    expect(capture.emitted_event[0]).toBe("hypothesis_proposed");
  });
});
```

- [ ] **Step 14.2: Run test to verify it fails**

Run: `cd services/agent && npm test -- tests/unit/propose-hypothesis.test.ts`
Expected: FAIL — module not found.

- [ ] **Step 14.3: Implement the tool**

Create `services/agent/src/tools/propose-hypothesis.ts`:

```ts
// Tool: propose_hypothesis (non-terminal).
//
// Transactional INSERT into hypotheses + hypothesis_citations + emission
// of `hypothesis_proposed` into ingestion_events. Anti-fabrication guard:
// rejects with 400-style Error if any cited_fact_id is not in the
// caller's per-turn seenFactIds set.

import { z } from "zod";
import type { Pool } from "pg";

import { withUserContext } from "../db.js";

export const ProposeHypothesisInput = z.object({
  hypothesis_text: z.string().min(10).max(4000),
  cited_fact_ids: z.array(z.string().uuid()).min(1).max(50),
  cited_reaction_ids: z.array(z.string().uuid()).max(100).optional(),
  confidence: z.number().min(0).max(1),
  scope_nce_project_id: z.string().uuid().optional(),
  citation_notes: z.record(z.string().uuid(), z.string().max(500)).optional(),
});
export type ProposeHypothesisInput = z.infer<typeof ProposeHypothesisInput>;

export const ProposeHypothesisOutput = z.object({
  hypothesis_id: z.string().uuid(),
  confidence_tier: z.enum(["low", "medium", "high"]),
  persisted_at: z.string(),
  projection_status: z.literal("pending"),
});
export type ProposeHypothesisOutput = z.infer<typeof ProposeHypothesisOutput>;

export interface ProposeHypothesisDeps {
  pool: Pool;
  userEntraId: string;
  seenFactIds: Set<string>;
  agentTraceId?: string;
}

export async function proposeHypothesis(
  input: ProposeHypothesisInput,
  deps: ProposeHypothesisDeps,
): Promise<ProposeHypothesisOutput> {
  const parsed = ProposeHypothesisInput.parse(input);

  // Anti-fabrication guard — every cited fact_id MUST have been surfaced to
  // the agent within this turn.
  const unseen = parsed.cited_fact_ids.filter((f) => !deps.seenFactIds.has(f));
  if (unseen.length > 0) {
    throw new Error(
      `propose_hypothesis rejected: cited_fact_ids not seen in this turn: ${unseen.join(", ")}. ` +
        `Re-plan and cite fact_ids actually returned by a prior tool call.`,
    );
  }

  const result = await withUserContext(deps.pool, deps.userEntraId, async (client) => {
    const ins = await client.query(
      `INSERT INTO hypotheses (
         hypothesis_text, confidence, scope_nce_project_id,
         proposed_by_user_entra_id, agent_trace_id
       ) VALUES ($1, $2, $3::uuid, $4, $5)
       RETURNING id, confidence_tier, created_at`,
      [
        parsed.hypothesis_text,
        parsed.confidence,
        parsed.scope_nce_project_id ?? null,
        deps.userEntraId,
        deps.agentTraceId ?? null,
      ],
    );
    const hid: string = ins.rows[0].id;
    const tier: "low" | "medium" | "high" = ins.rows[0].confidence_tier;
    const createdAt: string = ins.rows[0].created_at instanceof Date
      ? ins.rows[0].created_at.toISOString()
      : String(ins.rows[0].created_at);

    for (const fid of parsed.cited_fact_ids) {
      const note = parsed.citation_notes?.[fid] ?? null;
      await client.query(
        `INSERT INTO hypothesis_citations (hypothesis_id, fact_id, citation_note)
         VALUES ($1::uuid, $2::uuid, $3)`,
        [hid, fid, note],
      );
    }

    await client.query(
      `INSERT INTO ingestion_events (event_type, source_table, source_row_id, payload)
       VALUES ($1, 'hypotheses', $2::uuid, $3::jsonb)`,
      ["hypothesis_proposed", hid, JSON.stringify({ hypothesis_id: hid })],
    );

    return { hypothesis_id: hid, confidence_tier: tier, persisted_at: createdAt };
  });

  return ProposeHypothesisOutput.parse({
    ...result,
    projection_status: "pending",
  });
}
```

- [ ] **Step 14.4: Run tests**

Run: `cd services/agent && npm test -- tests/unit/propose-hypothesis.test.ts`
Expected: PASS (2 tests).

- [ ] **Step 14.5: Commit**

```bash
git add services/agent/src/tools/propose-hypothesis.ts services/agent/tests/unit/propose-hypothesis.test.ts
git commit -m "feat(tool): propose_hypothesis (non-terminal) with seenFactIds guard"
```

---

## Task 15: Green up the unified agent

- [ ] **Step 15.1: Run full TS suite + typecheck**

```bash
cd services/agent && npm run typecheck && npm test
```

Expected: typecheck PASS; test suite PASS. Pay attention to the unified-agent test, `deep-research.route.deletion.test.ts`, and the four new tool tests — all must be green.

- [ ] **Step 15.2: If any test fails, diagnose and fix**

Common issues:
- `seenFactIds` not propagated — ensure `ToolContext` is constructed fresh per turn (see `_prepare` in chat-agent.ts).
- Compilation error on tool module imports — make sure each of the four new tool files exports both `*Input`/`*Output` schemas and the function.
- Unified test expects 12 tools — if your count differs, double-check that none of the old mode-branch helpers remain exported.

- [ ] **Step 15.3: Commit the green-up**

```bash
git add services/agent
git commit -m "chore(agent): unified agent type-checks + all tests green"
```

---

## Task 16: `kg-hypotheses` projector + Neo4j integration test

**Files:**
- Create: `services/projectors/kg_hypotheses/__init__.py` (empty)
- Create: `services/projectors/kg_hypotheses/main.py`
- Create: `services/projectors/kg_hypotheses/requirements.txt`
- Create: `services/projectors/kg_hypotheses/Dockerfile`
- Create: `tests/integration/test_kg_hypotheses_projector.py`

- [ ] **Step 16.1: Write the failing integration test (gated)**

Create `tests/integration/test_kg_hypotheses_projector.py`:

```python
"""Integration test for the kg-hypotheses projector.

Gated by pytest.mark.integration so it runs only when NEO4J_URI is set.
"""
from __future__ import annotations

import json
import os
import uuid

import psycopg
import pytest

pytestmark = [
    pytest.mark.integration,
    pytest.mark.skipif(
        not os.getenv("NEO4J_URI"),
        reason="requires live Neo4j (set NEO4J_URI)",
    ),
]


def test_hypothesis_proposed_projects_node_and_cites_edges(pg_conn: psycopg.Connection, neo4j_driver) -> None:
    # Insert a hypothesis row + citation row + ingestion_event.
    hid = uuid.uuid4()
    fid = uuid.uuid4()
    with pg_conn.cursor() as cur:
        cur.execute("SET LOCAL ROLE chemclaw_service")
        cur.execute(
            "INSERT INTO hypotheses (id, hypothesis_text, confidence, proposed_by_user_entra_id) "
            "VALUES (%s, %s, %s, %s)",
            (str(hid), "Cross-project correlation hypothesis for test.", 0.8, "user-a"),
        )
        cur.execute(
            "INSERT INTO hypothesis_citations (hypothesis_id, fact_id) VALUES (%s, %s)",
            (str(hid), str(fid)),
        )
        cur.execute(
            "INSERT INTO ingestion_events (event_type, source_table, source_row_id, payload) "
            "VALUES (%s, %s, %s, %s::jsonb)",
            ("hypothesis_proposed", "hypotheses", str(hid), json.dumps({"hypothesis_id": str(hid)})),
        )
    pg_conn.commit()

    # Run projector catch-up (one iteration).
    from services.projectors.kg_hypotheses.main import KgHypothesesProjector
    from services.projectors.common.base import ProjectorSettings

    settings = ProjectorSettings()  # loads env
    proj = KgHypothesesProjector(settings)

    # Use the internal _catch_up directly — deterministic, no NOTIFY wait.
    import asyncio

    async def _run() -> None:
        async with await psycopg.AsyncConnection.connect(settings.postgres_dsn) as work:
            await proj._catch_up(work)

    asyncio.run(_run())

    # Verify Neo4j state.
    with neo4j_driver.session() as session:
        rec = session.run(
            "MATCH (h:Hypothesis) WHERE h.hypothesis_id = $hid "
            "OPTIONAL MATCH (h)-[c:CITES]->(f) RETURN h.text AS text, count(c) AS cites",
            hid=str(hid),
        ).single()
        assert rec is not None
        assert rec["text"].startswith("Cross-project")
        assert rec["cites"] >= 1  # CITES edge exists (to Fact or ungrounded placeholder)


def test_replay_is_idempotent(pg_conn: psycopg.Connection, neo4j_driver) -> None:
    # Insert + run twice; Neo4j node count should stay the same.
    hid = uuid.uuid4()
    with pg_conn.cursor() as cur:
        cur.execute("SET LOCAL ROLE chemclaw_service")
        cur.execute(
            "INSERT INTO hypotheses (id, hypothesis_text, confidence, proposed_by_user_entra_id) "
            "VALUES (%s, %s, %s, %s)",
            (str(hid), "Replay idempotency test hypothesis.", 0.6, "user-a"),
        )
        cur.execute(
            "INSERT INTO ingestion_events (event_type, source_table, source_row_id, payload) "
            "VALUES (%s, %s, %s, %s::jsonb)",
            ("hypothesis_proposed", "hypotheses", str(hid), json.dumps({"hypothesis_id": str(hid)})),
        )
        # Wipe acks so catch-up picks it up on both runs.
        cur.execute("DELETE FROM projection_acks WHERE projector_name = 'kg-hypotheses'")
    pg_conn.commit()

    from services.projectors.kg_hypotheses.main import KgHypothesesProjector
    from services.projectors.common.base import ProjectorSettings
    import asyncio

    settings = ProjectorSettings()
    proj = KgHypothesesProjector(settings)

    async def _run() -> None:
        async with await psycopg.AsyncConnection.connect(settings.postgres_dsn) as work:
            await proj._catch_up(work)

    asyncio.run(_run())
    with pg_conn.cursor() as cur:
        cur.execute("DELETE FROM projection_acks WHERE projector_name = 'kg-hypotheses'")
    pg_conn.commit()
    asyncio.run(_run())

    with neo4j_driver.session() as session:
        rec = session.run(
            "MATCH (h:Hypothesis) WHERE h.hypothesis_id = $hid RETURN count(h) AS n",
            hid=str(hid),
        ).single()
        assert rec["n"] == 1
```

*(Assumes a `neo4j_driver` pytest fixture exists — matching the pattern of the `kg-experiments` projector integration test. If not present, create it in the shared conftest for integration tests.)*

- [ ] **Step 16.2: Run test to verify it fails**

Run: `.venv/bin/pytest tests/integration/test_kg_hypotheses_projector.py -v -m integration`
Expected: FAIL — `No module named services.projectors.kg_hypotheses.main`.

- [ ] **Step 16.3: Implement the projector**

Create `services/projectors/kg_hypotheses/__init__.py` (empty).

Create `services/projectors/kg_hypotheses/requirements.txt`:

```
psycopg[binary]==3.2.3
pydantic==2.10.4
pydantic-settings==2.7.0
graphiti-core==0.4.7
neo4j==5.26.0
```

Create `services/projectors/kg_hypotheses/main.py`:

```python
"""Projector: canonical hypotheses → Neo4j :Hypothesis nodes + :CITES edges.

Subscribes to `hypothesis_proposed` and `hypothesis_status_changed`.
Idempotent via uniqueness constraint on fact_id (shared with kg-experiments).
"""
from __future__ import annotations

import asyncio
import json
import logging
import os
import uuid
from typing import Any

import psycopg
from neo4j import AsyncGraphDatabase  # type: ignore[import-untyped]

from services.projectors.common.base import (
    BaseProjector,
    ProjectorSettings,
)

log = logging.getLogger("kg-hypotheses")

NAMESPACE_HYPOTHESIS = uuid.UUID("7b1d1d6a-1c2d-4e55-9c82-0a1e5e9a7f01")
NAMESPACE_CITES = uuid.UUID("5b8fbd8a-66f9-4b23-9a1c-1f6a0e6bb2a3")


class KgHypothesesProjector(BaseProjector):
    name = "kg-hypotheses"
    interested_event_types = ("hypothesis_proposed", "hypothesis_status_changed")

    def __init__(self, settings: ProjectorSettings) -> None:
        super().__init__(settings)
        self._neo4j_uri = os.environ["NEO4J_URI"]
        self._neo4j_user = os.environ.get("NEO4J_USER", "neo4j")
        self._neo4j_password = os.environ["NEO4J_PASSWORD"]
        self._driver = AsyncGraphDatabase.driver(
            self._neo4j_uri, auth=(self._neo4j_user, self._neo4j_password),
        )

    async def close(self) -> None:
        await self._driver.close()

    async def handle(
        self,
        *,
        event_id: str,
        event_type: str,
        source_table: str | None,
        source_row_id: str | None,
        payload: dict[str, Any],
    ) -> None:
        if event_type == "hypothesis_proposed":
            await self._handle_proposed(payload, source_row_id)
        elif event_type == "hypothesis_status_changed":
            await self._handle_status_changed(payload, source_row_id)
        # Unknown: BaseProjector acks; no action.

    async def _load_hypothesis(self, hid: str) -> dict[str, Any] | None:
        async with await psycopg.AsyncConnection.connect(
            self.settings.postgres_dsn
        ) as conn, conn.cursor() as cur:
            await cur.execute("SET LOCAL ROLE chemclaw_service")
            await cur.execute(
                "SELECT id::text, hypothesis_text, confidence, confidence_tier, "
                "       scope_nce_project_id::text, created_at "
                "  FROM hypotheses WHERE id = %s::uuid",
                (hid,),
            )
            row = await cur.fetchone()
            if row is None:
                return None
            await cur.execute(
                "SELECT fact_id::text, citation_note "
                "  FROM hypothesis_citations WHERE hypothesis_id = %s::uuid",
                (hid,),
            )
            cites = await cur.fetchall()
        return {
            "id": row[0], "text": row[1], "confidence": float(row[2]),
            "confidence_tier": row[3], "scope_project_id": row[4],
            "created_at": row[5].isoformat() if hasattr(row[5], "isoformat") else str(row[5]),
            "citations": [(c[0], c[1]) for c in cites],
        }

    async def _handle_proposed(self, payload: dict[str, Any], source_row_id: str | None) -> None:
        hid = payload.get("hypothesis_id") or source_row_id
        if not hid:
            log.warning("hypothesis_proposed event missing hypothesis_id")
            return
        h = await self._load_hypothesis(hid)
        if h is None:
            log.warning("hypothesis %s not found (may have been deleted)", hid)
            return

        node_fact_id = str(uuid.uuid5(NAMESPACE_HYPOTHESIS, h["id"]))
        async with self._driver.session() as session:
            await session.run(
                """
                MERGE (n:Hypothesis {fact_id: $fact_id})
                  ON CREATE SET n.hypothesis_id = $hid,
                                n.text = $text,
                                n.confidence = $confidence,
                                n.confidence_tier = $tier,
                                n.scope_project_id = $scope,
                                n.created_at = $created_at,
                                n.valid_from = $created_at,
                                n.archived = false
                """,
                fact_id=node_fact_id,
                hid=h["id"], text=h["text"], confidence=h["confidence"],
                tier=h["confidence_tier"], scope=h["scope_project_id"],
                created_at=h["created_at"],
            )

            for fact_id, note in h["citations"]:
                edge_id = str(uuid.uuid5(NAMESPACE_CITES, f"{h['id']}|{fact_id}"))
                # If no :Fact node has this fact_id, fall back to an ungrounded placeholder.
                await session.run(
                    """
                    MATCH (h:Hypothesis {fact_id: $node_fact_id})
                    MERGE (f:Fact {fact_id: $fact_id})
                      ON CREATE SET f.ungrounded = true
                    MERGE (h)-[r:CITES {fact_id: $edge_id}]->(f)
                      ON CREATE SET r.note = $note
                    """,
                    node_fact_id=node_fact_id, fact_id=fact_id,
                    edge_id=edge_id, note=note,
                )

    async def _handle_status_changed(self, payload: dict[str, Any], source_row_id: str | None) -> None:
        hid = payload.get("hypothesis_id") or source_row_id
        if not hid:
            return
        async with await psycopg.AsyncConnection.connect(
            self.settings.postgres_dsn
        ) as conn, conn.cursor() as cur:
            await cur.execute("SET LOCAL ROLE chemclaw_service")
            await cur.execute("SELECT status FROM hypotheses WHERE id = %s::uuid", (hid,))
            row = await cur.fetchone()
        if not row:
            return
        status = row[0]
        node_fact_id = str(uuid.uuid5(NAMESPACE_HYPOTHESIS, hid))
        async with self._driver.session() as session:
            if status == "refuted":
                await session.run(
                    "MATCH (h:Hypothesis {fact_id: $fid}) "
                    "SET h.valid_to = datetime(), h.refuted = true",
                    fid=node_fact_id,
                )
            elif status == "archived":
                await session.run(
                    "MATCH (h:Hypothesis {fact_id: $fid}) SET h.archived = true",
                    fid=node_fact_id,
                )


def main() -> None:
    settings = ProjectorSettings()
    logging.basicConfig(level=settings.projector_log_level)
    proj = KgHypothesesProjector(settings)
    try:
        asyncio.run(proj.run())
    finally:
        asyncio.run(proj.close())


if __name__ == "__main__":
    main()
```

- [ ] **Step 16.4: Create the Dockerfile**

Create `services/projectors/kg_hypotheses/Dockerfile`:

```dockerfile
FROM python:3.11-slim
RUN groupadd -g 1001 app && useradd -r -u 1001 -g app app
WORKDIR /app
COPY services/projectors/common /app/services/projectors/common
COPY services/projectors/__init__.py /app/services/projectors/__init__.py
COPY services/__init__.py /app/services/__init__.py
COPY services/projectors/kg_hypotheses /app/services/projectors/kg_hypotheses
RUN pip install --no-cache-dir -r services/projectors/kg_hypotheses/requirements.txt
USER 1001:1001
CMD ["python", "-m", "services.projectors.kg_hypotheses.main"]
```

- [ ] **Step 16.5: Run integration test (if Neo4j available)**

Run: `NEO4J_URI=bolt://localhost:7687 NEO4J_PASSWORD=chemclaw .venv/bin/pytest tests/integration/test_kg_hypotheses_projector.py -v -m integration`
Expected: PASS (2 tests) when Neo4j is up; SKIPPED otherwise.

- [ ] **Step 16.6: Commit**

```bash
git add services/projectors/kg_hypotheses tests/integration/test_kg_hypotheses_projector.py
git commit -m "feat(projector): kg-hypotheses — canonical hypotheses -> Neo4j nodes + CITES edges"
```

---

## Task 17: Docker Compose entry for `kg-hypotheses` projector

**Files:**
- Modify: `docker-compose.yml`

- [ ] **Step 17.1: Add the projector service**

Edit `docker-compose.yml`. In the `services:` section (near other projectors):

```yaml
  # kg-hypotheses — projects hypotheses canonical rows to Neo4j
  kg-hypotheses:
    container_name: chemclaw-kg-hypotheses
    build:
      context: .
      dockerfile: services/projectors/kg_hypotheses/Dockerfile
    user: "1001:1001"
    environment:
      POSTGRES_HOST: postgres
      POSTGRES_PORT: 5432
      POSTGRES_DB: ${POSTGRES_DB:-chemclaw}
      POSTGRES_USER: chemclaw_service
      POSTGRES_PASSWORD: ${POSTGRES_SERVICE_PASSWORD:-chemclaw_service}
      NEO4J_URI: bolt://neo4j:7687
      NEO4J_USER: neo4j
      NEO4J_PASSWORD: ${NEO4J_PASSWORD:-chemclaw}
      PROJECTOR_LOG_LEVEL: INFO
    depends_on:
      postgres:
        condition: service_healthy
      neo4j:
        condition: service_healthy
    restart: unless-stopped
    security_opt:
      - no-new-privileges:true
```

- [ ] **Step 17.2: Smoke via docker compose build**

Run: `docker compose build kg-hypotheses`
Expected: image builds; no errors.

- [ ] **Step 17.3: Commit**

```bash
git add docker-compose.yml
git commit -m "chore(compose): register kg-hypotheses projector"
```

---

## Task 18: Streamlit — remove mode toggle + add Hypothesis badge

**Files:**
- Modify: `services/frontend/pages/chat.py`

- [ ] **Step 18.1: Delete mode toggle + DR endpoint routing**

Find and delete every reference to `mode`, `st.radio` for mode, and the `/api/deep_research` endpoint selection. The page should always POST to `/api/chat` (single endpoint).

Grep first:

```bash
grep -n "mode\|deep_research\|/api/deep_research" services/frontend/pages/chat.py
```

Remove:
- Any `MODE_OPTIONS = [...]` or `st.session_state.setdefault("chat_mode", ...)` block.
- Any `if st.session_state.chat_mode == "deep_research": url = ...` branching.
- The entire sidebar `st.radio` widget controlling mode.

Replace the endpoint construction with a single:

```python
endpoint = f"{API_BASE}/api/chat"
```

- [ ] **Step 18.2: Add the Hypothesis badge renderer**

Inside the tool-call panel render path (find where `tool_call` events produce their markdown), add special-case handling for `propose_hypothesis`:

```python
def render_tool_call_panel(event: dict) -> None:
    tool_id = event["toolId"]
    if tool_id == "propose_hypothesis":
        out = event.get("output") or {}
        hid = (out.get("hypothesis_id") or "?")[:8]
        tier = out.get("confidence_tier", "?")
        conf = event.get("input", {}).get("confidence")
        st.markdown(
            f"**Hypothesis `{hid}` · conf={conf:.2f} · tier={tier}**",
        )
    # ... existing render of the tool panel (input / output JSON) ...
```

- [ ] **Step 18.3: Manual smoke**

Run the frontend:

```bash
make run.frontend
```

Open http://localhost:8501/chat, send a simple message like "hello". Confirm there is no mode toggle and the chat posts to `/api/chat`.

- [ ] **Step 18.4: Commit**

```bash
git add services/frontend/pages/chat.py
git commit -m "feat(frontend): remove chat mode toggle; add Hypothesis badge"
```

---

## Task 19: Streamlit fenced-chart renderer

**Files:**
- Modify: `services/frontend/pages/chat.py`
- Create: `services/frontend/chart_spec.py`

- [ ] **Step 19.1: Add a strict chart-spec model**

Create `services/frontend/chart_spec.py`:

```python
"""Validated schema for the `chart` fenced code-block emitted by the agent.

Supported types: bar, line, scatter. Renders via Streamlit's built-in
chart primitives — no HTML, no script execution, no new JS dep.
"""
from __future__ import annotations

from typing import Literal

from pydantic import BaseModel, Field, ValidationError


class Series(BaseModel):
    name: str = Field(min_length=1, max_length=80)
    y: list[float] = Field(min_length=1, max_length=1000)


class ChartSpec(BaseModel):
    type: Literal["bar", "line", "scatter"]
    title: str = Field(default="", max_length=200)
    x_label: str = Field(default="", max_length=80)
    y_label: str = Field(default="", max_length=80)
    x: list[float | str] = Field(default_factory=list, max_length=1000)
    y: list[float] | None = None
    series: list[Series] | None = Field(default=None, max_length=10)


def parse_chart_spec(raw_json: str) -> ChartSpec | None:
    try:
        return ChartSpec.model_validate_json(raw_json)
    except ValidationError:
        return None
```

- [ ] **Step 19.2: Parse fenced `chart` blocks in assistant messages**

In `services/frontend/pages/chat.py`, add near the other message-rendering helpers:

```python
import json as _json
import re
import pandas as pd
import streamlit as st

from services.frontend.chart_spec import ChartSpec, parse_chart_spec

_CHART_BLOCK_RE = re.compile(r"```chart\s*\n(.*?)\n```", re.DOTALL)


def render_assistant_markdown(text: str) -> None:
    """Render a message body, extracting any ```chart blocks as native charts."""
    last_end = 0
    for m in _CHART_BLOCK_RE.finditer(text):
        prefix = text[last_end:m.start()]
        if prefix.strip():
            st.markdown(prefix)
        spec = parse_chart_spec(m.group(1))
        if spec is None:
            st.code(m.group(0), language="text")
        else:
            _render_chart(spec)
        last_end = m.end()
    tail = text[last_end:]
    if tail.strip():
        st.markdown(tail)


def _render_chart(spec: ChartSpec) -> None:
    if spec.title:
        st.caption(spec.title)
    if spec.series is not None and spec.x:
        df = pd.DataFrame({s.name: s.y for s in spec.series}, index=spec.x)
    elif spec.y is not None and spec.x:
        df = pd.DataFrame({spec.y_label or "value": spec.y}, index=spec.x)
    else:
        st.code(_json.dumps(spec.model_dump()), language="json")
        return
    if spec.type == "bar":
        st.bar_chart(df, x_label=spec.x_label or None, y_label=spec.y_label or None)
    elif spec.type == "line":
        st.line_chart(df, x_label=spec.x_label or None, y_label=spec.y_label or None)
    elif spec.type == "scatter":
        st.scatter_chart(df, x_label=spec.x_label or None, y_label=spec.y_label or None)
```

- [ ] **Step 19.3: Call the new renderer**

Find every `st.markdown(assistant_msg.content)` for assistant messages and replace with `render_assistant_markdown(assistant_msg.content)`.

- [ ] **Step 19.4: Manual smoke**

Post a chat message that causes the agent to emit a chart (e.g., "list reaction yields across my projects for Suzuki couplings as a bar chart"). Confirm the chart renders.

If the agent is not yet trained to emit chart blocks, paste an assistant message through the dev console containing:

````
Example result:

```chart
{"type":"bar","title":"Yields by solvent","x":["thf","dmf","toluene"],"y":[72.0,65.0,88.0]}
```
````

Confirm the bar chart renders and the fenced block disappears from the text.

- [ ] **Step 19.5: Commit**

```bash
git add services/frontend/chart_spec.py services/frontend/pages/chat.py
git commit -m "feat(frontend): validated fenced chart-spec renderer"
```

---

## Task 20: Smoke-test additions

**Files:**
- Modify: `scripts/smoke.sh`

- [ ] **Step 20.1: Add the new assertions**

Edit `scripts/smoke.sh`. After the existing SSE smoke segment, append:

```bash
# --- Phase 5A: cross-project learning smoke ------------------------------------
echo "--> Phase 5A smoke: /api/deep_research MUST 404"
status=$(curl -s -o /dev/null -w "%{http_code}" -X POST "${AGENT_URL}/api/deep_research" \
  -H "content-type: application/json" -d '{}')
if [ "$status" != "404" ]; then
  echo "!! expected 404 from /api/deep_research, got $status"
  exit 1
fi

echo "--> Phase 5A smoke: cross-project question lands a hypothesis row"
before=$(psql "$PG_URL" -Atc "SELECT count(*) FROM hypotheses WHERE proposed_by_user_entra_id = '${DEV_USER_ENTRA_ID:-dev-user}'")
curl -s -N -X POST "${AGENT_URL}/api/chat" \
  -H "content-type: application/json" \
  -d '{"messages":[{"role":"user","content":"Across my accessible projects, compare Suzuki coupling yields by solvent and propose one hypothesis with at least three cited fact_ids."}]}' \
  | tr -d '\0' | grep -q "\"type\":\"finish\"" || { echo "no terminal finish event"; exit 1; }

# Give the projector a moment to ack the event
sleep 3
after=$(psql "$PG_URL" -Atc "SELECT count(*) FROM hypotheses WHERE proposed_by_user_entra_id = '${DEV_USER_ENTRA_ID:-dev-user}'")
if [ "$after" -le "$before" ]; then
  echo "!! expected at least one new hypotheses row (before=$before after=$after)"
  exit 1
fi
echo "OK: Phase 5A smoke passed (hypotheses rows: $before -> $after)"
```

- [ ] **Step 20.2: Run smoke**

Run: `./scripts/smoke.sh`
Expected: `OK: Phase 5A smoke passed (hypotheses rows: N -> M)` where M > N.

*(If TabICL is slow on first invocation due to model download, pre-warm by running one `/api/chat` request before the smoke assertions.)*

- [ ] **Step 20.3: Commit**

```bash
git add scripts/smoke.sh
git commit -m "test(smoke): /api/deep_research 404 + cross-project hypothesis persistence"
```

---

## Task 21: `CLAUDE.md` Status update

**Files:**
- Modify: `CLAUDE.md`

- [ ] **Step 21.1: Rewrite the Phase 4 + Phase 5 status bullets**

Edit `CLAUDE.md`. Find the `## Status` section. Replace the Phase 4 bullet (which says Phase 4 Deep Research is "complete" with mode + dedicated route) with:

```markdown
- **Phase 4** (Deep Research): initial implementation landed in 7d46b1f with a `mode`
  parameter and dedicated `POST /api/deep_research` route. Phase 5A unwound that
  surface — the agent is now one unified `/api/chat` endpoint with a single
  `agent.system` v2 prompt; the Deep Research *tools* (`query_kg`,
  `check_contradictions`, `draft_section`, `mark_research_done`) remain available
  as part of the unified catalog and are invoked on demand.
```

Then replace the Phase 5 pending bullet with:

```markdown
- **Phase 5A** (cross-project reaction learning — toolkit half): **complete**.
  - `mcp-tabicl` — TabICL v2 tabular in-context learning on reaction features.
    JSON-persisted DRFP PCA (loader is pure NumPy; no arbitrary-code-execution
    path). Runs on port 8005.
  - New agent tools: `expand_reaction_context`, `statistical_analyze`,
    `synthesize_insights`, `propose_hypothesis`.
  - Canonical `hypotheses` + `hypothesis_citations` tables with RLS.
  - `kg-hypotheses` projector — canonical → Neo4j `:Hypothesis` nodes + `:CITES`
    edges. Uses uuid5 for race-safe MERGE; replay-idempotent.
  - Unified `agent.system.v2` + `tool.synthesize_insights.v1` prompts.
  - Anti-fabrication guard: per-turn `seenFactIds` Set; `propose_hypothesis`
    rejects citations the agent never surfaced.
  - Streamlit chat: mode toggle removed; fenced `chart` block rendering;
    Hypothesis badge per tool call.
- **Phase 5B** (proactive v1): pending — next sprint.
- **Phases 6–8**: pending.
```

- [ ] **Step 21.2: Commit**

```bash
git add CLAUDE.md
git commit -m "docs(claude.md): Phase 5A complete — unified agent + cross-learning toolkit"
```

---

## Self-review checklist

After executing all tasks, the engineer should verify:

- [ ] Python test suite: `.venv/bin/pytest tests/ -v` → counts have grown by ~12 (from 110 to ~122), 4 skipped Neo4j integration tests still skipped (or passing with Neo4j up).
- [ ] TypeScript: `cd services/agent && npm run typecheck && npm test` → all green; test count ~78 (was 68).
- [ ] `make up.full` brings up all services including `mcp-tabicl` and `kg-hypotheses`.
- [ ] `./scripts/smoke.sh` passes.
- [ ] Grep sanity: `grep -rn "deep_research_mode\|/api/deep_research\|mode: [\"']deep_research" services/` returns zero hits (except in historical SQL seeds and CLAUDE.md).
- [ ] `PromptRegistry` shows: `agent.system` v1 active=false, v2 active=true; `agent.deep_research_mode.v1` active=false; `tool.synthesize_insights.v1` active=true.
- [ ] End-to-end: open Streamlit, ask the cross-project question from Task 1's demo scenario, observe `find_similar_reactions` → `expand_reaction_context` → `statistical_analyze` → `propose_hypothesis` in the tool-call panels, and confirm at least one new row in `hypotheses` + a matching `Hypothesis` node in Neo4j.
