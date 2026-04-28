"""mcp-logs-sciy — LOGS-by-SciY SDMS adapter.

Routes vendor-shaped LOGS analytical metadata through a single FastAPI app
backed by either a local Postgres ``fake_logs`` schema (dev / CI) or the
real SciY tenant via ``logs-python`` (stub for now).

Endpoints:
- POST /datasets/query     — keyset-paginated dataset listing
- POST /datasets/fetch     — single dataset by UID
- POST /datasets/by_sample — datasets joined to a sample_id
- POST /persons/query      — operator lookup (LOGS Person API parity)
"""

from __future__ import annotations

import logging
import os
import re
from contextlib import asynccontextmanager
from datetime import datetime
from typing import Annotated, Any, Literal

from fastapi import Body, FastAPI, HTTPException
from pydantic import BaseModel, Field, field_validator
from pydantic_settings import SettingsConfigDict

from services.mcp_tools.common.settings import ToolSettings

from services.mcp_tools.common.app import create_app
from services.mcp_tools.mcp_logs_sciy.backends import (
    FakePostgresBackend,
    RealLogsBackend,
)

log = logging.getLogger("mcp-logs-sciy")


# Sentinel password used in dev-compose for the read-only fake_logs reader.
# If the configured DSN still contains this literal we refuse to start unless
# `LOGS_ALLOW_DEV_PASSWORD=true` is set, mirroring the mcp_eln_local guard.
# Imported from common/dev_sentinels.py so all services rotate together.
from services.mcp_tools.common.dev_sentinels import DEV_MOCK_ELN_READER_PASSWORD

_DEV_SENTINEL_PASSWORD = DEV_MOCK_ELN_READER_PASSWORD


# ---------------------------------------------------------------------------
# Settings
# ---------------------------------------------------------------------------
class LogsSettings(ToolSettings):
    """Environment-driven configuration. Inherits host/log_level from
    ``ToolSettings`` so this MCP follows the same convention as every
    other one (mcp_kg, mcp_drfp, …)."""

    model_config = SettingsConfigDict(env_file=None, extra="ignore")

    # ToolSettings already declares host/port/log_level. We override port
    # to the LOGS-specific 8016 default and let host/log_level inherit.
    port: int = Field(default=8016, alias="MCP_LOGS_SCIY_PORT")

    # Backend selection — "fake-postgres" for hermetic dev/CI, "real" for the
    # logs-python SDK against a live LOGS tenant.
    backend: Literal["fake-postgres", "real"] = Field(
        default="fake-postgres", alias="LOGS_BACKEND"
    )

    # Fake-postgres backend settings.
    postgres_host: str = Field(default="localhost", alias="POSTGRES_HOST")
    postgres_port: int = Field(default=5432, alias="POSTGRES_PORT")
    postgres_db: str = Field(default="chemclaw", alias="POSTGRES_DB")
    postgres_user: str = Field(default="chemclaw_mock_eln_reader", alias="POSTGRES_USER")
    postgres_password: str = Field(
        default=_DEV_SENTINEL_PASSWORD,
        alias="POSTGRES_PASSWORD",
    )

    # Explicit acknowledgement that we're running with the dev sentinel
    # password. Defaults to false so production deployments fail-closed
    # if the operator forgets to override POSTGRES_PASSWORD.
    logs_allow_dev_password: bool = Field(default=False, alias="LOGS_ALLOW_DEV_PASSWORD")

    # Real backend settings (placeholders — not used until Phase 4).
    real_tenant_url: str | None = Field(default=None, alias="LOGS_TENANT_URL")
    real_api_key: str | None = Field(default=None, alias="LOGS_API_KEY")

    @property
    def postgres_dsn(self) -> str:
        return (
            f"postgresql://{self.postgres_user}:{self.postgres_password}"
            f"@{self.postgres_host}:{self.postgres_port}/{self.postgres_db}"
        )


settings = LogsSettings()


# ---------------------------------------------------------------------------
# Schemas
# ---------------------------------------------------------------------------
INSTRUMENT_KINDS = ("HPLC", "NMR", "MS", "GC-MS", "LC-MS", "IR")
InstrumentKind = Literal["HPLC", "NMR", "MS", "GC-MS", "LC-MS", "IR"]

# Project / sample identifier shape — letters, digits, dash, underscore only.
# Length-bounded by construction so the regex can't backtrack.
_PROJECT_CODE_RE = re.compile(r"^[A-Za-z0-9_-]{1,64}$")
_SAMPLE_ID_RE = re.compile(r"^[A-Za-z0-9_.\-]{1,128}$")
_UID_RE = re.compile(r"^[A-Za-z0-9_.\-]{1,128}$")


