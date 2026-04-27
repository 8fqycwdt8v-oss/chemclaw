"""mcp-eln-local — Postgres-backed mock ELN MCP service.

Reads the `mock_eln` schema in the chemclaw DB via a dedicated read-only role
(`chemclaw_mock_eln_reader`). Surfaces ELN entries / canonical reactions /
samples / attachments at a stable, tool-agnostic shape so the agent can
treat this MCP exactly like a vendor ELN adapter.

Endpoints (all POST, JSON body):
    POST /experiments/query        — keyset-paginated entry search
    POST /experiments/fetch        — single entry by id
    POST /reactions/query          — OFAT-aware canonical reaction search
    POST /reactions/fetch          — canonical reaction + top-N OFAT children
    POST /samples/fetch            — sample + linked results
    POST /attachments/metadata     — attachment metadata for an entry

The post-tool source-cache hook in agent-claw matches the regex
`/^(query|fetch)_(eln|lims|instrument)_/` on the *agent-side tool id*, not
on these MCP paths. The matching builtins live in
services/agent-claw/src/tools/builtins/{query,fetch}_eln_*.ts.

Citation URIs (used by the agent's source-cache hook):
    local-mock-eln://eln/entry/{entry_id}
    local-mock-eln://eln/reaction/{reaction_id}

Each response carries `valid_until = NOW() + INTERVAL '7 days'` so the
post-tool hook can stamp temporal provenance on the derived :Fact nodes.
"""

from __future__ import annotations

import logging
import re
from contextlib import asynccontextmanager
from datetime import datetime, timedelta, timezone
from typing import Annotated, Any, AsyncIterator

import psycopg
from fastapi import Body, FastAPI, HTTPException
from psycopg.rows import dict_row
from psycopg_pool import AsyncConnectionPool
from pydantic import BaseModel, Field, field_validator
from pydantic_settings import SettingsConfigDict

from services.mcp_tools.common.app import create_app
from services.mcp_tools.common.payload_caps import cap_jsonb
from services.mcp_tools.common.settings import ToolSettings


log = logging.getLogger("mcp-eln-local")


# Sentinel password used by db/init/30_mock_eln_schema.sql when the
# `chemclaw.mock_eln_reader_password` GUC is unset. If the configured
# DSN still contains this literal we refuse to start unless explicitly
# allowed via MOCK_ELN_ALLOW_DEV_PASSWORD=true (set in dev-compose).
_DEV_SENTINEL_PASSWORD = "chemclaw_mock_eln_reader_dev_password_change_me"


# --------------------------------------------------------------------------
# Settings
# --------------------------------------------------------------------------
class ElnLocalSettings(ToolSettings):
    model_config = SettingsConfigDict(env_file=".env", extra="ignore")

    port: int = 8013
    # DSN for the read-only mock_eln reader. The default targets the
    # `postgres` host inside the docker network; override via env in
    # local-dev / CI.
    mock_eln_dsn: str = (
        "postgresql://chemclaw_mock_eln_reader:"
        f"{_DEV_SENTINEL_PASSWORD}"
        "@postgres:5432/chemclaw"
    )
    # Explicit acknowledgement that we're running with the dev sentinel
    # password. Defaults to false so production deployments fail-closed
    # if the operator forgets to override MOCK_ELN_DSN.
    mock_eln_allow_dev_password: bool = False
    # Feature flag: when false (production default until the schema is
    # populated), /readyz reports degraded so the harness keeps the
    # adapter out of rotation.
    mock_eln_enabled: bool = True
    # Default TTL for cached facts (matches source-cache hook default).
    valid_until_days: int = 7
    # Connection pool sizing. Small numbers — this is a read-only
    # mock-data MCP, not a production hotspot.
    pool_min_size: int = 1
    pool_max_size: int = 5


settings = ElnLocalSettings()


# --------------------------------------------------------------------------
# Pool + lifespan
# --------------------------------------------------------------------------
_pool_holder: dict[str, AsyncConnectionPool] = {}


