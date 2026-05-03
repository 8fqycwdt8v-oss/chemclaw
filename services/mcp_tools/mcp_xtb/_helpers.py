"""Pure helpers shared between ``main.py`` and the recipe package.

These functions used to live in ``main.py`` and were lazy-imported from
within recipe steps to avoid the cycle ``main → recipes → main``. Moving
them here lets recipes import at module top-level and removes the
"helpers re-imported on every step" pattern that obscured the call
graph. ``main.py`` re-exports nothing — the recipe package and any
external test consumers should target this module directly.

No subprocess work happens here. No FastAPI imports. ``run_subprocess``
remains in ``workflow.py`` because it owns the engine's timeout
contract.
"""

from __future__ import annotations

from typing import Any


def smiles_to_xyz(smiles: str) -> str:
    """Convert a SMILES to 3-D XYZ block via RDKit ETKDG.

    rdkit ships no stubs, so the imports and module objects are typed as
    ``Any``. Each call through Chem / AllChem is duck-typed rather than
    flagged by mypy strict mode.
    """
    try:
        from rdkit import Chem as _Chem  # noqa: PLC0415
        from rdkit.Chem import AllChem as _AllChem  # noqa: PLC0415
    except ImportError as exc:
        raise ImportError("rdkit required inside the Docker image") from exc

    Chem: Any = _Chem
    AllChem: Any = _AllChem

    if not smiles or not smiles.strip():
        raise ValueError("smiles must be a non-empty string")
    mol = Chem.MolFromSmiles(smiles)
    if mol is None:
        raise ValueError(f"invalid SMILES: {smiles!r}")
    mol = Chem.AddHs(mol)
    if AllChem.EmbedMolecule(mol, AllChem.ETKDGv3()) == -1:
        raise ValueError(
            f"RDKit could not generate 3-D embedding for SMILES: {smiles!r}",
        )
    AllChem.MMFFOptimizeMolecule(mol)

    conf = mol.GetConformer()
    lines = [str(mol.GetNumAtoms()), smiles]
    for atom in mol.GetAtoms():
        pos = conf.GetAtomPosition(atom.GetIdx())
        lines.append(
            f"{atom.GetSymbol():2s}  {pos.x:12.6f}  {pos.y:12.6f}  {pos.z:12.6f}",
        )
    return "\n".join(lines)


def parse_energy(stdout: str) -> float | None:
    """Extract total energy (Hartree) from xtb stdout.

    xtb prints lines like ``TOTAL ENERGY          -5.123456789000 Eh``;
    the numeric value is at index 2 (0-based). Index ``-2`` is a
    fallback when xtb's column padding shifts under newer versions.
    """
    for line in stdout.splitlines():
        if "TOTAL ENERGY" in line:
            parts = line.split()
            for idx in (2, -2):
                try:
                    return float(parts[idx])
                except (IndexError, ValueError):
                    pass
    return None


def parse_gnorm(stdout: str) -> float | None:
    """Extract gradient norm from xtb stdout."""
    for line in stdout.splitlines():
        if "GRADIENT NORM" in line:
            parts = line.split()
            for idx in (2, -2):
                try:
                    return float(parts[idx])
                except (IndexError, ValueError):
                    pass
    return None


def parse_crest_ensemble(ensemble_text: str) -> list[tuple[str, float]]:
    """Parse a multi-structure XYZ file from CREST into ``(xyz_block, energy)`` pairs."""
    conformers: list[tuple[str, float]] = []
    lines = ensemble_text.splitlines()
    i = 0
    while i < len(lines):
        line = lines[i].strip()
        if not line:
            i += 1
            continue
        try:
            n_atoms = int(line)
        except ValueError:
            i += 1
            continue
        if i + 1 + n_atoms >= len(lines):
            break
        comment = lines[i + 1]
        try:
            energy = float(comment.split()[0])
        except (ValueError, IndexError):
            energy = float("nan")
        xyz_lines = [line] + lines[i + 1: i + 2 + n_atoms]
        conformers.append(("\n".join(xyz_lines), energy))
        i += 2 + n_atoms
    return conformers
