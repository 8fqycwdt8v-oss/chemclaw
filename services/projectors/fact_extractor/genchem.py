"""genchem extractor — turns mcp-genchem generative-chemistry responses
into a SINGLE per-run rollup fact.

Phase 1.2 wave-2. The `generate_focused_library` builtin (wrapping mcp-genchem
endpoints /scaffold_decorate, /rgroup_enumerate, /bioisostere_replace,
/fragment_grow, /fragment_link) returns:
  {
    run_id,           # gen_runs.id (uuid as str, nullable on persistence failure)
    kind,             # 'scaffold' | 'rgroup' | 'bioisostere' | 'grow' | 'link'
    n_proposed,
    proposals: [{ smiles, inchikey, parent_inchikey, transformation, scores }],
  }

LOAD-BEARING design decision: emit ONE fact per run, NOT one per proposal.
A single bioisostere/scaffold call can return 500-5000 candidates; per-
proposal fact emission would flood the KG and break the wiki layer (every
candidate becomes its own Compound node before any signal-bearing screening
has happened). The proposals are persisted authoritatively in `gen_proposals`
already; the KG only needs to know "library N exists, sized M, anchored to
project P" so the wiki layer can summarise.

This is exactly why the registry row for genchem has `promote_default=FALSE`
— even the per-run fact stays in the staging area until an admin explicitly
promotes it. Generated candidates are exploratory until evaluated.

Subject anchoring: the project. We try args.project_internal_id first, then
ctx.project_id. Without a project anchor we skip.

Facts emitted per generate_focused_library invocation:
  - (Project, has_generated_library, run_id)
    with candidate_count, kind, seed_smiles in object_value.

Confidence: 0.50 — exploratory tier. Generated candidates are pure
combinatorial enumeration / curated-rule applications; no scoring done yet.
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

_CONFIDENCE = 0.50


def _resolve_project(
    args: dict[str, Any], ctx_project: str | None
) -> str | None:
    """Project anchor preference: explicit args > ctx.project_id."""
    proj = args.get("project_internal_id") or args.get("project_id")
    if isinstance(proj, str) and proj:
        return proj
    if isinstance(ctx_project, str) and ctx_project:
        return ctx_project
    return None


def extract(result: dict[str, Any], ctx: ExtractionContext) -> list[FactDraft]:
    try:
        return _extract(result, ctx)
    except Exception as exc:  # noqa: BLE001 — extractor must not raise
        log.debug("genchem extractor swallowed error: %s", exc)
        return []


def _extract(result: dict[str, Any], ctx: ExtractionContext) -> list[FactDraft]:
    run_id = result.get("run_id")
    if not isinstance(run_id, str) or not run_id:
        # No run_id means the gen_runs persistence failed; without a stable
        # subject id there's no useful KG fact to emit. The proposals
        # themselves are gone (the persistence side does the inserting).
        return []

    project = _resolve_project(ctx.args, ctx.project_id)
    if project is None:
        return []

    n_proposed = result.get("n_proposed")
    if isinstance(n_proposed, int):
        candidate_count = n_proposed
    elif isinstance(result.get("proposals"), list):
        candidate_count = len(result["proposals"])
    else:
        candidate_count = 0

    kind = result.get("kind") if isinstance(result.get("kind"), str) else None
    seed_smiles = (
        ctx.args.get("seed_smiles")
        or ctx.args.get("scaffold_smiles")
        or ctx.args.get("query_smiles")
        or ctx.args.get("fragment_smiles")
        if isinstance(ctx.args, dict)
        else None
    )
    if not isinstance(seed_smiles, str):
        seed_smiles = None

    tier = confidence_tier(_CONFIDENCE)
    return [
        FactDraft(
            subject_label="Project",
            subject_id_value=project,
            predicate="has_generated_library",
            object_value={
                "value": run_id,
                "candidate_count": candidate_count,
                "kind": kind,
                "seed_smiles": seed_smiles,
                "tool": "genchem.generate_focused_library",
            },
            derivation_class="COMPUTED",
            confidence=_CONFIDENCE,
            confidence_tier=tier,
            extractor_name="genchem.generate_focused_library",
        )
    ]
