"""hplc extractor — HPLC analytical dataset facts.

Phase 2. Handles LOGS-by-SciY HPLC query results. HPLC purity is a
high-confidence analytical measurement from the chromatography data system.

Facts per dataset (first 3):
  - (Compound, has_hplc_purity_pct, purity_pct)
  - (Compound, has_hplc_peak_count, peak_count)
  - (Compound, has_hplc_main_peak_rt_min, main_peak_rt_min)

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
        log.debug("hplc extractor swallowed error: %s", exc)
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
        common = {"tool": "hplc", "dataset_id": ds.get("dataset_id")}

        purity = ds.get("purity_pct")
        if isinstance(purity, (int, float)):
            facts.append(FactDraft(
                subject_label="Compound",
                subject_id_value=smiles,
                predicate="has_hplc_purity_pct",
                object_value={"value": float(purity), **common},
                unit="%",
                derivation_class="COMPUTED",
                confidence=_CONFIDENCE,
                confidence_tier=tier,
                extractor_name="hplc",
            ))

        peaks = ds.get("peak_count")
        if isinstance(peaks, int):
            facts.append(FactDraft(
                subject_label="Compound",
                subject_id_value=smiles,
                predicate="has_hplc_peak_count",
                object_value={"value": peaks, **common},
                derivation_class="COMPUTED",
                confidence=_CONFIDENCE,
                confidence_tier=tier,
                extractor_name="hplc",
            ))

        rt = ds.get("main_peak_rt_min")
        if isinstance(rt, (int, float)):
            facts.append(FactDraft(
                subject_label="Compound",
                subject_id_value=smiles,
                predicate="has_hplc_main_peak_rt_min",
                object_value={"value": float(rt), **common},
                unit="min",
                derivation_class="COMPUTED",
                confidence=_CONFIDENCE,
                confidence_tier=tier,
                extractor_name="hplc",
            ))

    return facts
