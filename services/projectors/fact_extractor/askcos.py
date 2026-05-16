"""askcos extractor — forward condition predictions as KG facts.

Phase 1 wave 3. query_conditions builtin wraps the ASKCOS forward-synthesis
endpoint. The response carries a ranked list of predicted reaction conditions.

Facts emitted per invocation:
  - (Compound, has_forward_condition_count, len(conditions))
  - (Compound, has_top_condition_score, best score)  [if conditions present]

derivation_class = COMPUTED. Confidence: 0.75 (ML-based search heuristic).
"""
from __future__ import annotations

import logging
from typing import Any

from services.projectors.fact_extractor._common import confidence_tier, resolve_smiles
from services.projectors.tool_result_extractor.main import ExtractionContext, FactDraft

log = logging.getLogger(__name__)
_CONFIDENCE = 0.75


def extract(result: dict[str, Any], ctx: ExtractionContext) -> list[FactDraft]:
    try:
        return _extract(result, ctx)
    except Exception as exc:  # noqa: BLE001
        log.debug("askcos extractor swallowed error: %s", exc)
        return []


def _extract(result: dict[str, Any], ctx: ExtractionContext) -> list[FactDraft]:
    conditions = result.get("conditions")
    if not isinstance(conditions, list) or not conditions:
        return []

    smiles = resolve_smiles(result, ctx.args)
    if smiles is None:
        return []

    tier = confidence_tier(_CONFIDENCE)
    common = {"tool": "askcos.query_conditions", "condition_count": len(conditions)}

    facts: list[FactDraft] = [
        FactDraft(
            subject_label="Compound",
            subject_id_value=smiles,
            predicate="has_forward_condition_count",
            object_value={"value": len(conditions), **common},
            derivation_class="COMPUTED",
            confidence=_CONFIDENCE,
            confidence_tier=tier,
            extractor_name="askcos.query_conditions",
        )
    ]

    scores = [
        float(c["score"])
        for c in conditions
        if isinstance(c, dict) and isinstance(c.get("score"), (int, float))
    ]
    if scores:
        facts.append(
            FactDraft(
                subject_label="Compound",
                subject_id_value=smiles,
                predicate="has_top_condition_score",
                object_value={"value": max(scores), **common},
                derivation_class="COMPUTED",
                confidence=_CONFIDENCE,
                confidence_tier=tier,
                extractor_name="askcos.query_conditions",
            )
        )
    return facts
