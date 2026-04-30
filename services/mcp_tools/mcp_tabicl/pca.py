"""DRFP → 32-dim PCA fit / persist / load / transform.

The persisted artifact is plain JSON — three float arrays plus
dimensionality metadata. The loader reconstructs NumPy arrays
directly, applying no serialisation framework that could execute
code. Shape mismatches refuse to load.
"""
from __future__ import annotations

import json
from dataclasses import dataclass
from pathlib import Path

import numpy as np
from sklearn.decomposition import PCA

PCA_N_COMPONENTS: int = 32
PCA_N_FEATURES: int = 2048


@dataclass(frozen=True)
class FittedPca:
    components: np.ndarray          # shape (n_components, n_features)
    mean: np.ndarray                # shape (n_features,)
    explained_variance: np.ndarray  # shape (n_components,)


def fit_and_save(X: np.ndarray, path: Path) -> None:
    """Fit a PCA on an (N, 2048) float matrix and persist to JSON atomically."""
    if X.ndim != 2 or X.shape[1] != PCA_N_FEATURES:
        raise ValueError(
            f"X must be 2-D with {PCA_N_FEATURES} columns; got shape {X.shape}"
        )
    if X.shape[0] < PCA_N_COMPONENTS:
        raise ValueError(
            f"need at least {PCA_N_COMPONENTS} rows to fit {PCA_N_COMPONENTS} components; "
            f"got {X.shape[0]}"
        )
    pca = PCA(n_components=PCA_N_COMPONENTS, svd_solver="auto", random_state=0)
    pca.fit(X.astype("float64", copy=False))
    payload = {
        "n_components": PCA_N_COMPONENTS,
        "n_features": PCA_N_FEATURES,
        "components": pca.components_.astype("float64").tolist(),
        "mean": pca.mean_.astype("float64").tolist(),
        "explained_variance": pca.explained_variance_.astype("float64").tolist(),
    }
    # Atomic swap: write temp then rename.
    tmp = path.with_suffix(path.suffix + ".tmp")
    tmp.write_text(json.dumps(payload))
    tmp.replace(path)


def load(path: Path) -> FittedPca:
    """Load a fitted PCA from its JSON artifact. Raises ValueError on mismatch."""
    try:
        raw = json.loads(path.read_text())
    except (OSError, json.JSONDecodeError) as exc:
        raise ValueError(f"cannot read PCA artifact {path}: {exc}") from exc

    if not isinstance(raw, dict):
        raise ValueError("PCA artifact must be a JSON object")
    if raw.get("n_components") != PCA_N_COMPONENTS:
        raise ValueError(
            f"PCA artifact n_components mismatch: expected {PCA_N_COMPONENTS}, "
            f"got {raw.get('n_components')}"
        )
    if raw.get("n_features") != PCA_N_FEATURES:
        raise ValueError(
            f"PCA artifact n_features mismatch: expected {PCA_N_FEATURES}, "
            f"got {raw.get('n_features')}"
        )

    components = np.asarray(raw["components"], dtype="float64")
    mean = np.asarray(raw["mean"], dtype="float64")
    explained = np.asarray(raw["explained_variance"], dtype="float64")

    if components.shape != (PCA_N_COMPONENTS, PCA_N_FEATURES):
        raise ValueError(f"bad components shape: {components.shape}")
    if mean.shape != (PCA_N_FEATURES,):
        raise ValueError(f"bad mean shape: {mean.shape}")
    if explained.shape != (PCA_N_COMPONENTS,):
        raise ValueError(f"bad explained_variance shape: {explained.shape}")

    return FittedPca(components=components, mean=mean, explained_variance=explained)


def transform(X: np.ndarray, fitted: FittedPca) -> np.ndarray:
    """Project X (N, 2048) → (N, 32) using the loaded PCA."""
    if X.ndim != 2 or X.shape[1] != PCA_N_FEATURES:
        raise ValueError(f"X must be 2-D with {PCA_N_FEATURES} columns; got shape {X.shape}")
    centered = X.astype("float64", copy=False) - fitted.mean
    # numpy stubs return Any from `@` (matmul); narrow back to ndarray.
    result: np.ndarray = centered @ fitted.components.T
    return result
