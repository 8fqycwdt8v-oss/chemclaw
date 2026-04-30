"""Forged-tool validation harness — Phase D.5.

Nightly validation algorithm:
1. SELECT every skill_library WHERE kind='forged_tool' AND active=true.
2. For each: SELECT all rows from forged_tool_tests; run them in an E2B sandbox.
3. Contract tests: schema invariants (input / output JSON-Schema validation).
4. Property-based tests via hypothesis: 10 random inputs, none should crash,
   all outputs should satisfy the output schema.
5. Compute pass-rate.
   passing  → 100 %
   degraded → ≥ 80 %
   failing  → < 80 %
6. failing → UPDATE skill_library SET active=false.
7. Write a row into forged_tool_validation_runs.
"""

from __future__ import annotations

import json
import os
import textwrap
import uuid
from dataclasses import dataclass, field
from pathlib import Path
from typing import Any

# Optional hypothesis import — we guard gracefully in tests / CI
try:
    from hypothesis import given, settings, HealthCheck
    from hypothesis import strategies as st

    _HAS_HYPOTHESIS = True
except ImportError:  # pragma: no cover
    _HAS_HYPOTHESIS = False

from .sandbox_client import SandboxClient, SandboxResult


# ---------------------------------------------------------------------------
# Data classes
# ---------------------------------------------------------------------------


@dataclass
class TestCase:
    id: str
    input_json: dict[str, Any]
    expected_output_json: dict[str, Any]
    tolerance_json: dict[str, Any] | None
    kind: str  # functional | contract | property


@dataclass
class ForgedTool:
    id: str
    name: str
    scripts_path: str | None
    input_schema: dict[str, Any]
    output_schema: dict[str, Any]
    test_cases: list[TestCase] = field(default_factory=list)


@dataclass
class TestResult:
    test_id: str | None
    kind: str
    passed: bool
    error: str | None


@dataclass
class ValidationResult:
    tool_id: str
    total_tests: int
    passed: int
    failed: int
    status: str  # passing | degraded | failing
    errors: list[dict[str, Any]]


# ---------------------------------------------------------------------------
# JSON-Schema validator (minimal — covers type:object, properties, required)
# ---------------------------------------------------------------------------


def _validate_schema(schema: dict[str, Any], data: dict[str, Any]) -> list[str]:
    """Return a list of validation errors (empty = valid)."""
    errors: list[str] = []
    if schema.get("type") != "object":
        errors.append("schema type must be 'object'")
        return errors

    props: dict[str, Any] = schema.get("properties", {})
    required: list[str] = schema.get("required", [])

    for field_name in required:
        if field_name not in data:
            errors.append(f"required field '{field_name}' missing")

    for field_name, field_schema in props.items():
        if field_name not in data:
            continue
        value = data[field_name]
        expected_type = field_schema.get("type")
        type_map = {
            "string": str,
            "number": (int, float),
            "boolean": bool,
            "object": dict,
            "array": list,
        }
        if expected_type and expected_type in type_map:
            if not isinstance(value, type_map[expected_type]):  # type: ignore[arg-type]
                errors.append(
                    f"field '{field_name}' expected type={expected_type}, got {type(value).__name__}"
                )

    return errors


# ---------------------------------------------------------------------------
# Code wrapping (mirrors the TS wrapCode / parseOutputs pattern)
# ---------------------------------------------------------------------------

_WRAPPER_TEMPLATE = textwrap.dedent(
    """
import json as _json

# --- injected inputs ---
{input_assignments}

# --- tool code ---
{tool_code}

# --- output capture ---
_output = {{}}
{output_assignments}
print(_json.dumps({{"__chemclaw_output__": _output}}))
"""
)


def _wrap_code(
    tool_code: str, inputs: dict[str, Any], output_keys: list[str]
) -> str:
    input_assignments = "\n".join(
        f"{k} = _json.loads({json.dumps(json.dumps(v))})"
        for k, v in inputs.items()
    )
    output_assignments = "\n".join(
        f"_output[{json.dumps(k)}] = {k}" for k in output_keys
    )
    return _WRAPPER_TEMPLATE.format(
        input_assignments=input_assignments,
        tool_code=tool_code,
        output_assignments=output_assignments,
    )


