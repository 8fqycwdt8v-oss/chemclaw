# Vendored from STEER (Synthegy)

Files in this directory are vendored verbatim (or near-verbatim with imports
adjusted) from the **STEER** repository, the open-source implementation of
the Synthegy framework described in:

> **Bran, A. M.; Neukomm, T. A.; Armstrong, D.; Jončev, Z.; Schwaller, P.**
> *Chemical reasoning in LLMs unlocks strategy-aware synthesis planning and
> reaction mechanism elucidation.*
> Matter (2026). DOI: [10.1016/j.matt.2026.102812](https://doi.org/10.1016/j.matt.2026.102812)

## Source

- Upstream: <https://github.com/schwallergroup/steer>
- Upstream HEAD at vendor time: `da0134f70a476c38f4a86498ee656a3179707319` (2026-04-30)
- Upstream license: MIT (see `LICENSE.upstream`)

## Files

| Vendored file | Upstream source | Notes |
|---|---|---|
| `molecule_set.py` | `src/steer/mechanism/molecule_set.py` | Verbatim copy. Rule-based environment — enumerates legal ionization + attack moves on a molecule set via RDKit. No internal `steer.*` imports, so vendored as-is. |
| `prompt_canonical.py` | `src/steer/mechanism/prompts/preprint_prompt_last_step_plus_game.py` | Verbatim copy. The canonical mechanism scoring prompt cited in the paper. |

## Why vendored vs. pip-installed

1. **Avoids upstream's heavy deps** — `aizynthfinder` (full retrosynthesis engine), `weave` (W&B tracing — would conflict with our Langfuse setup), `cairosvg` (SVG rendering), and `litellm.Router` with a hardcoded model list are pulled in by `pip install steer` but are not needed for mechanism elucidation.
2. **Avoids upstream's hardcoded credentials** — at vendor time, `src/steer/llm/llm_router.py:250` contained a hardcoded Google Cloud API key. Vendoring lets us replace the entire LLM-routing layer with a clean LiteLLM-proxy adapter.
3. **No stable releases yet** — upstream's `setup.cfg` is `version = 0.0.1` with `Development Status :: 1 - Planning`. Pinning a commit SHA is the right model.

## Maintenance

When updating: pull from upstream, diff against the file in this directory, hand-merge changes. Keep this `UPSTREAM.md` updated with the new commit SHA. Run `python -c "from services.mcp_tools.mcp_synthegy_mech.vendored.molecule_set import legal_moves_from_smiles"` afterward to confirm the import still works.

## Attribution

The mechanism-search algorithm, move grammar (`(i, x, y)` ionization / `(a, x, y)` attack), and scoring prompt are due to Bran et al. (cited above). ChemClaw adapts these into an HTTP-callable MCP service; we do not claim authorship of the vendored logic.
