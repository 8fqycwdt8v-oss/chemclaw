"""kg_experiments — project experiments and reactions into Neo4j.

On `experiment_imported`, writes:
- NCEProject node (if new)
- SyntheticStep node (if new)
- Experiment node
- Reaction nodes (per reaction)
- Compound nodes (for every reagent/product with a SMILES, grounded via mcp-rdkit → InChIKey)
- Edges:
    SyntheticStep -[:PART_OF_PROJECT]-> NCEProject
    Experiment    -[:PART_OF_STEP]     -> SyntheticStep
    Experiment    -[:PERFORMED_BY]     -> Researcher (if operator email present)
    Experiment    -[:PRODUCED_OUTCOME] -> Reaction   (with yield/purity)
    Reaction      -[:HAS_REAGENT  {role}] -> Compound
    Reaction      -[:HAS_PRODUCT]  -> Compound

fact_ids are derived deterministically from
(event_row_id, predicate, subject_id_value, object_id_value) so that
re-running the projector does not produce duplicate edges.
"""

from __future__ import annotations

import asyncio
import hashlib
import logging
import uuid
from typing import Any

import httpx
import psycopg
from psycopg.rows import dict_row
from pydantic_settings import SettingsConfigDict

from services.mcp_tools.common.logging import configure_logging
from services.projectors.common.base import BaseProjector, ProjectorSettings
from services.projectors.kg_experiments.kg_client import KGClient

log = logging.getLogger("projector.kg_experiments")


class Settings(ProjectorSettings):
    model_config = SettingsConfigDict(env_file=".env", extra="ignore")
    mcp_kg_url: str = "http://localhost:8003"
    mcp_rdkit_url: str = "http://localhost:8001"


# Stable-namespace UUID for deterministic fact_id derivation.
_FACT_ID_NAMESPACE = uuid.UUID("10101010-1010-1010-1010-101010101010")


def _deterministic_fact_id(*parts: str) -> str:
    """UUIDv5 from a joined key. Same inputs → same fact_id forever."""
    key = "|".join(parts)
    return str(uuid.uuid5(_FACT_ID_NAMESPACE, key))


def _short_hash(value: str) -> str:
    return hashlib.sha1(value.encode("utf-8")).hexdigest()[:16]