class Track(BaseModel):
    track_index: int
    detector: str | None = None
    unit: str | None = None
    peaks: list[dict[str, Any]] = Field(default_factory=list)


class Person(BaseModel):
    username: str
    display_name: str | None = None
    email: str | None = None


class LogsDataset(BaseModel):
    backend: Literal["fake-postgres", "real"]
    uid: str
    name: str
    instrument_kind: InstrumentKind
    instrument_serial: str | None = None
    method_name: str | None = None
    sample_id: str | None = None
    sample_name: str | None = None
    operator: str | None = None
    measured_at: datetime
    parameters: dict[str, Any] = Field(default_factory=dict)
    tracks: list[Track] = Field(default_factory=list)
    project_code: str | None = None
    citation_uri: str


# ---- Requests --------------------------------------------------------------
class DatasetsQueryRequest(BaseModel):
    instrument_kind: list[InstrumentKind] | None = None
    since: datetime | None = None
    project_code: str | None = None
    sample_name: str | None = None
    limit: int = Field(default=50, ge=1, le=200)
    cursor: str | None = None

    @field_validator("project_code")
    @classmethod
    def _validate_project_code(cls, v: str | None) -> str | None:
        if v is None:
            return v
        if not _PROJECT_CODE_RE.fullmatch(v):
            raise ValueError("project_code must match ^[A-Za-z0-9_-]{1,64}$")
        return v

    @field_validator("sample_name")
    @classmethod
    def _validate_sample_name(cls, v: str | None) -> str | None:
        if v is None:
            return v
        v = v.strip()
        if not v:
            raise ValueError("sample_name must be non-empty")
        if len(v) > 200:
            raise ValueError("sample_name must be <= 200 chars")
        return v

    @field_validator("cursor")
    @classmethod
    def _validate_cursor(cls, v: str | None) -> str | None:
        if v is None:
            return v
        if not v or len(v) > 1024:
            raise ValueError("cursor length out of range")
        return v


class DatasetsFetchRequest(BaseModel):
    uid: str

    @field_validator("uid")
    @classmethod
    def _validate_uid(cls, v: str) -> str:
        if not _UID_RE.fullmatch(v):
            raise ValueError("uid must match ^[A-Za-z0-9_.\\-]{1,128}$")
        return v


class DatasetsBySampleRequest(BaseModel):
    sample_id: str

    @field_validator("sample_id")
    @classmethod
    def _validate_sample_id(cls, v: str) -> str:
        if not _SAMPLE_ID_RE.fullmatch(v):
            raise ValueError("sample_id must match ^[A-Za-z0-9_.\\-]{1,128}$")
        return v


class PersonsQueryRequest(BaseModel):
    name_contains: str | None = None
    limit: int = Field(default=50, ge=1, le=200)

    @field_validator("name_contains")
    @classmethod
    def _validate_name_contains(cls, v: str | None) -> str | None:
        if v is None:
            return v
        v = v.strip()
        if not v:
            raise ValueError("name_contains must be non-empty when provided")
        if len(v) > 200:
            raise ValueError("name_contains must be <= 200 chars")
        return v


# ---- Responses -------------------------------------------------------------
class DatasetsQueryResponse(BaseModel):
    datasets: list[LogsDataset]
    next_cursor: str | None = None
    valid_until: datetime


class DatasetsFetchResponse(BaseModel):
    dataset: LogsDataset
    valid_until: datetime


class DatasetsBySampleResponse(BaseModel):
    datasets: list[LogsDataset]
    valid_until: datetime


class PersonsQueryResponse(BaseModel):
    persons: list[Person]
    valid_until: datetime


# ---------------------------------------------------------------------------
# Backend wiring
# ---------------------------------------------------------------------------
_backend_holder: dict[str, Any] = {}


def _build_backend() -> FakePostgresBackend | RealLogsBackend:
    if settings.backend == "fake-postgres":
        return FakePostgresBackend(settings.postgres_dsn)
    return RealLogsBackend(
        tenant_url=settings.real_tenant_url, api_key=settings.real_api_key
    )


