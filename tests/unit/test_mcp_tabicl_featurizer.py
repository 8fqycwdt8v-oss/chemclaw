"""Unit tests for the mcp-tabicl reaction featurizer."""
from __future__ import annotations

from pathlib import Path

import numpy as np

from services.mcp_tools.mcp_tabicl.featurizer import (
    FeatureSchema,
    ReactionRow,
    featurize,
)
from services.mcp_tools.mcp_tabicl.pca import (
    PCA_N_COMPONENTS,
    PCA_N_FEATURES,
    fit_and_save,
    load,
)


def _sample_pca(tmp_path: Path):
    rng = np.random.default_rng(0)
    X = rng.integers(0, 2, size=(PCA_N_COMPONENTS + 10, PCA_N_FEATURES)).astype("float64")
    p = tmp_path / "drfp_pca.json"
    fit_and_save(X, p)
    return load(p)


def test_featurize_happy_path(tmp_path: Path) -> None:
    fitted = _sample_pca(tmp_path)
    rows = [
        ReactionRow(
            reaction_id="00000000-0000-0000-0000-000000000001",
            rxn_smiles="BrC1=CC=CC=C1.OB(O)C1=CC=CC=C1>>C1=CC=C(C=C1)C2=CC=CC=C2",
            rxno_class="3.1.1",
            solvent="toluene",
            temp_c=80.0,
            time_min=1440.0,
            catalyst_loading_mol_pct=2.0,
            base="K2CO3",
            yield_pct=88.0,
        )
    ]
    schema, X, y, skipped = featurize(rows, fitted, include_targets=True)
    assert isinstance(schema, FeatureSchema)
    assert X.shape == (1, len(schema.feature_names))
    assert y is not None and y.shape == (1,)
    # All 32 PCA columns must be present.
    assert sum(1 for f in schema.feature_names if f.startswith("drfp_pc_")) == PCA_N_COMPONENTS
    assert skipped == []


def test_featurize_skips_invalid_smiles(tmp_path: Path) -> None:
    fitted = _sample_pca(tmp_path)
    rows = [
        ReactionRow(
            reaction_id="aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa",
            rxn_smiles="not a smiles",
            rxno_class=None, solvent=None, temp_c=None, time_min=None,
            catalyst_loading_mol_pct=None, base=None, yield_pct=None,
        )
    ]
    _, X, _y, skipped = featurize(rows, fitted, include_targets=False)
    assert X.shape[0] == 0
    assert len(skipped) == 1
    assert skipped[0]["reaction_id"].startswith("aaaaaaaa")


def test_featurize_row_cap(tmp_path: Path) -> None:
    fitted = _sample_pca(tmp_path)
    rows = [
        ReactionRow(
            reaction_id=str(i),
            rxn_smiles="CC>>CC",
            rxno_class=None, solvent=None, temp_c=None, time_min=None,
            catalyst_loading_mol_pct=None, base=None, yield_pct=None,
        )
        for i in range(1001)
    ]
    import pytest
    with pytest.raises(ValueError, match="row cap"):
        featurize(rows, fitted, include_targets=False)
