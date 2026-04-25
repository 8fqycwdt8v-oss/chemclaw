"""Tests for services/optimizer/forged_tool_validator — Phase D.5.

All Postgres and E2B interactions are stubbed.
"""

from __future__ import annotations

import json

import pytest

from services.optimizer.forged_tool_validator.sandbox_client import (
    SandboxResult,
    StubSandboxClient,
)
from services.optimizer.forged_tool_validator.validator import (
    ForgedTool,
    ForgedToolValidator,
    TestCase,
    _parse_output,
    _validate_schema,
    _values_match,
    _wrap_code,
)


# ---------------------------------------------------------------------------
# Fixtures
# ---------------------------------------------------------------------------


def make_tool(
    tool_id: str = "tool-1",
    name: str = "my_tool",
    scripts_path: str | None = None,
    input_schema: dict | None = None,
    output_schema: dict | None = None,
    test_cases: list | None = None,
) -> ForgedTool:
    return ForgedTool(
        id=tool_id,
        name=name,
        scripts_path=scripts_path,
        input_schema=input_schema or {"type": "object", "properties": {"x": {"type": "number"}}},
        output_schema=output_schema
        or {"type": "object", "properties": {"result": {"type": "number"}}, "required": ["result"]},
        test_cases=test_cases or [],
    )


def make_tc(
    tc_id: str = "tc-1",
    input_json: dict | None = None,
    expected_output_json: dict | None = None,
    kind: str = "functional",
) -> TestCase:
    return TestCase(
        id=tc_id,
        input_json=input_json or {"x": 1},
        expected_output_json=expected_output_json or {"result": 2},
        tolerance_json=None,
        kind=kind,
    )


# ---------------------------------------------------------------------------
# _values_match
# ---------------------------------------------------------------------------


def test_values_match_identical():
    assert _values_match(42, 42, None) is True


def test_values_match_different():
    assert _values_match(1, 2, None) is False


def test_values_match_tolerance():
    assert _values_match(1.0, 1.05, 0.1) is True
    assert _values_match(1.0, 1.2, 0.1) is False


def test_values_match_nested_dict():
    assert _values_match({"a": 1, "b": 2}, {"a": 1, "b": 2}, None) is True
    assert _values_match({"a": 1}, {"a": 2}, None) is False


# ---------------------------------------------------------------------------
# _validate_schema
# ---------------------------------------------------------------------------


def test_validate_schema_valid():
    schema = {"type": "object", "properties": {"x": {"type": "number"}}, "required": ["x"]}
    errors = _validate_schema(schema, {"x": 1.0})
    assert errors == []


def test_validate_schema_missing_required():
    schema = {"type": "object", "properties": {"x": {"type": "number"}}, "required": ["x"]}
    errors = _validate_schema(schema, {})
    assert any("required" in e and "x" in e for e in errors)


def test_validate_schema_wrong_type():
    schema = {"type": "object", "properties": {"x": {"type": "number"}}}
    errors = _validate_schema(schema, {"x": "not_a_number"})
    assert any("x" in e for e in errors)


# ---------------------------------------------------------------------------
# _wrap_code / _parse_output
# ---------------------------------------------------------------------------


def test_wrap_and_parse_round_trip():
    code = "result = x + 1"
    wrapped = _wrap_code(code, {"x": 5}, ["result"])
    # Execute the wrapped code and verify the output.
    ns: dict = {}
    exec(wrapped, ns)  # noqa: S102
    assert ns["_output"]["result"] == 6


def test_parse_output_extracts_chemclaw_output():
    stdout = 'some preamble\n{"__chemclaw_output__": {"result": 99}}\n'
    result = _parse_output(stdout)
    assert result == {"result": 99}


def test_parse_output_returns_none_on_bad_stdout():
    result = _parse_output("no json here")
    assert result is None


# ---------------------------------------------------------------------------
# ForgedToolValidator — functional tests
# ---------------------------------------------------------------------------


def test_validate_passing_functional_test(tmp_path):
    script = tmp_path / "my_tool.py"
    script.write_text("result = x + 1")

    tool = make_tool(scripts_path=str(script))
    tc = make_tc(input_json={"x": 5}, expected_output_json={"result": 6}, kind="functional")
    tool.test_cases = [tc]

    sandbox = StubSandboxClient()
    # Provide enough results for functional + property passes.
    for _ in range(10):
        sandbox.enqueue(
            SandboxResult(stdout='{"__chemclaw_output__": {"result": 6}}', stderr="", exit_code=0)
        )

    validator = ForgedToolValidator(sandbox)
    result = validator.validate_tool(tool)

    assert result.passed >= 1
    assert result.status == "passing"


