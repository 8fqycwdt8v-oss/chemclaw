"""plate_designer extractor — plate design decisions as campaign facts.

Phase 1 wave 3. design_plate produces a well layout for an experimental
campaign. Facts are scoped to the project (NCEProject), not a single
compound.

Facts emitted:
  - (NCEProject, has_plate_well_count, well_count)
  - (NCEProject, has_plate_design_strategy, strategy)

derivation_class = COMPUTED. Confidence: 0.95 (deterministic layout engine).
"""
from __future__ import annotations

import logging
from typing import Any

from services.projectors.fact_extractor._common import confidence_tier
from services.projectors.tool_result_extractor.main import ExtractionContext, FactDraft

log = logging.getLogger(__name__)
_CONFIDENCE = 0.95


def extract(result: dict[str, Any], ctx: ExtractionContext) -> list[FactDraft]:
    try:
        return _extract(result, ctx)
    except Exception as exc:  # noqa: BLE001
        log.debug("plate_designer extractor swallowed error: %s", exc)
        return []


def _extract(result: dict[str, Any], ctx: ExtractionContext) -> list[FactDraft]:
    project_id = (
        ctx.args.get("project_internal_id")
        or result.get("project_internal_id")
        or "unknown_campaign"
    )
    tier = confidence_tier(_CONFIDENCE)
    common = {"tool": "plate_designer.design_plate"}
    facts: list[FactDraft] = []

    well_count = result.get("well_count")
    if isinstance(well_count, int) and well_count > 0:
        facts.append(
            FactDraft(
                subject_label="NCEProject",
                subject_id_value=str(project_id),
                predicate="has_plate_well_count",
                object_value={"value": well_count, **common},
                derivation_class="COMPUTED",
                confidence=_CONFIDENCE,
                confidence_tier=tier,
                extractor_name="plate_designer.design_plate",
            )
        )

    strategy = result.get("strategy")
    if isinstance(strategy, str) and strategy:
        facts.append(
            FactDraft(
                subject_label="NCEProject",
                subject_id_value=str(project_id),
                predicate="has_plate_design_strategy",
                object_value={"value": strategy, **common},
                derivation_class="COMPUTED",
                confidence=_CONFIDENCE,
                confidence_tier=tier,
                extractor_name="plate_designer.design_plate",
            )
        )
    return facts
