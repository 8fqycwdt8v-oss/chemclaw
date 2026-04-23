"""reaction_vectorizer — DRFP projector.

Subscribes to `experiment_imported` events. For each reaction in the
experiment with a non-null rxn_smiles and a null drfp_vector, computes a
DRFP fingerprint via mcp-drfp and writes it to reactions.drfp_vector.

Idempotent: skips reactions that already have a vector.

Error policy:
  - 4xx from mcp-drfp (bad SMILES, etc.) → WARN + skip that reaction; the
    event is still acked. We never retry malformed data.
  - 5xx or network → raise; the event is NOT acked, retry on next NOTIFY.
"""

from __future__ import annotations

import asyncio
import logging
from typing import Any

import httpx
import psycopg
from psycopg.rows import dict_row
from pydantic_settings import SettingsConfigDict

from services.mcp_tools.common.logging import configure_logging
from services.projectors.common.base import BaseProjector, ProjectorSettings

log = logging.getLogger("projector.reaction_vectorizer")


class Settings(ProjectorSettings):
    model_config = SettingsConfigDict(env_file=".env", extra="ignore")
    mcp_drfp_url: str = "http://localhost:8002"
    drfp_n_bits: int = 2048
    drfp_radius: int = 3


class _BadSmilesError(Exception):
    """Permanent failure for a single reaction's rxn_smiles."""


class ReactionVectorizerProjector(BaseProjector):
    name = "reaction_vectorizer"
    interested_event_types = ("experiment_imported",)

    def __init__(self, settings: Settings) -> None:
        super().__init__(settings)
        self._s: Settings = settings
        self._client = httpx.AsyncClient(timeout=30.0)

    async def aclose(self) -> None:
        await self._client.aclose()

    async def handle(
        self,
        *,
        event_id: str,
        event_type: str,  # noqa: ARG002 — enforced by interested_event_types
        source_table: str | None,
        source_row_id: str | None,
        payload: dict[str, Any],  # noqa: ARG002
    ) -> None:
        if source_table != "experiments" or not source_row_id:
            return

        async with await psycopg.AsyncConnection.connect(
            self._s.postgres_dsn, row_factory=dict_row
        ) as conn:
            async with conn.cursor() as cur:
                await cur.execute(
                    """
                    SELECT id::text AS id, rxn_smiles
                      FROM reactions
                     WHERE experiment_id = %s::uuid
                       AND rxn_smiles IS NOT NULL
                       AND drfp_vector IS NULL
                    """,
                    (source_row_id,),
                )
                rows = await cur.fetchall()

            if not rows:
                log.debug("event %s: nothing to vectorize", event_id)
                return

            vectors: list[tuple[str, str]] = []
            for row in rows:
                try:
                    vec = await self._compute(row["rxn_smiles"])
                except _BadSmilesError:
                    # Permanent: log without echoing the SMILES (IP-safety).
                    log.warning(
                        "drfp rejected rxn for reaction %s (permanent, skipped)",
                        row["id"],
                    )
                    continue
                vectors.append((row["id"], vec))

            if not vectors:
                return

            async with conn.cursor() as cur:
                for rxn_id, vec_literal in vectors:
                    await cur.execute(
                        "UPDATE reactions SET drfp_vector = %s::vector WHERE id = %s::uuid",
                        (vec_literal, rxn_id),
                    )
            await conn.commit()
            log.info("event %s: vectorized %d reactions", event_id, len(vectors))

    async def _compute(self, rxn_smiles: str) -> str:
        """Call mcp-drfp; return a Postgres vector literal like '[0,1,0,...]'.

        Raises `_BadSmilesError` on 4xx (permanent), propagates on 5xx/network
        (transient — caller will retry).
        """
        try:
            r = await self._client.post(
                f"{self._s.mcp_drfp_url}/tools/compute_drfp",
                json={
                    "rxn_smiles": rxn_smiles,
                    "n_folded_length": self._s.drfp_n_bits,
                    "radius": self._s.drfp_radius,
                },
            )
        except httpx.HTTPError:
            # Transient: propagate so the event retries.
            raise

        if 400 <= r.status_code < 500:
            raise _BadSmilesError(f"mcp-drfp rejected input (status {r.status_code})")
        r.raise_for_status()
        body = r.json()
        vec: list[int] = body["vector"]
        if len(vec) != self._s.drfp_n_bits:
            raise _BadSmilesError(f"unexpected vector length: {len(vec)}")
        return "[" + ",".join(str(int(b)) for b in vec) + "]"


async def amain() -> None:
    settings = Settings()
    configure_logging(settings.projector_log_level)
    projector = ReactionVectorizerProjector(settings)
    try:
        await projector.run()
    finally:
        await projector.aclose()


if __name__ == "__main__":
    asyncio.run(amain())
