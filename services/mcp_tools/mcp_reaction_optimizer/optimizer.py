"""Pure-function BoFire optimizer helpers.

Re-fits a Strategy from {Domain JSON, prior measured outcomes} on every call
and asks for the next batch of recommendations. No persistent surrogate;
canonical state is in optimization_rounds.measured_outcomes.

Single-objective via SoboStrategy + qLogEI. Multi-objective (Z6) via
MoboStrategy + qNEHVI when the Domain has 2+ outputs. Pareto-front
extraction available via pareto_front() — pure non-dominated sorting on
measured outcomes.
"""
from __future__ import annotations

import logging
from typing import Any

import pandas as pd

log = logging.getLogger("mcp-reaction-optimizer.optimizer")

# Below this many measured rows, fall back to space-filling random sampling.
# GP fits are unstable below ~3-5 observations.
MIN_OBSERVATIONS_FOR_BO = 3


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


def recommend_next_batch(
    domain: Any,
    measured_outcomes: list[dict[str, Any]],
    n_candidates: int,
    seed: int = 42,
) -> list[dict[str, Any]]:
    """Fit a SoboStrategy and ask for n_candidates next-batch recommendations.

    Cold-start (< MIN_OBSERVATIONS_FOR_BO measured outcomes) → space-filling
    random samples from the Domain.
    """
    n_obs = len(measured_outcomes)
    cold = n_obs < MIN_OBSERVATIONS_FOR_BO

    if cold:
        df = domain.inputs.sample(n=n_candidates, seed=seed)
        return _df_rows_to_proposals(df, source="random_cold_start")

    # Single- vs multi-objective routing — count Domain outputs.
    try:
        n_outputs = len(domain.outputs.features) if hasattr(domain, "outputs") else 1
    except (TypeError, AttributeError):
        n_outputs = 1
    multi_objective = n_outputs >= 2

    try:
        from bofire.data_models.acquisition_functions.api import qLogEI, qNEHVI
        from bofire.data_models.strategies.api import MoboStrategy, SoboStrategy
        from bofire.strategies.api import strategy_map
    except ImportError:
        df = domain.inputs.sample(n=n_candidates, seed=seed)
        return _df_rows_to_proposals(df, source="random_fallback")

    if multi_objective:
        try:
            strategy_dm = MoboStrategy(domain=domain, acquisition_function=qNEHVI(), seed=seed)
        except Exception as exc:  # noqa: BLE001
            log.warning("MoboStrategy build failed (%s); falling back", exc)
            df = domain.inputs.sample(n=n_candidates, seed=seed)
            return _df_rows_to_proposals(df, source="random_mobo_build_failed")
        source_label = "qNEHVI"
    else:
        strategy_dm = SoboStrategy(domain=domain, acquisition_function=qLogEI(), seed=seed)
        source_label = "qLogEI"

    try:
        strategy = strategy_map(strategy_dm)
    except Exception as exc:  # noqa: BLE001
        log.warning("strategy_map failed (%s); falling back", exc)
        df = domain.inputs.sample(n=n_candidates, seed=seed)
        return _df_rows_to_proposals(df, source="random_strategy_failed")

    measured_df = measured_to_dataframe(domain, measured_outcomes)
    try:
        strategy.tell(measured_df)
    except Exception as exc:  # noqa: BLE001
        log.warning("strategy.tell failed (%s); falling back", exc)
        df = domain.inputs.sample(n=n_candidates, seed=seed)
        return _df_rows_to_proposals(df, source="random_tell_failed")

    try:
        candidates = strategy.ask(candidate_count=n_candidates)
    except Exception as exc:  # noqa: BLE001
        log.warning("strategy.ask failed (%s); falling back", exc)
        df = domain.inputs.sample(n=n_candidates, seed=seed)
        return _df_rows_to_proposals(df, source="random_ask_failed")

    return _df_rows_to_proposals(candidates, source=source_label)


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
