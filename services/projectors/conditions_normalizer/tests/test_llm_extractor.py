"""Tier 3 (LiteLLM JSON-extraction) tests. LLM is mocked."""
from __future__ import annotations

import json
from unittest import mock

import pytest


@pytest.fixture
def mock_litellm_completion():
    """Mock litellm.acompletion to return a predetermined response."""
    with mock.patch(
        "services.projectors.conditions_normalizer.llm_prompt.litellm.acompletion"
    ) as m:
        yield m


@pytest.mark.asyncio
async def test_llm_returns_parsed_fields(mock_litellm_completion):
    from services.projectors.conditions_normalizer.llm_prompt import (
        ExtractorSettings,
        extract_via_llm,
    )
    mock_litellm_completion.return_value = mock.MagicMock(
        choices=[mock.MagicMock(
            message=mock.MagicMock(
                content=json.dumps({
                    "solvent": "Toluene",
                    "catalyst_smiles": None,
                    "base": "K2CO3",
                    "temperature_c": 110,
                    "time_min": None,
                    "atmosphere": "N2",
                })
            )
        )]
    )
    settings = ExtractorSettings(
        litellm_base_url="http://x",
        litellm_api_key="k",
        agent_model_compactor="claude-haiku-4-5",
    )
    out = await extract_via_llm(
        "Procedure: heated solution in toluene with K2CO3 at 110 C overnight under N2.",
        settings,
    )
    assert out["solvent"] == "Toluene"
    assert out["base"] == "K2CO3"
    assert out["temperature_c"] == 110.0
    assert out["atmosphere"] == "N2"
    assert out["_status"]["solvent"]["source"] == "llm"


@pytest.mark.asyncio
async def test_llm_validation_failure_marks_ambiguous(mock_litellm_completion):
    from services.projectors.conditions_normalizer.llm_prompt import (
        ExtractorSettings,
        extract_via_llm,
    )
    mock_litellm_completion.return_value = mock.MagicMock(
        choices=[mock.MagicMock(message=mock.MagicMock(content="not-json"))]
    )
    settings = ExtractorSettings(
        litellm_base_url="http://x", litellm_api_key="k", agent_model_compactor="m",
    )
    out = await extract_via_llm("a procedure long enough to pass the 50-char minimum check needed", settings)
    assert out["solvent"] is None
    assert out["_status"]["solvent"]["status"] == "ambiguous"
    assert out["_status"]["solvent"]["error"] == "validation_failed"


@pytest.mark.asyncio
async def test_llm_truncates_long_input(mock_litellm_completion):
    """Input over 8k chars truncated before being sent to the LLM."""
    from services.projectors.conditions_normalizer.llm_prompt import (
        ExtractorSettings,
        extract_via_llm,
    )
    mock_litellm_completion.return_value = mock.MagicMock(
        choices=[mock.MagicMock(message=mock.MagicMock(content="{}"))]
    )
    settings = ExtractorSettings(
        litellm_base_url="http://x", litellm_api_key="k", agent_model_compactor="m",
    )
    huge = "z" * 20_000
    await extract_via_llm(huge, settings)
    sent_text = mock_litellm_completion.call_args.kwargs["messages"][1]["content"]
    assert len(sent_text) <= 8_500


@pytest.mark.asyncio
async def test_llm_skips_empty_input(mock_litellm_completion):
    """Empty / None / very short input bypasses the LLM call entirely."""
    from services.projectors.conditions_normalizer.llm_prompt import (
        ExtractorSettings,
        extract_via_llm,
    )
    settings = ExtractorSettings(
        litellm_base_url="http://x", litellm_api_key="k", agent_model_compactor="m",
    )
    out = await extract_via_llm("", settings)
    assert out["solvent"] is None
    mock_litellm_completion.assert_not_called()

    out = await extract_via_llm("hi", settings)
    assert out["solvent"] is None
    mock_litellm_completion.assert_not_called()