def _check_dsn_safety() -> None:
    """Refuse to start if the DSN still contains the dev sentinel password
    and the operator hasn't explicitly opted into it."""
    if (
        _DEV_SENTINEL_PASSWORD in settings.mock_eln_dsn
        and not settings.mock_eln_allow_dev_password
    ):
        raise RuntimeError(
            "mcp-eln-local refusing to start: MOCK_ELN_DSN contains the dev "
            "sentinel password but MOCK_ELN_ALLOW_DEV_PASSWORD is not set. "
            "Either override MOCK_ELN_DSN with a real password, or set "
            "MOCK_ELN_ALLOW_DEV_PASSWORD=true to acknowledge dev usage."
        )


@asynccontextmanager
async def _lifespan(_app: FastAPI) -> AsyncIterator[None]:
    _check_dsn_safety()
    log.info("mcp-eln-local starting; mock_eln_enabled=%s", settings.mock_eln_enabled)
    pool = AsyncConnectionPool(
        conninfo=settings.mock_eln_dsn,
        min_size=settings.pool_min_size,
        max_size=settings.pool_max_size,
        kwargs={"row_factory": dict_row, "autocommit": True},
        open=False,
    )
    try:
        if settings.mock_eln_enabled:
            try:
                await pool.open(wait=False)
                _pool_holder["pool"] = pool
            except Exception as exc:  # noqa: BLE001 — DB may not be up yet
                log.warning("mcp-eln-local: pool.open failed: %s", exc)
        yield
    finally:
        pool = _pool_holder.pop("pool", None)
        if pool is not None:
            await pool.close()


def _ready_check() -> bool:
    """Sync ready check: feature-flag gates this; DB liveness is best-effort."""
    return bool(settings.mock_eln_enabled)


@asynccontextmanager
async def _acquire() -> AsyncIterator[psycopg.AsyncConnection]:
    """Acquire a connection from the pool for the lifetime of one request.

    Replaces the previous module-level shared connection: psycopg's async
    connection is not safe for concurrent operations (only one cursor at
    a time), so under any concurrent load the shared-conn pattern would
    serialize requests at best and deadlock at worst.

    Transient pool failures (psycopg.OperationalError, e.g. DB restart
    mid-request) surface as 503 instead of an unstructured 500, so
    upstream clients can distinguish "service degraded, retry" from a
    bug. The `ValueError → 400` exception handler in `common/app.py`
    does not catch OperationalError, hence the explicit conversion.
    """
    pool = _pool_holder.get("pool")
    if pool is None:
        raise HTTPException(
            status_code=503,
            detail={"error": "service_unavailable", "detail": "mock_eln pool not initialized"},
        )
    try:
        async with pool.connection() as conn:
            yield conn
    except psycopg.OperationalError as exc:
        raise HTTPException(
            status_code=503,
            detail={"error": "service_unavailable", "detail": f"mock_eln DB unavailable: {exc}"},
        ) from exc


app = create_app(
    name="mcp-eln-local",
    version="0.1.0",
    log_level=settings.log_level,
    ready_check=_ready_check,
    lifespan=_lifespan,
    required_scope="mcp_eln:read",
)


# --------------------------------------------------------------------------
# Models
# --------------------------------------------------------------------------
_ID_RE = re.compile(r"^[A-Za-z0-9_\-\.:]+$")
_PROJECT_CODE_RE = re.compile(r"^[A-Za-z0-9_\-\.]+$")
_FAMILY_RE = re.compile(r"^[A-Za-z0-9_\-]+$")


def _validate_id(value: str, field_name: str) -> str:
    if not _ID_RE.match(value):
        raise ValueError(
            f"{field_name} must match {_ID_RE.pattern!r} "
            f"(got {value!r})"
        )
    return value


def _parse_iso(value: str | None, field_name: str) -> datetime | None:
    if value is None:
        return None
    try:
        # fromisoformat handles "2024-01-02T03:04:05+00:00" and similar.
        # Accept trailing Z by translating to +00:00.
        s = value.replace("Z", "+00:00")
        return datetime.fromisoformat(s)
    except ValueError as exc:
        raise ValueError(f"{field_name} must be ISO-8601 (got {value!r})") from exc


class AuditEntry(BaseModel):
    actor_email: str | None = None
    action: str
    field_path: str | None = None
    occurred_at: datetime
    reason: str | None = None


class Attachment(BaseModel):
    id: str
    filename: str
    mime_type: str | None = None
    size_bytes: int | None = None
    description: str | None = None
    uri: str | None = None
    created_at: datetime


