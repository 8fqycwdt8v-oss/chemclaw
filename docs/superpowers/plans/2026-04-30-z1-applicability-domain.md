# Z1 Applicability-Domain & Green-Chemistry Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Add three-signal applicability-domain (Tanimoto-NN + Mahalanobis + conformal-prediction interval) verdicts and CHEM21-aware soft-penalty greenness scoring to ChemClaw's condition-design pipeline.

**Architecture:** Two stateless math/lookup MCPs (`mcp_applicability_domain` port 8017, `mcp_green_chemistry` port 8019) backed by static JSON artifacts; two agent-claw builtins handle DB queries (RLS-scoped) and orchestration; `condition-design` skill bumps to v2 with annotate-don't-block AD verdict + soft-penalty score adjustment.

**Tech Stack:** Python 3.11 / FastAPI / Pydantic / RDKit (green-chem service) / NumPy (AD service); TypeScript / Zod / Vitest (agent-claw builtins); Postgres 16 + pgvector (RLS-scoped queries); existing JWT-Bearer middleware (`services/mcp_tools/common/app.py`).

**Spec:** `docs/superpowers/specs/2026-04-30-z1-applicability-domain-design.md`

---

## Task 1: `mcp_green_chemistry` skeleton + healthz/readyz

**Files:**
- Create: `services/mcp_tools/mcp_green_chemistry/__init__.py`
- Create: `services/mcp_tools/mcp_green_chemistry/main.py`
- Create: `services/mcp_tools/mcp_green_chemistry/requirements.txt`
- Create: `services/mcp_tools/mcp_green_chemistry/tests/__init__.py`
- Create: `services/mcp_tools/mcp_green_chemistry/tests/test_mcp_green_chemistry.py`
- Create: `services/mcp_tools/mcp_green_chemistry/data/.gitkeep`

- [ ] **Step 1: Write the failing tests**

```python
# services/mcp_tools/mcp_green_chemistry/tests/test_mcp_green_chemistry.py
"""Tests for mcp-green-chemistry FastAPI app."""
from __future__ import annotations

from unittest import mock

import pytest
from fastapi.testclient import TestClient


@pytest.fixture()
def client():
    from services.mcp_tools.mcp_green_chemistry.main import app  # noqa: PLC0415
    with TestClient(app) as c:
        yield c


def test_healthz(client):
    r = client.get("/healthz")
    assert r.status_code == 200
    assert r.json()["service"] == "mcp-green-chemistry"


def test_readyz_200_when_data_dir_present(client):
    r = client.get("/readyz")
    assert r.status_code == 200


def test_readyz_503_when_data_dir_missing(tmp_path):
    missing = tmp_path / "no_data"
    with mock.patch(
        "services.mcp_tools.mcp_green_chemistry.main._DATA_DIR",
        missing,
    ):
        from services.mcp_tools.mcp_green_chemistry.main import app
        with TestClient(app) as c:
            r = c.get("/readyz")
            assert r.status_code == 503
```

- [ ] **Step 2: Run test, expect failure**

```bash
cd /Users/robertmoeckel/Documents/VSCode/chemclaw/chemclaw-applicability-domain-z1
.venv/bin/pytest services/mcp_tools/mcp_green_chemistry/tests/ -v
```
Expected: ImportError — `services.mcp_tools.mcp_green_chemistry` does not exist.

- [ ] **Step 3: Implement the skeleton**

```python
# services/mcp_tools/mcp_green_chemistry/__init__.py
```
(empty file)

```python
# services/mcp_tools/mcp_green_chemistry/main.py
"""mcp-green-chemistry — solvent guide & reaction-safety lookup (port 8019).

Tools:
- POST /score_solvents          — per-solvent CHEM21 / GSK / Pfizer / AZ / Sanofi / ACS-GCI-PR class
- POST /assess_reaction_safety  — PMI estimate + Bretherick hazardous-group SMARTS lookup

Stateless: all answers come from static JSON tables shipped in the image.
"""

from __future__ import annotations

import logging
import os
from pathlib import Path

from services.mcp_tools.common.app import create_app
from services.mcp_tools.common.settings import ToolSettings

log = logging.getLogger("mcp-green-chemistry")
settings = ToolSettings()

# Data dir holds chem21_solvents.json, gsk_solvents.json, etc.
_DATA_DIR = Path(os.environ.get(
    "MCP_GREEN_CHEMISTRY_DATA_DIR",
    str(Path(__file__).parent / "data"),
))


def _is_ready() -> bool:
    return _DATA_DIR.exists() and _DATA_DIR.is_dir()


app = create_app(
    name="mcp-green-chemistry",
    version="0.1.0",
    log_level=settings.log_level,
    ready_check=_is_ready,
    required_scope="mcp_green_chemistry:invoke",
)


if __name__ == "__main__":
    import uvicorn

    uvicorn.run(
        "services.mcp_tools.mcp_green_chemistry.main:app",
        host=settings.host,
        port=settings.port,
        log_level=settings.log_level.lower(),
    )
```

```
# services/mcp_tools/mcp_green_chemistry/requirements.txt
fastapi>=0.115
uvicorn[standard]>=0.32
pydantic>=2.8
pydantic-settings>=2.4
rdkit>=2024.3
rapidfuzz>=3.10
```

```python
# services/mcp_tools/mcp_green_chemistry/tests/__init__.py
```
(empty)

```
# services/mcp_tools/mcp_green_chemistry/data/.gitkeep
```
(empty placeholder so the dir exists in git)

- [ ] **Step 4: Run tests, expect pass**

```bash
.venv/bin/pytest services/mcp_tools/mcp_green_chemistry/tests/ -v
```
Expected: 3 passed.

- [ ] **Step 5: Commit**

```bash
git add services/mcp_tools/mcp_green_chemistry/
git commit -m "feat(z1): mcp-green-chemistry skeleton + healthz/readyz"
```

---

## Task 2: CHEM21 + six solvent guides + `/score_solvents` endpoint

**Files:**
- Create: `services/mcp_tools/mcp_green_chemistry/data/chem21_solvents.json`
- Create: `services/mcp_tools/mcp_green_chemistry/data/gsk_solvents.json`
- Create: `services/mcp_tools/mcp_green_chemistry/data/pfizer_solvents.json`
- Create: `services/mcp_tools/mcp_green_chemistry/data/az_solvents.json`
- Create: `services/mcp_tools/mcp_green_chemistry/data/sanofi_solvents.json`
- Create: `services/mcp_tools/mcp_green_chemistry/data/acs_gci_pr_unified.json`
- Modify: `services/mcp_tools/mcp_green_chemistry/main.py`
- Modify: `services/mcp_tools/mcp_green_chemistry/tests/test_mcp_green_chemistry.py`

- [ ] **Step 1: Add the data files**

Each file is a JSON list of `{"smiles": "<RDKit canonical>", "name": "<display>", "inchikey": "<27-char>", "class": "...", "score": int|float}`. Ship a starter set covering the most common pharma solvents — the rest can be added later. Aim for ~30 solvents per guide; cross-vendor unified table covers ~50.

```json
[
  {"smiles": "CCO", "name": "Ethanol", "inchikey": "LFQSCWFLJHTTHZ-UHFFFAOYSA-N", "class": "Recommended", "score": 1, "safety": 5, "health": 4, "environment": 5},
  {"smiles": "OC(C)C", "name": "Isopropanol", "inchikey": "KFZMGEQAYNKOFK-UHFFFAOYSA-N", "class": "Recommended", "score": 2, "safety": 4, "health": 5, "environment": 5},
  {"smiles": "O", "name": "Water", "inchikey": "XLYOFNOQVPJJNP-UHFFFAOYSA-N", "class": "Recommended", "score": 1, "safety": 10, "health": 10, "environment": 10},
  {"smiles": "C1CCOC1", "name": "THF", "inchikey": "WYURNTSHIVDZCO-UHFFFAOYSA-N", "class": "Hazardous", "score": 5, "safety": 4, "health": 5, "environment": 4},
  {"smiles": "C1OCC(C)O1", "name": "2-MeTHF", "inchikey": "UJGHGRGFKZWGMS-UHFFFAOYSA-N", "class": "Recommended", "score": 3, "safety": 4, "health": 6, "environment": 6},
  {"smiles": "CC(=O)OCC", "name": "EtOAc", "inchikey": "XEKOWRVHYACXOJ-UHFFFAOYSA-N", "class": "Recommended", "score": 2, "safety": 5, "health": 6, "environment": 5},
  {"smiles": "CC(C)OC(C)C", "name": "Diisopropyl ether", "inchikey": "ZAFNJMIOTHYJRJ-UHFFFAOYSA-N", "class": "Hazardous", "score": 6, "safety": 3, "health": 6, "environment": 5},
  {"smiles": "ClCCl", "name": "DCM", "inchikey": "YMWUJEATGCHHMB-UHFFFAOYSA-N", "class": "HighlyHazardous", "score": 9, "safety": 6, "health": 2, "environment": 4},
  {"smiles": "ClC(Cl)Cl", "name": "Chloroform", "inchikey": "HEDRZPFGACZZDS-UHFFFAOYSA-N", "class": "HighlyHazardous", "score": 9, "safety": 7, "health": 1, "environment": 3},
  {"smiles": "CCCCCC", "name": "Hexane", "inchikey": "VLKZOEOYAKHREP-UHFFFAOYSA-N", "class": "HighlyHazardous", "score": 8, "safety": 3, "health": 2, "environment": 5},
  {"smiles": "CCCCCCC", "name": "Heptane", "inchikey": "IMNFDUFMRHMDMM-UHFFFAOYSA-N", "class": "Problematic", "score": 5, "safety": 3, "health": 5, "environment": 6},
  {"smiles": "Cc1ccccc1", "name": "Toluene", "inchikey": "YXFVVABEGXRONW-UHFFFAOYSA-N", "class": "Problematic", "score": 5, "safety": 4, "health": 4, "environment": 5},
  {"smiles": "CN(C)C=O", "name": "DMF", "inchikey": "ZMXDDKWLCZADIW-UHFFFAOYSA-N", "class": "HighlyHazardous", "score": 9, "safety": 6, "health": 2, "environment": 4},
  {"smiles": "CN(C)C(C)=O", "name": "DMAc", "inchikey": "FXHOOIRPVKKKFG-UHFFFAOYSA-N", "class": "HighlyHazardous", "score": 9, "safety": 6, "health": 2, "environment": 4},
  {"smiles": "O=S(C)C", "name": "DMSO", "inchikey": "IAZDPXIOMUYVGZ-UHFFFAOYSA-N", "class": "Problematic", "score": 4, "safety": 5, "health": 6, "environment": 6},
  {"smiles": "CC#N", "name": "Acetonitrile", "inchikey": "WEVYAHXRMPXWCK-UHFFFAOYSA-N", "class": "Problematic", "score": 5, "safety": 5, "health": 5, "environment": 5},
  {"smiles": "CC(=O)C", "name": "Acetone", "inchikey": "CSCPPACGZOOCGX-UHFFFAOYSA-N", "class": "Recommended", "score": 2, "safety": 4, "health": 7, "environment": 6},
  {"smiles": "C1CCCCO1", "name": "1,4-Dioxane", "inchikey": "RYHBNJHYFVUHQT-UHFFFAOYSA-N", "class": "HighlyHazardous", "score": 9, "safety": 5, "health": 2, "environment": 4},
  {"smiles": "CCOCC", "name": "DEE", "inchikey": "RTZKZFJDLAIYFH-UHFFFAOYSA-N", "class": "Hazardous", "score": 7, "safety": 2, "health": 6, "environment": 5},
  {"smiles": "O=C1CCCCN1C", "name": "NMP", "inchikey": "SECXISVLQFMRJM-UHFFFAOYSA-N", "class": "HighlyHazardous", "score": 8, "safety": 6, "health": 2, "environment": 4},
  {"smiles": "OCC(O)CO", "name": "Glycerol", "inchikey": "PEDCQBHIVMGVHV-UHFFFAOYSA-N", "class": "Recommended", "score": 1, "safety": 10, "health": 9, "environment": 9},
  {"smiles": "CO", "name": "Methanol", "inchikey": "OKKJLVBELUTLKV-UHFFFAOYSA-N", "class": "Problematic", "score": 5, "safety": 4, "health": 3, "environment": 6},
  {"smiles": "OCCO", "name": "Ethylene glycol", "inchikey": "LYCAIKOWRPUZTN-UHFFFAOYSA-N", "class": "Problematic", "score": 4, "safety": 7, "health": 4, "environment": 7},
  {"smiles": "CC(C)O", "name": "2-Butanol", "inchikey": "BTANRVKWQNVYAZ-UHFFFAOYSA-N", "class": "Recommended", "score": 2, "safety": 4, "health": 6, "environment": 6},
  {"smiles": "CC(=O)O", "name": "Acetic acid", "inchikey": "QTBSBXVTEAMEQO-UHFFFAOYSA-N", "class": "Problematic", "score": 4, "safety": 5, "health": 4, "environment": 7},
  {"smiles": "ClC(Cl)(Cl)Cl", "name": "Carbon tetrachloride", "inchikey": "VZGDMQKNWNREIO-UHFFFAOYSA-N", "class": "HighlyHazardous", "score": 10, "safety": 8, "health": 1, "environment": 1},
  {"smiles": "C(Cl)(Cl)C(Cl)Cl", "name": "Tetrachloroethane", "inchikey": "QPFMBZIOSGYJDE-UHFFFAOYSA-N", "class": "HighlyHazardous", "score": 9, "safety": 7, "health": 1, "environment": 3},
  {"smiles": "c1ccccc1", "name": "Benzene", "inchikey": "UHOVQNZJYSORNB-UHFFFAOYSA-N", "class": "HighlyHazardous", "score": 10, "safety": 4, "health": 1, "environment": 4},
  {"smiles": "Cc1ccccc1C", "name": "o-Xylene", "inchikey": "CTQNGGLPUBDAKN-UHFFFAOYSA-N", "class": "Problematic", "score": 5, "safety": 4, "health": 4, "environment": 5},
  {"smiles": "Clc1ccccc1", "name": "Chlorobenzene", "inchikey": "MVPPADPHJFYWMZ-UHFFFAOYSA-N", "class": "Problematic", "score": 5, "safety": 5, "health": 4, "environment": 4}
]
```
(write this to `chem21_solvents.json`)

