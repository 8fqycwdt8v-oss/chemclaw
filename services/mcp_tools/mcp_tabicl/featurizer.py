"""Reaction rows → feature matrix + targets for TabICL inference.

Featurization contract (see spec §3.4):
  drfp_pc_1..32            float     DRFP 2048-bit → 32 PCA components
  rxno_class               categorical
  solvent_class            categorical (mapped from free-text solvent)
  temp_c                   float
  time_min                 float
  catalyst_loading_mol_pct float
  base_class               categorical (mapped from free-text base)
  target:  yield_pct       float (regression)

This module is intentionally pure: no DB, no HTTP. Callers are
responsible for supplying rows.
"""
from __future__ import annotations

from dataclasses import dataclass, field
from typing import Any

import numpy as np

from .pca import FittedPca, PCA_N_COMPONENTS, transform as pca_transform

ROW_CAP: int = 1000

# Fixed categorical vocabularies — TabICL handles categoricals natively, but
# we normalize free-text strings to a fixed set so feature positions stay stable.
_SOLVENT_CLASSES = (
    "water", "methanol", "ethanol", "acetonitrile", "thf", "dmf", "dmso",
    "dcm", "chloroform", "toluene", "benzene", "hexane", "ether", "dioxane",
    "acetone", "etoac", "ipa", "nmp", "pyridine", "other",
)
_BASE_CLASSES = (
    "k2co3", "cs2co3", "na2co3", "k3po4", "kotbu", "naotbu", "kh", "nah",
    "lda", "nbuli", "dbu", "tea", "dipea", "dmap", "none", "other",
)


@dataclass(frozen=True)
class ReactionRow:
    reaction_id: str
    rxn_smiles: str
    rxno_class: str | None
    solvent: str | None
    temp_c: float | None
    time_min: float | None
    catalyst_loading_mol_pct: float | None
    base: str | None
    yield_pct: float | None


@dataclass(frozen=True)
class FeatureSchema:
    feature_names: list[str] = field(default_factory=list)
    categorical_names: frozenset[str] = field(default_factory=frozenset)


def _normalize_solvent(s: str | None) -> str:
    if not s:
        return "other"
    key = s.strip().lower()
    return key if key in _SOLVENT_CLASSES else "other"


def _normalize_base(b: str | None) -> str:
    if not b:
        return "none"
    key = b.strip().lower()
    return key if key in _BASE_CLASSES else "other"


def _patch_drfp_for_numpy2() -> None:
    """Apply a one-time monkey-patch so drfp 0.3.6 works with NumPy 2.x.

    drfp 0.3.6 passes unsigned 32-bit hash values (0..2^32-1) to
    np.array(..., dtype=np.int32). NumPy 2.x enforces strict int32 bounds
    and raises OverflowError. Replacing the dtype with uint32 is safe because
    the subsequent fold step only uses modulo arithmetic.
    """
    try:
        from drfp import DrfpEncoder
        from hashlib import blake2b as _blake2b

        # Guard: only patch when the original dtype would overflow.
        # We test by trying to store the max uint32 value in int32.
        try:
            np.array([4294967295], dtype=np.int32)
            return  # NumPy accepted it — no patch needed
        except (OverflowError, ValueError):
            pass

        def _hash_uint32(shingling):  # type: ignore[no-untyped-def]
            return np.array(
                [int(_blake2b(t, digest_size=4).hexdigest(), 16) for t in shingling],
                dtype="uint32",
            )

        DrfpEncoder.hash = staticmethod(_hash_uint32)
    except Exception:
        pass  # If drfp isn't importable, _compute_drfp_bits will handle it.


_patch_drfp_for_numpy2()


def _compute_drfp_bits(rxn_smiles: str) -> np.ndarray | None:
    try:
        from drfp import DrfpEncoder

        result = DrfpEncoder.encode(rxn_smiles, n_folded_length=2048, radius=3)
        # encode() returns a list of fingerprints (one per reaction SMILES).
        if not result:
            return None
        arr = np.asarray(result[0], dtype="float64")
        if arr.shape != (2048,):
            return None
        return arr
    except Exception:
        return None


def featurize(
    rows: list[ReactionRow],
    fitted_pca: FittedPca,
    include_targets: bool,
) -> tuple[FeatureSchema, np.ndarray, np.ndarray | None, list[dict[str, Any]]]:
    """Transform rows into a (N, F) feature matrix + optional (N,) targets.

    Rows with invalid / un-parseable SMILES are dropped; the reason is
    appended to `skipped` and the caller is expected to surface them as
    caveats. Raises ValueError if `len(rows) > ROW_CAP`.
    """
    if len(rows) > ROW_CAP:
        raise ValueError(f"row cap exceeded: {len(rows)} > {ROW_CAP}")

    # --- assemble DRFP bits + PCA ---
    drfp_mat_rows: list[np.ndarray] = []
    kept: list[ReactionRow] = []
    skipped: list[dict[str, Any]] = []
    for r in rows:
        bits = _compute_drfp_bits(r.rxn_smiles)
        if bits is None:
            skipped.append({"reaction_id": r.reaction_id, "reason": "invalid_rxn_smiles"})
            continue
        drfp_mat_rows.append(bits)
        kept.append(r)

    if not kept:
        schema = FeatureSchema(
            feature_names=[f"drfp_pc_{i+1}" for i in range(PCA_N_COMPONENTS)]
            + ["rxno_class", "solvent_class", "temp_c", "time_min",
               "catalyst_loading_mol_pct", "base_class"],
            categorical_names=frozenset({"rxno_class", "solvent_class", "base_class"}),
        )
        return schema, np.zeros((0, len(schema.feature_names)), dtype="float64"), None, skipped

    drfp_matrix = np.vstack(drfp_mat_rows)
    pca_out = pca_transform(drfp_matrix, fitted_pca)  # (N, 32)

    # --- build the combined feature matrix ---
    feature_names = [f"drfp_pc_{i+1}" for i in range(PCA_N_COMPONENTS)] + [
        "rxno_class", "solvent_class", "temp_c", "time_min",
        "catalyst_loading_mol_pct", "base_class",
    ]
    # TabICL accepts object arrays of mixed dtypes; we keep everything as
    # float for numeric cols and categorical encoded as int indices for
    # categorical cols. TabICL recognises them as categorical by the
    # `categorical_names` the caller passes to inference.
    n = len(kept)
    X = np.empty((n, len(feature_names)), dtype="object")
    X[:, :PCA_N_COMPONENTS] = pca_out
    for i, r in enumerate(kept):
        X[i, PCA_N_COMPONENTS + 0] = r.rxno_class or "unknown"
        X[i, PCA_N_COMPONENTS + 1] = _normalize_solvent(r.solvent)
        X[i, PCA_N_COMPONENTS + 2] = float(r.temp_c) if r.temp_c is not None else np.nan
        X[i, PCA_N_COMPONENTS + 3] = float(r.time_min) if r.time_min is not None else np.nan
        X[i, PCA_N_COMPONENTS + 4] = (
            float(r.catalyst_loading_mol_pct)
            if r.catalyst_loading_mol_pct is not None
            else np.nan
        )
        X[i, PCA_N_COMPONENTS + 5] = _normalize_base(r.base)

    y: np.ndarray | None = None
    if include_targets:
        y = np.asarray(
            [r.yield_pct if r.yield_pct is not None else np.nan for r in kept],
            dtype="float64",
        )

    schema = FeatureSchema(
        feature_names=feature_names,
        categorical_names=frozenset({"rxno_class", "solvent_class", "base_class"}),
    )
    return schema, X, y, skipped