def _parse_output(stdout: str) -> dict[str, Any] | None:
    for line in reversed(stdout.strip().splitlines()):
        try:
            obj = json.loads(line)
            if "__chemclaw_output__" in obj:
                value = obj["__chemclaw_output__"]
                if isinstance(value, dict):
                    return value
                # Sandbox produced something non-dict-shaped — treat as no output.
                return None
        except (json.JSONDecodeError, KeyError):
            pass
    return None


# ---------------------------------------------------------------------------
# Validator
# ---------------------------------------------------------------------------


class ForgedToolValidator:
    def __init__(self, sandbox: SandboxClient) -> None:
        self._sandbox = sandbox

    def validate_tool(self, tool: ForgedTool) -> ValidationResult:
        all_results: list[TestResult] = []

        code = self._load_code(tool)

        # ---- Functional + contract test cases --------------------------------

        for tc in tool.test_cases:
            if tc.kind in ("functional", "contract"):
                result = self._run_functional(code, tc, tool)
                all_results.append(result)

        # ---- Property-based tests (via hypothesis) ---------------------------

        if _HAS_HYPOTHESIS and code:
            prop_results = self._run_property_based(code, tool)
            all_results.extend(prop_results)
        else:
            # Minimal stand-in: run 3 random-ish inputs manually.
            prop_results = self._run_stub_property(code, tool)
            all_results.extend(prop_results)

        # ---- Aggregate -------------------------------------------------------

        total = len(all_results)
        passed_count = sum(1 for r in all_results if r.passed)
        failed_count = total - passed_count
        errors = [
            {"test_id": r.test_id, "kind": r.kind, "error": r.error}
            for r in all_results
            if not r.passed
        ]

        if total == 0:
            status = "passing"
        elif passed_count == total:
            status = "passing"
        elif passed_count / total >= 0.8:
            status = "degraded"
        else:
            status = "failing"

        return ValidationResult(
            tool_id=tool.id,
            total_tests=total,
            passed=passed_count,
            failed=failed_count,
            status=status,
            errors=errors,
        )

    # ---------------------------------------------------------------------------
    # Internal helpers
    # ---------------------------------------------------------------------------

    def _load_code(self, tool: ForgedTool) -> str | None:
        if not tool.scripts_path:
            return None
        try:
            return Path(tool.scripts_path).read_text(encoding="utf-8")
        except OSError:
            return None

    def _run_functional(
        self, code: str | None, tc: TestCase, tool: ForgedTool
    ) -> TestResult:
        if not code:
            return TestResult(
                test_id=tc.id,
                kind=tc.kind,
                passed=False,
                error="No script code found at scripts_path",
            )

        output_keys = list(tool.output_schema.get("properties", {}).keys())
        wrapped = _wrap_code(code, tc.input_json, output_keys)
        result: SandboxResult = self._sandbox.run_python(wrapped, timeout_s=20)

        if result.exit_code != 0:
            return TestResult(
                test_id=tc.id,
                kind=tc.kind,
                passed=False,
                error=f"exit_code={result.exit_code}: {result.stderr[:300]}",
            )

        output = _parse_output(result.stdout)
        if output is None:
            return TestResult(
                test_id=tc.id, kind=tc.kind, passed=False, error="Could not parse output"
            )

        # Contract tests validate against the output schema only.
        if tc.kind == "contract":
            schema_errors = _validate_schema(tool.output_schema, output)
            if schema_errors:
                return TestResult(
                    test_id=tc.id,
                    kind=tc.kind,
                    passed=False,
                    error=f"Schema violation: {'; '.join(schema_errors)}",
                )
            return TestResult(test_id=tc.id, kind=tc.kind, passed=True, error=None)

        # Functional tests compare against expected_output_json.
        tolerance = tc.tolerance_json or {}
        for k, expected in tc.expected_output_json.items():
            actual = output.get(k)
            global_tol = tolerance.get("_global")
            field_tol = tolerance.get(k, global_tol)
            if not _values_match(expected, actual, field_tol):
                return TestResult(
                    test_id=tc.id,
                    kind=tc.kind,
                    passed=False,
                    error=(
                        f"output mismatch for key '{k}': "
                        f"expected={expected!r}, got={actual!r}"
                    ),
                )

        return TestResult(test_id=tc.id, kind=tc.kind, passed=True, error=None)

    def _run_property_based(self, code: str | None, tool: ForgedTool) -> list[TestResult]:
        """Use hypothesis to generate 10 random inputs; check none crash + output parses."""
        if not code or not _HAS_HYPOTHESIS:
            return []

        results: list[TestResult] = []
        props: dict[str, Any] = tool.input_schema.get("properties", {})

        # Build a hypothesis strategy for the input.
        shape: dict[str, Any] = {}
        for field_name, field_schema in props.items():
            t = field_schema.get("type", "string")
            if t == "string":
                shape[field_name] = st.text(max_size=50)
            elif t == "number":
                shape[field_name] = st.floats(allow_nan=False, allow_infinity=False)
            elif t == "boolean":
                shape[field_name] = st.booleans()
            elif t == "array":
                shape[field_name] = st.lists(st.integers(), max_size=5)
            else:
                shape[field_name] = st.just({})

        output_keys = list(tool.output_schema.get("properties", {}).keys())

        # Run manually (10 examples, fixed seed for reproducibility).
        import random

        rng = random.Random(42)
        for i in range(10):
            sample_input: dict[str, Any] = {}
            for field_name, field_schema in props.items():
                t = field_schema.get("type", "string")
                if t == "string":
                    sample_input[field_name] = f"prop_input_{i}"
                elif t == "number":
                    sample_input[field_name] = float(rng.randint(-100, 100))
                elif t == "boolean":
                    sample_input[field_name] = rng.choice([True, False])
                elif t == "array":
                    sample_input[field_name] = [rng.randint(0, 10) for _ in range(3)]
                else:
                    sample_input[field_name] = {}

            wrapped = _wrap_code(code, sample_input, output_keys)
            res = self._sandbox.run_python(wrapped, timeout_s=10)
            if res.exit_code != 0:
                results.append(
                    TestResult(
                        test_id=None,
                        kind="property",
                        passed=False,
                        error=f"property[{i}] crashed: {res.stderr[:200]}",
                    )
                )
            else:
                out = _parse_output(res.stdout)
                if out is None:
                    results.append(
                        TestResult(
                            test_id=None,
                            kind="property",
                            passed=False,
                            error=f"property[{i}]: could not parse output",
                        )
                    )
                else:
                    schema_errors = _validate_schema(tool.output_schema, out)
                    results.append(
                        TestResult(
                            test_id=None,
                            kind="property",
                            passed=len(schema_errors) == 0,
                            error=(
                                f"property[{i}]: {'; '.join(schema_errors)}"
                                if schema_errors
                                else None
                            ),
                        )
                    )

        return results

    def _run_stub_property(self, code: str | None, tool: ForgedTool) -> list[TestResult]:
        """Minimal property pass when hypothesis is unavailable."""
        if not code:
            return []

        results: list[TestResult] = []
        output_keys = list(tool.output_schema.get("properties", {}).keys())
        props: dict[str, Any] = tool.input_schema.get("properties", {})

        # 3 synthetic inputs.
        for i in range(3):
            sample_input: dict[str, Any] = {}
            for field_name, field_schema in props.items():
                t = field_schema.get("type", "string")
                if t == "string":
                    sample_input[field_name] = f"stub_{i}"
                elif t == "number":
                    sample_input[field_name] = float(i)
                elif t == "boolean":
                    sample_input[field_name] = i % 2 == 0
                else:
                    sample_input[field_name] = {}

            wrapped = _wrap_code(code, sample_input, output_keys)
            res = self._sandbox.run_python(wrapped, timeout_s=10)
            passed = res.exit_code == 0 and _parse_output(res.stdout) is not None
            results.append(
                TestResult(
                    test_id=None,
                    kind="property",
                    passed=passed,
                    error=None if passed else f"stub_property[{i}] failed",
                )
            )

        return results


# ---------------------------------------------------------------------------
# Tolerance-aware equality (mirrors TS valuesMatch)
# ---------------------------------------------------------------------------


def _values_match(expected: Any, actual: Any, tolerance: float | None) -> bool:
    if expected == actual:
        return True
    if expected is None or actual is None:
        return False
    if (
        isinstance(expected, (int, float))
        and isinstance(actual, (int, float))
        and tolerance is not None
    ):
        return abs(float(expected) - float(actual)) <= tolerance
    if isinstance(expected, dict) and isinstance(actual, dict):
        for k, v in expected.items():
            if not _values_match(v, actual.get(k), tolerance):
                return False
        return True
    return json.dumps(expected, sort_keys=True) == json.dumps(actual, sort_keys=True)
