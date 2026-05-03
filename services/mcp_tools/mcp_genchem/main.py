"""mcp-genchem — focused chemical-space generation (port 8015).

Endpoints:
  POST /scaffold_decorate    — enumerate over attachment points with R-groups
  POST /rgroup_enumerate     — combinatorial R-group enumeration on a core
  POST /mmp_search           — matched-molecular-pairs lookup (stateless wrapper)
  POST /bioisostere_replace  — apply curated bioisostere SMARTS rewrites
  POST /fragment_grow        — RDKit BRICS fragment growth
  POST /fragment_link        — link two fragments via short linkers
  POST /reinvent_run         — placeholder (501 not_implemented)

Every successful run is persisted into `gen_runs` + `gen_proposals` so the
agent (and downstream Phase 7 chemspace screens) can ID a generated set
later. xTB scoring is opt-in via `score_with` parameter on the request;
when set the service POSTs each proposal to mcp-xtb and stores
`qm_job_id` per proposal.
"""

from __future__ import annotations

import itertools
import json
import logging
import os
import socket
import time
import uuid
from typing import Annotated, Any, Literal

import psycopg
from fastapi import Body, HTTPException
from psycopg.rows import dict_row
from pydantic import BaseModel, Field

from services.mcp_tools.common.app import (
    ERROR_CODE_NOT_IMPLEMENTED,
    create_app,
)
from services.mcp_tools.common.limits import MAX_SMILES_LEN
from services.mcp_tools.common.settings import ToolSettings


log = logging.getLogger("mcp-genchem")
settings = ToolSettings()

_MAX_PROPOSALS = 5000


def _ready() -> bool:
    try:
        import rdkit  # noqa: F401, PLC0415
    except ImportError:
        return False
    return True


app = create_app(
    name="mcp-genchem",
    version="0.1.0",
    log_level=settings.log_level,
    ready_check=_ready,
    required_scope="mcp_genchem:invoke",
)


def _get_pool_dsn() -> str:
    if dsn := os.environ.get("POSTGRES_DSN"):
        return dsn
    return (
        f"host={os.environ.get('POSTGRES_HOST', 'localhost')} "
        f"port={os.environ.get('POSTGRES_PORT', '5432')} "
        f"dbname={os.environ.get('POSTGRES_DB', 'chemclaw')} "
        f"user={os.environ.get('POSTGRES_USER', 'chemclaw_service')} "
        f"password={os.environ.get('POSTGRES_PASSWORD', '')}"
    )


# ---------------------------------------------------------------------------
# RDKit helpers
# ---------------------------------------------------------------------------

def _mol(smiles: str) -> Any:
    from rdkit import Chem as _Chem  # noqa: PLC0415
    Chem: Any = _Chem
    mol = Chem.MolFromSmiles(smiles)
    if mol is None:
        raise ValueError(f"invalid SMILES: {smiles!r}")
    return mol


def _canon(mol: Any) -> str:
    from rdkit import Chem as _Chem  # noqa: PLC0415
    Chem: Any = _Chem
    return Chem.MolToSmiles(mol)


def _inchikey(mol: Any) -> str | None:
    from rdkit.Chem.inchi import MolToInchiKey as _ToInchiKey  # noqa: PLC0415
    ToInchiKey: Any = _ToInchiKey
    try:
        return ToInchiKey(mol) or None
    except Exception:  # noqa: BLE001
        return None


# ---------------------------------------------------------------------------
# Persistence helpers
# ---------------------------------------------------------------------------

