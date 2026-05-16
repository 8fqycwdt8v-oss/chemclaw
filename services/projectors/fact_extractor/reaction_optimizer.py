"""reaction_optimizer extractor — optimization campaign lifecycle facts.

Phase 1 wave 3. Covers two builtins:
  - start_optimization_campaign → objective count at campaign start
  - extract_pareto_front        → Pareto front size + best yield

Subject: OptimizationCampaign (campaign_id from result or ctx.args).
"""
from __future__ import annotations

import logging
from typing import Any

from services.projectors.fact_extractor._common import confidence_tier
from services.projectors.tool_result_extractor.main import ExtractionContext, FactDraft

log = logging.getLogger(__name__)
_CONFIDENCE = 0.90


def extract(result: dict[str, Any], ctx: ExtractionContext) -> list[FactDraft]:
    try:
        return _extract(result, ctx)
    except Exception as exc:  # noqa: BLE001
        log.debug("reaction_optimizer extractor swallowed error: %s", exc)
        return []


def _extract(result: dict[str, Any], ctx: ExtractionContext) -> list[FactDraft]:
    campaign_id = str(
        result.get("campaign_id") or ctx.args.get("campaign_id") or "unknown"
    )
    tier = confidence_tier(_CONFIDENCE)
    common = {"tool": "reaction_optimizer", "campaign_id": campaign_id}
    facts: list[FactDraft] = []

    # start_optimization_campaign path — objective_count present.
    obj_count = result.get("objective_count")
    if isinstance(obj_count, int) and obj_count > 0:
        facts.append(
            FactDraft(
                subject_label="OptimizationCampaign",
                subject_id_value=campaign_id,
                predicate="has_optimization_objective_count",
                object_value={"value": obj_count, **common},
                derivation_class="COMPUTED",
                confidence=_CONFIDENCE,
                confidence_tier=tier,
                extractor_name="reaction_optimizer.start_optimization_campaign",
            )
        )

    # extract_pareto_front path — pareto_size present.
    pareto_size = result.get("pareto_size")
    if isinstance(pareto_size, int):
        facts.append(
            FactDraft(
                subject_label="OptimizationCampaign",
                subject_id_value=campaign_id,
                predicate="has_pareto_front_size",
                object_value={"value": pareto_size, **common},
                derivation_class="COMPUTED",
                confidence=_CONFIDENCE,
                confidence_tier=tier,
                extractor_name="reaction_optimizer.extract_pareto_front",
            )
        )

    best_yield = result.get("best_yield_pct")
    if isinstance(best_yield, (int, float)):
        facts.append(
            FactDraft(
                subject_label="OptimizationCampaign",
                subject_id_value=campaign_id,
                predicate="has_pareto_best_yield_pct",
                object_value={"value": float(best_yield), **common},
                unit="%",
                derivation_class="COMPUTED",
                confidence=_CONFIDENCE,
                confidence_tier=tier,
                extractor_name="reaction_optimizer.extract_pareto_front",
            )
        )
    return facts
