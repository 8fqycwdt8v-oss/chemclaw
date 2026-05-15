"""sirius extractor — turns mcp-sirius MS structure-identification results
into per-candidate KG facts.

Phase 1.2 wave-2. The `identify_unknown_from_ms` builtin (wrapping mcp-sirius
`/identify`) returns `candidates: [{ smiles, name, score, classyfire }]`
ranked descending by CSI:FingerID score. Each candidate is a *guess* at the
unknown structure for a given MS2 spectrum.

Subject anchoring: the input is an MS2 spectrum + precursor m/z, *not* a
SMILES. Each candidate SMILES is its own subject (so the KG can cross-link
multiple identifications of the same compound from different spectra). We
cap at top-5 to keep the per-spectrum fact volume bounded — a single
spectrum returning 100 candidates would otherwise flood the KG.

Facts emitted (one per candidate, up to 5):
  - (Compound, has_sirius_structure_score, score)
    with name + classyfire in object_value, precursor_mz in object_value
    (when present in args), so downstream consumers can reconstruct the
    spectrum context.

Confidence: 0.65 — structure elucidation from MS2 is heuristic. CSI:FingerID
high-scoring candidates are *probable* matches, not confirmed identities.
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

_CONFIDENCE = 0.65
_MAX_CANDIDATES = 5


def extract(result: dict[str, Any], ctx: ExtractionContext) -> list[FactDraft]:
    try:
        return _extract(result, ctx)
    except Exception as exc:  # noqa: BLE001 — extractor must not raise
        log.debug("sirius extractor swallowed error: %s", exc)
        return []


def _extract(result: dict[str, Any], ctx: ExtractionContext) -> list[FactDraft]:
    candidates = result.get("candidates")
    if not isinstance(candidates, list) or not candidates:
        return []

    tier = confidence_tier(_CONFIDENCE)
    precursor_mz = (
        ctx.args.get("precursor_mz") if isinstance(ctx.args, dict) else None
    )
    ionization = (
        ctx.args.get("ionization") if isinstance(ctx.args, dict) else None
    )

    facts: list[FactDraft] = []
    count = 0
    for cand in candidates:
        if count >= _MAX_CANDIDATES:
            break
        if not isinstance(cand, dict):
            continue
        smi = cand.get("smiles")
        score = cand.get("score")
        if not isinstance(smi, str) or not smi:
            continue
        if not isinstance(score, (int, float)):
            continue
        facts.append(
            FactDraft(
                subject_label="Compound",
                subject_id_value=smi,
                predicate="has_sirius_structure_score",
                object_value={
                    "value": float(score),
                    "name": cand.get("name"),
                    "classyfire": cand.get("classyfire"),
                    "precursor_mz": (
                        float(precursor_mz)
                        if isinstance(precursor_mz, (int, float))
                        else None
                    ),
                    "ionization": ionization
                    if isinstance(ionization, str)
                    else None,
                    "rank": count + 1,
                    "tool": "sirius.identify",
                },
                derivation_class="COMPUTED",
                confidence=_CONFIDENCE,
                confidence_tier=tier,
                extractor_name="sirius.identify",
            )
        )
        count += 1

    return facts
