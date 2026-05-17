"""Unit tests for the Phase 7 enrichment in wiki_regen._ctx_compound.

Verifies that the compound context builder returns facts and hypotheses
sections alongside the base compound identity fields.
"""
from __future__ import annotations

from typing import Any
from unittest.mock import AsyncMock, MagicMock, patch

import pytest

from services.optimizer.wiki_regen.main import _ctx_compound, _SkipPage


def _page(inchikey: str) -> dict[str, Any]:
    return {
        "slug": f"compound/{inchikey}",
        "kind": "compound",
        "title": f"Compound {inchikey[:14]}",
        "entity_ref": {"label": "Compound", "id_property": "inchikey", "id_value": inchikey},
        "nce_project_id": None,
    }


def _mock_conn(
    compound_row: dict[str, Any] | None,
    facts: list[dict[str, Any]] | None = None,
    hypotheses: list[dict[str, Any]] | None = None,
) -> MagicMock:
    """Build a mock psycopg connection that returns compound, then facts, then hypotheses."""
    call_seq: list[Any] = [compound_row, facts or [], hypotheses or []]

    class _MockCur:
        def __init__(self) -> None:
            self._seq = list(call_seq)

        async def __aenter__(self) -> "_MockCur":
            return self

        async def __aexit__(self, *a: Any) -> None:
            pass

        async def execute(self, *a: Any, **kw: Any) -> None:
            pass

        async def fetchone(self) -> Any:
            v = self._seq.pop(0) if self._seq else None
            return v if not isinstance(v, list) else None

        async def fetchall(self) -> Any:
            v = self._seq.pop(0) if self._seq else []
            return v if isinstance(v, list) else []

    cur = _MockCur()
    conn = AsyncMock()
    conn.cursor = MagicMock(return_value=cur)
    return conn


# ---------------------------------------------------------------------------
# Basic smoke tests
# ---------------------------------------------------------------------------


@pytest.mark.asyncio
async def test_ctx_compound_returns_compound_identity():
    cmp = {"inchikey": "AAAA", "smiles_canonical": "CCO", "molecular_formula": "C2H6O",
            "mw": 46.07, "chebi_id": None, "pubchem_cid": None, "internal_code_masked": None}
    conn = _mock_conn(cmp)
    ctx = await _ctx_compound(conn, _page("AAAA"))
    assert ctx["page_kind"] == "compound"
    assert ctx["compound"]["inchikey"] == "AAAA"
    assert ctx["compound"]["smiles"] == "CCO"


@pytest.mark.asyncio
async def test_ctx_compound_includes_facts_section():
    cmp = {"inchikey": "BBBB", "smiles_canonical": None, "molecular_formula": None,
            "mw": None, "chebi_id": None, "pubchem_cid": None, "internal_code_masked": None}
    facts = [
        {"id": "f1", "predicate": "has_yield_pct", "object_value": {"value": 85.0},
         "confidence": 0.90, "confidence_tier": "HIGH"},
    ]
    conn = _mock_conn(cmp, facts=facts, hypotheses=[])
    ctx = await _ctx_compound(conn, _page("BBBB"))
    assert "facts" in ctx
    assert len(ctx["facts"]) == 1
    assert ctx["facts"][0]["predicate"] == "has_yield_pct"
    assert ctx["facts"][0]["cite"] == "fact:f1"


@pytest.mark.asyncio
async def test_ctx_compound_includes_hypotheses_section():
    cmp = {"inchikey": "CCCC", "smiles_canonical": None, "molecular_formula": None,
            "mw": None, "chebi_id": None, "pubchem_cid": None, "internal_code_masked": None}
    # Hypothesized-tier entries come from the facts table (derivation_class='HYPOTHESIZED');
    # the hypotheses table does not have subject_id_value / predicate / object_value columns.
    hypotheses = [
        {"id": "h1", "predicate": "mechanism_involves_pi_stacking", "object_value": {"value": True},
         "confidence": 0.55, "confidence_tier": "medium"},
    ]
    conn = _mock_conn(cmp, facts=[], hypotheses=hypotheses)
    ctx = await _ctx_compound(conn, _page("CCCC"))
    assert "hypotheses" in ctx
    assert len(ctx["hypotheses"]) == 1
    assert ctx["hypotheses"][0]["predicate"] == "mechanism_involves_pi_stacking"
    assert ctx["hypotheses"][0]["cite"] == "fact:h1"
    assert ctx["hypotheses"][0]["confidence_tier"] == "medium"


@pytest.mark.asyncio
async def test_ctx_compound_empty_facts_and_hypotheses():
    cmp = {"inchikey": "DDDD", "smiles_canonical": "c1ccccc1", "molecular_formula": "C6H6",
            "mw": 78.11, "chebi_id": None, "pubchem_cid": None, "internal_code_masked": None}
    conn = _mock_conn(cmp, facts=[], hypotheses=[])
    ctx = await _ctx_compound(conn, _page("DDDD"))
    assert ctx["facts"] == []
    assert ctx["hypotheses"] == []


@pytest.mark.asyncio
async def test_ctx_compound_raises_skip_when_compound_not_found():
    conn = _mock_conn(compound_row=None)
    with pytest.raises(_SkipPage):
        await _ctx_compound(conn, _page("NOTEXIST"))
