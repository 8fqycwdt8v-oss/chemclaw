"""Postgres-backed QM cache helper for MCP services (mcp-xtb / mcp-crest).

Provides synchronous lookup + insert against the `qm_jobs` table defined in
`db/init/23_qm_results.sql`. The cache key is computed via
`services.mcp_tools.common.qm_hash.qm_cache_key`.

Design notes:
- We keep the API synchronous because xTB itself is invoked via
  `subprocess.run` (synchronous) and FastAPI happily runs sync handlers in a
  thread pool. An async API would force every handler to await two extra
  awaitables per call for marginal benefit.
- The DSN is read once at process start from the `POSTGRES_DSN` env var with
  fallback to per-component env vars (matching the projector base class).
- Connections are short-lived (one per call); for an MCP service that handles
  ~10 RPS this is fine. If we ever add a higher-RPS hot path, swap in
  psycopg's connection pool.
"""

from __future__ import annotations

import json
import logging
import os
import socket
import time
import uuid
from contextlib import contextmanager
from dataclasses import dataclass
from typing import Any, Iterator

import psycopg
from psycopg.rows import dict_row

from services.mcp_tools.common.qm_hash import qm_cache_key


log = logging.getLogger("qm_cache_db")


@dataclass(frozen=True)
class QmJobLookup:
    """Result of a cache lookup."""

    job_id: str
    method: str
    task: str
    energy_hartree: float | None
    converged: bool | None
    geometry_xyz: str | None
    summary_md: str | None
    descriptors: dict[str, Any] | None
    conformers: list[dict[str, Any]]


def _build_dsn() -> str:
    if dsn := os.environ.get("POSTGRES_DSN"):
        return dsn
    host = os.environ.get("POSTGRES_HOST", "localhost")
    port = os.environ.get("POSTGRES_PORT", "5432")
    db = os.environ.get("POSTGRES_DB", "chemclaw")
    user = os.environ.get("POSTGRES_USER", "chemclaw_service")
    password = os.environ.get("POSTGRES_PASSWORD", "")
    return f"host={host} port={port} dbname={db} user={user} password={password}"


@contextmanager
def _connect() -> Iterator[psycopg.Connection[dict[str, Any]]]:
    # row_factory=dict_row makes every fetched row a dict[str, Any] rather
    # than the default tuple. Parameterising Connection here keeps mypy
    # honest about cur.fetchone() / cur.fetchall() row types downstream.
    conn = psycopg.connect(_build_dsn(), row_factory=dict_row)
    try:
        yield conn
    finally:
        conn.close()


def lookup(
    *,
    method: str,
    task: str,
    smiles_canonical: str,
    charge: int = 0,
    multiplicity: int = 1,
    solvent_model: str | None = None,
    solvent_name: str | None = None,
    params: dict[str, Any] | None = None,
) -> QmJobLookup | None:
    """Return the live succeeded QM job matching the cache key, else None.

    Returns None on any DB failure — callers should treat as a cache miss.
    A noisy failure here MUST NOT take down the MCP service.
    """
    key = qm_cache_key(
        method=method,
        task=task,
        smiles_canonical=smiles_canonical,
        charge=charge,
        multiplicity=multiplicity,
        solvent_model=solvent_model,
        solvent_name=solvent_name,
        params=params,
    )
    try:
        with _connect() as conn, conn.cursor() as cur:
            cur.execute(
                """
                SELECT j.id::text AS job_id,
                       j.method, j.task,
                       r.energy_hartree, r.converged, r.geometry_xyz,
                       r.summary_md, r.descriptors
                  FROM qm_jobs j
                  LEFT JOIN qm_results r ON r.job_id = j.id
                 WHERE j.cache_key = %s
                   AND j.valid_to IS NULL
                   AND j.status = 'succeeded'
                 LIMIT 1
                """,
                (key,),
            )
            row = cur.fetchone()
            if row is None:
                return None

            cur.execute(
                """
                SELECT ensemble_index, xyz, energy_hartree, boltzmann_weight
                  FROM qm_conformers
                 WHERE job_id = %s::uuid
                 ORDER BY ensemble_index
                """,
                (row["job_id"],),
            )
            conformers = [
                {
                    "ensemble_index": r["ensemble_index"],
                    "xyz": r["xyz"],
                    "energy_hartree": r["energy_hartree"],
                    "boltzmann_weight": float(r["boltzmann_weight"] or 0.0),
                }
                for r in cur.fetchall()
            ]
        return QmJobLookup(
            job_id=row["job_id"],
            method=row["method"],
            task=row["task"],
            energy_hartree=row["energy_hartree"],
            converged=row["converged"],
            geometry_xyz=row["geometry_xyz"],
            summary_md=row["summary_md"],
            descriptors=row["descriptors"],
            conformers=conformers,
        )
    except Exception as exc:  # noqa: BLE001 — never crash the MCP on cache I/O
        log.warning("qm_cache lookup failed: %s", exc, extra={"event": "qm_cache_lookup_failed"})
        return None


