"""eln_reaction extractor — ELN canonical reactions as KG facts.

Phase 2. query_eln_canonical_reactions returns the OFAT-collapsed reaction
catalog from the local mock ELN. Each canonical reaction is a measured
result in the lab notebook.

Facts emitted per reaction (first 5 only to limit volume):
  - (Compound, has_eln_yield_pct, yield_pct)         [if present]
  - (Compound, has_eln_temperature_c, temperature_c)  [if present in conditions]
  - (Compound, has_eln_ofat_count, ofat_count)

derivation_class = COMPUTED. Confidence: 0.92 (curated lab notebook data).
"""
from __future__ import annotations

import logging
from typing import Any

from services.projectors.fact_extractor._common import confidence_tier
from services.projectors.tool_result_extractor.main import ExtractionContext, FactDraft

log = logging.getLogger(__name__)
_CONFIDENCE = 0.92
_MAX_REACTIONS = 5


def extract(result: dict[str, Any], ctx: ExtractionContext) -> list[FactDraft]:
    try:
        return _extract(result, ctx)
    except Exception as exc:  # noqa: BLE001
        log.debug("eln_reaction extractor swallowed error: %s", exc)
        return []


def _extract(result: dict[str, Any], ctx: ExtractionContext) -> list[FactDraft]:
    items = result.get("items")
    if not isinstance(items, list) or not items:
        return []

    tier = confidence_tier(_CONFIDENCE)
    facts: list[FactDraft] = []

    for rxn in items[:_MAX_REACTIONS]:
        if not isinstance(rxn, dict):
            continue
        smiles = rxn.get("smiles")
        if not isinstance(smiles, str) or not smiles:
            continue

        common = {"tool": "eln_reaction.query_eln_canonical_reactions", "smiles": smiles}

        yp = rxn.get("yield_pct")
        if isinstance(yp, (int, float)):
            facts.append(FactDraft(
                subject_label="Compound",
                subject_id_value=smiles,
                predicate="has_eln_yield_pct",
                object_value={"value": float(yp), **common},
                unit="%",
                derivation_class="COMPUTED",
                confidence=_CONFIDENCE,
                confidence_tier=tier,
                extractor_name="eln_reaction.query_eln_canonical_reactions",
            ))

        conditions = rxn.get("conditions") or {}
        temp = conditions.get("temperature_c") if isinstance(conditions, dict) else None
        if isinstance(temp, (int, float)):
            facts.append(FactDraft(
                subject_label="Compound",
                subject_id_value=smiles,
                predicate="has_eln_temperature_c",
                object_value={"value": float(temp), **common},
                unit="°C",
                derivation_class="COMPUTED",
                confidence=_CONFIDENCE,
                confidence_tier=tier,
                extractor_name="eln_reaction.query_eln_canonical_reactions",
            ))

        ofat = rxn.get("ofat_count")
        if isinstance(ofat, int):
            facts.append(FactDraft(
                subject_label="Compound",
                subject_id_value=smiles,
                predicate="has_eln_ofat_count",
                object_value={"value": ofat, **common},
                derivation_class="COMPUTED",
                confidence=_CONFIDENCE,
                confidence_tier=tier,
                extractor_name="eln_reaction.query_eln_canonical_reactions",
            ))

    return facts
