# Z3 Yield-Baseline Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Add a stateless `mcp_yield_baseline` ensemble service (chemprop MVE + per-project DRFP+XGBoost) and a `predict_yield_with_uq` builtin that surfaces both component scores plus a calibrated ensemble std.

**Architecture:** Two-call protocol mirroring Z1's AD pattern: builtin pulls per-project labeled training data via `withUserContext` RLS, POSTs `/train` (server-side LRU cache), then `/predict_yield` for batch predictions. Ensemble combines chemprop's MVE-head std with chemprop↔XGBoost disagreement. Cold-start projects (< 50 labels) fall back to a global pretrained XGBoost shipped as a static JSON artifact.

**Tech Stack:** Python 3.11 / FastAPI / Pydantic / xgboost==2.x / DRFP via httpx-to-mcp-drfp; TypeScript / Zod / Vitest (agent-claw builtin).

**Spec:** `docs/superpowers/specs/2026-05-03-z3-yield-baseline-design.md`

---

## Task 1: `mcp_yield_baseline` skeleton + healthz/readyz

**Files:**
- Create: `services/mcp_tools/mcp_yield_baseline/__init__.py`
- Create: `services/mcp_tools/mcp_yield_baseline/main.py`
- Create: `services/mcp_tools/mcp_yield_baseline/requirements.txt`
- Create: `services/mcp_tools/mcp_yield_baseline/tests/__init__.py`
- Create: `services/mcp_tools/mcp_yield_baseline/tests/test_skeleton.py`
- Create: `services/mcp_tools/mcp_yield_baseline/data/.gitkeep`
- Modify: `services/mcp_tools/common/scopes.py` (add `mcp_yield_baseline:invoke`)
- Modify: `Makefile` (add requirements.txt to setup.python)

- [ ] **Step 1: Add the scope**

In `services/mcp_tools/common/scopes.py` add `"mcp_yield_baseline": "mcp_yield_baseline:invoke",` next to the other entries.

- [ ] **Step 2: Write failing tests**

```python
# services/mcp_tools/mcp_yield_baseline/tests/test_skeleton.py
"""Skeleton tests for mcp-yield-baseline FastAPI app."""
from __future__ import annotations

from pathlib import Path
from unittest import mock

import pytest
from fastapi.testclient import TestClient


@pytest.fixture()
def client():
    from services.mcp_tools.mcp_yield_baseline.main import app  # noqa: PLC0415
    with TestClient(app) as c:
        yield c


def test_healthz(client):
    r = client.get("/healthz")
    assert r.status_code == 200
    assert r.json()["service"] == "mcp-yield-baseline"


def test_readyz_503_when_global_artifact_missing(tmp_path):
    missing = tmp_path / "no_xgb.json"
    with mock.patch(
        "services.mcp_tools.mcp_yield_baseline.main._GLOBAL_XGB_PATH",
        missing,
    ):
        from services.mcp_tools.mcp_yield_baseline.main import app
        with TestClient(app) as c:
            r = c.get("/readyz")
            assert r.status_code == 503


def test_global_xgb_loads_at_startup(client):
    from services.mcp_tools.mcp_yield_baseline.main import _GLOBAL_XGB_MODEL  # noqa: PLC0415
    assert _GLOBAL_XGB_MODEL is not None
```

Run: `.venv/bin/pytest services/mcp_tools/mcp_yield_baseline/tests/test_skeleton.py -v`
Expected: ImportError (module does not exist).

- [ ] **Step 3: Implement skeleton**

```python
# services/mcp_tools/mcp_yield_baseline/__init__.py
```
(empty)

```python
# services/mcp_tools/mcp_yield_baseline/main.py
"""mcp-yield-baseline — per-project ensemble yield prediction (port 8015).

Tools:
- POST /train          — fit per-project XGBoost from (rxn_smiles, yield_pct) pairs
- POST /predict_yield  — chemprop + per-project XGBoost ensemble with calibrated UQ

Stateless: no DB. The agent-claw builtin owns the RLS-scoped training-data pull.
"""
from __future__ import annotations

import json
import logging
import os
from contextlib import asynccontextmanager
from pathlib import Path
from typing import Any, AsyncIterator

from fastapi import FastAPI

from services.mcp_tools.common.app import create_app
from services.mcp_tools.common.settings import ToolSettings

log = logging.getLogger("mcp-yield-baseline")
settings = ToolSettings()

_GLOBAL_XGB_PATH = Path(os.environ.get(
    "MCP_YIELD_BASELINE_GLOBAL_XGB_PATH",
    str(Path(__file__).parent / "data" / "xgb_global_v1.json"),
))

_GLOBAL_XGB_MODEL: Any | None = None  # xgboost.Booster — loaded at startup


def _load_global_xgb() -> Any | None:
    if not _GLOBAL_XGB_PATH.exists():
        return None
    try:
        import xgboost as xgb  # noqa: PLC0415
    except ImportError:
        log.warning("xgboost not installed; global model unavailable")
        return None
    booster = xgb.Booster()
    booster.load_model(str(_GLOBAL_XGB_PATH))
    return booster


def _is_ready() -> bool:
    return _GLOBAL_XGB_MODEL is not None


@asynccontextmanager
async def _lifespan(_app: FastAPI) -> AsyncIterator[None]:
    """Load global XGBoost artifact at startup."""
    global _GLOBAL_XGB_MODEL
    _GLOBAL_XGB_MODEL = _load_global_xgb()
    yield


app = create_app(
    name="mcp-yield-baseline",
    version="0.1.0",
    log_level=settings.log_level,
    ready_check=_is_ready,
    required_scope="mcp_yield_baseline:invoke",
    lifespan=_lifespan,
)


if __name__ == "__main__":
    import uvicorn

    uvicorn.run(
        "services.mcp_tools.mcp_yield_baseline.main:app",
        host=settings.host,
        port=settings.port,
        log_level=settings.log_level.lower(),
    )
```

```
# services/mcp_tools/mcp_yield_baseline/requirements.txt
fastapi>=0.115
uvicorn[standard]>=0.32
pydantic>=2.8
pydantic-settings>=2.4
httpx>=0.27
numpy>=1.26
xgboost>=2.0,<3.0
drfp>=0.3.6
rdkit>=2024.3
```

```python
# services/mcp_tools/mcp_yield_baseline/tests/__init__.py
```
(empty)

```
# services/mcp_tools/mcp_yield_baseline/data/.gitkeep
```
(empty)

- [ ] **Step 4: Generate the global XGB artifact (synthetic dev fallback)**

(Build script ships in Task 6; for now we need a small synthetic artifact so `/readyz` passes in tests.)

```python
# Run inline to seed a synthetic artifact for tests:
.venv/bin/python -c "
import xgboost as xgb
import numpy as np
from pathlib import Path
np.random.seed(42)
X = np.random.rand(50, 2048)
y = np.random.uniform(20, 90, 50)
m = xgb.XGBRegressor(n_estimators=10, max_depth=3)
m.fit(X, y)
target = Path('services/mcp_tools/mcp_yield_baseline/data/xgb_global_v1.json')
target.parent.mkdir(parents=True, exist_ok=True)
m.get_booster().save_model(str(target))
print(f'Wrote synthetic {target}')
"
```

- [ ] **Step 5: Add to Makefile**

In `Makefile` `setup.python` (after `mcp_drfp/requirements.txt` line):

```makefile
	$(PIP) install -r services/mcp_tools/mcp_yield_baseline/requirements.txt
```

```bash
.venv/bin/pip install -r services/mcp_tools/mcp_yield_baseline/requirements.txt
```

- [ ] **Step 6: Run tests, expect pass**

```bash
.venv/bin/pytest services/mcp_tools/mcp_yield_baseline/tests/test_skeleton.py -v
```
Expected: 3 passed.

- [ ] **Step 7: Commit**

```bash
git add services/mcp_tools/mcp_yield_baseline/ services/mcp_tools/common/scopes.py Makefile
git commit -m "feat(z3): mcp-yield-baseline skeleton + global XGB loader"
```

---

## Task 2: Pure-function ensemble math

**Files:**
- Create: `services/mcp_tools/mcp_yield_baseline/ensemble.py`
- Create: `services/mcp_tools/mcp_yield_baseline/tests/test_ensemble.py`

- [ ] **Step 1: Write failing tests**

