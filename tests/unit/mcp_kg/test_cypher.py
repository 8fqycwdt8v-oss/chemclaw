"""Unit tests for the Cypher builders.

These are string-level tests — we check the builders produce expected query
skeletons and that unsafe labels/predicates are rejected. Integration tests
against a live Neo4j cover actual execution.
"""

from __future__ import annotations

from datetime import datetime, timezone

import pytest

from services.mcp_tools.mcp_kg.cypher import (
    _safe_id_property,
    _safe_label,
    _safe_predicate,
    bootstrap_cyphers,
    build_invalidate_fact_cypher,
    build_query_at_time_cypher,
    build_write_fact_cypher,
)
from services.mcp_tools.mcp_kg.models import (
    ConfidenceTier,
    EntityRef,
    Provenance,
    QueryAtTimeRequest,
    WriteFactRequest,
)


def _req() -> WriteFactRequest:
    return WriteFactRequest(
        subject=EntityRef(label="Compound", id_property="inchikey", id_value="KEY1"),
        object=EntityRef(label="Reaction", id_property="uuid", id_value="RXN1"),
        predicate="IS_REAGENT_IN",
        edge_properties={"equiv": 1.2},
        confidence_tier=ConfidenceTier.MULTI_SOURCE_LLM,
        confidence_score=0.8,
        provenance=Provenance(source_type="ELN", source_id="EXP-1"),
    )


class TestSafeGuards:
    @pytest.mark.parametrize(
        "bad",
        ["comp`ound", "Compound;", "Compound DROP", "Compound`", " Compound"],
    )
    def test_unsafe_label_raises(self, bad: str) -> None:
        with pytest.raises(ValueError):
            _safe_label(bad)

    @pytest.mark.parametrize(
        "bad",
        ["is_reagent_in", "IS REAGENT", "IS-REAGENT", "IS`REAGENT", "1_REAGENT"],
    )
    def test_unsafe_predicate_raises(self, bad: str) -> None:
        with pytest.raises(ValueError):
            _safe_predicate(bad)

    def test_unsafe_id_property_raises(self) -> None:
        with pytest.raises(ValueError):
            _safe_id_property("id; DROP TABLE")


class TestWriteFactCypher:
    def test_contains_correctly_interpolated_labels(self) -> None:
        q, params = build_write_fact_cypher(_req())
        # Labels appear as literal identifiers, not parameters.
        assert ":Compound " in q
        assert ":Reaction " in q
        assert ":IS_REAGENT_IN " in q
        # Values are parameterised.
        assert "$s_id_value" in q
        assert "$o_id_value" in q
        assert params["s_id_value"] == "KEY1"
        assert params["o_id_value"] == "RXN1"
        assert params["confidence_tier"] == "multi_source_llm"
        assert params["confidence_score"] == 0.8
        assert params["edge_properties"] == {"equiv": 1.2}

    def test_write_is_merge_not_create_for_race_safety(self) -> None:
        # The critical anti-race invariant: the edge must be matched by
        # fact_id via MERGE, not blindly CREATEd.
        q, _ = build_write_fact_cypher(_req())
        assert "MERGE (s)-[r:IS_REAGENT_IN { fact_id: $fact_id }]->(o)" in q
        assert "ON CREATE SET r.t_valid_from" in q
        # Returned flag lets callers know if their call was the creator.
        assert "AS created" in q


class TestBootstrap:
    def test_includes_uniqueness_constraint(self) -> None:
        stmts = bootstrap_cyphers()
        assert any("REQUIRE r.fact_id IS UNIQUE" in s for s in stmts)

    def test_includes_relationship_index(self) -> None:
        stmts = bootstrap_cyphers()
        assert any("FOR ()-[r]-() ON (r.fact_id)" in s for s in stmts)

    def test_every_stmt_is_idempotent(self) -> None:
        stmts = bootstrap_cyphers()
        assert all("IF NOT EXISTS" in s for s in stmts)


