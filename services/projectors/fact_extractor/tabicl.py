"""tabicl extractor — turns mcp-tabicl (TabPFN-based) prediction responses
into per-reaction / per-compound KG facts.

Phase 1.2 wave-2. Two response shapes the agent wraps through
`statistical_analyze` (the TabICL builtin):

  predict_yield_for_similar → {
    task: "regression",
    support_size: int,
    predictions: [{ query_reaction_id, predicted_yield_pct, std }],
    caveats: [str],
  }

  rank_feature_importance → {
    task: "regression",
    support_size: int,
    feature_importance: [{ feature, importance }],
    caveats: [str],
  }

  compare_conditions → {
    task: "regression",
    condition_comparison: [{ bucket_label, n, mean_yield, ... }],
  }

We extract from `predictions` only. Feature-importance is a tool-output for
the user to read, not a per-entity fact we'd want in the KG; condition
comparison is a pure-SQL aggregation (no ML) and is already retrievable from
the canonical reactions table.

Subject anchoring: each prediction's `query_reaction_id` is a UUID
referencing `reactions.id`. That's the canonical subject; the SMILES would
have to be reconciled downstream by a Reaction-resolution projector.

Facts emitted per prediction:
  - (Reaction, has_tabicl_predicted_yield_pct, predicted_yield_pct)
    with std + caveats in object_value.

Confidence base: 0.75 — TabPFN is a strong in-context learner but newer
than chemprop's calibrated ensemble. Per-prediction std down-modulates:
relative std > 0.5 → 0.50 (low tier); 0.3..0.5 → 0.65 (medium); else
0.75 (medium). Mirrors the chemprop pattern so the investigation scorer
treats both ML predictors consistently.
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

_CONFIDENCE_BASE = 0.75


def _confidence_for(value: float, std: float) -> float:
    """High std relative to mean drags confidence down. Mirrors chemprop."""
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
    try:
        return _extract(result, ctx)
    except Exception as exc:  # noqa: BLE001 — extractor must not raise
        log.debug("tabicl extractor swallowed error: %s", exc)
        return []


def _extract(result: dict[str, Any], ctx: ExtractionContext) -> list[FactDraft]:
    predictions = result.get("predictions")
    if not isinstance(predictions, list) or not predictions:
        return []

    facts: list[FactDraft] = []
    caveats = result.get("caveats") if isinstance(result.get("caveats"), list) else []
    support_size = result.get("support_size")

    for p in predictions:
        if not isinstance(p, dict):
            continue
        rxn_id = p.get("query_reaction_id")
        y = p.get("predicted_yield_pct")
        std = p.get("std", 0.0)
        if not isinstance(rxn_id, str) or not rxn_id:
            continue
        if not isinstance(y, (int, float)):
            continue
        conf = _confidence_for(
            float(y), float(std) if isinstance(std, (int, float)) else 0.0
        )
        facts.append(
            FactDraft(
                subject_label="Reaction",
                subject_id_value=rxn_id,
                predicate="has_tabicl_predicted_yield_pct",
                object_value={
                    "value": float(y),
                    "std": float(std) if isinstance(std, (int, float)) else None,
                    "support_size": (
                        support_size if isinstance(support_size, int) else None
                    ),
                    "caveats": caveats,
                    "tool": "tabicl.predict_yield_for_similar",
                },
                unit="%",
                derivation_class="COMPUTED",
                confidence=conf,
                confidence_tier=confidence_tier(conf),
                extractor_name="tabicl.predict_yield_for_similar",
            )
        )
    return facts
