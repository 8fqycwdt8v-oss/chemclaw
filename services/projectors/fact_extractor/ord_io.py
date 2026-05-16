"""ord_io extractor — ORD reaction records as KG facts.

Phase 1 wave 3. query_ord_reactions wraps the Open Reaction Database.
Each ORD record is an experimentally measured reaction — high-confidence
OBSERVED data.

Facts emitted for the first reaction record only (one canonical record
per invocation; ORD queries are usually specific):
  - (Compound, has_ord_yield_pct, yield_fraction * 100)
  - (Compound, has_ord_temperature_c, temperature_c)

derivation_class = OBSERVED (curated experimental measurement from ORD).
Confidence: 0.90 (measured experimental data, well-curated source).
"""
from __future__ import annotations

import logging
from typing import Any

from services.projectors.fact_extractor._common import confidence_tier, resolve_smiles
from services.projectors.tool_result_extractor.main import ExtractionContext, FactDraft

log = logging.getLogger(__name__)
_CONFIDENCE = 0.90


def extract(result: dict[str, Any], ctx: ExtractionContext) -> list[FactDraft]:
    try:
        return _extract(result, ctx)
    except Exception as exc:  # noqa: BLE001
        log.debug("ord_io extractor swallowed error: %s", exc)
        return []


def _extract(result: dict[str, Any], ctx: ExtractionContext) -> list[FactDraft]:
    reactions = result.get("reactions")
    if not isinstance(reactions, list) or not reactions:
        return []

    # Only process the first reaction to avoid fact flooding.
    rxn = reactions[0] if isinstance(reactions[0], dict) else {}
    smiles = rxn.get("smiles") or resolve_smiles(result, ctx.args)
    if not smiles:
        return []

    tier = confidence_tier(_CONFIDENCE)
    common = {"tool": "ord_io.query_ord_reactions", "source": "ORD"}
    facts: list[FactDraft] = []

    yf = rxn.get("yield_fraction")
    if isinstance(yf, (int, float)) and 0.0 <= yf <= 1.0:
        facts.append(
            FactDraft(
                subject_label="Compound",
                subject_id_value=smiles,
                predicate="has_ord_yield_pct",
                object_value={"value": round(float(yf) * 100, 2), **common},
                unit="%",
                derivation_class="OBSERVED",
                confidence=_CONFIDENCE,
                confidence_tier=tier,
                extractor_name="ord_io.query_ord_reactions",
            )
        )

    temp = rxn.get("temperature_c")
    if isinstance(temp, (int, float)):
        facts.append(
            FactDraft(
                subject_label="Compound",
                subject_id_value=smiles,
                predicate="has_ord_temperature_c",
                object_value={"value": float(temp), **common},
                unit="°C",
                derivation_class="OBSERVED",
                confidence=_CONFIDENCE,
                confidence_tier=tier,
                extractor_name="ord_io.query_ord_reactions",
            )
        )
    return facts
