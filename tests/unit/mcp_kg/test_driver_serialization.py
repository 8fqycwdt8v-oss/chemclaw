"""Unit tests for the driver's data-marshalling helpers.

Kept separate from integration tests so they can run without Neo4j.
"""

from __future__ import annotations

from datetime import datetime, timezone

from neo4j.time import DateTime as Neo4jDateTime

from services.mcp_tools.mcp_kg.driver import (
    _derive_id_property_from_node,
    _load_provenance,
    _n4j_to_py,
)
from services.mcp_tools.mcp_kg.models import Provenance


def test_n4j_to_py_converts_datetime() -> None:
    n = Neo4jDateTime(2026, 4, 22, 10, 30, 0, 0)
    out = _n4j_to_py(n)
    assert isinstance(out, datetime)


def test_n4j_to_py_recurses_into_dict_and_list() -> None:
    n = Neo4jDateTime(2026, 1, 1, 0, 0, 0, 0)
    mixed = {"a": 1, "b": [n, n], "c": {"d": n}}
    out = _n4j_to_py(mixed)
    assert isinstance(out["b"][0], datetime)
    assert isinstance(out["c"]["d"], datetime)


def test_load_provenance_from_json_string() -> None:
    raw = '{"source_type": "ELN", "source_id": "EXP-1"}'
    prov = _load_provenance(raw)
    assert isinstance(prov, Provenance)
    assert prov.source_id == "EXP-1"


def test_derive_id_property_prefers_inchikey() -> None:
    key, val = _derive_id_property_from_node({"inchikey": "ABC-1", "name": "foo"})
    assert key == "inchikey"
    assert val == "ABC-1"


def test_derive_id_property_falls_back_to_uuid() -> None:
    key, val = _derive_id_property_from_node({"uuid": "u-1", "x": 1})
    assert key == "uuid"
    assert val == "u-1"


def test_derive_id_property_raises_when_no_scalar_string() -> None:
    import pytest
    with pytest.raises(ValueError):
        _derive_id_property_from_node({"n": 1, "m": 2})
