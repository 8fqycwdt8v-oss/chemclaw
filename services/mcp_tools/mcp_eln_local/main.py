"""mcp-eln-local — Postgres-backed mock ELN MCP service.

Reads the `mock_eln` schema in the chemclaw DB via a dedicated read-only
role (`chemclaw_mock_eln_reader`). Surfaces ELN entries / canonical
reactions / samples / attachments at a stable, tool-agnostic shape so
the agent can treat this MCP exactly like a vendor ELN adapter.

Endpoints (all POST, JSON body): see routes.py. Citation URIs:
    local-mock-eln://eln/entry/{entry_id}
    local-mock-eln://eln/reaction/{reaction_id}

Each response carries `valid_until = NOW() + INTERVAL '7 days'` so the
post-tool source-cache hook can stamp temporal provenance on derived
:Fact nodes. After PR-7 split: settings + app + lifespan + `_acquire`
live here; models.py / queries.py / routes.py hold the rest.
"""

from __future__ import annotations

import logging
from contextlib import asynccontextmanager
from typing import AsyncIterator

import psycopg
from fastapi import FastAPI, HTTPException
from psycopg.rows import dict_row
import psycopg_pool
from psycopg_pool import AsyncConnectionPool
from pydantic_settings import SettingsConfigDict

from services.mcp_tools.common.app import create_app
from services.mcp_tools.common.dev_sentinels import DEV_MOCK_ELN_READER_PASSWORD
from services.mcp_tools.common.settings import ToolSettings

from .routes import register_routes


log = logging.getLogger("mcp-eln-local")


# Sentinel password used by db/init/30_mock_eln_schema.sql when the
# `chemclaw.mock_eln_reader_password` GUC is unset. If the configured
# DSN still contains this literal we refuse to start unless explicitly
# allowed via MOCK_ELN_ALLOW_DEV_PASSWORD=true (set in dev-compose).
# Imported from common/dev_sentinels.py so all services that guard on
# the same value rotate it together (cycle 4).
_DEV_SENTINEL_PASSWORD = DEV_MOCK_ELN_READER_PASSWORD


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

    psycopg's async connection is not safe for concurrent operations (one
    cursor at a time), so requests must each take a fresh pooled conn.
    Three classes of transient failure surface as a structured 503 so
    upstream clients can distinguish "service degraded, retry" from a bug:
    OperationalError (DB restart mid-request), PoolTimeout (all conns busy),
    PoolClosed (pool shut down between lookup and connection call).
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
    except (psycopg.OperationalError, psycopg_pool.PoolTimeout, psycopg_pool.PoolClosed) as exc:
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

register_routes(app, settings)


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