For the other 5 vendor guides, ship the same SMILES list with the per-vendor class field. To save plan length: **use the same 30 solvents in each of the 5 vendor guides; the per-vendor class field uses a smaller controlled vocabulary specific to each vendor**. The per-vendor classes are:

- `gsk_solvents.json` — class field values: `"Few Issues" | "Some Issues" | "Major Issues"`. DCM/CHCl₃/CCl₄/benzene/dioxane → "Major Issues"; THF/DMF/DMAc/NMP/hexane → "Some Issues"; rest → "Few Issues".
- `pfizer_solvents.json` — class field values: `"Preferred" | "Useable" | "Undesirable" | "Avoid"`. Same hazard hierarchy.
- `az_solvents.json` — class field values: `"Recommended" | "Acceptable" | "Avoid"`. Same hazard hierarchy.
- `sanofi_solvents.json` — class field values: `"Green" | "Amber" | "Red"`. Same hazard hierarchy.
- `acs_gci_pr_unified.json` — class field values: `"Preferred" | "Acceptable" | "Avoid"`. Same hazard hierarchy.

For each guide, copy the chem21_solvents.json structure and replace the `class` and `score` fields with the per-vendor values. Use score=1 for the safest tier, increasing.

- [ ] **Step 2: Write failing tests for `/score_solvents`**

Append to `services/mcp_tools/mcp_green_chemistry/tests/test_mcp_green_chemistry.py`:

```python
def test_score_solvents_known_smiles(client):
    r = client.post("/score_solvents", json={"solvents": [{"smiles": "ClCCl"}]})
    assert r.status_code == 200
    body = r.json()
    assert len(body["results"]) == 1
    res = body["results"][0]
    assert res["chem21_class"] == "HighlyHazardous"
    assert res["match_confidence"] == "smiles_exact"
    assert res["canonical_smiles"] == "ClCCl"


def test_score_solvents_known_name_fuzzy(client):
    r = client.post("/score_solvents", json={"solvents": [{"name": "Dichloromethane"}]})
    assert r.status_code == 200
    body = r.json()
    res = body["results"][0]
    assert res["chem21_class"] == "HighlyHazardous"
    assert res["match_confidence"] in ("name_only", "inchikey")


def test_score_solvents_recommended(client):
    r = client.post("/score_solvents", json={"solvents": [{"smiles": "C1OCC(C)O1"}]})
    assert r.status_code == 200
    res = r.json()["results"][0]
    assert res["chem21_class"] == "Recommended"


def test_score_solvents_unmatched(client):
    r = client.post(
        "/score_solvents",
        json={"solvents": [{"smiles": "C1CC2CC1CC2"}]},  # made-up bicycloalkane
    )
    assert r.status_code == 200
    res = r.json()["results"][0]
    assert res["chem21_class"] is None
    assert res["match_confidence"] == "unmatched"


def test_score_solvents_batch(client):
    r = client.post(
        "/score_solvents",
        json={"solvents": [{"smiles": "CCO"}, {"smiles": "ClCCl"}, {"name": "Toluene"}]},
    )
    assert r.status_code == 200
    body = r.json()
    assert len(body["results"]) == 3
    assert body["results"][0]["chem21_class"] == "Recommended"
    assert body["results"][1]["chem21_class"] == "HighlyHazardous"
    assert body["results"][2]["chem21_class"] == "Problematic"


def test_score_solvents_empty_input_400(client):
    r = client.post("/score_solvents", json={"solvents": []})
    assert r.status_code in (400, 422)


def test_score_solvents_includes_all_vendor_classes(client):
    r = client.post("/score_solvents", json={"solvents": [{"smiles": "ClCCl"}]})
    res = r.json()["results"][0]
    for key in ["chem21_class", "gsk_class", "pfizer_class", "az_class", "sanofi_class", "acs_unified_class"]:
        assert key in res, f"missing key {key}"
```