def test_validate_failing_functional_test(tmp_path):
    script = tmp_path / "my_tool.py"
    script.write_text("result = 999")

    tool = make_tool(scripts_path=str(script))
    tc = make_tc(input_json={"x": 5}, expected_output_json={"result": 6}, kind="functional")
    tool.test_cases = [tc]

    # Sandbox returns wrong value.
    sandbox = StubSandboxClient()
    for _ in range(10):
        sandbox.enqueue(
            SandboxResult(stdout='{"__chemclaw_output__": {"result": 999}}', stderr="", exit_code=0)
        )

    validator = ForgedToolValidator(sandbox)
    result = validator.validate_tool(tool)

    assert result.failed >= 1


def test_validate_exit_nonzero_marks_failed(tmp_path):
    script = tmp_path / "bad.py"
    script.write_text("raise ValueError('oops')")
    tool = make_tool(scripts_path=str(script))
    tc = make_tc()
    tool.test_cases = [tc]

    sandbox = StubSandboxClient()
    for _ in range(10):
        sandbox.enqueue(SandboxResult(stdout="", stderr="ValueError: oops", exit_code=1))

    validator = ForgedToolValidator(sandbox)
    result = validator.validate_tool(tool)

    assert result.failed >= 1


def test_validate_contract_checks_schema(tmp_path):
    script = tmp_path / "my_tool.py"
    script.write_text("result = 42")
    tool = make_tool(scripts_path=str(script))
    tc = make_tc(kind="contract")
    tool.test_cases = [tc]

    sandbox = StubSandboxClient()
    for _ in range(10):
        sandbox.enqueue(
            SandboxResult(stdout='{"__chemclaw_output__": {"result": 42}}', stderr="", exit_code=0)
        )

    validator = ForgedToolValidator(sandbox)
    result = validator.validate_tool(tool)

    assert result.passed >= 1


def test_validate_no_scripts_path():
    """Tool with no scripts_path should fail gracefully."""
    tool = make_tool(scripts_path=None)
    tc = make_tc()
    tool.test_cases = [tc]

    sandbox = StubSandboxClient()
    validator = ForgedToolValidator(sandbox)
    result = validator.validate_tool(tool)

    assert result.failed >= 1


def test_validate_empty_test_cases(tmp_path):
    """Tool with no test cases still runs property-based tests."""
    script = tmp_path / "my_tool.py"
    script.write_text("result = 1")
    tool = make_tool(scripts_path=str(script))
    tool.test_cases = []

    sandbox = StubSandboxClient()
    for _ in range(5):
        sandbox.enqueue(
            SandboxResult(stdout='{"__chemclaw_output__": {"result": 1}}', stderr="", exit_code=0)
        )

    validator = ForgedToolValidator(sandbox)
    result = validator.validate_tool(tool)

    assert result.status in ("passing", "degraded", "failing")


def test_validate_failing_status_when_all_fail(tmp_path):
    """All tests fail → status='failing'."""
    script = tmp_path / "bad.py"
    script.write_text("result = 'wrong'")
    tool = make_tool(scripts_path=str(script))
    tool.test_cases = [make_tc(expected_output_json={"result": 999}) for _ in range(5)]

    sandbox = StubSandboxClient()
    for _ in range(30):
        sandbox.enqueue(
            SandboxResult(stdout='{"__chemclaw_output__": {"result": "wrong"}}', stderr="", exit_code=0)
        )

    validator = ForgedToolValidator(sandbox)
    result = validator.validate_tool(tool)

    assert result.status == "failing"


def test_validate_passing_status_all_pass(tmp_path):
    """All tests pass → status='passing'."""
    script = tmp_path / "good.py"
    script.write_text("result = 99")
    tool = make_tool(scripts_path=str(script))
    tool.test_cases = [make_tc(expected_output_json={"result": 99}) for _ in range(3)]

    sandbox = StubSandboxClient()
    for _ in range(30):
        sandbox.enqueue(
            SandboxResult(stdout='{"__chemclaw_output__": {"result": 99}}', stderr="", exit_code=0)
        )

    validator = ForgedToolValidator(sandbox)
    result = validator.validate_tool(tool)

    assert result.status == "passing"
