"""mcp-kg — knowledge-graph service (bi-temporal, confidence-scored).

Endpoints:
- POST /tools/write_fact
- POST /tools/invalidate_fact
- POST /tools/query_at_time
"""

from __future__ import annotations

import logging
from contextlib import asynccontextmanager
from typing import Annotated

from fastapi import Body, FastAPI, HTTPException
from fastapi.responses import JSONResponse

from services.mcp_tools.common.logging import configure_logging
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
configure_logging(settings.log_level)

# Driver is created in lifespan (not at module import) so health checks and
# tests can manage it independently.
_driver_holder: dict[str, KGDriver] = {}


@asynccontextmanager
async def lifespan(_app: FastAPI):
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
        log.info("mcp-kg stopping")
        await drv.close()
        _driver_holder.clear()


app = FastAPI(title="mcp-kg", version="0.1.0", lifespan=lifespan)


def _driver() -> KGDriver:
    drv = _driver_holder.get("driver")
    if drv is None:
        raise RuntimeError("KGDriver not initialised (lifespan not yet run)")
    return drv


# --------------------------------------------------------------------------
# Health / readiness
# --------------------------------------------------------------------------
@app.get("/healthz")
async def healthz() -> dict[str, str]:
    return {"status": "ok", "service": "mcp-kg", "version": "0.1.0"}


@app.get("/readyz")
async def readyz() -> dict[str, str]:
    try:
        await _driver().verify()
    except Exception as exc:  # noqa: BLE001 — any failure means "not ready"
        return JSONResponse(
            status_code=503, content={"status": "degraded", "detail": str(exc)}
        )
    return {"status": "ok", "neo4j": "up"}


# --------------------------------------------------------------------------
# Tools
# --------------------------------------------------------------------------
@app.post("/tools/write_fact", response_model=WriteFactResponse, tags=["kg"])
async def write_fact(req: Annotated[WriteFactRequest, Body(...)]) -> WriteFactResponse:
    try:
        return await _driver().write_fact(req)
    except ValueError as exc:
        raise HTTPException(status_code=400, detail=str(exc)) from exc


@app.post("/tools/invalidate_fact", response_model=InvalidateFactResponse, tags=["kg"])
async def invalidate_fact(
    req: Annotated[InvalidateFactRequest, Body(...)],
) -> InvalidateFactResponse:
    try:
        return await _driver().invalidate_fact(req)
    except LookupError as exc:
        raise HTTPException(status_code=404, detail=str(exc)) from exc
    except ValueError as exc:
        raise HTTPException(status_code=400, detail=str(exc)) from exc


@app.post("/tools/query_at_time", response_model=QueryAtTimeResponse, tags=["kg"])
async def query_at_time(
    req: Annotated[QueryAtTimeRequest, Body(...)],
) -> QueryAtTimeResponse:
    try:
        return await _driver().query_at_time(req)
    except ValueError as exc:
        raise HTTPException(status_code=400, detail=str(exc)) from exc


if __name__ == "__main__":
    import uvicorn

    uvicorn.run(
        "services.mcp_tools.mcp_kg.main:app",
        host=settings.host,
        port=settings.port,
        log_level=settings.log_level.lower(),
    )
