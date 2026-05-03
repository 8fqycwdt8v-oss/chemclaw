"""mcp-rdkit — RDKit cheminformatics as a tool service.

Tools:
- POST /tools/canonicalize_smiles
- POST /tools/inchikey_from_smiles
- POST /tools/morgan_fingerprint
- POST /tools/compute_descriptors

Every input is validated and parsed with RDKit. Invalid SMILES return a 400
with a specific reason; this lets callers distinguish "malformed input" from
"tool internal error".
"""

from __future__ import annotations

import logging
from collections.abc import Callable
from typing import Annotated, Any, Literal

from fastapi import Body
from pydantic import BaseModel, Field

# rdkit ships no type stubs. Import each module as a private name and
# re-bind to a name typed as Any so the rest of the file is duck-typed
# rather than fighting attr-defined / no-untyped-call errors on every
# call into rdkit. (Same idiom as mcp_xtb at function scope.)
from rdkit import Chem as _Chem, RDLogger as _RDLogger
from rdkit.Chem import (
    AllChem as _AllChem,
    Crippen as _Crippen,
    Descriptors as _Descriptors,
    Lipinski as _Lipinski,
    rdMolDescriptors as _rdMolDescriptors,
)
from rdkit.Chem.inchi import MolToInchiKey as _MolToInchiKey

Chem: Any = _Chem
RDLogger: Any = _RDLogger
AllChem: Any = _AllChem
Crippen: Any = _Crippen
Descriptors: Any = _Descriptors
Lipinski: Any = _Lipinski
rdMolDescriptors: Any = _rdMolDescriptors  # noqa: N816 — RDKit's actual module name
MolToInchiKey: Any = _MolToInchiKey

from services.mcp_tools.common.app import create_app
from services.mcp_tools.common.limits import MAX_SMILES_LEN
from services.mcp_tools.common.settings import ToolSettings

# RDKit prints stern warnings to stderr on every bad SMILES parse; route
# them into our logging instead of leaking to container stderr.
RDLogger.DisableLog("rdApp.*")

log = logging.getLogger("mcp-rdkit")
settings = ToolSettings()
app = create_app(
    name="mcp-rdkit",
    version="0.1.0",
    log_level=settings.log_level,
    required_scope="mcp_rdkit:invoke",
)


# --------------------------------------------------------------------------
# Helpers
# --------------------------------------------------------------------------
def _mol_from_smiles(smiles: str) -> Chem.Mol:
    if not smiles or not smiles.strip():
        raise ValueError("smiles must be a non-empty string")
    mol = Chem.MolFromSmiles(smiles)
    if mol is None:
        raise ValueError(f"invalid SMILES: {smiles!r}")
    return mol


# --------------------------------------------------------------------------
# canonicalize_smiles
# --------------------------------------------------------------------------
class CanonicalizeIn(BaseModel):
    smiles: str = Field(min_length=1, max_length=MAX_SMILES_LEN)
    kekulize: bool = False


class CanonicalizeOut(BaseModel):
    canonical_smiles: str
    inchikey: str
    formula: str
    mw: float


@app.post("/tools/canonicalize_smiles", response_model=CanonicalizeOut, tags=["rdkit"])
async def canonicalize_smiles(req: Annotated[CanonicalizeIn, Body(...)]) -> CanonicalizeOut:
    mol = _mol_from_smiles(req.smiles)
    canonical = Chem.MolToSmiles(mol, canonical=True, kekuleSmiles=req.kekulize)
    return CanonicalizeOut(
        canonical_smiles=canonical,
        inchikey=MolToInchiKey(mol),
        formula=rdMolDescriptors.CalcMolFormula(mol),
        mw=float(Descriptors.MolWt(mol)),
    )


# --------------------------------------------------------------------------
# inchikey_from_smiles
# --------------------------------------------------------------------------
class InchikeyIn(BaseModel):
    smiles: str = Field(min_length=1, max_length=MAX_SMILES_LEN)


class InchikeyOut(BaseModel):
    inchikey: str


@app.post("/tools/inchikey_from_smiles", response_model=InchikeyOut, tags=["rdkit"])
async def inchikey_from_smiles(req: Annotated[InchikeyIn, Body(...)]) -> InchikeyOut:
    mol = _mol_from_smiles(req.smiles)
    return InchikeyOut(inchikey=MolToInchiKey(mol))


# --------------------------------------------------------------------------
# morgan_fingerprint
# --------------------------------------------------------------------------
class MorganIn(BaseModel):
    smiles: str = Field(min_length=1, max_length=MAX_SMILES_LEN)
    radius: int = Field(default=2, ge=1, le=4)
    n_bits: int = Field(default=2048, ge=512, le=4096)


