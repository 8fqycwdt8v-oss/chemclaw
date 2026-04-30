"""LiteLLM-proxied scoring policy for the mechanism A* search.

Replaces STEER's `steer.llm.llm_router.router` (which constructs an in-process
`litellm.Router` with a hardcoded model_list and dispatches directly to
providers using env-var API keys — including a hardcoded Google API key).

This policy speaks to ChemClaw's central LiteLLM proxy server over HTTP via
`litellm.acompletion(..., api_base=LITELLM_BASE_URL)`. Every prompt therefore
traverses the redactor callback in `services/litellm_redactor/callback.py`,
maintaining ChemClaw's single LLM-egress chokepoint.

The policy implements the callable shape that
`mechanism_search.MechanismSearch.policy` expects:

    async def __call__(rxn: str, history: list[str], moves: list[str]) -> list[float]

It scores each candidate move 0..10 with one LLM call per move, in parallel
via asyncio.gather. Failures fall back to score 0 (worst), so a single
misbehaving move never crashes the whole search.
"""
from __future__ import annotations

import asyncio
import hashlib
import logging
import os
import re
from dataclasses import dataclass
from typing import Any

log = logging.getLogger("mcp-synthegy-mech.policy")

# Compile once. Score is the integer between <score>...</score>.
_SCORE_RE = re.compile(r"<score>\s*(-?\d+(?:\.\d+)?)\s*</score>", re.IGNORECASE)


def _smiles_tag(smiles: str) -> str:
    """Stable, non-reversible identifier for a SMILES, safe to log.

    Proprietary compound structures must not appear in production logs even
    truncated — 80 chars is enough to identify most NCEs by structure search.
    A short blake2s digest is sufficient to correlate log lines for the same
    intermediate without revealing the structure itself.
    """
    return hashlib.blake2s(smiles.encode("utf-8"), digest_size=8).hexdigest()


@dataclass
class PolicyStats:
    """Telemetry collected over a single search run."""

    total_calls: int = 0
    prompt_tokens: int = 0
    completion_tokens: int = 0
    parse_failures: int = 0
    upstream_errors: int = 0


class LiteLLMScoringPolicy:
    """Policy: score each candidate next-state SMILES with the canonical prompt."""

    def __init__(
        self,
        model: str,
        prompt_prefix: str,
        prompt_intermed: str,
        prompt_suffix: str,
        timeout_s: float = 60.0,
        api_base: str | None = None,
        api_key: str | None = None,
        max_concurrency: int = 8,
    ) -> None:
        # Lazy import — keeps `pytest` collection fast and lets us mock at the
        # call site without paying for the litellm import in unit tests that
        # patch this class wholesale.
        self.model = model
        self.prefix = prompt_prefix
        self.intermed = prompt_intermed
        self.suffix = prompt_suffix
        self.timeout_s = timeout_s
        self.api_base = api_base or os.getenv("LITELLM_BASE_URL")
        self.api_key = api_key or os.getenv("LITELLM_API_KEY")
        self._sem = asyncio.Semaphore(max_concurrency)
        self.stats = PolicyStats()

    # ------------------------------------------------------------------
    # Search-policy contract
    # ------------------------------------------------------------------

    async def __call__(
        self,
        rxn: str,
        history: list[str],
        moves: list[str],
    ) -> list[float]:
        """Score each candidate next-state SMILES.

        Args:
            rxn: full target reaction as `reactants>>products`.
            history: list of intermediate-state SMILES already explored
                (the partial mechanism so far).
            moves: list of candidate next-state SMILES to score.

        Returns:
            list[float] of scores 0..10, one per input move, aligned with
            the input order.
        """
        if not moves:
            return []
        coros = [self._score_one(rxn, history, m) for m in moves]
        scores = await asyncio.gather(*coros, return_exceptions=False)
        return scores

    # ------------------------------------------------------------------
    # Internals
    # ------------------------------------------------------------------

    async def _score_one(self, rxn: str, history: list[str], move: str) -> float:
        async with self._sem:
            try:
                # Cycle-2 fix H-3: keep _build_messages INSIDE the try.
                # A bad `{step}` placeholder in self.suffix would otherwise
                # raise KeyError out of _score_one and bubble through
                # asyncio.gather (return_exceptions=False) → 500 to caller
                # with no partial path.
                messages = self._build_messages(rxn, history, move)
                response = await self._acompletion(messages)
            except asyncio.CancelledError:
                # NEVER swallow CancelledError — it's the asyncio cooperative
                # cancellation signal. Letting it propagate makes the search
                # responsive to caller cancellation (request abort, timeout).
                raise
            except Exception as exc:
                self.stats.upstream_errors += 1
                # Log a stable hash, not a SMILES prefix — proprietary
                # compound structures must not appear in log aggregation.
                log.warning(
                    "LiteLLM call failed for move %s: %s",
                    _smiles_tag(move),
                    exc,
                )
                return 0.0

            self.stats.total_calls += 1
            content, prompt_tokens, completion_tokens = self._extract(response)
            self.stats.prompt_tokens += prompt_tokens
            self.stats.completion_tokens += completion_tokens

            score = self._parse_score(content)
            if score is None:
                self.stats.parse_failures += 1
                # Log only the move's hash and the parse-failure type. The
                # raw LLM completion is intentionally not logged: it could
                # echo redacted tokens or proprietary SMILES from the prompt.
                log.warning(
                    "Could not parse <score> from response for move %s",
                    _smiles_tag(move),
                )
                return 0.0
            return score

    async def _acompletion(self, messages: list[dict[str, Any]]) -> Any:
        """Wrapper so tests can patch `litellm.acompletion` cleanly."""
        import litellm  # noqa: PLC0415 — lazy

        return await litellm.acompletion(
            model=self.model,
            temperature=0.1,
            messages=messages,
            api_base=self.api_base,
            api_key=self.api_key,
            timeout=self.timeout_s,
        )

    def _build_messages(
        self,
        rxn: str,
        history: list[str],
        move: str,
    ) -> list[dict[str, Any]]:
        """Construct the canonical prompt for one candidate move."""
        history_block = "\n".join(
            f"Step #{i + 1}: {smiles}" for i, smiles in enumerate(history)
        )
        full_prompt = (
            self.prefix
            + rxn
            + self.intermed
            + history_block
            + self.suffix.format(step=move)
        )
        return [{"role": "user", "content": full_prompt}]

    @staticmethod
    def _parse_score(text: str) -> float | None:
        match = _SCORE_RE.search(text)
        if not match:
            return None
        try:
            value = float(match.group(1))
        except ValueError:
            return None
        # Clamp to the documented 0..10 range; the prompt allows the model
        # to drift outside this band on rare occasions.
        return max(0.0, min(10.0, value))

    @staticmethod
    def _extract(response: Any) -> tuple[str, int, int]:
        """Pull (content, prompt_tokens, completion_tokens) from a litellm response.

        Tolerant of the shape variation between sync and async responses;
        the unit tests pin both paths.
        """
        try:
            content = response.choices[0].message.content
        except (AttributeError, IndexError, KeyError):
            content = ""
        try:
            prompt_tokens = int(response.usage.prompt_tokens)
        except (AttributeError, TypeError, ValueError):
            prompt_tokens = 0
        try:
            completion_tokens = int(response.usage.completion_tokens)
        except (AttributeError, TypeError, ValueError):
            completion_tokens = 0
        return content or "", prompt_tokens, completion_tokens