```python
# services/mcp_tools/mcp_yield_baseline/tests/test_ensemble.py
"""Pure-function ensemble math tests."""
from __future__ import annotations

import math


def test_combine_zero_disagreement_keeps_chemprop_std():
    from services.mcp_tools.mcp_yield_baseline.ensemble import combine_ensemble
    out = combine_ensemble(chemprop_mean=50.0, chemprop_std=5.0, xgboost_mean=50.0)
    assert out["ensemble_mean"] == 50.0
    assert math.isclose(out["ensemble_std"], 5.0, abs_tol=1e-9)


def test_combine_simple_disagreement():
    """chemprop=50, std=5; xgboost=60. mean=55; std=sqrt(25+25)=sqrt(50)≈7.07"""
    from services.mcp_tools.mcp_yield_baseline.ensemble import combine_ensemble
    out = combine_ensemble(chemprop_mean=50.0, chemprop_std=5.0, xgboost_mean=60.0)
    assert out["ensemble_mean"] == 55.0
    assert math.isclose(out["ensemble_std"], math.sqrt(50.0), abs_tol=1e-9)


def test_combine_chemprop_std_zero_uses_disagreement_only():
    """When MVE head missing, std reduces to abs(diff)/2."""
    from services.mcp_tools.mcp_yield_baseline.ensemble import combine_ensemble
    out = combine_ensemble(chemprop_mean=40.0, chemprop_std=0.0, xgboost_mean=80.0)
    assert out["ensemble_mean"] == 60.0
    assert math.isclose(out["ensemble_std"], 20.0, abs_tol=1e-9)


def test_combine_negative_disagreement_treated_symmetrically():
    """abs disagreement: chemprop=80, xgboost=60 produces same std as 60/80."""
    from services.mcp_tools.mcp_yield_baseline.ensemble import combine_ensemble
    a = combine_ensemble(chemprop_mean=80.0, chemprop_std=5.0, xgboost_mean=60.0)
    b = combine_ensemble(chemprop_mean=60.0, chemprop_std=5.0, xgboost_mean=80.0)
    assert math.isclose(a["ensemble_std"], b["ensemble_std"], abs_tol=1e-9)


def test_combine_clips_mean_to_yield_range():
    """ensemble_mean clipped to [0, 100] for yield-percentage sanity."""
    from services.mcp_tools.mcp_yield_baseline.ensemble import combine_ensemble
    over = combine_ensemble(chemprop_mean=110.0, chemprop_std=5.0, xgboost_mean=110.0)
    assert over["ensemble_mean"] == 100.0
    under = combine_ensemble(chemprop_mean=-10.0, chemprop_std=5.0, xgboost_mean=-10.0)
    assert under["ensemble_mean"] == 0.0


def test_combine_components_in_response():
    from services.mcp_tools.mcp_yield_baseline.ensemble import combine_ensemble
    out = combine_ensemble(chemprop_mean=50.0, chemprop_std=5.0, xgboost_mean=60.0)
    assert out["components"] == {
        "chemprop_mean": 50.0,
        "chemprop_std": 5.0,
        "xgboost_mean": 60.0,
    }


def test_combine_negative_chemprop_std_rejected():
    from services.mcp_tools.mcp_yield_baseline.ensemble import combine_ensemble
    import pytest
    with pytest.raises(ValueError, match="chemprop_std"):
        combine_ensemble(chemprop_mean=50.0, chemprop_std=-1.0, xgboost_mean=60.0)


def test_combine_batch_maps_per_row():
    from services.mcp_tools.mcp_yield_baseline.ensemble import combine_batch
    rows = combine_batch(
        chemprop_means=[50.0, 80.0],
        chemprop_stds=[5.0, 3.0],
        xgboost_means=[60.0, 80.0],
    )
    assert len(rows) == 2
    assert rows[0]["ensemble_mean"] == 55.0
    assert rows[1]["ensemble_mean"] == 80.0
    assert math.isclose(rows[1]["ensemble_std"], 3.0, abs_tol=1e-9)
```

Run: `.venv/bin/pytest services/mcp_tools/mcp_yield_baseline/tests/test_ensemble.py -v`
Expected: ImportError.

- [ ] **Step 2: Implement ensemble**

```python
# services/mcp_tools/mcp_yield_baseline/ensemble.py
"""Pure-function ensemble math for mcp-yield-baseline.

Combines a chemprop MVE-head prediction (mean, std) with a single XGBoost
mean. Returns ensemble_mean (average) and ensemble_std (sqrt of chemprop_std²
plus disagreement²/4). Both component scores travel into the response so the
ensemble is auditable.

Yield-percentage clipping: ensemble_mean is clamped to [0, 100] so the
response is always a sensible yield value even if the upstream models
predict out-of-range.
"""
from __future__ import annotations

import math
from typing import Any


def combine_ensemble(
    chemprop_mean: float,
    chemprop_std: float,
    xgboost_mean: float,
) -> dict[str, Any]:
    """Return {ensemble_mean, ensemble_std, components} for a single reaction."""
    if chemprop_std < 0:
        raise ValueError(f"chemprop_std must be non-negative; got {chemprop_std}")

    ensemble_mean = (chemprop_mean + xgboost_mean) / 2.0
    ensemble_mean = max(0.0, min(100.0, ensemble_mean))

    half_diff = (chemprop_mean - xgboost_mean) / 2.0
    ensemble_std = math.sqrt(chemprop_std * chemprop_std + half_diff * half_diff)

    return {
        "ensemble_mean": ensemble_mean,
        "ensemble_std": ensemble_std,
        "components": {
            "chemprop_mean": chemprop_mean,
            "chemprop_std": chemprop_std,
            "xgboost_mean": xgboost_mean,
        },
    }


def combine_batch(
    chemprop_means: list[float],
    chemprop_stds: list[float],
    xgboost_means: list[float],
) -> list[dict[str, Any]]:
    """Vectorized combine over equal-length lists."""
    if not (len(chemprop_means) == len(chemprop_stds) == len(xgboost_means)):
        raise ValueError(
            f"length mismatch: chemprop_means={len(chemprop_means)}, "
            f"chemprop_stds={len(chemprop_stds)}, xgboost_means={len(xgboost_means)}"
        )
    return [
        combine_ensemble(cm, cs, xm)
        for cm, cs, xm in zip(chemprop_means, chemprop_stds, xgboost_means)
    ]
```

- [ ] **Step 3: Run tests, expect pass**

```bash
.venv/bin/pytest services/mcp_tools/mcp_yield_baseline/tests/test_ensemble.py -v
```
Expected: 8 passed.

- [ ] **Step 4: Commit**

```bash
git add services/mcp_tools/mcp_yield_baseline/ensemble.py services/mcp_tools/mcp_yield_baseline/tests/test_ensemble.py
git commit -m "feat(z3): mcp-yield-baseline pure-function ensemble math"
```

---

## Task 3: `/train` endpoint + LRU cache

**Files:**
- Modify: `services/mcp_tools/mcp_yield_baseline/main.py`
- Create: `services/mcp_tools/mcp_yield_baseline/cache.py`
- Create: `services/mcp_tools/mcp_yield_baseline/tests/test_train_endpoint.py`

- [ ] **Step 1: Write failing tests**

