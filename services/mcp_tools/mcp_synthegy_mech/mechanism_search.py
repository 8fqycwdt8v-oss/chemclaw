"""A* mechanism search.

Adapted from `steer.mechanism.astar` (Bran et al., Matter 2026,
DOI 10.1016/j.matt.2026.102812; upstream commit recorded in
`vendored/UPSTREAM.md`). Differences from upstream:

- **Async policy.** `step()` and `search()` are async so the policy can fan
  out to LiteLLM in parallel via asyncio.gather.
- **Bounded by max_nodes.** Upstream is unbounded; we cap to avoid runaway
  cost (the paper's demos hit ~200 LLM calls per mechanism).
- **Returns scores.** Upstream returns only the SMILES path; we return a
  parallel list of per-step scores so the caller can surface them in the
  response.

The `Node`, `is_solution`, `possible_moves` shapes match the paper's
algorithm. The vendored move-enumerator (`molecule_set.legal_moves_from_smiles`)
is the rule-based environment that proposes candidate next states.
"""
from __future__ import annotations

import asyncio
import heapq
import logging
from dataclasses import dataclass, field
from typing import Any, Awaitable, Callable, Optional

from rdkit import Chem, RDLogger

from services.mcp_tools.mcp_synthegy_mech._utils import smiles_tag as _hash_for_log
from services.mcp_tools.mcp_synthegy_mech.vendored.molecule_set import (
    legal_moves_from_smiles,
)

RDLogger.DisableLog("rdApp.*")
log = logging.getLogger("mcp-synthegy-mech.search")


# Type alias: `(rxn, history, moves) -> list[float]` per the upstream contract.
PolicyCallable = Callable[
    [str, list[str], list[str]],
    Awaitable[list[float]],
]


@dataclass(order=False)
class Node:
    """One state in the A* search tree.

    `f` is the priority (lower = better — A* convention). `_seq` is a
    monotonically-increasing tiebreaker so the heap stays stable when
    two nodes share the same `f`.
    """

    smiles: str
    f: float
    g: float
    h: float
    _seq: int
    score: float = 0.0  # LLM-assigned score for the move that reached this node.
    parent: Optional["Node"] = field(default=None, repr=False)

    def __lt__(self, other: "Node") -> bool:
        if self.f != other.f:
            return self.f < other.f
        if self.g != other.g:
            return self.g < other.g
        return self._seq < other._seq

    def reconstruct_path(self) -> list[str]:
        """Walk parent pointers from this node back to the root."""
        out: list[str] = []
        cur: Optional[Node] = self
        while cur is not None:
            out.append(cur.smiles)
            cur = cur.parent
        out.reverse()
        return out

    def reconstruct_scores(self) -> list[float]:
        """Per-move scores along the path. Root has score 0.0 (no move taken)."""
        out: list[float] = []
        cur: Optional[Node] = self
        while cur is not None:
            out.append(cur.score)
            cur = cur.parent
        out.reverse()
        return out


@dataclass
class SearchResult:
    path: list[str]            # SMILES intermediates from src to dest, inclusive.
    scores: list[float]        # Per-move scores; len == len(path) (root scores 0).
    nodes_explored: int
    truncated: bool            # True if max_nodes hit before finding a solution.