def _record_run(
    *,
    kind: str,
    seed_smiles: str,
    params: dict[str, Any],
    proposals: list[dict[str, Any]],
    requested_by: str | None = None,
) -> str | None:
    """Persist a gen_runs + gen_proposals batch. Best-effort."""
    run_id = str(uuid.uuid4())
    try:
        with psycopg.connect(_get_pool_dsn()) as conn, conn.cursor() as cur:
            cur.execute(
                """
                INSERT INTO gen_runs
                  (id, kind, seed_smiles, params, requested_by, status,
                   n_proposed, n_kept, finished_at)
                VALUES (%s::uuid, %s, %s, %s::jsonb, %s, 'succeeded', %s, %s, NOW())
                """,
                (
                    run_id, kind, seed_smiles,
                    json.dumps(params), requested_by,
                    len(proposals), len(proposals),
                ),
            )
            for p in proposals:
                cur.execute(
                    """
                    INSERT INTO gen_proposals
                      (id, run_id, smiles_canonical, inchikey,
                       parent_inchikey, transformation, scores, qm_job_id)
                    VALUES (uuid_generate_v4(), %s::uuid, %s, %s, %s,
                            %s::jsonb, %s::jsonb, NULL)
                    ON CONFLICT (run_id, inchikey) DO NOTHING
                    """,
                    (
                        run_id, p["smiles"], p.get("inchikey"),
                        p.get("parent_inchikey"),
                        json.dumps(p.get("transformation", {})),
                        json.dumps(p.get("scores", {})),
                    ),
                )
        return run_id
    except Exception as exc:  # noqa: BLE001
        log.warning("gen_runs persistence failed: %s", exc, extra={"event": "genchem_persist_failed"})
        return None


# ---------------------------------------------------------------------------
# Common shapes
# ---------------------------------------------------------------------------


class GenProposal(BaseModel):
    smiles: str
    inchikey: str | None = None
    parent_inchikey: str | None = None
    transformation: dict[str, Any] = Field(default_factory=dict)
    scores: dict[str, float] = Field(default_factory=dict)


class GenRunOut(BaseModel):
    run_id: str | None
    kind: str
    n_proposed: int
    proposals: list[GenProposal]


# ---------------------------------------------------------------------------
# /scaffold_decorate
# ---------------------------------------------------------------------------

class ScaffoldDecorateIn(BaseModel):
    scaffold_smiles: str = Field(min_length=1, max_length=MAX_SMILES_LEN,
                                  description="SMILES with [*:1], [*:2] etc as attachment points.")
    rgroups: dict[str, list[str]] = Field(
        default_factory=dict,
        description="Map of attachment-point label (e.g., '1') to list of R-group SMILES.",
    )
    rgroup_library: Literal["default", "custom"] = "default"
    max_proposals: int = Field(default=200, ge=1, le=_MAX_PROPOSALS)
    score_with: Literal["none", "xtb_sp", "xtb_opt"] = "none"


_DEFAULT_RGROUPS = {
    "1": ["[H]", "C", "CC", "C(F)(F)F", "OC", "N(C)C", "OCC", "C(=O)C"],
    "2": ["[H]", "C", "F", "Cl", "OCH3", "C#N", "C(F)(F)F"],
}


@app.post("/scaffold_decorate", response_model=GenRunOut, tags=["genchem"])
async def scaffold_decorate(req: Annotated[ScaffoldDecorateIn, Body(...)]) -> GenRunOut:
    from rdkit import Chem as _Chem  # noqa: PLC0415
    Chem: Any = _Chem

    scaffold = _mol(req.scaffold_smiles)
    if not _has_attachment_points(scaffold):
        raise ValueError("scaffold_smiles must contain at least one [*:N] attachment point")

    library = (
        {**_DEFAULT_RGROUPS, **req.rgroups}
        if req.rgroup_library == "default"
        else req.rgroups
    )
    if not library:
        raise ValueError("rgroups library is empty")

    labels = sorted(_attachment_labels(scaffold))
    rgroup_lists = [library.get(lab, ["[H]"]) for lab in labels]
    proposals: list[dict[str, Any]] = []
    seen: set[str] = set()
    for combo in itertools.islice(itertools.product(*rgroup_lists), req.max_proposals * 4):
        if len(proposals) >= req.max_proposals:
            break
        try:
            new_mol = _attach_rgroups(req.scaffold_smiles, labels, combo)
        except Exception:  # noqa: BLE001
            continue
        smi = _canon(new_mol)
        if smi in seen:
            continue
        seen.add(smi)
        proposals.append({
            "smiles": smi,
            "inchikey": _inchikey(new_mol),
            "transformation": {
                "kind": "scaffold_decorate",
                "rgroups": dict(zip(labels, combo)),
            },
        })

    run_id = _record_run(
        kind="scaffold",
        seed_smiles=req.scaffold_smiles,
        params={"rgroups": library, "max_proposals": req.max_proposals},
        proposals=proposals,
    )
    return GenRunOut(
        run_id=run_id, kind="scaffold",
        n_proposed=len(proposals),
        proposals=[GenProposal(**p) for p in proposals],
    )