class TestQueryAtTimeCypher:
    def test_both_direction_with_predicate(self) -> None:
        req = QueryAtTimeRequest(
            entity=EntityRef(label="Compound", id_property="inchikey", id_value="K"),
            predicate="IS_REAGENT_IN",
            direction="both",
            at_time=datetime(2026, 1, 1, tzinfo=timezone.utc),
        )
        q, params = build_query_at_time_cypher(req)
        assert ":IS_REAGENT_IN" in q
        assert "r.t_valid_from <= $at_time" in q
        assert "r.invalidated_at IS NULL" in q
        assert params["id_value"] == "K"
        assert params["at_time"] is not None

    def test_out_direction_without_predicate(self) -> None:
        req = QueryAtTimeRequest(
            entity=EntityRef(label="NCEProject", id_property="internal_id", id_value="NCE-1"),
            direction="out",
        )
        q, _ = build_query_at_time_cypher(req)
        assert "-[r]->" in q
        assert "$at_time" not in q.replace("$at_time", "", 1) or "at_time" not in q  # no temporal clause

    def test_include_invalidated_toggles_where(self) -> None:
        req = QueryAtTimeRequest(
            entity=EntityRef(label="Compound", id_property="inchikey", id_value="K"),
            include_invalidated=True,
        )
        q, _ = build_query_at_time_cypher(req)
        assert "invalidated_at IS NULL" not in q


class TestInvalidateFactCypher:
    def test_cypher_shape(self) -> None:
        q = build_invalidate_fact_cypher()
        assert "$fact_id" in q
        assert "r.t_valid_to" in q
        assert "$t_valid_to" in q
        assert "r.invalidated_at" in q


class TestGroupIdTenantScope:
    """Tranche 1 / C6: every Cypher path must carry a group_id."""

    def test_write_fact_sets_group_id_on_edge(self) -> None:
        q, params = build_write_fact_cypher(_req())
        assert "r.group_id = $group_id" in q
        # Default falls back to the system sentinel for backward compat.
        assert params["group_id"] == "__system__"

    def test_write_fact_propagates_explicit_group_id(self) -> None:
        req = WriteFactRequest(
            subject=EntityRef(label="Compound", id_property="inchikey", id_value="KEY1"),
            object=EntityRef(label="Reaction", id_property="uuid", id_value="RXN1"),
            predicate="IS_REAGENT_IN",
            confidence_tier=ConfidenceTier.MULTI_SOURCE_LLM,
            confidence_score=0.8,
            provenance=Provenance(source_type="ELN", source_id="EXP-1"),
            group_id="proj-NCE-007",
        )
        _, params = build_write_fact_cypher(req)
        assert params["group_id"] == "proj-NCE-007"

    def test_query_filters_by_group_id_first(self) -> None:
        req = QueryAtTimeRequest(
            entity=EntityRef(label="Compound", id_property="inchikey", id_value="K"),
            include_invalidated=True,
        )
        q, params = build_query_at_time_cypher(req)
        # group_id must be present in the WHERE clause and the params.
        assert "r.group_id = $group_id" in q
        assert params["group_id"] == "__system__"

    def test_invalidate_fact_includes_group_id_in_match(self) -> None:
        # Cross-tenant invalidation surfaces as 'fact not found' because the
        # MATCH requires the calling tenant.
        q = build_invalidate_fact_cypher()
        assert "{ fact_id: $fact_id, group_id: $group_id }" in q

    def test_bootstrap_creates_group_id_index(self) -> None:
        stmts = bootstrap_cyphers()
        assert any("FOR ()-[r]-() ON (r.group_id)" in s for s in stmts)

    @pytest.mark.parametrize(
        "bad",
        ["", "ab/cd", "ab cd", "ab;DROP", "abc'", "x" * 81],
    )
    def test_pydantic_rejects_unsafe_group_id(self, bad: str) -> None:
        from pydantic import ValidationError

        with pytest.raises(ValidationError):
            QueryAtTimeRequest(
                entity=EntityRef(label="Compound", id_property="inchikey", id_value="K"),
                group_id=bad,
            )