```python
# services/mcp_tools/mcp_yield_baseline/tests/test_train_endpoint.py
"""/train endpoint + LRU cache tests. DRFP encoder is mocked."""
from __future__ import annotations

from unittest import mock

import pytest
from fastapi.testclient import TestClient


@pytest.fixture()
def client():
    from services.mcp_tools.mcp_yield_baseline.main import app  # noqa: PLC0415
    with TestClient(app) as c:
        yield c


def _mock_drfp():
    """Patch the local DRFP encoder helper to return deterministic vectors."""
    import numpy as np

    def fake_encode(rxn_smiles_list: list[str]) -> list[list[float]]:
        # Deterministic 2048-dim vector per smiles based on hash.
        rng = np.random.default_rng(seed=hash(tuple(rxn_smiles_list)) & 0xFFFF_FFFF)
        return rng.integers(0, 2, size=(len(rxn_smiles_list), 2048)).astype(float).tolist()

    return mock.patch(
        "services.mcp_tools.mcp_yield_baseline.main._encode_drfp_batch",
        side_effect=fake_encode,
    )


def test_train_returns_model_id(client):
    pairs = [
        {"rxn_smiles": f"CC>>CC{i}", "yield_pct": 50.0 + i}
        for i in range(60)
    ]
    with _mock_drfp():
        r = client.post(
            "/train",
            json={
                "project_internal_id": "PRJ-001",
                "training_pairs": pairs,
            },
        )
    assert r.status_code == 200
    body = r.json()
    assert "model_id" in body
    assert body["model_id"].startswith("PRJ-001@")
    assert body["n_train"] == 60


def test_train_deterministic_id(client):
    pairs = [
        {"rxn_smiles": f"CC>>CC{i}", "yield_pct": 50.0 + i}
        for i in range(60)
    ]
    with _mock_drfp():
        r1 = client.post(
            "/train",
            json={"project_internal_id": "PRJ-A", "training_pairs": pairs},
        ).json()
        r2 = client.post(
            "/train",
            json={"project_internal_id": "PRJ-A", "training_pairs": pairs},
        ).json()
    assert r1["model_id"] == r2["model_id"]


def test_train_rejects_too_few_pairs(client):
    pairs = [{"rxn_smiles": "CC>>CC", "yield_pct": 50.0}]
    r = client.post(
        "/train",
        json={"project_internal_id": "PRJ-X", "training_pairs": pairs},
    )
    assert r.status_code in (400, 422)


def test_train_rejects_degenerate_variance(client):
    """All-identical yields can't train a useful regressor → 422."""
    pairs = [
        {"rxn_smiles": f"CC>>CC{i}", "yield_pct": 50.0}  # variance == 0
        for i in range(60)
    ]
    with _mock_drfp():
        r = client.post(
            "/train",
            json={"project_internal_id": "PRJ-DEGEN", "training_pairs": pairs},
        )
    assert r.status_code == 422
    assert "training_failed" in r.json().get("detail", "")
```

Run: `.venv/bin/pytest services/mcp_tools/mcp_yield_baseline/tests/test_train_endpoint.py -v`
Expected: failures.

- [ ] **Step 2: Implement cache module**

```python
# services/mcp_tools/mcp_yield_baseline/cache.py
"""In-memory LRU cache of fitted per-project XGBoost models.

Cap 32 projects, 30-min TTL. Cache key: (project_internal_id, sha256 of
sorted training_pairs). Same data → same key → cache hit. On capacity
overflow, evict by oldest expires_at.
"""
from __future__ import annotations

import hashlib
import json
import time
from typing import Any

_TTL_SEC = 30 * 60
_CAP = 32

_CACHE: dict[str, dict[str, Any]] = {}


def deterministic_id(project_internal_id: str, training_pairs: list[dict[str, Any]]) -> str:
    """Return a stable id from sorted pair contents."""
    h = hashlib.sha256()
    h.update(project_internal_id.encode("utf-8"))
    sorted_pairs = sorted(training_pairs, key=lambda p: (p["rxn_smiles"], p["yield_pct"]))
    h.update(json.dumps(sorted_pairs, sort_keys=True).encode("utf-8"))
    return f"{project_internal_id}@{h.hexdigest()[:16]}"


def store(model_id: str, model: Any) -> None:
    _evict()
    _CACHE[model_id] = {"model": model, "expires_at": time.time() + _TTL_SEC}


def get(model_id: str) -> Any | None:
    _evict()
    entry = _CACHE.get(model_id)
    return entry["model"] if entry is not None else None


def _evict() -> None:
    """Drop expired entries; if still over cap, drop oldest."""
    now = time.time()
    expired = [k for k, v in _CACHE.items() if v["expires_at"] < now]
    for k in expired:
        del _CACHE[k]
    while len(_CACHE) > _CAP:
        oldest = min(_CACHE, key=lambda k: _CACHE[k]["expires_at"])
        del _CACHE[oldest]


def clear() -> None:
    """Used by tests to reset state between cases."""
    _CACHE.clear()
```

- [ ] **Step 3: Append `/train` endpoint to main.py**

Append to `services/mcp_tools/mcp_yield_baseline/main.py` above the `if __name__ == "__main__":` block:

```python
from typing import Annotated

import httpx
import numpy as np
from fastapi import Body, HTTPException
from pydantic import BaseModel, Field

from services.mcp_tools.common.limits import MAX_RXN_SMILES_LEN
from services.mcp_tools.mcp_yield_baseline import cache as _cache

# Min pairs required to fit a per-project model. < 50 → builtin should
# instead pass used_global_fallback=true and skip /train entirely.
_MIN_TRAIN_PAIRS = 50


class TrainingPair(BaseModel):
    rxn_smiles: str = Field(min_length=3, max_length=MAX_RXN_SMILES_LEN)
    yield_pct: float = Field(ge=-1.0, le=110.0)


class TrainIn(BaseModel):
    project_internal_id: str = Field(min_length=1, max_length=200)
    training_pairs: list[TrainingPair] = Field(min_length=_MIN_TRAIN_PAIRS, max_length=10_000)


class TrainOut(BaseModel):
    model_id: str
    n_train: int
    cached_for_seconds: int


def _drfp_url() -> str:
    return os.environ.get("MCP_DRFP_URL", "http://localhost:8002").rstrip("/")


def _encode_drfp_batch(rxn_smiles_list: list[str]) -> list[list[float]]:
    """Call mcp-drfp /tools/compute_drfp for a batch.

    Stubbed in tests via mock.patch on this exact symbol.
    """
    with httpx.Client(timeout=30.0) as client:
        resp = client.post(
            f"{_drfp_url()}/tools/compute_drfp",
            json={
                "rxn_smiles_list": rxn_smiles_list,
                "n_folded_length": 2048,
                "radius": 3,
            },
        )
        resp.raise_for_status()
        body = resp.json()
        return [v["vector"] for v in body["vectors"]]


@app.post("/train", response_model=TrainOut, tags=["yield_baseline"])
async def train(req: Annotated[TrainIn, Body(...)]) -> TrainOut:
    pairs_dicts = [p.model_dump() for p in req.training_pairs]
    model_id = _cache.deterministic_id(req.project_internal_id, pairs_dicts)

    cached = _cache.get(model_id)
    if cached is not None:
        return TrainOut(model_id=model_id, n_train=len(pairs_dicts), cached_for_seconds=30 * 60)

    # Encode + check label variance.
    smiles = [p.rxn_smiles for p in req.training_pairs]
    yields = [p.yield_pct for p in req.training_pairs]
    if float(np.var(yields)) < 1e-6:
        raise HTTPException(
            status_code=422,
            detail="training_failed: degenerate yield variance (all labels equal)",
        )

    try:
        vectors = _encode_drfp_batch(smiles)
    except httpx.HTTPError as exc:
        raise HTTPException(status_code=503, detail=f"drfp_unavailable: {exc}") from exc

    X = np.asarray(vectors, dtype=np.float64)
    y = np.asarray(yields, dtype=np.float64)

    try:
        import xgboost as xgb  # noqa: PLC0415
    except ImportError as exc:
        raise HTTPException(status_code=500, detail="xgboost not available") from exc

    model = xgb.XGBRegressor(
        n_estimators=500,
        max_depth=6,
        learning_rate=0.05,
        early_stopping_rounds=10,
        verbosity=0,
    )
    # 10% holdout for early stopping.
    n_holdout = max(1, len(y) // 10)
    rng = np.random.default_rng(seed=42)
    perm = rng.permutation(len(y))
    val_idx = perm[:n_holdout]
    tr_idx = perm[n_holdout:]
    model.fit(X[tr_idx], y[tr_idx], eval_set=[(X[val_idx], y[val_idx])], verbose=False)

    _cache.store(model_id, model)
    return TrainOut(model_id=model_id, n_train=len(pairs_dicts), cached_for_seconds=30 * 60)
```

- [ ] **Step 4: Run tests, expect pass**

```bash
.venv/bin/pytest services/mcp_tools/mcp_yield_baseline/tests/test_train_endpoint.py -v
```
Expected: 4 passed.

- [ ] **Step 5: Commit**

```bash
git add services/mcp_tools/mcp_yield_baseline/main.py services/mcp_tools/mcp_yield_baseline/cache.py services/mcp_tools/mcp_yield_baseline/tests/test_train_endpoint.py
git commit -m "feat(z3): mcp-yield-baseline /train + LRU cache"
```

---

## Task 4: `/predict_yield` endpoint

**Files:**
- Modify: `services/mcp_tools/mcp_yield_baseline/main.py`
- Create: `services/mcp_tools/mcp_yield_baseline/tests/test_predict_endpoint.py`

- [ ] **Step 1: Write failing tests**