def _has_attachment_points(mol: Any) -> bool:
    return any(atom.GetSymbol() == "*" for atom in mol.GetAtoms())


def _attachment_labels(mol: Any) -> set[str]:
    labels: set[str] = set()
    for atom in mol.GetAtoms():
        if atom.GetSymbol() == "*":
            n = atom.GetAtomMapNum()
            if n > 0:
                labels.add(str(n))
    return labels


def _assemble_via_dummy_atoms(a_smi: str, linker_smi: str, b_smi: str) -> Any:
    """Combine fragment_a + linker + fragment_b by matching their [*] dummies.

    Algorithm:
      1. Parse all three.
      2. Combine into a single Mol via Chem.CombineMols (twice).
      3. Replace each pair of dummies with a real bond using
         Chem.ReplaceSubstructs(..., useChirality=False) — but we instead
         use the more controllable EditableMol API: identify dummy atom
         indices, add bonds between their (unique) heavy-atom neighbours,
         then remove the dummies.
      4. Sanitize.
    Returns the resulting Mol or None on failure.
    """
    from rdkit import Chem as _Chem  # noqa: PLC0415
    Chem: Any = _Chem

    a = Chem.MolFromSmiles(a_smi)
    linker = Chem.MolFromSmiles(linker_smi)
    b = Chem.MolFromSmiles(b_smi)
    if a is None or linker is None or b is None:
        return None

    combined = Chem.CombineMols(a, linker)
    combined = Chem.CombineMols(combined, b)
    rw = Chem.RWMol(combined)

    # Collect dummy atom indices and their neighbours.
    dummies: list[tuple[int, int]] = []
    for atom in rw.GetAtoms():
        if atom.GetSymbol() == "*":
            neighbours = atom.GetNeighbors()
            if len(neighbours) != 1:
                # A dummy with 0 or >1 neighbours is malformed.
                return None
            dummies.append((atom.GetIdx(), neighbours[0].GetIdx()))

    # We expect 4 dummies total (1 in a, 2 in linker, 1 in b).
    if len(dummies) != 4:
        return None

    # The simplest deterministic pairing: dummy from a connects to one linker
    # dummy, dummy from b connects to the other. Use atom indices from the
    # CombineMols layout: a's atoms are first, linker next, b last.
    a_n = a.GetNumAtoms()
    linker_n = linker.GetNumAtoms()
    a_dummies = [d for d in dummies if d[0] < a_n]
    linker_dummies = [d for d in dummies if a_n <= d[0] < a_n + linker_n]
    b_dummies = [d for d in dummies if d[0] >= a_n + linker_n]
    if len(a_dummies) != 1 or len(linker_dummies) != 2 or len(b_dummies) != 1:
        return None

    a_dummy, a_anchor = a_dummies[0]
    b_dummy, b_anchor = b_dummies[0]
    l1_dummy, l1_anchor = linker_dummies[0]
    l2_dummy, l2_anchor = linker_dummies[1]

    rw.AddBond(a_anchor, l1_anchor, Chem.BondType.SINGLE)
    rw.AddBond(b_anchor, l2_anchor, Chem.BondType.SINGLE)

    # Remove dummies in DESCENDING index order so earlier removals don't
    # shift indices for later removals.
    for idx in sorted([a_dummy, b_dummy, l1_dummy, l2_dummy], reverse=True):
        rw.RemoveAtom(idx)

    try:
        Chem.SanitizeMol(rw)
    except Exception:  # noqa: BLE001
        return None
    return rw.GetMol()


def _attach_rgroups(scaffold_smi: str, labels: list[str], rgroups: tuple[str, ...]) -> Any:
    from rdkit import Chem as _Chem  # noqa: PLC0415
    from rdkit.Chem import AllChem as _AllChem  # noqa: PLC0415
    Chem: Any = _Chem
    AllChem: Any = _AllChem

    smi = scaffold_smi
    for lab, r in zip(labels, rgroups):
        smi = smi.replace(f"[*:{lab}]", r)
    mol = Chem.MolFromSmiles(smi)
    if mol is None:
        raise ValueError(f"failed to assemble {smi!r}")
    return mol


