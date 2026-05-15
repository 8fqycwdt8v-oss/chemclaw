"""aizynth extractor — surfaces retrosynthesis search outcomes as KG facts.

Phase 1.2. The propose_retrosynthesis builtin wraps ASKCOS (primary) and
AiZynthFinder (fallback). The builtin output has:
  - source: "askcos" | "aizynth"
  - routes_askcos: list[AskcosRoute]   — each has total_score, steps, depth
  - routes_aizynth: list[AiZynthRoute] — each has score, in_stock_ratio, tree

Facts emitted per retrosynthesis invocation (when routes are present):
  - (Compound, has_retrosynthesis_route_count, len(routes))
  - (Compound, has_top_retrosynthesis_score, best score)     [both sources]
  - (Compound, has_top_in_stock_ratio, best ratio)           [aizynth only]

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
    source = result.get("source")

    if source == "aizynth":
        routes = result.get("routes_aizynth") or []
        score_key = "score"
    elif source == "askcos":
        routes = result.get("routes_askcos") or []
        score_key = "total_score"
    else:
        # Defensive fallback: try aizynth first, then askcos.
        aizynth_routes = result.get("routes_aizynth") or []
        if aizynth_routes:
            routes, score_key = aizynth_routes, "score"
        else:
            routes, score_key = result.get("routes_askcos") or [], "total_score"

    if not isinstance(routes, list) or not routes:
        return []

    smiles = resolve_smiles(result, ctx.args)
    if smiles is None:
        return []

    # Collect numeric score / ratio defensively — skip malformed entries.
    valid_scores: list[float] = []
    valid_ratios: list[float] = []
    for r in routes:
        if not isinstance(r, dict):
            continue
        s = r.get(score_key)
        if isinstance(s, (int, float)):
            valid_scores.append(float(s))
        # in_stock_ratio only present on AiZynth routes.
        ratio = r.get("in_stock_ratio")
        if isinstance(ratio, (int, float)):
            valid_ratios.append(float(ratio))

    tier = confidence_tier(_CONFIDENCE)
    common = {
        "tool": "aizynth.retrosynthesis",
        "route_count": len(routes),
        "source": source,
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
