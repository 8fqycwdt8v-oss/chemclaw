"""Pure-function ensemble math tests."""
from __future__ import annotations

import math


def test_combine_zero_disagreement_keeps_chemprop_std():
    from services.mcp_tools.mcp_yield_baseline.ensemble import combine_ensemble
    out = combine_ensemble(chemprop_mean=50.0, chemprop_std=5.0, xgboost_mean=50.0)
    assert out["ensemble_mean"] == 50.0
    assert math.isclose(out["ensemble_std"], 5.0, abs_tol=1e-9)


def test_combine_simple_disagreement():
    """chemprop=50, std=5; xgboost=60. mean=55; std=sqrt(25+25)=sqrt(50)≈7.07"""
    from services.mcp_tools.mcp_yield_baseline.ensemble import combine_ensemble
    out = combine_ensemble(chemprop_mean=50.0, chemprop_std=5.0, xgboost_mean=60.0)
    assert out["ensemble_mean"] == 55.0
    assert math.isclose(out["ensemble_std"], math.sqrt(50.0), abs_tol=1e-9)


def test_combine_chemprop_std_zero_uses_disagreement_only():
    """When MVE head missing, std reduces to abs(diff)/2."""
    from services.mcp_tools.mcp_yield_baseline.ensemble import combine_ensemble
    out = combine_ensemble(chemprop_mean=40.0, chemprop_std=0.0, xgboost_mean=80.0)
    assert out["ensemble_mean"] == 60.0
    assert math.isclose(out["ensemble_std"], 20.0, abs_tol=1e-9)


def test_combine_negative_disagreement_treated_symmetrically():
    """abs disagreement: chemprop=80, xgboost=60 produces same std as 60/80."""
    from services.mcp_tools.mcp_yield_baseline.ensemble import combine_ensemble
    a = combine_ensemble(chemprop_mean=80.0, chemprop_std=5.0, xgboost_mean=60.0)
    b = combine_ensemble(chemprop_mean=60.0, chemprop_std=5.0, xgboost_mean=80.0)
    assert math.isclose(a["ensemble_std"], b["ensemble_std"], abs_tol=1e-9)


def test_combine_clips_mean_to_yield_range():
    """ensemble_mean clipped to [0, 100] for yield-percentage sanity."""
    from services.mcp_tools.mcp_yield_baseline.ensemble import combine_ensemble
    over = combine_ensemble(chemprop_mean=110.0, chemprop_std=5.0, xgboost_mean=110.0)
    assert over["ensemble_mean"] == 100.0
    under = combine_ensemble(chemprop_mean=-10.0, chemprop_std=5.0, xgboost_mean=-10.0)
    assert under["ensemble_mean"] == 0.0


def test_combine_components_in_response():
    from services.mcp_tools.mcp_yield_baseline.ensemble import combine_ensemble
    out = combine_ensemble(chemprop_mean=50.0, chemprop_std=5.0, xgboost_mean=60.0)
    assert out["components"] == {
        "chemprop_mean": 50.0,
        "chemprop_std": 5.0,
        "xgboost_mean": 60.0,
    }


def test_combine_negative_chemprop_std_rejected():
    import pytest
    from services.mcp_tools.mcp_yield_baseline.ensemble import combine_ensemble
    with pytest.raises(ValueError, match="chemprop_std"):
        combine_ensemble(chemprop_mean=50.0, chemprop_std=-1.0, xgboost_mean=60.0)


def test_combine_batch_maps_per_row():
    from services.mcp_tools.mcp_yield_baseline.ensemble import combine_batch
    rows = combine_batch(
        chemprop_means=[50.0, 80.0],
        chemprop_stds=[5.0, 3.0],
        xgboost_means=[60.0, 80.0],
    )
    assert len(rows) == 2
    assert rows[0]["ensemble_mean"] == 55.0
    assert rows[1]["ensemble_mean"] == 80.0
    assert math.isclose(rows[1]["ensemble_std"], 3.0, abs_tol=1e-9)