```python
# services/mcp_tools/mcp_yield_baseline/tests/test_predict_endpoint.py
"""/predict_yield endpoint tests. drfp + chemprop both mocked."""
from __future__ import annotations

from unittest import mock

import numpy as np
import pytest
from fastapi.testclient import TestClient


@pytest.fixture()
def client():
    from services.mcp_tools.mcp_yield_baseline import cache as _cache
    _cache.clear()
    from services.mcp_tools.mcp_yield_baseline.main import app  # noqa: PLC0415
    with TestClient(app) as c:
        yield c


def _mock_drfp_batch():
    def fake_encode(rxn_smiles_list: list[str]) -> list[list[float]]:
        rng = np.random.default_rng(seed=hash(tuple(rxn_smiles_list)) & 0xFFFF_FFFF)
        return rng.integers(0, 2, size=(len(rxn_smiles_list), 2048)).astype(float).tolist()
    return mock.patch(
        "services.mcp_tools.mcp_yield_baseline.main._encode_drfp_batch",
        side_effect=fake_encode,
    )


def _mock_chemprop(returns):
    def fake_chemprop(rxn_smiles_list: list[str]) -> list[tuple[float, float]]:
        return [returns[s] for s in rxn_smiles_list]
    return mock.patch(
        "services.mcp_tools.mcp_yield_baseline.main._call_chemprop_batch",
        side_effect=fake_chemprop,
    )


def _seed_project_model(client, project: str = "PRJ-PRED") -> str:
    pairs = [
        {"rxn_smiles": f"CC>>CC{i}", "yield_pct": 50.0 + (i * 0.5)}
        for i in range(60)
    ]
    with _mock_drfp_batch():
        r = client.post(
            "/train",
            json={"project_internal_id": project, "training_pairs": pairs},
        )
    return r.json()["model_id"]


def test_predict_with_cached_model_returns_ensemble(client):
    model_id = _seed_project_model(client)
    chem = {"O>>P": (60.0, 5.0)}
    with _mock_drfp_batch(), _mock_chemprop(chem):
        r = client.post(
            "/predict_yield",
            json={
                "rxn_smiles_list": ["O>>P"],
                "project_internal_id": "PRJ-PRED",
                "model_id": model_id,
            },
        )
    assert r.status_code == 200
    body = r.json()
    assert len(body["predictions"]) == 1
    pred = body["predictions"][0]
    assert "ensemble_mean" in pred
    assert "ensemble_std" in pred
    assert pred["components"]["chemprop_mean"] == 60.0
    assert pred["components"]["chemprop_std"] == 5.0
    assert "xgboost_mean" in pred["components"]
    assert pred["used_global_fallback"] is False


def test_predict_unknown_model_id_returns_412(client):
    chem = {"O>>P": (60.0, 5.0)}
    with _mock_drfp_batch(), _mock_chemprop(chem):
        r = client.post(
            "/predict_yield",
            json={
                "rxn_smiles_list": ["O>>P"],
                "project_internal_id": "PRJ-PRED",
                "model_id": "PRJ-PRED@deadbeef00000000",
            },
        )
    assert r.status_code == 412
    assert "needs_calibration" in r.json().get("detail", "")


def test_predict_global_fallback_no_model_id(client):
    chem = {"O>>P": (60.0, 5.0)}
    with _mock_drfp_batch(), _mock_chemprop(chem):
        r = client.post(
            "/predict_yield",
            json={
                "rxn_smiles_list": ["O>>P"],
                "used_global_fallback": True,
            },
        )
    assert r.status_code == 200
    body = r.json()
    assert body["predictions"][0]["used_global_fallback"] is True


def test_predict_batch(client):
    model_id = _seed_project_model(client)
    chem = {"A>>X": (40.0, 3.0), "B>>Y": (75.0, 4.0)}
    with _mock_drfp_batch(), _mock_chemprop(chem):
        r = client.post(
            "/predict_yield",
            json={
                "rxn_smiles_list": ["A>>X", "B>>Y"],
                "project_internal_id": "PRJ-PRED",
                "model_id": model_id,
            },
        )
    assert r.status_code == 200
    assert len(r.json()["predictions"]) == 2


def test_predict_empty_list_rejected(client):
    r = client.post("/predict_yield", json={"rxn_smiles_list": []})
    assert r.status_code in (400, 422)


def test_predict_chemprop_failure_propagates_503(client):
    model_id = _seed_project_model(client)

    def fake_chemprop(rxn_smiles_list):
        raise httpx.HTTPError("chemprop down")

    import httpx
    with _mock_drfp_batch(), mock.patch(
        "services.mcp_tools.mcp_yield_baseline.main._call_chemprop_batch",
        side_effect=fake_chemprop,
    ):
        r = client.post(
            "/predict_yield",
            json={
                "rxn_smiles_list": ["O>>P"],
                "project_internal_id": "PRJ-PRED",
                "model_id": model_id,
            },
        )
    assert r.status_code == 503
```

Run: `.venv/bin/pytest services/mcp_tools/mcp_yield_baseline/tests/test_predict_endpoint.py -v`
Expected: failures.

- [ ] **Step 2: Implement `/predict_yield`**

Append to `services/mcp_tools/mcp_yield_baseline/main.py`:

```python
from services.mcp_tools.mcp_yield_baseline.ensemble import combine_batch


class PredictYieldIn(BaseModel):
    rxn_smiles_list: list[str] = Field(min_length=1, max_length=100)
    project_internal_id: str | None = Field(default=None, max_length=200)
    model_id: str | None = Field(default=None, max_length=300)
    used_global_fallback: bool = False


class ReactionPrediction(BaseModel):
    rxn_smiles: str
    ensemble_mean: float
    ensemble_std: float
    components: dict[str, float]
    used_global_fallback: bool
    model_id: str | None


class PredictYieldOut(BaseModel):
    predictions: list[ReactionPrediction]


def _call_chemprop_batch(rxn_smiles_list: list[str]) -> list[tuple[float, float]]:
    """Call mcp-chemprop /predict_yield. Stubbed in tests."""
    chemprop_url = os.environ.get("MCP_CHEMPROP_URL", "http://localhost:8009").rstrip("/")
    with httpx.Client(timeout=60.0) as client:
        resp = client.post(
            f"{chemprop_url}/predict_yield",
            json={"rxn_smiles_list": rxn_smiles_list},
        )
        resp.raise_for_status()
        body = resp.json()
        return [(p["mean"], p["std"]) for p in body["predictions"]]


def _xgboost_predict(model: Any, vectors: list[list[float]]) -> list[float]:
    X = np.asarray(vectors, dtype=np.float64)
    preds = model.predict(X) if hasattr(model, "predict") else _booster_predict(model, X)
    return [float(p) for p in preds]


def _booster_predict(booster: Any, X: np.ndarray) -> np.ndarray:
    """Predict via raw xgboost.Booster (the global-fallback case)."""
    import xgboost as xgb  # noqa: PLC0415

    return booster.predict(xgb.DMatrix(X))


@app.post("/predict_yield", response_model=PredictYieldOut, tags=["yield_baseline"])
async def predict_yield(req: Annotated[PredictYieldIn, Body(...)]) -> PredictYieldOut:
    if not req.rxn_smiles_list:
        raise ValueError("rxn_smiles_list must be non-empty")

    # Resolve which XGBoost to use.
    use_global = req.used_global_fallback or req.model_id is None
    if not use_global:
        model = _cache.get(req.model_id)  # type: ignore[arg-type]
        if model is None:
            raise HTTPException(
                status_code=412,
                detail="needs_calibration: model_id not in cache (restart or eviction); re-supply via /train",
            )
    else:
        if _GLOBAL_XGB_MODEL is None:
            raise HTTPException(status_code=503, detail="global_xgb_unavailable")
        model = _GLOBAL_XGB_MODEL

    # Encode + chemprop in parallel-ish (sequential; cheap to make concurrent later).
    try:
        vectors = _encode_drfp_batch(req.rxn_smiles_list)
    except httpx.HTTPError as exc:
        raise HTTPException(status_code=503, detail=f"drfp_unavailable: {exc}") from exc
    try:
        chem = _call_chemprop_batch(req.rxn_smiles_list)
    except httpx.HTTPError as exc:
        raise HTTPException(status_code=503, detail=f"chemprop_unavailable: {exc}") from exc

    xgb_means = _xgboost_predict(model, vectors)

    rows = combine_batch(
        chemprop_means=[m for m, _ in chem],
        chemprop_stds=[s for _, s in chem],
        xgboost_means=xgb_means,
    )

    return PredictYieldOut(
        predictions=[
            ReactionPrediction(
                rxn_smiles=smi,
                ensemble_mean=row["ensemble_mean"],
                ensemble_std=row["ensemble_std"],
                components=row["components"],
                used_global_fallback=use_global,
                model_id=None if use_global else req.model_id,
            )
            for smi, row in zip(req.rxn_smiles_list, rows)
        ],
    )
```

