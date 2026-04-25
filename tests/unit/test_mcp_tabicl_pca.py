"""Tests for mcp-tabicl DRFP PCA persistence.

PCA state is persisted as plain JSON — three float arrays
(`components_`, `mean_`, `explained_variance_`) plus `n_components` and
`n_features`. The loader reconstructs NumPy arrays without any
serialisation framework that could execute code on load.
"""
from __future__ import annotations

import json
from pathlib import Path

import numpy as np
import pytest

from services.mcp_tools.mcp_tabicl.pca import (
    PCA_N_COMPONENTS,
    PCA_N_FEATURES,
    fit_and_save,
    load,
    transform,
)


def test_fit_save_load_roundtrip(tmp_path: Path) -> None:
    rng = np.random.default_rng(42)
    # synthetic DRFP-like binary bits, 2048 features
    X = rng.integers(0, 2, size=(200, PCA_N_FEATURES)).astype("float64")
    out = tmp_path / "drfp_pca.json"

    fit_and_save(X, out)

    loaded = load(out)
    assert loaded.components.shape == (PCA_N_COMPONENTS, PCA_N_FEATURES)
    assert loaded.mean.shape == (PCA_N_FEATURES,)
    assert loaded.explained_variance.shape == (PCA_N_COMPONENTS,)

    # Transform produces consistent shape + finite values.
    y = transform(X[:5], loaded)
    assert y.shape == (5, PCA_N_COMPONENTS)
    assert np.isfinite(y).all()


def test_load_rejects_wrong_n_components(tmp_path: Path) -> None:
    bad = {
        "n_components": PCA_N_COMPONENTS + 1,
        "n_features": PCA_N_FEATURES,
        "components": [[0.0] * PCA_N_FEATURES] * (PCA_N_COMPONENTS + 1),
        "mean": [0.0] * PCA_N_FEATURES,
        "explained_variance": [1.0] * (PCA_N_COMPONENTS + 1),
    }
    p = tmp_path / "drfp_pca.json"
    p.write_text(json.dumps(bad))
    with pytest.raises(ValueError, match="n_components"):
        load(p)


def test_load_rejects_wrong_n_features(tmp_path: Path) -> None:
    bad = {
        "n_components": PCA_N_COMPONENTS,
        "n_features": 128,
        "components": [[0.0] * 128] * PCA_N_COMPONENTS,
        "mean": [0.0] * 128,
        "explained_variance": [1.0] * PCA_N_COMPONENTS,
    }
    p = tmp_path / "drfp_pca.json"
    p.write_text(json.dumps(bad))
    with pytest.raises(ValueError, match="n_features"):
        load(p)


def test_load_rejects_malformed_json(tmp_path: Path) -> None:
    p = tmp_path / "drfp_pca.json"
    p.write_text("not json")
    with pytest.raises(ValueError):
        load(p)