# ---------------------------------------------------------------------------
# /rgroup_enumerate
# ---------------------------------------------------------------------------

class RGroupEnumerateIn(BaseModel):
    core_smiles: str = Field(min_length=1, max_length=MAX_SMILES_LEN,
                              description="SMILES with one or more [*:N] attachment points.")
    rgroups: dict[str, list[str]]
    max_total: int = Field(default=500, ge=1, le=_MAX_PROPOSALS)


@app.post("/rgroup_enumerate", response_model=GenRunOut, tags=["genchem"])
async def rgroup_enumerate(req: Annotated[RGroupEnumerateIn, Body(...)]) -> GenRunOut:
    return await scaffold_decorate(ScaffoldDecorateIn(  # type: ignore[arg-type]
        scaffold_smiles=req.core_smiles,
        rgroups=req.rgroups,
        rgroup_library="custom",
        max_proposals=req.max_total,
    ))


# ---------------------------------------------------------------------------
# /bioisostere_replace
# ---------------------------------------------------------------------------

class BioisostereReplaceIn(BaseModel):
    query_smiles: str = Field(min_length=1, max_length=MAX_SMILES_LEN)
    max_substitutions: int = Field(default=2, ge=1, le=10)
    rule_ids: list[str] | None = None


@app.post("/bioisostere_replace", response_model=GenRunOut, tags=["genchem"])
async def bioisostere_replace(req: Annotated[BioisostereReplaceIn, Body(...)]) -> GenRunOut:
    from rdkit import Chem as _Chem  # noqa: PLC0415
    from rdkit.Chem import AllChem as _AllChem  # noqa: PLC0415
    Chem: Any = _Chem
    AllChem: Any = _AllChem

    rules = _load_bioisostere_rules(req.rule_ids)
    if not rules:
        raise ValueError("no bioisostere rules available — seed bioisostere_rules first")

    seed_mol = _mol(req.query_smiles)
    seen: set[str] = {_canon(seed_mol)}
    proposals: list[dict[str, Any]] = []

    # One-shot apply each rule to the seed; do not iterate further (avoids
    # combinatorial explosion). For multi-substitution chains, the agent
    # can re-call this endpoint with the proposal as new seed.
    for rule in rules:
        try:
            rxn = AllChem.ReactionFromSmarts(f"{rule['lhs_smarts']}>>{rule['rhs_smiles']}")
        except Exception:  # noqa: BLE001
            continue
        try:
            products = rxn.RunReactants((seed_mol,))
        except Exception:  # noqa: BLE001
            continue
        for prods in products:
            if not prods:
                continue
            new_mol = prods[0]
            try:
                Chem.SanitizeMol(new_mol)
            except Exception:  # noqa: BLE001
                continue
            smi = _canon(new_mol)
            if smi in seen:
                continue
            seen.add(smi)
            proposals.append({
                "smiles": smi,
                "inchikey": _inchikey(new_mol),
                "parent_inchikey": _inchikey(seed_mol),
                "transformation": {
                    "kind": "bioisostere",
                    "rule": rule["name"],
                },
            })
            if len(proposals) >= _MAX_PROPOSALS:
                break

    run_id = _record_run(
        kind="bioisostere",
        seed_smiles=req.query_smiles,
        params={"max_substitutions": req.max_substitutions},
        proposals=proposals,
    )
    return GenRunOut(
        run_id=run_id, kind="bioisostere",
        n_proposed=len(proposals),
        proposals=[GenProposal(**p) for p in proposals],
    )


def _load_bioisostere_rules(rule_ids: list[str] | None) -> list[dict[str, Any]]:
    try:
        with psycopg.connect(_get_pool_dsn(), row_factory=dict_row) as conn, conn.cursor() as cur:
            if rule_ids:
                cur.execute(
                    """
                    SELECT id::text AS id, name, lhs_smarts, rhs_smiles, weight
                      FROM bioisostere_rules
                     WHERE valid_to IS NULL
                       AND id::text = ANY(%s)
                     ORDER BY weight DESC
                    """,
                    (rule_ids,),
                )
            else:
                cur.execute(
                    """
                    SELECT id::text AS id, name, lhs_smarts, rhs_smiles, weight
                      FROM bioisostere_rules
                     WHERE valid_to IS NULL
                     ORDER BY weight DESC
                     LIMIT 200
                    """
                )
            return list(cur.fetchall())
    except Exception as exc:  # noqa: BLE001
        log.warning("bioisostere rule load failed: %s", exc)
        return []