- [ ] **Step 3: Run tests, expect pass**

```bash
.venv/bin/pytest services/mcp_tools/mcp_yield_baseline/tests/ -v
```
Expected: all tests pass (3 skeleton + 8 ensemble + 4 train + 6 predict = 21 passed).

- [ ] **Step 4: Commit**

```bash
git add services/mcp_tools/mcp_yield_baseline/main.py services/mcp_tools/mcp_yield_baseline/tests/test_predict_endpoint.py
git commit -m "feat(z3): mcp-yield-baseline /predict_yield ensemble endpoint"
```

---

## Task 5: Dockerfile + docker-compose

**Files:**
- Create: `services/mcp_tools/mcp_yield_baseline/Dockerfile`
- Modify: `docker-compose.yml`

- [ ] **Step 1: Add Dockerfile**

```dockerfile
# services/mcp_tools/mcp_yield_baseline/Dockerfile
FROM python:3.11-slim
WORKDIR /app

RUN apt-get update && apt-get install -y --no-install-recommends \
      build-essential libxrender1 libxext6 \
  && rm -rf /var/lib/apt/lists/*

COPY services/mcp_tools/mcp_yield_baseline/requirements.txt /app/services/mcp_tools/mcp_yield_baseline/requirements.txt
RUN pip install --no-cache-dir -r /app/services/mcp_tools/mcp_yield_baseline/requirements.txt

COPY services/__init__.py /app/services/__init__.py
COPY services/mcp_tools/__init__.py /app/services/mcp_tools/__init__.py
COPY services/mcp_tools/common /app/services/mcp_tools/common
COPY services/mcp_tools/mcp_yield_baseline /app/services/mcp_tools/mcp_yield_baseline

ENV PYTHONPATH=/app
EXPOSE 8015

RUN useradd -r -u 1001 app && chown -R app /app
USER 1001

CMD ["python", "-m", "uvicorn", "services.mcp_tools.mcp_yield_baseline.main:app", \
     "--host", "0.0.0.0", "--port", "8015"]
```

- [ ] **Step 2: Add to docker-compose.yml**

Find the `mcp-chemprop` service block (search `mcp-chemprop:` near the chemistry MCPs). After its closing block, add:

```yaml
  # -------------------------------------------------------------
  # mcp-yield-baseline — chemprop + per-project XGBoost ensemble (port 8015)
  # -------------------------------------------------------------
  mcp-yield-baseline:
    build:
      context: .
      dockerfile: services/mcp_tools/mcp_yield_baseline/Dockerfile
    container_name: chemclaw-mcp-yield-baseline
    restart: unless-stopped
    profiles: ["chemistry"]
    ports:
      - "8015:8015"
    environment:
      MCP_AUTH_SIGNING_KEY: ${MCP_AUTH_SIGNING_KEY:?required}
      MCP_DRFP_URL: http://mcp-drfp:8002
      MCP_CHEMPROP_URL: http://mcp-chemprop:8009
      LOG_LEVEL: ${LOG_LEVEL:-INFO}
    healthcheck:
      test: ["CMD-SHELL", "python -c \"import urllib.request,sys; sys.exit(0 if urllib.request.urlopen('http://127.0.0.1:8015/readyz',timeout=5).status==200 else 1)\""]
      interval: 30s
      timeout: 5s
      retries: 3
    security_opt:
      - no-new-privileges:true
```

- [ ] **Step 3: Verify compose**

```bash
MCP_AUTH_SIGNING_KEY=x docker compose --profile chemistry config --services 2>&1 | grep mcp-yield-baseline
```
Expected: `mcp-yield-baseline` listed.

- [ ] **Step 4: Commit**

```bash
git add services/mcp_tools/mcp_yield_baseline/Dockerfile docker-compose.yml
git commit -m "feat(z3): mcp-yield-baseline Dockerfile + compose registration"
```

---

## Task 6: Build-time global model script + Doyle Buchwald evaluator

**Files:**
- Create: `services/mcp_tools/mcp_yield_baseline/scripts/build_global_xgb.py`
- Create: `services/mcp_tools/mcp_yield_baseline/scripts/eval_doyle.py`

- [ ] **Step 1: Add the build script**

```python
# services/mcp_tools/mcp_yield_baseline/scripts/build_global_xgb.py
"""Build the global pretrained XGBoost artifact.

Reads (rxn_smiles, yield_pct) pairs from reactions JOIN experiments as
chemclaw_service (BYPASSRLS, aggregate-only — no per-row leakage), DRFP-
encodes each pair, fits XGBRegressor, saves data/xgb_global_v1.json plus
metadata.

Synthetic fallback for dev environments without a populated reactions table.
"""
from __future__ import annotations

import json
import os
import sys
from pathlib import Path
from datetime import datetime, timezone

import numpy as np

_TARGET = Path(__file__).resolve().parents[1] / "data" / "xgb_global_v1.json"
_META = Path(__file__).resolve().parents[1] / "data" / "xgb_global_v1.meta.json"


def _write(model: object, n_train: int, dataset: str, holdout_rmse: float) -> None:
    import xgboost as xgb  # noqa: PLC0415

    _TARGET.parent.mkdir(parents=True, exist_ok=True)
    booster = model.get_booster() if hasattr(model, "get_booster") else model
    booster.save_model(str(_TARGET))
    _META.write_text(json.dumps({
        "n_train": n_train,
        "dataset": dataset,
        "snapshot_at": datetime.now(tz=timezone.utc).isoformat(),
        "xgboost_version": xgb.__version__,
        "holdout_rmse": holdout_rmse,
        "version": "xgb_global_v1",
    }))
    print(f"Wrote {_TARGET} (n_train={n_train}, holdout_rmse={holdout_rmse:.3f})")


def _write_synthetic() -> None:
    import xgboost as xgb

    rng = np.random.default_rng(seed=42)
    X = rng.integers(0, 2, size=(200, 2048)).astype(np.float64)
    y = rng.uniform(20, 90, 200)
    model = xgb.XGBRegressor(n_estimators=50, max_depth=4, learning_rate=0.05, verbosity=0)
    model.fit(X, y)
    _write(model, n_train=200, dataset="synthetic_dev", holdout_rmse=float("nan"))


def main() -> None:
    dsn = os.environ.get("CHEMCLAW_SERVICE_DSN")
    if not dsn:
        print("CHEMCLAW_SERVICE_DSN unset — emitting synthetic global model.")
        _write_synthetic()
        return

    try:
        import psycopg
        import xgboost as xgb
    except ImportError as exc:
        print(f"Missing deps: {exc}", file=sys.stderr)
        sys.exit(1)

    import httpx
    drfp_url = os.environ.get("MCP_DRFP_URL", "http://localhost:8002").rstrip("/")

    with psycopg.connect(dsn) as conn:
        with conn.cursor() as cur:
            cur.execute("SET search_path TO public")
            cur.execute("""
                SELECT r.rxn_smiles, e.yield_pct::float
                  FROM reactions r
                  JOIN experiments e ON e.id = r.experiment_id
                 WHERE r.rxn_smiles IS NOT NULL AND e.yield_pct IS NOT NULL
                 LIMIT 100000
            """)
            rows = cur.fetchall()

    if len(rows) < 50:
        print(f"Only {len(rows)} rows; emitting synthetic.")
        _write_synthetic()
        return

    smiles = [r[0] for r in rows]
    y = np.asarray([r[1] for r in rows], dtype=np.float64)

    print(f"Encoding {len(smiles)} reactions via DRFP...")
    with httpx.Client(timeout=300.0) as cli:
        resp = cli.post(
            f"{drfp_url}/tools/compute_drfp",
            json={"rxn_smiles_list": smiles, "n_folded_length": 2048, "radius": 3},
        )
        resp.raise_for_status()
        body = resp.json()
        X = np.asarray([v["vector"] for v in body["vectors"]], dtype=np.float64)

    rng = np.random.default_rng(seed=42)
    perm = rng.permutation(len(y))
    n_holdout = max(1, len(y) // 10)
    val_idx, tr_idx = perm[:n_holdout], perm[n_holdout:]
    model = xgb.XGBRegressor(
        n_estimators=500, max_depth=6, learning_rate=0.05,
        early_stopping_rounds=10, verbosity=0,
    )
    model.fit(X[tr_idx], y[tr_idx], eval_set=[(X[val_idx], y[val_idx])], verbose=False)
    preds = model.predict(X[val_idx])
    rmse = float(np.sqrt(np.mean((preds - y[val_idx]) ** 2)))
    _write(model, n_train=len(tr_idx), dataset="reactions+experiments", holdout_rmse=rmse)


if __name__ == "__main__":
    main()
```

