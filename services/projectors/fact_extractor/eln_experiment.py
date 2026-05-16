"""eln_experiment extractor — ELN experiment metadata as KG facts.

Phase 2. query_eln_experiments returns experiment-level summaries from the
mock ELN, including experiment type, status, and entry counts.

Facts per experiment (first 3):
  - (NCEProject, has_eln_experiment_type, experiment_type)
  - (NCEProject, has_eln_experiment_status, status)
  - (NCEProject, has_eln_entry_count, entry_count)

derivation_class = COMPUTED. Confidence: 0.90.
"""
from __future__ import annotations

import logging
from typing import Any

from services.projectors.fact_extractor._common import confidence_tier
from services.projectors.tool_result_extractor.main import ExtractionContext, FactDraft

log = logging.getLogger(__name__)
_CONFIDENCE = 0.90
_MAX_EXPERIMENTS = 3


def extract(result: dict[str, Any], ctx: ExtractionContext) -> list[FactDraft]:
    try:
        return _extract(result, ctx)
    except Exception as exc:  # noqa: BLE001
        log.debug("eln_experiment extractor swallowed error: %s", exc)
        return []


def _extract(result: dict[str, Any], ctx: ExtractionContext) -> list[FactDraft]:
    experiments = result.get("experiments")
    if not isinstance(experiments, list) or not experiments:
        return []

    tier = confidence_tier(_CONFIDENCE)
    facts: list[FactDraft] = []

    for exp in experiments[:_MAX_EXPERIMENTS]:
        if not isinstance(exp, dict):
            continue
        project_code = (
            exp.get("project_code")
            or ctx.args.get("project_code")
            or "unknown"
        )
        common = {
            "tool": "eln_experiment.query_eln_experiments",
            "experiment_id": exp.get("experiment_id"),
        }

        for pred, key in [
            ("has_eln_experiment_type", "experiment_type"),
            ("has_eln_experiment_status", "status"),
        ]:
            val = exp.get(key)
            if isinstance(val, str) and val:
                facts.append(FactDraft(
                    subject_label="NCEProject",
                    subject_id_value=str(project_code),
                    predicate=pred,
                    object_value={"value": val, **common},
                    derivation_class="COMPUTED",
                    confidence=_CONFIDENCE,
                    confidence_tier=tier,
                    extractor_name="eln_experiment.query_eln_experiments",
                ))

        entry_count = exp.get("entry_count")
        if isinstance(entry_count, int):
            facts.append(FactDraft(
                subject_label="NCEProject",
                subject_id_value=str(project_code),
                predicate="has_eln_entry_count",
                object_value={"value": entry_count, **common},
                derivation_class="COMPUTED",
                confidence=_CONFIDENCE,
                confidence_tier=tier,
                extractor_name="eln_experiment.query_eln_experiments",
            ))

    return facts
