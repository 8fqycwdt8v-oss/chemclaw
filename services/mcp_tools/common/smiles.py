"""SMILES → 3D-XYZ helper used by every QM-style MCP service.

Centralizes the RDKit embed pipeline (canonicalize → InChIKey → AddHs →
ETKDGv3 embed → MMFF optimize → XYZ block) so mcp_xtb, mcp_crest, and
future quantum-chemistry tools share one definition. Pure function — no
module-level state or DB / network calls.

The lazy import of rdkit lets services that don't actually use this helper
skip the ~250ms import cost.
"""

from __future__ import annotations

from typing import Any


def smiles_to_canonical_and_xyz(smiles: str) -> tuple[str, str, str | None]:
    """Return (canonical_smiles, xyz_block, inchikey_or_None) from a SMILES string.

    Raises ImportError if RDKit is not installed (catchable so the service
    can degrade rather than crash at import time). Raises ValueError for
    empty or invalid SMILES, or when ETKDG embedding fails.
    """
    try:
        from rdkit import Chem as _Chem  # noqa: PLC0415
        from rdkit.Chem import AllChem as _AllChem  # noqa: PLC0415
        from rdkit.Chem.inchi import MolToInchiKey as _ToInchiKey  # noqa: PLC0415
    except ImportError as exc:
        raise ImportError("rdkit required inside the Docker image") from exc

    Chem: Any = _Chem
    AllChem: Any = _AllChem
    ToInchiKey: Any = _ToInchiKey
    if not smiles or not smiles.strip():
        raise ValueError("smiles must be a non-empty string")

    mol = Chem.MolFromSmiles(smiles)
    if mol is None:
        raise ValueError(f"invalid SMILES: {smiles!r}")
    canonical = Chem.MolToSmiles(mol)
    try:
        inchikey = ToInchiKey(mol) or None  # pragma: no cover — best-effort, no CI test
    except Exception:  # noqa: BLE001 — InChI gen is best-effort
        inchikey = None

    mol = Chem.AddHs(mol)
    if AllChem.EmbedMolecule(mol, AllChem.ETKDGv3()) == -1:
        raise ValueError(f"RDKit could not embed SMILES: {smiles!r}")
    AllChem.MMFFOptimizeMolecule(mol)

    conf = mol.GetConformer()
    lines = [str(mol.GetNumAtoms()), canonical]
    for atom in mol.GetAtoms():
        pos = conf.GetAtomPosition(atom.GetIdx())
        lines.append(
            f"{atom.GetSymbol():2s}  {pos.x:12.6f}  {pos.y:12.6f}  {pos.z:12.6f}"
        )
    return canonical, "\n".join(lines), inchikey
