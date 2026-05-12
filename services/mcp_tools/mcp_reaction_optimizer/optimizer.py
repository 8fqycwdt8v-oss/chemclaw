"""Pure-function BoFire optimizer helpers.

Re-fits a Strategy from {Domain JSON, prior measured outcomes} on every call
and asks for the next batch of recommendations. No persistent surrogate;
canonical state is in optimization_rounds.measured_outcomes.

Strategy + acquisition routing follows the request, with sensible fallbacks
for unsupported combinations:

  * Single-objective:   Sobo + qLogEI / qLogNEI
  * Multi-objective:    Mobo + qNEHVI / qEHVI
  * RandomStrategy:     skip GP altogether and space-fill the Domain.

Cold-start (< MIN_OBSERVATIONS_FOR_BO measured outcomes) → space-filling
random, regardless of the requested strategy. The (per-round) seed is
caller-provided so distinct campaigns don't all start with the same plate.
"""
from __future__ import annotations

import logging
from typing import Any

import pandas as pd

log = logging.getLogger("mcp-reaction-optimizer.optimizer")

# Default cold-start threshold. The actual value is read at the call site
# (TS builtin) from ConfigRegistry key `bo.min_observations_for_bo` and
# threaded through as `min_observations_for_bo` on the request, so per-org
# / per-project tuning is possible without changing this default.
MIN_OBSERVATIONS_FOR_BO = 3


# ---------------------------------------------------------------------------
# Helpers
# ---------------------------------------------------------------------------

def measured_to_dataframe(
    domain: Any,
    measured_outcomes: list[dict[str, Any]],
) -> pd.DataFrame:
    """Convert measured_outcomes list-of-dicts to BoFire's DataFrame contract.

    Each item is `{"factor_values": {<input_name>: value}, "outputs": {<output_name>: value}}`.
    """
    rows = []
    for item in measured_outcomes:
        factors = item.get("factor_values", {})
        outputs = item.get("outputs", {})
        rows.append({**factors, **outputs})
    return pd.DataFrame(rows)


def domain_input_keys(domain: Any) -> set[str]:
    """Return the set of input feature keys declared on a Domain.

    Tolerates BoFire schema variants (features attribute vs. .get()).
    Returns the empty set when the Domain has no inputs.
    """
    inputs = getattr(domain, "inputs", None)
    if inputs is None:
        return set()
    feats = getattr(inputs, "features", None) or []
    keys: set[str] = set()
    for f in feats:
        k = getattr(f, "key", None)
        if isinstance(k, str):
            keys.add(k)
    return keys


def domain_output_keys(domain: Any) -> set[str]:
    """Return the set of output feature keys declared on a Domain."""
    outputs = getattr(domain, "outputs", None)
    if outputs is None:
        return set()
    feats = getattr(outputs, "features", None) or []
    keys: set[str] = set()
    for f in feats:
        k = getattr(f, "key", None)
        if isinstance(k, str):
            keys.add(k)
    return keys


# Acquisitions valid for single- and multi-objective. The caller passes one
# from the campaign row; unsupported combos fall back with a fallback_reason
# so the agent can surface the mismatch instead of silently doing the wrong
# thing.
SINGLE_OBJ_ACQS = {"qLogEI", "qLogNEI"}
MULTI_OBJ_ACQS = {"qNEHVI", "qEHVI"}
ALL_BO_ACQS = SINGLE_OBJ_ACQS | MULTI_OBJ_ACQS


