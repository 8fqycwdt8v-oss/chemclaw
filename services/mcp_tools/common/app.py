"""FastAPI app factory shared by MCP tool services.

Every tool service is a small FastAPI app exposing:
- GET /healthz — liveness
- GET /readyz  — readiness (override if the tool has dependencies)
- POST /tools/<name> — invoke a tool

The MCP-over-HTTP wrapper (Streamable HTTP transport) will be layered on in
sprint 3. For now, this is plain JSON REST.
"""

from __future__ import annotations

import logging
import uuid
from collections.abc import Callable
from contextlib import asynccontextmanager
from typing import Any

from fastapi import FastAPI, Request
from fastapi.responses import JSONResponse

from services.mcp_tools.common.logging import configure_logging

log = logging.getLogger("mcp.common")


def create_app(
    name: str,
    version: str,
    log_level: str = "INFO",
    ready_check: Callable[[], bool] | None = None,
) -> FastAPI:
    """Build a FastAPI app with the standard shape for an MCP tool service."""
    configure_logging(log_level)

    @asynccontextmanager
    async def lifespan(_app: FastAPI) -> Any:
        log.info("starting %s@%s", name, version)
        yield
        log.info("stopping %s", name)

    app = FastAPI(title=name, version=version, lifespan=lifespan)

    @app.middleware("http")
    async def add_request_id(request: Request, call_next: Callable):
        rid = request.headers.get("x-request-id") or str(uuid.uuid4())
        request.state.request_id = rid
        response = await call_next(request)
        response.headers["x-request-id"] = rid
        return response

    @app.exception_handler(ValueError)
    async def handle_value_error(request: Request, exc: ValueError) -> JSONResponse:
        return JSONResponse(
            status_code=400,
            content={"error": "invalid_input", "detail": str(exc)},
            headers={"x-request-id": getattr(request.state, "request_id", "")},
        )

    @app.get("/healthz", tags=["internal"])
    async def healthz() -> dict[str, str]:
        return {"status": "ok", "service": name, "version": version}

    @app.get("/readyz", tags=["internal"])
    async def readyz() -> dict[str, Any]:
        if ready_check is None:
            return {"status": "ok", "service": name}
        try:
            ok = ready_check()
        except Exception as exc:  # noqa: BLE001 — any failure is "not ready"
            return JSONResponse(status_code=503, content={"status": "degraded", "detail": str(exc)})
        return (
            {"status": "ok", "service": name}
            if ok
            else JSONResponse(status_code=503, content={"status": "degraded"})
        )

    return app