class MorganOut(BaseModel):
    n_bits: int
    on_bits: list[int]


@app.post("/tools/morgan_fingerprint", response_model=MorganOut, tags=["rdkit"])
async def morgan_fingerprint(req: Annotated[MorganIn, Body(...)]) -> MorganOut:
    mol = _mol_from_smiles(req.smiles)
    # Use the modern Morgan generator API.
    gen = AllChem.GetMorganGenerator(radius=req.radius, fpSize=req.n_bits)
    fp = gen.GetFingerprint(mol)
    on_bits = list(fp.GetOnBits())
    return MorganOut(n_bits=req.n_bits, on_bits=on_bits)


# --------------------------------------------------------------------------
# compute_descriptors
# --------------------------------------------------------------------------
DescriptorKey = Literal[
    "mw", "logp", "tpsa", "hbd", "hba", "rotatable_bonds",
    "heavy_atom_count", "aromatic_ring_count", "ring_count",
    "fsp3", "qed", "formal_charge",
]


class DescriptorsIn(BaseModel):
    smiles: str = Field(min_length=1, max_length=MAX_SMILES_LEN)
    which: list[DescriptorKey] | None = None  # None → all


class DescriptorsOut(BaseModel):
    values: dict[str, float]


_DESCRIPTORS: dict[DescriptorKey, Callable[[Any], Any]] = {
    "mw":                   lambda m: Descriptors.MolWt(m),
    "logp":                 lambda m: Crippen.MolLogP(m),
    "tpsa":                 lambda m: Descriptors.TPSA(m),
    "hbd":                  lambda m: Lipinski.NumHDonors(m),
    "hba":                  lambda m: Lipinski.NumHAcceptors(m),
    "rotatable_bonds":      lambda m: Lipinski.NumRotatableBonds(m),
    "heavy_atom_count":     lambda m: m.GetNumHeavyAtoms(),
    "aromatic_ring_count":  lambda m: Lipinski.NumAromaticRings(m),
    "ring_count":           lambda m: rdMolDescriptors.CalcNumRings(m),
    "fsp3":                 lambda m: rdMolDescriptors.CalcFractionCSP3(m),
    "qed":                  lambda m: Descriptors.qed(m),
    "formal_charge":        lambda m: Chem.GetFormalCharge(m),
}


@app.post("/tools/compute_descriptors", response_model=DescriptorsOut, tags=["rdkit"])
async def compute_descriptors(req: Annotated[DescriptorsIn, Body(...)]) -> DescriptorsOut:
    mol = _mol_from_smiles(req.smiles)
    keys = req.which or list(_DESCRIPTORS.keys())
    return DescriptorsOut(values={k: float(_DESCRIPTORS[k](mol)) for k in keys})


# --------------------------------------------------------------------------
# Phase 3 — MACCS, atom-pair, SMARTS substructure
# --------------------------------------------------------------------------

class MaccsIn(BaseModel):
    smiles: str = Field(min_length=1, max_length=MAX_SMILES_LEN)


class MaccsOut(BaseModel):
    n_bits: int
    on_bits: list[int]


@app.post("/tools/maccs_fingerprint", response_model=MaccsOut, tags=["rdkit"])
async def maccs_fingerprint(req: Annotated[MaccsIn, Body(...)]) -> MaccsOut:
    from rdkit.Chem import MACCSkeys as _MACCSkeys  # noqa: PLC0415
    MACCSkeys: Any = _MACCSkeys
    mol = _mol_from_smiles(req.smiles)
    fp = MACCSkeys.GenMACCSKeys(mol)
    return MaccsOut(n_bits=167, on_bits=list(fp.GetOnBits()))


class AtomPairIn(BaseModel):
    smiles: str = Field(min_length=1, max_length=MAX_SMILES_LEN)
    n_bits: int = Field(default=2048, ge=512, le=4096)


class AtomPairOut(BaseModel):
    n_bits: int
    on_bits: list[int]


@app.post("/tools/atompair_fingerprint", response_model=AtomPairOut, tags=["rdkit"])
async def atompair_fingerprint(req: Annotated[AtomPairIn, Body(...)]) -> AtomPairOut:
    from rdkit.Chem import rdFingerprintGenerator as _rdFingerprintGenerator  # noqa: PLC0415
    rdFingerprintGenerator: Any = _rdFingerprintGenerator
    mol = _mol_from_smiles(req.smiles)
    gen = rdFingerprintGenerator.GetAtomPairGenerator(fpSize=req.n_bits)
    fp = gen.GetFingerprint(mol)
    return AtomPairOut(n_bits=req.n_bits, on_bits=list(fp.GetOnBits()))