class ElnEntry(BaseModel):
    id: str
    notebook_id: str
    project_id: str
    project_code: str | None = None
    reaction_id: str | None = None
    schema_kind: str
    title: str
    author_email: str | None = None
    signed_by: str | None = None
    status: str
    entry_shape: str
    data_quality_tier: str
    fields_jsonb: dict[str, Any] = Field(default_factory=dict)
    freetext: str | None = None
    freetext_length_chars: int = 0
    created_at: datetime
    modified_at: datetime
    signed_at: datetime | None = None
    citation_uri: str
    valid_until: datetime
    attachments: list[Attachment] = Field(default_factory=list)
    audit_summary: list[AuditEntry] = Field(default_factory=list)


class CanonicalReaction(BaseModel):
    reaction_id: str
    canonical_smiles_rxn: str
    family: str
    project_id: str
    project_code: str | None = None
    step_number: int | None = None
    ofat_count: int
    mean_yield: float | None = None
    last_activity_at: datetime | None = None
    citation_uri: str
    valid_until: datetime


class CanonicalReactionDetail(CanonicalReaction):
    ofat_children: list[ElnEntry] = Field(default_factory=list)


class Result(BaseModel):
    id: str
    method_id: str | None = None
    metric: str
    value_num: float | None = None
    value_text: str | None = None
    unit: str | None = None
    measured_at: datetime | None = None
    metadata: dict[str, Any] = Field(default_factory=dict)


class Sample(BaseModel):
    id: str
    entry_id: str
    sample_code: str
    compound_id: str | None = None
    amount_mg: float | None = None
    purity_pct: float | None = None
    notes: str | None = None
    created_at: datetime
    citation_uri: str
    valid_until: datetime
    results: list[Result] = Field(default_factory=list)


# --------------------------------------------------------------------------
# Request / response models
# --------------------------------------------------------------------------
class ExperimentsQueryIn(BaseModel):
    project_code: str = Field(min_length=1, max_length=64)
    schema_kind: str | None = Field(default=None, max_length=64)
    reaction_id: str | None = Field(default=None, max_length=128)
    since: str | None = Field(
        default=None, description="ISO-8601 cutoff on modified_at."
    )
    entry_shape: str | None = None
    data_quality_tier: str | None = None
    limit: int = Field(default=50, ge=1, le=200)
    cursor: str | None = Field(
        default=None,
        max_length=1024,
        description=(
            "Opaque cursor returned by the previous page. Format: "
            "'<modified_at_iso>|<id>'."
        ),
    )

    @field_validator("project_code")
    @classmethod
    def _check_project_code(cls, v: str) -> str:
        if not _PROJECT_CODE_RE.match(v):
            raise ValueError(
                f"project_code must match {_PROJECT_CODE_RE.pattern!r}"
            )
        return v

    @field_validator("reaction_id")
    @classmethod
    def _check_reaction_id(cls, v: str | None) -> str | None:
        if v is None:
            return v
        return _validate_id(v, "reaction_id")

    @field_validator("entry_shape")
    @classmethod
    def _check_entry_shape(cls, v: str | None) -> str | None:
        if v is None:
            return v
        if v not in ("mixed", "pure-structured", "pure-freetext"):
            raise ValueError("entry_shape must be one of mixed/pure-structured/pure-freetext")
        return v

    @field_validator("data_quality_tier")
    @classmethod
    def _check_dqt(cls, v: str | None) -> str | None:
        if v is None:
            return v
        if v not in ("clean", "partial", "noisy", "failed"):
            raise ValueError("data_quality_tier must be one of clean/partial/noisy/failed")
        return v

    @field_validator("schema_kind")
    @classmethod
    def _check_schema_kind(cls, v: str | None) -> str | None:
        if v is None:
            return v
        return _validate_id(v, "schema_kind")


class ExperimentsQueryOut(BaseModel):
    items: list[ElnEntry]
    next_cursor: str | None = None


class ExperimentsFetchIn(BaseModel):
    entry_id: str = Field(min_length=1, max_length=128)

    @field_validator("entry_id")
    @classmethod
    def _check(cls, v: str) -> str:
        return _validate_id(v, "entry_id")


