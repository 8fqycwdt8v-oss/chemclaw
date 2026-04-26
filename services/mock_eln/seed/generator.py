"""Mock ELN seed generator.

Reads `world.yaml` next to this file and emits:
  - Postgres COPY-format gzipped fixture files in
    test-fixtures/mock_eln/world-default/<table>.copy.gz
  - A single idempotent seed loader at db/seed/20_mock_eln_data.sql
    that \\copies the gzipped fixtures into mock_eln.* tables.

Determinism: re-running with the same WORLD_SEED env var (default 42)
produces byte-identical output. UUIDs are derived from a deterministic
seed via uuid.uuid5(NAMESPACE, key) so they are stable across runs.

Usage:
    python -m services.mock_eln.seed.generator
    WORLD_SEED=42 python -m services.mock_eln.seed.generator

The seed loader is gated by `current_setting('app.mock_eln_enabled', true)`.
To apply it:
    psql -v mock_eln_enabled=on -f db/seed/20_mock_eln_data.sql
or:
    SET app.mock_eln_enabled = 'on';
    \\i db/seed/20_mock_eln_data.sql

Counts (typical):
    projects          4
    notebooks        ~30
    compounds       ~600
    reactions       ~150 (canonical)
    methods          ~30
    entries        2000+
    samples        ~3000
    results        ~5000
    attachments    ~3500
    audit_trail   ~12000
"""

from __future__ import annotations

import csv
import gzip
import io
import json
import os
import random
import uuid
from dataclasses import dataclass, field
from datetime import UTC, datetime, timedelta
from pathlib import Path
from typing import Any

import yaml
from rdkit import Chem
from rdkit.Chem import AllChem

from services.mock_eln.seed import freetext_templates as ft

# --------------------------------------------------------------------------
# Constants & paths
# --------------------------------------------------------------------------

REPO_ROOT = Path(__file__).resolve().parents[3]
SEED_DIR = Path(__file__).resolve().parent
WORLD_YAML = SEED_DIR / "world.yaml"
FIXTURES_DIR = REPO_ROOT / "test-fixtures" / "mock_eln" / "world-default"
SEED_SQL_PATH = REPO_ROOT / "db" / "seed" / "20_mock_eln_data.sql"

# Stable UUID namespace so re-runs produce identical primary keys.
UUID_NAMESPACE = uuid.UUID("4e8b1c2d-7a3f-4b5e-9c8a-1d2e3f4a5b6c")

# Fraction of entries-with-freetext that get an adversarial probe in their
# narrative (prompt-injection bait, fabricated fact_id, etc.). Keeps the
# agent's redact-secrets + anti-fabrication safety hooks under continuous
# regression coverage. ~0.5% of ~1860 freetext-bearing entries → ~9
# adversarial entries in the default world.
ADVERSARIAL_RATE = 0.005

# Tables, in load order (FK-respecting).
TABLE_ORDER = [
    "projects",
    "notebooks",
    "methods",
    "compounds",
    "reactions",
    "entries",
    "entry_attachments",
    "samples",
    "results",
    "audit_trail",
]

# Column order for each COPY file. The seed loader uses identical orderings.
COLUMNS: dict[str, list[str]] = {
    "projects": [
        "id", "code", "name", "therapeutic_area", "started_at", "ended_at",
        "pi_email", "metadata", "created_at", "updated_at",
    ],
    "notebooks": [
        "id", "project_id", "name", "kind", "metadata", "created_at", "updated_at",
    ],
    "methods": [
        "id", "code", "name", "instrument_kind", "description", "parameters",
        "created_at",
    ],
    "compounds": [
        "id", "smiles_canonical", "inchikey", "mw", "external_id",
        "project_id", "metadata", "created_at",
    ],
    "reactions": [
        "id", "canonical_smiles_rxn", "family", "step_number", "project_id",
        "metadata", "created_at",
    ],
    "entries": [
        "id", "notebook_id", "project_id", "reaction_id", "schema_kind",
        "title", "author_email", "signed_by", "status", "entry_shape",
        "data_quality_tier", "fields_jsonb", "freetext", "freetext_length_chars",
        "created_at", "modified_at", "signed_at",
    ],
    "entry_attachments": [
        "id", "entry_id", "filename", "mime_type", "size_bytes", "description",
        "uri", "created_at",
    ],
    "samples": [
        "id", "entry_id", "sample_code", "compound_id", "amount_mg", "purity_pct",
        "notes", "created_at",
    ],
    "results": [
        "id", "sample_id", "method_id", "metric", "value_num", "value_text",
        "unit", "measured_at", "metadata", "created_at",
    ],
    "audit_trail": [
        "id", "entry_id", "actor_email", "action", "field_path", "old_value",
        "new_value", "reason", "occurred_at",
    ],
}


# --------------------------------------------------------------------------
# Helpers
# --------------------------------------------------------------------------


