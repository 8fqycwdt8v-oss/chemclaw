"""Unit tests for the MCP circuit breaker."""

from __future__ import annotations

import time
from unittest.mock import patch

import pytest

from services.mcp_tools.common.circuit_breaker import CircuitBreaker, build_circuit_breaker


class TestCircuitBreakerClosed:
    def test_starts_closed(self) -> None:
        cb = CircuitBreaker(threshold=3, cooldown_secs=10)
        assert not cb.is_open()
        assert cb.state()["status"] == "closed"

    def test_failures_below_threshold_stay_closed(self) -> None:
        cb = CircuitBreaker(threshold=3, cooldown_secs=10)
        cb.record_failure()
        cb.record_failure()
        assert not cb.is_open()
        assert cb.state()["status"] == "closed"
        assert cb.state()["consecutive_failures"] == 2

    def test_success_resets_consecutive_failures(self) -> None:
        cb = CircuitBreaker(threshold=3, cooldown_secs=10)
        cb.record_failure()
        cb.record_failure()
        cb.record_success()
        assert cb.state()["consecutive_failures"] == 0
        assert not cb.is_open()


class TestCircuitBreakerTrips:
    def test_trips_on_threshold(self) -> None:
        cb = CircuitBreaker(threshold=3, cooldown_secs=10)
        cb.record_failure()
        cb.record_failure()
        cb.record_failure()
        assert cb.is_open()
        assert cb.state()["status"] == "open"

    def test_open_state_has_cooldown_remaining(self) -> None:
        cb = CircuitBreaker(threshold=2, cooldown_secs=10)
        cb.record_failure()
        cb.record_failure()
        state = cb.state()
        assert state["cooldown_remaining_secs"] is not None
        assert state["cooldown_remaining_secs"] > 0  # type: ignore[operator]

    def test_further_failures_retrigger_cooldown(self) -> None:
        cb = CircuitBreaker(threshold=1, cooldown_secs=5)
        cb.record_failure()
        assert cb.is_open()
        # One more failure while already open resets the clock
        cb.record_failure()
        state = cb.state()
        assert state["status"] == "open"


class TestCircuitBreakerHalfOpen:
    def test_half_open_after_cooldown(self) -> None:
        cb = CircuitBreaker(threshold=1, cooldown_secs=0.05)
        cb.record_failure()
        assert cb.is_open()
        time.sleep(0.06)
        assert not cb.is_open()
        assert cb.state()["status"] == "half_open"

    def test_success_in_half_open_closes_breaker(self) -> None:
        cb = CircuitBreaker(threshold=1, cooldown_secs=0.05)
        cb.record_failure()
        time.sleep(0.06)
        cb.record_success()
        assert not cb.is_open()
        assert cb.state()["status"] == "closed"

    def test_failure_in_half_open_reopens_breaker(self) -> None:
        cb = CircuitBreaker(threshold=1, cooldown_secs=0.05)
        cb.record_failure()
        time.sleep(0.06)
        # Another failure re-trips
        cb.record_failure()
        assert cb.is_open()
        assert cb.state()["status"] == "open"


class TestBuildCircuitBreaker:
    def test_defaults_from_env_absent(self) -> None:
        with patch.dict("os.environ", {}, clear=False):
            import os
            os.environ.pop("MCP_CB_THRESHOLD", None)
            os.environ.pop("MCP_CB_COOLDOWN_SECS", None)
            cb = build_circuit_breaker()
        assert cb._threshold == 5
        assert cb._cooldown_secs == 30.0

    def test_reads_env_vars(self) -> None:
        with patch.dict("os.environ", {"MCP_CB_THRESHOLD": "2", "MCP_CB_COOLDOWN_SECS": "60"}):
            cb = build_circuit_breaker()
        assert cb._threshold == 2
        assert cb._cooldown_secs == 60.0