class ReactionsQueryIn(BaseModel):
    family: str | None = Field(default=None, max_length=64)
    project_code: str | None = Field(default=None, max_length=64)
    step_number: int | None = Field(default=None, ge=0, le=100)
    min_ofat_count: int | None = Field(default=None, ge=0, le=10_000)
    limit: int = Field(default=50, ge=1, le=200)

    @field_validator("project_code")
    @classmethod
    def _check_pc(cls, v: str | None) -> str | None:
        if v is None:
            return v
        if not _PROJECT_CODE_RE.match(v):
            raise ValueError(
                f"project_code must match {_PROJECT_CODE_RE.pattern!r}"
            )
        return v

    @field_validator("family")
    @classmethod
    def _check_family(cls, v: str | None) -> str | None:
        if v is None:
            return v
        if not _FAMILY_RE.match(v):
            raise ValueError(f"family must match {_FAMILY_RE.pattern!r}")
        return v


class ReactionsQueryOut(BaseModel):
    items: list[CanonicalReaction]


class ReactionsFetchIn(BaseModel):
    reaction_id: str = Field(min_length=1, max_length=128)
    top_n_ofat: int = Field(default=10, ge=0, le=200)

    @field_validator("reaction_id")
    @classmethod
    def _check(cls, v: str) -> str:
        return _validate_id(v, "reaction_id")


class SamplesFetchIn(BaseModel):
    sample_id: str = Field(min_length=1, max_length=128)

    @field_validator("sample_id")
    @classmethod
    def _check(cls, v: str) -> str:
        return _validate_id(v, "sample_id")


class AttachmentsMetadataIn(BaseModel):
    entry_id: str = Field(min_length=1, max_length=128)

    @field_validator("entry_id")
    @classmethod
    def _check(cls, v: str) -> str:
        return _validate_id(v, "entry_id")


class AttachmentsMetadataOut(BaseModel):
    entry_id: str
    attachments: list[Attachment]


class SamplesByEntryIn(BaseModel):
    entry_id: str = Field(min_length=1, max_length=128)

    @field_validator("entry_id")
    @classmethod
    def _check(cls, v: str) -> str:
        return _validate_id(v, "entry_id")


class SamplesByEntryOut(BaseModel):
    entry_id: str
    samples: list[Sample]


# --------------------------------------------------------------------------
# Helpers
# --------------------------------------------------------------------------
def _valid_until_now() -> datetime:
    return datetime.now(timezone.utc) + timedelta(days=settings.valid_until_days)


def _entry_citation_uri(entry_id: str) -> str:
    return f"local-mock-eln://eln/entry/{entry_id}"


def _reaction_citation_uri(reaction_id: str) -> str:
    return f"local-mock-eln://eln/reaction/{reaction_id}"


def _sample_citation_uri(sample_id: str) -> str:
    return f"local-mock-eln://eln/sample/{sample_id}"


def _row_to_entry(row: dict[str, Any]) -> ElnEntry:
    eid = str(row["id"])
    return ElnEntry(
        id=eid,
        notebook_id=str(row["notebook_id"]),
        project_id=str(row["project_id"]),
        project_code=row.get("project_code"),
        reaction_id=str(row["reaction_id"]) if row.get("reaction_id") else None,
        schema_kind=row["schema_kind"],
        title=row["title"],
        author_email=row.get("author_email"),
        signed_by=row.get("signed_by"),
        status=row["status"],
        entry_shape=row["entry_shape"],
        data_quality_tier=row["data_quality_tier"],
        fields_jsonb=cap_jsonb(
            row.get("fields_jsonb") or {}, field_name="fields_jsonb"
        ),
        freetext=row.get("freetext"),
        freetext_length_chars=row.get("freetext_length_chars") or 0,
        created_at=row["created_at"],
        modified_at=row["modified_at"],
        signed_at=row.get("signed_at"),
        citation_uri=_entry_citation_uri(eid),
        valid_until=_valid_until_now(),
        attachments=[],
        audit_summary=[],
    )


