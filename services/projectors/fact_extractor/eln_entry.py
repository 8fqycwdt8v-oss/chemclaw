"""eln_entry extractor — ELN free-text note existence as KG facts.

Phase 2. Records the *existence* of a free-text note as a fact — never the
note body itself (it may contain sensitive chemistry not yet redacted by the
egress pipeline).

Facts per entry (first 5):
  - (Compound, has_eln_free_text_note, true)  [if notes non-empty]

derivation_class = COMPUTED. Confidence: 0.60 (existence only, not content).
"""
from __future__ import annotations

import logging
from typing import Any

from services.projectors.fact_extractor._common import confidence_tier
from services.projectors.tool_result_extractor.main import ExtractionContext, FactDraft

log = logging.getLogger(__name__)
_CONFIDENCE = 0.60
_MAX_ENTRIES = 5


def extract(result: dict[str, Any], ctx: ExtractionContext) -> list[FactDraft]:
    try:
        return _extract(result, ctx)
    except Exception as exc:  # noqa: BLE001
        log.debug("eln_entry extractor swallowed error: %s", exc)
        return []


def _extract(result: dict[str, Any], ctx: ExtractionContext) -> list[FactDraft]:
    entries = result.get("entries")
    if not isinstance(entries, list) or not entries:
        return []

    tier = confidence_tier(_CONFIDENCE)
    facts: list[FactDraft] = []

    for entry in entries[:_MAX_ENTRIES]:
        if not isinstance(entry, dict):
            continue
        notes = entry.get("notes")
        if not (isinstance(notes, str) and notes.strip()):
            continue
        compound_id = entry.get("compound_smiles") or ctx.args.get("smiles")
        if not compound_id:
            continue
        facts.append(FactDraft(
            subject_label="Compound",
            subject_id_value=str(compound_id),
            predicate="has_eln_free_text_note",
            object_value={
                "value": True,
                "tool": "eln_entry",
                "entry_id": entry.get("entry_id"),
            },
            derivation_class="COMPUTED",
            confidence=_CONFIDENCE,
            confidence_tier=tier,
            extractor_name="eln_entry",
        ))

    return facts
