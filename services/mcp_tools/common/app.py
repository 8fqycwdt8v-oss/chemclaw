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
import os
import time
import uuid
from collections.abc import Awaitable, Callable
from contextlib import asynccontextmanager
from typing import Any

from fastapi import FastAPI, HTTPException, Request, Response, status
from fastapi.responses import JSONResponse

from services.mcp_tools.common.log_context import bind_log_context, reset_log_context
from services.mcp_tools.common.logging import configure_logging
from services.mcp_tools.common.user_hash import hash_user


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
    required_scope: str | None = None,
) -> FastAPI:
    """Build a FastAPI app with the standard shape for an MCP tool service.

    Pass `lifespan` if your service needs to manage resources (DB drivers,
    HTTP clients) across the app lifetime. The factory wraps the supplied
    lifespan so the standard start/stop logs still fire.

    Bearer-token authentication (ADR 006 partial) is wired automatically.
    By default it runs in dev mode — calls without a token are accepted with
    a warning so existing tests still pass. Set MCP_AUTH_REQUIRED=true in
    production to enforce verification on every non-probe request.

    `required_scope` enforces ADR 006 Layer 2 scope checking. When auth is
    enforced and the verified token's `scopes` claim does not contain the
    given string, the middleware returns 403. When `required_scope` is
    omitted (None), the middleware looks up the service's scope from
    `services.mcp_tools.common.scopes.SERVICE_SCOPES[name]`. The agent's
    TS-side `SERVICE_SCOPES` mirror in
    `services/agent-claw/src/security/mcp-token-cache.ts` must match — a
    pact test asserts equality across the language boundary.

    Cycle 3 also binds tokens to a specific service via the JWT `aud`
    claim: the middleware passes `expected_audience=name` to the verifier,
    which rejects tokens minted for a different service. This closes the
    "lifted token replayed across blue/green deployments" gap that scope-
    only enforcement leaves open.

    Probe paths (/healthz, /readyz, /internal/*) are always exempt; the
    `/internal/` exemption rejects path-traversal segments (`..`).
    """
    configure_logging(log_level, service=name)
    # Imported lazily so unit tests of `auth.py` don't drag in FastAPI.
    from services.mcp_tools.common.auth import _require_or_skip
    from services.mcp_tools.common.scopes import SERVICE_SCOPES

    # Single source of truth: prefer SERVICE_SCOPES[name] so a typo in any
    # service's main.py can't ship a silent 403 in production. The
    # `required_scope=""` sentinel is the explicit opt-out for the rare
    # service that legitimately has no required scope; it bypasses the
    # reconciliation check below (an empty string can never match a real
    # catalog entry). `required_scope=None` defers to the catalog.
    catalog_scope = SERVICE_SCOPES.get(name)
    if (
        required_scope is not None
        and required_scope != ""  # explicit opt-out
        and catalog_scope is not None
        and required_scope != catalog_scope
    ):
        raise RuntimeError(
            f"create_app(name={name!r}) got required_scope={required_scope!r} but "
            f"SERVICE_SCOPES[{name!r}]={catalog_scope!r}; reconcile in "
            "services/mcp_tools/common/scopes.py before starting."
        )
    effective_scope = required_scope if required_scope is not None else catalog_scope

    # Catalog-omission fail-OPEN guard (cycle 4, hardened cycle 5): a future
    # service registered with a name not in SERVICE_SCOPES and no explicit
    # required_scope would silently disable the scope check whenever auth
    # is being enforced.
    #
    # Use the same `_require_or_skip()` policy as the runtime middleware so
    # the startup guard fires under the EXACT same conditions enforcement
    # is active — including the cycle-1 fail-closed default where
    # MCP_AUTH_REQUIRED is unset and MCP_AUTH_DEV_MODE is not "true". A
    # prior cycle-4 implementation read MCP_AUTH_REQUIRED directly,
    # disagreed with the runtime policy, and re-opened the gap when an
    # operator used the documented MCP_AUTH_DEV_MODE=false-style toggle.
    if (
        _require_or_skip()
        and required_scope is None
        and catalog_scope is None
        and not name.startswith("mcp-test")  # test fixture prefix
    ):
        raise RuntimeError(
            f"create_app(name={name!r}) is in enforced-auth mode but the service "
            f"is not in SERVICE_SCOPES and required_scope is None — every request "
            "would be accepted regardless of scope. Add the service to "
            "services/mcp_tools/common/scopes.py or pass required_scope=\"\" "
            "to opt out explicitly."
        )

    @asynccontextmanager
    async def _default_lifespan(app: FastAPI) -> Any:
        log.info("starting %s@%s", name, version)
        if lifespan is not None:
            async with lifespan(app):
                yield
        else:
            yield
        log.info("stopping %s", name)

    app = FastAPI(title=name, version=version, lifespan=_default_lifespan)

    # ADR 006 Layer 2 — Bearer-token auth on every /tools/* route.
    # Implemented as middleware (not a FastAPI dependency) so service code
    # doesn't need to thread `Depends(...)` into every route declaration.
    # Probes (/healthz, /readyz) are explicitly excluded — k8s liveness /
    # readiness must stay reachable regardless of auth state.
    #
    # In dev mode (MCP_AUTH_REQUIRED unset / "false"), missing / invalid
    # tokens are accepted with a warning. Existing test suites continue to
    # pass. Production sets MCP_AUTH_REQUIRED=true and the middleware
    # rejects unauthenticated /tools/* requests with 401.
    from services.mcp_tools.common.auth import (  # imported lazily
        McpAuthError,
        verify_mcp_token,
        _require_or_skip,
    )

    @app.middleware("http")
    async def mcp_auth_middleware(
        request: Request,
        call_next: Callable[[Request], Awaitable[Response]],
    ) -> Response:
        # Probes always pass. ONLY the explicit allowlist below is
        # exempted; an earlier blanket `/internal/*` prefix bypass was
        # removed because no MCP service registers `/internal/*` today,
        # and a future PR adding such a route would silently land
        # unauthenticated. If a service later needs a cluster-internal
        # endpoint, add it here explicitly (and gate by source IP /
        # secret as appropriate).
        path = request.url.path
        if path in ("/healthz", "/readyz"):
            return await call_next(request)

        enforce = _require_or_skip()
        authz = request.headers.get("authorization")
        if not authz:
            if enforce:
                return JSONResponse(
                    status_code=status.HTTP_401_UNAUTHORIZED,
                    content={"error": "unauthenticated", "detail": "missing Authorization header"},
                    headers={"WWW-Authenticate": "Bearer"},
                )
            # Dev mode — proceed without claims. Tools that need user context
            # can read the (None) claims via request.state.mcp_claims.
            request.state.mcp_claims = None
            return await call_next(request)

        parts = authz.split(" ", 1)
        if len(parts) != 2 or parts[0].lower() != "bearer" or not parts[1].strip():
            if enforce:
                return JSONResponse(
                    status_code=status.HTTP_401_UNAUTHORIZED,
                    content={"error": "unauthenticated", "detail": "expected `Authorization: Bearer <token>`"},
                    headers={"WWW-Authenticate": "Bearer"},
                )
            request.state.mcp_claims = None
            return await call_next(request)

        try:
            # ALWAYS bind the token to this specific service via the JWT
            # `aud` claim when a token is presented — even in dev mode.
            # The dev-mode opt-out (MCP_AUTH_REQUIRED unset / "false") is
            # ONLY about the missing-token branch above; if the caller IS
            # presenting a token, the cross-service replay surface that
            # `aud` closes is the same in dev and prod. Tests that mint
            # generic tokens should mint with the right `aud`, not rely
            # on the audience check being silently disabled.
            claims = verify_mcp_token(parts[1].strip(), expected_audience=name)
            request.state.mcp_claims = claims
        except McpAuthError as exc:
            # Always log MCP auth failures — in dev mode the request is
            # still allowed through (ADR 006), but the failure remains an
            # operationally interesting signal. Hash the user before logging
            # (claims has been verified-failed so we don't have a real user
            # here, but if the token's claim subset is recoverable we'd
            # surface it; for now the placeholder is empty).
            log.warning(
                "MCP token verification failed",
                extra={
                    "event": "mcp_auth_failed",
                    "error_code": "MCP_AUTH_FAILED",
                    "service": name,
                    "enforced": enforce,
                    "err_msg": str(exc),
                },
            )
            if enforce:
                return JSONResponse(
                    status_code=status.HTTP_401_UNAUTHORIZED,
                    content={"error": "unauthenticated", "detail": str(exc)},
                    headers={
                        "WWW-Authenticate": "Bearer",
                        "x-request-id": getattr(request.state, "request_id", ""),
                    },
                )
            request.state.mcp_claims = None
            return await call_next(request)

        # Scope enforcement (ADR 006 Layer 2). When required_scope is set and
        # auth is enforced, the verified token must carry that scope or the
        # request is rejected with 403. In dev mode the check is skipped so
        # local-dev / hermetic tests don't need to mint scoped tokens. The
        # empty-string sentinel means "explicitly opted out"; skip both
        # the catalog-omission startup guard and this runtime check.
        if enforce and effective_scope:
            if effective_scope not in claims.scopes:
                log.warning(
                    "scope check failed: %s required %s, token has %s",
                    name,
                    effective_scope,
                    list(claims.scopes),
                    extra={
                        "event": "mcp_scope_denied",
                        "error_code": "MCP_SCOPE_DENIED",
                        "service": name,
                        "required_scope": effective_scope,
                        "user": hash_user(getattr(claims, "user", "") or ""),
                    },
                )
                return JSONResponse(
                    status_code=status.HTTP_403_FORBIDDEN,
                    content={
                        "error": "forbidden",
                        "detail": f"token missing required scope {effective_scope!r}",
                    },
                    headers={"x-request-id": getattr(request.state, "request_id", "")},
                )

        # Bind the hashed user onto the log context for the rest of the
        # request lifetime so every record (handler logs, tool spans,
        # error logs) carries it. Token reset happens on the way back
        # through the middleware stack.
        user_hash = hash_user(getattr(claims, "user", "") or "")
        if user_hash:
            user_token = bind_log_context(user=user_hash)
            try:
                return await call_next(request)
            finally:
                reset_log_context(user_token)
        return await call_next(request)

    @app.middleware("http")
    async def add_request_id(
        request: Request,
        call_next: Callable[[Request], Awaitable[Response]],
    ) -> Response:
        # Each MCP service hosts a `service` value that flows from
        # create_app(name=...) onto every log record (via the
        # `_ServiceFilter` set up in configure_logging). The request_id
        # binding scope is per-request only.
        rid = request.headers.get("x-request-id") or str(uuid.uuid4())
        request.state.request_id = rid
        token = bind_log_context(
            request_id=rid,
            session_id=request.headers.get("x-session-id") or "",
        )
        started = time.monotonic()
        try:
            response = await call_next(request)
        except Exception:
            # Per-request access log even on exception, then re-raise so the
            # exception handlers below can map it to a status code.
            duration_ms = int((time.monotonic() - started) * 1000)
            log.exception(
                "request failed before response",
                extra={
                    "event": "http_request_failed",
                    "method": request.method,
                    "path": request.url.path,
                    "duration_ms": duration_ms,
                },
            )
            reset_log_context(token)
            raise
        duration_ms = int((time.monotonic() - started) * 1000)
        # Skip access logs for probe endpoints — they fire every few
        # seconds from k8s liveness/readiness and would dominate the log
        # volume. Operators can re-enable by setting LOG_ACCESS_PROBES=true
        # if a probe failure investigation needs the trail.
        if request.url.path in ("/healthz", "/readyz") and (
            os.getenv("LOG_ACCESS_PROBES", "").lower() != "true"
        ):
            response.headers["x-request-id"] = rid
            reset_log_context(token)
            return response
        log.info(
            "http request",
            extra={
                "event": "http_request",
                "method": request.method,
                "path": request.url.path,
                "status": response.status_code,
                "duration_ms": duration_ms,
            },
        )
        response.headers["x-request-id"] = rid
        reset_log_context(token)
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

    @app.get("/readyz", tags=["internal"], response_model=None)
    async def readyz() -> dict[str, Any] | JSONResponse:
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