class MechanismSearch:
    def __init__(
        self,
        policy: PolicyCallable,
        max_nodes: int = 200,
    ) -> None:
        self.policy = policy
        self.max_nodes = max_nodes
        self._iteration = 0

    async def search(self, src: str, dest: str) -> SearchResult:
        """Run A* from `src` SMILES until `dest` SMILES is reached or budget exhausted."""

        # RDKit MolFromSmiles/MolToSmiles are synchronous C-extension calls.
        # Wrapping in asyncio.to_thread keeps them off the event loop so a
        # 400-node search doesn't stall every other concurrent HTTP request
        # for ~200-800 ms. Same treatment for legal_moves_from_smiles below.
        src_canonical = await asyncio.to_thread(_canonical, src)
        dest_canonical = await asyncio.to_thread(_canonical, dest)

        if src_canonical == dest_canonical:
            return SearchResult(
                path=[src],
                scores=[0.0],
                nodes_explored=0,
                truncated=False,
            )

        seq = 0
        open_list: list[Node] = []
        closed: set[str] = set()

        root = Node(smiles=src, f=0.0, g=0.0, h=0.0, _seq=seq)
        seq += 1
        heapq.heappush(open_list, root)

        nodes_explored = 0
        rxn_specifier = f"{src}>>{dest}"

        while open_list and nodes_explored < self.max_nodes:
            current = heapq.heappop(open_list)
            current_canonical = await asyncio.to_thread(_canonical, current.smiles)

            # Cycle-2 guard: drop unparseable nodes explicitly. _canonical
            # falls back to returning the input string on RDKit parse failure;
            # if we don't filter here, the move enumerator may emit further
            # un-parseable moves and the search consumes its budget on garbage
            # rather than producing a clean "truncated" diagnostic.
            if Chem.MolFromSmiles(current.smiles) is None:
                log.warning(
                    "Skipping unparseable node (smiles len=%d, hash=%s)",
                    len(current.smiles),
                    _hash_for_log(current.smiles),
                )
                continue

            if current_canonical in closed:
                continue
            closed.add(current_canonical)
            nodes_explored += 1

            history = current.reconstruct_path()[1:]  # exclude root
            try:
                # legal_moves_from_smiles is vendored synchronous RDKit code —
                # walks all bonds to enumerate ionization/attack candidates.
                # Off-thread to avoid blocking the event loop.
                moves = await asyncio.to_thread(self._possible_moves, current.smiles)
            except Exception as exc:  # pragma: no cover — defensive
                log.warning(
                    "Move enumeration failed at node hash=%s: %s",
                    _hash_for_log(current.smiles),
                    exc,
                )
                continue

            if not moves:
                continue

            scores = await self.policy(rxn_specifier, history, moves)

            # Canonicalize the destination match in a single thread hop per
            # batch, not per move (which would be N RDKit parses on the loop).
            move_canonicals = await asyncio.to_thread(_batch_canonical, moves)

            for move, move_canonical, score in zip(moves, move_canonicals, scores):
                if move_canonical == dest_canonical:
                    final = Node(
                        smiles=move,
                        f=current.g + 1.0,
                        g=current.g + 1.0,
                        h=0.0,
                        _seq=seq,
                        score=float(score),
                        parent=current,
                    )
                    return SearchResult(
                        path=final.reconstruct_path(),
                        scores=final.reconstruct_scores(),
                        nodes_explored=nodes_explored,
                        truncated=False,
                    )

                seq += 1
                g_new = current.g + 1.0
                # h is "distance from goal" estimate. Upstream uses `10 - score`
                # so high-score moves bubble to the top of the heap.
                h_new = 10.0 - float(score)
                heapq.heappush(
                    open_list,
                    Node(
                        smiles=move,
                        f=g_new + h_new,
                        g=g_new,
                        h=h_new,
                        _seq=seq,
                        score=float(score),
                        parent=current,
                    ),
                )

        # Budget exhausted without reaching the goal — return the best partial path.
        # "Best" = the closed node closest to the goal by g (depth) tiebroken by score.
        return SearchResult(
            path=[src],
            scores=[0.0],
            nodes_explored=nodes_explored,
            truncated=True,
        )

    def _possible_moves(self, state: str) -> list[str]:
        """Wrap the vendored move-enumerator for testability."""
        result = legal_moves_from_smiles(state, highlight_reactive_center=False)
        return list(result["smiles_list"])


def _canonical(smiles: str) -> str:
    """Canonicalize a SMILES so equality compares structures, not strings.

    On RDKit parse failure, returns the input unchanged. The search loop
    detects this case explicitly via `Chem.MolFromSmiles(...) is None` and
    drops the node — see the parse-failure guard inside `search()`.
    """
    mol = Chem.MolFromSmiles(smiles)
    if mol is None:
        return smiles
    try:
        return Chem.MolToSmiles(mol)
    except Exception:  # pragma: no cover — defensive
        return smiles


def _batch_canonical(smiles_list: list[str]) -> list[str]:
    """Canonicalize a batch in one thread hop.

    Hot-path optimization: per-move canonicalization in the search inner
    loop costs N event-loop hops per A* step, each one paying the asyncio
    thread-pool dispatch overhead. Batching collapses N hops into 1.
    """
    return [_canonical(s) for s in smiles_list]