- [ ] **Step 2: Add the Doyle Buchwald evaluator**

```python
# services/mcp_tools/mcp_yield_baseline/scripts/eval_doyle.py
"""Doyle Buchwald-Hartwig HTE held-out evaluation.

Replays the open Doyle dataset (4608 reactions, Science 2018) through
/predict_yield against the global pretrained model. Reports RMSE, NLL,
ECE for ensemble vs chemprop-alone vs xgboost-alone. Target: ECE < 0.10.

Z7 wires this into the /eval slash verb. For now, run manually post-deploy.

Dataset CSV must be supplied via DOYLE_DATASET_PATH env var; this script
does NOT download it.
"""
from __future__ import annotations

import json
import math
import os
import sys
from pathlib import Path

import httpx
import numpy as np

_BASE = os.environ.get("MCP_YIELD_BASELINE_URL", "http://localhost:8015").rstrip("/")


def _ece(predictions: list[dict], n_bins: int = 10) -> float:
    """Expected Calibration Error using equal-width yield bins on the abs error."""
    errors = [abs(p["true"] - p["ensemble_mean"]) for p in predictions]
    stds = [p["ensemble_std"] for p in predictions]
    if not errors:
        return float("nan")
    bins = np.linspace(0, max(stds) + 1e-6, n_bins + 1)
    n = len(errors)
    ece = 0.0
    for i in range(n_bins):
        lo, hi = bins[i], bins[i + 1]
        in_bin = [j for j, s in enumerate(stds) if lo <= s < hi]
        if not in_bin:
            continue
        avg_err = np.mean([errors[j] for j in in_bin])
        avg_std = np.mean([stds[j] for j in in_bin])
        ece += (len(in_bin) / n) * abs(avg_err - avg_std)
    return float(ece)


def main() -> None:
    csv_path = os.environ.get("DOYLE_DATASET_PATH")
    if not csv_path or not Path(csv_path).exists():
        print("Set DOYLE_DATASET_PATH to a CSV with columns rxn_smiles,yield_pct", file=sys.stderr)
        sys.exit(1)

    rows: list[tuple[str, float]] = []
    with open(csv_path) as f:
        next(f)  # header
        for line in f:
            parts = line.strip().split(",")
            if len(parts) < 2:
                continue
            rows.append((parts[0], float(parts[1])))

    print(f"Loaded {len(rows)} Doyle reactions; sending in batches of 100...")
    predictions: list[dict] = []
    with httpx.Client(timeout=300.0) as cli:
        for batch_start in range(0, len(rows), 100):
            batch = rows[batch_start : batch_start + 100]
            resp = cli.post(
                f"{_BASE}/predict_yield",
                json={
                    "rxn_smiles_list": [r[0] for r in batch],
                    "used_global_fallback": True,
                },
            )
            resp.raise_for_status()
            for (_, y_true), pred in zip(batch, resp.json()["predictions"]):
                predictions.append({
                    "true": y_true,
                    "ensemble_mean": pred["ensemble_mean"],
                    "ensemble_std": pred["ensemble_std"],
                    "chemprop_mean": pred["components"]["chemprop_mean"],
                    "xgboost_mean": pred["components"]["xgboost_mean"],
                })

    rmse = math.sqrt(np.mean([(p["true"] - p["ensemble_mean"]) ** 2 for p in predictions]))
    rmse_chem = math.sqrt(np.mean([(p["true"] - p["chemprop_mean"]) ** 2 for p in predictions]))
    rmse_xgb = math.sqrt(np.mean([(p["true"] - p["xgboost_mean"]) ** 2 for p in predictions]))
    ece = _ece(predictions)

    report = {
        "n": len(predictions),
        "rmse_ensemble": rmse,
        "rmse_chemprop_only": rmse_chem,
        "rmse_xgboost_only": rmse_xgb,
        "ece_ensemble": ece,
        "target_ece": 0.10,
        "passed": ece < 0.10,
    }
    print(json.dumps(report, indent=2))
    if not report["passed"]:
        sys.exit(2)


if __name__ == "__main__":
    main()
```

- [ ] **Step 3: Lint passes**

```bash
.venv/bin/ruff check services/mcp_tools/mcp_yield_baseline/scripts/
```
Expected: All checks passed.

- [ ] **Step 4: Commit**

```bash
git add services/mcp_tools/mcp_yield_baseline/scripts/
git commit -m "feat(z3): build_global_xgb + eval_doyle scripts"
```

---

## Task 7: Builtin `predict_yield_with_uq.ts`

**Files:**
- Modify: `services/agent-claw/src/config.ts`
- Modify: `services/agent-claw/src/bootstrap/dependencies.ts`
- Create: `services/agent-claw/src/tools/builtins/predict_yield_with_uq.ts`
- Create: `services/agent-claw/tests/unit/builtins/predict_yield_with_uq.test.ts`
- Modify: `db/seed/05_harness_tools.sql`
- Modify: `db/init/19_reaction_optimization.sql`

- [ ] **Step 1: Add config key**

In `services/agent-claw/src/config.ts`, near the other chemistry MCP URLs (search `MCP_ASKCOS_URL`):

```typescript
  MCP_YIELD_BASELINE_URL: z.string().url().default("http://localhost:8015"),
```

- [ ] **Step 2: Write failing builtin tests**

