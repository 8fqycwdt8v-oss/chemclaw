"""Thread-safe circuit breaker for MCP tool service route handlers.

Trips after MCP_CB_THRESHOLD consecutive 5xx responses and rejects subsequent
requests with 503 until MCP_CB_COOLDOWN_SECS have elapsed (half-open probe).
A single successful probe resets the breaker to CLOSED.

State machine:
  CLOSED   → normal operation; consecutive_failures tracked.
  OPEN     → every request rejected with 503 until cooldown elapses.
  HALF_OPEN → cooldown elapsed; next request is a probe.
               Probe success  → CLOSED (reset failures).
               Probe failure  → OPEN   (reset cooldown clock).
"""

from __future__ import annotations

import os
import threading
import time


class CircuitBreaker:
    def __init__(self, threshold: int = 5, cooldown_secs: float = 30.0) -> None:
        self._threshold = threshold
        self._cooldown_secs = cooldown_secs
        self._consecutive_failures = 0
        self._tripped_at: float | None = None
        self._lock = threading.Lock()

    def is_open(self) -> bool:
        """Return True when the circuit is OPEN and calls should be rejected."""
        with self._lock:
            if self._tripped_at is None:
                return False
            return (time.monotonic() - self._tripped_at) < self._cooldown_secs

    def record_success(self) -> None:
        with self._lock:
            self._consecutive_failures = 0
            self._tripped_at = None

    def record_failure(self) -> None:
        with self._lock:
            self._consecutive_failures += 1
            if self._consecutive_failures >= self._threshold:
                self._tripped_at = time.monotonic()

    def state(self) -> dict[str, object]:
        with self._lock:
            if self._tripped_at is None:
                return {
                    "status": "closed",
                    "consecutive_failures": self._consecutive_failures,
                    "cooldown_remaining_secs": None,
                }
            elapsed = time.monotonic() - self._tripped_at
            if elapsed >= self._cooldown_secs:
                return {
                    "status": "half_open",
                    "consecutive_failures": self._consecutive_failures,
                    "cooldown_remaining_secs": 0.0,
                }
            return {
                "status": "open",
                "consecutive_failures": self._consecutive_failures,
                "cooldown_remaining_secs": round(self._cooldown_secs - elapsed, 1),
            }


def build_circuit_breaker() -> CircuitBreaker:
    """Build a CircuitBreaker from MCP_CB_THRESHOLD / MCP_CB_COOLDOWN_SECS env vars."""
    threshold = int(os.getenv("MCP_CB_THRESHOLD", "5"))
    cooldown = float(os.getenv("MCP_CB_COOLDOWN_SECS", "30"))
    return CircuitBreaker(threshold=threshold, cooldown_secs=cooldown)
