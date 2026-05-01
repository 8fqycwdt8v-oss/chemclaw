"""xTB single-point energy validator for proposed mechanisms (Phase 3).

When the caller passes ``validate_energies=True``, the service calls
``mcp-xtb`` once per unique intermediate SMILES along the proposed path,
computes per-move energy deltas in Hartree, and surfaces them in the
``Move.energy_delta_hartree`` field.

Auth: when ``MCP_AUTH_SIGNING_KEY`` is set, this module mints an HS256
JWT scoped to ``mcp_xtb:invoke`` with ``aud=mcp-xtb`` via the existing
``services.mcp_tools.common.auth.sign_mcp_token`` helper. When the key
is unset, the call goes out without an Authorization header — mcp-xtb
will accept it only when ``MCP_AUTH_DEV_MODE=true``. This matches the
agent's outbound auth behaviour.

Failure mode: if mcp-xtb is unreachable or returns 5xx for any
intermediate, this validator does NOT crash the search. It returns
``None`` for the affected energies and surfaces a warning string the
caller appends to the response's ``warnings`` array. Energy validation
is a *secondary* signal; losing it is preferable to losing the
mechanism elucidation entirely.
"""
from __future__ import annotations

import asyncio
import logging
import os
import uuid
from dataclasses import dataclass

import httpx

from services.mcp_tools.common.auth import McpAuthError, sign_mcp_token
from services.mcp_tools.mcp_synthegy_mech._utils import smiles_tag as _smiles_tag

log = logging.getLogger("mcp-synthegy-mech.xtb_validator")


def _canonicalize_batch(smiles_list: list[str]) -> list[str]:
    """Canonicalize a batch of SMILES via RDKit. Falls back to the input
    string on parse failure so the caller can still look up by the original
    key (and can detect failures via `compute_energy_deltas` returning None).
    """
    from rdkit import Chem  # noqa: PLC0415 — only call on validate path

    out: list[str] = []
    for s in smiles_list:
        mol = Chem.MolFromSmiles(s)
        if mol is None:
            out.append(s)
            continue
        try:
            out.append(Chem.MolToSmiles(mol))
        except Exception:  # pragma: no cover — defensive
            out.append(s)
    return out

_DEFAULT_TIMEOUT_S = 60.0  # xtb opt for small molecules takes ~5–30 s.
_TARGET_SCOPE = "mcp_xtb:invoke"
_TARGET_AUDIENCE = "mcp-xtb"


@dataclass
class ValidationResult:
    """One validation pass over a list of intermediate SMILES.

    ``energy_per_smiles`` maps canonical (or input) SMILES → energy (Hartree).
    Missing keys mean xtb failed for that intermediate; the caller leaves
    the corresponding ``Move.energy_delta_hartree`` as None.
    """

    energy_per_smiles: dict[str, float]
    warnings: list[str]


