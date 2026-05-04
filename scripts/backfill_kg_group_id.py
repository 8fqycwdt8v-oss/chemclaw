#!/usr/bin/env python3
"""Backfill `group_id` on every Neo4j fact edge that's missing it.

Tranche 1 / C6 (KG refactor): pre-Tranche-1 facts in Neo4j carry no
`group_id` property because the tenant-scope feature didn't exist yet.
This script walks every edge in the KG, derives the canonical project_id
from the related Postgres canonical row, and stamps it on the edge. Edges
where a project can't be recovered get the sentinel value `__legacy__`.

Run order:
  1. Deploy mcp-kg with group_id support.
  2. Stop projectors so no new edges land mid-migration.
  3. `python scripts/backfill_kg_group_id.py`
  4. Restart projectors (they now write with proper group_id).

Idempotency: only updates edges where r.group_id IS NULL. Re-runs are no-ops.

Recovery strategies, in order of preference per provenance.source_type:
  - 'ELN':   look up `experiments.eln_entry_id == provenance.source_id`,
             follow synthetic_steps -> nce_projects.id.
  - 'agent_inference': try to extract a hypothesis_id from edge metadata and
                      look up hypotheses.scope_nce_project_id.
  - everything else: '__legacy__' sentinel.

Environment:
  NEO4J_URI       (required)
  NEO4J_USER      (default: 'neo4j')
  NEO4J_PASSWORD  (required)
  CHEMCLAW_SERVICE_DSN  (required) — chemclaw_service Postgres DSN (BYPASSRLS).
"""

from __future__ import annotations

import argparse
import asyncio
import json
import logging
import os
import sys
from typing import Any

import psycopg
from neo4j import AsyncGraphDatabase

LEGACY_SENTINEL = "__legacy__"
SYSTEM_SENTINEL = "__system__"

log = logging.getLogger("backfill_kg_group_id")


def _ensure_env(name: str) -> str:
    val = os.environ.get(name)
    if not val:
        print(f"error: ${name} is required", file=sys.stderr)
        sys.exit(2)
    return val


async def _resolve_group_id(
    pg: psycopg.AsyncConnection,
    provenance: dict[str, Any] | None,
) -> str:
    """Best-effort recover the canonical project UUID for a fact."""
    if not provenance:
        return LEGACY_SENTINEL
    src_type = provenance.get("source_type")
    src_id = provenance.get("source_id")
    # Guard against malformed pre-existing edges where provenance.source_id
    # was written as a non-string (e.g. an int from a buggy historical writer).
    # Pydantic's SafeStr enforces string-ness on new writes, but this is a
    # backfill against unknown legacy state.
    if not isinstance(src_id, str) or not src_id:
        return LEGACY_SENTINEL

    if src_type == "ELN":
        # source_id is typically the ELN entry id or a synthetic
        # "experiment:<uuid>" string.
        try:
            async with pg.cursor() as cur:
                if src_id.startswith("experiment:"):
                    exp_id = src_id.split(":", 1)[1]
                    await cur.execute(
                        """
                        SELECT ss.nce_project_id::text
                          FROM experiments e
                          JOIN synthetic_steps ss ON ss.id = e.synthetic_step_id
                         WHERE e.id = %s::uuid
                        """,
                        (exp_id,),
                    )
                else:
                    await cur.execute(
                        """
                        SELECT ss.nce_project_id::text
                          FROM experiments e
                          JOIN synthetic_steps ss ON ss.id = e.synthetic_step_id
                         WHERE e.eln_entry_id = %s
                        """,
                        (src_id,),
                    )
                row = await cur.fetchone()
                return row[0] if row else LEGACY_SENTINEL
        except Exception as exc:  # noqa: BLE001 — best effort
            log.warning("ELN recovery failed for %s: %s", src_id, exc)
            return LEGACY_SENTINEL

    # Source-system caches predate per-project scoping; treat as system-wide.
    if src_type == "source_system":
        return SYSTEM_SENTINEL

    # agent_inference / user_correction / import_tool / SOP / literature /
    # analytical: no clean canonical link. Mark legacy so tenants see them
    # only after an explicit promotion later.
    return LEGACY_SENTINEL


async def _backfill(
    *,
    neo4j_uri: str,
    neo4j_user: str,
    neo4j_password: str,
    pg_dsn: str,
    batch_size: int,
    dry_run: bool,
) -> None:
    drv = AsyncGraphDatabase.driver(neo4j_uri, auth=(neo4j_user, neo4j_password))
    pg = await psycopg.AsyncConnection.connect(pg_dsn)
    try:
        async with drv.session() as session:
            # Total count for progress logging.
            total_res = await session.run(
                "MATCH ()-[r]-() WHERE r.group_id IS NULL RETURN count(r) AS n"
            )
            total = (await total_res.single())["n"]
            log.info("edges missing group_id: %d", total)
            if total == 0:
                return

            updated = 0
            while True:
                # Read a batch of facts that still need a group_id, plus the
                # provenance JSON we'll use to recover the project.
                read = await session.run(
                    """
                    MATCH ()-[r]-()
                    WHERE r.group_id IS NULL
                    RETURN elementId(r) AS eid, r.fact_id AS fact_id,
                           r.provenance AS provenance
                    LIMIT $batch
                    """,
                    {"batch": batch_size},
                )
                rows = [dict(rec) async for rec in read]
                if not rows:
                    break

                writes: list[tuple[str, str]] = []
                for r in rows:
                    prov_raw = r.get("provenance")
                    prov: dict[str, Any] | None
                    if isinstance(prov_raw, str):
                        try:
                            prov = json.loads(prov_raw)
                        except json.JSONDecodeError:
                            prov = None
                    elif isinstance(prov_raw, dict):
                        prov = prov_raw
                    else:
                        prov = None
                    gid = await _resolve_group_id(pg, prov)
                    writes.append((r["eid"], gid))

                if dry_run:
                    log.info(
                        "dry-run: would set group_id on %d edges (sample: %s)",
                        len(writes),
                        writes[:3],
                    )
                else:
                    # Apply in a single transaction. UNWIND lets us batch
                    # without round-tripping per edge.
                    await session.run(
                        """
                        UNWIND $rows AS row
                        MATCH ()-[r]-() WHERE elementId(r) = row.eid
                        SET r.group_id = row.gid
                        """,
                        {"rows": [{"eid": eid, "gid": gid} for (eid, gid) in writes]},
                    )

                updated += len(writes)
                log.info("backfilled %d / %d", updated, total)
                if updated >= total:
                    break

            log.info("done: %d edges updated", updated)
    finally:
        await drv.close()
        await pg.close()


def _parse_args() -> argparse.Namespace:
    p = argparse.ArgumentParser()
    p.add_argument("--batch-size", type=int, default=500)
    p.add_argument("--dry-run", action="store_true")
    p.add_argument("--log-level", default="INFO")
    return p.parse_args()


async def amain() -> None:
    args = _parse_args()
    logging.basicConfig(
        level=args.log_level,
        format="%(asctime)s %(levelname)s %(name)s %(message)s",
    )
    await _backfill(
        neo4j_uri=_ensure_env("NEO4J_URI"),
        neo4j_user=os.environ.get("NEO4J_USER", "neo4j"),
        neo4j_password=_ensure_env("NEO4J_PASSWORD"),
        pg_dsn=_ensure_env("CHEMCLAW_SERVICE_DSN"),
        batch_size=args.batch_size,
        dry_run=args.dry_run,
    )


if __name__ == "__main__":
    asyncio.run(amain())
