"""xtb extractor — turns mcp-xtb `single_point` responses into KG facts.

Phase 1.1 pilot: validates the registry-driven extractor pattern end-to-end
with a small, well-typed surface. Subsequent xtb endpoints (geometry_opt,
frequencies, transition_state, irc, etc.) will land as additional functions
in this module under the `EXTRACTORS` dispatch table once the pilot is
stable.

Subject identification: the tool's input args carry a `smiles` string; we
use the *canonical* SMILES if the response includes it (cached path), else
fall back to the input SMILES. The KG's compound_fingerprinter projector
reconciles SMILES → inchikey downstream so we don't try to canonicalise
here (no RDKit dependency in projector containers).

Facts emitted per single_point invocation (when fields are populated):
  - (Compound, has_xtb_single_point_energy_hartree, energy_hartree)
  - (Compound, has_homo_lumo_gap_eV, homo_lumo_eV)
  - (Compound, has_xtb_dipole_debye, |dipole|)  -- magnitude only
"""

from __future__ import annotations

import logging
import math
from typing import Any

from services.projectors.tool_result_extractor.main import (
    ExtractionContext,
    FactDraft,
)

log = logging.getLogger(__name__)


def _confidence_tier(score: float) -> str:
    if score >= 0.85:
        return "high"
    if score >= 0.65:
        return "medium"
    if score >= 0.40:
        return "low"
    return "exploratory"


def _resolve_compound_id(
    result: dict[str, Any],
    args: dict[str, Any],
) -> str | None:
    """Pick the SMILES identifier for the compound facts. Prefer a
    canonical SMILES from the response (cached path may carry one),
    fall back to the input args. Returns None if nothing resolvable."""
    canonical = result.get("smiles_canonical")
    if isinstance(canonical, str) and canonical:
        return canonical
    smiles = args.get("smiles")
    if isinstance(smiles, str) and smiles:
        return smiles
    return None


def _dipole_magnitude(dipole: Any) -> float | None:
    """Reduce a length-3 dipole vector to its magnitude in Debye. Returns
    None on shape mismatch rather than raising — the extractor must not
    fail the projector."""
    if not isinstance(dipole, (list, tuple)) or len(dipole) != 3:
        return None
    try:
        x, y, z = (float(v) for v in dipole)
    except (TypeError, ValueError):
        return None
    return math.sqrt(x * x + y * y + z * z)


def _extract_single_point(
    result: dict[str, Any],
    ctx: ExtractionContext,
) -> list[FactDraft]:
    facts: list[FactDraft] = []

    compound_id = _resolve_compound_id(result, ctx.args)
    if compound_id is None:
        log.debug(
            "xtb single_point extractor: no SMILES in args or result; skipping"
        )
        return facts

    # Method as a fact-level qualifier — recorded in object_value so a
    # consumer can distinguish GFN2-xTB vs. GFN-FF results on the same
    # compound. xtb's intrinsic reliability for GFN2-xTB is ~0.85
    # (chemist-grade single-point energies); GFN-FF degrades to ~0.70.
    method = result.get("method") or ctx.args.get("method") or "GFN2"
    if isinstance(method, str) and method.upper() == "GFN-FF":
        method_conf = 0.70
    else:
        method_conf = 0.85
    tier = _confidence_tier(method_conf)
    cache_hit = bool(result.get("cache_hit", False))

    common_object_value: dict[str, Any] = {
        "method": method,
        "task": "single_point",
        "cache_hit": cache_hit,
        "job_id": result.get("job_id"),
    }

    # Fact 1 — single-point energy (Hartree).
    energy = result.get("energy_hartree")
    if isinstance(energy, (int, float)):
        facts.append(
            FactDraft(
                subject_label="Compound",
                subject_id_value=compound_id,
                predicate="has_xtb_single_point_energy_hartree",
                object_value={"value": float(energy), **common_object_value},
                unit="Hartree",
                derivation_class="COMPUTED",
                confidence=method_conf,
                confidence_tier=tier,
                extractor_name="xtb.single_point",
            )
        )

    # Fact 2 — HOMO-LUMO gap (eV).
    gap = result.get("homo_lumo_eV")
    if isinstance(gap, (int, float)):
        facts.append(
            FactDraft(
                subject_label="Compound",
                subject_id_value=compound_id,
                predicate="has_homo_lumo_gap_eV",
                object_value={"value": float(gap), **common_object_value},
                unit="eV",
                derivation_class="COMPUTED",
                confidence=method_conf,
                confidence_tier=tier,
                extractor_name="xtb.single_point",
            )
        )

    # Fact 3 — dipole magnitude (Debye). xtb reports the dipole as a 3-vec
    # in atomic units; we surface the magnitude in Debye-ish via a simple
    # conversion (1 a.u. ≈ 2.5417 D). Keep the raw vector in object_value
    # so downstream consumers can recover it.
    dipole_au = _dipole_magnitude(result.get("dipole"))
    if dipole_au is not None:
        au_to_debye = 2.541746229
        facts.append(
            FactDraft(
                subject_label="Compound",
                subject_id_value=compound_id,
                predicate="has_xtb_dipole_debye",
                object_value={
                    "value": dipole_au * au_to_debye,
                    "raw_au_vector": result.get("dipole"),
                    **common_object_value,
                },
                unit="D",
                derivation_class="COMPUTED",
                confidence=method_conf,
                confidence_tier=tier,
                extractor_name="xtb.single_point",
            )
        )

    return facts


# Dispatch table: (result_schema_id) -> extractor function. Phase 1.1
# ships only single_point; subsequent xtb tasks add rows here AND a
# matching extraction_registry row pointing at the same module path
# with the appropriate result_schema_id.
_DISPATCH: dict[str, Any] = {
    "single_point.v1": _extract_single_point,
    # Default — the single_point extractor is the only one shipped today.
    # If a future result_schema_id is missing from this table the top-level
    # `extract()` falls through to a no-op rather than raising.
}


def extract(result: dict[str, Any], ctx: ExtractionContext) -> list[FactDraft]:
    """Entry point invoked by the tool_result_extractor projector.

    The `result_schema_id` is carried in the ingestion event payload and
    routed to the right extractor function via the dispatch table. Phase
    1.1 ships only the single_point variant; future xtb endpoints land as
    new entries here without changing the projector.

    Errors are caught and logged at debug level; never raised — the
    projector's transaction must not abort on a single malformed event.
    """
    # The dispatching projector passes the tool's invocation context but
    # not the result_schema_id. We infer the variant from the response
    # shape: presence of `energy_hartree` or `homo_lumo_eV` or `dipole`
    # marks a single_point response. Other xtb endpoints have distinct
    # discriminator fields (e.g. `optimized_xyz` for geometry_opt).
    try:
        if (
            "energy_hartree" in result
            or "homo_lumo_eV" in result
            or "dipole" in result
        ):
            return _extract_single_point(result, ctx)
    except Exception as exc:  # noqa: BLE001 — extractor must not raise
        log.debug("xtb extractor swallowed error: %s", exc)
    return []
