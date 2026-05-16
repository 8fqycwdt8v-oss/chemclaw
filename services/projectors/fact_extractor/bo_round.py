"""bo_round extractor — Bayesian optimisation round facts.

Phase 1 wave 3. Handles two builtins:
  - recommend_next_batch    → suggestion count + round index
  - ingest_campaign_results → observed yield mean + round index

Subject is the campaign (OptimizationCampaign), not a compound.
Both builtins are discriminated by response-shape key presence.
"""
from __future__ import annotations

import logging
from typing import Any

from services.projectors.fact_extractor._common import confidence_tier
from services.projectors.tool_result_extractor.main import ExtractionContext, FactDraft

log = logging.getLogger(__name__)


def extract(result: dict[str, Any], ctx: ExtractionContext) -> list[FactDraft]:
    try:
        return _extract(result, ctx)
    except Exception as exc:  # noqa: BLE001
        log.debug("bo_round extractor swallowed error: %s", exc)
        return []


def _extract(result: dict[str, Any], ctx: ExtractionContext) -> list[FactDraft]:
    campaign_id = str(
        result.get("campaign_id") or ctx.args.get("campaign_id") or "unknown"
    )
    round_index = result.get("round_index")
    facts: list[FactDraft] = []

    # recommend_next_batch path — presence of "suggestions" key discriminates.
    suggestions = result.get("suggestions")
    if isinstance(suggestions, list):
        conf = 0.80
        tier = confidence_tier(conf)
        common = {"tool": "bo_round.recommend_next_batch", "campaign_id": campaign_id}
        facts.append(
            FactDraft(
                subject_label="OptimizationCampaign",
                subject_id_value=campaign_id,
                predicate="has_bo_suggestion_count",
                object_value={"value": len(suggestions), **common},
                derivation_class="COMPUTED",
                confidence=conf,
                confidence_tier=tier,
                extractor_name="bo_round.recommend_next_batch",
            )
        )
        if isinstance(round_index, int):
            facts.append(
                FactDraft(
                    subject_label="OptimizationCampaign",
                    subject_id_value=campaign_id,
                    predicate="has_bo_round_index",
                    object_value={"value": round_index, **common},
                    derivation_class="COMPUTED",
                    confidence=conf,
                    confidence_tier=tier,
                    extractor_name="bo_round.recommend_next_batch",
                )
            )

    # ingest_campaign_results path — presence of "observations" key discriminates.
    observations = result.get("observations")
    if isinstance(observations, list) and observations:
        conf = 0.90
        tier = confidence_tier(conf)
        common = {"tool": "bo_round.ingest_campaign_results", "campaign_id": campaign_id}
        yields = [
            float(o["yield_fraction"])
            for o in observations
            if isinstance(o, dict) and isinstance(o.get("yield_fraction"), (int, float))
        ]
        if yields:
            mean_yield_pct = sum(yields) / len(yields) * 100
            facts.append(
                FactDraft(
                    subject_label="OptimizationCampaign",
                    subject_id_value=campaign_id,
                    predicate="has_bo_observed_yield_mean_pct",
                    object_value={"value": round(mean_yield_pct, 2), **common},
                    unit="%",
                    derivation_class="COMPUTED",
                    confidence=conf,
                    confidence_tier=tier,
                    extractor_name="bo_round.ingest_campaign_results",
                )
            )
        if isinstance(round_index, int):
            facts.append(
                FactDraft(
                    subject_label="OptimizationCampaign",
                    subject_id_value=campaign_id,
                    predicate="has_bo_round_index",
                    object_value={"value": round_index, **common},
                    derivation_class="COMPUTED",
                    confidence=conf,
                    confidence_tier=tier,
                    extractor_name="bo_round.ingest_campaign_results",
                )
            )

    return facts