class XtbValidator:
    def __init__(
        self,
        xtb_base_url: str,
        signing_key: str | None = None,
        user_entra_id: str = "system:mcp-synthegy-mech",
        timeout_s: float = _DEFAULT_TIMEOUT_S,
        max_concurrency: int = 4,
    ) -> None:
        self.xtb_base_url = xtb_base_url.rstrip("/")
        self.signing_key = signing_key if signing_key is not None else os.environ.get(
            "MCP_AUTH_SIGNING_KEY", ""
        )
        self.user_entra_id = user_entra_id
        self.timeout_s = timeout_s
        self._sem = asyncio.Semaphore(max_concurrency)

    async def validate(self, intermediates: list[str]) -> ValidationResult:
        """Compute single-point energies for each unique intermediate SMILES.

        Cycle-2 fix M-2: dedup by RDKit canonical form, not by Python string
        identity. Two SMILES like "c1ccccc1" and "C1=CC=CC=C1" both denote
        benzene; without canonicalization the dedup misses the duplicate
        and we'd pay xtb's ~10 s cost twice. Energies are stored under
        canonical keys; `compute_energy_deltas` looks up by canonical too.
        """
        # Off-thread RDKit canonicalization (synchronous C-ext) — keeps the
        # event loop responsive on a long path.
        canonical_inputs = await asyncio.to_thread(_canonicalize_batch, intermediates)
        # Order-preserving dedup by canonical form. Empty/None entries
        # from RDKit parse failure are kept under their original key so
        # the caller still sees them in `compute_energy_deltas`.
        unique_canonical: list[str] = list(dict.fromkeys(canonical_inputs))
        if not unique_canonical:
            return ValidationResult(energy_per_smiles={}, warnings=[])

        try:
            headers = self._auth_headers()
        except McpAuthError as exc:
            return ValidationResult(
                energy_per_smiles={},
                warnings=[
                    f"xTB validation skipped: could not mint mcp-xtb token ({exc})."
                ],
            )

        async with httpx.AsyncClient(timeout=self.timeout_s) as client:
            tasks = [self._optimize_one(client, headers, smi) for smi in unique_canonical]
            results = await asyncio.gather(*tasks, return_exceptions=True)

        energy_map_canonical: dict[str, float] = {}
        warnings: list[str] = []
        for smi, result in zip(unique_canonical, results):
            tag = _smiles_tag(smi)
            if isinstance(result, asyncio.CancelledError):
                # Never swallow CancelledError — propagate so the outer
                # request's cancellation actually cancels.
                raise result
            if isinstance(result, BaseException):
                warnings.append(
                    f"xTB validation failed for intermediate {tag}: "
                    f"{type(result).__name__}"
                )
                continue
            if result is None:
                warnings.append(
                    f"xTB returned no energy for intermediate {tag}; "
                    f"see mcp-xtb logs."
                )
                continue
            energy_map_canonical[smi] = result

        # Re-key the energy map back to the ORIGINAL SMILES so callers can
        # look up by the same string they passed in. canonical_inputs is
        # aligned with `intermediates` so we can map orig→canonical→energy.
        energy_map: dict[str, float] = {}
        for orig, canonical in zip(intermediates, canonical_inputs):
            if canonical in energy_map_canonical:
                energy_map[orig] = energy_map_canonical[canonical]

        return ValidationResult(energy_per_smiles=energy_map, warnings=warnings)

    async def _optimize_one(
        self,
        client: httpx.AsyncClient,
        headers: dict[str, str],
        smiles: str,
    ) -> float | None:
        tag = _smiles_tag(smiles)
        async with self._sem:
            try:
                response = await client.post(
                    f"{self.xtb_base_url}/optimize_geometry",
                    json={"smiles": smiles, "method": "GFN2-xTB"},
                    headers=headers,
                )
            except httpx.HTTPError as exc:
                log.warning("HTTP error calling mcp-xtb for %s: %s", tag, exc)
                return None

            if response.status_code != 200:
                log.warning(
                    "mcp-xtb returned %d for %s",
                    response.status_code,
                    tag,
                )
                return None

            try:
                payload = response.json()
            except ValueError:
                return None
            energy = payload.get("energy_hartree")
            if isinstance(energy, (int, float)):
                return float(energy)
            return None

    def _auth_headers(self) -> dict[str, str]:
        """Mint a scoped JWT or skip the header in dev mode."""
        if not self.signing_key.strip():
            return {}
        token = sign_mcp_token(
            sandbox_id=str(uuid.uuid4()),
            user_entra_id=self.user_entra_id,
            scopes=[_TARGET_SCOPE],
            audience=_TARGET_AUDIENCE,
            ttl_seconds=300,
            signing_key=self.signing_key,
        )
        return {"Authorization": f"Bearer {token}"}


def compute_energy_deltas(
    moves_smiles: list[tuple[str, str]],
    energy_per_smiles: dict[str, float],
) -> list[float | None]:
    """Compute per-move energy delta (to_smiles - from_smiles) in Hartree.

    Returns ``None`` for any move where either endpoint's energy is missing
    from the validation map.
    """
    deltas: list[float | None] = []
    for from_smi, to_smi in moves_smiles:
        e_from = energy_per_smiles.get(from_smi)
        e_to = energy_per_smiles.get(to_smi)
        if e_from is None or e_to is None:
            deltas.append(None)
        else:
            deltas.append(e_to - e_from)
    return deltas
