"""Peak tracking across chromatographic runs.

Pure functions. Matches detected peaks to a set of known target compounds
so the optimizer's resolution objective refers to the *same* critical
pairs from one injection to the next even when selectivity shifts. When
no target set is supplied the caller falls back to the "unknown
impurities" mode (all adjacent peaks are critical) handled in
``scorer.py``.

Matching priority:
  1. exact (case-/whitespace-insensitive) name match
  2. m/z within ``mz_tolerance`` (default ±0.5 Da — unit-resolution MS;
     pass a tighter tolerance for hi-res)
  3. DAD-UV spectrum cosine similarity ≥ ``spectrum_threshold`` (default
     0.95) when both target and peak carry a ``spectrum`` field — the
     UV-only fallback for campaigns without an MS detector. The spectrum
     is a flat array of absorbances (or DAD intensities at fixed
     wavelengths); the caller is responsible for ensuring all spectra in
     one campaign share the same wavelength grid.
  4. unmatched targets are reported so the caller can flag a low-
     confidence scoring run (a target that disappeared usually means
     co-elution or a selectivity inversion the agent should surface, not
     silently score)
"""
from __future__ import annotations

import math
from typing import Any, Sequence

DEFAULT_MZ_TOLERANCE = 0.5
DEFAULT_SPECTRUM_COSINE_THRESHOLD = 0.95


def _norm_name(s: Any) -> str | None:
    if not isinstance(s, str):
        return None
    n = " ".join(s.strip().lower().split())
    return n or None


def _as_spectrum_vector(value: Any) -> list[float] | None:
    """Coerce ``value`` to a non-trivial spectrum vector or return None."""
    if not isinstance(value, (list, tuple)) or len(value) < 2:
        return None
    out: list[float] = []
    for v in value:
        if not isinstance(v, (int, float)) or not math.isfinite(v):
            return None
        out.append(float(v))
    return out


def _cosine_similarity(a: Sequence[float], b: Sequence[float]) -> float | None:
    """Cosine similarity of two equal-length spectrum vectors, in [-1, 1].

    Returns None if either is zero-vector or lengths differ — defensive
    against mis-aligned wavelength grids and noise-only baselines."""
    if len(a) != len(b):
        return None
    dot = 0.0
    na = 0.0
    nb = 0.0
    for x, y in zip(a, b):
        dot += x * y
        na += x * x
        nb += y * y
    if na <= 0 or nb <= 0:
        return None
    return dot / math.sqrt(na * nb)


def match_targets(
    peaks: Sequence[dict[str, Any]],
    targets: Sequence[dict[str, Any]],
    *,
    mz_tolerance: float = DEFAULT_MZ_TOLERANCE,
    spectrum_threshold: float = DEFAULT_SPECTRUM_COSINE_THRESHOLD,
) -> dict[str, Any]:
    """Match peaks to named / typed target compounds.

    ``targets`` items: ``{"name": str, "m_z": float | None,
    "spectrum": list[float] | None}`` (m_z and spectrum optional).
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
        # 3. DAD-UV spectrum cosine-similarity match (UV-only fallback)
        t_spec = _as_spectrum_vector(t.get("spectrum"))
        if t_spec is not None:
            best_spec: dict[str, Any] | None = None
            best_cos = spectrum_threshold
            for p in peaks:
                if id(p) in used_ids:
                    continue
                p_spec = _as_spectrum_vector(p.get("spectrum"))
                if p_spec is None:
                    continue
                cos = _cosine_similarity(t_spec, p_spec)
                if cos is not None and cos >= best_cos:
                    best_spec, best_cos = p, cos
            if best_spec is not None:
                matched[tname] = best_spec
                used_ids.add(id(best_spec))
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
    spectrum_threshold: float = DEFAULT_SPECTRUM_COSINE_THRESHOLD,
) -> tuple[list[dict[str, Any]], str]:
    """Return (peaks_to_use, confidence).

    When ``targets`` is given, returns just the matched target peaks
    (so resolution is computed over the target set); confidence reflects
    whether all targets were found. When ``targets`` is None/empty, returns
    all peaks (unknown-impurity mode) with confidence "high".
    """
    if not targets:
        return list(peaks), "high"
    m = match_targets(
        peaks, targets,
        mz_tolerance=mz_tolerance, spectrum_threshold=spectrum_threshold,
    )
    return list(m["matched"].values()), m["confidence"]