def stable_uuid(*parts: Any) -> str:
    key = "|".join(str(p) for p in parts)
    return str(uuid.uuid5(UUID_NAMESPACE, key))


def iso(dt: datetime) -> str:
    """Stable ISO 8601 string. Always UTC."""
    return dt.astimezone(UTC).strftime("%Y-%m-%d %H:%M:%S+00")


def parse_iso(s: str) -> datetime:
    return datetime.fromisoformat(s)


def jstr(obj: Any) -> str:
    """JSON serializer with stable key order so output is byte-identical."""
    return json.dumps(obj, sort_keys=True, separators=(",", ":"))


def weighted_pick(rng: random.Random, weights: dict[str, float]) -> str:
    keys = list(weights.keys())
    w = list(weights.values())
    return rng.choices(keys, weights=w, k=1)[0]


def dist_assign(
    rng: random.Random, n: int, weights: dict[str, float]
) -> list[str]:
    """Assign N items across categories per `weights`, exact integer counts."""
    keys = list(weights.keys())
    raw = [(k, weights[k] * n) for k in keys]
    floors = [(k, int(v)) for k, v in raw]
    remainder = n - sum(c for _, c in floors)
    fracs = sorted(
        ((k, raw[i][1] - floors[i][1]) for i, k in enumerate(keys)),
        key=lambda x: -x[1],
    )
    counts = dict(floors)
    for i in range(remainder):
        counts[fracs[i % len(fracs)][0]] += 1
    out: list[str] = []
    for k, c in counts.items():
        out.extend([k] * c)
    rng.shuffle(out)
    return out


# --------------------------------------------------------------------------
# Reaction expansion via RDKit
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


def build_reaction_smiles(family: dict[str, Any], rng: random.Random) -> tuple[str, str | None, list[str]]:
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


# --------------------------------------------------------------------------
# State
# --------------------------------------------------------------------------


@dataclass
class GenState:
    rows: dict[str, list[dict[str, Any]]] = field(default_factory=dict)

    def add(self, table: str, row: dict[str, Any]) -> None:
        self.rows.setdefault(table, []).append(row)

    def count(self, table: str) -> int:
        return len(self.rows.get(table, []))


# --------------------------------------------------------------------------
# CSV writer
# --------------------------------------------------------------------------


def _coerce_csv(v: Any) -> str:
    if v is None:
        return ""
    if isinstance(v, bool):
        return "true" if v else "false"
    if isinstance(v, (int, float)):
        if isinstance(v, float) and v != v:  # NaN guard
            return ""
        return repr(v)
    return str(v)


def write_csv_gz(path: Path, columns: list[str], rows: list[dict[str, Any]]) -> None:
    """Write rows as gzipped CSV. Empty string = NULL on COPY ... CSV WITH NULL ''.

    Uses sorted-determinism: rows are emitted in insertion order; within tests
    the generator emits in stable order so two runs match byte-for-byte.
    """
    buf = io.StringIO()
    writer = csv.writer(buf, quoting=csv.QUOTE_MINIMAL, lineterminator="\n")
    for row in rows:
        writer.writerow([_coerce_csv(row.get(col)) for col in columns])
    data = buf.getvalue().encode("utf-8")
    path.parent.mkdir(parents=True, exist_ok=True)
    # mtime=0 so gzip headers are deterministic across runs.
    with gzip.GzipFile(filename=str(path), mode="wb", mtime=0) as gz:
        gz.write(data)


# --------------------------------------------------------------------------
# Date / cadence helpers
# --------------------------------------------------------------------------


def is_holiday(d: datetime, holidays: set[str]) -> bool:
    return d.strftime("%Y-%m-%d") in holidays


def next_workday(d: datetime, holidays: set[str], rng: random.Random, weekend_skip_p: float) -> datetime:
    """Advance d by one or more days, mostly skipping weekends and holidays."""
    while True:
        d = d + timedelta(days=1)
        if is_holiday(d, holidays):
            continue
        if d.weekday() >= 5 and rng.random() < weekend_skip_p:
            continue
        return d


