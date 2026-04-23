"""Core ELN JSON import logic.

Writes to Postgres in a single transaction per file. Emits an
`ingestion_events` row per experiment so downstream projectors (KG, vector,
reaction DRFP) can subscribe via LISTEN/NOTIFY.

This deliberately does NO chemistry parsing yet (no SMILES canonicalization,
no DRFP computation). Those are separate projector steps in Phase 2+.
"""

from __future__ import annotations

import hashlib
import json
import logging
from pathlib import Path
from typing import Any

import psycopg
from psycopg.rows import dict_row
from psycopg.types.json import Jsonb

from services.ingestion.eln_json_importer.schemas import (
    ELNExperiment,
    ELNImportDocument,
)
from services.ingestion.eln_json_importer.settings import get_settings

logger = logging.getLogger(__name__)


def _file_hash(path: Path) -> str:
    h = hashlib.sha256()
    with path.open("rb") as f:
        for chunk in iter(lambda: f.read(1 << 16), b""):
            h.update(chunk)
    return h.hexdigest()


def _ensure_project(
    cur: psycopg.Cursor, project_internal_id: str
) -> str:
    """Return project UUID; create a stub project if missing.

    Race-safe: uses `INSERT ... ON CONFLICT DO NOTHING RETURNING id`, then
    falls back to `SELECT` when another importer already inserted the row
    between our INSERT and its commit. The UNIQUE constraint on
    `internal_id` gives us the atomicity we need.
    """
    cur.execute(
        """
        INSERT INTO nce_projects (internal_id, name, status)
        VALUES (%s, %s, 'active')
        ON CONFLICT (internal_id) DO NOTHING
        RETURNING id::text
        """,
        (project_internal_id, f"Imported: {project_internal_id}"),
    )
    row = cur.fetchone()
    if row is not None:
        logger.info("created stub project %s", project_internal_id)
        return row["id"]

    # Another transaction inserted it; fetch the canonical id.
    cur.execute(
        "SELECT id::text FROM nce_projects WHERE internal_id = %s",
        (project_internal_id,),
    )
    existing = cur.fetchone()
    if existing is None:
        raise RuntimeError(
            f"project {project_internal_id!r} neither inserted nor found — concurrent delete?"
        )
    return existing["id"]


def _ensure_step(
    cur: psycopg.Cursor, project_id: str, step_index: int, step_name: str,
    target_compound_inchikey: str | None,
) -> str:
    """Race-safe step ensure. Same pattern as `_ensure_project`."""
    cur.execute(
        """
        INSERT INTO synthetic_steps
          (nce_project_id, step_index, step_name, target_compound_inchikey)
        VALUES (%s, %s, %s, %s)
        ON CONFLICT (nce_project_id, step_index) DO NOTHING
        RETURNING id::text
        """,
        (project_id, step_index, step_name, target_compound_inchikey),
    )
    row = cur.fetchone()
    if row is not None:
        return row["id"]

    cur.execute(
        """
        SELECT id::text FROM synthetic_steps
         WHERE nce_project_id = %s AND step_index = %s
        """,
        (project_id, step_index),
    )
    existing = cur.fetchone()
    if existing is None:
        raise RuntimeError(
            f"step ({project_id}, {step_index}) neither inserted nor found — concurrent delete?"
        )
    return existing["id"]


def _upsert_experiment(
    cur: psycopg.Cursor,
    step_id: str,
    exp: ELNExperiment,
    imported_from: dict[str, Any],
) -> str:
    cur.execute(
        """
        INSERT INTO experiments (
          synthetic_step_id, eln_entry_id, date_performed, operator_entra_id,
          procedure_text, observations, tabular_data,
          yield_pct, scale_mg, outcome_status,
          raw_source_file_path, imported_from
        ) VALUES (%s, %s, %s, %s, %s, %s, %s, %s, %s, %s, %s, %s)
        ON CONFLICT (eln_entry_id) DO UPDATE SET
          date_performed   = EXCLUDED.date_performed,
          operator_entra_id = EXCLUDED.operator_entra_id,
          procedure_text   = EXCLUDED.procedure_text,
          observations     = EXCLUDED.observations,
          tabular_data     = EXCLUDED.tabular_data,
          yield_pct        = EXCLUDED.yield_pct,
          scale_mg         = EXCLUDED.scale_mg,
          outcome_status   = EXCLUDED.outcome_status,
          raw_source_file_path = EXCLUDED.raw_source_file_path,
          imported_from    = EXCLUDED.imported_from,
          updated_at       = NOW()
        RETURNING id::text
        """,
        (
            step_id,
            exp.eln_entry_id,
            exp.date_performed,
            exp.operator_entra_id,
            exp.procedure_text,
            exp.observations,
            Jsonb(exp.tabular_data),
            exp.yield_pct,
            exp.scale_mg,
            exp.outcome_status,
            exp.raw_source_file_path,
            Jsonb(imported_from),
        ),
    )
    row = cur.fetchone()
    if row is None:
        raise RuntimeError("failed to upsert experiment")
    return row["id"]


