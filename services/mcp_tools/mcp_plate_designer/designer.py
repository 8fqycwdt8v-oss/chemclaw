"""Pure-function plate-design helpers — no FastAPI, no I/O.

Builds a BoFire Domain from request inputs, applies exclusions + the
CHEM21 safety floor, samples space-filling candidates, and labels them
A01..H12 / A01..P24 / etc.
"""
from __future__ import annotations

import json
from pathlib import Path
from typing import Any

from bofire.data_models.domain.api import Domain, Inputs
from bofire.data_models.features.api import CategoricalInput, ContinuousInput

# --------------------------------------------------------------------------
# Plate format → (rows, cols) — A01..H12 layout
# --------------------------------------------------------------------------
_PLATE_LAYOUTS: dict[str, tuple[int, int]] = {
    "24":   (4,  6),
    "96":   (8,  12),
    "384":  (16, 24),
    "1536": (32, 48),
}


def plate_geometry(plate_format: str) -> tuple[int, int]:
    if plate_format not in _PLATE_LAYOUTS:
        raise ValueError(
            f"unknown plate_format {plate_format!r}; choose 24/96/384/1536"
        )
    return _PLATE_LAYOUTS[plate_format]


def plate_capacity(plate_format: str) -> int:
    rows, cols = plate_geometry(plate_format)
    return rows * cols


def well_id(row_idx: int, col_idx: int) -> str:
    """Row 0 → A, col 0 → 01. A01, A02, ..., H12, etc."""
    if row_idx < 0 or row_idx > 25:
        raise ValueError(f"row_idx {row_idx} out of A..Z range")
    return f"{chr(ord('A') + row_idx)}{col_idx + 1:02d}"


def generate_well_ids(plate_format: str, n_wells: int) -> list[str]:
    rows, cols = plate_geometry(plate_format)
    ids: list[str] = []
    for i in range(n_wells):
        r, c = divmod(i, cols)
        if r >= rows:
            raise ValueError(
                f"n_wells={n_wells} exceeds plate {plate_format} capacity {rows * cols}"
            )
        ids.append(well_id(r, c))
    return ids


# --------------------------------------------------------------------------
# CHEM21 safety floor
# --------------------------------------------------------------------------
def load_chem21_floor(data_dir: Path) -> set[str]:
    """Return the set of solvent names with class 'HighlyHazardous'."""
    path = data_dir / "chem21_solvents_v1.json"
    if not path.exists():
        return set()
    with path.open("r", encoding="utf-8") as f:
        rows = json.load(f)
    return {r["name"] for r in rows if r.get("class") == "HighlyHazardous"}


# --------------------------------------------------------------------------
# Domain construction
# --------------------------------------------------------------------------
def apply_exclusions(
    categorical_inputs: list[dict[str, Any]],
    exclusions: dict[str, list[str]],
    chem21_floor: set[str],
    disable_chem21_floor: bool = False,
) -> tuple[list[dict[str, Any]], dict[str, list[str]]]:
    """Drop excluded values from each categorical list. Returns (filtered, applied_floor_per_field).

    The CHEM21 floor only applies to a categorical named 'solvent'. Other
    categoricals (catalyst, base, ligand) are user-supplied as-is.
    """
    filtered: list[dict[str, Any]] = []
    applied_floor: dict[str, list[str]] = {}
    for cat in categorical_inputs:
        name = cat["name"]
        original = list(cat["values"])
        # Apply user exclusions for this field.
        excluded = set(exclusions.get(name, []))
        excluded.update(exclusions.get("solvents", []) if name == "solvent" else [])
        # Apply CHEM21 floor for the solvent field.
        if name == "solvent" and not disable_chem21_floor:
            floor_drops = [v for v in original if v in chem21_floor and v not in excluded]
            if floor_drops:
                applied_floor[name] = floor_drops
            excluded.update(floor_drops)
        kept = [v for v in original if v not in excluded]
        if not kept:
            raise ValueError(
                f"empty_categorical:{name}: all values excluded "
                f"(original={original}, excluded={sorted(excluded)})"
            )
        filtered.append({**cat, "values": kept})
    return filtered, applied_floor


def build_domain(
    factors: list[dict[str, Any]],
    categorical_inputs: list[dict[str, Any]],
) -> Domain:
    features: list[Any] = []
    for f in factors:
        if f["type"] != "continuous":
            raise ValueError(f"unknown factor type {f['type']!r}; only 'continuous' supported")
        lo, hi = f["range"]
        features.append(ContinuousInput(key=f["name"], bounds=(float(lo), float(hi))))
    for cat in categorical_inputs:
        features.append(CategoricalInput(key=cat["name"], categories=list(cat["values"])))
    return Domain(inputs=Inputs(features=features))


def design_plate(
    plate_format: str,
    factors: list[dict[str, Any]],
    categorical_inputs: list[dict[str, Any]],
    exclusions: dict[str, list[str]],
    n_wells: int,
    seed: int,
    chem21_floor: set[str],
    disable_chem21_floor: bool = False,
    reactants_smiles: str | None = None,
    product_smiles: str | None = None,
) -> dict[str, Any]:
    """Build Domain → sample n_wells points → label and return JSON."""
    capacity = plate_capacity(plate_format)
    if n_wells > capacity:
        raise ValueError(
            f"n_wells={n_wells} exceeds plate {plate_format} capacity {capacity}"
        )

    filtered_cats, applied_floor = apply_exclusions(
        categorical_inputs, exclusions, chem21_floor, disable_chem21_floor
    )
    domain = build_domain(factors, filtered_cats)
    samples = domain.inputs.sample(n=n_wells, seed=seed)

    well_ids = generate_well_ids(plate_format, n_wells)
    rxn_smiles = (
        f"{reactants_smiles}>>{product_smiles}"
        if reactants_smiles and product_smiles
        else None
    )

    factor_names = [f["name"] for f in factors] + [c["name"] for c in filtered_cats]
    wells: list[dict[str, Any]] = []
    for idx, wid in enumerate(well_ids):
        row = samples.iloc[idx]
        factor_values = {name: _coerce_cell(row[name]) for name in factor_names}
        wells.append(
            {
                "well_id": wid,
                "rxn_smiles": rxn_smiles,
                "factor_values": factor_values,
            }
        )

    rows, cols = plate_geometry(plate_format)
    return {
        "wells": wells,
        "domain_json": json.loads(domain.model_dump_json()),
        "design_metadata": {
            "n_wells": n_wells,
            "plate_format": plate_format,
            "rows": rows,
            "cols": cols,
            "sampling_strategy": "space_filling",
            "seed": seed,
            "excluded_solvents": list(set(exclusions.get("solvents", []))),
            "applied_chem21_floor": applied_floor,
            "disable_chem21_floor": disable_chem21_floor,
        },
    }


def _coerce_cell(val: Any) -> Any:
    """pandas Series cell → JSON-friendly Python value."""
    try:
        import numpy as np  # noqa: PLC0415

        if isinstance(val, (np.floating, np.integer)):
            return float(val)
    except ImportError:
        pass
    return val
