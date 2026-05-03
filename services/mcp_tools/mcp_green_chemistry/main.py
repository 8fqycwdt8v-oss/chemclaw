"""mcp-green-chemistry — solvent guide & reaction-safety lookup (port 8019).

Tools:
- POST /score_solvents          — per-solvent CHEM21 / GSK / Pfizer / AZ / Sanofi / ACS-GCI-PR class
- POST /assess_reaction_safety  — PMI estimate + Bretherick hazardous-group SMARTS lookup

Stateless: all answers come from static JSON tables shipped in the image.
"""

from __future__ import annotations

import json
import logging
import os
from contextlib import asynccontextmanager
from pathlib import Path
from typing import Annotated, Any, AsyncIterator

from fastapi import Body, FastAPI
from pydantic import BaseModel, Field
from rapidfuzz import process as fuzz_process
from rdkit import Chem, RDLogger

from services.mcp_tools.common.app import create_app
from services.mcp_tools.common.limits import MAX_SMILES_LEN
from services.mcp_tools.common.settings import ToolSettings

# Suppress RDKit warning spam — invalid SMILES from user input is expected.
RDLogger.DisableLog("rdApp.warning")

log = logging.getLogger("mcp-green-chemistry")
settings = ToolSettings()

_DATA_DIR = Path(os.environ.get(
    "MCP_GREEN_CHEMISTRY_DATA_DIR",
    str(Path(__file__).parent / "data"),
))


def _is_ready() -> bool:
    return _DATA_DIR.exists() and _DATA_DIR.is_dir()


@asynccontextmanager
async def _lifespan(_app: FastAPI) -> AsyncIterator[None]:
    """Build vendor indexes + load Bretherick groups on startup."""
    global _BRETHERICK_GROUPS
    if _is_ready():
        _build_indexes()
        _BRETHERICK_GROUPS = _load_bretherick()
    yield


app = create_app(
    name="mcp-green-chemistry",
    version="0.1.0",
    log_level=settings.log_level,
    ready_check=_is_ready,
    required_scope="mcp_green_chemistry:invoke",
    lifespan=_lifespan,
)


# ---------------------------------------------------------------------------
# Static data — vendor solvent guides + Bretherick hazardous-group SMARTS
# ---------------------------------------------------------------------------

_VENDOR_FILES = {
    "chem21": "chem21_solvents.json",
    "gsk":    "gsk_solvents.json",
    "pfizer": "pfizer_solvents.json",
    "az":     "az_solvents.json",
    "sanofi": "sanofi_solvents.json",
    "acs":    "acs_gci_pr_unified.json",
}

_VENDOR_INDEXES: dict[str, dict[str, Any]] = {}
_BRETHERICK_GROUPS: list[dict[str, Any]] = []


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


def _build_indexes() -> None:
    """Index each vendor table by canonical SMILES + InChIKey + name."""
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


def _load_bretherick() -> list[dict[str, Any]]:
    path = _DATA_DIR / "bretherick_groups.json"
    if not path.exists():
        return []
    with path.open("r", encoding="utf-8") as f:
        return json.load(f)


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
                _, _score, idx = best
                primary_row = names_table[idx][1]
                confidence = "name_only"

    canon_for_lookup = canon or (primary_row.get("smiles") if primary_row else None)
    if canon_for_lookup:
        canon_for_lookup = _canonical_smiles(canon_for_lookup) or canon_for_lookup

    def _vendor_class(vendor: str) -> str | None:
        if not canon_for_lookup:
            return None
        idx = _VENDOR_INDEXES.get(vendor, {}).get("by_canon", {})
        row = idx.get(canon_for_lookup)
        return row.get("class") if row else None

    chem21_score: float | None = None
    if primary_row is not None:
        raw_score = primary_row.get("score")
        chem21_score = float(raw_score) if raw_score is not None else None

    return SolventScore(
        input=s,
        canonical_smiles=canon_for_lookup,
        chem21_class=primary_row.get("class") if primary_row else None,
        chem21_score=chem21_score,
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


# ---------------------------------------------------------------------------
# /assess_reaction_safety — Bretherick + PMI
# ---------------------------------------------------------------------------

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
    reactant_safety_score: float
    solvent_safety_score: float
    overall_safety_class: str


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
    """Estimate PMI as (reactant mass / product mass) over RDKit MolWt.

    True PMI requires actual stoichiometry/scale; we label this an estimate.
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


_CLASS_RANK = {
    "Recommended": 0,
    "Problematic": 1,
    "Hazardous": 2,
    "HighlyHazardous": 3,
}


def _solvent_signals(solvents: list[SolventInput]) -> tuple[float, str]:
    """Return (worst_chem21_score, worst_chem21_class) over the solvents.

    Unmatched solvents get a numeric floor of 3.0 and class 'Problematic' so
    they don't silently pass as Recommended.
    """
    if not solvents:
        return 0.0, "Recommended"
    chem21_idx = _VENDOR_INDEXES.get("chem21", {}).get("by_canon", {})
    worst_score = 0.0
    worst_class = "Recommended"
    for s in solvents:
        canon = _canonical_smiles(s.smiles) if s.smiles else None
        if canon and canon in chem21_idx:
            entry = chem21_idx[canon]
            raw_score = entry.get("score", 0.0)
            worst_score = max(worst_score, float(raw_score) if raw_score is not None else 0.0)
            cls = entry.get("class", "Recommended")
            if _CLASS_RANK.get(cls, 0) > _CLASS_RANK.get(worst_class, 0):
                worst_class = cls
        else:
            worst_score = max(worst_score, 3.0)
            if _CLASS_RANK["Problematic"] > _CLASS_RANK.get(worst_class, 0):
                worst_class = "Problematic"
    return worst_score, worst_class


def _overall_class(reactant_hits: list[HazardousGroupHit], solvent_class: str) -> str:
    """Combine reactant hazard hits with the worst solvent CHEM21 class."""
    if any(h.hazard_class in ("Explosive", "Pyrophoric") for h in reactant_hits):
        return "HighlyHazardous"
    candidates = [solvent_class]
    if reactant_hits:
        # Any non-explosive/pyrophoric Bretherick hit lifts the floor to Hazardous.
        candidates.append("Hazardous")
    return max(candidates, key=lambda c: _CLASS_RANK.get(c, 0))


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
    reactant_score = float(min(10.0, 2.5 * len(hits)))
    solvent_score, solvent_class = _solvent_signals(req.solvents)
    overall = _overall_class(hits, solvent_class)
    return AssessReactionSafetyOut(
        pmi_estimate=pmi,
        hazardous_groups=hits,
        reactant_safety_score=reactant_score,
        solvent_safety_score=solvent_score,
        overall_safety_class=overall,
    )


if __name__ == "__main__":
    import uvicorn

    uvicorn.run(
        "services.mcp_tools.mcp_green_chemistry.main:app",
        host=settings.host,
        port=settings.port,
        log_level=settings.log_level.lower(),
    )
