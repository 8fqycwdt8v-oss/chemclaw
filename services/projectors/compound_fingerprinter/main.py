"""compound_fingerprinter projector — populates fingerprint vectors + SMARTS hits.

Subscribes to `pg_notify('compound_changed', inchikey)` (the trigger lives in
db/init/24_compound_fingerprints.sql). For each new/changed compound:

  1. Compute Morgan(r=2,r=3), MACCS, atom-pair fingerprints via mcp-rdkit.
  2. Compute the Bemis-Murcko scaffold via mcp-rdkit.
  3. Iterate compound_smarts_catalog (enabled rules) and write
     compound_substructure_hits rows for every match.
  4. Emit `pg_notify('compound_fingerprinted', inchikey)` so the Phase 4
     classifier projector runs strictly after fingerprints exist.

Idempotent: re-running on the same compound recomputes the same vectors and
upserts the same rows.
"""

from __future__ import annotations

import asyncio
import json
import logging
import os
from typing import Any

import httpx
import psycopg
from psycopg.rows import dict_row

from services.mcp_tools.common.logging import configure_logging
from services.projectors.common.base import (
    BaseProjector,
    PermanentHandlerError,
    ProjectorSettings,
)


log = logging.getLogger("compound_fingerprinter")
_NOTIFY_CHANNEL = "compound_changed"
_OUT_NOTIFY_CHANNEL = "compound_fingerprinted"
_FP_VERSION = "v1"


class CompoundFingerprinterSettings(ProjectorSettings):
    mcp_rdkit_url: str = "http://mcp-rdkit:8001"


