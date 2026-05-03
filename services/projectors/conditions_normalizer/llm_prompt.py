"""LLM-based conditions extractor (Tier 3 fallback).

Calls LiteLLM (Haiku tier) with a strict JSON-extraction prompt. Validates
the response with Pydantic before returning. Validation failures or LLM
errors return an empty result with all fields marked 'ambiguous' so the
projector can record provenance and the calling code can decide whether
to retry.
"""
from __future__ import annotations

import json
import logging
from datetime import datetime, timezone
from typing import Any

import litellm
from pydantic import BaseModel, Field, ValidationError
from pydantic_settings import BaseSettings, SettingsConfigDict

log = logging.getLogger("projector.conditions_normalizer.llm")

_MIN_TEXT_LEN = 50
_MAX_TEXT_LEN = 8_000

_SYSTEM_PROMPT = """You extract reaction conditions from procedure freetext.
Return a JSON object with these fields (use null when not stated):
  solvent (str), catalyst_smiles (str), ligand_smiles (str), base (str),
  temperature_c (number), time_min (number), atmosphere (one of "air","N2","Ar","O2").
Do NOT invent values. Do NOT include any prose outside the JSON object.
"""


class ExtractorSettings(BaseSettings):
    model_config = SettingsConfigDict(env_file=None, extra="ignore")
    litellm_base_url: str
    litellm_api_key: str
    agent_model_compactor: str = "claude-haiku-4-5"


class _LLMOutput(BaseModel):
    solvent: str | None = Field(default=None, max_length=200)
    catalyst_smiles: str | None = Field(default=None, max_length=10_000)
    ligand_smiles: str | None = Field(default=None, max_length=10_000)
    base: str | None = Field(default=None, max_length=200)
    temperature_c: float | None = Field(default=None, ge=-100.0, le=500.0)
    time_min: float | None = Field(default=None, ge=0.0, le=10_000.0)
    atmosphere: str | None = None  # validated against canonical set below


_FIELDS_LLM = (
    "solvent", "catalyst_smiles", "ligand_smiles", "base",
    "temperature_c", "time_min", "atmosphere",
)
_ATM_VALID = {"air", "N2", "Ar", "O2"}


def _now_iso() -> str:
    return datetime.now(tz=timezone.utc).isoformat()


def _empty_with_status(status: str, **extra: Any) -> dict[str, Any]:
    """Return all-null result with a uniform status label per field."""
    out: dict[str, Any] = {f: None for f in _FIELDS_LLM}
    out["solvent_smiles"] = None
    out["pressure_atm"] = None
    out["stoichiometry_json"] = None
    out["_status"] = {
        f: {"status": status, **extra} for f in _FIELDS_LLM
    }
    return out


async def extract_via_llm(
    procedure_text: str | None,
    settings: ExtractorSettings,
) -> dict[str, Any]:
    """Run the LLM-tier extractor.

    Skips the LLM call entirely for missing / very-short input — bypass
    is observable via _status[*].status == 'absent'.
    """
    if not isinstance(procedure_text, str) or len(procedure_text) < _MIN_TEXT_LEN:
        return _empty_with_status("absent")

    payload = procedure_text[:_MAX_TEXT_LEN]

    try:
        resp = await litellm.acompletion(
            model=settings.agent_model_compactor,
            api_base=settings.litellm_base_url,
            api_key=settings.litellm_api_key,
            messages=[
                {"role": "system", "content": _SYSTEM_PROMPT},
                {"role": "user", "content": payload},
            ],
            response_format={"type": "json_object"},
            max_tokens=400,
            temperature=0.0,
        )
        raw = resp.choices[0].message.content
    except Exception as exc:  # noqa: BLE001 — broad on purpose for transient failures
        log.warning("LLM call failed: %s", exc)
        return _empty_with_status("ambiguous", source="llm", error="llm_call_failed")

    try:
        parsed = json.loads(raw)
        validated = _LLMOutput.model_validate(parsed)
    except (json.JSONDecodeError, ValidationError) as exc:
        log.warning("LLM output failed validation: %s", exc)
        return _empty_with_status("ambiguous", source="llm", error="validation_failed")

    # Atmosphere extra normalization — Pydantic doesn't enforce the enum.
    atm = validated.atmosphere
    if atm is not None and atm not in _ATM_VALID:
        atm = None

    out: dict[str, Any] = {
        "solvent":         validated.solvent,
        "solvent_smiles":  None,
        "catalyst_smiles": validated.catalyst_smiles,
        "ligand_smiles":   validated.ligand_smiles,
        "base":            validated.base,
        "temperature_c":   validated.temperature_c,
        "time_min":        validated.time_min,
        "pressure_atm":    None,
        "atmosphere":      atm,
        "stoichiometry_json": None,
    }
    out["_status"] = {}
    now = _now_iso()
    for f in _FIELDS_LLM:
        if out[f] is not None:
            out["_status"][f] = {
                "status": "extracted",
                "source": "llm",
                "model": settings.agent_model_compactor,
                "extracted_at": now,
            }
        else:
            out["_status"][f] = {"status": "absent", "source": "llm"}
    return out
