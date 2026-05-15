"""applicability_domain extractor — surfaces in/out-of-domain verdicts.

Phase 1.2. The assess endpoint returns a `verdict` ("in_domain" / "out_of_domain"
/ "marginal" / "unknown") plus per-signal scores (tanimoto, mahalanobis,
optional conformal). The verdict is the most actionable fact for downstream
consumers; the per-signal scores ride along in object_value.

Subject anchoring: applicability is assessed against a query SMILES or
reaction. We try ctx.args for `query_smiles` first, then any other smiles
key. If neither is found, we skip.

Facts emitted:
  - (Compound|Reaction, has_applicability_verdict, verdict)
  - (Compound|Reaction, has_applicability_signal_<name>, score)  if present

Confidence: 0.75 — verdict is a calibrated multi-signal aggregate, but
"in_domain" doesn't guarantee correctness, only that the model has seen
similar inputs.
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

_CONFIDENCE = 0.75


def _resolve_subject(
    result: dict[str, Any], args: dict[str, Any]
) -> tuple[str, str] | None:
    """Return (subject_label, subject_id_value) or None."""
    rxn = args.get("rxn_smiles") or args.get("query_rxn_smiles")
    if isinstance(rxn, str) and rxn:
        return ("Reaction", rxn)
    smi = (
        args.get("smiles")
        or args.get("query_smiles")
        or result.get("smiles_canonical")
    )
    if isinstance(smi, str) and smi:
        return ("Compound", smi)
    return None


def extract(result: dict[str, Any], ctx: ExtractionContext) -> list[FactDraft]:
    try:
        return _extract(result, ctx)
    except Exception as exc:  # noqa: BLE001
        log.debug("applicability_domain extractor swallowed error: %s", exc)
        return []


def _extract(
    result: dict[str, Any], ctx: ExtractionContext
) -> list[FactDraft]:
    verdict = result.get("verdict")
    if not isinstance(verdict, str) or not verdict:
        return []
    subj = _resolve_subject(result, ctx.args)
    if subj is None:
        return []
    label, ident = subj

    tier = confidence_tier(_CONFIDENCE)
    fallback = bool(result.get("used_global_fallback", False))
    common = {
        "tool": "applicability_domain.assess",
        "verdict": verdict,
        "used_global_fallback": fallback,
    }

    facts: list[FactDraft] = [
        FactDraft(
            subject_label=label,
            subject_id_value=ident,
            predicate="has_applicability_verdict",
            object_value={"value": verdict, **common},
            derivation_class="COMPUTED",
            confidence=_CONFIDENCE,
            confidence_tier=tier,
            extractor_name="applicability_domain.assess",
        )
    ]

    # Per-signal numeric scores — emit one fact per populated signal.
    for signal_key in ("tanimoto_signal", "mahalanobis_signal", "conformal_signal"):
        sig = result.get(signal_key)
        if not isinstance(sig, dict):
            continue
        # Each signal carries a "score" field at minimum.
        score = sig.get("score")
        if not isinstance(score, (int, float)):
            continue
        predicate = f"has_applicability_{signal_key}"
        facts.append(
            FactDraft(
                subject_label=label,
                subject_id_value=ident,
                predicate=predicate,
                object_value={"value": float(score), "raw": sig, **common},
                derivation_class="COMPUTED",
                confidence=_CONFIDENCE,
                confidence_tier=tier,
                extractor_name="applicability_domain.assess",
            )
        )

    return facts