class CompoundFingerprinter(BaseProjector):
    """Listens on the custom `compound_changed` NOTIFY channel.

    DR-06 (CLAUDE.md "Required patterns / Projectors") permits a projector
    to bypass the default ingestion_events drive by overriding
    `_connect_and_run`, provided the override documents the custom channel
    name explicitly. We drive off `pg_notify('compound_changed', inchikey)`
    emitted by the trigger in db/init/24_compound_fingerprints.sql — the
    payload is the inchikey directly, NOT an ingestion_events row id.
    `interested_event_types` is therefore empty (the base `_listen_loop`
    is bypassed entirely).
    """

    name = "compound_fingerprinter"
    interested_event_types = ()  # pragma: no cover — class-attr declaration; never exercised by unit tests (custom NOTIFY drives this projector)

    def __init__(self, settings: CompoundFingerprinterSettings) -> None:
        super().__init__(settings)
        self._fp_settings = settings
        self._http: httpx.AsyncClient | None = None

    async def _connect_and_run(self) -> None:
        self._http = httpx.AsyncClient(
            base_url=self._fp_settings.mcp_rdkit_url, timeout=30.0,
        )
        try:
            async with await psycopg.AsyncConnection.connect(
                self.settings.postgres_dsn, autocommit=True, row_factory=dict_row,
            ) as listen_conn:
                async with listen_conn.cursor() as cur:
                    await cur.execute(f"LISTEN {_NOTIFY_CHANNEL}")
                log.info("[%s] LISTEN %s established", self.name, _NOTIFY_CHANNEL)

                async with await psycopg.AsyncConnection.connect(
                    self.settings.postgres_dsn, row_factory=dict_row,
                ) as work_conn:
                    await self._catch_up(work_conn)
                    log.info("[%s] catch-up complete", self.name)
                    await self._listen_loop_compounds(listen_conn, work_conn)
        finally:
            if self._http is not None:
                await self._http.aclose()
                self._http = None

    async def _catch_up(self, work_conn: psycopg.AsyncConnection) -> None:
        async with work_conn.cursor() as cur:
            await cur.execute(
                """
                SELECT inchikey, smiles_canonical
                  FROM compounds
                 WHERE smiles_canonical IS NOT NULL
                   AND (fp_version IS NULL OR fp_version <> %s)
                 LIMIT 1000
                """,
                (_FP_VERSION,),
            )
            rows = await cur.fetchall()
        for row in rows:
            if self._shutdown.is_set():
                return
            try:
                await self._fingerprint(work_conn, row["inchikey"], row["smiles_canonical"])
            except Exception:
                log.exception("[%s] catch-up fingerprint failed for %s", self.name, row["inchikey"])

    async def _listen_loop_compounds(
        self,
        listen_conn: psycopg.AsyncConnection,
        work_conn: psycopg.AsyncConnection,
    ) -> None:
        notify_gen = listen_conn.notifies()
        next_notify_task: asyncio.Task[Any] | None = None
        shutdown_task = asyncio.create_task(self._shutdown.wait(), name="shutdown")
        try:
            while not self._shutdown.is_set():
                if next_notify_task is None or next_notify_task.done():
                    next_notify_task = asyncio.create_task(notify_gen.__anext__())
                done, _pending = await asyncio.wait(
                    {next_notify_task, shutdown_task},
                    timeout=5.0,
                    return_when=asyncio.FIRST_COMPLETED,
                )
                if shutdown_task in done:
                    break
                if next_notify_task in done:
                    try:
                        notify = next_notify_task.result()
                    except StopAsyncIteration:
                        break
                    next_notify_task = None
                    inchikey = (notify.payload or "").strip()
                    if not inchikey:
                        continue
                    smi = await self._fetch_smiles(work_conn, inchikey)
                    if smi:
                        try:
                            await self._fingerprint(work_conn, inchikey, smi)
                        except Exception:
                            log.exception("[%s] fingerprint failed for %s", self.name, inchikey)
        finally:
            if next_notify_task and not next_notify_task.done():
                next_notify_task.cancel()
            if not shutdown_task.done():
                shutdown_task.cancel()

    async def handle(  # pragma: no cover — bypassed
        self, *, event_id, event_type, source_table, source_row_id, payload,
    ) -> None:
        return None

    async def _fetch_smiles(self, work_conn: psycopg.AsyncConnection, inchikey: str) -> str | None:
        async with work_conn.cursor() as cur:
            await cur.execute(
                "SELECT smiles_canonical FROM compounds WHERE inchikey = %s",
                (inchikey,),
            )
            row = await cur.fetchone()
        await work_conn.commit()
        if row is None:
            return None
        return row["smiles_canonical"]

    # --- the actual work -----------------------------------------------------

    async def _fingerprint(
        self, work_conn: psycopg.AsyncConnection, inchikey: str, smiles: str,
    ) -> None:
        if self._http is None:
            raise RuntimeError("http client not initialized")

        # 1. Compute fingerprints in parallel.
        morgan_r2_task = self._morgan(smiles, radius=2, n_bits=2048)
        morgan_r3_task = self._morgan(smiles, radius=3, n_bits=2048)
        maccs_task = self._post_json("/tools/maccs_fingerprint", {"smiles": smiles})
        atompair_task = self._post_json(
            "/tools/atompair_fingerprint", {"smiles": smiles, "n_bits": 2048},
        )
        scaffold_task = self._post_json("/tools/murcko_scaffold", {"smiles": smiles})

        morgan_r2, morgan_r3, maccs, atompair, scaffold = await asyncio.gather(
            morgan_r2_task, morgan_r3_task, maccs_task, atompair_task, scaffold_task,
        )

        # 2. Convert on_bits → dense vector strings (pgvector format).
        morgan_r2_vec = _bits_to_vector(morgan_r2.get("on_bits", []), morgan_r2.get("n_bits", 2048))
        morgan_r3_vec = _bits_to_vector(morgan_r3.get("on_bits", []), morgan_r3.get("n_bits", 2048))
        maccs_vec = _bits_to_vector(maccs.get("on_bits", []), maccs.get("n_bits", 167))
        atompair_vec = _bits_to_vector(atompair.get("on_bits", []), atompair.get("n_bits", 2048))

        # 3. Write fingerprint vectors + scaffold to the compound row.
        async with work_conn.cursor() as cur:
            await cur.execute(
                """
                UPDATE compounds
                   SET morgan_r2 = %s::vector,
                       morgan_r3 = %s::vector,
                       maccs = %s::vector,
                       atompair = %s::vector,
                       scaffold_smiles = %s,
                       scaffold_inchikey = %s,
                       fp_version = %s,
                       fp_computed_at = NOW()
                 WHERE inchikey = %s
                """,
                (
                    morgan_r2_vec, morgan_r3_vec, maccs_vec, atompair_vec,
                    scaffold.get("scaffold_smiles"),
                    scaffold.get("scaffold_inchikey"),
                    _FP_VERSION,
                    inchikey,
                ),
            )

            # 4. Iterate the SMARTS catalog and write hits.
            await cur.execute(
                "SELECT id::text AS id, smarts FROM compound_smarts_catalog WHERE enabled = TRUE"
            )
            rules = await cur.fetchall()

            # Bulk-check via mcp-rdkit's substructure_match (one round-trip per rule).
            for rule in rules:
                try:
                    res = await self._post_json(
                        "/tools/substructure_match",
                        {"query_smarts": rule["smarts"], "target_smiles": smiles},
                    )
                except Exception as exc:  # noqa: BLE001
                    log.warning("[%s] SMARTS rule %s failed: %s", self.name, rule["id"], exc)
                    continue
                count = int(res.get("count", 0))
                if count == 0:
                    # Skip the row to keep the table small; the absence of a row
                    # is treated as "no match" by every consumer.
                    continue
                await cur.execute(
                    """
                    INSERT INTO compound_substructure_hits (inchikey, smarts_id, n_matches, computed_at)
                    VALUES (%s, %s::uuid, %s, NOW())
                    ON CONFLICT (inchikey, smarts_id)
                      DO UPDATE SET n_matches = EXCLUDED.n_matches, computed_at = NOW()
                    """,
                    (inchikey, rule["id"], count),
                )

            # 5. Notify downstream classifier projector.
            await cur.execute("SELECT pg_notify(%s, %s)", (_OUT_NOTIFY_CHANNEL, inchikey))
        await work_conn.commit()

    async def _morgan(self, smiles: str, radius: int, n_bits: int) -> dict[str, Any]:
        return await self._post_json(
            "/tools/morgan_fingerprint",
            {"smiles": smiles, "radius": radius, "n_bits": n_bits},
        )

    async def _post_json(self, path: str, body: dict[str, Any]) -> dict[str, Any]:
        if self._http is None:
            raise RuntimeError("http client not initialized")
        resp = await self._http.post(path, json=body)
        if resp.status_code >= 400:
            raise PermanentHandlerError(
                f"mcp-rdkit {path} {resp.status_code}: {resp.text[:200]}"
            )
        return resp.json()


from services.mcp_tools.common.fingerprint import bits_to_pgvector_literal as _bits_to_vector  # noqa: E402, F401


def main() -> None:
    settings = CompoundFingerprinterSettings()
    configure_logging(settings.projector_log_level, service="compound_fingerprinter")
    projector = CompoundFingerprinter(settings)
    asyncio.run(projector.run())


if __name__ == "__main__":
    main()
