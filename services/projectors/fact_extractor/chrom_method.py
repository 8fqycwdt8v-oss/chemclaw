"""chrom_method extractor — chromatography method Pareto front as KG facts.

Phase 1 wave 3. optimize_chromatography_method produces a Pareto-optimal
set of gradient/temperature conditions for HPLC method development.

Facts emitted (campaign-level):
  - (NCEProject, has_chrom_pareto_front_size, len(pareto_front))
  - (NCEProject, has_chrom_best_resolution, best_resolution)

derivation_class = COMPUTED. Confidence: 0.85 (BO optimisation output).
"""
from __future__ import annotations

import logging
from typing import Any

from services.projectors.fact_extractor._common import confidence_tier
from services.projectors.tool_result_extractor.main import ExtractionContext, FactDraft

log = logging.getLogger(__name__)
_CONFIDENCE = 0.85


def extract(result: dict[str, Any], ctx: ExtractionContext) -> list[FactDraft]:
    try:
        return _extract(result, ctx)
    except Exception as exc:  # noqa: BLE001
        log.debug("chrom_method extractor swallowed error: %s", exc)
        return []


def _extract(result: dict[str, Any], ctx: ExtractionContext) -> list[FactDraft]:
    project_id = (
        ctx.args.get("project_internal_id")
        or result.get("project_internal_id")
        or "unknown"
    )
    tier = confidence_tier(_CONFIDENCE)
    common = {"tool": "chrom_method.optimize_chromatography_method"}
    facts: list[FactDraft] = []

    pareto = result.get("pareto_front")
    if isinstance(pareto, list) and pareto:
        facts.append(
            FactDraft(
                subject_label="NCEProject",
                subject_id_value=str(project_id),
                predicate="has_chrom_pareto_front_size",
                object_value={"value": len(pareto), **common},
                derivation_class="COMPUTED",
                confidence=_CONFIDENCE,
                confidence_tier=tier,
                extractor_name="chrom_method.optimize_chromatography_method",
            )
        )

    best_res = result.get("best_resolution")
    if not isinstance(best_res, (int, float)):
        resolutions = [
            float(e["resolution"])
            for e in (pareto or [])
            if isinstance(e, dict) and isinstance(e.get("resolution"), (int, float))
        ]
        best_res = max(resolutions) if resolutions else None

    if isinstance(best_res, (int, float)):
        facts.append(
            FactDraft(
                subject_label="NCEProject",
                subject_id_value=str(project_id),
                predicate="has_chrom_best_resolution",
                object_value={"value": float(best_res), **common},
                derivation_class="COMPUTED",
                confidence=_CONFIDENCE,
                confidence_tier=tier,
                extractor_name="chrom_method.optimize_chromatography_method",
            )
        )
    return facts
