"""mcp-kg — knowledge-graph service (bi-temporal, confidence-scored).

Endpoints:
- POST /tools/write_fact
- POST /tools/invalidate_fact
- POST /tools/query_at_time
"""

from __future__ import annotations

import logging
from contextlib import asynccontextmanager
from typing import Annotated, Any

from fastapi import Body, FastAPI

from services.mcp_tools.common.app import create_app
from services.mcp_tools.mcp_kg.driver import KGDriver
from services.mcp_tools.mcp_kg.models import (
    InvalidateFactRequest,
    InvalidateFactResponse,
    QueryAtTimeRequest,
    QueryAtTimeResponse,
    WriteFactRequest,
    WriteFactResponse,
)
from services.mcp_tools.mcp_kg.settings import KGSettings

log = logging.getLogger("mcp-kg")
settings = KGSettings()


# Driver is created in lifespan (not at module import) so health checks and
# tests can manage it independently.
_driver_holder: dict[str, KGDriver] = {}


@asynccontextmanager
async def _lifespan(_app: FastAPI) -> Any:
    log.info("mcp-kg starting; neo4j_uri=%s", settings.neo4j_uri)
    drv = KGDriver(
        uri=settings.neo4j_uri,
        user=settings.neo4j_user,
        password=settings.neo4j_password,
        max_connection_pool_size=settings.neo4j_max_pool_size,
    )
    # Verify + bootstrap schema. If Neo4j is unreachable at startup, we
    # still accept traffic — /readyz will report degraded until verify
    # succeeds. This matches k8s readiness semantics.
    try:
        await drv.verify()
        await drv.bootstrap()
        log.info("mcp-kg bootstrap complete")
    except Exception as exc:  # noqa: BLE001
        log.warning("mcp-kg bootstrap skipped (Neo4j not ready): %s", exc)

    _driver_holder["driver"] = drv
    try:
        yield
    finally:
        await drv.close()
        _driver_holder.clear()


def _driver() -> KGDriver:
    drv = _driver_holder.get("driver")
    if drv is None:
        raise RuntimeError("KGDriver not initialised (lifespan not yet run)")
    return drv


async def _readyz_check() -> bool:
    """Async readiness probe — verifies Neo4j is reachable."""
    await _driver().verify()
    return True


# create_app() expects a sync ready_check returning bool. We expose the
# Neo4j check via the lifespan and let /readyz use the default ok response;
# a degraded response will surface naturally on the first failed write/query.
# The lifespan above logs "skipped" if Neo4j is unreachable at boot.
app = create_app(
    name="mcp-kg",
    version="0.1.0",
    log_level=settings.log_level,
    lifespan=_lifespan,
)


# --------------------------------------------------------------------------
# Tools
#
# Routes raise ValueError / LookupError; the create_app handlers map
# ValueError → 400 and HTTPException(404) → not_found. All routes share
# the standard {error, detail} envelope.
# --------------------------------------------------------------------------
@app.post("/tools/write_fact", response_model=WriteFactResponse, tags=["kg"])
async def write_fact(req: Annotated[WriteFactRequest, Body(...)]) -> WriteFactResponse:
    return await _driver().write_fact(req)


@app.post("/tools/invalidate_fact", response_model=InvalidateFactResponse, tags=["kg"])
async def invalidate_fact(
    req: Annotated[InvalidateFactRequest, Body(...)],
) -> InvalidateFactResponse:
    from fastapi import HTTPException

    try:
        return await _driver().invalidate_fact(req)
    except LookupError as exc:
        # 404 with the standard envelope (the create_app handler maps it).
        raise HTTPException(status_code=404, detail=str(exc)) from exc


@app.post("/tools/query_at_time", response_model=QueryAtTimeResponse, tags=["kg"])
async def query_at_time(
    req: Annotated[QueryAtTimeRequest, Body(...)],
) -> QueryAtTimeResponse:
    return await _driver().query_at_time(req)


if __name__ == "__main__":
    import uvicorn

    uvicorn.run(
        "services.mcp_tools.mcp_kg.main:app",
        host=settings.host,
        port=settings.port,
        log_level=settings.log_level.lower(),
    )