Run: `.venv/bin/pytest services/mcp_tools/mcp_green_chemistry/tests/ -v -k score_solvents`
Expected: all fail (`/score_solvents` doesn't exist).

- [ ] **Step 3: Implement `/score_solvents`**

Append to `services/mcp_tools/mcp_green_chemistry/main.py` (above the `if __name__ == "__main__":` block):

```python
import json
from typing import Annotated, Any

from fastapi import Body
from pydantic import BaseModel, Field
from rapidfuzz import process as fuzz_process
from rdkit import Chem
from rdkit import RDLogger

from services.mcp_tools.common.limits import MAX_SMILES_LEN

# Suppress RDKit warning spam — invalid SMILES from user input is expected.
RDLogger.DisableLog("rdApp.warning")

# ---------------------------------------------------------------------------
# Static data
# ---------------------------------------------------------------------------

_VENDOR_FILES = {
    "chem21": "chem21_solvents.json",
    "gsk":    "gsk_solvents.json",
    "pfizer": "pfizer_solvents.json",
    "az":     "az_solvents.json",
    "sanofi": "sanofi_solvents.json",
    "acs":    "acs_gci_pr_unified.json",
}


def _load_vendor_table(filename: str) -> list[dict[str, Any]]:
    path = _DATA_DIR / filename
    if not path.exists():
        return []
    with path.open("r", encoding="utf-8") as f:
        return json.load(f)


def _canonical_smiles(smiles: str) -> str | None:
    """RDKit-canonicalize a SMILES; return None on parse failure."""
    mol = Chem.MolFromSmiles(smiles)
    if mol is None:
        return None
    return Chem.MolToSmiles(mol)


# Precompute lookup indexes at startup. Each vendor table is keyed by canonical
# SMILES and InChIKey for O(1) exact lookup, plus a name list for fuzzy match.
_VENDOR_INDEXES: dict[str, dict[str, Any]] = {}


def _build_indexes() -> None:
    for vendor, fname in _VENDOR_FILES.items():
        rows = _load_vendor_table(fname)
        by_canon: dict[str, dict[str, Any]] = {}
        by_inchi: dict[str, dict[str, Any]] = {}
        names: list[tuple[str, dict[str, Any]]] = []
        for row in rows:
            canon = _canonical_smiles(row["smiles"]) if row.get("smiles") else None
            if canon:
                by_canon[canon] = row
            ikey = row.get("inchikey")
            if ikey:
                by_inchi[ikey] = row
            name = row.get("name")
            if name:
                names.append((name, row))
        _VENDOR_INDEXES[vendor] = {
            "by_canon": by_canon,
            "by_inchi": by_inchi,
            "names": names,
        }


@app.on_event("startup")
async def _on_startup() -> None:
    if _is_ready():
        _build_indexes()


# ---------------------------------------------------------------------------
# /score_solvents
# ---------------------------------------------------------------------------

class SolventInput(BaseModel):
    smiles: str | None = Field(default=None, max_length=MAX_SMILES_LEN)
    name: str | None = Field(default=None, max_length=200)


class SolventScore(BaseModel):
    input: SolventInput
    canonical_smiles: str | None
    chem21_class: str | None
    chem21_score: float | None
    gsk_class: str | None
    pfizer_class: str | None
    az_class: str | None
    sanofi_class: str | None
    acs_unified_class: str | None
    match_confidence: str  # 'smiles_exact' | 'inchikey' | 'name_only' | 'unmatched'


class ScoreSolventsIn(BaseModel):
    solvents: list[SolventInput] = Field(min_length=1, max_length=50)


class ScoreSolventsOut(BaseModel):
    results: list[SolventScore]


def _lookup_one(s: SolventInput) -> SolventScore:
    """Look one solvent up across all six vendor tables.

    Match priority:
      1. Canonical SMILES exact match (best)
      2. InChIKey match (when SMILES not present but name has known inchikey)
      3. Fuzzy name match >= 90 score (last resort)
      4. Unmatched
    """
    canon: str | None = None
    if s.smiles:
        canon = _canonical_smiles(s.smiles)

    # Find a "primary hit" via the chem21 vendor table (drives match_confidence).
    chem21_idx = _VENDOR_INDEXES.get("chem21", {})
    primary_row: dict[str, Any] | None = None
    confidence = "unmatched"

    if canon and canon in chem21_idx.get("by_canon", {}):
        primary_row = chem21_idx["by_canon"][canon]
        confidence = "smiles_exact"
    elif s.name:
        names_table: list[tuple[str, dict[str, Any]]] = chem21_idx.get("names", [])
        if names_table:
            choices = [n for n, _ in names_table]
            best = fuzz_process.extractOne(s.name, choices, score_cutoff=90)
            if best is not None:
                _, score, idx = best
                primary_row = names_table[idx][1]
                confidence = "name_only"

    # Lookup each vendor independently, using the primary hit's canonical SMILES
    # if any (so the chem21 hit informs the GSK/Pfizer/etc. lookups).
    canon_for_lookup = canon or (primary_row.get("smiles") if primary_row else None)
    if canon_for_lookup:
        canon_for_lookup = _canonical_smiles(canon_for_lookup) or canon_for_lookup

    def _vendor_class(vendor: str) -> str | None:
        if not canon_for_lookup:
            return None
        idx = _VENDOR_INDEXES.get(vendor, {}).get("by_canon", {})
        row = idx.get(canon_for_lookup)
        return row.get("class") if row else None

    return SolventScore(
        input=s,
        canonical_smiles=canon_for_lookup,
        chem21_class=primary_row.get("class") if primary_row else None,
        chem21_score=(primary_row.get("score") if primary_row else None),
        gsk_class=_vendor_class("gsk"),
        pfizer_class=_vendor_class("pfizer"),
        az_class=_vendor_class("az"),
        sanofi_class=_vendor_class("sanofi"),
        acs_unified_class=_vendor_class("acs"),
        match_confidence=confidence,
    )


@app.post(
    "/score_solvents",
    response_model=ScoreSolventsOut,
    tags=["green_chemistry"],
)
async def score_solvents(
    req: Annotated[ScoreSolventsIn, Body(...)],
) -> ScoreSolventsOut:
    if not req.solvents:
        raise ValueError("solvents must be a non-empty list")
    results = [_lookup_one(s) for s in req.solvents]
    return ScoreSolventsOut(results=results)
```

- [ ] **Step 4: Run tests, expect pass**

```bash
.venv/bin/pytest services/mcp_tools/mcp_green_chemistry/tests/ -v
```
Expected: all 10 tests pass (3 healthz + 7 score_solvents).

- [ ] **Step 5: Commit**

```bash
git add services/mcp_tools/mcp_green_chemistry/
git commit -m "feat(z1): mcp-green-chemistry /score_solvents over 6 vendor guides"
```

---

## Task 3: Bretherick groups + `/assess_reaction_safety`

**Files:**
- Create: `services/mcp_tools/mcp_green_chemistry/data/bretherick_groups.json`
- Modify: `services/mcp_tools/mcp_green_chemistry/main.py`
- Modify: `services/mcp_tools/mcp_green_chemistry/tests/test_mcp_green_chemistry.py`

- [ ] **Step 1: Add Bretherick groups data file**

```json
[
  {"smarts": "[N+]=[N-]", "group_name": "Azide", "hazard_class": "Explosive", "notes": "Energetic; avoid > 1 mol scale"},
  {"smarts": "[N+]#N", "group_name": "Diazo", "hazard_class": "Explosive", "notes": "Highly reactive; ESD-sensitive"},
  {"smarts": "[N+](=O)[O-]", "group_name": "Nitro", "hazard_class": "Energetic", "notes": "Decomposition risk above 100°C"},
  {"smarts": "OO", "group_name": "Peroxide", "hazard_class": "Explosive", "notes": "Shock-sensitive"},
  {"smarts": "[Li,Na,K]C", "group_name": "Organolithium/Na/K", "hazard_class": "Pyrophoric", "notes": "Ignites in air"},
  {"smarts": "ClC#N", "group_name": "Cyanogen halide", "hazard_class": "Toxic", "notes": "Acutely toxic"},
  {"smarts": "[Cl,Br,I][C](=O)Cl", "group_name": "Acyl halide", "hazard_class": "Lachrymator", "notes": "Severe eye irritant; HCl on hydrolysis"},
  {"smarts": "C=C-O-O", "group_name": "Vinyl peroxide", "hazard_class": "Explosive", "notes": "Highly shock-sensitive"},
  {"smarts": "S(=O)(=O)Cl", "group_name": "Sulfonyl chloride", "hazard_class": "Lachrymator", "notes": "Severe eye/lung irritant"},
  {"smarts": "[B,Al]([Cl,F,H])([Cl,F,H])[Cl,F,H]", "group_name": "Group-13 halide/hydride", "hazard_class": "Pyrophoric", "notes": "Reacts violently with water"}
]
```

- [ ] **Step 2: Write failing tests**

Append to test file:

```python
def test_assess_reaction_safety_no_hazardous_groups(client):
    r = client.post(
        "/assess_reaction_safety",
        json={
            "reaction_smiles": "CC(=O)O.CCO>>CC(=O)OCC.O",  # esterification
            "solvents": [{"smiles": "C1OCC(C)O1"}],  # 2-MeTHF
        },
    )
    assert r.status_code == 200
    body = r.json()
    assert body["hazardous_groups"] == []
    assert body["overall_safety_class"] == "Recommended"
    assert isinstance(body["pmi_estimate"], (int, float))


def test_assess_reaction_safety_flags_azide(client):
    r = client.post(
        "/assess_reaction_safety",
        json={
            "reaction_smiles": "[N-]=[N+]=Nc1ccccc1.C#CCN>>c1ccc(-c2cn(CC#C)nn2)cc1",
            "solvents": [{"smiles": "O"}],
        },
    )
    assert r.status_code == 200
    body = r.json()
    group_names = [g["group_name"] for g in body["hazardous_groups"]]
    assert "Azide" in group_names


def test_assess_reaction_safety_solvent_drives_overall_class(client):
    """A perfectly safe reaction in DCM should still flag as Hazardous overall."""
    r = client.post(
        "/assess_reaction_safety",
        json={
            "reaction_smiles": "CC(=O)O.CCO>>CC(=O)OCC.O",
            "solvents": [{"smiles": "ClCCl"}],  # DCM = HighlyHazardous
        },
    )
    assert r.status_code == 200
    body = r.json()
    assert body["solvent_safety_score"] >= 8  # high hazard
    assert body["overall_safety_class"] == "HighlyHazardous"


def test_assess_reaction_safety_invalid_smiles_400(client):
    r = client.post(
        "/assess_reaction_safety",
        json={"reaction_smiles": "not a smiles", "solvents": []},
    )
    assert r.status_code in (400, 422)
```

Run: `.venv/bin/pytest services/mcp_tools/mcp_green_chemistry/tests/ -v -k assess_reaction_safety`
Expected: 4 fails.

- [ ] **Step 3: Implement `/assess_reaction_safety`**

Append to `main.py` above the `if __name__ == "__main__"` block:

```python
# ---------------------------------------------------------------------------
# Bretherick groups + /assess_reaction_safety
# ---------------------------------------------------------------------------

_BRETHERICK_GROUPS: list[dict[str, Any]] = []


@app.on_event("startup")
async def _load_bretherick() -> None:
    global _BRETHERICK_GROUPS
    path = _DATA_DIR / "bretherick_groups.json"
    if path.exists():
        with path.open("r", encoding="utf-8") as f:
            _BRETHERICK_GROUPS = json.load(f)


class HazardousGroupHit(BaseModel):
    smarts: str
    group_name: str
    hazard_class: str
    notes: str
    matched_atoms_in_reactants: int


class AssessReactionSafetyIn(BaseModel):
    reaction_smiles: str = Field(min_length=3, max_length=MAX_SMILES_LEN)
    solvents: list[SolventInput] = Field(default_factory=list, max_length=10)


class AssessReactionSafetyOut(BaseModel):
    pmi_estimate: float
    hazardous_groups: list[HazardousGroupHit]
    reactant_safety_score: float  # 0-10, higher = more hazardous
    solvent_safety_score: float
    overall_safety_class: str  # 'Recommended' | 'Problematic' | 'Hazardous' | 'HighlyHazardous'


def _split_reaction(rxn_smiles: str) -> tuple[str, str]:
    """Split 'A.B>>C' or 'A.B>X>C' into (reactants, products); reagents discarded."""
    if ">>" in rxn_smiles:
        left, right = rxn_smiles.split(">>", 1)
        return left, right
    parts = rxn_smiles.split(">")
    if len(parts) != 3:
        raise ValueError(f"reaction_smiles must contain '>>' or two '>': got {rxn_smiles!r}")
    return parts[0], parts[2]


def _estimate_pmi(reactants: str, products: str) -> float:
    """Estimate PMI as (reactant mass / product mass).

    Approximation: assume 1 mol of each component, use molecular weight from
    RDKit. True PMI requires actual stoichiometry / scale data; we label the
    output as estimate.
    """
    from rdkit.Chem.Descriptors import MolWt  # noqa: PLC0415

    react_mass = 0.0
    for s in reactants.split("."):
        m = Chem.MolFromSmiles(s)
        if m is not None:
            react_mass += MolWt(m)
    prod_mass = 0.0
    for s in products.split("."):
        m = Chem.MolFromSmiles(s)
        if m is not None:
            prod_mass += MolWt(m)
    if prod_mass <= 0:
        return float("inf")
    return float(react_mass / prod_mass)


def _scan_bretherick(reactants_smiles: str) -> list[HazardousGroupHit]:
    hits: list[HazardousGroupHit] = []
    for s in reactants_smiles.split("."):
        mol = Chem.MolFromSmiles(s)
        if mol is None:
            continue
        for group in _BRETHERICK_GROUPS:
            patt = Chem.MolFromSmarts(group["smarts"])
            if patt is None:
                continue
            matches = mol.GetSubstructMatches(patt)
            if matches:
                hits.append(
                    HazardousGroupHit(
                        smarts=group["smarts"],
                        group_name=group["group_name"],
                        hazard_class=group["hazard_class"],
                        notes=group["notes"],
                        matched_atoms_in_reactants=sum(len(m) for m in matches),
                    )
                )
    return hits


def _solvent_safety_score(solvents: list[SolventInput]) -> float:
    """Worst-class score across the supplied solvents (0-10).

    Uses chem21 score field; unmatched solvents contribute a small uncertainty
    penalty (3.0) so they don't silently pass through as 0.
    """
    if not solvents:
        return 0.0
    chem21_idx = _VENDOR_INDEXES.get("chem21", {}).get("by_canon", {})
    worst = 0.0
    for s in solvents:
        canon = _canonical_smiles(s.smiles) if s.smiles else None
        if canon and canon in chem21_idx:
            worst = max(worst, float(chem21_idx[canon].get("score", 0.0)))
        else:
            worst = max(worst, 3.0)  # unmatched penalty
    return worst


def _overall_class(reactant_hits: list[HazardousGroupHit], solvent_score: float) -> str:
    if any(h.hazard_class in ("Explosive", "Pyrophoric") for h in reactant_hits):
        return "HighlyHazardous"
    if solvent_score >= 8:
        return "HighlyHazardous"
    if solvent_score >= 5 or reactant_hits:
        return "Hazardous"
    if solvent_score >= 3:
        return "Problematic"
    return "Recommended"


@app.post(
    "/assess_reaction_safety",
    response_model=AssessReactionSafetyOut,
    tags=["green_chemistry"],
)
async def assess_reaction_safety(
    req: Annotated[AssessReactionSafetyIn, Body(...)],
) -> AssessReactionSafetyOut:
    reactants, products = _split_reaction(req.reaction_smiles)
    if not reactants.strip() or not products.strip():
        raise ValueError("reaction_smiles must have non-empty reactants and products")

    pmi = _estimate_pmi(reactants, products)
    hits = _scan_bretherick(reactants)
    reactant_score = float(min(10.0, 2.5 * len(hits)))  # 2.5 per group, cap 10
    solvent_score = _solvent_safety_score(req.solvents)
    overall = _overall_class(hits, solvent_score)
    return AssessReactionSafetyOut(
        pmi_estimate=pmi,
        hazardous_groups=hits,
        reactant_safety_score=reactant_score,
        solvent_safety_score=solvent_score,
        overall_safety_class=overall,
    )
```

- [ ] **Step 4: Run tests, expect pass**

```bash
.venv/bin/pytest services/mcp_tools/mcp_green_chemistry/tests/ -v
```
Expected: all 14 tests pass (3 healthz + 7 score_solvents + 4 assess_reaction_safety).

- [ ] **Step 5: Commit**

```bash
git add services/mcp_tools/mcp_green_chemistry/
git commit -m "feat(z1): mcp-green-chemistry /assess_reaction_safety + Bretherick"
```

---

## Task 4: `mcp_green_chemistry` Dockerfile + docker-compose registration

**Files:**
- Create: `services/mcp_tools/mcp_green_chemistry/Dockerfile`
- Modify: `docker-compose.yml`

- [ ] **Step 1: Add Dockerfile**

```dockerfile
FROM python:3.11-slim
WORKDIR /app

RUN apt-get update && apt-get install -y --no-install-recommends \
      build-essential libxrender1 libxext6 \
  && rm -rf /var/lib/apt/lists/*

COPY services/mcp_tools/mcp_green_chemistry/requirements.txt /app/services/mcp_tools/mcp_green_chemistry/requirements.txt
RUN pip install --no-cache-dir -r /app/services/mcp_tools/mcp_green_chemistry/requirements.txt

COPY services/__init__.py /app/services/__init__.py
COPY services/mcp_tools/__init__.py /app/services/mcp_tools/__init__.py
COPY services/mcp_tools/common /app/services/mcp_tools/common
COPY services/mcp_tools/mcp_green_chemistry /app/services/mcp_tools/mcp_green_chemistry

ENV PYTHONPATH=/app
EXPOSE 8019

RUN useradd -r -u 1001 app && chown -R app /app
USER 1001

CMD ["python", "-m", "uvicorn", "services.mcp_tools.mcp_green_chemistry.main:app", \
     "--host", "0.0.0.0", "--port", "8019"]
```

- [ ] **Step 2: Add to docker-compose.yml**

Find the `mcp-askcos` block in `docker-compose.yml` (around line 678). After the `mcp-askcos` service block, add:

```yaml
  # mcp-green-chemistry — solvent guide + Bretherick lookup (port 8019)
  mcp-green-chemistry:
    build:
      context: .
      dockerfile: services/mcp_tools/mcp_green_chemistry/Dockerfile
    container_name: chemclaw-mcp-green-chemistry
    image: chemclaw/mcp-green-chemistry:dev
    profiles: ["chemistry"]
    environment:
      MCP_AUTH_SIGNING_KEY: ${MCP_AUTH_SIGNING_KEY:?required}
      LOG_LEVEL: ${LOG_LEVEL:-INFO}
    ports:
      - "8019:8019"
    healthcheck:
      test: ["CMD", "python", "-c", "import urllib.request; urllib.request.urlopen('http://localhost:8019/healthz').read()"]
      interval: 30s
      timeout: 5s
      retries: 3
    security_opt:
      - "no-new-privileges:true"
    restart: unless-stopped
```

- [ ] **Step 3: Verify compose file parses**

```bash
docker compose --profile chemistry config --services 2>&1 | grep mcp-green-chemistry
```
Expected: `mcp-green-chemistry` is listed.

- [ ] **Step 4: Commit**

```bash
git add services/mcp_tools/mcp_green_chemistry/Dockerfile docker-compose.yml
git commit -m "feat(z1): mcp-green-chemistry Dockerfile + compose registration"
```

---

## Task 5: `mcp_applicability_domain` skeleton + drfp_stats artifact

**Files:**
- Create: `services/mcp_tools/mcp_applicability_domain/__init__.py`
- Create: `services/mcp_tools/mcp_applicability_domain/main.py`
- Create: `services/mcp_tools/mcp_applicability_domain/requirements.txt`
- Create: `services/mcp_tools/mcp_applicability_domain/tests/__init__.py`
- Create: `services/mcp_tools/mcp_applicability_domain/tests/test_mcp_applicability_domain.py`
- Create: `services/mcp_tools/mcp_applicability_domain/data/drfp_stats_v1.json`
- Create: `services/mcp_tools/mcp_applicability_domain/scripts/build_drfp_stats.py`

- [ ] **Step 1: Write failing skeleton tests**

```python
# services/mcp_tools/mcp_applicability_domain/tests/test_mcp_applicability_domain.py
"""Tests for mcp-applicability-domain FastAPI app."""
from __future__ import annotations

import json
from pathlib import Path
from unittest import mock

import pytest
from fastapi.testclient import TestClient


@pytest.fixture()
def client():
    from services.mcp_tools.mcp_applicability_domain.main import app  # noqa: PLC0415
    with TestClient(app) as c:
        yield c


def test_healthz(client):
    r = client.get("/healthz")
    assert r.status_code == 200
    assert r.json()["service"] == "mcp-applicability-domain"


def test_readyz_503_when_stats_missing(tmp_path):
    missing = tmp_path / "no_stats.json"
    with mock.patch(
        "services.mcp_tools.mcp_applicability_domain.main._STATS_PATH",
        missing,
    ):
        from services.mcp_tools.mcp_applicability_domain.main import app
        with TestClient(app) as c:
            r = c.get("/readyz")
            assert r.status_code == 503


def test_stats_artifact_loads(client):
    """The shipped drfp_stats_v1.json artifact loads at startup."""
    from services.mcp_tools.mcp_applicability_domain.main import _STATS  # noqa: PLC0415
    assert _STATS is not None
    assert "mean" in _STATS
    assert "var_diag" in _STATS
    assert len(_STATS["mean"]) == 2048
    assert len(_STATS["var_diag"]) == 2048
    assert _STATS["n_train"] >= 1
    assert "threshold_in" in _STATS
    assert "threshold_out" in _STATS
```

Run: `.venv/bin/pytest services/mcp_tools/mcp_applicability_domain/tests/ -v`
Expected: 3 fails (module doesn't exist).

- [ ] **Step 2: Implement skeleton**

```python
# services/mcp_tools/mcp_applicability_domain/__init__.py
```
(empty)

```python
# services/mcp_tools/mcp_applicability_domain/main.py
"""mcp-applicability-domain — three-signal AD verdict service (port 8017).

Tools:
- POST /calibrate  — supply per-project residuals, get a calibration_id (cached)
- POST /assess     — three-signal AD verdict given a query DRFP vector +
                     nearest-neighbor distance + (calibration_id or inline residuals)

Stateless math + an LRU cache of per-project calibration sets (30-min TTL).
The DB lives in agent-claw, not here.
"""

from __future__ import annotations

import json
import logging
import os
from pathlib import Path
from typing import Any

from services.mcp_tools.common.app import create_app
from services.mcp_tools.common.settings import ToolSettings

log = logging.getLogger("mcp-applicability-domain")
settings = ToolSettings()

_STATS_PATH = Path(os.environ.get(
    "MCP_AD_STATS_PATH",
    str(Path(__file__).parent / "data" / "drfp_stats_v1.json"),
))

_STATS: dict[str, Any] | None = None


def _load_stats() -> dict[str, Any] | None:
    if not _STATS_PATH.exists():
        return None
    with _STATS_PATH.open("r", encoding="utf-8") as f:
        return json.load(f)


def _is_ready() -> bool:
    return _STATS is not None


app = create_app(
    name="mcp-applicability-domain",
    version="0.1.0",
    log_level=settings.log_level,
    ready_check=_is_ready,
    required_scope="mcp_applicability_domain:invoke",
)


@app.on_event("startup")
async def _on_startup() -> None:
    global _STATS
    _STATS = _load_stats()


if __name__ == "__main__":
    import uvicorn

    uvicorn.run(
        "services.mcp_tools.mcp_applicability_domain.main:app",
        host=settings.host,
        port=settings.port,
        log_level=settings.log_level.lower(),
    )
```

```
# services/mcp_tools/mcp_applicability_domain/requirements.txt
fastapi>=0.115
uvicorn[standard]>=0.32
pydantic>=2.8
pydantic-settings>=2.4
numpy>=1.26
```

```python
# services/mcp_tools/mcp_applicability_domain/tests/__init__.py
```
(empty)

- [ ] **Step 3: Generate the shipped drfp_stats_v1.json**

Write the offline build script:

```python
# services/mcp_tools/mcp_applicability_domain/scripts/build_drfp_stats.py
"""Build a DRFP stats artifact from a Postgres reactions corpus.

Run inside the chemclaw .venv:
    .venv/bin/python services/mcp_tools/mcp_applicability_domain/scripts/build_drfp_stats.py

Reads `reactions.drfp_vector` cross-project as chemclaw_service (BYPASSRLS) and
emits aggregate mean + diagonal covariance + chi-square thresholds. This is
aggregate-only data; no per-row leakage.
"""
from __future__ import annotations

import json
import os
import sys
from pathlib import Path

import numpy as np

try:
    import psycopg
except ImportError:
    print("psycopg not installed; install with `.venv/bin/pip install psycopg`", file=sys.stderr)
    sys.exit(1)


def main() -> None:
    dsn = os.environ.get("CHEMCLAW_SERVICE_DSN")
    if not dsn:
        print("Set CHEMCLAW_SERVICE_DSN (chemclaw_service role) to build from real data.")
        print("Falling back to synthetic stats for dev.")
        _write_synthetic()
        return

    with psycopg.connect(dsn) as conn:
        with conn.cursor() as cur:
            cur.execute("SET search_path TO public")
            cur.execute(
                "SELECT drfp_vector::text FROM reactions "
                "WHERE drfp_vector IS NOT NULL"
            )
            rows = cur.fetchall()

    if not rows:
        print("No drfp_vector rows; emitting synthetic stats.")
        _write_synthetic()
        return

    # pgvector serializes as '[0,1,0,...]'.
    vectors = []
    for (text,) in rows:
        bits = json.loads(text)
        vectors.append(bits)
    arr = np.asarray(vectors, dtype=np.float64)

    mean = arr.mean(axis=0)
    var = arr.var(axis=0) + 1e-6  # ridge for zero-variance bits
    n_train = arr.shape[0]
    # Chi-square 95th and 99th percentiles for df=2048.
    threshold_in = 2150.0
    threshold_out = 2200.0

    out = {
        "mean": mean.tolist(),
        "var_diag": var.tolist(),
        "n_train": int(n_train),
        "snapshot_at": "2026-04-30T00:00:00Z",
        "threshold_in": threshold_in,
        "threshold_out": threshold_out,
        "version": "drfp_stats_v1",
    }
    target = Path(__file__).resolve().parents[1] / "data" / "drfp_stats_v1.json"
    target.parent.mkdir(parents=True, exist_ok=True)
    target.write_text(json.dumps(out))
    print(f"Wrote {target} (n_train={n_train})")


def _write_synthetic() -> None:
    """Fallback synthetic stats so tests can run without a live DB."""
    mean = [0.05] * 2048
    var = [0.05 * 0.95] * 2048
    out = {
        "mean": mean,
        "var_diag": var,
        "n_train": 1,
        "snapshot_at": "2026-04-30T00:00:00Z",
        "threshold_in": 2150.0,
        "threshold_out": 2200.0,
        "version": "drfp_stats_v1_synthetic",
    }
    target = Path(__file__).resolve().parents[1] / "data" / "drfp_stats_v1.json"
    target.parent.mkdir(parents=True, exist_ok=True)
    target.write_text(json.dumps(out))
    print(f"Wrote synthetic {target}")


if __name__ == "__main__":
    main()
```

Run the script to generate the artifact:

```bash
.venv/bin/python services/mcp_tools/mcp_applicability_domain/scripts/build_drfp_stats.py
```
Expected: synthetic artifact written.

- [ ] **Step 4: Run tests, expect pass**

```bash
.venv/bin/pytest services/mcp_tools/mcp_applicability_domain/tests/ -v
```
Expected: 3 passed.

- [ ] **Step 5: Commit**

```bash
git add services/mcp_tools/mcp_applicability_domain/
git commit -m "feat(z1): mcp-applicability-domain skeleton + drfp_stats artifact"
```

---

## Task 6: `/calibrate` endpoint + LRU cache

**Files:**
- Modify: `services/mcp_tools/mcp_applicability_domain/main.py`
- Modify: `services/mcp_tools/mcp_applicability_domain/tests/test_mcp_applicability_domain.py`

- [ ] **Step 1: Write failing tests**

Append to test file:

```python
def test_calibrate_returns_id(client):
    r = client.post(
        "/calibrate",
        json={
            "project_id": "00000000-0000-0000-0000-000000000001",
            "residuals": [5.0, 10.0, 15.0, 20.0, 25.0],
        },
    )
    assert r.status_code == 200
    body = r.json()
    assert "calibration_id" in body
    assert body["calibration_size"] == 5


def test_calibrate_deterministic_id(client):
    body = {
        "project_id": "00000000-0000-0000-0000-000000000001",
        "residuals": [5.0, 10.0, 15.0],
    }
    r1 = client.post("/calibrate", json=body).json()
    r2 = client.post("/calibrate", json=body).json()
    assert r1["calibration_id"] == r2["calibration_id"]


def test_calibrate_residuals_must_be_nonempty(client):
    r = client.post(
        "/calibrate",
        json={"project_id": "00000000-0000-0000-0000-000000000001", "residuals": []},
    )
    assert r.status_code in (400, 422)


def test_calibrate_residuals_must_be_nonneg(client):
    r = client.post(
        "/calibrate",
        json={"project_id": "00000000-0000-0000-0000-000000000001", "residuals": [-1.0]},
    )
    assert r.status_code in (400, 422)
```

Run: `.venv/bin/pytest services/mcp_tools/mcp_applicability_domain/tests/ -v -k calibrate`
Expected: 4 fails.

- [ ] **Step 2: Implement `/calibrate`**

Append to `main.py` above the `if __name__ == "__main__":` block:

```python
import hashlib
import time
from typing import Annotated

from fastapi import Body
from pydantic import BaseModel, Field

# ---------------------------------------------------------------------------
# /calibrate — server-side LRU cache of per-project conformal calibration sets
#
# Cache shape: dict[calibration_id] = {"residuals": np.ndarray, "expires_at": float}
# TTL: 30 minutes. Cap: 256 entries (LRU). Builtin re-supplies on miss.
# ---------------------------------------------------------------------------

_CALIBRATION_CACHE: dict[str, dict[str, Any]] = {}
_CALIBRATION_TTL_SEC = 30 * 60
_CALIBRATION_CAP = 256


def _calibration_id(project_id: str, residuals: list[float]) -> str:
    """Deterministic id from (project_id, sorted residuals)."""
    h = hashlib.sha256()
    h.update(project_id.encode("utf-8"))
    for r in sorted(residuals):
        h.update(f"{r:.6f}|".encode("ascii"))
    return h.hexdigest()[:16]


def _evict_expired() -> None:
    now = time.time()
    expired = [k for k, v in _CALIBRATION_CACHE.items() if v["expires_at"] < now]
    for k in expired:
        del _CALIBRATION_CACHE[k]
    while len(_CALIBRATION_CACHE) > _CALIBRATION_CAP:
        # Pop oldest by expires_at.
        oldest_k = min(_CALIBRATION_CACHE, key=lambda k: _CALIBRATION_CACHE[k]["expires_at"])
        del _CALIBRATION_CACHE[oldest_k]


class CalibrateIn(BaseModel):
    project_id: str = Field(min_length=1, max_length=64)
    residuals: list[float] = Field(min_length=1, max_length=1000)


class CalibrateOut(BaseModel):
    calibration_id: str
    calibration_size: int
    cached_for_seconds: int


@app.post(
    "/calibrate",
    response_model=CalibrateOut,
    tags=["applicability_domain"],
)
async def calibrate(
    req: Annotated[CalibrateIn, Body(...)],
) -> CalibrateOut:
    if any(r < 0 for r in req.residuals):
        raise ValueError("residuals must be non-negative (|true - predicted|)")

    cid = _calibration_id(req.project_id, req.residuals)
    _evict_expired()
    _CALIBRATION_CACHE[cid] = {
        "residuals": list(req.residuals),  # plain list; numpy lazy on /assess
        "expires_at": time.time() + _CALIBRATION_TTL_SEC,
    }
    return CalibrateOut(
        calibration_id=cid,
        calibration_size=len(req.residuals),
        cached_for_seconds=_CALIBRATION_TTL_SEC,
    )
```

- [ ] **Step 3: Run tests, expect pass**

```bash
.venv/bin/pytest services/mcp_tools/mcp_applicability_domain/tests/ -v
```
Expected: 7 passed.

- [ ] **Step 4: Commit**

```bash
git add services/mcp_tools/mcp_applicability_domain/
git commit -m "feat(z1): mcp-applicability-domain /calibrate + LRU cache"
```

---

## Task 7: `/assess` endpoint with all 3 signals + verdict aggregation

**Files:**
- Modify: `services/mcp_tools/mcp_applicability_domain/main.py`
- Modify: `services/mcp_tools/mcp_applicability_domain/tests/test_mcp_applicability_domain.py`

- [ ] **Step 1: Write failing tests covering all signals + verdict matrix**

Append to test file:

```python
import numpy as np


def _vec(seed: int, n: int = 2048) -> list[float]:
    """Deterministic 0/1 vector for tests."""
    rng = np.random.default_rng(seed)
    return rng.integers(0, 2, size=n).astype(float).tolist()


def test_assess_tanimoto_in_band(client):
    """nearest_neighbor_distance <= 0.50 → tanimoto.in_band=True."""
    r = client.post(
        "/assess",
        json={
            "query_drfp_vector": _vec(1),
            "nearest_neighbor_distance": 0.30,
            "calibration_id": None,
            "inline_residuals": [10.0] * 50,
        },
    )
    assert r.status_code == 200
    body = r.json()
    assert body["tanimoto_signal"]["in_band"] is True
    assert body["tanimoto_signal"]["distance"] == pytest.approx(0.30)


def test_assess_tanimoto_out_of_band(client):
    r = client.post(
        "/assess",
        json={
            "query_drfp_vector": _vec(2),
            "nearest_neighbor_distance": 0.85,  # > 0.70
            "inline_residuals": [10.0] * 50,
        },
    )
    body = r.json()
    assert body["tanimoto_signal"]["in_band"] is False


def test_assess_mahalanobis_signal_bounded(client):
    """A vector close to the mean has small Mahalanobis distance."""
    from services.mcp_tools.mcp_applicability_domain.main import _STATS
    mean = _STATS["mean"]
    # Use a vector identical to mean → Mahalanobis ≈ 0 → in_band.
    r = client.post(
        "/assess",
        json={
            "query_drfp_vector": list(mean),
            "nearest_neighbor_distance": 0.4,
            "inline_residuals": [10.0] * 50,
        },
    )
    body = r.json()
    assert body["mahalanobis_signal"]["mahalanobis"] >= 0
    assert body["mahalanobis_signal"]["in_band"] is True


def test_assess_conformal_uses_inline_residuals(client):
    """80% quantile of [5,10,15,20,...,100] (n=20) is 80.0."""
    residuals = [5.0 * i for i in range(1, 21)]
    r = client.post(
        "/assess",
        json={
            "query_drfp_vector": _vec(3),
            "nearest_neighbor_distance": 0.4,
            "inline_residuals": residuals,
        },
    )
    body = r.json()
    cs = body["conformal_signal"]
    assert cs is not None
    # 80% quantile = 80.0 (residuals[16] in zero-indexed empirical CDF).
    assert cs["half_width"] == pytest.approx(80.0, abs=2.0)
    assert cs["alpha"] == pytest.approx(0.20)
    # half_width=80 > threshold_out=50 → out-of-band.
    assert cs["in_band"] is False


def test_assess_conformal_abstains_when_no_residuals(client):
    """Empty inline_residuals + no calibration_id → conformal abstains."""
    r = client.post(
        "/assess",
        json={
            "query_drfp_vector": _vec(4),
            "nearest_neighbor_distance": 0.4,
            "inline_residuals": [],
        },
    )
    body = r.json()
    assert body["conformal_signal"] is None
    assert body["used_global_fallback"] is True


def test_assess_calibration_id_unknown_returns_404(client):
    r = client.post(
        "/assess",
        json={
            "query_drfp_vector": _vec(5),
            "nearest_neighbor_distance": 0.4,
            "calibration_id": "deadbeef00000000",
        },
    )
    assert r.status_code == 404
    assert "calibration_id_unknown" in r.json().get("detail", "")


def test_assess_verdict_in_domain(client):
    """All 3 signals in_band → verdict 'in_domain'."""
    from services.mcp_tools.mcp_applicability_domain.main import _STATS
    r = client.post(
        "/assess",
        json={
            "query_drfp_vector": list(_STATS["mean"]),  # mahalanobis ~ 0
            "nearest_neighbor_distance": 0.2,            # tanimoto in_band
            "inline_residuals": [5.0] * 50,              # half_width ~ 5 < 30
        },
    )
    body = r.json()
    assert body["verdict"] == "in_domain"


def test_assess_verdict_borderline_majority(client):
    """2 of 3 signals in_band → verdict 'borderline'."""
    from services.mcp_tools.mcp_applicability_domain.main import _STATS
    r = client.post(
        "/assess",
        json={
            "query_drfp_vector": list(_STATS["mean"]),  # mahalanobis in_band
            "nearest_neighbor_distance": 0.85,           # tanimoto OUT
            "inline_residuals": [5.0] * 50,              # conformal in_band
        },
    )
    assert r.json()["verdict"] == "borderline"


def test_assess_verdict_out_of_domain(client):
    """0 or 1 of 3 signals in_band → 'out_of_domain'."""
    r = client.post(
        "/assess",
        json={
            "query_drfp_vector": _vec(6),               # mahalanobis OUT (random vec)
            "nearest_neighbor_distance": 0.85,            # tanimoto OUT
            "inline_residuals": [60.0] * 50,             # half_width=60 > 50 OUT
        },
    )
    body = r.json()
    assert body["verdict"] == "out_of_domain"


def test_assess_verdict_with_conformal_abstain_strict(client):
    """Conformal abstains, both other signals must be in_band for 'in_domain'."""
    from services.mcp_tools.mcp_applicability_domain.main import _STATS
    r = client.post(
        "/assess",
        json={
            "query_drfp_vector": list(_STATS["mean"]),
            "nearest_neighbor_distance": 0.2,
            "inline_residuals": [],
        },
    )
    body = r.json()
    assert body["used_global_fallback"] is True
    assert body["verdict"] == "in_domain"
```

Run: `.venv/bin/pytest services/mcp_tools/mcp_applicability_domain/tests/ -v -k assess`
Expected: 10 fails.

- [ ] **Step 2: Implement `/assess`**

Append to `main.py` above the `if __name__` block:

```python
import numpy as np
from fastapi import HTTPException

# ---------------------------------------------------------------------------
# /assess
# ---------------------------------------------------------------------------

# Tanimoto / DRFP-distance bands (cosine distance on binary fingerprints).
_TANIMOTO_THRESHOLD_IN = 0.50
_TANIMOTO_THRESHOLD_OUT = 0.70

# Conformal interval width (yield-percentage points).
_CONFORMAL_ALPHA = 0.20  # 80% nominal coverage
_CONFORMAL_THRESHOLD_IN = 30.0
_CONFORMAL_THRESHOLD_OUT = 50.0
_CONFORMAL_MIN_N = 30  # below this, abstain entirely


class AssessIn(BaseModel):
    query_drfp_vector: list[float] = Field(min_length=2048, max_length=2048)
    nearest_neighbor_distance: float = Field(ge=0.0, le=1.0)
    calibration_id: str | None = Field(default=None, max_length=64)
    inline_residuals: list[float] = Field(default_factory=list, max_length=1000)


class TanimotoSignal(BaseModel):
    distance: float
    tanimoto: float
    threshold_in: float
    threshold_out: float
    in_band: bool


class MahalanobisSignal(BaseModel):
    mahalanobis: float
    threshold_in: float
    threshold_out: float
    in_band: bool
    stats_version: str
    n_train: int


class ConformalSignal(BaseModel):
    alpha: float
    half_width: float
    calibration_size: int
    used_global_fallback: bool
    threshold_in: float
    threshold_out: float
    in_band: bool


class AssessOut(BaseModel):
    verdict: str  # 'in_domain' | 'borderline' | 'out_of_domain'
    tanimoto_signal: TanimotoSignal
    mahalanobis_signal: MahalanobisSignal
    conformal_signal: ConformalSignal | None
    used_global_fallback: bool


def _resolve_residuals(req: AssessIn) -> tuple[list[float], bool]:
    """Return (residuals, used_global_fallback)."""
    if req.calibration_id is not None:
        _evict_expired()
        entry = _CALIBRATION_CACHE.get(req.calibration_id)
        if entry is None:
            raise HTTPException(
                status_code=404,
                detail="calibration_id_unknown — re-supply via /calibrate and retry",
            )
        return entry["residuals"], False
    return list(req.inline_residuals), True


def _tanimoto_signal(distance: float) -> TanimotoSignal:
    return TanimotoSignal(
        distance=distance,
        tanimoto=1.0 - distance,
        threshold_in=_TANIMOTO_THRESHOLD_IN,
        threshold_out=_TANIMOTO_THRESHOLD_OUT,
        in_band=distance <= _TANIMOTO_THRESHOLD_IN,
    )


def _mahalanobis_signal(query: list[float]) -> MahalanobisSignal:
    assert _STATS is not None
    x = np.asarray(query, dtype=np.float64)
    mu = np.asarray(_STATS["mean"], dtype=np.float64)
    var = np.asarray(_STATS["var_diag"], dtype=np.float64)
    diff = x - mu
    # Diagonal Mahalanobis: sum((x - μ)² / var)
    m_dist = float(np.sum((diff * diff) / var))
    return MahalanobisSignal(
        mahalanobis=m_dist,
        threshold_in=float(_STATS["threshold_in"]),
        threshold_out=float(_STATS["threshold_out"]),
        in_band=m_dist <= float(_STATS["threshold_in"]),
        stats_version=str(_STATS.get("version", "drfp_stats_v1")),
        n_train=int(_STATS["n_train"]),
    )


def _conformal_signal(residuals: list[float], used_fallback: bool) -> ConformalSignal | None:
    n = len(residuals)
    if n < _CONFORMAL_MIN_N:
        return None
    arr = np.asarray(residuals, dtype=np.float64)
    half_width = float(np.quantile(arr, 1.0 - _CONFORMAL_ALPHA))
    return ConformalSignal(
        alpha=_CONFORMAL_ALPHA,
        half_width=half_width,
        calibration_size=n,
        used_global_fallback=used_fallback,
        threshold_in=_CONFORMAL_THRESHOLD_IN,
        threshold_out=_CONFORMAL_THRESHOLD_OUT,
        in_band=half_width <= _CONFORMAL_THRESHOLD_IN,
    )


def _aggregate_verdict(
    t: TanimotoSignal,
    m: MahalanobisSignal,
    c: ConformalSignal | None,
) -> str:
    in_band_count = (1 if t.in_band else 0) + (1 if m.in_band else 0) + (1 if c and c.in_band else 0)
    usable = 3 if c is not None else 2
    if in_band_count == usable:
        return "in_domain"
    # majority: ceil(usable/2) → 2 of 3, 1 of 2
    if in_band_count >= -(-usable // 2):
        return "borderline"
    return "out_of_domain"


@app.post(
    "/assess",
    response_model=AssessOut,
    tags=["applicability_domain"],
)
async def assess(
    req: Annotated[AssessIn, Body(...)],
) -> AssessOut:
    if _STATS is None:
        raise HTTPException(status_code=503, detail="drfp_stats artifact not loaded")
    residuals, used_fallback_inline = _resolve_residuals(req)
    t = _tanimoto_signal(req.nearest_neighbor_distance)
    m = _mahalanobis_signal(req.query_drfp_vector)
    c = _conformal_signal(residuals, used_fallback_inline)
    used_fallback = (c is None) or (used_fallback_inline and c is not None)
    verdict = _aggregate_verdict(t, m, c)
    return AssessOut(
        verdict=verdict,
        tanimoto_signal=t,
        mahalanobis_signal=m,
        conformal_signal=c,
        used_global_fallback=used_fallback,
    )
```

- [ ] **Step 3: Run tests, expect pass**

```bash
.venv/bin/pytest services/mcp_tools/mcp_applicability_domain/tests/ -v
```
Expected: 17 passed (3 + 4 calibrate + 10 assess).

- [ ] **Step 4: Commit**

```bash
git add services/mcp_tools/mcp_applicability_domain/
git commit -m "feat(z1): mcp-applicability-domain /assess + 3-signal verdict"
```

---

## Task 8: `mcp_applicability_domain` Dockerfile + docker-compose registration

**Files:**
- Create: `services/mcp_tools/mcp_applicability_domain/Dockerfile`
- Modify: `docker-compose.yml`

- [ ] **Step 1: Add Dockerfile**

```dockerfile
FROM python:3.11-slim
WORKDIR /app

COPY services/mcp_tools/mcp_applicability_domain/requirements.txt /app/services/mcp_tools/mcp_applicability_domain/requirements.txt
RUN pip install --no-cache-dir -r /app/services/mcp_tools/mcp_applicability_domain/requirements.txt

COPY services/__init__.py /app/services/__init__.py
COPY services/mcp_tools/__init__.py /app/services/mcp_tools/__init__.py
COPY services/mcp_tools/common /app/services/mcp_tools/common
COPY services/mcp_tools/mcp_applicability_domain /app/services/mcp_tools/mcp_applicability_domain

ENV PYTHONPATH=/app
EXPOSE 8017

RUN useradd -r -u 1001 app && chown -R app /app
USER 1001

CMD ["python", "-m", "uvicorn", "services.mcp_tools.mcp_applicability_domain.main:app", \
     "--host", "0.0.0.0", "--port", "8017"]
```

- [ ] **Step 2: Add to docker-compose.yml**

Insert after the `mcp-green-chemistry` block from Task 4:

```yaml
  # mcp-applicability-domain — 3-signal AD verdict (port 8017)
  mcp-applicability-domain:
    build:
      context: .
      dockerfile: services/mcp_tools/mcp_applicability_domain/Dockerfile
    container_name: chemclaw-mcp-applicability-domain
    image: chemclaw/mcp-applicability-domain:dev
    profiles: ["chemistry"]
    environment:
      MCP_AUTH_SIGNING_KEY: ${MCP_AUTH_SIGNING_KEY:?required}
      LOG_LEVEL: ${LOG_LEVEL:-INFO}
    ports:
      - "8017:8017"
    healthcheck:
      test: ["CMD", "python", "-c", "import urllib.request; urllib.request.urlopen('http://localhost:8017/healthz').read()"]
      interval: 30s
      timeout: 5s
      retries: 3
    security_opt:
      - "no-new-privileges:true"
    restart: unless-stopped
```

- [ ] **Step 3: Verify compose**

```bash
docker compose --profile chemistry config --services 2>&1 | grep mcp-applicability-domain
```
Expected: present.

- [ ] **Step 4: Commit**

```bash
git add services/mcp_tools/mcp_applicability_domain/Dockerfile docker-compose.yml
git commit -m "feat(z1): mcp-applicability-domain Dockerfile + compose registration"
```

---

## Task 9: `score_green_chemistry.ts` builtin

**Files:**
- Create: `services/agent-claw/src/tools/builtins/score_green_chemistry.ts`
- Create: `services/agent-claw/tests/unit/builtins/score_green_chemistry.test.ts`

- [ ] **Step 1: Write failing test**

```typescript
// services/agent-claw/tests/unit/builtins/score_green_chemistry.test.ts
import { describe, it, expect, vi, afterEach } from "vitest";
import { buildScoreGreenChemistryTool } from "../../../src/tools/builtins/score_green_chemistry.js";

const URL_ = "http://mcp-green-chemistry:8019";

function makeCtx() {
  const seenFactIds = new Set<string>();
  const scratchpad = new Map<string, unknown>([["seenFactIds", seenFactIds]]);
  return { userEntraId: "test@example.com", scratchpad, seenFactIds };
}

const FAKE_RESPONSE = {
  results: [
    {
      input: { smiles: "ClCCl" },
      canonical_smiles: "ClCCl",
      chem21_class: "HighlyHazardous",
      chem21_score: 9,
      gsk_class: "Major Issues",
      pfizer_class: "Avoid",
      az_class: "Avoid",
      sanofi_class: "Red",
      acs_unified_class: "Avoid",
      match_confidence: "smiles_exact",
    },
  ],
};

afterEach(() => vi.unstubAllGlobals());

describe("buildScoreGreenChemistryTool", () => {
  it("calls /score_solvents and returns results", async () => {
    const mockFetch = vi.fn().mockResolvedValue({
      ok: true,
      text: async () => JSON.stringify(FAKE_RESPONSE),
    });
    vi.stubGlobal("fetch", mockFetch);

    const tool = buildScoreGreenChemistryTool(URL_);
    const result = await tool.execute(makeCtx(), { solvents: [{ smiles: "ClCCl" }] });

    expect(result.results).toHaveLength(1);
    expect(result.results[0].chem21_class).toBe("HighlyHazardous");

    const [url] = mockFetch.mock.calls[0] as [string];
    expect(url).toBe(`${URL_}/score_solvents`);
  });

  it("rejects empty solvents list", () => {
    const tool = buildScoreGreenChemistryTool(URL_);
    expect(tool.inputSchema.safeParse({ solvents: [] }).success).toBe(false);
  });

  it("strips trailing slash", async () => {
    const mockFetch = vi.fn().mockResolvedValue({
      ok: true,
      text: async () => JSON.stringify(FAKE_RESPONSE),
    });
    vi.stubGlobal("fetch", mockFetch);
    const tool = buildScoreGreenChemistryTool(`${URL_}/`);
    await tool.execute(makeCtx(), { solvents: [{ smiles: "ClCCl" }] });
    const [url] = mockFetch.mock.calls[0] as [string];
    expect(url).toBe(`${URL_}/score_solvents`);
  });
});
```

- [ ] **Step 2: Run, expect failure**

```bash
cd services/agent-claw && npx vitest run tests/unit/builtins/score_green_chemistry.test.ts 2>&1 | tail -10
```
Expected: import error.

- [ ] **Step 3: Implement**

```typescript
// services/agent-claw/src/tools/builtins/score_green_chemistry.ts
// score_green_chemistry — wraps mcp-green-chemistry /score_solvents.

import { z } from "zod";
import { defineTool } from "../tool.js";
import { postJson } from "../../mcp/postJson.js";
import { MAX_SMILES_LEN } from "../_limits.js";

const SolventInput = z.object({
  smiles: z.string().min(1).max(MAX_SMILES_LEN).optional(),
  name: z.string().min(1).max(200).optional(),
});

export const ScoreGreenChemistryIn = z.object({
  solvents: z.array(SolventInput).min(1).max(50),
});
export type ScoreGreenChemistryInput = z.infer<typeof ScoreGreenChemistryIn>;

const SolventScore = z.object({
  input: SolventInput,
  canonical_smiles: z.string().nullable(),
  chem21_class: z.string().nullable(),
  chem21_score: z.number().nullable(),
  gsk_class: z.string().nullable(),
  pfizer_class: z.string().nullable(),
  az_class: z.string().nullable(),
  sanofi_class: z.string().nullable(),
  acs_unified_class: z.string().nullable(),
  match_confidence: z.string(),
});

export const ScoreGreenChemistryOut = z.object({
  results: z.array(SolventScore),
});
export type ScoreGreenChemistryOutput = z.infer<typeof ScoreGreenChemistryOut>;

const TIMEOUT_MS = 10_000;

export function buildScoreGreenChemistryTool(mcpUrl: string) {
  const base = mcpUrl.replace(/\/$/, "");
  return defineTool({
    id: "score_green_chemistry",
    description:
      "Score a list of solvents against CHEM21 / GSK / Pfizer / AZ / Sanofi / ACS GCI-PR " +
      "guides. Returns per-solvent class + score plus a unified match_confidence " +
      "(smiles_exact / inchikey / name_only / unmatched). Use BEFORE proposing " +
      "conditions to a chemist so the soft-greenness penalty in condition-design " +
      "can be applied.",
    inputSchema: ScoreGreenChemistryIn,
    outputSchema: ScoreGreenChemistryOut,
    annotations: { readOnly: true },
    execute: async (_ctx, input) => {
      return await postJson(
        `${base}/score_solvents`,
        { solvents: input.solvents },
        ScoreGreenChemistryOut,
        TIMEOUT_MS,
        "mcp-green-chemistry",
      );
    },
  });
}
```

- [ ] **Step 4: Run tests**

```bash
cd services/agent-claw && npx vitest run tests/unit/builtins/score_green_chemistry.test.ts
```
Expected: 3 passed.

- [ ] **Step 5: Commit**

```bash
cd /Users/robertmoeckel/Documents/VSCode/chemclaw/chemclaw-applicability-domain-z1
git add services/agent-claw/src/tools/builtins/score_green_chemistry.ts services/agent-claw/tests/unit/builtins/score_green_chemistry.test.ts
git commit -m "feat(z1): score_green_chemistry builtin"
```

---

## Task 10: `assess_applicability_domain.ts` builtin

**Files:**
- Create: `services/agent-claw/src/tools/builtins/assess_applicability_domain.ts`
- Create: `services/agent-claw/tests/unit/builtins/assess_applicability_domain.test.ts`

The orchestration is more involved than Task 9. Inputs: `rxn_smiles` + optional `project_internal_id`. Internally:
1. POST `mcp-drfp /encode` with the rxn_smiles → vector
2. SELECT nearest neighbor distance from `reactions.drfp_vector` (RLS-scoped via `withUserContext`)
3. SELECT up to 100 calibration `(rxn_smiles, yield_pct)` pairs from the project (RLS); if < 30, re-run without project filter (still RLS-scoped); if cross-project total < 30 → conformal abstains
4. POST `mcp-chemprop /predict_yield` for the calibration rxns → predicted yields → residuals = |true - pred|
5. POST `mcp-applicability-domain /calibrate` → calibration_id
6. POST `mcp-applicability-domain /assess` with vector + nearest distance + calibration_id (or empty inline_residuals when abstaining)
7. On 404 from /assess, retry once after re-supplying via /calibrate

- [ ] **Step 1: Write the failing tests**

```typescript
// services/agent-claw/tests/unit/builtins/assess_applicability_domain.test.ts
import { describe, it, expect, vi, afterEach } from "vitest";
import { buildAssessApplicabilityDomainTool } from "../../../src/tools/builtins/assess_applicability_domain.js";

const URLS = {
  drfp: "http://mcp-drfp:8002",
  chemprop: "http://mcp-chemprop:8009",
  ad: "http://mcp-applicability-domain:8017",
};

function makeCtx() {
  const seenFactIds = new Set<string>();
  const scratchpad = new Map<string, unknown>([["seenFactIds", seenFactIds]]);
  return { userEntraId: "test@example.com", scratchpad, seenFactIds };
}

function makePoolMock(opts: {
  nearestDistance: number | null;
  calibrationRows: Array<{ rxn_smiles: string; yield_pct: number }>;
  bootstrapRows?: Array<{ rxn_smiles: string; yield_pct: number }>;
}) {
  const queries: string[] = [];
  let queryCount = 0;
  return {
    queries,
    pool: {
      query: vi.fn(async (sql: string, _params?: unknown[]) => {
        queries.push(sql);
        queryCount++;
        if (sql.includes("drfp_vector <=>")) {
          return {
            rows: opts.nearestDistance !== null ? [{ distance: opts.nearestDistance }] : [],
          };
        }
        if (sql.includes("yield_pct IS NOT NULL")) {
          // First call: project-scoped. Second call (if any): cross-project bootstrap.
          if (queryCount === 2) {
            return { rows: opts.calibrationRows };
          }
          return { rows: opts.bootstrapRows ?? opts.calibrationRows };
        }
        return { rows: [] };
      }),
    },
  };
}

const ENCODED_VECTOR = Array.from({ length: 2048 }, () => 0);
const FAKE_DRFP_RESPONSE = { vector: ENCODED_VECTOR, on_bit_count: 0 };

afterEach(() => vi.unstubAllGlobals());

describe("buildAssessApplicabilityDomainTool", () => {
  it("happy path: project has enough calibration → in_domain verdict", async () => {
    const calibrationRows = Array.from({ length: 50 }, (_, i) => ({
      rxn_smiles: `CC>>CC${i}`,
      yield_pct: 50 + i,
    }));
    const { pool } = makePoolMock({ nearestDistance: 0.3, calibrationRows });

    const fetchMock = vi.fn();
    // 1) drfp /encode
    fetchMock.mockResolvedValueOnce({
      ok: true,
      text: async () => JSON.stringify(FAKE_DRFP_RESPONSE),
    });
    // 2) chemprop /predict_yield (residuals computed from this)
    fetchMock.mockResolvedValueOnce({
      ok: true,
      text: async () => JSON.stringify({
        predictions: calibrationRows.map((r) => ({
          rxn_smiles: r.rxn_smiles,
          predicted_yield: r.yield_pct + 10,  // residual 10 each
          std: 1.0,
          model_id: "yield_model@v1",
        })),
      }),
    });
    // 3) ad /calibrate
    fetchMock.mockResolvedValueOnce({
      ok: true,
      text: async () => JSON.stringify({
        calibration_id: "abcdef0123456789",
        calibration_size: 50,
        cached_for_seconds: 1800,
      }),
    });
    // 4) ad /assess
    fetchMock.mockResolvedValueOnce({
      ok: true,
      text: async () => JSON.stringify({
        verdict: "in_domain",
        tanimoto_signal: { distance: 0.3, tanimoto: 0.7, threshold_in: 0.5, threshold_out: 0.7, in_band: true },
        mahalanobis_signal: { mahalanobis: 100, threshold_in: 2150, threshold_out: 2200, in_band: true, stats_version: "drfp_stats_v1", n_train: 1 },
        conformal_signal: { alpha: 0.20, half_width: 10, calibration_size: 50, used_global_fallback: false, threshold_in: 30, threshold_out: 50, in_band: true },
        used_global_fallback: false,
      }),
    });
    vi.stubGlobal("fetch", fetchMock);

    const tool = buildAssessApplicabilityDomainTool(pool as never, URLS.drfp, URLS.chemprop, URLS.ad);
    const result = await tool.execute(makeCtx(), {
      rxn_smiles: "CC.OO>>CC(=O)O",
      project_internal_id: "PRJ-001",
    });

    expect(result.verdict).toBe("in_domain");
    expect(result.tanimoto_signal.in_band).toBe(true);
    expect(result.conformal_signal?.in_band).toBe(true);
    expect(fetchMock).toHaveBeenCalledTimes(4);
  });

  it("bootstrap path: project has 0 calibration → falls back to cross-project", async () => {
    const bootstrapRows = Array.from({ length: 40 }, (_, i) => ({
      rxn_smiles: `CC>>CC${i}`,
      yield_pct: 50 + i,
    }));
    const { pool, queries } = makePoolMock({
      nearestDistance: 0.4,
      calibrationRows: [],
      bootstrapRows,
    });

    const fetchMock = vi.fn();
    fetchMock.mockResolvedValueOnce({ ok: true, text: async () => JSON.stringify(FAKE_DRFP_RESPONSE) });
    fetchMock.mockResolvedValueOnce({
      ok: true,
      text: async () => JSON.stringify({
        predictions: bootstrapRows.map((r) => ({
          rxn_smiles: r.rxn_smiles,
          predicted_yield: r.yield_pct,
          std: 1.0,
          model_id: "y@v1",
        })),
      }),
    });
    fetchMock.mockResolvedValueOnce({
      ok: true,
      text: async () => JSON.stringify({
        calibration_id: "boot01",
        calibration_size: 40,
        cached_for_seconds: 1800,
      }),
    });
    fetchMock.mockResolvedValueOnce({
      ok: true,
      text: async () => JSON.stringify({
        verdict: "borderline",
        tanimoto_signal: { distance: 0.4, tanimoto: 0.6, threshold_in: 0.5, threshold_out: 0.7, in_band: true },
        mahalanobis_signal: { mahalanobis: 2160, threshold_in: 2150, threshold_out: 2200, in_band: false, stats_version: "v1", n_train: 1 },
        conformal_signal: { alpha: 0.20, half_width: 5, calibration_size: 40, used_global_fallback: true, threshold_in: 30, threshold_out: 50, in_band: true },
        used_global_fallback: true,
      }),
    });
    vi.stubGlobal("fetch", fetchMock);

    const tool = buildAssessApplicabilityDomainTool(pool as never, URLS.drfp, URLS.chemprop, URLS.ad);
    const result = await tool.execute(makeCtx(), {
      rxn_smiles: "CC>>CC",
      project_internal_id: "PRJ-EMPTY",
    });

    // Pool query was called 3x: nearest neighbor, project-scoped (empty), cross-project bootstrap.
    expect(pool.query).toHaveBeenCalledTimes(3);
    expect(result.used_global_fallback).toBe(true);
  });

  it("conformal abstain: cross-project total < 30 → returns abstain", async () => {
    const { pool } = makePoolMock({
      nearestDistance: 0.5,
      calibrationRows: [],
      bootstrapRows: [{ rxn_smiles: "CC>>CC", yield_pct: 80 }],  // only 1 row
    });

    const fetchMock = vi.fn();
    fetchMock.mockResolvedValueOnce({ ok: true, text: async () => JSON.stringify(FAKE_DRFP_RESPONSE) });
    // No /predict_yield call; no /calibrate call. Direct /assess with empty inline_residuals.
    fetchMock.mockResolvedValueOnce({
      ok: true,
      text: async () => JSON.stringify({
        verdict: "borderline",
        tanimoto_signal: { distance: 0.5, tanimoto: 0.5, threshold_in: 0.5, threshold_out: 0.7, in_band: true },
        mahalanobis_signal: { mahalanobis: 100, threshold_in: 2150, threshold_out: 2200, in_band: true, stats_version: "v1", n_train: 1 },
        conformal_signal: null,
        used_global_fallback: true,
      }),
    });
    vi.stubGlobal("fetch", fetchMock);

    const tool = buildAssessApplicabilityDomainTool(pool as never, URLS.drfp, URLS.chemprop, URLS.ad);
    const result = await tool.execute(makeCtx(), { rxn_smiles: "CC>>CC" });

    expect(result.conformal_signal).toBeNull();
    expect(result.used_global_fallback).toBe(true);
    expect(fetchMock).toHaveBeenCalledTimes(2);  // drfp + assess only
  });

  it("inputSchema requires non-empty rxn_smiles", () => {
    const { pool } = makePoolMock({ nearestDistance: 0.5, calibrationRows: [] });
    const tool = buildAssessApplicabilityDomainTool(pool as never, URLS.drfp, URLS.chemprop, URLS.ad);
    expect(tool.inputSchema.safeParse({ rxn_smiles: "" }).success).toBe(false);
  });
});
```

- [ ] **Step 2: Run, expect failure**

```bash
cd services/agent-claw && npx vitest run tests/unit/builtins/assess_applicability_domain.test.ts 2>&1 | tail -10
```
Expected: import error.

- [ ] **Step 3: Implement**

```typescript
// services/agent-claw/src/tools/builtins/assess_applicability_domain.ts
// assess_applicability_domain — three-signal AD verdict (Z1).
//
// Orchestrates: drfp encode → pgvector nearest-neighbor (RLS) → calibration
// pull (project, fallback to cross-RLS) → chemprop predict → residuals →
// /calibrate → /assess. Cache miss on /assess re-supplies once.

import { z } from "zod";
import type { Pool } from "pg";
import { defineTool } from "../tool.js";
import { postJson } from "../../mcp/postJson.js";
import { withUserContext } from "../../db/with-user-context.js";
import { MAX_RXN_SMILES_LEN } from "../_limits.js";

const CONFORMAL_MIN_N = 30;
const CALIBRATION_LIMIT = 100;

// ---------- Schemas ---------------------------------------------------------

export const AssessApplicabilityDomainIn = z.object({
  rxn_smiles: z.string().min(3).max(MAX_RXN_SMILES_LEN),
  project_internal_id: z.string().max(200).optional(),
});
export type AssessApplicabilityDomainInput = z.infer<typeof AssessApplicabilityDomainIn>;

const TanimotoSignal = z.object({
  distance: z.number(),
  tanimoto: z.number(),
  threshold_in: z.number(),
  threshold_out: z.number(),
  in_band: z.boolean(),
});

const MahalanobisSignal = z.object({
  mahalanobis: z.number(),
  threshold_in: z.number(),
  threshold_out: z.number(),
  in_band: z.boolean(),
  stats_version: z.string(),
  n_train: z.number().int(),
});

const ConformalSignal = z.object({
  alpha: z.number(),
  half_width: z.number(),
  calibration_size: z.number().int(),
  used_global_fallback: z.boolean(),
  threshold_in: z.number(),
  threshold_out: z.number(),
  in_band: z.boolean(),
});

export const AssessApplicabilityDomainOut = z.object({
  verdict: z.enum(["in_domain", "borderline", "out_of_domain"]),
  tanimoto_signal: TanimotoSignal,
  mahalanobis_signal: MahalanobisSignal,
  conformal_signal: ConformalSignal.nullable(),
  used_global_fallback: z.boolean(),
});
export type AssessApplicabilityDomainOutput = z.infer<typeof AssessApplicabilityDomainOut>;

// MCP response schemas (intentionally narrow — the AD MCP enforces the rest).
const DrfpEncodeOut = z.object({
  vector: z.array(z.number()),
  on_bit_count: z.number().int().nonnegative(),
});

const ChempropPredictYieldOut = z.object({
  predictions: z.array(
    z.object({
      rxn_smiles: z.string(),
      predicted_yield: z.number(),
      std: z.number(),
      model_id: z.string(),
    }),
  ),
});

const CalibrateOut = z.object({
  calibration_id: z.string(),
  calibration_size: z.number().int(),
  cached_for_seconds: z.number().int(),
});

// ---------- Helpers ---------------------------------------------------------

function toVectorLiteral(bits: number[]): string {
  return "[" + bits.map((b) => (b ? "1" : "0")).join(",") + "]";
}

interface CalibrationRow {
  rxn_smiles: string;
  yield_pct: number;
}

async function fetchCalibrationRows(
  pool: Pool,
  userEntraId: string,
  projectInternalId: string | undefined,
): Promise<{ rows: CalibrationRow[]; usedGlobalFallback: boolean }> {
  return withUserContext(pool, userEntraId, async (client) => {
    let projectRows: CalibrationRow[] = [];
    if (projectInternalId) {
      const { rows } = await client.query<CalibrationRow>(
        `SELECT r.rxn_smiles, e.yield_pct::float AS yield_pct
           FROM reactions r
           JOIN experiments e ON e.id = r.experiment_id
           JOIN synthetic_steps s ON s.id = e.synthetic_step_id
           JOIN nce_projects p ON p.id = s.nce_project_id
          WHERE p.internal_id = $1
            AND e.yield_pct IS NOT NULL
            AND r.rxn_smiles IS NOT NULL
          LIMIT $2`,
        [projectInternalId, CALIBRATION_LIMIT],
      );
      projectRows = rows;
    }
    if (projectRows.length >= CONFORMAL_MIN_N) {
      return { rows: projectRows, usedGlobalFallback: false };
    }
    // Bootstrap path: pull cross-RLS-accessible calibration data without
    // the project filter. Still RLS-scoped — only projects this user can see.
    const { rows: bootstrapRows } = await client.query<CalibrationRow>(
      `SELECT r.rxn_smiles, e.yield_pct::float AS yield_pct
         FROM reactions r
         JOIN experiments e ON e.id = r.experiment_id
        WHERE e.yield_pct IS NOT NULL
          AND r.rxn_smiles IS NOT NULL
        LIMIT $1`,
      [CALIBRATION_LIMIT],
    );
    return { rows: bootstrapRows, usedGlobalFallback: true };
  });
}

async function fetchNearestDistance(
  pool: Pool,
  userEntraId: string,
  vectorLiteral: string,
): Promise<number | null> {
  return withUserContext(pool, userEntraId, async (client) => {
    const { rows } = await client.query<{ distance: number }>(
      `SELECT r.drfp_vector <=> $1::vector AS distance
         FROM reactions r
        WHERE r.drfp_vector IS NOT NULL
        ORDER BY r.drfp_vector <=> $1::vector ASC
        LIMIT 1`,
      [vectorLiteral],
    );
    return rows.length > 0 ? Number(rows[0].distance) : null;
  });
}

// ---------- Factory --------------------------------------------------------

export function buildAssessApplicabilityDomainTool(
  pool: Pool,
  drfpUrl: string,
  chempropUrl: string,
  adUrl: string,
) {
  const drfpBase = drfpUrl.replace(/\/$/, "");
  const chempropBase = chempropUrl.replace(/\/$/, "");
  const adBase = adUrl.replace(/\/$/, "");

  return defineTool({
    id: "assess_applicability_domain",
    description:
      "Three-signal applicability-domain verdict for a reaction: Tanimoto-NN " +
      "in DRFP space, Mahalanobis in feature space, and conformal-prediction " +
      "interval width. Returns the verdict ('in_domain' / 'borderline' / " +
      "'out_of_domain') plus all underlying scores. Annotate-don't-block: " +
      "the verdict is descriptive; the chemist still sees every recommendation.",
    inputSchema: AssessApplicabilityDomainIn,
    outputSchema: AssessApplicabilityDomainOut,
    annotations: { readOnly: true },

    execute: async (ctx, input) => {
      const userEntraId = ctx.userEntraId;
      if (!userEntraId) {
        throw new Error("assess_applicability_domain requires userEntraId in context");
      }

      // 1. Encode the query reaction.
      const encoded = await postJson(
        `${drfpBase}/encode`,
        { rxn_smiles: input.rxn_smiles },
        DrfpEncodeOut,
        15_000,
        "mcp-drfp",
      );
      const vectorLiteral = toVectorLiteral(encoded.vector);

      // 2. Nearest-neighbor distance (RLS).
      const nearestDistance = await fetchNearestDistance(pool, userEntraId, vectorLiteral);

      // 3. Calibration pull (RLS), with cross-project bootstrap fallback.
      const { rows: calibrationRows, usedGlobalFallback } = await fetchCalibrationRows(
        pool,
        userEntraId,
        input.project_internal_id,
      );

      // 4. Conformal abstain when even the cross-project pool is too small.
      const conformalAbstain = calibrationRows.length < CONFORMAL_MIN_N;

      // 5. Build the /assess request body.
      let calibrationId: string | null = null;
      let inlineResiduals: number[] = [];

      if (!conformalAbstain) {
        // Predict yields on the calibration rxns and compute residuals.
        const predResp = await postJson(
          `${chempropBase}/predict_yield`,
          { rxn_smiles_list: calibrationRows.map((r) => r.rxn_smiles) },
          ChempropPredictYieldOut,
          60_000,
          "mcp-chemprop",
        );
        const residuals = predResp.predictions.map((p, i) =>
          Math.abs(calibrationRows[i].yield_pct - p.predicted_yield),
        );

        // POST /calibrate to get a calibration_id.
        const calibrated = await postJson(
          `${adBase}/calibrate`,
          {
            project_id: input.project_internal_id ?? "__cross_project_bootstrap__",
            residuals,
          },
          CalibrateOut,
          10_000,
          "mcp-applicability-domain",
        );
        calibrationId = calibrated.calibration_id;
      }

      // 6. Issue the /assess call. Retry once on 404 (cache miss).
      const assessBody = {
        query_drfp_vector: encoded.vector,
        nearest_neighbor_distance: nearestDistance ?? 1.0, // empty corpus → max distance
        calibration_id: calibrationId,
        inline_residuals: conformalAbstain ? [] : [],  // residuals live on cache, not inline
      };

      try {
        return await postJson(
          `${adBase}/assess`,
          assessBody,
          AssessApplicabilityDomainOut,
          15_000,
          "mcp-applicability-domain",
        );
      } catch (err) {
        const msg = err instanceof Error ? err.message : String(err);
        if (msg.includes("404") && !conformalAbstain && input.project_internal_id) {
          // Cache miss after restart. Re-supply once via /calibrate, then retry.
          const predResp = await postJson(
            `${chempropBase}/predict_yield`,
            { rxn_smiles_list: calibrationRows.map((r) => r.rxn_smiles) },
            ChempropPredictYieldOut,
            60_000,
            "mcp-chemprop",
          );
          const residuals = predResp.predictions.map((p, i) =>
            Math.abs(calibrationRows[i].yield_pct - p.predicted_yield),
          );
          const recalibrated = await postJson(
            `${adBase}/calibrate`,
            { project_id: input.project_internal_id, residuals },
            CalibrateOut,
            10_000,
            "mcp-applicability-domain",
          );
          return await postJson(
            `${adBase}/assess`,
            { ...assessBody, calibration_id: recalibrated.calibration_id },
            AssessApplicabilityDomainOut,
            15_000,
            "mcp-applicability-domain",
          );
        }
        throw err;
      }
    },
  });
}
```

- [ ] **Step 4: Run tests**

```bash
cd services/agent-claw && npx vitest run tests/unit/builtins/assess_applicability_domain.test.ts
```
Expected: 4 passed.

- [ ] **Step 5: Commit**

```bash
cd /Users/robertmoeckel/Documents/VSCode/chemclaw/chemclaw-applicability-domain-z1
git add services/agent-claw/src/tools/builtins/assess_applicability_domain.ts services/agent-claw/tests/unit/builtins/assess_applicability_domain.test.ts
git commit -m "feat(z1): assess_applicability_domain builtin"
```

---

## Task 11: Wire builtins into config + dependencies + tools seed + model_cards

**Files:**
- Modify: `services/agent-claw/src/config.ts`
- Modify: `services/agent-claw/src/bootstrap/dependencies.ts`
- Modify: `db/seed/05_harness_tools.sql`
- Modify: `db/init/19_reaction_optimization.sql`

- [ ] **Step 1: Add config keys**

In `services/agent-claw/src/config.ts`, add the two new MCP URL keys alongside the existing chemistry MCP URLs (search for `MCP_ASKCOS_URL` to find the cluster):

```typescript
  MCP_APPLICABILITY_DOMAIN_URL: z.string().url().default("http://localhost:8017"),
  MCP_GREEN_CHEMISTRY_URL: z.string().url().default("http://localhost:8019"),
```

- [ ] **Step 2: Register builtins in dependencies.ts**

In `services/agent-claw/src/bootstrap/dependencies.ts`, add imports near the existing chemistry-builtin imports:

```typescript
import { buildAssessApplicabilityDomainTool } from "../tools/builtins/assess_applicability_domain.js";
import { buildScoreGreenChemistryTool } from "../tools/builtins/score_green_chemistry.js";
```

In `registerBuiltinTools(...)`, add registrations next to the existing chemistry builtins:

```typescript
  registry.registerBuiltin("score_green_chemistry", () =>
    asTool(buildScoreGreenChemistryTool(cfg.MCP_GREEN_CHEMISTRY_URL)),
  );
  registry.registerBuiltin("assess_applicability_domain", () =>
    asTool(buildAssessApplicabilityDomainTool(
      pool,
      cfg.MCP_DRFP_URL,
      cfg.MCP_CHEMPROP_URL,
      cfg.MCP_APPLICABILITY_DOMAIN_URL,
    )),
  );
```

- [ ] **Step 3: Seed the tools-table rows**

Append to `db/seed/05_harness_tools.sql` (before the final `COMMIT;`):

```sql
-- ── Applicability-domain & green-chemistry (Phase Z1) ─────────────────────

INSERT INTO tools (name, source, schema_json, description, enabled, version)
VALUES (
  'score_green_chemistry',
  'builtin',
  '{
    "type": "object",
    "properties": {
      "solvents": {
        "type": "array",
        "items": {
          "type": "object",
          "properties": {
            "smiles": {"type": "string", "minLength": 1, "maxLength": 10000},
            "name":   {"type": "string", "minLength": 1, "maxLength": 200}
          }
        },
        "minItems": 1,
        "maxItems": 50,
        "description": "Solvents to score; each entry needs a smiles or a name."
      }
    },
    "required": ["solvents"]
  }',
  'Score solvents against CHEM21 / GSK / Pfizer / AZ / Sanofi / ACS GCI-PR guides. Returns per-solvent class + score + match_confidence (smiles_exact / inchikey / name_only / unmatched). Use BEFORE proposing conditions so the soft-greenness penalty in condition-design can be applied.',
  true,
  1
)
ON CONFLICT (name) DO UPDATE SET
  source = EXCLUDED.source, schema_json = EXCLUDED.schema_json,
  description = EXCLUDED.description, enabled = EXCLUDED.enabled, version = EXCLUDED.version;

INSERT INTO tools (name, source, schema_json, description, enabled, version)
VALUES (
  'assess_applicability_domain',
  'builtin',
  '{
    "type": "object",
    "properties": {
      "rxn_smiles": {
        "type": "string",
        "minLength": 3,
        "maxLength": 20000,
        "description": "Reaction SMILES (reactants>>products)."
      },
      "project_internal_id": {
        "type": "string",
        "maxLength": 200,
        "description": "Optional NCE project internal_id; calibration is per-project."
      }
    },
    "required": ["rxn_smiles"]
  }',
  'Three-signal applicability-domain verdict for a reaction: Tanimoto-NN, Mahalanobis, conformal-prediction interval width. Returns verdict (in_domain/borderline/out_of_domain) + underlying scores. Annotate-don''t-block: the verdict is descriptive; the chemist still sees every recommendation.',
  true,
  1
)
ON CONFLICT (name) DO UPDATE SET
  source = EXCLUDED.source, schema_json = EXCLUDED.schema_json,
  description = EXCLUDED.description, enabled = EXCLUDED.enabled, version = EXCLUDED.version;
```

- [ ] **Step 4: Add model_cards rows**

Append to `db/init/19_reaction_optimization.sql`, before the `COMMIT;`:

```sql
-- ── Z1 model_cards rows ──────────────────────────────────────────────────

INSERT INTO model_cards (
  service_name,
  model_version,
  defined_endpoint,
  algorithm,
  applicability_domain,
  predictivity_metrics,
  mechanistic_interpretation,
  trained_on
) VALUES (
  'mcp_applicability_domain',
  'ad_3signal@v1',
  'Three-signal AD verdict for a reaction: in_domain / borderline / out_of_domain plus per-signal scores (Tanimoto distance, Mahalanobis distance, conformal-prediction half-width).',
  'Deterministic threshold logic on three independent metrics: cosine distance to nearest in-house DRFP neighbor; diagonal Mahalanobis distance against shipped DRFP corpus stats; inductive conformal prediction over per-project chemprop residuals (alpha=0.20, 80% nominal coverage). Verdict aggregates by majority vote when conformal usable; tighter rule when conformal abstains.',
  'Operates on any reaction the upstream mcp_drfp service can encode. Conformal signal abstains when project (or cross-RLS-accessible projects) has < 30 yield-labeled reactions.',
  '{"verdict_distribution_target": {"in_domain": 0.70, "borderline": 0.25, "out_of_domain": 0.05}, "notes": "Z7 wires /eval evaluation against held-out mock_eln slice."}'::jsonb,
  'Tanimoto reflects nearest-analog availability; Mahalanobis reflects feature-space density; conformal interval reflects yield-model calibrated uncertainty. None are causal; all three are statistical proxies for predictive reliability.',
  'DRFP stats over mock_eln seed (~2000 reactions); per-project conformal calibration over experiments.yield_pct (RLS-scoped).'
)
ON CONFLICT (service_name, model_version) DO NOTHING;

INSERT INTO model_cards (
  service_name,
  model_version,
  defined_endpoint,
  algorithm,
  applicability_domain,
  predictivity_metrics,
  mechanistic_interpretation,
  trained_on
) VALUES (
  'mcp_green_chemistry',
  'solvent_lookup@v1',
  'Per-solvent CHEM21 / GSK / Pfizer / AZ / Sanofi / ACS GCI-PR class + reaction-safety estimate (PMI, Bretherick group hits).',
  'Dictionary lookup keyed on RDKit-canonicalized SMILES with InChIKey + fuzzy-name fallback (rapidfuzz, score>=90); PMI from (mass_input - mass_product) / mass_product computed via RDKit MolWt; Bretherick SMARTS matching against shipped hazardous-group library.',
  'Solvents present in any of the seven shipped guides; unmatched solvents return match_confidence: unmatched and null class fields. Bretherick group library covers ~10 high-frequency hazard motifs (azide, peroxide, organolithium, etc.); not exhaustive.',
  '{}'::jsonb,
  'No mechanistic model. Industry / academic guides curated by their authors. PMI is a widely-used pharmaceutical greenness proxy; Bretherick groups encode known thermal / shock / reactive hazards.',
  'Prat et al. Green Chem. 2016 (CHEM21); GSK guide; Alfonsi et al. Green Chem. 2008 (Pfizer); Diorazio et al. Org. Process Res. Dev. 2016 (AZ); Prat et al. Org. Process Res. Dev. 2013 (Sanofi); Byrne et al. 2016 (ACS GCI-PR); Bretherick subset (public-disclosable patterns only).'
)
ON CONFLICT (service_name, model_version) DO NOTHING;
```

- [ ] **Step 5: Run typecheck and full vitest**

```bash
cd services/agent-claw && npx tsc --noEmit && npm test 2>&1 | tail -20
```
Expected: tsc clean; all tests pass (existing + new).

- [ ] **Step 6: Commit**

```bash
cd /Users/robertmoeckel/Documents/VSCode/chemclaw/chemclaw-applicability-domain-z1
git add services/agent-claw/src/config.ts services/agent-claw/src/bootstrap/dependencies.ts db/seed/05_harness_tools.sql db/init/19_reaction_optimization.sql
git commit -m "feat(z1): wire AD + green-chem builtins; seed tools + model_cards"
```

---

## Task 12: Update `condition-design` skill v1 → v2

**Files:**
- Modify: `skills/condition-design/SKILL.md`

- [ ] **Step 1: Rewrite the skill**

Replace the file contents:

```markdown
---
id: condition-design
description: "Propose forward reaction conditions (catalyst / reagent / solvent / temperature) for a target transformation, anchored to historical analogs. Returns AD verdict + soft-greenness-adjusted ranking."
version: 2
tools:
  - canonicalize_smiles
  - recommend_conditions
  - find_similar_reactions
  - assess_applicability_domain
  - score_green_chemistry
  - predict_reaction_yield
  - search_knowledge
  - query_kg
  - fetch_original_document
max_steps_override: 25
---

# Condition Design skill (v2 — AD + greenness)

Activated when the user asks "what conditions for X", "propose conditions for
this reaction", "Buchwald between A and B?", or types
`/conditions <reactants> >> <product>`.

## Approach

1. **Canonicalize inputs.** Pass reactants and product through
   `canonicalize_smiles` so all downstream tools see the same representation.
2. **Recommend conditions.** Call `recommend_conditions` with the canonical
   reactants + product (default top_k=5). Output: ranked list of
   {catalysts, reagents, solvents, temperature_c, score}.
3. **Anchor to historical analog.** For each top recommendation, call
   `find_similar_reactions` on the reaction SMILES (`reactants>>product`).
   Cite the nearest analog as `[rxn:<uuid>]`.
4. **Applicability-domain check (Z1, NEW).** Call
   `assess_applicability_domain` ONCE for the query reaction (NOT once per
   recommendation — they all share the same reaction). Pass
   `project_internal_id` from the user's session context if available.
   The result has `verdict`, `tanimoto_signal`, `mahalanobis_signal`,
   `conformal_signal`, `used_global_fallback`. **All recommendations inherit
   the same verdict.** Annotate-don't-block: surface the verdict but do not
   suppress recommendations.
5. **Greenness scoring (Z1, NEW).** Collect the union of solvents across all
   top-k recommendations. Call `score_green_chemistry` once with the union.
   Map results back to each recommendation by canonical SMILES.
6. **Soft-penalty re-ranking (Z1, NEW).** For each recommendation, compute:
   ```
   hazard_penalty_per_solvent = {
       'HighlyHazardous': 0.40, 'Hazardous': 0.20,
       'Problematic': 0.10, 'Recommended': 0.00, null: 0.05
   }
   worst_penalty   = max over the recommendation's solvents
   final_rank_score = recommender_score * (1.0 - worst_penalty)
   ```
   Re-rank by `final_rank_score` descending. **Show both the original
   recommender_score AND final_rank_score in the rendered table.**
7. **Yield sanity check.** For each top-3 (post re-ranking), build a reaction
   SMILES and call `predict_reaction_yield` for an expected yield ± std.
   Informational only.
8. **Risks.** Use `query_kg` to look up known reagent hazards or
   substrate-class incompatibilities; flag matches against the recommended
   condition set.
9. **Optional literature cross-reference.** If the AD verdict is
   `out_of_domain` OR the in-house analog at step 3 has cosine distance
   > 0.70, call `search_knowledge` for the reaction class + reagent context,
   then `fetch_original_document` on the top-1 hit for a citable procedure.

## Output conventions

Present the top-k as a table:
- Columns: catalyst(s), reagent(s), solvent(s), T (°C), recommender_score,
  final_rank_score, worst_solvent_class, predicted_yield ± std, AD verdict,
  nearest in-house analog, risks.
- Order by `final_rank_score` descending (post soft-penalty).
- Cite in-house analogs as `[rxn:<uuid>]`. Cite literature procedures as
  `[doc:<uuid>:<chunk_index>]`.
- Include the AD verdict + per-signal scores under the table:
  > **AD verdict:** borderline. Tanimoto distance 0.42 (in_band ≤ 0.50);
  > Mahalanobis 1842 / 2150 (in_band); Conformal half-width 35 / 30
  > (out-of-band). The recommender is operating on chemotypes near but not
  > inside the in-house Buchwald corpus; treat the top-3 as starting points
  > for an HTE plate, not a single-experiment commitment.
- If `used_global_fallback: true`, add: "AD calibration drew from cross-
  project data because this project has < 30 prior yield-labeled reactions."
- State the recommender's known limits in the conclusion: USPTO 1976-2016,
  top-10 includes ground truth ~70% of the time, T MAE ~20 °C.

## Soft-penalty transparency

When a chemist says "we have to use DCM for this" or "weight greenness
less", recompute the table with `hazard_penalty_per_solvent[*] = 0.0` for
that turn and surface both rankings side-by-side. Never silently swap.

## Latency expectations

- recommend_conditions: ~5-15 s.
- find_similar_reactions: <1 s.
- assess_applicability_domain: ~2-5 s (one DRFP encode + 2 DB queries +
  chemprop batch on calibration + 2 MCP calls; calibration cache makes
  intra-turn re-calls cheap).
- score_green_chemistry: <1 s.
- predict_reaction_yield: ~2 s per call.
- query_kg + search_knowledge: ~1 s each.
- Total skill turn: ~30-90 s.

## What this skill does NOT do (still deferred)

- HTE plate design — different skill (`hte-plate-design`, Phase Z4).
- Closed-loop optimization — different skill (`closed-loop-optimization`,
  Phase Z5). This skill is single-experiment / one-shot.
- Multi-objective Pareto over yield × selectivity × PMI × greenness × safety
  — Phase Z6.
```

- [ ] **Step 2: Verify the skill loads**

```bash
cd services/agent-claw && npx vitest run tests/unit/api-skills.test.ts 2>&1 | tail -10
```
Expected: pass (the api-skills test enforces YAML frontmatter validity).

- [ ] **Step 3: Commit**

```bash
cd /Users/robertmoeckel/Documents/VSCode/chemclaw/chemclaw-applicability-domain-z1
git add skills/condition-design/SKILL.md
git commit -m "feat(z1): condition-design skill v1->v2 (AD + soft-greenness)"
```

---

## Task 13: Final lint / typecheck / test pass

**Files:** none (verification only)

- [ ] **Step 1: Lint changed Python files**

```bash
cd /Users/robertmoeckel/Documents/VSCode/chemclaw/chemclaw-applicability-domain-z1
.venv/bin/ruff check services/mcp_tools/mcp_applicability_domain/ services/mcp_tools/mcp_green_chemistry/
```
Expected: All checks passed!

- [ ] **Step 2: Lint changed TypeScript**

```bash
cd services/agent-claw && npx eslint src/tools/builtins/assess_applicability_domain.ts src/tools/builtins/score_green_chemistry.ts src/bootstrap/dependencies.ts src/config.ts tests/unit/builtins/assess_applicability_domain.test.ts tests/unit/builtins/score_green_chemistry.test.ts
```
Expected: clean.

- [ ] **Step 3: Typecheck**

```bash
cd services/agent-claw && npx tsc --noEmit
```
Expected: clean.

- [ ] **Step 4: Full pytest**

```bash
cd /Users/robertmoeckel/Documents/VSCode/chemclaw/chemclaw-applicability-domain-z1
.venv/bin/pytest services/mcp_tools/mcp_applicability_domain/tests/ services/mcp_tools/mcp_green_chemistry/tests/ services/mcp_tools/mcp_askcos/tests/ -v
```
Expected: all green; ~30 new tests + 16 askcos tests still passing.

- [ ] **Step 5: Full vitest**

```bash
cd services/agent-claw && npm test 2>&1 | tail -10
```
Expected: ≥ 790 + 7 = 797 passed (Z0 baseline plus 7 new builtin tests). Skipped count unchanged.

- [ ] **Step 6: SQL idempotency check**

If a Postgres is up locally: `make db.init` should be a clean no-op (the new INSERT ... ON CONFLICT DO NOTHING rows in `19_reaction_optimization.sql` re-apply harmlessly). If Postgres is not up, skip.

- [ ] **Step 7: Final commit (if any uncommitted touch-ups remain)**

```bash
git status --short
# If clean: nothing to do.
# If not: commit with a "chore(z1): final verification touch-ups" message.
```

---

## Self-Review

**Spec coverage:** every section of the spec maps to at least one task —
- Architecture / two MCPs → Tasks 1-8.
- Two builtins + skill v2 → Tasks 9, 10, 12.
- model_cards rows → Task 11.
- Schema additions / no new tables → Task 11 (only the existing `model_cards` table is appended).
- Data flow + bootstrap fallback → Task 10 (bootstrap path explicitly tested).
- AD signal definitions + verdict aggregation → Task 7 (truth-table tests).
- Greenness scoring + soft-penalty math → Tasks 2-3, 12 (skill applies the penalty).
- Error handling table → Tasks 7 (calibration_id_unknown 404), 10 (cache-miss retry), 11 (typecheck), 12 (graceful skill banners codified in playbook).
- Testing strategy → Tasks 1, 2, 3, 5, 6, 7, 9, 10, 13.
- Out-of-scope items not implemented (web UI, calibration refresh projector, multi-fidelity AD, learned density estimator, hard-blocking) — confirmed absent from tasks.

**Placeholder scan:** no TBD/TODO; every step has runnable code or commands.

**Type consistency:** `RecommendConditionsOut` from Z0 is unchanged; `AssessApplicabilityDomainOut` is consistent across builtin (Task 10), MCP (Task 7), skill (Task 12). `ScoreGreenChemistryOut` shape matches the MCP `/score_solvents` Pydantic response. The `worst_penalty` math in the skill (Task 12) reads from `chem21_class` which the MCP populates (Task 2). `match_confidence: 'unmatched'` triggers the `null` chem21_class branch in the skill's penalty mapping — consistent.

---

## Execution Handoff

Plan complete and saved to `docs/superpowers/plans/2026-04-30-z1-applicability-domain.md`.

Per the user's standing instruction ("when done with writing implementation plan, directly start implementation"), proceed inline via `superpowers:executing-plans`.
