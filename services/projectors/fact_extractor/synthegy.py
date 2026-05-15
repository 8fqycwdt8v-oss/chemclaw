"""synthegy extractor — turns mcp-synthegy-mech mechanism-elucidation
responses into per-reaction KG facts.

Phase 1.2 wave-2. The `elucidate_mechanism` builtin (wrapping mcp-synthegy-mech
`/elucidate_mechanism`) runs LLM-guided A* over ionic arrow-pushing moves and
returns:
  {
    moves: [{ from_smiles, to_smiles, score, derived_kind,
              derived_atom_x, derived_atom_y, energy_delta_hartree }],
    reactants_smiles, products_smiles,
    total_llm_calls, total_nodes_explored,
    prompt_tokens, completion_tokens,
    parse_failures, upstream_errors,
    warnings, truncated,
  }

A *truncated* search returns moves=[] — the budget was exhausted before the
search reached the product. We treat that as "no useful facts" and emit
nothing (the per-move volume is the only signal, and zero moves = no
information).

Subject anchoring: the reaction. The canonical key is
`<reactants_smiles>>><products_smiles>` (rxn_smiles convention). We fall
back to the args' input reactants/products if the response doesn't echo
them.

Facts emitted per elucidate_mechanism invocation (when moves present):
  - (Reaction, has_mechanism_step_count, len(moves))
  - (Reaction, has_mechanism_top_barrier_kj_mol, max_barrier)
      when at least one move carries a numeric energy_delta_hartree;
      converted Hartree → kJ/mol (×2625.5) and we report MAX (rate-
      limiting barrier).

Confidence: 0.70 — LLM-guided A* over ionic mechanisms is published with
peer review (Bran et al., Matter 2026) but explicitly does NOT cover
radicals or pericyclics; medium-tier is the right default. Truncated /
high-warning runs would ideally drop further, but we already skip those.
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

_CONFIDENCE = 0.70

# 1 Hartree = 2625.5 kJ/mol (CODATA 2018). Standard chemistry unit conversion;
# barriers are conventionally reported in kJ/mol so the agent + wiki layer
# don't need to interpret raw Hartree at fact-read time.
_HARTREE_TO_KJ_MOL = 2625.499639


def extract(result: dict[str, Any], ctx: ExtractionContext) -> list[FactDraft]:
    try:
        return _extract(result, ctx)
    except Exception as exc:  # noqa: BLE001 — extractor must not raise
        log.debug("synthegy extractor swallowed error: %s", exc)
        return []


def _resolve_rxn_smiles(
    result: dict[str, Any], args: dict[str, Any]
) -> str | None:
    """Build a canonical rxn SMILES `<reactants>>><products>` from response
    or args. Returns None if either half is missing."""
    reactants = result.get("reactants_smiles") or args.get("reactants_smiles")
    products = result.get("products_smiles") or args.get("products_smiles")
    if not isinstance(reactants, str) or not reactants:
        return None
    if not isinstance(products, str) or not products:
        return None
    return f"{reactants}>>{products}"


def _extract(result: dict[str, Any], ctx: ExtractionContext) -> list[FactDraft]:
    moves = result.get("moves")
    if not isinstance(moves, list) or not moves:
        # Truncated runs hand us moves=[]; no useful per-reaction signal.
        return []

    rxn = _resolve_rxn_smiles(result, ctx.args)
    if rxn is None:
        return []

    # Defensive: count only well-shaped dict entries.
    valid_moves = [m for m in moves if isinstance(m, dict)]
    if not valid_moves:
        return []
    n_steps = len(valid_moves)

    # Take the maximum |energy_delta_hartree| across moves as a proxy for
    # the rate-limiting barrier. Filter to numeric finite deltas; energy
    # validation is opt-in and most calls won't carry any deltas at all.
    deltas_hartree: list[float] = []
    for m in valid_moves:
        d = m.get("energy_delta_hartree")
        if isinstance(d, (int, float)):
            deltas_hartree.append(float(d))

    tier = confidence_tier(_CONFIDENCE)
    truncated = bool(result.get("truncated", False))
    common = {
        "tool": "synthegy.elucidate_mechanism",
        "truncated": truncated,
        "total_llm_calls": result.get("total_llm_calls"),
        "warnings_count": (
            len(result.get("warnings", []))
            if isinstance(result.get("warnings"), list)
            else 0
        ),
    }

    facts: list[FactDraft] = [
        FactDraft(
            subject_label="Reaction",
            subject_id_value=rxn,
            predicate="has_mechanism_step_count",
            object_value={"value": n_steps, **common},
            derivation_class="COMPUTED",
            confidence=_CONFIDENCE,
            confidence_tier=tier,
            extractor_name="synthegy.elucidate_mechanism",
        )
    ]
    if deltas_hartree:
        # Take MAX (rate-limiting step). Convert to kJ/mol.
        top_barrier_kj = max(deltas_hartree) * _HARTREE_TO_KJ_MOL
        facts.append(
            FactDraft(
                subject_label="Reaction",
                subject_id_value=rxn,
                predicate="has_mechanism_top_barrier_kj_mol",
                object_value={
                    "value": top_barrier_kj,
                    "raw_hartree": max(deltas_hartree),
                    **common,
                },
                unit="kJ/mol",
                derivation_class="COMPUTED",
                confidence=_CONFIDENCE,
                confidence_tier=tier,
                extractor_name="synthegy.elucidate_mechanism",
            )
        )
    return facts
