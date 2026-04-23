"""Unit tests for the ChartSpec Pydantic model and parse_chart_spec helper."""

from __future__ import annotations

import json

import pytest

from services.frontend.chart_spec import ChartSpec, Series, parse_chart_spec


# ---------------------------------------------------------------------------
# Valid specs
# ---------------------------------------------------------------------------


def test_valid_bar_spec_parses() -> None:
    raw = json.dumps({"type": "bar", "x": ["a", "b"], "y": [1.0, 2.0]})
    spec = parse_chart_spec(raw)
    assert spec is not None
    assert isinstance(spec, ChartSpec)
    assert spec.type == "bar"
    assert spec.x == ["a", "b"]
    assert spec.y == [1.0, 2.0]
    assert spec.series == []


def test_valid_line_spec_with_series_parses() -> None:
    raw = json.dumps(
        {
            "type": "line",
            "x": ["t1", "t2", "t3"],
            "y": [0.1, 0.2, 0.3],
            "title": "Yield over time",
            "series": [{"name": "control", "values": [0.05, 0.15, 0.25]}],
        }
    )
    spec = parse_chart_spec(raw)
    assert spec is not None
    assert spec.type == "line"
    assert spec.title == "Yield over time"
    assert len(spec.series) == 1
    assert spec.series[0].name == "control"
    assert spec.series[0].values == [0.05, 0.15, 0.25]


def test_valid_scatter_spec_parses() -> None:
    raw = json.dumps({"type": "scatter", "x": ["x1"], "y": [42.0]})
    spec = parse_chart_spec(raw)
    assert spec is not None
    assert spec.type == "scatter"


# ---------------------------------------------------------------------------
# Invalid specs
# ---------------------------------------------------------------------------


def test_malformed_json_returns_none() -> None:
    assert parse_chart_spec("{not valid json}") is None


def test_invalid_type_returns_none() -> None:
    raw = json.dumps({"type": "pie", "x": ["a"], "y": [1.0]})
    assert parse_chart_spec(raw) is None


def test_array_length_cap_rejected() -> None:
    # 1001 elements exceeds the 1000-point cap.
    big = list(range(1001))
    raw = json.dumps({"type": "bar", "x": [str(i) for i in big], "y": [float(i) for i in big]})
    assert parse_chart_spec(raw) is None


def test_mismatched_xy_lengths_rejected() -> None:
    raw = json.dumps({"type": "bar", "x": ["a", "b"], "y": [1.0]})
    assert parse_chart_spec(raw) is None


def test_too_many_series_rejected() -> None:
    series = [{"name": f"s{i}", "values": [1.0]} for i in range(11)]
    raw = json.dumps({"type": "line", "x": ["a"], "y": [1.0], "series": series})
    assert parse_chart_spec(raw) is None


def test_empty_arrays_rejected() -> None:
    raw = json.dumps({"type": "bar", "x": [], "y": []})
    assert parse_chart_spec(raw) is None
