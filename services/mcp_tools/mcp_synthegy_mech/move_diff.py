"""Best-effort derivation of the paper's `(kind, atom_x, atom_y)` notation.

Synthegy's internal representation is intermediate-state SMILES strings — the
`(i, x, y)` ionization / `(a, x, y)` attack tuple in Figure 4C of the paper
is a *post-hoc display format* derived from the diff between two consecutive
states. This module computes that derivation by RDKit-comparing successive
SMILES.

Caveat: atom indexing in the resulting tuple references the **product** state
(the SMILES after the move), and is best-effort. When the molecule rearranges
in a way that breaks the heuristic (e.g. atom remapping under aromatization),
this returns None and the caller surfaces the move via `from_smiles` /
`to_smiles` only.
"""
from __future__ import annotations

import logging
from dataclasses import dataclass
from typing import Literal, Optional

from rdkit import Chem

log = logging.getLogger("mcp-synthegy-mech.move_diff")


@dataclass
class DerivedMove:
    kind: Literal["i", "a"]
    atom_x: int
    atom_y: int


def derive_move(from_smiles: str, to_smiles: str) -> Optional[DerivedMove]:
    """Classify the move that takes `from_smiles` to `to_smiles`.

    Algorithm:
      - Build atom-formal-charge histograms before and after.
      - If a pair of atoms gained equal-and-opposite charge between the two
        states (e.g. one became +1 and another became -1), and the bond
        order between them dropped by 1, the move is **ionization** (i, x, y).
      - If a pair of atoms had equal-and-opposite charge in `from_smiles`
        that disappeared in `to_smiles` and the bond order between them
        rose by 1, the move is **attack** (a, x, y).
      - Otherwise return None.

    Returns:
        DerivedMove with atom indices in `to_smiles` numbering, or None if
        the heuristic can't classify the move.
    """
    mol_from = Chem.MolFromSmiles(from_smiles)
    mol_to = Chem.MolFromSmiles(to_smiles)
    if mol_from is None or mol_to is None:
        return None

    # The number of heavy atoms must match — the mechanism game preserves
    # atom count by construction.
    if mol_from.GetNumAtoms() != mol_to.GetNumAtoms():
        return None

    charges_from = [a.GetFormalCharge() for a in mol_from.GetAtoms()]
    charges_to = [a.GetFormalCharge() for a in mol_to.GetAtoms()]

    # Indices where charge changed.
    changed = [
        i for i in range(len(charges_to))
        if charges_from[i] != charges_to[i]
    ]
    if len(changed) != 2:
        return None

    a, b = changed
    delta_a = charges_to[a] - charges_from[a]
    delta_b = charges_to[b] - charges_from[b]

    # Equal-and-opposite charge change is the diagnostic signal.
    if delta_a + delta_b != 0:
        return None
    if delta_a == 0:
        return None

    # Compare bond orders between (a, b) before and after.
    bond_from = mol_from.GetBondBetweenAtoms(a, b)
    bond_to = mol_to.GetBondBetweenAtoms(a, b)

    bo_from = _bond_order(bond_from)
    bo_to = _bond_order(bond_to)

    # Ionization: charges appeared (delta != 0), bond order dropped by 1.
    # We also accept the case where charges were ZERO before and nonzero after.
    if charges_from[a] == 0 and charges_from[b] == 0 and bo_to == bo_from - 1:
        return DerivedMove(kind="i", atom_x=a, atom_y=b)

    # Attack: charges disappeared (delta != 0 to bring them to zero), bond
    # order rose by 1.
    if charges_to[a] == 0 and charges_to[b] == 0 and bo_to == bo_from + 1:
        return DerivedMove(kind="a", atom_x=a, atom_y=b)

    return None


def _bond_order(bond) -> float:
    """0 if no bond; otherwise the numeric bond order (1, 1.5, 2, 3)."""
    if bond is None:
        return 0.0
    bt = bond.GetBondTypeAsDouble()
    return float(bt)