```typescript
// services/agent-claw/tests/unit/builtins/predict_yield_with_uq.test.ts
import { describe, it, expect, vi, afterEach } from "vitest";
import { buildPredictYieldWithUqTool } from "../../../src/tools/builtins/predict_yield_with_uq.js";

const URL_ = "http://mcp-yield-baseline:8015";

function makeCtx() {
  const seenFactIds = new Set<string>();
  const scratchpad = new Map<string, unknown>([["seenFactIds", seenFactIds]]);
  return { userEntraId: "test@example.com", scratchpad, seenFactIds };
}

function makePoolMock(rows: Array<{ rxn_smiles: string; yield_pct: number }>) {
  return {
    connect: vi.fn(async () => ({
      query: vi.fn(async (sql: string) => {
        if (typeof sql === "string" && sql.includes("yield_pct IS NOT NULL")) {
          return { rows };
        }
        return { rows: [] };
      }),
      release: vi.fn(),
    })),
  };
}

afterEach(() => vi.unstubAllGlobals());

describe("buildPredictYieldWithUqTool", () => {
  it("happy path: project has 60 labels → /train then /predict_yield", async () => {
    const labels = Array.from({ length: 60 }, (_, i) => ({
      rxn_smiles: `CC>>CC${i}`,
      yield_pct: 50 + i,
    }));
    const pool = makePoolMock(labels);

    const fetchMock = vi.fn();
    fetchMock.mockResolvedValueOnce({
      ok: true,
      text: async () =>
        JSON.stringify({ model_id: "PRJ-001@abc123", n_train: 60, cached_for_seconds: 1800 }),
    });
    fetchMock.mockResolvedValueOnce({
      ok: true,
      text: async () =>
        JSON.stringify({
          predictions: [
            {
              rxn_smiles: "O>>P",
              ensemble_mean: 65,
              ensemble_std: 7,
              components: { chemprop_mean: 60, chemprop_std: 5, xgboost_mean: 70 },
              used_global_fallback: false,
              model_id: "PRJ-001@abc123",
            },
          ],
        }),
    });
    vi.stubGlobal("fetch", fetchMock);

    const tool = buildPredictYieldWithUqTool(pool as never, URL_);
    const result = await tool.execute(makeCtx(), {
      rxn_smiles_list: ["O>>P"],
      project_internal_id: "PRJ-001",
    });

    expect(result.predictions).toHaveLength(1);
    expect(result.predictions[0]!.ensemble_mean).toBe(65);
    expect(result.predictions[0]!.used_global_fallback).toBe(false);
    expect(fetchMock).toHaveBeenCalledTimes(2);
    const trainBody = JSON.parse(
      (fetchMock.mock.calls[0]![1] as RequestInit).body as string,
    );
    expect(trainBody.training_pairs).toHaveLength(60);
  });

  it("bootstrap path: project has 5 labels → no /train, used_global_fallback", async () => {
    const labels = Array.from({ length: 5 }, (_, i) => ({
      rxn_smiles: `CC>>CC${i}`,
      yield_pct: 50,
    }));
    const pool = makePoolMock(labels);

    const fetchMock = vi.fn().mockResolvedValueOnce({
      ok: true,
      text: async () =>
        JSON.stringify({
          predictions: [
            {
              rxn_smiles: "O>>P",
              ensemble_mean: 60,
              ensemble_std: 8,
              components: { chemprop_mean: 60, chemprop_std: 5, xgboost_mean: 60 },
              used_global_fallback: true,
              model_id: null,
            },
          ],
        }),
    });
    vi.stubGlobal("fetch", fetchMock);

    const tool = buildPredictYieldWithUqTool(pool as never, URL_);
    const result = await tool.execute(makeCtx(), {
      rxn_smiles_list: ["O>>P"],
      project_internal_id: "PRJ-EMPTY",
    });

    // Only /predict_yield was called — no /train.
    expect(fetchMock).toHaveBeenCalledTimes(1);
    expect(result.predictions[0]!.used_global_fallback).toBe(true);
  });

  it("retries once on 412 (cache miss)", async () => {
    const labels = Array.from({ length: 60 }, (_, i) => ({
      rxn_smiles: `CC>>CC${i}`,
      yield_pct: 50 + i,
    }));
    const pool = makePoolMock(labels);

    const fetchMock = vi.fn();
    // 1st: /train
    fetchMock.mockResolvedValueOnce({
      ok: true,
      text: async () =>
        JSON.stringify({ model_id: "PRJ-001@abc", n_train: 60, cached_for_seconds: 1800 }),
    });
    // 2nd: /predict_yield → 412
    fetchMock.mockResolvedValueOnce({
      ok: false,
      status: 412,
      text: async () => JSON.stringify({ detail: "needs_calibration: ..." }),
    });
    // 3rd: /train (re-supply)
    fetchMock.mockResolvedValueOnce({
      ok: true,
      text: async () =>
        JSON.stringify({ model_id: "PRJ-001@abc", n_train: 60, cached_for_seconds: 1800 }),
    });
    // 4th: /predict_yield retry → ok
    fetchMock.mockResolvedValueOnce({
      ok: true,
      text: async () =>
        JSON.stringify({
          predictions: [
            {
              rxn_smiles: "O>>P",
              ensemble_mean: 65,
              ensemble_std: 7,
              components: { chemprop_mean: 60, chemprop_std: 5, xgboost_mean: 70 },
              used_global_fallback: false,
              model_id: "PRJ-001@abc",
            },
          ],
        }),
    });
    vi.stubGlobal("fetch", fetchMock);

    const tool = buildPredictYieldWithUqTool(pool as never, URL_);
    const result = await tool.execute(makeCtx(), {
      rxn_smiles_list: ["O>>P"],
      project_internal_id: "PRJ-001",
    });

    expect(fetchMock).toHaveBeenCalledTimes(4);
    expect(result.predictions[0]!.ensemble_mean).toBe(65);
  });

  it("inputSchema rejects empty rxn_smiles_list", () => {
    const pool = makePoolMock([]);
    const tool = buildPredictYieldWithUqTool(pool as never, URL_);
    expect(tool.inputSchema.safeParse({ rxn_smiles_list: [] }).success).toBe(false);
  });
});
```

Run: `cd services/agent-claw && npx vitest run tests/unit/builtins/predict_yield_with_uq.test.ts`
Expected: ImportError.

- [ ] **Step 3: Implement the builtin**

```typescript
// services/agent-claw/src/tools/builtins/predict_yield_with_uq.ts
// predict_yield_with_uq — chemprop + per-project XGBoost ensemble (Z3).
//
// Pulls per-project labeled training data via the existing withUserContext
// RLS pattern, calls /train (cached server-side), then /predict_yield. Cache
// miss on /predict_yield re-supplies once.

import { z } from "zod";
import type { Pool } from "pg";
import { defineTool } from "../tool.js";
import { postJson } from "../../mcp/postJson.js";
import { withUserContext } from "../../db/with-user-context.js";
import { MAX_RXN_SMILES_LEN, MAX_BATCH_SMILES } from "../_limits.js";

const MIN_TRAIN_PAIRS = 50;
const MAX_TRAIN_PAIRS = 10_000;

// ---------- Schemas ---------------------------------------------------------

export const PredictYieldWithUqIn = z.object({
  rxn_smiles_list: z
    .array(z.string().min(1).max(MAX_RXN_SMILES_LEN))
    .min(1)
    .max(MAX_BATCH_SMILES),
  project_internal_id: z.string().max(200).optional(),
});
export type PredictYieldWithUqInput = z.infer<typeof PredictYieldWithUqIn>;

const ReactionPrediction = z.object({
  rxn_smiles: z.string(),
  ensemble_mean: z.number(),
  ensemble_std: z.number(),
  components: z.object({
    chemprop_mean: z.number(),
    chemprop_std: z.number(),
    xgboost_mean: z.number(),
  }),
  used_global_fallback: z.boolean(),
  model_id: z.string().nullable(),
});

export const PredictYieldWithUqOut = z.object({
  predictions: z.array(ReactionPrediction),
});
export type PredictYieldWithUqOutput = z.infer<typeof PredictYieldWithUqOut>;

const TrainOut = z.object({
  model_id: z.string(),
  n_train: z.number().int(),
  cached_for_seconds: z.number().int(),
});

interface TrainingRow {
  rxn_smiles: string;
  yield_pct: number;
}

async function fetchTrainingPairs(
  pool: Pool,
  userEntraId: string,
  projectInternalId: string,
): Promise<TrainingRow[]> {
  return await withUserContext(pool, userEntraId, async (client) => {
    const result = await client.query<TrainingRow>(
      `SELECT r.rxn_smiles, e.yield_pct::float AS yield_pct
         FROM reactions r
         JOIN experiments e ON e.id = r.experiment_id
         JOIN synthetic_steps s ON s.id = e.synthetic_step_id
         JOIN nce_projects p ON p.id = s.nce_project_id
        WHERE p.internal_id = $1
          AND e.yield_pct IS NOT NULL
          AND r.rxn_smiles IS NOT NULL
        LIMIT $2`,
      [projectInternalId, MAX_TRAIN_PAIRS],
    );
    return result.rows;
  });
}

// ---------- Factory --------------------------------------------------------

export function buildPredictYieldWithUqTool(pool: Pool, mcpUrl: string) {
  const base = mcpUrl.replace(/\/$/, "");

  async function trainAndGetModelId(
    projectInternalId: string,
    pairs: TrainingRow[],
  ): Promise<string> {
    const resp = await postJson(
      `${base}/train`,
      {
        project_internal_id: projectInternalId,
        training_pairs: pairs,
      },
      TrainOut,
      120_000,
      "mcp-yield-baseline",
    );
    return resp.model_id;
  }

  return defineTool({
    id: "predict_yield_with_uq",
    description:
      "Predict yield with calibrated uncertainty for a list of reaction SMILES. " +
      "Combines chemprop's MVE-head std (aleatoric) with chemprop↔XGBoost " +
      "disagreement (epistemic) into a single ensemble_std. Per-project XGBoost " +
      "trained on the user's RLS-scoped reactions; falls back to a global " +
      "pretrained model when project has < 50 labeled reactions.",
    inputSchema: PredictYieldWithUqIn,
    outputSchema: PredictYieldWithUqOut,
    annotations: { readOnly: true },

    execute: async (ctx, input) => {
      const userEntraId = ctx.userEntraId;
      if (!userEntraId) {
        throw new Error("predict_yield_with_uq requires userEntraId in context");
      }

      let modelId: string | null = null;
      let useGlobalFallback = true;
      let trainingPairs: TrainingRow[] = [];

      if (input.project_internal_id) {
        trainingPairs = await fetchTrainingPairs(
          pool,
          userEntraId,
          input.project_internal_id,
        );
        if (trainingPairs.length >= MIN_TRAIN_PAIRS) {
          modelId = await trainAndGetModelId(input.project_internal_id, trainingPairs);
          useGlobalFallback = false;
        }
      }

      const predictBody = {
        rxn_smiles_list: input.rxn_smiles_list,
        project_internal_id: input.project_internal_id ?? null,
        model_id: modelId,
        used_global_fallback: useGlobalFallback,
      };

      try {
        return await postJson(
          `${base}/predict_yield`,
          predictBody,
          PredictYieldWithUqOut,
          60_000,
          "mcp-yield-baseline",
        );
      } catch (err) {
        const msg = err instanceof Error ? err.message : String(err);
        // 412 → cache miss after restart; re-train and retry once.
        if (msg.includes("412") && !useGlobalFallback && input.project_internal_id) {
          modelId = await trainAndGetModelId(input.project_internal_id, trainingPairs);
          return await postJson(
            `${base}/predict_yield`,
            { ...predictBody, model_id: modelId },
            PredictYieldWithUqOut,
            60_000,
            "mcp-yield-baseline",
          );
        }
        throw err;
      }
    },
  });
}
```

