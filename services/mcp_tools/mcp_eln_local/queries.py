"""SQL query builders and constants for mcp-eln-local.

Every query in this module uses named-parameter binding (``%(name)s`` +
a ``params: dict[str, Any]``); no value is ever concatenated into the
SQL string. The builder functions return ``(sql, params)`` tuples so
the route handlers stay focused on orchestration.

Split from main.py during PR-7 (Python God-file split).
"""

from __future__ import annotations

from datetime import datetime
from typing import Any

from .models import ExperimentsQueryIn, ReactionsQueryIn


# --------------------------------------------------------------------------
# Constant SQL
# --------------------------------------------------------------------------
EXPERIMENTS_FETCH_SQL = """
SELECT e.id, e.notebook_id, e.project_id, e.reaction_id, e.schema_kind,
       e.title, e.author_email, e.signed_by, e.status, e.entry_shape,
       e.data_quality_tier, e.fields_jsonb, e.freetext,
       e.freetext_length_chars, e.created_at, e.modified_at, e.signed_at,
       p.code AS project_code
FROM mock_eln.entries e
JOIN mock_eln.projects p ON p.id = e.project_id
WHERE e.id = %(entry_id)s::uuid
LIMIT 1
"""


REACTIONS_FETCH_SQL = """
SELECT v.reaction_id, v.canonical_smiles_rxn, v.family, v.project_id,
       v.step_number, v.ofat_count, v.mean_yield, v.last_activity_at,
       p.code AS project_code
FROM mock_eln.canonical_reactions_with_ofat v
JOIN mock_eln.projects p ON p.id = v.project_id
WHERE v.reaction_id = %(reaction_id)s::uuid
LIMIT 1
"""


OFAT_CHILDREN_SQL = """
SELECT e.id, e.notebook_id, e.project_id, e.reaction_id, e.schema_kind,
       e.title, e.author_email, e.signed_by, e.status, e.entry_shape,
       e.data_quality_tier, e.fields_jsonb, e.freetext,
       e.freetext_length_chars, e.created_at, e.modified_at, e.signed_at,
       p.code AS project_code
FROM mock_eln.entries e
JOIN mock_eln.projects p ON p.id = e.project_id
WHERE e.reaction_id = %(reaction_id)s::uuid
ORDER BY
  CASE
    WHEN jsonb_typeof(e.fields_jsonb -> 'results' -> 'yield_pct') = 'number'
      THEN (e.fields_jsonb -> 'results' ->> 'yield_pct')::numeric
    ELSE NULL
  END DESC NULLS LAST,
  e.modified_at DESC
LIMIT %(limit)s
"""


ATTACHMENTS_BY_ENTRY_SQL = """
SELECT id, filename, mime_type, size_bytes, description, uri, created_at
FROM mock_eln.entry_attachments
WHERE entry_id = %(entry_id)s::uuid
ORDER BY created_at ASC
"""


AUDIT_SUMMARY_SQL = """
SELECT actor_email, action, field_path, occurred_at, reason
FROM mock_eln.audit_trail
WHERE entry_id = %(entry_id)s::uuid
ORDER BY occurred_at DESC
LIMIT %(limit)s
"""


SAMPLE_BY_ID_SQL = """
SELECT id, entry_id, sample_code, compound_id, amount_mg,
       purity_pct, notes, created_at
FROM mock_eln.samples
WHERE id = %(sample_id)s::uuid
LIMIT 1
"""


RESULTS_BY_SAMPLE_SQL = """
SELECT id, method_id, metric, value_num, value_text, unit,
       measured_at, metadata
FROM mock_eln.results
WHERE sample_id = %(sample_id)s::uuid
ORDER BY measured_at DESC NULLS LAST, created_at DESC
"""


SAMPLES_BY_ENTRY_SQL = """
SELECT id, entry_id, sample_code, compound_id, amount_mg,
       purity_pct, notes, created_at
FROM mock_eln.samples
WHERE entry_id = %(entry_id)s::uuid
ORDER BY sample_code ASC
"""


