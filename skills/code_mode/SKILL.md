---
id: code_mode
description: "Replace 3+ sequential read-only tool calls with one Python script run inside the Monty sandbox."
version: 1
tools:
  - run_orchestration_script
  - canonicalize_smiles
  - inchikey_from_smiles
  - find_similar_reactions
  - find_similar_compounds
  - search_knowledge
  - query_kg
  - query_kg_at_time
  - query_provenance
  - query_source_cache
  - retrieve_related
  - expand_reaction_context
  - query_eln_canonical_reactions
  - fetch_eln_canonical_reaction
  - query_eln_experiments
  - fetch_eln_entry
  - query_eln_samples_by_entry
  - query_instrument_runs
  - query_instrument_datasets
max_steps_override: 8
---

# Code-mode orchestration skill

Activated when the user asks for compound retrieve / filter / rank / dedupe / join queries that would otherwise take 3+ sequential ReAct turns.

## When to reach for `run_orchestration_script`

Use code-mode if **all** of these hold:

1. The task needs **3 or more** sequential calls to read-only tools.
2. The composition between calls is pure-Python (filter, sort, dedupe by key, top-k, join two lists by id).
3. The data flow is **linear** — each call's output feeds the next; no branching that depends on the model's reasoning between steps.
4. None of the involved tools are state-mutating, prompt the user, or generate chemistry (`ask_user`, `enqueue_batch`, `workflow_*`, `generate_focused_library`).

If any of those don't hold, stay with sequential ReAct — code-mode is not free, and the model can't react to intermediate results inside a script.

## When NOT to reach for code-mode

- One- or two-step queries: the round-trip cost is in the noise.
- Anything mutating state.
- Anything where you'd want to inspect an intermediate result and decide what to do next.
- Generative chemistry, hypothesis formation, deep-research loops: these need the model in the loop on every step.

## Output conventions

- Cite every reaction / fact / chunk as you would in sequential mode (`[rxn:<uuid>]`, `[fact:<uuid>]`, `[doc:<uuid>:<chunk_index>]`). The `external_calls` trace is auditable, but citations still anchor in the rendered text.
- Surface the script's `outputs` map verbatim where possible. If the script returned a ranked list, render it as a Markdown table.
- If the runtime returns `outcome: "runtime_disabled"`, fall back to sequential ReAct calls — do not retry the script.
