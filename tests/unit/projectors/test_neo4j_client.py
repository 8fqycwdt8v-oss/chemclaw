"""Unit tests for the shared Neo4j client wrapper.

The wrapper is thin — these tests verify env-var pickup + lazy import +
constructor-arg precedence without spinning up a real Neo4j instance.
"""
from __future__ import annotations

from unittest.mock import MagicMock, patch

import pytest

from services.projectors.common.neo4j_client import (
    SYSTEM_GROUP_ID,
    Neo4jClient,
    SyncNeo4jClient,
)


def test_system_group_id_matches_mcp_kg_sentinel() -> None:
    """Drift guard: the sentinel must match mcp-kg's server-side default."""
    assert SYSTEM_GROUP_ID == "__system__"


def test_async_client_picks_up_env(monkeypatch: pytest.MonkeyPatch) -> None:
    """from_env() reads NEO4J_URI / NEO4J_USER / NEO4J_PASSWORD."""
    monkeypatch.setenv("NEO4J_URI", "bolt://example:7687")
    monkeypatch.setenv("NEO4J_USER", "tester")
    monkeypatch.setenv("NEO4J_PASSWORD", "p")

    fake_driver = MagicMock()
    fake_driver_factory = MagicMock(return_value=fake_driver)

    with patch.dict("sys.modules", {"neo4j": MagicMock(AsyncGraphDatabase=MagicMock(driver=fake_driver_factory))}):
        client = Neo4jClient.from_env()

    fake_driver_factory.assert_called_once_with("bolt://example:7687", auth=("tester", "p"))
    assert client._driver is fake_driver  # noqa: SLF001 — internal access acceptable in unit test


def test_async_client_constructor_args_override_env(monkeypatch: pytest.MonkeyPatch) -> None:
    """Explicit args take precedence over env vars."""
    monkeypatch.setenv("NEO4J_URI", "bolt://from-env:7687")
    monkeypatch.setenv("NEO4J_USER", "env-user")
    monkeypatch.setenv("NEO4J_PASSWORD", "env-pw")

    fake_driver_factory = MagicMock()

    with patch.dict("sys.modules", {"neo4j": MagicMock(AsyncGraphDatabase=MagicMock(driver=fake_driver_factory))}):
        Neo4jClient(uri="bolt://override:7687", user="me", password="mine")

    fake_driver_factory.assert_called_once_with("bolt://override:7687", auth=("me", "mine"))


def test_async_client_user_defaults_when_env_absent(monkeypatch: pytest.MonkeyPatch) -> None:
    """NEO4J_USER falls back to 'neo4j' if unset."""
    monkeypatch.setenv("NEO4J_URI", "bolt://x:7687")
    monkeypatch.delenv("NEO4J_USER", raising=False)
    monkeypatch.setenv("NEO4J_PASSWORD", "p")

    fake_driver_factory = MagicMock()

    with patch.dict("sys.modules", {"neo4j": MagicMock(AsyncGraphDatabase=MagicMock(driver=fake_driver_factory))}):
        Neo4jClient.from_env()

    fake_driver_factory.assert_called_once_with("bolt://x:7687", auth=("neo4j", "p"))


def test_sync_client_picks_up_env(monkeypatch: pytest.MonkeyPatch) -> None:
    """SyncNeo4jClient mirrors the async one but uses the sync driver."""
    monkeypatch.setenv("NEO4J_URI", "bolt://example:7687")
    monkeypatch.setenv("NEO4J_USER", "tester")
    monkeypatch.setenv("NEO4J_PASSWORD", "p")

    fake_driver = MagicMock()
    fake_driver_factory = MagicMock(return_value=fake_driver)

    with patch.dict("sys.modules", {"neo4j": MagicMock(GraphDatabase=MagicMock(driver=fake_driver_factory))}):
        client = SyncNeo4jClient.from_env()

    fake_driver_factory.assert_called_once_with("bolt://example:7687", auth=("tester", "p"))
    assert client._driver is fake_driver  # noqa: SLF001
