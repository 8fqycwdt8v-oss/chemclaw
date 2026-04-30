"""Unit tests for services.mcp_tools.common.log_context."""

from __future__ import annotations

import asyncio
import logging
from io import StringIO

import pytest

from services.mcp_tools.common.log_context import (
    LogContextFilter,
    bind_log_context,
    get_log_context,
    log_context_scope,
    reset_log_context,
)


def test_empty_outside_any_binding() -> None:
    assert get_log_context() == {}


def test_bind_and_reset_round_trip() -> None:
    token = bind_log_context(request_id="req-1", user="abc")
    try:
        ctx = get_log_context()
        assert ctx["request_id"] == "req-1"
        assert ctx["user"] == "abc"
    finally:
        reset_log_context(token)
    assert get_log_context() == {}


def test_scope_unbinds_on_exit() -> None:
    with log_context_scope(request_id="req-1"):
        assert get_log_context()["request_id"] == "req-1"
    assert "request_id" not in get_log_context()


def test_scope_unbinds_on_exception() -> None:
    with pytest.raises(RuntimeError):
        with log_context_scope(request_id="req-fail"):
            assert get_log_context()["request_id"] == "req-fail"
            raise RuntimeError("boom")
    assert "request_id" not in get_log_context()


def test_get_returns_a_copy_so_callers_cant_mutate() -> None:
    with log_context_scope(request_id="req-x"):
        snapshot = get_log_context()
        snapshot["request_id"] = "tampered"
        assert get_log_context()["request_id"] == "req-x"


def test_empty_field_values_are_dropped() -> None:
    """`bind_log_context` skips empty strings — log records shouldn't see
    request_id="" stamped on them when nothing was bound."""
    with log_context_scope(request_id="", user="abc"):
        ctx = get_log_context()
        assert "request_id" not in ctx
        assert ctx["user"] == "abc"


def test_filter_copies_context_onto_log_record() -> None:
    logger = logging.getLogger("test_log_context.filter")
    logger.handlers.clear()
    buf = StringIO()
    handler = logging.StreamHandler(buf)
    handler.setFormatter(logging.Formatter("%(request_id)s|%(user)s|%(message)s"))
    handler.addFilter(LogContextFilter())
    logger.addHandler(handler)
    logger.setLevel(logging.INFO)
    logger.propagate = False

    with log_context_scope(request_id="req-Z", user="u-Z"):
        logger.info("hello")

    line = buf.getvalue().strip()
    assert line == "req-Z|u-Z|hello"


def test_filter_does_not_overwrite_explicit_extras() -> None:
    """If a caller passes `extra={"user": "explicit"}`, that wins."""
    logger = logging.getLogger("test_log_context.filter_extras")
    logger.handlers.clear()
    buf = StringIO()
    handler = logging.StreamHandler(buf)
    handler.setFormatter(logging.Formatter("%(user)s"))
    handler.addFilter(LogContextFilter())
    logger.addHandler(handler)
    logger.setLevel(logging.INFO)
    logger.propagate = False

    with log_context_scope(user="from-context"):
        logger.info("x", extra={"user": "explicit"})

    assert buf.getvalue().strip() == "explicit"


def test_async_propagation_across_awaits() -> None:
    async def inner() -> str:
        await asyncio.sleep(0)
        return get_log_context().get("request_id", "")

    async def main() -> str:
        with log_context_scope(request_id="async-req"):
            return await inner()

    result = asyncio.run(main())
    assert result == "async-req"
