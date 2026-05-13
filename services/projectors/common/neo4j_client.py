"""Shared Neo4j driver wrapper for direct-driver projectors.

History (review 2026-05-10 §1.3): the KG had two parallel write paths — some
projectors (`kg_experiments`, `kg_source_cache`) went through `mcp-kg` REST,
others (`kg_hypotheses`, `kg_documents`, `qm_kg`) held their own
`AsyncGraphDatabase.driver(...)` instance. Splitting the surface meant tenant
scoping, idempotency MERGE keys, and driver pin/version concerns lived in
multiple places.

This module is the central wrapper for the direct-driver projectors. It does
NOT replace `mcp-kg` — `mcp-kg` remains the right choice for cross-service
writers and for any agent-callable read path. What this module provides:

  - One place to pick up `NEO4J_URI` / `NEO4J_USER` / `NEO4J_PASSWORD` env vars.
  - One place to pin the driver version / connection-pool config.
  - Both async (`Neo4jClient`) and sync (`SyncNeo4jClient`) variants — qm_kg
    runs sync MERGEs inside an async wrapper for historical reasons; the others
    are fully async.
  - A `SYSTEM_GROUP_ID` sentinel matching mcp-kg's default so QM-style
    cross-tenant facts can be tagged consistently.

Cypher stays in the projector — the variety across the three projectors
(`:Hypothesis`/`:Fact`/`:CITES` cascade, `:Document`/`:Chunk`,
`:Compound`/`:CalculationResult`/`:Conformer` with bi-temporal valid_to
guarding) is too diverse to reify as helper methods cleanly without dragging
in the whole `mcp_kg.cypher` builder set.
"""
from __future__ import annotations

import os
from contextlib import asynccontextmanager, contextmanager
from typing import Any, AsyncIterator, Iterator

# Default group_id for cross-tenant facts (compound-level QM cache, etc.).
# Matches the mcp-kg server-side sentinel so the two write paths agree.
SYSTEM_GROUP_ID = "__system__"


def _env_uri() -> str:
    return os.environ["NEO4J_URI"]


def _env_user() -> str:
    return os.environ.get("NEO4J_USER", "neo4j")


def _env_password() -> str:
    return os.environ["NEO4J_PASSWORD"]


class Neo4jClient:
    """Async Neo4j driver wrapper.

    Holds a single `AsyncDriver` instance for the lifetime of the projector.
    Use `session()` as an async context manager:

        async with client.session() as sess:
            await sess.run("MERGE (n:Foo {id: $id})", id=row_id)

    Pass `database=...` to `session()` if you need a non-default DB name.
    """

    def __init__(
        self,
        uri: str | None = None,
        user: str | None = None,
        password: str | None = None,
    ) -> None:
        # Lazy import keeps unit tests that don't need neo4j (e.g. pure
        # idempotency-key tests) free of the dependency.
        from neo4j import AsyncGraphDatabase  # noqa: PLC0415

        self._driver = AsyncGraphDatabase.driver(
            uri or _env_uri(),
            auth=(user or _env_user(), password or _env_password()),
        )

    @classmethod
    def from_env(cls) -> "Neo4jClient":
        return cls()

    @asynccontextmanager
    async def session(self, *, database: str | None = None) -> AsyncIterator[Any]:
        # Pass `database` as an explicit keyword rather than splatting a dict —
        # neo4j 5.x types AsyncDriver.session()'s keyword params precisely, so a
        # `**dict[str, str]` passthrough fails `mypy --strict` (arg-type).
        cm = self._driver.session() if database is None else self._driver.session(database=database)
        async with cm as sess:
            yield sess

    async def close(self) -> None:
        await self._driver.close()


class SyncNeo4jClient:
    """Sync Neo4j driver wrapper.

    Used by `qm_kg` whose `_merge_into_neo4j` runs the MERGE chain
    synchronously inside an async caller. Same env-var pickup as
    `Neo4jClient`; constructor lazily imports the sync `GraphDatabase`.
    """

    def __init__(
        self,
        uri: str | None = None,
        user: str | None = None,
        password: str | None = None,
    ) -> None:
        from neo4j import GraphDatabase  # noqa: PLC0415

        self._driver = GraphDatabase.driver(
            uri or _env_uri(),
            auth=(user or _env_user(), password or _env_password()),
        )

    @classmethod
    def from_env(cls) -> "SyncNeo4jClient":
        return cls()

    @contextmanager
    def session(self, *, database: str | None = None) -> Iterator[Any]:
        # See Neo4jClient.session — pass `database` explicitly, no dict splat.
        cm = self._driver.session() if database is None else self._driver.session(database=database)
        with cm as sess:
            yield sess

    def close(self) -> None:
        self._driver.close()
