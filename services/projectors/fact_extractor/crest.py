"""crest extractor — turns mcp-crest conformer / tautomer / protomer
ensemble responses into per-compound rollup facts.

Phase 1.2 wave-2. The `qm_crest_screen` builtin (wrapping mcp-crest
`/conformers`, `/tautomers`, `/protomers`) returns:
  {
    job_id, cache_hit, method, task,
    summary,
    ensemble: [{ ensemble_index, xyz, energy_hartree, boltzmann_weight }],
  }

We emit per-compound rollup facts, *not* one fact per conformer — a 200-
conformer ensemble would otherwise drown the KG with low-value duplicates
(every conformer is the same compound).

Facts emitted per qm_crest_screen invocation (when fields are populated):
  - (Compound, has_conformer_count, n)            # always when ensemble non-empty
  - (Compound, has_lowest_conformer_energy_hartree, min_energy)
                                                  # min over finite energies

The `task` field (conformers / tautomers / protomers) rides in object_value
so downstream consumers can distinguish a 20-conformer ensemble from a
20-tautomer ensemble for the same SMILES.

Confidence: 0.80 — CREST conformer search is reliable for typical drug-
like molecules; flexible or highly-charged inputs degrade quality but
80% is a defensible baseline (chemist-grade for small molecules).
"""
from __future__ import annotations

import logging
import math
from typing import Any

from services.projectors.fact_extractor._common import confidence_tier, resolve_smiles
from services.projectors.tool_result_extractor.main import (
    ExtractionContext,
    FactDraft,
)

log = logging.getLogger(__name__)

_CONFIDENCE = 0.80


def extract(result: dict[str, Any], ctx: ExtractionContext) -> list[FactDraft]:
    try:
        return _extract(result, ctx)
    except Exception as exc:  # noqa: BLE001 — extractor must not raise
        log.debug("crest extractor swallowed error: %s", exc)
        return []


def _extract(result: dict[str, Any], ctx: ExtractionContext) -> list[FactDraft]:
    ensemble = result.get("ensemble")
    if not isinstance(ensemble, list) or not ensemble:
        return []

    smiles = resolve_smiles(result, ctx.args)
    if smiles is None:
        return []

    # Defensive: count only well-shaped dict entries.
    entries = [e for e in ensemble if isinstance(e, dict)]
    if not entries:
        return []
    n = len(entries)

    # Lowest energy across finite values; NaN / non-numeric are ignored.
    energies: list[float] = []
    for e in entries:
        v = e.get("energy_hartree")
        if isinstance(v, (int, float)) and math.isfinite(v):
            energies.append(float(v))

    tier = confidence_tier(_CONFIDENCE)
    task = result.get("task") if isinstance(result.get("task"), str) else None
    method = result.get("method") if isinstance(result.get("method"), str) else None
    cache_hit = bool(result.get("cache_hit", False))
    common = {
        "method": method,
        "task": task,
        "cache_hit": cache_hit,
        "job_id": result.get("job_id"),
        "tool": "crest.ensemble",
    }

    facts: list[FactDraft] = [
        FactDraft(
            subject_label="Compound",
            subject_id_value=smiles,
            predicate="has_conformer_count",
            object_value={"value": n, **common},
            derivation_class="COMPUTED",
            confidence=_CONFIDENCE,
            confidence_tier=tier,
            extractor_name="crest.ensemble",
        )
    ]
    if energies:
        facts.append(
            FactDraft(
                subject_label="Compound",
                subject_id_value=smiles,
                predicate="has_lowest_conformer_energy_hartree",
                object_value={"value": min(energies), **common},
                unit="Hartree",
                derivation_class="COMPUTED",
                confidence=_CONFIDENCE,
                confidence_tier=tier,
                extractor_name="crest.ensemble",
            )
        )
    return facts
