"""yield_baseline extractor — records baseline-model training events as
project-scoped facts.

Phase 1.2. The /train endpoint returns `{model_id, n_train, cached_for_seconds}`.
We emit one fact per training event so the KG knows a baseline exists for a
project (downstream consumers can ask "what's my baseline?" without
re-training). Cache hits are still real facts — they confirm the model is
fresh and available.

Subject: the project (carried in ctx.project_id or args.project_internal_id).
If neither is resolvable we skip — a project-less baseline has no anchor.

Facts emitted per train invocation:
  - (Project, has_yield_baseline_model, model_id)  with n_train in object_value

Confidence: 0.85 — the model exists, this is a deterministic observation
about state of the system.
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

_CONFIDENCE = 0.85


def extract(result: dict[str, Any], ctx: ExtractionContext) -> list[FactDraft]:
    try:
        return _extract(result, ctx)
    except Exception as exc:  # noqa: BLE001
        log.debug("yield_baseline extractor swallowed error: %s", exc)
        return []


def _resolve_project(
    result: dict[str, Any], args: dict[str, Any], ctx_project: str | None
) -> str | None:
    """Project anchor preference: explicit args > ctx.project_id."""
    proj = args.get("project_internal_id") or args.get("project_id")
    if isinstance(proj, str) and proj:
        return proj
    if isinstance(ctx_project, str) and ctx_project:
        return ctx_project
    return None


def _extract(
    result: dict[str, Any], ctx: ExtractionContext
) -> list[FactDraft]:
    model_id = result.get("model_id")
    if not isinstance(model_id, str) or not model_id:
        return []

    n_train = result.get("n_train")
    cached_for = result.get("cached_for_seconds")
    project = _resolve_project(result, ctx.args, ctx.project_id)
    if project is None:
        return []

    tier = confidence_tier(_CONFIDENCE)
    return [
        FactDraft(
            subject_label="Project",
            subject_id_value=project,
            predicate="has_yield_baseline_model",
            object_value={
                "value": model_id,
                "n_train": n_train if isinstance(n_train, int) else None,
                "cached_for_seconds": cached_for if isinstance(cached_for, int) else None,
                "tool": "yield_baseline.train",
            },
            derivation_class="COMPUTED",
            confidence=_CONFIDENCE,
            confidence_tier=tier,
            extractor_name="yield_baseline.train",
        )
    ]
