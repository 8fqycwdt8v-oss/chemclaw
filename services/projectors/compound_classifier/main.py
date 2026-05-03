"""compound_classifier projector — assigns roles + chemotype families.

Subscribes to `pg_notify('compound_fingerprinted', inchikey)` (emitted by
the compound_fingerprinter projector after Morgan/MACCS/AP vectors and
substructure hits land). For each compound:

  1. Walk every enabled `compound_classes` rule by ascending priority.
  2. A class matches when EVERY one of its `smarts_rule_names` has at
     least one corresponding row in `compound_substructure_hits`.
  3. Confidence = clamp(1.0 - 0.1 * (priority/100), 0.5, 1.0). Rules with
     priority < 100 get full confidence; long-tail catch-alls degrade.
  4. Insert/upsert into `compound_class_assignments` with `valid_to=NULL`.
     Assignments that were live but no longer match get their `valid_to`
     stamped — preserves the bi-temporal trail.
"""

from __future__ import annotations

import asyncio
import logging
from typing import Any

import psycopg
from psycopg.rows import dict_row

from services.mcp_tools.common.logging import configure_logging
from services.projectors.common.base import (
    BaseProjector,
    PermanentHandlerError,
    ProjectorSettings,
)


log = logging.getLogger("compound_classifier")
_NOTIFY_CHANNEL = "compound_fingerprinted"


class CompoundClassifier(BaseProjector):
    name = "compound_classifier"
    interested_event_types = ()

    async def _connect_and_run(self) -> None:
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
                await self._listen_loop_classes(listen_conn, work_conn)

    async def _catch_up(self, work_conn: psycopg.AsyncConnection) -> None:
        # Re-classify every compound that has fingerprints but no live class
        # assignment yet. Bounded so a fresh image doesn't churn for hours.
        async with work_conn.cursor() as cur:
            await cur.execute(
                """
                SELECT c.inchikey
                  FROM compounds c
                 WHERE c.fp_version IS NOT NULL
                   AND NOT EXISTS (
                     SELECT 1 FROM compound_class_assignments a
                      WHERE a.inchikey = c.inchikey AND a.valid_to IS NULL
                   )
                 LIMIT 1000
                """
            )
            rows = await cur.fetchall()
        for row in rows:
            if self._shutdown.is_set():
                return
            try:
                await self._classify(work_conn, row["inchikey"])
            except Exception:
                log.exception("[%s] catch-up classify failed for %s", self.name, row["inchikey"])

    async def _listen_loop_classes(
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
                    if inchikey:
                        try:
                            await self._classify(work_conn, inchikey)
                        except Exception:
                            log.exception("[%s] classify failed for %s", self.name, inchikey)
        finally:
            if next_notify_task and not next_notify_task.done():
                next_notify_task.cancel()
            if not shutdown_task.done():
                shutdown_task.cancel()

    async def handle(  # pragma: no cover
        self, *, event_id, event_type, source_table, source_row_id, payload,
    ) -> None:
        return None

    async def _classify(self, work_conn: psycopg.AsyncConnection, inchikey: str) -> None:
        async with work_conn.cursor() as cur:
            # Determine which classes match this compound.
            await cur.execute(
                """
                WITH live_hits AS (
                  SELECT sc.name AS rule_name
                    FROM compound_substructure_hits h
                    JOIN compound_smarts_catalog sc ON sc.id = h.smarts_id
                   WHERE h.inchikey = %s
                ),
                classes AS (
                  SELECT cc.id, cc.name, cc.priority,
                         cc.smarts_rule_names,
                         (SELECT count(*) FROM live_hits lh
                            WHERE lh.rule_name = ANY (cc.smarts_rule_names)
                         ) AS matched_count,
                         array_length(cc.smarts_rule_names, 1) AS required_count
                    FROM compound_classes cc
                   WHERE cc.enabled = TRUE
                )
                SELECT id, name, priority,
                       matched_count >= COALESCE(required_count, 0) AS class_matches
                  FROM classes
                """,
                (inchikey,),
            )
            class_rows = await cur.fetchall()

            matched_class_ids = [
                r["id"] for r in class_rows
                if r["class_matches"]
            ]
            unmatched_class_ids = [
                r["id"] for r in class_rows
                if not r["class_matches"]
            ]

            # Close any live assignments that no longer match.
            if unmatched_class_ids:
                await cur.execute(
                    """
                    UPDATE compound_class_assignments
                       SET valid_to = NOW()
                     WHERE inchikey = %s
                       AND class_id = ANY(%s::uuid[])
                       AND valid_to IS NULL
                    """,
                    (inchikey, unmatched_class_ids),
                )

            # Insert (or refresh) live assignments for new matches.
            for r in class_rows:
                if not r["class_matches"]:
                    continue
                # Confidence: 1.0 for priority <=10, 0.85 for <=50, 0.6 for >100.
                priority = int(r["priority"])
                if priority <= 10:
                    conf = 1.0
                elif priority <= 50:
                    conf = 0.85
                elif priority <= 100:
                    conf = 0.7
                else:
                    conf = 0.5
                await cur.execute(
                    """
                    INSERT INTO compound_class_assignments
                      (inchikey, class_id, confidence, evidence, valid_from, valid_to)
                    SELECT %s, %s::uuid, %s, '{}'::jsonb, NOW(), NULL
                    WHERE NOT EXISTS (
                      SELECT 1 FROM compound_class_assignments a
                       WHERE a.inchikey = %s AND a.class_id = %s::uuid
                         AND a.valid_to IS NULL
                    )
                    """,
                    (inchikey, r["id"], conf, inchikey, r["id"]),
                )
        await work_conn.commit()
        log.info(
            "[%s] classified %s → %d classes",
            self.name, inchikey, len(matched_class_ids),
            extra={"event": "compound_classified", "inchikey": inchikey,
                   "n_classes": len(matched_class_ids)},
        )


def main() -> None:
    settings = ProjectorSettings()
    configure_logging(settings.projector_log_level, service="compound_classifier")
    projector = CompoundClassifier(settings)
    asyncio.run(projector.run())


if __name__ == "__main__":
    main()
