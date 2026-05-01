"""Three-tier conditions extractor.

Tier 1: direct JSONB copy from experiments.tabular_data + mock_eln.fields_jsonb
Tier 2: bounded regex over experiments.procedure_text
Tier 3: LiteLLM-Haiku fallback for residual freetext (in llm_prompt.py)

All tiers are pure functions — no DB, no network. The projector orchestrates
them and persists the union.

Output shape:
    {
        "solvent": str | None,
        "solvent_smiles": str | None,
        "catalyst_smiles": str | None,
        "ligand_smiles": str | None,
        "base": str | None,
        "temperature_c": float | None,
        "time_min": float | None,
        "pressure_atm": float | None,
        "atmosphere": str | None,           # 'air' | 'N2' | 'Ar' | 'O2'
        "stoichiometry_json": dict | None,
        "_status": {field: {"status": "extracted"|"absent"|"ambiguous", "source": ...}}
    }
"""
from __future__ import annotations

import re
from datetime import datetime, timezone
from typing import Any

# Allowed string values for atmosphere column
_ATMOSPHERE_CANONICAL = {
    "air":      "air",
    "n2":       "N2",
    "nitrogen": "N2",
    "ar":       "Ar",
    "argon":    "Ar",
    "o2":       "O2",
    "oxygen":   "O2",
}

_FIELDS = (
    "solvent", "solvent_smiles", "catalyst_smiles", "ligand_smiles",
    "base", "temperature_c", "time_min", "pressure_atm", "atmosphere",
    "stoichiometry_json",
)

# Cap to defend against catastrophic input. Bounded regex by construction;
# this is defense-in-depth.
MAX_PROCEDURE_TEXT_LEN = 100_000


def _now_iso() -> str:
    return datetime.now(tz=timezone.utc).isoformat()


def _canonical_atmosphere(raw: Any) -> str | None:
    if not isinstance(raw, str):
        return None
    return _ATMOSPHERE_CANONICAL.get(raw.strip().lower())


def _coerce_float(raw: Any) -> float | None:
    if raw is None:
        return None
    if isinstance(raw, bool):
        # bool is a subclass of int in Python — explicitly reject.
        return None
    try:
        return float(raw)
    except (TypeError, ValueError):
        return None


def _empty_result() -> dict[str, Any]:
    return {f: None for f in _FIELDS} | {"_status": {}}


def _read_field(
    src: dict[str, Any],
    keys: tuple[str, ...],
) -> Any:
    """Return the first non-None value for any key in `keys`, else None."""
    for k in keys:
        if k in src and src[k] is not None:
            return src[k]
    return None


# ---------------------------------------------------------------------------
# Tier 1 — direct JSONB copy
# ---------------------------------------------------------------------------

def extract_tier1(
    tabular_data: dict[str, Any] | None,
    mock_eln_fields: dict[str, Any] | None,
) -> dict[str, Any]:
    """Direct JSONB copy from tabular_data + mock_eln fields_jsonb.

    tabular_data wins when both sources have a value (canonical column;
    mock_eln_fields_jsonb is the dev-mode mirror). When neither has a value,
    the field is left null and recorded as `absent` in `_status`.
    """
    result = _empty_result()
    if not isinstance(tabular_data, dict):
        tabular_data = {}
    if not isinstance(mock_eln_fields, dict):
        mock_eln_fields = {}

    sources = [
        ("tabular_data", tabular_data),
        ("mock_eln_fields_jsonb", mock_eln_fields),
    ]

    string_keys = {
        "solvent":         ("solvent",),
        "solvent_smiles":  ("solvent_smiles",),
        "catalyst_smiles": ("catalyst_smiles",),
        "ligand_smiles":   ("ligand_smiles",),
        "base":            ("base",),
    }
    float_keys = {
        "temperature_c": ("temperature_c", "temp_c", "temp"),
        "time_min":      ("time_min", "time_minutes"),
        "pressure_atm":  ("pressure_atm",),
    }

    def _record(field: str, source: str) -> None:
        result["_status"][field] = {
            "status": "extracted",
            "source": source,
            "extracted_at": _now_iso(),
        }

    def _record_absent(field: str) -> None:
        result["_status"][field] = {"status": "absent"}

    # String fields
    for field, keys in string_keys.items():
        found = False
        for source_name, src in sources:
            val = _read_field(src, keys)
            if isinstance(val, str) and val.strip():
                result[field] = val
                _record(field, source_name)
                found = True
                break
        if not found:
            _record_absent(field)

    # Float-typed fields
    for field, keys in float_keys.items():
        found = False
        for source_name, src in sources:
            raw = _read_field(src, keys)
            coerced = _coerce_float(raw)
            if coerced is not None:
                result[field] = coerced
                _record(field, source_name)
                found = True
                break
        if not found:
            _record_absent(field)

    # Atmosphere — special-cased canonicalization
    found = False
    for source_name, src in sources:
        raw = _read_field(src, ("atmosphere",))
        canon = _canonical_atmosphere(raw)
        if canon is not None:
            result["atmosphere"] = canon
            _record("atmosphere", source_name)
            found = True
            break
    if not found:
        _record_absent("atmosphere")

    # Stoichiometry — copy as-is if it's a dict
    found = False
    for source_name, src in sources:
        raw = _read_field(src, ("stoichiometry_json", "stoichiometry", "equivalents"))
        if isinstance(raw, dict):
            result["stoichiometry_json"] = raw
            _record("stoichiometry_json", source_name)
            found = True
            break
    if not found:
        _record_absent("stoichiometry_json")

    return result


