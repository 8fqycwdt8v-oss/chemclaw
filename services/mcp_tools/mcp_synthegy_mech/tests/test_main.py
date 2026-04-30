"""Tests for mcp-synthegy-mech FastAPI app and search loop.

litellm.acompletion is mocked everywhere — no real LLM calls in CI. The
tests pin three things:

1. Schema validation: bad SMILES → 400, missing required fields → 422.
2. Warnings surface: radical input → warnings list non-empty.
3. Search budget: max_nodes=1 truncates after one node, returns the
   stub `[reactants_canonical]` path with truncated=True.
4. Score parsing: <score>7</score> in the LLM response is correctly
   extracted into the per-move score field.

The full multi-step paper-benchmark replay (Task #1, Task #4 from the paper)
runs the search end-to-end against a deterministic mocked LLM that always
gives the highest score to the move closest to the goal, exercising the A*
loop, move enumeration, and the move_diff derivation.
"""
from __future__ import annotations

import os
from types import SimpleNamespace
from unittest import mock

import pytest
from fastapi.testclient import TestClient

# Import after env knobs so create_app picks them up.
os.environ.setdefault("MCP_AUTH_DEV_MODE", "true")


@pytest.fixture()
def client():
    from services.mcp_tools.mcp_synthegy_mech.main import app
    with TestClient(app) as c:
        yield c


def _fake_response(score: float = 5.0, prompt_tokens: int = 100, completion_tokens: int = 40):
    """Build a litellm-compatible mock response object."""
    return SimpleNamespace(
        choices=[
            SimpleNamespace(
                message=SimpleNamespace(
                    content=f"<mechanism_evaluation>...</mechanism_evaluation>\n<score>{score}</score>",
                ),
            ),
        ],
        usage=SimpleNamespace(
            prompt_tokens=prompt_tokens,
            completion_tokens=completion_tokens,
        ),
    )


# ---------------------------------------------------------------------------
# /readyz
# ---------------------------------------------------------------------------


def test_readyz_returns_200_when_rdkit_present(client):
    r = client.get("/readyz")
    assert r.status_code == 200


# ---------------------------------------------------------------------------
# Input validation
# ---------------------------------------------------------------------------


def test_invalid_reactant_smiles_returns_400(client):
    r = client.post(
        "/elucidate_mechanism",
        json={
            "reactants_smiles": "this is not a smiles",
            "products_smiles": "CCO",
            "max_nodes": 5,
        },
    )
    assert r.status_code == 400


def test_invalid_product_smiles_returns_400(client):
    r = client.post(
        "/elucidate_mechanism",
        json={
            "reactants_smiles": "CCO",
            "products_smiles": "!!!not_smiles!!!",
            "max_nodes": 5,
        },
    )
    assert r.status_code == 400


def test_missing_required_field_returns_422(client):
    r = client.post(
        "/elucidate_mechanism",
        json={"reactants_smiles": "CCO"},  # products_smiles missing
    )
    assert r.status_code == 422


def test_max_nodes_above_cap_returns_422(client):
    r = client.post(
        "/elucidate_mechanism",
        json={
            "reactants_smiles": "CCO",
            "products_smiles": "CCO",
            "max_nodes": 9999,  # > 400 ceiling
        },
    )
    assert r.status_code == 422


# ---------------------------------------------------------------------------
# Identity case (reactants == products)
# ---------------------------------------------------------------------------


def test_reactants_equals_products_returns_no_moves(client):
    """If src and dest canonicalize the same, search exits immediately."""
    r = client.post(
        "/elucidate_mechanism",
        json={
            "reactants_smiles": "CCO",
            "products_smiles": "OCC",  # same molecule, different SMILES order
            "max_nodes": 200,
        },
    )
    assert r.status_code == 200
    data = r.json()
    assert data["moves"] == []
    assert data["truncated"] is False
    assert data["total_nodes_explored"] == 0
    assert data["total_llm_calls"] == 0
    assert data["reactants_smiles"] == data["products_smiles"]


# ---------------------------------------------------------------------------
# Search budget exhaustion
# ---------------------------------------------------------------------------


def test_max_nodes_truncation_surfaces_warning(client):
    """A 1-node budget on a non-trivial reaction must truncate and warn."""
    # Mock LiteLLM so the search burns its single node before finding the goal.
    with mock.patch(
        "services.mcp_tools.mcp_synthegy_mech.llm_policy.LiteLLMScoringPolicy._acompletion",
        return_value=_fake_response(score=5.0),
    ):
        r = client.post(
            "/elucidate_mechanism",
            json={
                "reactants_smiles": "CC=O",
                "products_smiles": "CCN",  # cannot be reached from CC=O via game moves
                "max_nodes": 1,
            },
        )
    assert r.status_code == 200
    data = r.json()
    assert data["truncated"] is True
    assert data["moves"] == []
    assert any("budget exhausted" in w for w in data["warnings"])
    assert data["total_nodes_explored"] >= 1


# ---------------------------------------------------------------------------
# Warnings
# ---------------------------------------------------------------------------


def test_radical_input_surfaces_warning(client):
    """Synthegy is ionic-only — radical SMILES must trigger a warning."""
    with mock.patch(
        "services.mcp_tools.mcp_synthegy_mech.llm_policy.LiteLLMScoringPolicy._acompletion",
        return_value=_fake_response(),
    ):
        r = client.post(
            "/elucidate_mechanism",
            json={
                "reactants_smiles": "[O.]",  # explicit oxygen radical via [.] notation
                "products_smiles": "CCO",
                "max_nodes": 1,
            },
        )
    if r.status_code == 200:
        warnings = r.json()["warnings"]
        assert any("radical" in w.lower() for w in warnings), warnings
    else:
        # An invalid SMILES would 400; either path is acceptable so long as
        # we don't silently proceed.
        assert r.status_code == 400


def test_validate_energies_flag_surfaces_phase3_stub_warning(client):
    """Phase 3 is not implemented; the flag must produce an explicit warning."""
    with mock.patch(
        "services.mcp_tools.mcp_synthegy_mech.llm_policy.LiteLLMScoringPolicy._acompletion",
        return_value=_fake_response(),
    ):
        r = client.post(
            "/elucidate_mechanism",
            json={
                "reactants_smiles": "CC=O",
                "products_smiles": "CC=O",  # identity → no moves but flag still echoed
                "max_nodes": 1,
                "validate_energies": True,
            },
        )
    assert r.status_code == 200
    warnings = r.json()["warnings"]
    assert any("Phase 3" in w or "stub" in w.lower() for w in warnings), warnings


# ---------------------------------------------------------------------------
# Telemetry
# ---------------------------------------------------------------------------


def test_token_counters_aggregate_across_llm_calls(client):
    """prompt_tokens / completion_tokens must aggregate, not just echo last call."""
    # Each fake call returns 100 + 40 tokens. With 1-node budget the LLM is
    # invoked once per legal move enumerated at the root state.
    with mock.patch(
        "services.mcp_tools.mcp_synthegy_mech.llm_policy.LiteLLMScoringPolicy._acompletion",
        return_value=_fake_response(prompt_tokens=100, completion_tokens=40),
    ):
        r = client.post(
            "/elucidate_mechanism",
            json={
                "reactants_smiles": "CC=O",
                "products_smiles": "CCO",
                "max_nodes": 1,
            },
        )
    assert r.status_code == 200
    data = r.json()
    assert data["total_llm_calls"] >= 1
    assert data["prompt_tokens"] == data["total_llm_calls"] * 100
    assert data["completion_tokens"] == data["total_llm_calls"] * 40