def _row_to_canonical_reaction(row: dict[str, Any]) -> CanonicalReaction:
    rid = str(row["reaction_id"])
    mean_yield_raw = row.get("mean_yield")
    return CanonicalReaction(
        reaction_id=rid,
        canonical_smiles_rxn=row["canonical_smiles_rxn"],
        family=row["family"],
        project_id=str(row["project_id"]),
        project_code=row.get("project_code"),
        step_number=row.get("step_number"),
        ofat_count=int(row.get("ofat_count") or 0),
        mean_yield=float(mean_yield_raw) if mean_yield_raw is not None else None,
        last_activity_at=row.get("last_activity_at"),
        citation_uri=_reaction_citation_uri(rid),
        valid_until=_valid_until_now(),
    )


def _row_to_attachment(row: dict[str, Any]) -> Attachment:
    return Attachment(
        id=str(row["id"]),
        filename=row["filename"],
        mime_type=row.get("mime_type"),
        size_bytes=row.get("size_bytes"),
        description=row.get("description"),
        uri=row.get("uri"),
        created_at=row["created_at"],
    )


def _row_to_audit(row: dict[str, Any]) -> AuditEntry:
    return AuditEntry(
        actor_email=row.get("actor_email"),
        action=row["action"],
        field_path=row.get("field_path"),
        occurred_at=row["occurred_at"],
        reason=row.get("reason"),
    )


def _row_to_result(row: dict[str, Any]) -> Result:
    return Result(
        id=str(row["id"]),
        method_id=str(row["method_id"]) if row.get("method_id") else None,
        metric=row["metric"],
        value_num=float(row["value_num"]) if row.get("value_num") is not None else None,
        value_text=row.get("value_text"),
        unit=row.get("unit"),
        measured_at=row.get("measured_at"),
        metadata=cap_jsonb(row.get("metadata") or {}, field_name="results.metadata"),
    )


def _row_to_sample(row: dict[str, Any]) -> Sample:
    sid = str(row["id"])
    return Sample(
        id=sid,
        entry_id=str(row["entry_id"]),
        sample_code=row["sample_code"],
        compound_id=str(row["compound_id"]) if row.get("compound_id") else None,
        amount_mg=float(row["amount_mg"]) if row.get("amount_mg") is not None else None,
        purity_pct=float(row["purity_pct"]) if row.get("purity_pct") is not None else None,
        notes=row.get("notes"),
        created_at=row["created_at"],
        citation_uri=_sample_citation_uri(sid),
        valid_until=_valid_until_now(),
        results=[],
    )


def _encode_cursor(modified_at: datetime, entry_id: str) -> str:
    return f"{modified_at.isoformat()}|{entry_id}"


def _decode_cursor(cursor: str) -> tuple[datetime, str]:
    parts = cursor.split("|", 1)
    if len(parts) != 2:
        raise ValueError("cursor must be '<iso-timestamp>|<id>'")
    ts = _parse_iso(parts[0], "cursor")
    if ts is None:
        raise ValueError("cursor timestamp could not be parsed")
    eid = parts[1]
    if not _ID_RE.match(eid):
        raise ValueError("cursor id segment is invalid")
    return ts, eid


# --------------------------------------------------------------------------
# Endpoints
# --------------------------------------------------------------------------
@app.post("/experiments/query", response_model=ExperimentsQueryOut, tags=["eln"])
async def experiments_query(
    req: Annotated[ExperimentsQueryIn, Body(...)],
) -> ExperimentsQueryOut:
    since_dt = _parse_iso(req.since, "since")
    cursor_ts: datetime | None = None
    cursor_id: str | None = None
    if req.cursor:
        cursor_ts, cursor_id = _decode_cursor(req.cursor)

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

    async with _acquire() as conn:
        async with conn.cursor() as cur:
            await cur.execute("".join(sql), params)
            rows = await cur.fetchall()

    items = [_row_to_entry(r) for r in rows[: req.limit]]
    next_cursor: str | None = None
    if len(rows) > req.limit and items:
        last = items[-1]
        next_cursor = _encode_cursor(last.modified_at, last.id)

    return ExperimentsQueryOut(items=items, next_cursor=next_cursor)


async def _fetch_attachments(
    conn: psycopg.AsyncConnection, entry_id: str
) -> list[Attachment]:
    async with conn.cursor() as cur:
        await cur.execute(
            """
            SELECT id, filename, mime_type, size_bytes, description, uri, created_at
            FROM mock_eln.entry_attachments
            WHERE entry_id = %(entry_id)s::uuid
            ORDER BY created_at ASC
            """,
            {"entry_id": entry_id},
        )
        rows = await cur.fetchall()
    return [_row_to_attachment(r) for r in rows]