# ---------------------------------------------------------------------------
# Tier 2 — bounded regex over procedure_text
# ---------------------------------------------------------------------------

# Common solvent names. lowercase pattern → canonical name.
_KNOWN_SOLVENTS: dict[str, str] = {
    "ethanol":           "Ethanol",
    "etoh":              "Ethanol",
    "isopropanol":       "Isopropanol",
    "iproh":             "Isopropanol",
    "methanol":          "Methanol",
    "meoh":              "Methanol",
    "water":             "Water",
    "thf":               "THF",
    "2-methf":           "2-MeTHF",
    "2-methyltetrahydrofuran": "2-MeTHF",
    "ethyl acetate":     "EtOAc",
    "etoac":             "EtOAc",
    "dcm":               "DCM",
    "dichloromethane":   "DCM",
    "chloroform":        "Chloroform",
    "hexane":            "Hexane",
    "heptane":           "Heptane",
    "toluene":           "Toluene",
    "dmf":               "DMF",
    "dimethylformamide": "DMF",
    "dmac":              "DMAc",
    "dmso":              "DMSO",
    "dimethylsulfoxide": "DMSO",
    "acetonitrile":      "Acetonitrile",
    "mecn":              "Acetonitrile",
    "acetone":           "Acetone",
    "1,4-dioxane":       "1,4-Dioxane",
    "dioxane":           "1,4-Dioxane",
    "diethyl ether":     "DEE",
    "et2o":              "DEE",
    "nmp":               "NMP",
    "n-methylpyrrolidone": "NMP",
}

# All quantifiers explicit-bounded; defends against catastrophic backtracking
# per CLAUDE.md.
_RE_TEMP = re.compile(
    r"\b(?:at|to|reflux\s+at)\s+(?P<temp>-?\d{1,3}(?:\.\d{1,2})?)\s*°?\s*C\b",
    re.IGNORECASE,
)
_RE_TIME_HOURS = re.compile(
    r"\bfor\s+(?P<n>\d{1,3}(?:\.\d{1,2})?)\s*(?:h|hours?|hr)\b",
    re.IGNORECASE,
)
_RE_TIME_MINUTES = re.compile(
    r"\bfor\s+(?P<n>\d{1,3})\s*(?:min|minutes?)\b",
    re.IGNORECASE,
)
_RE_ATMOSPHERE = re.compile(
    r"\b(?:under|in)\s+(?P<atm>nitrogen|argon|air|oxygen|N2|Ar|O2)\b",
    re.IGNORECASE,
)


def _build_solvent_pattern() -> re.Pattern[str]:
    keys = sorted(_KNOWN_SOLVENTS.keys(), key=len, reverse=True)
    escaped = [re.escape(k) for k in keys]
    return re.compile(r"\b(" + "|".join(escaped) + r")\b", re.IGNORECASE)


_RE_SOLVENT = _build_solvent_pattern()


