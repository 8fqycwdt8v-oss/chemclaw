"""Pytest fixtures shared across MCP service tests.

The auth middleware in `services/mcp_tools/common/app.py` now fails CLOSED
by default (security review D1 — production deploys that forget to set
the auth env shouldn't silently accept unsigned requests). Test suites
that exercise route handlers via Starlette's TestClient don't carry a
JWT, so they hit 401 unless the service is told this is a dev/test run.

Setting `MCP_AUTH_DEV_MODE=true` here at *collection* time (before any
service module is imported) declares intent without changing per-test
boilerplate. Production code paths read `MCP_AUTH_REQUIRED` first, so
this fixture is a no-op in any deploy that explicitly sets the var.
"""

from __future__ import annotations

import os


def _enable_dev_mode() -> None:
    # Don't override an explicit caller setting — let CI / a custom
    # `pytest -s` run that wants to test the closed-default path do so.
    if "MCP_AUTH_REQUIRED" not in os.environ and "MCP_AUTH_DEV_MODE" not in os.environ:
        os.environ["MCP_AUTH_DEV_MODE"] = "true"


_enable_dev_mode()