async def _fetch_audit_summary(
    conn: psycopg.AsyncConnection, entry_id: str, limit: int = 20
) -> list[AuditEntry]:
    async with conn.cursor() as cur:
        await cur.execute(
            """
            SELECT actor_email, action, field_path, occurred_at, reason
            FROM mock_eln.audit_trail
            WHERE entry_id = %(entry_id)s::uuid
            ORDER BY occurred_at DESC
            LIMIT %(limit)s
            """,
            {"entry_id": entry_id, "limit": limit},
        )
        rows = await cur.fetchall()
    return [_row_to_audit(r) for r in rows]


@app.post("/experiments/fetch", response_model=ElnEntry, tags=["eln"])
async def experiments_fetch(
    req: Annotated[ExperimentsFetchIn, Body(...)],
) -> ElnEntry:
    async with _acquire() as conn:
        async with conn.cursor() as cur:
            await cur.execute(
                """
                SELECT e.id, e.notebook_id, e.project_id, e.reaction_id, e.schema_kind,
                       e.title, e.author_email, e.signed_by, e.status, e.entry_shape,
                       e.data_quality_tier, e.fields_jsonb, e.freetext,
                       e.freetext_length_chars, e.created_at, e.modified_at, e.signed_at,
                       p.code AS project_code
                FROM mock_eln.entries e
                JOIN mock_eln.projects p ON p.id = e.project_id
                WHERE e.id = %(entry_id)s::uuid
                LIMIT 1
                """,
                {"entry_id": req.entry_id},
            )
            row = await cur.fetchone()

        if row is None:
            raise HTTPException(
                status_code=404,
                detail={"error": "not_found", "detail": f"entry {req.entry_id!r} not found"},
            )
        entry = _row_to_entry(row)
        entry.attachments = await _fetch_attachments(conn, entry.id)
        entry.audit_summary = await _fetch_audit_summary(conn, entry.id)
        return entry


@app.post("/reactions/query", response_model=ReactionsQueryOut, tags=["eln"])
async def reactions_query(
    req: Annotated[ReactionsQueryIn, Body(...)],
) -> ReactionsQueryOut:
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

    async with _acquire() as conn:
        async with conn.cursor() as cur:
            await cur.execute("".join(sql), params)
            rows = await cur.fetchall()
    return ReactionsQueryOut(items=[_row_to_canonical_reaction(r) for r in rows])


@app.post(
    "/reactions/fetch",
    response_model=CanonicalReactionDetail,
    tags=["eln"],
)
async def reactions_fetch(
    req: Annotated[ReactionsFetchIn, Body(...)],
) -> CanonicalReactionDetail:
    async with _acquire() as conn:
        async with conn.cursor() as cur:
            await cur.execute(
                """
                SELECT v.reaction_id, v.canonical_smiles_rxn, v.family, v.project_id,
                       v.step_number, v.ofat_count, v.mean_yield, v.last_activity_at,
                       p.code AS project_code
                FROM mock_eln.canonical_reactions_with_ofat v
                JOIN mock_eln.projects p ON p.id = v.project_id
                WHERE v.reaction_id = %(reaction_id)s::uuid
                LIMIT 1
                """,
                {"reaction_id": req.reaction_id},
            )
            row = await cur.fetchone()

        if row is None:
            raise HTTPException(
                status_code=404,
                detail={
                    "error": "not_found",
                    "detail": f"reaction {req.reaction_id!r} not found",
                },
            )
        canonical = _row_to_canonical_reaction(row)

        children: list[ElnEntry] = []
        if req.top_n_ofat > 0:
            async with conn.cursor() as cur:
                await cur.execute(
                    """
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
                    """,
                    {"reaction_id": req.reaction_id, "limit": req.top_n_ofat},
                )
                child_rows = await cur.fetchall()
            children = [_row_to_entry(r) for r in child_rows]

        return CanonicalReactionDetail(
            **canonical.model_dump(),
            ofat_children=children,
        )


