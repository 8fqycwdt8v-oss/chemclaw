"""Worker handler-mapping tests — pure unit, no DB / network."""

from services.queue.worker import WorkerSettings, _build_handlers


def test_handlers_cover_expected_kinds():
    s = WorkerSettings()
    h = _build_handlers(s)
    assert "qm_single_point" in h
    assert "qm_geometry_opt" in h
    assert "qm_frequencies" in h
    assert "qm_fukui" in h
    assert "qm_crest_conformers" in h
    assert "genchem_scaffold" in h
    assert "genchem_bioisostere" in h
