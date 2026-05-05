"""workflow_engine unit tests — pure helpers, no DB."""

from services.workflow_engine.main import EngineSettings, WorkflowEngine


def test_resolve_dotted_path():
    eng = WorkflowEngine(EngineSettings())
    scope = {"steps": {"first": {"output": {"energy_hartree": -5.123}}}}
    assert eng._resolve_dotted_path("steps.first.output.energy_hartree", scope) == -5.123


def test_resolve_dotted_path_missing_returns_none():
    eng = WorkflowEngine(EngineSettings())
    assert eng._resolve_dotted_path("steps.missing.x", {"steps": {}}) is None


def test_tool_url_for_known_tools():
    eng = WorkflowEngine(EngineSettings())
    assert eng._tool_url("qm_single_point").endswith("/single_point")
    assert eng._tool_url("qm_geometry_opt").endswith("/geometry_opt")
    assert eng._tool_url("qm_crest_screen").endswith("/conformers")


def test_tool_url_unknown_raises():
    import pytest
    eng = WorkflowEngine(EngineSettings())
    with pytest.raises(ValueError):
        eng._tool_url("fictional_tool_xyz")