- [ ] **Step 4: Wire into dependencies.ts**

In `services/agent-claw/src/bootstrap/dependencies.ts`, add the import near the other chemistry-builtin imports (search `buildPredictReactionYieldTool`):

```typescript
import { buildPredictYieldWithUqTool } from "../tools/builtins/predict_yield_with_uq.js";
```

In `registerBuiltinTools`, after the existing `predict_reaction_yield` registration:

```typescript
  registry.registerBuiltin("predict_yield_with_uq", () =>
    asTool(buildPredictYieldWithUqTool(pool, cfg.MCP_YIELD_BASELINE_URL)),
  );
```

- [ ] **Step 5: Seed the tools-table row**

Append to `db/seed/05_harness_tools.sql` (before the final `COMMIT;`):

```sql
-- ── Yield baseline ensemble (Phase Z3) ────────────────────────────────────

INSERT INTO tools (name, source, schema_json, description, enabled, version)
VALUES (
  'predict_yield_with_uq',
  'builtin',
  '{
    "type": "object",
    "properties": {
      "rxn_smiles_list": {
        "type": "array",
        "items": {"type": "string", "minLength": 1, "maxLength": 20000},
        "minItems": 1,
        "maxItems": 100,
        "description": "Reaction SMILES to predict yield for."
      },
      "project_internal_id": {
        "type": "string",
        "maxLength": 200,
        "description": "Optional NCE project internal_id; per-project model is used when available."
      }
    },
    "required": ["rxn_smiles_list"]
  }',
  'Predict yield with calibrated uncertainty. Combines chemprop''s MVE-head std (aleatoric) with chemprop-XGBoost disagreement (epistemic) into a single ensemble_std. Returns per-reaction ensemble_mean + ensemble_std + component scores. Per-project XGBoost trained on user''s RLS-scoped reactions; global pretrained fallback when project has < 50 labeled reactions.',
  true,
  1
)
ON CONFLICT (name) DO UPDATE SET
  source = EXCLUDED.source, schema_json = EXCLUDED.schema_json,
  description = EXCLUDED.description, enabled = EXCLUDED.enabled, version = EXCLUDED.version;
```

- [ ] **Step 6: Append model_cards row**

In `db/init/19_reaction_optimization.sql`, before the final `COMMIT;`, append:

```sql
INSERT INTO model_cards (
  service_name, model_version, defined_endpoint, algorithm,
  applicability_domain, predictivity_metrics,
  mechanistic_interpretation, trained_on
) VALUES (
  'mcp_yield_baseline', 'yield_baseline_v1',
  'Per-reaction ensemble yield prediction with calibrated UQ. Returns ensemble_mean + ensemble_std plus chemprop and XGBoost component scores.',
  'Two-model ensemble: chemprop v2 MPNN with MVE head (aleatoric) + per-project XGBoost over DRFP fingerprints (epistemic via disagreement). Global pretrained XGBoost fallback when project has < 50 labels.',
  'Reactions whose DRFP fingerprints fall within the per-project training corpus when used_global_fallback=false; broader USPTO + ORD coverage when used_global_fallback=true.',
  '{"target_ece_global": 0.10, "evaluation_dataset": "Doyle Buchwald-Hartwig HTE (4608 reactions)"}'::jsonb,
  'Aleatoric uncertainty from chemprop MVE head; epistemic from chemprop-XGBoost disagreement. Components surfaced separately so chemists can act on each (high aleatoric -> noise; high epistemic -> unfamiliar chemotype).',
  'Per-project: experiments.yield_pct + reactions.rxn_smiles, RLS-scoped. Global fallback: USPTO + ORD subset, snapshot at image-build time.'
)
ON CONFLICT (service_name, model_version) DO NOTHING;
```

- [ ] **Step 7: Run all relevant tests**

```bash
cd services/agent-claw && npx vitest run tests/unit/builtins/predict_yield_with_uq.test.ts
```
Expected: 4 passed.

- [ ] **Step 8: Commit**

```bash
cd /Users/robertmoeckel/Documents/VSCode/chemclaw/chemclaw-yield-baseline-z3
git add services/agent-claw/src/config.ts services/agent-claw/src/bootstrap/dependencies.ts services/agent-claw/src/tools/builtins/predict_yield_with_uq.ts services/agent-claw/tests/unit/builtins/predict_yield_with_uq.test.ts db/seed/05_harness_tools.sql db/init/19_reaction_optimization.sql
git commit -m "feat(z3): predict_yield_with_uq builtin + tools/model_cards seed"
```

---

## Task 8: Final lint / typecheck / pytest / vitest

**Files:** none (verification only)

- [ ] **Step 1: Lint Python changes**

```bash
cd /Users/robertmoeckel/Documents/VSCode/chemclaw/chemclaw-yield-baseline-z3
.venv/bin/ruff check services/mcp_tools/mcp_yield_baseline/
```
Expected: All checks passed!

- [ ] **Step 2: Lint TS changes**

```bash
cd services/agent-claw && npx eslint \
    src/tools/builtins/predict_yield_with_uq.ts \
    tests/unit/builtins/predict_yield_with_uq.test.ts \
    src/bootstrap/dependencies.ts \
    src/config.ts
```
Expected: clean.

- [ ] **Step 3: Typecheck**

```bash
cd services/agent-claw && npx tsc --noEmit
```
Expected: clean.

- [ ] **Step 4: Full pytest for the new MCP**

```bash
cd /Users/robertmoeckel/Documents/VSCode/chemclaw/chemclaw-yield-baseline-z3
.venv/bin/pytest services/mcp_tools/mcp_yield_baseline/tests/ -v
```
Expected: 21 passed.

- [ ] **Step 5: Full vitest**

```bash
cd services/agent-claw && npm test 2>&1 | tail -10
```
Expected: ≥ 4 new tests passing on top of the existing baseline.

- [ ] **Step 6: Compose check**

```bash
MCP_AUTH_SIGNING_KEY=x docker compose --profile chemistry config --services 2>&1 | grep mcp-yield-baseline
```
Expected: present.

- [ ] **Step 7: If clean, no commit. If a touch-up was needed, commit it.**

```bash
git status --short
```

---

## Self-Review

**Spec coverage:**
- Schema (`model_cards` row) → Task 7.
- `mcp_yield_baseline` skeleton + readyz → Task 1.
- Pure-function ensemble math → Task 2.
- `/train` + LRU cache → Task 3.
- `/predict_yield` ensemble + cache miss 412 + global fallback → Task 4.
- Dockerfile + compose → Task 5.
- `build_global_xgb.py` + `eval_doyle.py` → Task 6.
- Builtin `predict_yield_with_uq.ts` + retry-on-412 + bootstrap fallback + Zod schema → Task 7.
- Wiring (config + dependencies + tools seed) → Task 7.
- Final verification → Task 8.

**Placeholder scan:** every step has runnable code/commands; no TBD/TODO.

**Type consistency:** `model_id` shape `<project>@<sha>`, `components` keys (`chemprop_mean`, `chemprop_std`, `xgboost_mean`), `used_global_fallback` bool, `412 needs_calibration` semantics — all consistent across MCP (Tasks 3, 4), builtin (Task 7), and consumer expectations. The `combine_ensemble` function signature in Task 2 matches its callers in Task 4.

---

## Execution Handoff

Plan complete and saved to `docs/superpowers/plans/2026-05-03-z3-yield-baseline.md`.

Per the user's standing instruction ("when done with writing implementation plan, directly start implementation"), proceed inline via `superpowers:executing-plans`.
