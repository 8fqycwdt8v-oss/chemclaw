"""Tests for Pareto-front extraction (Z6 — pure function + endpoint)."""
from __future__ import annotations

import pytest
from fastapi.testclient import TestClient

from services.mcp_tools.mcp_reaction_optimizer.optimizer import pareto_front


@pytest.fixture()
def client():
    from services.mcp_tools.mcp_reaction_optimizer.main import app
    with TestClient(app) as c:
        yield c


def test_pareto_empty_input():
    assert pareto_front([], {"yield": "maximize"}) == []
    assert pareto_front([{"factor_values": {}, "outputs": {"yield": 50}}], {}) == []


def test_pareto_single_point():
    items = [{"factor_values": {"t": 80}, "outputs": {"yield": 60}}]
    result = pareto_front(items, {"yield": "maximize"})
    assert result == items


def test_pareto_dominates_simple():
    """Two outcomes, one strictly better — only the better one survives."""
    items = [
        {"factor_values": {"t": 80}, "outputs": {"yield": 60}},
        {"factor_values": {"t": 100}, "outputs": {"yield": 80}},
    ]
    result = pareto_front(items, {"yield": "maximize"})
    assert len(result) == 1
    assert result[0]["outputs"]["yield"] == 80


def test_pareto_two_objectives_tradeoff():
    """yield max + PMI min — neither point dominates the other."""
    items = [
        {"factor_values": {"t": 80}, "outputs": {"yield": 70, "pmi": 30}},
        {"factor_values": {"t": 100}, "outputs": {"yield": 85, "pmi": 80}},
        {"factor_values": {"t": 60}, "outputs": {"yield": 50, "pmi": 100}},
    ]
    result = pareto_front(items, {"yield": "maximize", "pmi": "minimize"})
    yields = sorted(p["outputs"]["yield"] for p in result)
    assert yields == [70, 85]  # 50/100 dominated by 70/30


def test_pareto_minimize_only():
    items = [
        {"factor_values": {}, "outputs": {"pmi": 30}},
        {"factor_values": {}, "outputs": {"pmi": 50}},
        {"factor_values": {}, "outputs": {"pmi": 20}},
    ]
    result = pareto_front(items, {"pmi": "minimize"})
    assert len(result) == 1
    assert result[0]["outputs"]["pmi"] == 20


def test_pareto_skips_missing_outputs():
    """Items without the required outputs are excluded."""
    items = [
        {"factor_values": {}, "outputs": {"yield": 80}},
        {"factor_values": {}, "outputs": {"other": 5}},  # missing yield
    ]
    result = pareto_front(items, {"yield": "maximize"})
    assert len(result) == 1


def test_endpoint_pareto_extraction(client):
    r = client.post(
        "/extract_pareto",
        json={
            "measured_outcomes": [
                {"factor_values": {"t": 80}, "outputs": {"yield": 70, "pmi": 30}},
                {"factor_values": {"t": 100}, "outputs": {"yield": 85, "pmi": 80}},
                {"factor_values": {"t": 60}, "outputs": {"yield": 50, "pmi": 100}},
            ],
            "output_directions": {"yield": "maximize", "pmi": "minimize"},
        },
    )
    assert r.status_code == 200, r.text
    body = r.json()
    assert body["n_total"] == 3
    assert body["n_pareto"] == 2


def test_endpoint_invalid_direction(client):
    r = client.post(
        "/extract_pareto",
        json={
            "measured_outcomes": [
                {"factor_values": {}, "outputs": {"yield": 50}},
            ],
            "output_directions": {"yield": "wrong_value"},
        },
    )
    assert r.status_code == 422