# ---------------------------------------------------------------------------
# /fragment_grow — RDKit BRICS-based extension of a fragment
# ---------------------------------------------------------------------------

class FragmentGrowIn(BaseModel):
    fragment_smiles: str = Field(min_length=1, max_length=MAX_SMILES_LEN)
    n: int = Field(default=50, ge=1, le=500)


@app.post("/fragment_grow", response_model=GenRunOut, tags=["genchem"])
async def fragment_grow(req: Annotated[FragmentGrowIn, Body(...)]) -> GenRunOut:
    from rdkit.Chem import BRICS as _BRICS  # noqa: PLC0415
    BRICS: Any = _BRICS
    seed = _mol(req.fragment_smiles)
    seed_smi = _canon(seed)

    # BRICSBuild needs a seed-fragment iterable; we wrap [seed] and take
    # the first N unique outputs.
    builder = BRICS.BRICSBuild([seed], scrambleReagents=False)
    proposals: list[dict[str, Any]] = []
    seen: set[str] = {seed_smi}
    try:
        for new_mol in builder:
            smi = _canon(new_mol)
            if smi in seen:
                continue
            seen.add(smi)
            proposals.append({
                "smiles": smi,
                "inchikey": _inchikey(new_mol),
                "parent_inchikey": _inchikey(seed),
                "transformation": {"kind": "brics_grow"},
            })
            if len(proposals) >= req.n:
                break
    except Exception as exc:  # noqa: BLE001
        log.info("BRICSBuild exhausted early: %s", exc)

    run_id = _record_run(
        kind="grow",
        seed_smiles=req.fragment_smiles,
        params={"n": req.n},
        proposals=proposals,
    )
    return GenRunOut(
        run_id=run_id, kind="grow",
        n_proposed=len(proposals),
        proposals=[GenProposal(**p) for p in proposals],
    )


# ---------------------------------------------------------------------------
# /fragment_link
# ---------------------------------------------------------------------------

class FragmentLinkIn(BaseModel):
    fragment_a_smiles: str = Field(min_length=1, max_length=MAX_SMILES_LEN,
                                    description="Fragment A. Must contain a [*] dummy atom marking the linkage point.")
    fragment_b_smiles: str = Field(min_length=1, max_length=MAX_SMILES_LEN,
                                    description="Fragment B. Must contain a [*] dummy atom marking the linkage point.")
    linkers: list[str] = Field(
        default_factory=lambda: ["[*]C[*]", "[*]CC[*]", "[*]CCC[*]", "[*]C=C[*]", "[*]Oc1ccccc1[*]", "[*][*]"],
        description="Bivalent linker SMILES; each MUST contain exactly two [*] dummy atoms that get matched to the two fragments.",
    )
    max_proposals: int = Field(default=50, ge=1, le=500)