_MAX_SMARTS_LEN = 500


class SubstructureMatchIn(BaseModel):
    query_smarts: str = Field(min_length=1, max_length=_MAX_SMARTS_LEN)
    target_smiles: str = Field(min_length=1, max_length=MAX_SMILES_LEN)
    use_chirality: bool = False


class SubstructureMatchOut(BaseModel):
    matches: list[list[int]]
    count: int


@app.post("/tools/substructure_match", response_model=SubstructureMatchOut, tags=["rdkit"])
async def substructure_match(
    req: Annotated[SubstructureMatchIn, Body(...)],
) -> SubstructureMatchOut:
    target = _mol_from_smiles(req.target_smiles)
    query = Chem.MolFromSmarts(req.query_smarts)
    if query is None:
        raise ValueError(f"invalid SMARTS: {req.query_smarts!r}")
    raw = target.GetSubstructMatches(query, useChirality=req.use_chirality, uniquify=True)
    matches = [[int(i) for i in m] for m in raw]
    return SubstructureMatchOut(matches=matches, count=len(matches))


class BulkSubstructureSearchIn(BaseModel):
    """Bulk SMARTS query against a candidate list of SMILES.

    The agent passes a candidate list (typically from a fingerprint pre-filter
    on the corpus) plus the SMARTS query; we re-verify each candidate
    server-side. The MCP service does NOT touch the canonical compounds table
    directly — the projector + agent do that — so this endpoint is stateless.
    """

    query_smarts: str = Field(min_length=1, max_length=_MAX_SMARTS_LEN)
    candidates: list[dict[str, str]] = Field(
        ...,
        description="List of {inchikey, smiles} dicts to re-verify against the SMARTS.",
    )
    limit: int = Field(default=200, ge=1, le=5000)


class BulkSubstructureHit(BaseModel):
    inchikey: str
    smiles: str
    n_matches: int


class BulkSubstructureSearchOut(BaseModel):
    hits: list[BulkSubstructureHit]
    n_scanned: int


@app.post(
    "/tools/bulk_substructure_search",
    response_model=BulkSubstructureSearchOut,
    tags=["rdkit"],
)
async def bulk_substructure_search(
    req: Annotated[BulkSubstructureSearchIn, Body(...)],
) -> BulkSubstructureSearchOut:
    query = Chem.MolFromSmarts(req.query_smarts)
    if query is None:
        raise ValueError(f"invalid SMARTS: {req.query_smarts!r}")

    hits: list[BulkSubstructureHit] = []
    n_scanned = 0
    for cand in req.candidates[: req.limit]:
        n_scanned += 1
        smi = cand.get("smiles", "")
        ik = cand.get("inchikey", "")
        if not smi:
            continue
        mol = Chem.MolFromSmiles(smi)
        if mol is None:
            continue
        matches = mol.GetSubstructMatches(query, uniquify=True)
        if matches:
            hits.append(BulkSubstructureHit(
                inchikey=ik, smiles=smi, n_matches=len(matches),
            ))
    return BulkSubstructureSearchOut(hits=hits, n_scanned=n_scanned)


class ScaffoldIn(BaseModel):
    smiles: str = Field(min_length=1, max_length=MAX_SMILES_LEN)


class ScaffoldOut(BaseModel):
    scaffold_smiles: str | None
    scaffold_inchikey: str | None


@app.post("/tools/murcko_scaffold", response_model=ScaffoldOut, tags=["rdkit"])
async def murcko_scaffold(req: Annotated[ScaffoldIn, Body(...)]) -> ScaffoldOut:
    from rdkit.Chem.Scaffolds import MurckoScaffold as _MurckoScaffold  # noqa: PLC0415
    MurckoScaffold: Any = _MurckoScaffold
    mol = _mol_from_smiles(req.smiles)
    scaffold = MurckoScaffold.GetScaffoldForMol(mol)
    if scaffold is None or scaffold.GetNumAtoms() == 0:
        return ScaffoldOut(scaffold_smiles=None, scaffold_inchikey=None)
    smi = Chem.MolToSmiles(scaffold)
    try:
        ik = MolToInchiKey(scaffold)
    except Exception:  # noqa: BLE001
        ik = None
    return ScaffoldOut(scaffold_smiles=smi, scaffold_inchikey=ik or None)


if __name__ == "__main__":
    import uvicorn

    uvicorn.run(
        "services.mcp_tools.mcp_rdkit.main:app",
        host=settings.host,
        port=settings.port,
        log_level=settings.log_level.lower(),
    )
