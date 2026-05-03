"""conditions_normalizer — promote reaction conditions to first-class columns.

Subscribes to `experiment_imported` events. For each reaction in the experiment,
runs a 3-tier extraction (tabular_data direct copy → bounded regex → LiteLLM
fallback) over experiments.procedure_text + experiments.tabular_data +
mock_eln.entries.fields_jsonb sources, and writes the structured columns plus
per-field extraction_status to the reactions row.

Idempotent: COALESCE on each column + JSONB merge on extraction_status make
re-running over an already-populated row a no-op. Standard replay runbook:
DELETE FROM projection_acks WHERE projector_name='conditions_normalizer'.
"""
from __future__ import annotations

import json
import logging
from contextlib import asynccontextmanager
from typing import Any, AsyncIterator

import psycopg
from psycopg.rows import dict_row
from pydantic_settings import SettingsConfigDict

from services.projectors.common.base import BaseProjector, ProjectorSettings
from services.projectors.conditions_normalizer.extractors import (
    compose_extractions,
    extract_tier1,
    extract_tier2,
)
from services.projectors.conditions_normalizer.llm_prompt import (
    ExtractorSettings,
    extract_via_llm,
)

log = logging.getLogger("projector.conditions_normalizer")


class Settings(ProjectorSettings):
    model_config = SettingsConfigDict(env_file=None, extra="ignore")
    mcp_rdkit_url: str = "http://localhost:8001"
    conditions_normalizer_llm_fallback: bool = True
    litellm_base_url: str = "http://localhost:4000"
    litellm_api_key: str = ""
    agent_model_compactor: str = "claude-haiku-4-5"


_LOAD_CONTEXT_SQL = """
SELECT r.id AS reaction_id,
       r.rxn_smiles,
       e.procedure_text,
       COALESCE(e.tabular_data, '{}'::jsonb) AS tabular_data,
       COALESCE(me_fields.fields_jsonb, '{}'::jsonb) AS mock_eln_fields
  FROM experiments e
  JOIN reactions r ON r.experiment_id = e.id
  LEFT JOIN LATERAL (
      SELECT fields_jsonb FROM mock_eln.entries me
       WHERE me.id::text = e.eln_entry_id
       LIMIT 1
  ) me_fields ON to_regclass('mock_eln.entries') IS NOT NULL
 WHERE e.id = %s
"""

_UPDATE_SQL = """
UPDATE reactions
   SET solvent              = COALESCE(solvent,              %(solvent)s),
       solvent_smiles       = COALESCE(solvent_smiles,       %(solvent_smiles)s),
       catalyst_smiles      = COALESCE(catalyst_smiles,      %(catalyst_smiles)s),
       ligand_smiles        = COALESCE(ligand_smiles,        %(ligand_smiles)s),
       base                 = COALESCE(base,                 %(base)s),
       temperature_c        = COALESCE(temperature_c,        %(temperature_c)s),
       time_min             = COALESCE(time_min,             %(time_min)s),
       pressure_atm         = COALESCE(pressure_atm,         %(pressure_atm)s),
       atmosphere           = COALESCE(atmosphere,           %(atmosphere)s),
       stoichiometry_json   = COALESCE(stoichiometry_json,   %(stoichiometry_json)s::jsonb),
       conditions_extracted_from = COALESCE(conditions_extracted_from, %(extracted_from)s),
       extraction_status    = extraction_status || %(status)s::jsonb
 WHERE id = %(reaction_id)s
"""


class ConditionsNormalizer(BaseProjector):
    name = "conditions_normalizer"
    interested_event_types = ("experiment_imported",)

    def __init__(self, settings: Settings) -> None:
        super().__init__(settings)
        self._settings = settings

    @asynccontextmanager
    async def _open_work_conn(self) -> AsyncIterator[Any]:
        async with await psycopg.AsyncConnection.connect(
            self._settings.postgres_dsn,
            row_factory=dict_row,
        ) as conn:
            yield conn

    async def handle(
        self,
        event_id: Any,
        event_type: str,
        source_table: str | None,
        source_row_id: Any,
        payload: dict[str, Any],
    ) -> None:
        if event_type not in self.interested_event_types:
            return

        experiment_id = payload.get("experiment_id") or source_row_id
        if not experiment_id:
            log.warning("experiment_imported event %s lacks experiment_id", event_id)
            return

        async with self._open_work_conn() as conn:
            async with conn.cursor() as cur:
                await cur.execute(_LOAD_CONTEXT_SQL, (experiment_id,))
                rows = await cur.fetchall()

                for row in rows:
                    await self._normalize_reaction(cur, row)

                await conn.commit()

    async def _normalize_reaction(self, cur: Any, row: dict[str, Any]) -> None:
        # Tier 1
        tier1 = extract_tier1(row.get("tabular_data"), row.get("mock_eln_fields"))

        # Tier 2 — only run if any tier1 slot is empty.
        any_missing_after_t1 = any(
            tier1.get(f) is None
            for f in ("solvent", "temperature_c", "time_min", "atmosphere")
        )
        tier2 = extract_tier2(row.get("procedure_text")) if any_missing_after_t1 else None

        # Tier 3 — only run if LLM enabled AND any slot still missing.
        tier3 = None
        if self._settings.conditions_normalizer_llm_fallback:
            merged_so_far = compose_extractions(tier1, tier2, None)
            still_missing = any(
                merged_so_far.get(f) is None
                for f in ("solvent", "catalyst_smiles", "ligand_smiles", "base",
                          "temperature_c", "time_min", "atmosphere")
            )
            if still_missing:
                ext_settings = ExtractorSettings(
                    litellm_base_url=self._settings.litellm_base_url,
                    litellm_api_key=self._settings.litellm_api_key,
                    agent_model_compactor=self._settings.agent_model_compactor,
                )
                tier3 = await extract_via_llm(row.get("procedure_text"), ext_settings)

        merged = compose_extractions(tier1, tier2, tier3)

        params = {
            "reaction_id":         row["reaction_id"],
            "solvent":             merged.get("solvent"),
            "solvent_smiles":      merged.get("solvent_smiles"),
            "catalyst_smiles":     merged.get("catalyst_smiles"),
            "ligand_smiles":       merged.get("ligand_smiles"),
            "base":                merged.get("base"),
            "temperature_c":       merged.get("temperature_c"),
            "time_min":            merged.get("time_min"),
            "pressure_atm":        merged.get("pressure_atm"),
            "atmosphere":          merged.get("atmosphere"),
            "stoichiometry_json":  json.dumps(merged.get("stoichiometry_json"))
                                       if merged.get("stoichiometry_json") is not None else None,
            "extracted_from":      merged.get("conditions_extracted_from"),
            "status":              json.dumps(merged.get("extraction_status", {})),
        }
        await cur.execute(_UPDATE_SQL, params)


if __name__ == "__main__":
    import asyncio

    from services.mcp_tools.common.logging import configure_logging

    # env_file is already None in the Settings model_config above; no
    # need to pass it again here (mypy rejects the call kwarg).
    settings = Settings()
    configure_logging(settings.projector_log_level)
    proj = ConditionsNormalizer(settings)
    asyncio.run(proj.run())
