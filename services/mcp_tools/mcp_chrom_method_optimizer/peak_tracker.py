"""Peak tracking across chromatographic runs.

Pure functions. Matches detected peaks to a set of known target compounds
(by name or m/z) so the optimizer's resolution objective refers to the
*same* critical pairs from one injection to the next even when selectivity
shifts. When no target set is supplied the caller falls back to the
"unknown impurities" mode (all adjacent peaks are critical) handled in
``scorer.py``.

Matching priority:
  1. exact (case-/whitespace-insensitive) name match
  2. m/z within ``mz_tolerance`` (default ±0.5 Da — unit-resolution MS;
     pass a tighter tolerance for hi-res)
  3. unmatched targets are reported so the caller can flag a low-confidence
     scoring run (a target that disappeared usually means co-elution or a
     selectivity inversion the agent should surface, not silently score)

This is deliberately conservative: name + m/z only. DAD-spectral-correlation
matching (cosine ≥ 0.95) and retention-window priors are a follow-up — see
BACKLOG / docs/plans/bo-chromatography-implementation-plan.md Phase 2.
"""
from __future__ import annotations

from typing import Any, Sequence

DEFAULT_MZ_TOLERANCE = 0.5


def _norm_name(s: Any) -> str | None:
    if not isinstance(s, str):
        return None
    n = " ".join(s.strip().lower().split())
    return n or None


def match_targets(
    peaks: Sequence[dict[str, Any]],
    targets: Sequence[dict[str, Any]],
    *,
    mz_tolerance: float = DEFAULT_MZ_TOLERANCE,
) -> dict[str, Any]:
    """Match peaks to named/typed target compounds.

    ``targets`` items: ``{"name": str, "m_z": float | None}`` (m_z optional).
    Returns:
      {
        "matched":   {target_name: peak_dict, ...},
        "unmatched_targets": [target_name, ...],
        "extra_peaks": [peak_dict, ...],          # detected but not a target
        "confidence": "high" | "partial",         # partial if any target missing
      }
    """
    by_name: dict[str, dict[str, Any]] = {}
    for p in peaks:
        nn = _norm_name(p.get("name"))
        if nn is not None and nn not in by_name:
            by_name[nn] = p

    used_ids: set[int] = set()
    matched: dict[str, dict[str, Any]] = {}
    unmatched: list[str] = []

    for t in targets:
        tname = t.get("name")
        if not isinstance(tname, str) or not tname.strip():
            continue
        nn = _norm_name(tname)
        # 1. name match
        if nn is not None and nn in by_name and id(by_name[nn]) not in used_ids:
            matched[tname] = by_name[nn]
            used_ids.add(id(by_name[nn]))
            continue
        # 2. m/z match
        tmz = t.get("m_z")
        if isinstance(tmz, (int, float)):
            best: dict[str, Any] | None = None
            best_d = mz_tolerance
            for p in peaks:
                if id(p) in used_ids:
                    continue
                pmz = p.get("m_z")
                if isinstance(pmz, (int, float)):
                    d = abs(float(pmz) - float(tmz))
                    if d <= best_d:
                        best, best_d = p, d
            if best is not None:
                matched[tname] = best
                used_ids.add(id(best))
                continue
        unmatched.append(tname)

    extra = [p for p in peaks if id(p) not in used_ids]
    return {
        "matched": matched,
        "unmatched_targets": unmatched,
        "extra_peaks": extra,
        "confidence": "partial" if unmatched else "high",
    }


def critical_pair_peaks(
    peaks: Sequence[dict[str, Any]],
    targets: Sequence[dict[str, Any]] | None,
    *,
    mz_tolerance: float = DEFAULT_MZ_TOLERANCE,
) -> tuple[list[dict[str, Any]], str]:
    """Return (peaks_to_use, confidence).

    When ``targets`` is given, returns just the matched target peaks
    (so resolution is computed over the target set); confidence reflects
    whether all targets were found. When ``targets`` is None/empty, returns
    all peaks (unknown-impurity mode) with confidence "high".
    """
    if not targets:
        return list(peaks), "high"
    m = match_targets(peaks, targets, mz_tolerance=mz_tolerance)
    return list(m["matched"].values()), m["confidence"]
