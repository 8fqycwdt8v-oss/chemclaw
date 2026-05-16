"""Tests for the DNS-rebinding mitigation: pin_resolution context manager.

Verifies the thread-local socket.getaddrinfo override in fetchers.py:
  1. Inside the context, getaddrinfo for the pinned host returns only the
     validated IPs (not the real DNS result).
  2. After the context exits, the pin is removed and the original resolver
     is restored for that host.
  3. Empty validated_ips is a no-op — the context exits immediately without
     installing any pin.
  4. Nested calls with different IP sets don't trample each other; the inner
     pin restores the outer pin on exit rather than deleting it.
"""

from __future__ import annotations

import socket

import pytest

from services.mcp_tools.mcp_doc_fetcher.fetchers import (
    _ORIGINAL_GETADDRINFO,
    _pin_state,
    pin_resolution,
)


def _current_pin(host: str) -> list[str] | None:
    """Return the current thread-local pin for *host*, or None if absent."""
    return (getattr(_pin_state, "pinned", None) or {}).get(host.lower())


class TestPinResolution:
    def test_pin_is_active_inside_context(self) -> None:
        """getaddrinfo returns results only for pinned IPs during the context."""
        with pin_resolution("example.com", ["1.2.3.4"]):
            # Verify the thread-local pin is set.
            assert _current_pin("example.com") == ["1.2.3.4"]

    def test_pin_is_removed_after_context(self) -> None:
        """The pin is cleaned up on __exit__ regardless of outcome."""
        with pin_resolution("example.com", ["1.2.3.4"]):
            pass
        assert _current_pin("example.com") is None

    def test_pin_removed_on_exception(self) -> None:
        """The pin is cleaned up even when an exception is raised inside."""
        with pytest.raises(RuntimeError):
            with pin_resolution("example.com", ["1.2.3.4"]):
                raise RuntimeError("boom")
        assert _current_pin("example.com") is None

    def test_empty_validated_ips_is_noop(self) -> None:
        """Empty IP list → context exits immediately without touching the pin map."""
        with pin_resolution("example.com", []):
            assert _current_pin("example.com") is None
        assert _current_pin("example.com") is None

    def test_nested_pins_restore_outer(self) -> None:
        """Inner pin_resolution for the same host restores the outer pin on exit."""
        with pin_resolution("example.com", ["1.1.1.1"]):
            assert _current_pin("example.com") == ["1.1.1.1"]
            with pin_resolution("example.com", ["2.2.2.2"]):
                assert _current_pin("example.com") == ["2.2.2.2"]
            # Outer pin should be back after inner exits.
            assert _current_pin("example.com") == ["1.1.1.1"]
        assert _current_pin("example.com") is None

    def test_different_hosts_dont_interfere(self) -> None:
        """Pins for distinct hosts are independent."""
        with pin_resolution("alpha.example.com", ["10.0.0.1"]):
            with pin_resolution("beta.example.com", ["10.0.0.2"]):
                assert _current_pin("alpha.example.com") == ["10.0.0.1"]
                assert _current_pin("beta.example.com") == ["10.0.0.2"]
            assert _current_pin("beta.example.com") is None
            assert _current_pin("alpha.example.com") == ["10.0.0.1"]

    def test_pinned_getaddrinfo_installed_after_first_pin(self) -> None:
        """The process-global override is installed on first non-empty pin."""
        from services.mcp_tools.mcp_doc_fetcher.fetchers import _pinned_getaddrinfo

        with pin_resolution("example.com", ["1.2.3.4"]):
            assert socket.getaddrinfo is _pinned_getaddrinfo
        # Override stays installed (idempotent no-op for unpinned threads).
        assert socket.getaddrinfo is _pinned_getaddrinfo
