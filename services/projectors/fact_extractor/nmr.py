"""nmr extractor — NMR analytical dataset facts.

Phase 2. Handles LOGS-by-SciY NMR query results. NMR shift count is a
high-confidence structural characterisation measurement.

Facts per dataset (first 3):
  - (Compound, has_nmr_shift_count, shift_count)

derivation_class = COMPUTED. Confidence: 0.92.
"""
from __future__ import annotations

import logging
from typing import Any

from services.projectors.fact_extractor._common import confidence_tier, resolve_smiles
from services.projectors.tool_result_extractor.main import ExtractionContext, FactDraft

log = logging.getLogger(__name__)
_CONFIDENCE = 0.92
_MAX_DATASETS = 3


def extract(result: dict[str, Any], ctx: ExtractionContext) -> list[FactDraft]:
    try:
        return _extract(result, ctx)
    except Exception as exc:  # noqa: BLE001
        log.debug("nmr extractor swallowed error: %s", exc)
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
        common = {"tool": "nmr", "dataset_id": ds.get("dataset_id")}

        shift_count = ds.get("shift_count")
        if not isinstance(shift_count, int):
            shifts_ppm = ds.get("shifts_ppm")
            if isinstance(shifts_ppm, list):
                shift_count = len(shifts_ppm)

        if isinstance(shift_count, int) and shift_count >= 0:
            facts.append(FactDraft(
                subject_label="Compound",
                subject_id_value=smiles,
                predicate="has_nmr_shift_count",
                object_value={"value": shift_count, **common},
                derivation_class="COMPUTED",
                confidence=_CONFIDENCE,
                confidence_tier=tier,
                extractor_name="nmr",
            ))

    return facts