def burst_dates(
    start: datetime,
    end: datetime,
    n: int,
    chemists: list[str],
    holidays: set[str],
    rng: random.Random,
) -> list[tuple[datetime, str]]:
    """Spread n entries across [start, end] with bursty milestones, weekend
    gaps, holiday gaps. Returns list of (timestamp, chemist_email)."""
    span = (end - start).total_seconds()
    if span <= 0 or n == 0:
        return []
    out: list[tuple[datetime, str]] = []
    n_milestones = max(3, n // 60)
    milestones = sorted(
        start + timedelta(seconds=rng.uniform(0, span)) for _ in range(n_milestones)
    )
    for i in range(n):
        if rng.random() < 0.55 and milestones:
            anchor = milestones[i % len(milestones)]
            jitter_h = rng.gauss(0, 36)  # 1.5 days
            ts = anchor + timedelta(hours=jitter_h)
        else:
            ts = start + timedelta(seconds=rng.uniform(0, span))
        if ts < start:
            ts = start
        if ts > end:
            ts = end
        if is_holiday(ts, holidays):
            ts = ts + timedelta(days=1)
        if ts.weekday() >= 5 and rng.random() < 0.92:
            ts = ts + timedelta(days=2)
        ts = ts.replace(
            hour=rng.randint(8, 18),
            minute=rng.choice([0, 5, 10, 15, 20, 25, 30, 35, 40, 45, 50, 55]),
            second=rng.randint(0, 59),
            microsecond=0,
        )
        chemist = chemists[i % len(chemists)]
        out.append((ts, chemist))
    out.sort(key=lambda x: x[0])
    return out


# --------------------------------------------------------------------------
# Generator
# --------------------------------------------------------------------------


def generate(world: dict[str, Any], seed: int) -> GenState:
    state = GenState()
    rng = random.Random(seed)

    # ---- projects ----
    project_records: list[dict[str, Any]] = []
    for p in world["projects"]:
        pid = stable_uuid("project", p["code"])
        row = {
            "id": pid,
            "code": p["code"],
            "name": p["name"],
            "therapeutic_area": p["therapeutic_area"],
            "started_at": iso(parse_iso(p["started_at"])),
            "ended_at": iso(parse_iso(p["ended_at"])),
            "pi_email": p["pi_email"],
            "metadata": jstr({"source": "mock_eln", "chemists": p["chemists"]}),
            "created_at": iso(parse_iso(p["started_at"])),
            "updated_at": iso(parse_iso(p["started_at"])),
        }
        state.add("projects", row)
        project_records.append({**p, "_id": pid, "_row": row})

    # ---- methods (global pool) ----
    method_ids: list[str] = []
    for m in world["methods"]:
        mid = stable_uuid("method", m["code"])
        method_ids.append(mid)
        state.add(
            "methods",
            {
                "id": mid,
                "code": m["code"],
                "name": m["name"],
                "instrument_kind": m.get("instrument_kind"),
                "description": m.get("description"),
                "parameters": jstr({"mock": True}),
                "created_at": iso(parse_iso(world["timing"]["global_started_at"])),
            },
        )

    # ---- families lookup ----
    families: dict[str, dict[str, Any]] = {f["name"]: f for f in world["chemistry_families"]}
    bonuses: dict[str, dict[str, dict[str, float]]] = world.get("condition_bonuses", {})
    pools: dict[str, list[Any]] = world["condition_pools"]
    holidays = set(world["timing"]["holiday_gap_dates"])

    # ---- per project: notebooks + reactions + compounds ----
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
            try:
                m = Chem.MolFromSmiles(smi)
                inchikey = Chem.MolToInchiKey(m) if m else None
                mw = Chem.Descriptors.MolWt(m) if m else None
            except Exception:
                inchikey = None
                mw = None
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

    # ---- OFAT campaigns: pick or create a canonical reaction per family in
    # the campaign's project; stamp entries with that reaction_id and per-
    # entry condition variation. ----
    ofat_campaigns_index: dict[str, dict[str, Any]] = {}
    for camp in world["ofat_campaigns"]:
        proj_code = camp["project_code"]
        family_name = camp["family"]
        # Find an existing reaction with this family, else add one.
        candidate = None
        for r in project_reactions[proj_code]:
            if r["family"] == family_name:
                candidate = r
                break
        if candidate is None:
            fam = families[family_name]
            rxn_smi, _, _ = build_reaction_smiles(fam, rng)
            rid = stable_uuid("reaction-ofat", camp["id"])
            pid = stable_uuid("project", proj_code)
            candidate = {
                "id": rid,
                "canonical_smiles_rxn": rxn_smi,
                "family": family_name,
                "step_number": 1,
                "project_id": pid,
                "metadata": jstr({"source": "ofat_campaign", "campaign": camp["id"]}),
                "created_at": iso(
                    parse_iso(
                        next(p for p in world["projects"] if p["code"] == proj_code)[
                            "started_at"
                        ]
                    )
                ),
            }
            state.add("reactions", candidate)
            project_reactions[proj_code].append(candidate)
        ofat_campaigns_index[camp["id"]] = {**camp, "_reaction": candidate}

    # ---- Entries: OFAT children + discovery. ----
    proj_entry_targets = {p["code"]: p["entries"] for p in world["projects"]}
    proj_ofat_count = {p["code"]: 0 for p in world["projects"]}
    for camp in world["ofat_campaigns"]:
        proj_ofat_count[camp["project_code"]] += camp["entry_count"]

    distrib_shape = world["distributions"]["entry_shape"]
    distrib_quality = world["distributions"]["data_quality_tier"]
    distrib_freetext = world["distributions"]["freetext_length_band"]
    distrib_quality_text = world["distributions"]["freetext_quality"]

    # Compute discovery-entry counts per project
    proj_discovery_count = {
        p["code"]: max(0, proj_entry_targets[p["code"]] - proj_ofat_count[p["code"]])
        for p in world["projects"]
    }
    total_entries = sum(proj_entry_targets.values())

    # Pre-assign distributions once across the whole population so global
    # ratios are tight.
    shape_assignments = dist_assign(rng, total_entries, distrib_shape)
    quality_assignments = dist_assign(rng, total_entries, distrib_quality)
    freetext_assignments = dist_assign(rng, total_entries, distrib_freetext)
    freetext_quality_assignments = dist_assign(rng, total_entries, distrib_quality_text)

    entry_index = 0  # consumed in order so determinism holds

    def sample_yield(family_name: str, conditions: dict[str, Any]) -> float | None:
        """Noisy regression: base + sum(condition bonuses) + N(0, sigma)."""
        fam = families[family_name]
        base = float(fam["base_yield_pct"])
        sigma = float(fam["yield_sigma"])
        bonus = 0.0
        for axis, value in conditions.items():
            axis_bonus = bonuses.get(family_name, {}).get(axis, {})
            if isinstance(axis_bonus, dict):
                bonus += float(axis_bonus.get(str(value), axis_bonus.get(value, 0.0)) or 0.0)
        y = base + bonus + rng.gauss(0, sigma)
        return max(0.0, min(99.5, round(y, 2)))

    def pick_conditions(family_name: str, sweep_axes: list[str], idx: int) -> dict[str, Any]:
        """Pick a condition tuple. Sweep axes are varied; non-swept ones are
        held at a sensible default."""
        out: dict[str, Any] = {}
        # All axes get a value (so freetext template has it). Sweep axes are
        # cycled via idx so each campaign exhibits visible variation.
        for axis, vals in pools.items():
            if axis in sweep_axes:
                out[axis] = vals[idx % len(vals)]
            else:
                out[axis] = vals[0]
        return out

    # OFAT entries first — they share a reaction_id within campaign.
    for camp in world["ofat_campaigns"]:
        proj_code = camp["project_code"]
        proj = next(p for p in world["projects"] if p["code"] == proj_code)
        pid = stable_uuid("project", proj_code)
        rxn = ofat_campaigns_index[camp["id"]]["_reaction"]
        chemists = proj["chemists"]
        nbs = [n for n in project_notebooks[proj_code] if n["kind"] in ("process-dev", "discovery")]
        if not nbs:
            nbs = project_notebooks[proj_code]
        ts_chemist = burst_dates(
            parse_iso(proj["started_at"]),
            parse_iso(proj["ended_at"]),
            camp["entry_count"],
            chemists,
            holidays,
            rng,
        )
        for i, (ts, chemist) in enumerate(ts_chemist):
            shape = shape_assignments[entry_index]
            quality = quality_assignments[entry_index]
            ftext_band = freetext_assignments[entry_index]
            ftext_quality = freetext_quality_assignments[entry_index]
            entry_index += 1

            conditions = pick_conditions(camp["family"], camp["sweep_axes"], i)
            yield_pct = sample_yield(camp["family"], conditions)
            if quality == "failed":
                yield_pct = 0.0
            elif quality == "noisy":
                yield_pct = round(max(0.0, yield_pct + rng.gauss(0, 5)), 2)

            scale_mg = rng.choice([50, 100, 200, 500, 1000, 2000])
            entry_id = stable_uuid("entry-ofat", camp["id"], i)
            nb = nbs[i % len(nbs)]
            title = f"{camp['family']} OFAT — {camp['id']} #{i + 1:03d}"

            structured = {
                "family": camp["family"],
                "step_number": rxn["step_number"],
                "scale_mg": scale_mg,
                "campaign_id": camp["id"],
                "conditions": conditions,
                "results": {"yield_pct": yield_pct, "outcome_status": "completed" if quality != "failed" else "failed"},
            }
            ftext_fields = {
                **{k: v for k, v in conditions.items() if k in ("solvent", "base", "ligand", "temperature_c", "time_h", "catalyst", "reductant", "acid", "coupling_reagent")},
                "yield_pct": yield_pct,
                "scale_mg": scale_mg,
                "family": camp["family"],
                "outcome": "completed" if quality != "failed" else "failed",
            }

            # ~0.5% of entries with freetext carry an adversarial probe
            # (prompt-injection bait, fact-id fabrication, etc.) so the
            # agent's safety hooks have continuous regression coverage.
            adversarial = shape != "pure-structured" and rng.random() < ADVERSARIAL_RATE

            if shape == "pure-structured":
                fields_jsonb = structured
                freetext = ""
                ftext_len = 0
            elif shape == "pure-freetext":
                # Pure-freetext OFAT entries still carry the campaign_id
                # marker so OFAT-aware aggregation works regardless of shape.
                fields_jsonb = {"campaign_id": camp["id"]}
                lo, hi = ft.LENGTH_BANDS[[b[0] for b in ft.LENGTH_BANDS].index(ftext_band)][1:]
                freetext = ft.render_freetext(
                    rng, ftext_fields, lo, hi, ftext_quality,
                    pure_freetext=True, adversarial=adversarial,
                )
                ftext_len = len(freetext)
            else:  # mixed
                # Apply data_quality_tier perturbation to structured fields
                fields_jsonb = dict(structured)
                if quality == "partial":
                    # Drop ~30% of conditions
                    cs = dict(conditions)
                    keys = list(cs.keys())
                    drop_n = max(1, int(len(keys) * 0.3))
                    for k in rng.sample(keys, k=drop_n):
                        del cs[k]
                    fields_jsonb["conditions"] = cs
                if quality == "noisy":
                    # Add a stray jsonb field that's plausibly wrong
                    fields_jsonb["raw_remarks"] = "see freetext for actuals"
                lo, hi = ft.LENGTH_BANDS[[b[0] for b in ft.LENGTH_BANDS].index(ftext_band)][1:]
                # Mixed-shape freetext is biased shorter
                lo = min(lo, 50)
                hi = min(hi, 500) if hi <= 1500 else hi
                freetext = ft.render_freetext(
                    rng, ftext_fields, lo, hi, ftext_quality,
                    pure_freetext=False, adversarial=adversarial,
                )
                ftext_len = len(freetext)

            status = "signed" if rng.random() < 0.55 else rng.choice(["draft", "in_progress", "witnessed", "archived"])
            signed_at = iso(ts + timedelta(days=rng.randint(0, 5))) if status in ("signed", "witnessed", "archived") else ""
            signed_by = chemist if status in ("signed", "witnessed", "archived") else ""

            state.add(
                "entries",
                {
                    "id": entry_id,
                    "notebook_id": nb["id"],
                    "project_id": pid,
                    "reaction_id": rxn["id"],
                    "schema_kind": "ord-v0.3",
                    "title": title,
                    "author_email": chemist,
                    "signed_by": signed_by,
                    "status": status,
                    "entry_shape": shape,
                    "data_quality_tier": quality,
                    "fields_jsonb": jstr(fields_jsonb),
                    "freetext": freetext,
                    "freetext_length_chars": ftext_len,
                    "created_at": iso(ts),
                    "modified_at": iso(ts + timedelta(hours=rng.randint(1, 48))),
                    "signed_at": signed_at,
                },
            )

    # ---- Discovery entries ----
    for proj in world["projects"]:
        pcode = proj["code"]
        pid = stable_uuid("project", pcode)
        chemists = proj["chemists"]
        rxns = project_reactions[pcode]
        nbs = project_notebooks[pcode]
        n = proj_discovery_count[pcode]
        ts_chemist = burst_dates(
            parse_iso(proj["started_at"]),
            parse_iso(proj["ended_at"]),
            n,
            chemists,
            holidays,
            rng,
        )
        for i, (ts, chemist) in enumerate(ts_chemist):
            shape = shape_assignments[entry_index]
            quality = quality_assignments[entry_index]
            ftext_band = freetext_assignments[entry_index]
            ftext_quality = freetext_quality_assignments[entry_index]
            entry_index += 1

            # 70% are linked to a reaction; 30% are pure-discovery (analytical/qc style)
            if rng.random() < 0.7 and rxns:
                rxn = rng.choice(rxns)
                family_name = rxn["family"]
                conditions = pick_conditions(family_name, list(pools.keys())[:3], i)
                yield_pct = sample_yield(family_name, conditions)
                if quality == "failed":
                    yield_pct = 0.0
                rxn_id = rxn["id"]
                title = f"{family_name} discovery — {pcode} #{i + 1:04d}"
            else:
                rxn = None
                family_name = "analytical"
                conditions = {"solvent": "MeCN", "method": "HPLC-A"}
                yield_pct = None
                rxn_id = None
                title = f"Analytical / QC entry — {pcode} #{i + 1:04d}"

            scale_mg = rng.choice([10, 25, 50, 100, 200, 500])
            entry_id = stable_uuid("entry-disc", pcode, i)
            nb = nbs[i % len(nbs)]

            structured = {
                "family": family_name,
                "step_number": rxn["step_number"] if rxn else None,
                "scale_mg": scale_mg,
                "conditions": conditions,
                "results": {
                    "yield_pct": yield_pct,
                    "outcome_status": "completed" if quality != "failed" else "failed",
                },
            }
            ftext_fields = {
                **{k: conditions.get(k) for k in ("solvent", "base", "temperature_c") if k in conditions},
                "yield_pct": yield_pct,
                "scale_mg": scale_mg,
                "family": family_name,
                "outcome": "completed" if quality != "failed" else "failed",
            }

            adversarial = shape != "pure-structured" and rng.random() < ADVERSARIAL_RATE

            if shape == "pure-structured":
                fields_jsonb = structured
                freetext = ""
                ftext_len = 0
            elif shape == "pure-freetext":
                fields_jsonb = {}
                lo, hi = ft.LENGTH_BANDS[[b[0] for b in ft.LENGTH_BANDS].index(ftext_band)][1:]
                freetext = ft.render_freetext(
                    rng, ftext_fields, lo, hi, ftext_quality,
                    pure_freetext=True, adversarial=adversarial,
                )
                ftext_len = len(freetext)
            else:
                fields_jsonb = dict(structured)
                if quality == "partial":
                    cs = dict(conditions)
                    keys = list(cs.keys())
                    if keys:
                        drop_n = max(1, int(len(keys) * 0.3))
                        for k in rng.sample(keys, k=drop_n):
                            del cs[k]
                        fields_jsonb["conditions"] = cs
                if quality == "noisy":
                    fields_jsonb["raw_remarks"] = "see freetext"
                lo, hi = ft.LENGTH_BANDS[[b[0] for b in ft.LENGTH_BANDS].index(ftext_band)][1:]
                lo = min(lo, 50)
                hi = min(hi, 500) if hi <= 1500 else hi
                freetext = ft.render_freetext(
                    rng, ftext_fields, lo, hi, ftext_quality,
                    pure_freetext=False, adversarial=adversarial,
                )
                ftext_len = len(freetext)

            status = "signed" if rng.random() < 0.5 else rng.choice(["draft", "in_progress", "witnessed", "archived"])
            signed_at = iso(ts + timedelta(days=rng.randint(0, 7))) if status in ("signed", "witnessed", "archived") else ""
            signed_by = chemist if status in ("signed", "witnessed", "archived") else ""

            state.add(
                "entries",
                {
                    "id": entry_id,
                    "notebook_id": nb["id"],
                    "project_id": pid,
                    "reaction_id": rxn_id or "",
                    "schema_kind": "ord-v0.3",
                    "title": title,
                    "author_email": chemist,
                    "signed_by": signed_by,
                    "status": status,
                    "entry_shape": shape,
                    "data_quality_tier": quality,
                    "fields_jsonb": jstr(fields_jsonb),
                    "freetext": freetext,
                    "freetext_length_chars": ftext_len,
                    "created_at": iso(ts),
                    "modified_at": iso(ts + timedelta(hours=rng.randint(1, 72))),
                    "signed_at": signed_at,
                },
            )

    # ---- Samples + results + attachments + audit_trail ----
    entries = state.rows["entries"]
    samples_target = 3000
    results_target = 5000
    attachments_target = 3500
    audit_target = 12000

    # Samples: ~1.5 per entry, but skewed so some entries have 0 and others have many.
    #
    # sample_code format: S-{PROJECT_CODE}-{NNNNN} (zero-padded sequential
    # per project). This is the cross-link key used by fake_logs.datasets
    # (~70% of which carry a sample_id matching one of these codes), so it
    # MUST stay deterministic and predictable from the project code +
    # ordinal alone — DO NOT mix entry-derived bytes into it.
    sample_rng = random.Random(seed + 1)
    samples_emitted = 0
    project_sample_counters: dict[str, int] = {}
    # Build a fast lookup project_id → project_code (avoids the linear
    # search inside the hot loop).
    pid_to_code: dict[str, str] = {
        stable_uuid("project", p["code"]): p["code"] for p in world["projects"]
    }
    for e in entries:
        if samples_emitted >= samples_target:
            break
        # Most entries get 1-2 samples, some get 0, a few get up to 5
        roll = sample_rng.random()
        n_samples = 0 if roll < 0.10 else 1 if roll < 0.55 else 2 if roll < 0.85 else sample_rng.randint(3, 5)
        if e["data_quality_tier"] == "failed":
            n_samples = max(0, n_samples - 1)
        proj_code = pid_to_code[e["project_id"]]
        for s_idx in range(n_samples):
            if samples_emitted >= samples_target:
                break
            sample_id = stable_uuid("sample", e["id"], s_idx)
            project_compounds_for_proj = project_compounds[proj_code]
            cmpd = sample_rng.choice(project_compounds_for_proj) if project_compounds_for_proj else None
            ordinal = project_sample_counters.get(proj_code, 0) + 1
            project_sample_counters[proj_code] = ordinal
            sample_code = f"S-{proj_code}-{ordinal:05d}"
            amt = round(sample_rng.uniform(5, 500), 2)
            purity = round(sample_rng.uniform(70, 99.9), 2)
            state.add(
                "samples",
                {
                    "id": sample_id,
                    "entry_id": e["id"],
                    "sample_code": sample_code,
                    "compound_id": cmpd["id"] if cmpd else "",
                    "amount_mg": amt,
                    "purity_pct": purity,
                    "notes": "" if sample_rng.random() < 0.7 else "Stored at -20C under N2.",
                    "created_at": e["created_at"],
                },
            )
            samples_emitted += 1

    # Results: ~1.7 per sample (nudged so total clears the 4500 floor).
    result_rng = random.Random(seed + 2)
    samples = state.rows["samples"]
    results_emitted = 0
    for s in samples:
        if results_emitted >= results_target:
            break
        n_res = 1 if result_rng.random() < 0.40 else 2 if result_rng.random() < 0.80 else 3
        for r_idx in range(n_res):
            if results_emitted >= results_target:
                break
            method_id = result_rng.choice(method_ids)
            metric = result_rng.choice(["purity_pct", "yield_pct", "rt_min", "mz", "ee_pct"])
            value_num: float | None = None
            value_text: str | None = None
            unit: str | None = None
            if metric == "purity_pct":
                value_num = round(result_rng.uniform(80, 100), 2)
                unit = "%"
            elif metric == "yield_pct":
                value_num = round(result_rng.uniform(20, 99), 2)
                unit = "%"
            elif metric == "rt_min":
                value_num = round(result_rng.uniform(1.0, 12.0), 3)
                unit = "min"
            elif metric == "mz":
                value_num = round(result_rng.uniform(150, 800), 4)
                unit = "Da"
            else:
                value_num = round(result_rng.uniform(85, 99.9), 2)
                unit = "% ee"
            rid = stable_uuid("result", s["id"], r_idx)
            measured_at = s["created_at"]
            state.add(
                "results",
                {
                    "id": rid,
                    "sample_id": s["id"],
                    "method_id": method_id,
                    "metric": metric,
                    "value_num": value_num,
                    "value_text": value_text or "",
                    "unit": unit,
                    "measured_at": measured_at,
                    "metadata": jstr({"qc": True}),
                    "created_at": measured_at,
                },
            )
            results_emitted += 1

    # Attachments: ~1.75 per entry on average
    att_rng = random.Random(seed + 3)
    att_emitted = 0
    for e in entries:
        if att_emitted >= attachments_target:
            break
        n_att = 1 if att_rng.random() < 0.55 else 2 if att_rng.random() < 0.85 else att_rng.randint(3, 5)
        for a_idx in range(n_att):
            if att_emitted >= attachments_target:
                break
            ext = att_rng.choice([
                ("pdf", "application/pdf", 200_000),
                ("png", "image/png", 80_000),
                ("xlsx", "application/vnd.ms-excel", 40_000),
                ("zip", "application/zip", 1_500_000),
                ("txt", "text/plain", 4_000),
            ])
            aid = stable_uuid("attachment", e["id"], a_idx)
            state.add(
                "entry_attachments",
                {
                    "id": aid,
                    "entry_id": e["id"],
                    "filename": f"{e['id'][:8]}-{a_idx + 1}.{ext[0]}",
                    "mime_type": ext[1],
                    "size_bytes": ext[2] + att_rng.randint(0, 50_000),
                    "description": att_rng.choice([
                        "Raw HPLC trace",
                        "Procedure photo",
                        "Workup notes",
                        "TLC scan",
                        "NMR PDF",
                        "Excel data dump",
                    ]),
                    "uri": f"local-mock-eln://{e['id']}/{a_idx + 1}",
                    "created_at": e["created_at"],
                },
            )
            att_emitted += 1

    # Audit trail: ~6 events per entry
    audit_rng = random.Random(seed + 4)
    audit_emitted = 0
    for e in entries:
        if audit_emitted >= audit_target:
            break
        n_audit = audit_rng.randint(3, 9)
        for a_idx in range(n_audit):
            if audit_emitted >= audit_target:
                break
            action = audit_rng.choice(["create", "update", "sign", "witness", "comment", "attach", "amend"])
            field_path = audit_rng.choice([
                "fields_jsonb.conditions.solvent",
                "fields_jsonb.results.yield_pct",
                "fields_jsonb.scale_mg",
                "freetext",
                "status",
            ])
            occurred_at = e["created_at"]
            aid = stable_uuid("audit", e["id"], a_idx)
            state.add(
                "audit_trail",
                {
                    "id": aid,
                    "entry_id": e["id"],
                    "actor_email": e["author_email"],
                    "action": action,
                    "field_path": field_path,
                    "old_value": jstr(None),
                    "new_value": jstr({"_": "redacted"}),
                    "reason": audit_rng.choice(["", "transcription error", "instrument re-cal", "operator correction", ""]),
                    "occurred_at": occurred_at,
                },
            )
            audit_emitted += 1

    # Sort each table by id for byte-identical output across runs.
    for tname in TABLE_ORDER:
        if tname in state.rows:
            state.rows[tname].sort(key=lambda r: r["id"])

    return state


# --------------------------------------------------------------------------
# SQL loader emission
# --------------------------------------------------------------------------


def write_seed_sql(out_path: Path, fixtures_relpath: str) -> None:
    """Write db/seed/20_mock_eln_data.sql.

    The loader is gated by `current_setting('app.mock_eln_enabled', true) = 'on'`.
    Use:
        psql -v "ON_ERROR_STOP=1" -c "SET app.mock_eln_enabled = 'on';" -f db/seed/20_mock_eln_data.sql
    or:
        psql -c "ALTER DATABASE chemclaw SET app.mock_eln_enabled = 'on';"
        psql -f db/seed/20_mock_eln_data.sql

    Idempotency: the script TRUNCATES mock_eln tables (CASCADE) inside the
    gated block, then \\copies. Re-running yields the same rows.
    """
    lines: list[str] = [
        "-- Mock ELN — seed data loader.",
        "-- Auto-generated by services/mock_eln/seed/generator.py.",
        "-- DO NOT EDIT BY HAND. Re-run the generator instead.",
        "--",
        "-- Gating: this loader only runs when the postgres GUC",
        "--   app.mock_eln_enabled = 'on'",
        "-- is set on the session or the database.",
        "--",
        "-- Apply with:",
        "--   psql -v ON_ERROR_STOP=1 \\",
        "--     -c \"SET app.mock_eln_enabled = 'on';\" \\",
        "--     -f db/seed/20_mock_eln_data.sql",
        "-- or set it persistently:",
        "--   ALTER DATABASE chemclaw SET app.mock_eln_enabled = 'on';",
        "--",
        "-- Re-running is safe: the gated block TRUNCATEs the mock_eln tables",
        "-- (CASCADE) before \\copying so the resulting state is byte-identical",
        "-- to a fresh run with the same fixtures.",
        "",
        r"\set ON_ERROR_STOP on",
        "",
        "-- Resolve the gate into a psql boolean variable. \\if accepts only",
        "-- a literal boolean, so we compute the comparison server-side and",
        "-- \\gset the resulting true/false into :mock_eln_enabled.",
        "SELECT (coalesce(current_setting('app.mock_eln_enabled', true), 'off') = 'on')",
        "       AS mock_eln_enabled \\gset",
        "",
        r"\if :mock_eln_enabled",
        "BEGIN;",
        "",
        "TRUNCATE TABLE mock_eln.audit_trail, mock_eln.results, mock_eln.samples,",
        "               mock_eln.entry_attachments, mock_eln.entries,",
        "               mock_eln.reactions, mock_eln.compounds, mock_eln.methods,",
        "               mock_eln.notebooks, mock_eln.projects RESTART IDENTITY CASCADE;",
        "",
    ]

    for table in TABLE_ORDER:
        cols = COLUMNS[table]
        cols_sql = ", ".join(cols)
        rel = f"{fixtures_relpath}/{table}.copy.gz"
        lines.append(
            f"\\copy mock_eln.{table} ({cols_sql}) FROM PROGRAM 'gunzip -c {rel}' WITH (FORMAT csv, NULL '');"
        )

    lines.extend(
        [
            "",
            "COMMIT;",
            "",
            r"\echo 'Mock ELN seed data loaded.'",
            r"\else",
            r"\echo 'Mock ELN seed skipped — set app.mock_eln_enabled = ''on'' to load.'",
            r"\endif",
            "",
        ]
    )
    out_path.parent.mkdir(parents=True, exist_ok=True)
    out_path.write_text("\n".join(lines), encoding="utf-8")


# --------------------------------------------------------------------------
# Public entry point
# --------------------------------------------------------------------------


def run(seed: int | None = None, fixtures_dir: Path | None = None,
        seed_sql_path: Path | None = None) -> dict[str, int]:
    """Generate fixtures + seed loader; returns row counts per table."""
    seed_val = seed if seed is not None else int(os.environ.get("WORLD_SEED", "42"))
    fdir = fixtures_dir or FIXTURES_DIR
    sql_path = seed_sql_path or SEED_SQL_PATH

    with open(WORLD_YAML, encoding="utf-8") as fh:
        world = yaml.safe_load(fh)

    state = generate(world, seed_val)

    # Write COPY files
    counts: dict[str, int] = {}
    for table in TABLE_ORDER:
        rows = state.rows.get(table, [])
        out = fdir / f"{table}.copy.gz"
        write_csv_gz(out, COLUMNS[table], rows)
        counts[table] = len(rows)

    # Write loader SQL. For the canonical (in-tree) layout the path in the
    # SQL file is repo-root-relative; for tests we accept any out-of-tree
    # fixtures dir and emit an absolute path.
    try:
        rel = fdir.relative_to(REPO_ROOT).as_posix()
    except ValueError:
        rel = str(fdir)
    write_seed_sql(sql_path, rel)

    return counts


if __name__ == "__main__":
    counts = run()
    for t, n in counts.items():
        print(f"{t:25s} {n:>6d}")
