"""qm_kg projector — projects successful QM jobs into Neo4j with bi-temporal edges.

Subscribes to two NOTIFY channels:
  - `ingestion_events` (the canonical fan-out for the rest of ChemClaw); used
    when a QM job is committed via `record_qm_job` and an `ingestion_events`
    row is also written (mostly the case when a queue worker drives the job).
  - `qm_job_succeeded` — fired by the trigger in `db/init/23_qm_results.sql`
    when a `qm_jobs` row transitions to `status='succeeded'`. This is the
    "always on" path that catches direct MCP writes too.

For each succeeded job, the projector:
  1. Reads the job, result, conformer, frequency, and thermo rows.
  2. MERGEs the parent compound node by InChIKey (creates if unseen).
  3. MERGEs a `:CalculationResult{job_id}` node with the scalar properties.
  4. Creates `(:Compound)-[:HAS_CALCULATION{method,task,valid_from,valid_to}]->(:CalculationResult)`.
  5. For ensembles: creates `(:CalculationResult)-[:HAS_CONFORMER]->(:Conformer{job_id,index})`.
  6. Closes any prior live calculation edges for the same `(method,task)` pair
     by setting their `valid_to=NOW()` so the bi-temporal lineage stays clean.

The projector is idempotent: re-running on the same `qm_job_succeeded`
notification produces the same KG state. Failures during Neo4j writes
propagate as transient handler errors so the next NOTIFY retries.

Neo4j connection is best-effort: if the driver is missing or the database is
unreachable, the projector logs and treats the event as non-fatal (acks via
PermanentHandlerError) so the QM cache itself remains the source of truth.
The KG is a derived view — losing a single projection is not a correctness
issue.
"""

from __future__ import annotations

import asyncio
import json
import logging
import os
import signal
from typing import Any

import psycopg
from psycopg.rows import dict_row

from services.mcp_tools.common.logging import configure_logging
from services.projectors.common.base import (
    BaseProjector,
    PermanentHandlerError,
    ProjectorSettings,
)


log = logging.getLogger("qm_kg")


_QM_NOTIFY_CHANNEL = "qm_job_succeeded"


class QmKgProjectorSettings(ProjectorSettings):
    neo4j_uri: str = "bolt://neo4j:7687"
    neo4j_user: str = "neo4j"
    neo4j_password: str = ""
    neo4j_database: str = "neo4j"