@app.post("/samples/fetch", response_model=Sample, tags=["eln"])
async def samples_fetch(
    req: Annotated[SamplesFetchIn, Body(...)],
) -> Sample:
    async with _acquire() as conn:
        async with conn.cursor() as cur:
            await cur.execute(
                """
                SELECT id, entry_id, sample_code, compound_id, amount_mg,
                       purity_pct, notes, created_at
                FROM mock_eln.samples
                WHERE id = %(sample_id)s::uuid
                LIMIT 1
                """,
                {"sample_id": req.sample_id},
            )
            row = await cur.fetchone()

        if row is None:
            raise HTTPException(
                status_code=404,
                detail={"error": "not_found", "detail": f"sample {req.sample_id!r} not found"},
            )
        sample = _row_to_sample(row)

        async with conn.cursor() as cur:
            await cur.execute(
                """
                SELECT id, method_id, metric, value_num, value_text, unit,
                       measured_at, metadata
                FROM mock_eln.results
                WHERE sample_id = %(sample_id)s::uuid
                ORDER BY measured_at DESC NULLS LAST, created_at DESC
                """,
                {"sample_id": sample.id},
            )
            result_rows = await cur.fetchall()
        sample.results = [_row_to_result(r) for r in result_rows]
        return sample


@app.post(
    "/attachments/metadata",
    response_model=AttachmentsMetadataOut,
    tags=["eln"],
)
async def attachments_metadata(
    req: Annotated[AttachmentsMetadataIn, Body(...)],
) -> AttachmentsMetadataOut:
    async with _acquire() as conn:
        # Verify the entry exists so we return 404 (not an empty list) for an
        # unknown id — keeps cache invalidation semantics tidy.
        async with conn.cursor() as cur:
            await cur.execute(
                "SELECT 1 FROM mock_eln.entries WHERE id = %(entry_id)s::uuid LIMIT 1",
                {"entry_id": req.entry_id},
            )
            exists = await cur.fetchone()
        if exists is None:
            raise HTTPException(
                status_code=404,
                detail={"error": "not_found", "detail": f"entry {req.entry_id!r} not found"},
            )
        attachments = await _fetch_attachments(conn, req.entry_id)
        return AttachmentsMetadataOut(entry_id=req.entry_id, attachments=attachments)


@app.post("/samples/by_entry", response_model=SamplesByEntryOut, tags=["eln"])
async def samples_by_entry(
    req: Annotated[SamplesByEntryIn, Body(...)],
) -> SamplesByEntryOut:
    """Return all samples linked to one ELN entry.

    The cross-source path (ELN entry → samples → fake_logs.datasets) was
    blocked without this endpoint: clients had to know sample IDs upfront.
    Now `query_eln_canonical_reactions` → `fetch_eln_canonical_reaction`
    (gives entry IDs) → `query_eln_samples_by_entry` (gives sample codes)
    → `query_instrument_datasets` (cross-source linkage by sample_id)
    works end to end.
    """
    async with _acquire() as conn:
        # 404 on unknown entry — same idiom as /attachments/metadata so
        # downstream cache layers can distinguish "no samples" from "no entry".
        async with conn.cursor() as cur:
            await cur.execute(
                "SELECT 1 FROM mock_eln.entries WHERE id = %(entry_id)s::uuid LIMIT 1",
                {"entry_id": req.entry_id},
            )
            exists = await cur.fetchone()
        if exists is None:
            raise HTTPException(
                status_code=404,
                detail={"error": "not_found", "detail": f"entry {req.entry_id!r} not found"},
            )
        async with conn.cursor() as cur:
            await cur.execute(
                """
                SELECT id, entry_id, sample_code, compound_id, amount_mg,
                       purity_pct, notes, created_at
                FROM mock_eln.samples
                WHERE entry_id = %(entry_id)s::uuid
                ORDER BY sample_code ASC
                """,
                {"entry_id": req.entry_id},
            )
            sample_rows = await cur.fetchall()
        samples = [_row_to_sample(r) for r in sample_rows]
        return SamplesByEntryOut(entry_id=req.entry_id, samples=samples)


# --------------------------------------------------------------------------
# Entry point (local dev)
# --------------------------------------------------------------------------
if __name__ == "__main__":
    import uvicorn

    uvicorn.run(
        "services.mcp_tools.mcp_eln_local.main:app",
        host=settings.host,
        port=settings.port,
        log_level=settings.log_level.lower(),
    )
