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

from fastapi import FastAPI, HTTPException, Request
from fastapi.responses import JSONResponse

from services.mcp_tools.common.logging import configure_logging


# Standard error codes used in the {error, detail} envelope. Services should
# pass one of these to HTTPException(status_code=..., detail={"error": CODE,
# "detail": "..."}) — the handler below preserves them verbatim.
ERROR_CODE_INVALID_INPUT = "invalid_input"
ERROR_CODE_NOT_FOUND = "not_found"
ERROR_CODE_NOT_IMPLEMENTED = "not_implemented"
ERROR_CODE_UPSTREAM = "upstream_error"
ERROR_CODE_DEGRADED = "degraded"

log = logging.getLogger("mcp.common")


def create_app(
    name: str,
    version: str,
    log_level: str = "INFO",
    ready_check: Callable[[], bool] | Callable[[], Any] | None = None,
    lifespan: Callable[[FastAPI], Any] | None = None,
) -> FastAPI:
    """Build a FastAPI app with the standard shape for an MCP tool service.

    Pass `lifespan` if your service needs to manage resources (DB drivers,
    HTTP clients) across the app lifetime. The factory wraps the supplied
    lifespan so the standard start/stop logs still fire.
    """
    configure_logging(log_level)

    @asynccontextmanager
    async def _default_lifespan(app: FastAPI) -> Any:
        log.info("starting %s@%s", name, version)
        if lifespan is not None:
            async with lifespan(app):  # type: ignore[misc]
                yield
        else:
            yield
        log.info("stopping %s", name)

    app = FastAPI(title=name, version=version, lifespan=_default_lifespan)

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
            content={"error": ERROR_CODE_INVALID_INPUT, "detail": str(exc)},
            headers={"x-request-id": getattr(request.state, "request_id", "")},
        )

    @app.exception_handler(HTTPException)
    async def handle_http_exception(request: Request, exc: HTTPException) -> JSONResponse:
        # Standardize the error envelope across the fleet. Services may pass
        # detail as either a plain string ("not found") or a dict that already
        # contains an `error` code — preserve both shapes.
        if isinstance(exc.detail, dict) and "error" in exc.detail:
            content = exc.detail
        else:
            # Map common status codes to error codes so clients can switch on
            # `error` without reading status_code.
            code_map = {
                400: ERROR_CODE_INVALID_INPUT,
                404: ERROR_CODE_NOT_FOUND,
                501: ERROR_CODE_NOT_IMPLEMENTED,
                502: ERROR_CODE_UPSTREAM,
                503: ERROR_CODE_DEGRADED,
            }
            content = {
                "error": code_map.get(exc.status_code, "error"),
                "detail": exc.detail if isinstance(exc.detail, str) else str(exc.detail),
            }
        return JSONResponse(
            status_code=exc.status_code,
            content=content,
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