def _check_dsn_safety() -> None:
    """Refuse to start if the fake-postgres DSN still contains the dev
    sentinel password and the operator hasn't explicitly opted into it."""
    if (
        settings.backend == "fake-postgres"
        and _DEV_SENTINEL_PASSWORD in settings.postgres_password
        and not settings.logs_allow_dev_password
    ):
        raise RuntimeError(
            "mcp-logs-sciy refusing to start: POSTGRES_PASSWORD contains the "
            "dev sentinel but LOGS_ALLOW_DEV_PASSWORD is not set. Either "
            "override POSTGRES_PASSWORD with a real password, or set "
            "LOGS_ALLOW_DEV_PASSWORD=true to acknowledge dev usage."
        )


@asynccontextmanager
async def _lifespan(_app: FastAPI):  # type: ignore[no-untyped-def]
    _check_dsn_safety()
    log.info("mcp-logs-sciy starting; backend=%s", settings.backend)
    # Fail fast for the real backend if it hasn't been wired yet — better
    # than passing /readyz at boot only to 500 every actual request.
    # When the real backend lands, swap RealLogsBackend.ready() to a real
    # tenant-auth check; the existing NotImplementedError is the
    # fail-fast we want today.
    if settings.backend == "real" and not (
        settings.real_tenant_url and settings.real_api_key
    ):
        raise RuntimeError(
            "mcp-logs-sciy: backend=real requires LOGS_REAL_TENANT_URL and "
            "LOGS_REAL_API_KEY; refusing to start with empty config."
        )
    _backend_holder["backend"] = _build_backend()
    _backend_holder["healthy"] = settings.backend == "fake-postgres"
    try:
        yield
    finally:
        _backend_holder.clear()


def _backend() -> FakePostgresBackend | RealLogsBackend:
    b = _backend_holder.get("backend")
    if b is None:
        raise RuntimeError("backend not initialised (lifespan not yet run)")
    return b


def _ready_check() -> bool:
    # The fake-postgres backend is always considered healthy when wired:
    # connectivity is exercised by the routes themselves and a transient
    # DB blip should not flap /readyz.
    # The real backend is intentionally unhealthy until the SDK lands —
    # fail-closed is the safer default while NotImplementedError is the
    # only behaviour the routes expose.
    return bool(_backend_holder.get("healthy"))


app = create_app(
    name="mcp-logs-sciy",
    version="0.1.0",
    log_level=settings.log_level,
    lifespan=_lifespan,
    ready_check=_ready_check,
    required_scope="mcp_instrument:read",
)


# ---------------------------------------------------------------------------
# Routes
# ---------------------------------------------------------------------------
@app.post("/datasets/query", response_model=DatasetsQueryResponse, tags=["logs"])
async def datasets_query(
    req: Annotated[DatasetsQueryRequest, Body(...)],
) -> DatasetsQueryResponse:
    return DatasetsQueryResponse.model_validate(
        await _backend().query_datasets(
            instrument_kind=list(req.instrument_kind) if req.instrument_kind else None,
            since=req.since,
            project_code=req.project_code,
            sample_name=req.sample_name,
            limit=req.limit,
            cursor=req.cursor,
        )
    )


@app.post("/datasets/fetch", response_model=DatasetsFetchResponse, tags=["logs"])
async def datasets_fetch(
    req: Annotated[DatasetsFetchRequest, Body(...)],
) -> DatasetsFetchResponse:
    payload = await _backend().fetch_dataset(uid=req.uid)
    if payload.get("dataset") is None:
        raise HTTPException(status_code=404, detail=f"dataset not found: {req.uid}")
    return DatasetsFetchResponse.model_validate(payload)


@app.post(
    "/datasets/by_sample", response_model=DatasetsBySampleResponse, tags=["logs"]
)
async def datasets_by_sample(
    req: Annotated[DatasetsBySampleRequest, Body(...)],
) -> DatasetsBySampleResponse:
    return DatasetsBySampleResponse.model_validate(
        await _backend().fetch_by_sample(sample_id=req.sample_id)
    )


@app.post("/persons/query", response_model=PersonsQueryResponse, tags=["logs"])
async def persons_query(
    req: Annotated[PersonsQueryRequest, Body(...)],
) -> PersonsQueryResponse:
    return PersonsQueryResponse.model_validate(
        await _backend().query_persons(
            name_contains=req.name_contains, limit=req.limit
        )
    )


if __name__ == "__main__":
    import uvicorn

    uvicorn.run(
        "services.mcp_tools.mcp_logs_sciy.main:app",
        host=settings.host,
        port=settings.port,
        log_level=settings.log_level.lower(),
    )
