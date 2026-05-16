"""ms extractor — MS analytical dataset facts.

Phase 2. Handles LOGS-by-SciY MS query results. Precursor m/z and peak
count are high-confidence mass spectrometry measurements.

Facts per dataset (first 3):
  - (Compound, has_ms_precursor_mz, precursor_mz)
  - (Compound, has_ms_peak_count, peak_count)

derivation_class = COMPUTED. Confidence: 0.90.
"""
from __future__ import annotations

import logging
from typing import Any

from services.projectors.fact_extractor._common import confidence_tier, resolve_smiles
from services.projectors.tool_result_extractor.main import ExtractionContext, FactDraft

log = logging.getLogger(__name__)
_CONFIDENCE = 0.90
_MAX_DATASETS = 3


def extract(result: dict[str, Any], ctx: ExtractionContext) -> list[FactDraft]:
    try:
        return _extract(result, ctx)
    except Exception as exc:  # noqa: BLE001
        log.debug("ms extractor swallowed error: %s", exc)
        return []


def _extract(result: dict[str, Any], ctx: ExtractionContext) -> list[FactDraft]:
    datasets = result.get("datasets")
    if not isinstance(datasets, list) or not datasets:
        return []

    tier = confidence_tier(_CONFIDENCE)
    facts: list[FactDraft] = []

    for ds in datasets[:_MAX_DATASETS]:
        if not isinstance(ds, dict):
            continue
        smiles = ds.get("compound_smiles") or resolve_smiles(result, ctx.args)
        if not smiles:
            continue
        common = {"tool": "ms", "dataset_id": ds.get("dataset_id")}

        precursor_mz = ds.get("precursor_mz")
        if isinstance(precursor_mz, (int, float)) and precursor_mz > 0:
            facts.append(FactDraft(
                subject_label="Compound",
                subject_id_value=smiles,
                predicate="has_ms_precursor_mz",
                object_value={"value": float(precursor_mz), **common},
                unit="m/z",
                derivation_class="COMPUTED",
                confidence=_CONFIDENCE,
                confidence_tier=tier,
                extractor_name="ms",
            ))

        peak_count = ds.get("peak_count")
        if isinstance(peak_count, int) and peak_count >= 0:
            facts.append(FactDraft(
                subject_label="Compound",
                subject_id_value=smiles,
                predicate="has_ms_peak_count",
                object_value={"value": peak_count, **common},
                derivation_class="COMPUTED",
                confidence=_CONFIDENCE,
                confidence_tier=tier,
                extractor_name="ms",
            ))

    return facts
