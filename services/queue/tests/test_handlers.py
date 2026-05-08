"""Worker handler-mapping tests — pure unit, no DB / network."""

import asyncio

from services.queue.worker import WorkerSettings, _build_handlers


def test_handlers_cover_expected_kinds():
    s = WorkerSettings()
    h, _aclose = _build_handlers(s)
    assert "qm_single_point" in h
    assert "qm_geometry_opt" in h
    assert "qm_frequencies" in h
    assert "qm_fukui" in h
    assert "qm_crest_conformers" in h
    assert "genchem_scaffold" in h
    assert "genchem_bioisostere" in h


def test_build_handlers_returns_aclose_callback():
    """Drain hook contract: the second tuple element is an awaitable
    closer that releases the shared httpx client's connection pool."""
    s = WorkerSettings()
    h, aclose = _build_handlers(s)
    # awaitable; calling it must not raise even without prior use.
    asyncio.run(aclose())