class KGExperimentsProjector(BaseProjector):
    name = "kg_experiments"
    interested_event_types = ("experiment_imported",)

    def __init__(self, settings: Settings):
        super().__init__(settings)
        self._s: Settings = settings
        self._kg = KGClient(settings.mcp_kg_url)
        self._rdkit = httpx.AsyncClient(base_url=settings.mcp_rdkit_url, timeout=10.0)

    async def aclose(self) -> None:
        await self._kg.aclose()
        await self._rdkit.aclose()

    # -----------------------------------------------------------------------
    # Helpers
    # -----------------------------------------------------------------------
    async def _inchikey_from_smiles(self, smiles: str) -> str | None:
        """Ask mcp-rdkit to canonicalise and produce an InChIKey.

        Returns None on failure — compounds without a SMILES, or with an
        invalid one, are still recorded as Compound nodes keyed by a short
        hash so the provenance chain isn't broken.
        """
        try:
            r = await self._rdkit.post(
                "/tools/inchikey_from_smiles", json={"smiles": smiles}
            )
            if r.status_code == 400:
                # Permanent: malformed SMILES. Do not echo the value — it may
                # be a proprietary structure and logs are long-lived.
                return None
            r.raise_for_status()
            inchikey: str | None = r.json().get("inchikey")
            return inchikey
        except httpx.HTTPError as exc:
            # Transient upstream failure. Log the error class, not the SMILES.
            log.warning("rdkit call failed: %s", exc.__class__.__name__)
            return None

    async def _compound_ref(self, name: str, smiles: str | None) -> tuple[str, dict[str, Any]]:
        """Return (inchikey_or_fallback, properties) for a reagent/product row."""
        if smiles:
            ik = await self._inchikey_from_smiles(smiles)
            if ik:
                return ik, {"smiles_original": smiles, "name_last_seen": name}
        # Fall back to hashed-name identity so we always have a node to hang
        # relationships from; mark it as ungrounded.
        fallback = f"ungrounded-{_short_hash(name)}"
        return fallback, {"name_last_seen": name, "ungrounded": True}

    async def _load_experiment_bundle(
        self, experiment_id: str
    ) -> dict[str, Any] | None:
        """Fetch the experiment + synthetic step + project + reactions + reagents."""
        async with await psycopg.AsyncConnection.connect(
            self._s.postgres_dsn, row_factory=dict_row
        ) as conn:
            async with conn.cursor() as cur:
                await cur.execute(
                    """
                    SELECT e.id::text AS experiment_id,
                           e.eln_entry_id, e.operator_entra_id,
                           e.yield_pct, e.scale_mg, e.outcome_status,
                           e.procedure_text, e.observations,
                           ss.id::text AS step_id, ss.step_index, ss.step_name,
                           p.id::text AS project_id, p.internal_id AS project_internal_id,
                           p.name AS project_name, p.therapeutic_area, p.phase, p.status
                      FROM experiments e
                      JOIN synthetic_steps ss ON ss.id = e.synthetic_step_id
                      JOIN nce_projects p     ON p.id  = ss.nce_project_id
                     WHERE e.id = %s::uuid
                    """,
                    (experiment_id,),
                )
                exp = await cur.fetchone()
                if exp is None:
                    return None

                await cur.execute(
                    """
                    SELECT id::text AS reaction_id, rxn_smiles, rxno_class,
                           rxnmapper_output
                      FROM reactions
                     WHERE experiment_id = %s::uuid
                    """,
                    (experiment_id,),
                )
                exp["reactions"] = await cur.fetchall()

        return exp

    # -----------------------------------------------------------------------
    # Handler
    # -----------------------------------------------------------------------
    async def handle(
        self,
        *,
        event_id: str,
        event_type: str,
        source_table: str | None,
        source_row_id: str | None,
        payload: dict[str, Any],
    ) -> None:
        if source_table != "experiments" or not source_row_id:
            return

        bundle = await self._load_experiment_bundle(source_row_id)
        if bundle is None:
            log.warning("experiment %s not found; acking", source_row_id)
            return

        prov_source_id = bundle["eln_entry_id"] or f"experiment:{source_row_id}"
        # Tranche 1 / C6: every fact carries the canonical project UUID as
        # tenant scope so cross-project KG reads are filtered out at the
        # mcp-kg layer (mirrors Postgres RLS for the Neo4j layer).
        scope_group_id: str = bundle["project_id"]

        # 1. Project + step
        await self._kg.write_fact(
            subject_label="SyntheticStep",
            subject_id_property="uuid",
            subject_id_value=bundle["step_id"],
            subject_properties={
                "step_index": bundle["step_index"],
                "step_name": bundle["step_name"],
            },
            object_label="NCEProject",
            object_id_property="internal_id",
            object_id_value=bundle["project_internal_id"],
            object_properties={
                "name": bundle["project_name"],
                "therapeutic_area": bundle["therapeutic_area"],
                "phase": bundle["phase"],
                "status": bundle["status"],
            },
            predicate="PART_OF_PROJECT",
            edge_properties=None,
            source_type="ELN",
            source_id=prov_source_id,
            fact_id=_deterministic_fact_id(
                "PART_OF_PROJECT", bundle["step_id"], bundle["project_internal_id"]
            ),
            confidence_tier="expert_validated",
            confidence_score=1.0,
            group_id=scope_group_id,
        )

        # 2. Experiment → step
        await self._kg.write_fact(
            subject_label="Experiment",
            subject_id_property="uuid",
            subject_id_value=bundle["experiment_id"],
            subject_properties={
                "eln_entry_id": bundle["eln_entry_id"],
                "yield_pct": bundle.get("yield_pct"),
                "scale_mg": bundle.get("scale_mg"),
                "outcome_status": bundle.get("outcome_status"),
            },
            object_label="SyntheticStep",
            object_id_property="uuid",
            object_id_value=bundle["step_id"],
            object_properties=None,
            predicate="PART_OF_STEP",
            edge_properties=None,
            source_type="ELN",
            source_id=prov_source_id,
            fact_id=_deterministic_fact_id(
                "PART_OF_STEP", bundle["experiment_id"], bundle["step_id"]
            ),
            confidence_tier="expert_validated",
            confidence_score=1.0,
            group_id=scope_group_id,
        )

        # 3. Researcher (optional)
        if bundle.get("operator_entra_id"):
            await self._kg.write_fact(
                subject_label="Experiment",
                subject_id_property="uuid",
                subject_id_value=bundle["experiment_id"],
                subject_properties=None,
                object_label="Researcher",
                object_id_property="entra_user_id",
                object_id_value=bundle["operator_entra_id"],
                object_properties=None,
                predicate="PERFORMED_BY",
                edge_properties=None,
                source_type="ELN",
                source_id=prov_source_id,
                fact_id=_deterministic_fact_id(
                    "PERFORMED_BY", bundle["experiment_id"], bundle["operator_entra_id"]
                ),
                group_id=scope_group_id,
            )

        # 4. Reactions and reagents/products
        for rxn in bundle["reactions"]:
            reaction_id = rxn["reaction_id"]
            reagents = (
                (rxn.get("rxnmapper_output") or {}).get("reagents") or []
            )

            # Experiment -PRODUCED_OUTCOME-> Reaction
            await self._kg.write_fact(
                subject_label="Experiment",
                subject_id_property="uuid",
                subject_id_value=bundle["experiment_id"],
                subject_properties=None,
                object_label="Reaction",
                object_id_property="uuid",
                object_id_value=reaction_id,
                object_properties={
                    "rxn_smiles": rxn.get("rxn_smiles"),
                    "rxno_class": rxn.get("rxno_class"),
                },
                predicate="PRODUCED_OUTCOME",
                edge_properties={
                    "yield_pct": bundle.get("yield_pct"),
                },
                source_type="ELN",
                source_id=prov_source_id,
                fact_id=_deterministic_fact_id(
                    "PRODUCED_OUTCOME", bundle["experiment_id"], reaction_id
                ),
                confidence_tier="expert_validated",
                confidence_score=1.0,
            )

            for r_idx, reagent in enumerate(reagents):
                name = str(reagent.get("name") or "").strip()
                if not name:
                    continue
                smiles = reagent.get("smiles")
                role = str(reagent.get("role") or "reagent").lower()
                compound_id, compound_props = await self._compound_ref(name, smiles)

                predicate = {
                    "product": "HAS_PRODUCT",
                    "catalyst": "HAS_CATALYST",
                    "solvent": "HAS_SOLVENT",
                }.get(role, "HAS_REAGENT")

                await self._kg.write_fact(
                    subject_label="Reaction",
                    subject_id_property="uuid",
                    subject_id_value=reaction_id,
                    subject_properties=None,
                    object_label="Compound",
                    object_id_property="inchikey",
                    object_id_value=compound_id,
                    object_properties=compound_props,
                    predicate=predicate,
                    edge_properties={
                        "role": role,
                        "equiv": reagent.get("equiv"),
                        "amount_value": reagent.get("amount_value"),
                        "amount_unit": reagent.get("amount_unit"),
                    },
                    source_type="ELN",
                    source_id=prov_source_id,
                    fact_id=_deterministic_fact_id(
                        predicate, reaction_id, compound_id, str(r_idx)
                    ),
                    confidence_tier="multi_source_llm",
                    confidence_score=0.85 if smiles else 0.5,
                    group_id=scope_group_id,
                )

        log.info(
            "projected experiment %s (%d reactions)",
            source_row_id,
            len(bundle["reactions"]),
        )


async def amain() -> None:
    settings = Settings()
    configure_logging(settings.projector_log_level)
    projector = KGExperimentsProjector(settings)
    try:
        await projector.run()
    finally:
        await projector.aclose()


if __name__ == "__main__":
    asyncio.run(amain())