def recommend_next_batch(
    domain: Any,
    measured_outcomes: list[dict[str, Any]],
    n_candidates: int,
    seed: int = 42,
    *,
    strategy: str = "SoboStrategy",
    acquisition: str = "qLogEI",
    min_observations_for_bo: int = MIN_OBSERVATIONS_FOR_BO,
) -> tuple[list[dict[str, Any]], str | None]:
    """Fit the requested Strategy and ask for n_candidates next-batch recommendations.

    Returns ``(proposals, fallback_reason)``. ``fallback_reason`` is None when
    the configured BO path was used; otherwise a short string identifying why
    the loop degraded (cold start, RandomStrategy, BoFire missing, fit
    failure, …). Callers MUST surface this so silent degradation is visible.
    """
    n_obs = len(measured_outcomes)
    cold = n_obs < max(1, int(min_observations_for_bo))

    # Determine objective dimensionality up-front so we can pick the right
    # default acquisition when the caller passed one that is incompatible
    # with the Domain.
    try:
        n_outputs = len(domain.outputs.features) if hasattr(domain, "outputs") else 1
    except (TypeError, AttributeError):
        n_outputs = 1
    multi_objective = n_outputs >= 2

    # RandomStrategy short-circuits the GP regardless of measured count.
    if strategy == "RandomStrategy":
        df = domain.inputs.sample(n=n_candidates, seed=seed)
        return _df_rows_to_proposals(df, source="random_strategy"), "random_strategy"

    if cold:
        df = domain.inputs.sample(n=n_candidates, seed=seed)
        return _df_rows_to_proposals(df, source="random_cold_start"), (
            f"cold_start_n_obs={n_obs}<{int(min_observations_for_bo)}"
        )

    # Validate acquisition against the objective shape; coerce with a reason
    # rather than throwing, so the campaign doesn't dead-stop on a stale row.
    coerced_reason: str | None = None
    if multi_objective and acquisition not in MULTI_OBJ_ACQS:
        coerced_reason = (
            f"acquisition={acquisition!r} unsupported for {n_outputs}-objective campaign; "
            "coerced to qNEHVI."
        )
        acquisition = "qNEHVI"
    elif (not multi_objective) and acquisition not in SINGLE_OBJ_ACQS:
        coerced_reason = (
            f"acquisition={acquisition!r} unsupported for single-objective campaign; "
            "coerced to qLogEI."
        )
        acquisition = "qLogEI"

    try:
        from bofire.data_models.acquisition_functions.api import (
            qEHVI, qLogEI, qLogNEI, qNEHVI,
        )
        from bofire.data_models.strategies.api import MoboStrategy, SoboStrategy
        from bofire.strategies.api import strategy_map
    except ImportError:
        df = domain.inputs.sample(n=n_candidates, seed=seed)
        return _df_rows_to_proposals(df, source="random_fallback"), "bofire_import_failed"

    acq_ctors = {
        "qLogEI": qLogEI,
        "qLogNEI": qLogNEI,
        "qNEHVI": qNEHVI,
        "qEHVI": qEHVI,
    }
    acq_ctor = acq_ctors[acquisition]

    try:
        if multi_objective:
            strategy_dm = MoboStrategy(domain=domain, acquisition_function=acq_ctor(), seed=seed)
        else:
            strategy_dm = SoboStrategy(domain=domain, acquisition_function=acq_ctor(), seed=seed)
    except Exception as exc:  # noqa: BLE001
        log.warning("strategy build failed (%s); falling back", exc)
        df = domain.inputs.sample(n=n_candidates, seed=seed)
        return _df_rows_to_proposals(df, source="random_strategy_build_failed"), (
            f"strategy_build_failed: {exc}"
        )

    try:
        strategy_obj = strategy_map(strategy_dm)
    except Exception as exc:  # noqa: BLE001
        log.warning("strategy_map failed (%s); falling back", exc)
        df = domain.inputs.sample(n=n_candidates, seed=seed)
        return _df_rows_to_proposals(df, source="random_strategy_failed"), (
            f"strategy_map_failed: {exc}"
        )

    measured_df = measured_to_dataframe(domain, measured_outcomes)
    try:
        strategy_obj.tell(measured_df)
    except Exception as exc:  # noqa: BLE001
        log.warning("strategy.tell failed (%s); falling back", exc)
        df = domain.inputs.sample(n=n_candidates, seed=seed)
        return _df_rows_to_proposals(df, source="random_tell_failed"), (
            f"strategy_tell_failed: {exc}"
        )

    try:
        candidates = strategy_obj.ask(candidate_count=n_candidates)
    except Exception as exc:  # noqa: BLE001
        log.warning("strategy.ask failed (%s); falling back", exc)
        df = domain.inputs.sample(n=n_candidates, seed=seed)
        return _df_rows_to_proposals(df, source="random_ask_failed"), (
            f"strategy_ask_failed: {exc}"
        )

    return _df_rows_to_proposals(candidates, source=acquisition), coerced_reason


# ---------------------------------------------------------------------------
# Pareto-front extraction (Z6) — pure function, no BoFire required.
# ---------------------------------------------------------------------------

def pareto_front(
    measured_outcomes: list[dict[str, Any]],
    output_directions: dict[str, str],
) -> list[dict[str, Any]]:
    """Return the non-dominated subset of measured_outcomes.

    output_directions maps each output name to "maximize" or "minimize".
    A point p dominates q iff p is at least as good as q on every objective
    AND strictly better on at least one. Non-dominated points form the
    Pareto frontier.
    """
    if not measured_outcomes or not output_directions:
        return []
    points: list[tuple[list[float], dict[str, Any]]] = []
    for item in measured_outcomes:
        outputs = item.get("outputs") or {}
        scores: list[float] = []
        valid = True
        for name, direction in output_directions.items():
            val = outputs.get(name)
            if not isinstance(val, (int, float)):
                valid = False
                break
            scores.append(float(val) if direction == "maximize" else -float(val))
        if valid:
            points.append((scores, item))

    pareto: list[dict[str, Any]] = []
    for i, (scores_i, item_i) in enumerate(points):
        dominated = False
        for j, (scores_j, _) in enumerate(points):
            if i == j:
                continue
            ge_all = all(sj >= si for sj, si in zip(scores_j, scores_i))
            gt_any = any(sj > si for sj, si in zip(scores_j, scores_i))
            if ge_all and gt_any:
                dominated = True
                break
        if not dominated:
            pareto.append(item_i)
    return pareto


def _df_rows_to_proposals(df: pd.DataFrame, source: str) -> list[dict[str, Any]]:
    """Convert a BoFire candidate DataFrame to a JSON-friendly list of proposals."""
    out: list[dict[str, Any]] = []
    for _, row in df.iterrows():
        factor_values: dict[str, Any] = {}
        for col, val in row.items():
            # Skip BoFire metadata columns (acquisition value, predicted output, etc.)
            if isinstance(col, str) and col.endswith("_pred"):
                continue
            if isinstance(col, str) and col.endswith("_sd"):
                continue
            factor_values[str(col)] = _coerce_cell(val)
        out.append({"factor_values": factor_values, "source": source})
    return out


def _coerce_cell(val: Any) -> Any:
    try:
        import numpy as np  # noqa: PLC0415

        if isinstance(val, (np.floating, np.integer)):
            return float(val)
    except ImportError:
        pass
    return val
