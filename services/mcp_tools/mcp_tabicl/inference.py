"""Thin wrapper around TabICL v2 for per-request fit-and-predict.

TabICL is a prior-fitted tabular foundation model: you hand it a
support set + targets and a query set; it returns predictions without
separate training. We expose two modes: regression (default) and
classification (when targets are integer class labels).

We also expose an optional permutation-based feature-importance pass
so the agent can ask "which columns matter?" without a second tool.
"""
from __future__ import annotations

from dataclasses import dataclass

import numpy as np

try:
    from tabicl import TabICLRegressor, TabICLClassifier  # type: ignore[import-untyped]
except ImportError:  # pragma: no cover — import error surfaces at /readyz
    TabICLRegressor = None  # type: ignore[assignment]
    TabICLClassifier = None  # type: ignore[assignment]


@dataclass(frozen=True)
class PredictResult:
    predictions: np.ndarray      # shape (n_query,)
    prediction_std: np.ndarray   # shape (n_query,); zero if model does not return std
    feature_importance: dict[str, float] | None


def _require_tabicl() -> None:
    if TabICLRegressor is None or TabICLClassifier is None:
        raise RuntimeError("tabicl is not installed; cannot run inference")


def predict_and_rank(
    *,
    support_rows: np.ndarray,            # (n_support, n_features), dtype=object
    support_targets: np.ndarray,         # (n_support,) floats or ints
    query_rows: np.ndarray,              # (n_query, n_features), dtype=object
    feature_names: list[str],
    categorical_names: frozenset[str],
    task: str,                           # "regression" | "classification"
    return_feature_importance: bool,
) -> PredictResult:
    _require_tabicl()
    if support_rows.shape[1] != query_rows.shape[1]:
        raise ValueError(
            f"support/query width mismatch: {support_rows.shape[1]} vs {query_rows.shape[1]}"
        )
    if task not in ("regression", "classification"):
        raise ValueError(f"task must be regression|classification; got {task!r}")

    cat_indices = [i for i, n in enumerate(feature_names) if n in categorical_names]

    if task == "regression":
        model = TabICLRegressor(categorical_features=cat_indices)
    else:
        model = TabICLClassifier(categorical_features=cat_indices)
    model.fit(support_rows, support_targets)

    preds = np.asarray(model.predict(query_rows))
    try:
        std = np.asarray(model.predict_std(query_rows))  # may not exist
    except (AttributeError, NotImplementedError):
        std = np.zeros_like(preds, dtype="float64")

    fi: dict[str, float] | None = None
    if return_feature_importance:
        fi = _permutation_importance(model, support_rows, support_targets, feature_names)

    return PredictResult(predictions=preds, prediction_std=std, feature_importance=fi)


def _permutation_importance(
    model, X: np.ndarray, y: np.ndarray, names: list[str],
) -> dict[str, float]:
    """Simple permutation FI over the support set (80/20 split)."""
    rng = np.random.default_rng(0)
    n = X.shape[0]
    n_val = max(1, n // 5)
    idx = rng.permutation(n)
    val_idx, train_idx = idx[:n_val], idx[n_val:]
    model.fit(X[train_idx], y[train_idx])
    base_err = _mse(model.predict(X[val_idx]), y[val_idx])

    out: dict[str, float] = {}
    for j, nm in enumerate(names):
        Xp = X[val_idx].copy()
        rng.shuffle(Xp[:, j])
        err = _mse(model.predict(Xp), y[val_idx])
        out[nm] = float(err - base_err)
    return out


def _mse(pred, y) -> float:
    pred = np.asarray(pred, dtype="float64")
    y = np.asarray(y, dtype="float64")
    return float(np.mean((pred - y) ** 2))
