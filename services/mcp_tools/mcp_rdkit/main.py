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
from typing import Annotated, Literal

from fastapi import Body
from pydantic import BaseModel, Field
from rdkit import Chem, RDLogger
from rdkit.Chem import AllChem, Crippen, Descriptors, Lipinski, rdMolDescriptors
from rdkit.Chem.inchi import MolToInchiKey

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
class DescriptorsIn(BaseModel):
    smiles: str = Field(min_length=1, max_length=MAX_SMILES_LEN)
    which: (
        list[Literal[
            "mw", "logp", "tpsa", "hbd", "hba", "rotatable_bonds",
            "heavy_atom_count", "aromatic_ring_count", "ring_count",
            "fsp3", "qed", "formal_charge",
        ]]
        | None
    ) = None  # None → all


class DescriptorsOut(BaseModel):
    values: dict[str, float]


_DESCRIPTORS: dict[str, callable] = {
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


if __name__ == "__main__":
    import uvicorn

    uvicorn.run(
        "services.mcp_tools.mcp_rdkit.main:app",
        host=settings.host,
        port=settings.port,
        log_level=settings.log_level.lower(),
    )