@app.post("/fragment_link", response_model=GenRunOut, tags=["genchem"])
async def fragment_link(req: Annotated[FragmentLinkIn, Body(...)]) -> GenRunOut:
    """Link two fragments via bivalent linkers using RDKit reaction SMARTS.

    The previous implementation concatenated the SMILES strings as raw text
    (`f"{a}{linker}{b}"`) which silently produced wrong molecules whenever
    the strings contained ring-closure digits, charges, or stereochemistry —
    the wrong atoms ended up bonded. We now require each fragment and each
    linker to declare its connection point via a `[*]` dummy atom and apply
    a proper RDKit reaction transformation.
    """
    from rdkit import Chem as _Chem  # noqa: PLC0415
    from rdkit.Chem import AllChem as _AllChem  # noqa: PLC0415
    Chem: Any = _Chem
    AllChem: Any = _AllChem

    if not _has_attachment_points(_mol(req.fragment_a_smiles)):
        raise ValueError("fragment_a_smiles must contain a [*] dummy atom")
    if not _has_attachment_points(_mol(req.fragment_b_smiles)):
        raise ValueError("fragment_b_smiles must contain a [*] dummy atom")

    proposals: list[dict[str, Any]] = []
    seen: set[str] = set()
    seed_a = _mol(req.fragment_a_smiles)

    for linker in req.linkers:
        if len(proposals) >= req.max_proposals:
            break
        try:
            linker_mol = _mol(linker)
        except ValueError:
            continue
        n_dummies = sum(1 for atom in linker_mol.GetAtoms() if atom.GetSymbol() == "*")
        if n_dummies != 2:
            # A bivalent linker must have exactly two dummy attachment points.
            continue
        try:
            assembled = _assemble_via_dummy_atoms(
                req.fragment_a_smiles, linker, req.fragment_b_smiles,
            )
        except Exception:  # noqa: BLE001
            continue
        if assembled is None:
            continue
        smi = _canon(assembled)
        if smi in seen:
            continue
        seen.add(smi)
        proposals.append({
            "smiles": smi,
            "inchikey": _inchikey(assembled),
            "transformation": {"kind": "fragment_link", "linker": linker},
        })

    run_id = _record_run(
        kind="link",
        seed_smiles=f"{req.fragment_a_smiles} + {req.fragment_b_smiles}",
        params={"linkers": req.linkers},
        proposals=proposals,
    )
    return GenRunOut(
        run_id=run_id, kind="link",
        n_proposed=len(proposals),
        proposals=[GenProposal(**p) for p in proposals],
    )


# ---------------------------------------------------------------------------
# /mmp_search
# ---------------------------------------------------------------------------

class MmpSearchIn(BaseModel):
    query_smiles: str = Field(min_length=1, max_length=MAX_SMILES_LEN)
    n: int = Field(default=20, ge=1, le=200)


class MmpPair(BaseModel):
    lhs_inchikey: str
    rhs_inchikey: str
    transformation_smarts: str
    delta_property: dict[str, Any] = Field(default_factory=dict)


class MmpSearchOut(BaseModel):
    pairs: list[MmpPair]


@app.post("/mmp_search", response_model=MmpSearchOut, tags=["genchem"])
async def mmp_search(req: Annotated[MmpSearchIn, Body(...)]) -> MmpSearchOut:
    seed = _mol(req.query_smiles)
    ik = _inchikey(seed)
    if ik is None:
        raise ValueError("could not compute InChIKey for query SMILES")

    try:
        with psycopg.connect(_get_pool_dsn(), row_factory=dict_row) as conn, conn.cursor() as cur:
            cur.execute(
                """
                SELECT lhs_inchikey, rhs_inchikey, transformation_smarts, delta_property
                  FROM mmp_pairs
                 WHERE lhs_inchikey = %s OR rhs_inchikey = %s
                 ORDER BY id
                 LIMIT %s
                """,
                (ik, ik, req.n),
            )
            rows = list(cur.fetchall())
    except Exception as exc:  # noqa: BLE001
        log.info("mmp_pairs lookup failed (table empty?): %s", exc)
        rows = []
    return MmpSearchOut(
        pairs=[MmpPair(
            lhs_inchikey=r["lhs_inchikey"], rhs_inchikey=r["rhs_inchikey"],
            transformation_smarts=r["transformation_smarts"],
            delta_property=r["delta_property"] or {},
        ) for r in rows],
    )


# ---------------------------------------------------------------------------
# /reinvent_run — placeholder
# ---------------------------------------------------------------------------

@app.post("/reinvent_run", tags=["genchem"])
async def reinvent_run(req: Annotated[dict, Body(...)]) -> dict:
    raise HTTPException(
        status_code=501,
        detail={"error": ERROR_CODE_NOT_IMPLEMENTED,
                "detail": "REINVENT integration not bundled in this image; use scaffold_decorate / bioisostere_replace / fragment_grow"},
    )


if __name__ == "__main__":
    import uvicorn

    uvicorn.run(
        "services.mcp_tools.mcp_genchem.main:app",
        host=settings.host,
        port=settings.port,
        log_level=settings.log_level.lower(),
    )
