"""eln_sample extractor — ELN sample purity as KG facts.

Phase 2. query_eln_samples_by_entry returns analytical purity measurements
from the mock ELN. Purity is a high-confidence analytical measurement.

Facts per sample (first 5):
  - (Compound, has_eln_purity_pct, purity_pct)

derivation_class = COMPUTED. Confidence: 0.92.
"""
from __future__ import annotations

import logging
from typing import Any

from services.projectors.fact_extractor._common import confidence_tier
from services.projectors.tool_result_extractor.main import ExtractionContext, FactDraft

log = logging.getLogger(__name__)
_CONFIDENCE = 0.92
_MAX_SAMPLES = 5


def extract(result: dict[str, Any], ctx: ExtractionContext) -> list[FactDraft]:
    try:
        return _extract(result, ctx)
    except Exception as exc:  # noqa: BLE001
        log.debug("eln_sample extractor swallowed error: %s", exc)
        return []


def _extract(result: dict[str, Any], ctx: ExtractionContext) -> list[FactDraft]:
    samples = result.get("samples")
    if not isinstance(samples, list) or not samples:
        return []

    tier = confidence_tier(_CONFIDENCE)
    facts: list[FactDraft] = []

    for sample in samples[:_MAX_SAMPLES]:
        if not isinstance(sample, dict):
            continue
        compound_id = sample.get("inchikey") or sample.get("smiles")
        if not compound_id:
            continue

        purity = sample.get("purity_pct")
        if isinstance(purity, (int, float)) and 0.0 <= purity <= 100.0:
            facts.append(FactDraft(
                subject_label="Compound",
                subject_id_value=str(compound_id),
                predicate="has_eln_purity_pct",
                object_value={
                    "value": float(purity),
                    "tool": "eln_sample.query_eln_samples_by_entry",
                    "sample_id": sample.get("sample_id"),
                },
                unit="%",
                derivation_class="COMPUTED",
                confidence=_CONFIDENCE,
                confidence_tier=tier,
                extractor_name="eln_sample.query_eln_samples_by_entry",
            ))

    return facts
