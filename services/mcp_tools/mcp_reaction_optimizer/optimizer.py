"""Pure-function BoFire optimizer helpers.

Re-fits a Strategy from {Domain JSON, prior measured outcomes} on every call
and asks for the next batch of recommendations. No persistent surrogate;
canonical state is in optimization_rounds.measured_outcomes.

Single-objective today (SoboStrategy + qLogEI). Z6 brings multi-objective.
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

    # Warm path: fit a SoboStrategy and ask.
    try:
        from bofire.data_models.acquisition_functions.api import qLogEI
        from bofire.data_models.strategies.api import SoboStrategy
        from bofire.strategies.api import strategy_map
        from bofire.strategies.api import SoboStrategy as SoboStrategyImpl
    except ImportError:
        # Fallback if bofire layout differs from expectations.
        df = domain.inputs.sample(n=n_candidates, seed=seed)
        return _df_rows_to_proposals(df, source="random_fallback")

    strategy_dm = SoboStrategy(domain=domain, acquisition_function=qLogEI(), seed=seed)
    try:
        strategy = SoboStrategyImpl(data_model=strategy_dm)
    except TypeError:
        # Older API: just pass the data model.
        strategy = strategy_map(strategy_dm)

    measured_df = measured_to_dataframe(domain, measured_outcomes)
    try:
        strategy.tell(measured_df)
    except Exception as exc:  # noqa: BLE001
        log.warning("strategy.tell failed (%s); falling back to space-filling", exc)
        df = domain.inputs.sample(n=n_candidates, seed=seed)
        return _df_rows_to_proposals(df, source="random_tell_failed")

    try:
        candidates = strategy.ask(candidate_count=n_candidates)
    except Exception as exc:  # noqa: BLE001
        log.warning("strategy.ask failed (%s); falling back to space-filling", exc)
        df = domain.inputs.sample(n=n_candidates, seed=seed)
        return _df_rows_to_proposals(df, source="random_ask_failed")

    return _df_rows_to_proposals(candidates, source="qLogEI")


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