def store(
    *,
    method: str,
    task: str,
    smiles_canonical: str,
    inchikey: str | None = None,
    charge: int = 0,
    multiplicity: int = 1,
    solvent_model: str | None = None,
    solvent_name: str | None = None,
    params: dict[str, Any] | None = None,
    energy_hartree: float | None = None,
    gnorm: float | None = None,
    converged: bool | None = None,
    geometry_xyz: str | None = None,
    charges: dict[str, Any] | None = None,
    fukui: dict[str, Any] | None = None,
    descriptors: dict[str, Any] | None = None,
    summary_md: str | None = None,
    conformers: list[dict[str, Any]] | None = None,
    frequencies: list[dict[str, Any]] | None = None,
    thermo: dict[str, float] | None = None,
    scan_points: list[dict[str, Any]] | None = None,
    irc_points: list[dict[str, Any]] | None = None,
    md_frames: list[dict[str, Any]] | None = None,
    runtime_ms: int | None = None,
    version_xtb: str | None = None,
    version_crest: str | None = None,
) -> str | None:
    """Insert a succeeded QM job + result rows; returns the new job_id.

    Returns None on DB failure (the MCP service still returns the computed
    result to the caller — losing the cache entry is an observability
    concern, not a correctness one).
    """
    key = qm_cache_key(
        method=method,
        task=task,
        smiles_canonical=smiles_canonical,
        charge=charge,
        multiplicity=multiplicity,
        solvent_model=solvent_model,
        solvent_name=solvent_name,
        params=params,
    )
    job_id = str(uuid.uuid4())
    started = time.monotonic()
    try:
        with _connect() as conn, conn.cursor() as cur:
            cur.execute(
                """
                INSERT INTO qm_jobs (
                  id, cache_key, method, task,
                  smiles_canonical, inchikey,
                  charge, multiplicity,
                  solvent_model, solvent_name, params,
                  status, finished_at, runtime_ms, host,
                  version_xtb, version_crest
                ) VALUES (
                  %s::uuid, %s, %s, %s,
                  %s, %s,
                  %s, %s,
                  %s, %s, %s::jsonb,
                  'succeeded', NOW(), %s, %s,
                  %s, %s
                )
                ON CONFLICT DO NOTHING
                """,
                (
                    job_id, key, method, task,
                    smiles_canonical, inchikey,
                    int(charge), int(multiplicity),
                    solvent_model, solvent_name, json.dumps(params or {}),
                    runtime_ms, socket.gethostname(),
                    version_xtb, version_crest,
                ),
            )
            cur.execute(
                """
                INSERT INTO qm_results (
                  job_id, energy_hartree, gnorm, converged,
                  geometry_xyz, charges, fukui, descriptors, summary_md
                ) VALUES (
                  %s::uuid, %s, %s, %s, %s, %s::jsonb, %s::jsonb, %s::jsonb, %s
                )
                ON CONFLICT (job_id) DO NOTHING
                """,
                (
                    job_id, energy_hartree, gnorm, converged,
                    geometry_xyz,
                    json.dumps(charges) if charges is not None else None,
                    json.dumps(fukui) if fukui is not None else None,
                    json.dumps(descriptors) if descriptors is not None else None,
                    summary_md,
                ),
            )
            for c in conformers or []:
                cur.execute(
                    """
                    INSERT INTO qm_conformers (
                      job_id, ensemble_index, xyz, energy_hartree,
                      boltzmann_weight, rmsd_to_min
                    ) VALUES (%s::uuid, %s, %s, %s, %s, %s)
                    ON CONFLICT (job_id, ensemble_index) DO NOTHING
                    """,
                    (
                        job_id, c["ensemble_index"], c["xyz"],
                        c.get("energy_hartree"),
                        c.get("boltzmann_weight"),
                        c.get("rmsd_to_min"),
                    ),
                )
            for f in frequencies or []:
                cur.execute(
                    """
                    INSERT INTO qm_frequencies (
                      job_id, mode_index, freq_cm1, ir_intensity, raman_intensity
                    ) VALUES (%s::uuid, %s, %s, %s, %s)
                    ON CONFLICT (job_id, mode_index) DO NOTHING
                    """,
                    (
                        job_id, f["mode_index"], f.get("freq_cm1"),
                        f.get("ir_intensity"), f.get("raman_intensity"),
                    ),
                )
            if thermo:
                cur.execute(
                    """
                    INSERT INTO qm_thermo (job_id, zpe_hartree, h298, g298, s298, cv)
                    VALUES (%s::uuid, %s, %s, %s, %s, %s)
                    ON CONFLICT (job_id) DO NOTHING
                    """,
                    (
                        job_id,
                        thermo.get("zpe_hartree"),
                        thermo.get("h298"),
                        thermo.get("g298"),
                        thermo.get("s298"),
                        thermo.get("cv"),
                    ),
                )
            for sp in scan_points or []:
                cur.execute(
                    """
                    INSERT INTO qm_scan_points (
                      job_id, point_index, coord_value, energy, geometry_xyz
                    ) VALUES (%s::uuid, %s, %s, %s, %s)
                    ON CONFLICT (job_id, point_index) DO NOTHING
                    """,
                    (
                        job_id, sp["point_index"], sp.get("coord_value"),
                        sp.get("energy"), sp.get("geometry_xyz"),
                    ),
                )
            for ip in irc_points or []:
                cur.execute(
                    """
                    INSERT INTO qm_irc_points (
                      job_id, branch, step_index, coord_arc, energy, geometry_xyz
                    ) VALUES (%s::uuid, %s, %s, %s, %s, %s)
                    ON CONFLICT (job_id, branch, step_index) DO NOTHING
                    """,
                    (
                        job_id, ip["branch"], ip["step_index"],
                        ip.get("coord_arc"), ip.get("energy"),
                        ip.get("geometry_xyz"),
                    ),
                )
            for mdf in md_frames or []:
                cur.execute(
                    """
                    INSERT INTO qm_md_frames (
                      job_id, frame_index, time_fs, energy, temperature_k,
                      geometry_xyz, cv_value
                    ) VALUES (%s::uuid, %s, %s, %s, %s, %s, %s)
                    ON CONFLICT (job_id, frame_index) DO NOTHING
                    """,
                    (
                        job_id, mdf["frame_index"], mdf.get("time_fs"),
                        mdf.get("energy"), mdf.get("temperature_k"),
                        mdf.get("geometry_xyz"), mdf.get("cv_value"),
                    ),
                )
        elapsed_ms = int((time.monotonic() - started) * 1000)
        log.info(
            "qm_cache stored",
            extra={"event": "qm_cache_store", "job_id": job_id, "duration_ms": elapsed_ms},
        )
        return job_id
    except Exception as exc:  # noqa: BLE001
        log.warning("qm_cache store failed: %s", exc, extra={"event": "qm_cache_store_failed"})
        return None