ENTRY_EXISTS_SQL = (
    "SELECT 1 FROM mock_eln.entries WHERE id = %(entry_id)s::uuid LIMIT 1"
)


# --------------------------------------------------------------------------
# Dynamic query builders
# --------------------------------------------------------------------------
def build_experiments_query(
    req: ExperimentsQueryIn,
    cursor_ts: datetime | None,
    cursor_id: str | None,
    since_dt: datetime | None,
) -> tuple[str, dict[str, Any]]:
    """Build the keyset-paginated experiments query.

    All inputs land as named parameters; the SQL string is composed only
    from compile-time literal fragments.
    """
    sql = [
        """
        SELECT e.id, e.notebook_id, e.project_id, e.reaction_id, e.schema_kind,
               e.title, e.author_email, e.signed_by, e.status, e.entry_shape,
               e.data_quality_tier, e.fields_jsonb, e.freetext,
               e.freetext_length_chars, e.created_at, e.modified_at, e.signed_at,
               p.code AS project_code
        FROM mock_eln.entries e
        JOIN mock_eln.projects p ON p.id = e.project_id
        WHERE p.code = %(project_code)s
        """
    ]
    params: dict[str, Any] = {"project_code": req.project_code}

    if req.schema_kind is not None:
        sql.append(" AND e.schema_kind = %(schema_kind)s")
        params["schema_kind"] = req.schema_kind
    if req.reaction_id is not None:
        sql.append(" AND e.reaction_id = %(reaction_id)s::uuid")
        params["reaction_id"] = req.reaction_id
    if since_dt is not None:
        sql.append(" AND e.modified_at >= %(since)s")
        params["since"] = since_dt
    if req.entry_shape is not None:
        sql.append(" AND e.entry_shape = %(entry_shape)s")
        params["entry_shape"] = req.entry_shape
    if req.data_quality_tier is not None:
        sql.append(" AND e.data_quality_tier = %(data_quality_tier)s")
        params["data_quality_tier"] = req.data_quality_tier
    if cursor_ts is not None and cursor_id is not None:
        # Keyset: rows strictly after the cursor in (modified_at DESC, id DESC).
        sql.append(
            " AND (e.modified_at, e.id::text) "
            "< (%(cursor_ts)s, %(cursor_id)s)"
        )
        params["cursor_ts"] = cursor_ts
        params["cursor_id"] = cursor_id

    sql.append(" ORDER BY e.modified_at DESC, e.id DESC LIMIT %(limit_plus)s")
    # Fetch one extra to determine whether more exist.
    params["limit_plus"] = req.limit + 1
    return "".join(sql), params


def build_reactions_query(req: ReactionsQueryIn) -> tuple[str, dict[str, Any]]:
    """Build the OFAT-aware canonical reactions query."""
    sql = [
        """
        SELECT v.reaction_id, v.canonical_smiles_rxn, v.family, v.project_id,
               v.step_number, v.ofat_count, v.mean_yield, v.last_activity_at,
               p.code AS project_code
        FROM mock_eln.canonical_reactions_with_ofat v
        JOIN mock_eln.projects p ON p.id = v.project_id
        WHERE 1=1
        """
    ]
    params: dict[str, Any] = {}
    if req.family is not None:
        sql.append(" AND v.family = %(family)s")
        params["family"] = req.family
    if req.project_code is not None:
        sql.append(" AND p.code = %(project_code)s")
        params["project_code"] = req.project_code
    if req.step_number is not None:
        sql.append(" AND v.step_number = %(step_number)s")
        params["step_number"] = req.step_number
    if req.min_ofat_count is not None:
        sql.append(" AND v.ofat_count >= %(min_ofat_count)s")
        params["min_ofat_count"] = req.min_ofat_count
    sql.append(
        " ORDER BY v.ofat_count DESC, v.last_activity_at DESC NULLS LAST "
        "LIMIT %(limit)s"
    )
    params["limit"] = req.limit
    return "".join(sql), params