def extract_tier2(procedure_text: str | None) -> dict[str, Any]:
    """Bounded regex over procedure_text; returns same shape as Tier 1."""
    result = _empty_result()
    if not isinstance(procedure_text, str):
        for f in _FIELDS:
            result["_status"][f] = {"status": "absent"}
        return result
    if len(procedure_text) > MAX_PROCEDURE_TEXT_LEN:
        for f in _FIELDS:
            result["_status"][f] = {"status": "absent"}
        return result

    def _record(field: str) -> None:
        result["_status"][field] = {
            "status": "extracted",
            "source": "regex",
            "extracted_at": _now_iso(),
        }

    def _record_absent(field: str) -> None:
        result["_status"][field] = {"status": "absent"}

    # Temperature
    m = _RE_TEMP.search(procedure_text)
    if m:
        result["temperature_c"] = float(m.group("temp"))
        _record("temperature_c")
    else:
        _record_absent("temperature_c")

    # Time — hours dominate over minutes if both present.
    m_h = _RE_TIME_HOURS.search(procedure_text)
    m_m = _RE_TIME_MINUTES.search(procedure_text)
    if m_h:
        result["time_min"] = float(m_h.group("n")) * 60.0
        _record("time_min")
    elif m_m:
        result["time_min"] = float(m_m.group("n"))
        _record("time_min")
    else:
        _record_absent("time_min")

    # Atmosphere
    m = _RE_ATMOSPHERE.search(procedure_text)
    if m:
        canon = _canonical_atmosphere(m.group("atm"))
        if canon:
            result["atmosphere"] = canon
            _record("atmosphere")
        else:
            _record_absent("atmosphere")
    else:
        _record_absent("atmosphere")

    # Solvent
    m = _RE_SOLVENT.search(procedure_text)
    if m:
        canonical = _KNOWN_SOLVENTS[m.group(1).lower()]
        result["solvent"] = canonical
        _record("solvent")
    else:
        _record_absent("solvent")

    # Fields not extracted by Tier 2 — leave null, mark absent.
    for f in ("solvent_smiles", "catalyst_smiles", "ligand_smiles", "base",
              "pressure_atm", "stoichiometry_json"):
        _record_absent(f)

    return result


# ---------------------------------------------------------------------------
# Compose three tiers
# ---------------------------------------------------------------------------

_FIELDS_COMPOSE = (
    "solvent", "solvent_smiles", "catalyst_smiles", "ligand_smiles",
    "base", "temperature_c", "time_min", "pressure_atm", "atmosphere",
    "stoichiometry_json",
)
_SOURCE_PRIORITY = {
    "tabular_data": 0,
    "mock_eln_fields_jsonb": 1,
    "regex": 2,
    "llm": 3,
}


def compose_extractions(
    tier1: dict[str, Any] | None,
    tier2: dict[str, Any] | None,
    tier3: dict[str, Any] | None,
) -> dict[str, Any]:
    """Merge three tiers, earliest-wins. Returns a single dict ready to write
    to `reactions`.

    Output:
        {field: value | None, ...,
         "extraction_status": {field: {"status": ..., "source": ..., ...}},
         "conditions_extracted_from": "tabular_data"|"mock_eln_fields_jsonb"|
                                      "regex"|"llm"|"none"}
    """
    out: dict[str, Any] = {f: None for f in _FIELDS_COMPOSE}
    out["extraction_status"] = {}

    tiers = [t for t in (tier1, tier2, tier3) if isinstance(t, dict)]

    for f in _FIELDS_COMPOSE:
        chosen = False
        for t in tiers:
            value = t.get(f)
            if value is not None:
                out[f] = value
                status = t.get("_status", {}).get(f, {"status": "extracted"})
                out["extraction_status"][f] = status
                chosen = True
                break
        if not chosen:
            statuses = [t.get("_status", {}).get(f, {"status": "absent"}) for t in tiers]
            ambiguous = [s for s in statuses if s.get("status") == "ambiguous"]
            out["extraction_status"][f] = ambiguous[0] if ambiguous else {"status": "absent"}

    # conditions_extracted_from = highest-priority source that contributed any value
    sources_used = [
        out["extraction_status"][f].get("source")
        for f in _FIELDS_COMPOSE
        if out["extraction_status"][f].get("status") == "extracted"
    ]
    sources_used = [s for s in sources_used if s in _SOURCE_PRIORITY]
    if sources_used:
        out["conditions_extracted_from"] = min(
            sources_used, key=lambda s: _SOURCE_PRIORITY[s]
        )
    else:
        out["conditions_extracted_from"] = "none"

    return out
