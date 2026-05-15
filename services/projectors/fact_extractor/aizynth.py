"""aizynth extractor — surfaces retrosynthesis search outcomes as KG facts.

Phase 1.2. The aizynth /retrosynthesis endpoint returns `routes: list[RetroRoute]`
where each route has `score` (0..∞, higher is better) and `in_stock_ratio`
(0..1). We emit a small per-target rollup, not per-route — Phase 1+ doesn't
want a flood of route-level facts (would swamp the KG and break the wiki).

Facts emitted per retrosynthesis invocation (when routes are present):
  - (Compound, has_top_retrosynthesis_score, best_score)
  - (Compound, has_top_in_stock_ratio, best_ratio)
  - (Compound, has_retrosynthesis_route_count, len(routes))

derivation_class = COMPUTED (deterministic post-processing of typed output).
Confidence: 0.80 — retrosynthesis is heuristic search, lower than QM single
points (0.85) but higher than pure-LLM proposals (0.75).
"""
from __future__ import annotations

import logging
from typing import Any

from services.projectors.fact_extractor._common import confidence_tier, resolve_smiles
from services.projectors.tool_result_extractor.main import (
    ExtractionContext,
    FactDraft,
)

log = logging.getLogger(__name__)

_CONFIDENCE = 0.80


def extract(result: dict[str, Any], ctx: ExtractionContext) -> list[FactDraft]:
    """Entry point for the tool_result_extractor projector."""
    try:
        return _extract(result, ctx)
    except Exception as exc:  # noqa: BLE001 — extractor must not raise
        log.debug("aizynth extractor swallowed error: %s", exc)
        return []


def _extract(result: dict[str, Any], ctx: ExtractionContext) -> list[FactDraft]:
    routes = result.get("routes")
    if not isinstance(routes, list) or not routes:
        return []

    smiles = resolve_smiles(result, ctx.args)
    if smiles is None:
        return []

    # Filter to dict entries with a numeric score / ratio. Defensive
    # against partial / corrupted entries.
    valid_scores: list[float] = []
    valid_ratios: list[float] = []
    for r in routes:
        if not isinstance(r, dict):
            continue
        s = r.get("score")
        if isinstance(s, (int, float)):
            valid_scores.append(float(s))
        ratio = r.get("in_stock_ratio")
        if isinstance(ratio, (int, float)):
            valid_ratios.append(float(ratio))

    tier = confidence_tier(_CONFIDENCE)
    common = {
        "tool": "aizynth.retrosynthesis",
        "route_count": len(routes),
    }
    facts: list[FactDraft] = [
        FactDraft(
            subject_label="Compound",
            subject_id_value=smiles,
            predicate="has_retrosynthesis_route_count",
            object_value={"value": len(routes), **common},
            derivation_class="COMPUTED",
            confidence=_CONFIDENCE,
            confidence_tier=tier,
            extractor_name="aizynth.retrosynthesis",
        )
    ]
    if valid_scores:
        facts.append(
            FactDraft(
                subject_label="Compound",
                subject_id_value=smiles,
                predicate="has_top_retrosynthesis_score",
                object_value={"value": max(valid_scores), **common},
                derivation_class="COMPUTED",
                confidence=_CONFIDENCE,
                confidence_tier=tier,
                extractor_name="aizynth.retrosynthesis",
            )
        )
    if valid_ratios:
        facts.append(
            FactDraft(
                subject_label="Compound",
                subject_id_value=smiles,
                predicate="has_top_in_stock_ratio",
                object_value={"value": max(valid_ratios), **common},
                derivation_class="COMPUTED",
                confidence=_CONFIDENCE,
                confidence_tier=tier,
                extractor_name="aizynth.retrosynthesis",
            )
        )
    return facts
