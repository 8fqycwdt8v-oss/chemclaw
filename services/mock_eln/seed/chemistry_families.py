"""Chemistry-family helpers for the mock ELN seed generator.

Holds the RDKit-bound reaction expansion (``smarts_react``,
``canonical_smiles``, ``build_reaction_smiles``) plus the
per-project chemistry phase that materialises notebooks, compounds
and canonical reactions for every project in the seed world.

This is the only module in the seed path that imports ``rdkit`` —
keeping it isolated lets unit tests for the orchestrator stub the
chemistry phase out without paying the RDKit import cost.

Split from generator.py during PR-7 (Python God-file split).
"""

from __future__ import annotations

import random
from typing import Any

from rdkit import Chem
from rdkit.Chem import AllChem


# --------------------------------------------------------------------------
# RDKit reaction expansion
# --------------------------------------------------------------------------
def smarts_react(smarts: str, reactants: list[str]) -> str | None:
    """Run an RDKit SMARTS reaction and return a canonical SMILES of the
    first product. Returns None on failure (silently — caller falls back)."""
    try:
        rxn = AllChem.ReactionFromSmarts(smarts)
        mols = [Chem.MolFromSmiles(s) for s in reactants]
        if any(m is None for m in mols):
            return None
        ps = rxn.RunReactants(tuple(mols))
        if not ps:
            return None
        for product_set in ps:
            for product in product_set:
                try:
                    Chem.SanitizeMol(product)
                except Exception:
                    continue
                smi = Chem.MolToSmiles(product, canonical=True)
                if smi:
                    return smi
        return None
    except Exception:
        return None


def canonical_smiles(s: str) -> str | None:
    m = Chem.MolFromSmiles(s)
    if m is None:
        return None
    return Chem.MolToSmiles(m, canonical=True)


def build_reaction_smiles(
    family: dict[str, Any], rng: random.Random
) -> tuple[str, str | None, list[str]]:
    """Pick fragments and produce a canonical reaction SMILES of the form
    'reactant1.reactant2>>product'. Returns (rxn_smi, product_smi, reactants)."""
    pools = family["fragment_pools"]
    pool_names = list(pools.keys())
    picked = [rng.choice(pools[name]) for name in pool_names]
    canonical_reactants = [canonical_smiles(r) or r for r in picked]
    product = smarts_react(family["smarts"], picked)
    if product is None:
        product = canonical_reactants[0]  # fallback so we still emit a row
    rxn = ".".join(canonical_reactants) + ">>" + product
    return rxn, product, canonical_reactants


def compound_descriptors(smiles: str) -> tuple[str | None, float | None]:
    """Compute (inchikey, molecular_weight) from a SMILES string. Returns
    (None, None) if RDKit can't parse the SMILES."""
    try:
        m = Chem.MolFromSmiles(smiles)
        inchikey = Chem.MolToInchiKey(m) if m else None
        mw = Chem.Descriptors.MolWt(m) if m else None
    except Exception:
        return None, None
    return inchikey, mw


# --------------------------------------------------------------------------
# Per-project chemistry phase
# --------------------------------------------------------------------------
def emit_per_project_chemistry(
    state,
    project_records: list[dict[str, Any]],
    families: dict[str, dict[str, Any]],
    stable_uuid,
    iso,
    parse_iso,
    jstr,
    rng: random.Random,
) -> tuple[
    dict[str, list[dict[str, Any]]],
    dict[str, list[dict[str, Any]]],
    dict[str, list[dict[str, Any]]],
]:
    """Emit notebooks, compounds, and canonical reactions for every project.

    Returns ``(project_notebooks, project_compounds, project_reactions)``,
    each keyed by ``project_code``.

    The helpers ``stable_uuid`` / ``iso`` / ``parse_iso`` / ``jstr`` are passed
    in (rather than imported) so this module stays decoupled from the
    orchestrator's helper layout.
    """
    project_reactions: dict[str, list[dict[str, Any]]] = {}
    project_compounds: dict[str, list[dict[str, Any]]] = {}
    project_notebooks: dict[str, list[dict[str, Any]]] = {}

    for p in project_records:
        pcode = p["code"]
        pid = p["_id"]
        # Notebooks: cap to 8 per project (so total ~30 across 4 projects).
        nb_kinds = p["notebook_kinds"]
        n_notebooks = min(8, max(3, len(nb_kinds) * 3))
        nbs = []
        for i in range(n_notebooks):
            kind = nb_kinds[i % len(nb_kinds)]
            nbid = stable_uuid("notebook", pcode, i)
            row = {
                "id": nbid,
                "project_id": pid,
                "name": f"{pcode} NB-{i + 1:02d} ({kind})",
                "kind": kind,
                "metadata": jstr({"chemists": p["chemists"]}),
                "created_at": iso(parse_iso(p["started_at"])),
                "updated_at": iso(parse_iso(p["started_at"])),
            }
            state.add("notebooks", row)
            nbs.append(row)
        project_notebooks[pcode] = nbs

        # Compounds: ~150 per project. Generate via SMARTS expansion across
        # families round-robin so we build a believable compound library.
        n_compounds = max(120, p["reactions_canonical"] * 4)
        compounds: list[dict[str, Any]] = []
        family_names = list(families.keys())
        for i in range(n_compounds):
            fam = families[family_names[i % len(family_names)]]
            _, product, _ = build_reaction_smiles(fam, rng)
            smi = product or "C"
            inchikey, mw = compound_descriptors(smi)
            cid = stable_uuid("compound", pcode, i)
            row = {
                "id": cid,
                "smiles_canonical": smi,
                "inchikey": inchikey,
                "mw": round(float(mw), 3) if mw else None,
                "external_id": f"{pcode}-CMPD-{i + 1:04d}",
                "project_id": pid,
                "metadata": jstr({"family": fam["name"]}),
                "created_at": iso(parse_iso(p["started_at"])),
            }
            state.add("compounds", row)
            compounds.append(row)
        project_compounds[pcode] = compounds

        # Canonical reactions per project — tagged with family round-robin.
        n_rxn = p["reactions_canonical"]
        rxns: list[dict[str, Any]] = []
        for i in range(n_rxn):
            fam = families[family_names[i % len(family_names)]]
            rxn_smi, _, _ = build_reaction_smiles(fam, rng)
            rid = stable_uuid("reaction", pcode, i)
            row = {
                "id": rid,
                "canonical_smiles_rxn": rxn_smi,
                "family": fam["name"],
                "step_number": (i % 5) + 1,
                "project_id": pid,
                "metadata": jstr({"source": "smarts_expansion"}),
                "created_at": iso(parse_iso(p["started_at"])),
            }
            state.add("reactions", row)
            rxns.append(row)
        project_reactions[pcode] = rxns

    return project_notebooks, project_compounds, project_reactions
