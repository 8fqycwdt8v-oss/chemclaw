"""workflow_engine unit tests — pure helpers, no DB."""

from services.workflow_engine.main import EngineSettings, WorkflowEngine


def test_resolve_jmespath_dotted_path_compat():
    """Pre-PR _resolve_dotted_path semantics still work via JMESPath."""
    eng = WorkflowEngine(EngineSettings())
    scope = {"steps": {"first": {"output": {"energy_hartree": -5.123}}}}
    assert eng._resolve_jmespath("steps.first.output.energy_hartree", scope) == -5.123


def test_resolve_jmespath_missing_returns_none():
    eng = WorkflowEngine(EngineSettings())
    assert eng._resolve_jmespath("steps.missing.x", {"steps": {}}) is None


def test_resolve_jmespath_drops_scope_prefix():
    """Pre-PR walker treated the leading `scope.` prefix as a no-op; JMESPath
    would see it as a literal `scope` key. Adapter strips it."""
    eng = WorkflowEngine(EngineSettings())
    scope = {"steps": {"first": {"output": {"x": 42}}}}
    assert eng._resolve_jmespath("scope.steps.first.output.x", scope) == 42


def test_resolve_jmespath_filter_expression():
    """Real bug fix: the dotted-path walker silently returned None for any
    expression with brackets / filters. JMESPath correctly evaluates them."""
    eng = WorkflowEngine(EngineSettings())
    scope = {
        "outputs": [
            {"id": "a", "status": "fail"},
            {"id": "b", "status": "ok", "value": 1},
            {"id": "c", "status": "ok", "value": 2},
        ],
    }
    assert eng._resolve_jmespath("outputs[?status=='ok'].value", scope) == [1, 2]


def test_resolve_jmespath_pipe_expression():
    eng = WorkflowEngine(EngineSettings())
    scope = {"items": [{"v": 3}, {"v": 1}, {"v": 2}]}
    # JMESPath pipe + length() — completely beyond the dotted-path walker.
    assert eng._resolve_jmespath("items | length(@)", scope) == 3


def test_resolve_jmespath_invalid_expression_returns_none():
    """Malformed JMESPath returns None instead of raising — matches the
    pre-PR behaviour for inputs the dotted walker couldn't handle."""
    eng = WorkflowEngine(EngineSettings())
    assert eng._resolve_jmespath("][bad syntax", {}) is None


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
