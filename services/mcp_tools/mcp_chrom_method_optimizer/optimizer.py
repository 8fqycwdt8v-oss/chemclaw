"""Pure-function BoFire optimizer for chromatography method optimization.

Mirrors services.mcp_tools.mcp_reaction_optimizer.optimizer one-for-one; the
chromatography-aware parts (gradient parameterization, column descriptors,
constraints, output objectives) live in domain_builder.py — this module is
agnostic and only dispatches BoFire on the Domain it is handed.

Re-fits a Strategy from {Domain JSON, prior measured outcomes} on every call
and asks for the next batch. No persistent surrogate; canonical state lives
in optimization_rounds.measured_outcomes.

Single-objective via SoboStrategy + qLogEI. Multi-objective via MoboStrategy
+ qNEHVI when the Domain has 2+ outputs.
"""
from __future__ import annotations

import logging
from typing import Any

import pandas as pd

log = logging.getLogger("mcp-chrom-method-optimizer.optimizer")

# Below this many measured rows we fall back to space-filling random sampling.
# Bumped from the reaction-optimizer's 3 to 5: chromatography measurements
# carry more nuisance variability per injection (peak detection, integration,
# tracking) and the GP needs a slightly larger anchor before it stops
# overfitting to noise.
MIN_OBSERVATIONS_FOR_BO = 5


def measured_to_dataframe(
    domain: Any,
    measured_outcomes: list[dict[str, Any]],
) -> pd.DataFrame:
    """Convert the list-of-dicts contract to BoFire's flat DataFrame shape."""
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
    """Fit a Strategy and ask for n_candidates next-batch recommendations.

    Cold-start (< MIN_OBSERVATIONS_FOR_BO measured outcomes) → space-filling
    random samples from the Domain (constraint-aware via domain.inputs.sample).
    """
    n_obs = len(measured_outcomes)
    cold = n_obs < MIN_OBSERVATIONS_FOR_BO

    if cold:
        df = domain.inputs.sample(n=n_candidates, seed=seed)
        return _df_rows_to_proposals(df, source="random_cold_start")

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


def _df_rows_to_proposals(df: pd.DataFrame, source: str) -> list[dict[str, Any]]:
    out: list[dict[str, Any]] = []
    for _, row in df.iterrows():
        factor_values: dict[str, Any] = {}
        for col, val in row.items():
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