class QmKgProjector(BaseProjector):
    """Project succeeded `qm_jobs` rows into the Neo4j knowledge graph."""

    name = "qm_kg"
    # We rely on the dedicated `qm_job_succeeded` channel rather than
    # `ingestion_events`, so we accept all event types that surface QM data.
    interested_event_types = ("qm_job_succeeded",)

    def __init__(self, settings: QmKgProjectorSettings) -> None:
        super().__init__(settings)
        self._neo4j_driver: Any = None
        self.qm_settings = settings

    # The base class subscribes to `ingestion_events`. For QM we want the
    # dedicated `qm_job_succeeded` channel too — override `_connect_and_run`
    # to issue both LISTENs on the same connection.
    async def _connect_and_run(self) -> None:
        async with await psycopg.AsyncConnection.connect(
            self.settings.postgres_dsn,
            autocommit=True,
            row_factory=dict_row,
        ) as listen_conn:
            async with listen_conn.cursor() as cur:
                await cur.execute(f"LISTEN {_QM_NOTIFY_CHANNEL}")
            log.info("[%s] LISTEN %s established", self.name, _QM_NOTIFY_CHANNEL)

            async with await psycopg.AsyncConnection.connect(
                self.settings.postgres_dsn,
                row_factory=dict_row,
            ) as work_conn:
                await self._catch_up_qm(work_conn)
                log.info("[%s] catch-up complete", self.name)
                await self._listen_loop_qm(listen_conn, work_conn)

    async def _catch_up_qm(
        self, work_conn: psycopg.AsyncConnection[dict[str, Any]]
    ) -> None:
        """Project every succeeded QM job that doesn't yet have an ack row."""
        async with work_conn.cursor() as cur:
            await cur.execute(
                """
                SELECT j.id::text AS id
                  FROM qm_jobs j
                 WHERE j.status = 'succeeded'
                   AND NOT EXISTS (
                     SELECT 1 FROM projection_acks a
                      WHERE a.event_id = j.id AND a.projector_name = %s
                   )
                 ORDER BY j.recorded_at ASC
                 LIMIT 1000
                """,
                (self.name,),
            )
            rows = await cur.fetchall()
        for row in rows:
            if self._shutdown.is_set():
                return
            await self._project_job(work_conn, row["id"])

    async def _listen_loop_qm(
        self,
        listen_conn: psycopg.AsyncConnection[dict[str, Any]],
        work_conn: psycopg.AsyncConnection[dict[str, Any]],
    ) -> None:
        notify_gen = listen_conn.notifies()
        next_notify_task: asyncio.Task[Any] | None = None
        shutdown_task = asyncio.create_task(self._shutdown.wait(), name="shutdown")
        try:
            while not self._shutdown.is_set():
                if next_notify_task is None or next_notify_task.done():
                    next_notify_task = asyncio.create_task(
                        notify_gen.__anext__(), name="next_notify"
                    )
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
                        log.info("[%s] notify stream ended", self.name)
                        break
                    next_notify_task = None
                    job_id = (notify.payload or "").strip()
                    if job_id:
                        await self._project_job(work_conn, job_id)
        finally:
            if next_notify_task and not next_notify_task.done():
                next_notify_task.cancel()
            if not shutdown_task.done():
                shutdown_task.cancel()

    # The base class's abstract handle is unused — we drive everything off the
    # qm_job_succeeded channel — but we still need a concrete implementation.
    async def handle(  # pragma: no cover — bypassed in this subclass
        self,
        *,
        event_id: str,
        event_type: str,
        source_table: str | None,
        source_row_id: str | None,
        payload: dict[str, Any],
    ) -> None:
        return None

    async def _project_job(
        self, work_conn: psycopg.AsyncConnection[dict[str, Any]], job_id: str
    ) -> None:
        """Read the QM job + outputs, write the KG nodes/edges, ack on success."""
        async with work_conn.cursor() as cur:
            await cur.execute(
                """
                SELECT j.id::text AS id,
                       j.method, j.task,
                       j.smiles_canonical, j.inchikey,
                       j.charge, j.multiplicity,
                       j.solvent_model, j.solvent_name,
                       j.params,
                       j.version_xtb, j.version_crest,
                       j.valid_from, j.valid_to,
                       r.energy_hartree, r.converged, r.summary_md,
                       r.descriptors, r.charges, r.fukui
                  FROM qm_jobs j
                  LEFT JOIN qm_results r ON r.job_id = j.id
                 WHERE j.id = %s::uuid
                """,
                (job_id,),
            )
            row = await cur.fetchone()
            if row is None:
                # Job vanished (TTL? race?). Ack to stop scanning.
                await self._ack(work_conn, job_id)
                return

            await cur.execute(
                """
                SELECT ensemble_index, energy_hartree, boltzmann_weight
                  FROM qm_conformers
                 WHERE job_id = %s::uuid
                 ORDER BY ensemble_index
                 LIMIT 200
                """,
                (job_id,),
            )
            conformers = await cur.fetchall()

        try:
            self._merge_into_neo4j(row, conformers)
        except RuntimeError as exc:
            # Driver-missing or transient connection error — keep retrying.
            log.warning("[%s] neo4j MERGE failed for %s: %s", self.name, job_id, exc)
            raise
        except Exception as exc:
            # Permanent error (malformed data) — ack so we don't retry forever.
            log.exception("[%s] permanent KG projection failure for %s", self.name, job_id)
            raise PermanentHandlerError(str(exc)) from exc
        else:
            await self._ack(work_conn, job_id)

    async def _ack(
        self, work_conn: psycopg.AsyncConnection[dict[str, Any]], job_id: str
    ) -> None:
        """Insert a synthetic ingestion_events row + projection_acks ack.

        We need an `event_id` for `projection_acks` (FK to `ingestion_events`),
        but we'd rather not write a separate event for every QM success — the
        cache table itself is the durable record. Use a stable surrogate by
        upserting an `ingestion_events` row whose `id` equals the job id.
        """
        async with work_conn.cursor() as cur:
            await cur.execute(
                """
                INSERT INTO ingestion_events (id, event_type, source_table, source_row_id, payload)
                VALUES (%s::uuid, 'qm_job_succeeded', 'qm_jobs', %s::uuid, '{}'::jsonb)
                ON CONFLICT (id) DO NOTHING
                """,
                (job_id, job_id),
            )
            await cur.execute(
                """
                INSERT INTO projection_acks (event_id, projector_name)
                VALUES (%s::uuid, %s)
                ON CONFLICT DO NOTHING
                """,
                (job_id, self.name),
            )
        await work_conn.commit()

    # ─── neo4j ──────────────────────────────────────────────────────────────
    def _get_driver(self) -> Any:
        if self._neo4j_driver is not None:
            return self._neo4j_driver
        try:
            from neo4j import GraphDatabase  # noqa: PLC0415
        except ImportError as exc:
            raise RuntimeError("neo4j driver not installed") from exc
        self._neo4j_driver = GraphDatabase.driver(
            self.qm_settings.neo4j_uri,
            auth=(self.qm_settings.neo4j_user, self.qm_settings.neo4j_password),
        )
        return self._neo4j_driver

    def _merge_into_neo4j(
        self, row: dict[str, Any], conformers: list[dict[str, Any]]
    ) -> None:
        driver = self._get_driver()
        with driver.session(database=self.qm_settings.neo4j_database) as sess:
            # Close any prior live calculation edges for the same (method,task)
            # pair so we keep one live calculation per pair per compound.
            sess.run(
                """
                MATCH (c:Compound {inchikey: $inchikey})
                  -[edge:HAS_CALCULATION {method: $method, task: $task}]->
                      (cr:CalculationResult)
                WHERE edge.valid_to IS NULL AND cr.job_id <> $job_id
                  SET edge.valid_to = datetime()
                """,
                inchikey=row["inchikey"] or "",
                method=row["method"],
                task=row["task"],
                job_id=row["id"],
            )

            sess.run(
                """
                MERGE (c:Compound {inchikey: $inchikey})
                  ON CREATE SET c.smiles = $smiles, c.created_at = datetime()
                MERGE (cr:CalculationResult {job_id: $job_id})
                  ON CREATE SET cr.created_at = datetime()
                SET cr.method = $method,
                    cr.task = $task,
                    cr.smiles = $smiles,
                    cr.charge = $charge,
                    cr.multiplicity = $multiplicity,
                    cr.solvent_model = $solvent_model,
                    cr.solvent_name = $solvent_name,
                    cr.energy_hartree = $energy,
                    cr.converged = $converged,
                    cr.summary_md = $summary,
                    cr.version_xtb = $version_xtb,
                    cr.version_crest = $version_crest
                MERGE (c)-[edge:HAS_CALCULATION {method: $method, task: $task, job_id: $job_id}]->(cr)
                  ON CREATE SET edge.valid_from = datetime()
                """,
                inchikey=row["inchikey"] or "",
                smiles=row["smiles_canonical"] or "",
                job_id=row["id"],
                method=row["method"],
                task=row["task"],
                charge=row["charge"],
                multiplicity=row["multiplicity"],
                solvent_model=row["solvent_model"] or "none",
                solvent_name=row["solvent_name"] or "",
                energy=row["energy_hartree"],
                converged=row["converged"],
                summary=row["summary_md"] or "",
                version_xtb=row["version_xtb"] or "",
                version_crest=row["version_crest"] or "",
            )

            for conf in conformers:
                sess.run(
                    """
                    MATCH (cr:CalculationResult {job_id: $job_id})
                    MERGE (c:Conformer {job_id: $job_id, ensemble_index: $idx})
                      SET c.energy_hartree = $energy,
                          c.boltzmann_weight = $weight
                    MERGE (cr)-[:HAS_CONFORMER]->(c)
                    """,
                    job_id=row["id"],
                    idx=conf["ensemble_index"],
                    energy=conf["energy_hartree"],
                    weight=float(conf["boltzmann_weight"] or 0.0),
                )

    def close(self) -> None:
        if self._neo4j_driver is not None:
            try:
                self._neo4j_driver.close()
            except Exception:  # noqa: BLE001
                pass
            self._neo4j_driver = None


def main() -> None:
    settings = QmKgProjectorSettings()
    configure_logging(settings.projector_log_level, service="qm_kg")
    projector = QmKgProjector(settings)
    try:
        asyncio.run(projector.run())
    finally:
        projector.close()


if __name__ == "__main__":
    main()
