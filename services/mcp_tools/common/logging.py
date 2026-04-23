"""Structured logging for MCP tool services."""

from __future__ import annotations

import logging
import sys


def configure_logging(level: str = "INFO") -> None:
    """Configure root logger with an uncolored single-line format.

    Services run behind a container runtime that collects stdout; keep the
    format parseable (no ANSI).
    """
    handler = logging.StreamHandler(sys.stdout)
    handler.setFormatter(
        logging.Formatter(
            fmt="%(asctime)s %(levelname)-7s %(name)s :: %(message)s",
            datefmt="%Y-%m-%dT%H:%M:%S%z",
        )
    )
    root = logging.getLogger()
    # Clear existing handlers (e.g., uvicorn re-adds its own).
    for h in list(root.handlers):
        root.removeHandler(h)
    root.addHandler(handler)
    root.setLevel(level.upper())
    # Quiet the noisy loggers a step.
    for noisy in ("uvicorn.access", "httpx"):
        logging.getLogger(noisy).setLevel(logging.WARNING)
