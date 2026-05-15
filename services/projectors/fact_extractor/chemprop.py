"""chemprop extractor — turns chemprop predict_yield / predict_property
responses into per-reaction / per-compound facts with calibrated std.

Phase 1.2. chemprop reports a mean + std per prediction — the std is the
single most useful signal for the (Phase 3+) anomaly detector + interpreter,
so we surface it as part of object_value.

Response shapes:
  PredictYieldOut    = {predictions: [{rxn_smiles, predicted_yield, std, model_id}]}
  PredictPropertyOut = {predictions: [{smiles, value, std}]}

Predicate naming is property-aware: logP → has_predicted_logP, logS →
has_predicted_logS, etc. Reaction yield gets has_predicted_yield_pct.

Confidence base: 0.80 for chemprop (calibrated ensemble). Per-prediction
std down-modulates: if std/value > 0.3 we drop tier to "medium" (0.65)
so the investigation scorer can route the most uncertain ones first.
"""
from __future__ import annotations

import logging
from typing import Any

from services.projectors.fact_extractor._common import confidence_tier
from services.projectors.tool_result_extractor.main import (
    ExtractionContext,
    FactDraft,
)

log = logging.getLogger(__name__)

_CONFIDENCE_BASE = 0.80


def _confidence_for(value: float, std: float) -> float:
    """High std relative to mean drags confidence down."""
    if not isinstance(value, (int, float)) or not isinstance(std, (int, float)):
        return _CONFIDENCE_BASE
    if value == 0:
        return _CONFIDENCE_BASE
    rel = abs(std / value)
    if rel > 0.5:
        return 0.50
    if rel > 0.3:
        return 0.65
    return _CONFIDENCE_BASE


def extract(result: dict[str, Any], ctx: ExtractionContext) -> list[FactDraft]:
    """Entry point. Dispatches on response shape:
    - predict_yield response has {rxn_smiles, predicted_yield} per prediction
    - predict_property response has {smiles, value} per prediction
    """
    try:
        predictions = result.get("predictions")
        if not isinstance(predictions, list) or not predictions:
            return []
        # Sniff first non-trivial entry to decide which extractor branch.
        sample = next((p for p in predictions if isinstance(p, dict)), None)
        if sample is None:
            return []
        if "rxn_smiles" in sample and "predicted_yield" in sample:
            return _extract_yield(predictions, ctx)
        if "smiles" in sample and "value" in sample:
            return _extract_property(predictions, ctx)
        return []
    except Exception as exc:  # noqa: BLE001
        log.debug("chemprop extractor swallowed error: %s", exc)
        return []


def _extract_yield(
    predictions: list[Any], ctx: ExtractionContext
) -> list[FactDraft]:
    facts: list[FactDraft] = []
    for p in predictions:
        if not isinstance(p, dict):
            continue
        rxn = p.get("rxn_smiles")
        y = p.get("predicted_yield")
        std = p.get("std", 0.0)
        if not isinstance(rxn, str) or not isinstance(y, (int, float)):
            continue
        conf = _confidence_for(float(y), float(std) if isinstance(std, (int, float)) else 0.0)
        facts.append(
            FactDraft(
                subject_label="Reaction",
                subject_id_value=rxn,
                predicate="has_predicted_yield_pct",
                object_value={
                    "value": float(y),
                    "std": float(std) if isinstance(std, (int, float)) else None,
                    "model_id": p.get("model_id"),
                    "tool": "chemprop.predict_yield",
                },
                unit="%",
                derivation_class="COMPUTED",
                confidence=conf,
                confidence_tier=confidence_tier(conf),
                extractor_name="chemprop.predict_yield",
            )
        )
    return facts


def _property_predicate(prop: str | None) -> str:
    if not isinstance(prop, str) or not prop:
        return "has_predicted_property_value"
    return f"has_predicted_{prop}"


def _extract_property(
    predictions: list[Any], ctx: ExtractionContext
) -> list[FactDraft]:
    facts: list[FactDraft] = []
    prop = ctx.args.get("property") if isinstance(ctx.args, dict) else None
    predicate = _property_predicate(prop if isinstance(prop, str) else None)
    for p in predictions:
        if not isinstance(p, dict):
            continue
        smi = p.get("smiles")
        v = p.get("value")
        std = p.get("std", 0.0)
        if not isinstance(smi, str) or not isinstance(v, (int, float)):
            continue
        conf = _confidence_for(float(v), float(std) if isinstance(std, (int, float)) else 0.0)
        facts.append(
            FactDraft(
                subject_label="Compound",
                subject_id_value=smi,
                predicate=predicate,
                object_value={
                    "value": float(v),
                    "std": float(std) if isinstance(std, (int, float)) else None,
                    "property": prop,
                    "tool": "chemprop.predict_property",
                },
                derivation_class="COMPUTED",
                confidence=conf,
                confidence_tier=confidence_tier(conf),
                extractor_name="chemprop.predict_property",
            )
        )
    return facts