def _insert_reaction_rows(
    cur: psycopg.Cursor, experiment_id: str, exp: ELNExperiment
) -> int:
    """Insert raw reaction rows (no DRFP yet — that's a projector's job)."""
    count = 0
    for rxn in exp.reactions:
        cur.execute(
            """
            INSERT INTO reactions (
              experiment_id, rxn_smiles, rxn_smarts, rxno_class, rxnmapper_output
            ) VALUES (%s, %s, %s, %s, %s)
            """,
            (
                experiment_id,
                rxn.rxn_smiles,
                rxn.rxn_smarts,
                rxn.rxno_class,
                Jsonb({"reagents": [r.model_dump() for r in rxn.reagents]}),
            ),
        )
        count += 1
    return count


def _emit_event(
    cur: psycopg.Cursor,
    event_type: str,
    source_table: str,
    source_row_id: str,
    payload: dict[str, Any],
) -> None:
    cur.execute(
        """
        INSERT INTO ingestion_events (event_type, source_table, source_row_id, payload)
        VALUES (%s, %s, %s, %s)
        """,
        (event_type, source_table, source_row_id, Jsonb(payload)),
    )


# Cap on imported JSON file size. 256 MiB is enormous for a daily batch;
# anything larger is almost certainly a mistake or an attack.
_MAX_IMPORT_FILE_BYTES = 256 * 1024 * 1024


def import_file(path: Path) -> dict[str, int]:
    """Import one ELN JSON file. Idempotent on eln_entry_id."""
    settings = get_settings()
    path = path.resolve()
    if not path.exists():
        raise FileNotFoundError(path)

    size = path.stat().st_size
    if size > _MAX_IMPORT_FILE_BYTES:
        raise ValueError(
            f"file exceeds size limit: {size} > {_MAX_IMPORT_FILE_BYTES}"
        )

    raw = json.loads(path.read_text(encoding="utf-8"))
    doc = ELNImportDocument.model_validate(raw)
    file_hash = _file_hash(path)

    counters = {"projects": 0, "steps": 0, "experiments": 0, "reactions": 0}

    with psycopg.connect(settings.postgres_dsn, row_factory=dict_row) as conn:
        # Ingestion workers bypass RLS via the chemclaw_service role when
        # configured; for local dev we rely on the connection user being the
        # table owner (also bypasses). Setting RLS user to empty keeps the
        # policy permissive.
        with conn.cursor() as cur:
            cur.execute("SELECT set_config('app.current_user_entra_id', '', false)")

            for exp in doc.experiments:
                project_id = _ensure_project(cur, exp.project_internal_id)
                step_id = _ensure_step(
                    cur,
                    project_id,
                    exp.step_index,
                    exp.step_name,
                    exp.target_compound_inchikey,
                )
                experiment_id = _upsert_experiment(
                    cur,
                    step_id,
                    exp,
                    imported_from={
                        "source": doc.source,
                        "file": str(path),
                        "file_sha256": file_hash,
                        "exported_at": doc.exported_at,
                    },
                )
                rxn_count = _insert_reaction_rows(cur, experiment_id, exp)
                counters["experiments"] += 1
                counters["reactions"] += rxn_count

                _emit_event(
                    cur,
                    event_type="experiment_imported",
                    source_table="experiments",
                    source_row_id=experiment_id,
                    payload={
                        "eln_entry_id": exp.eln_entry_id,
                        "project_internal_id": exp.project_internal_id,
                        "reaction_count": rxn_count,
                    },
                )

        conn.commit()

    logger.info("imported file %s: %s", path.name, counters)
    return counters
