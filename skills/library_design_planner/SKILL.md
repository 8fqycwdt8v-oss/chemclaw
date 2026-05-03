---
id: library_design_planner
description: "Design and rank focused chemical libraries by chaining the generative MCP, the corpus class catalog, and a QM scoring screen."
version: 1
tools:
  - canonicalize_smiles
  - inchikey_from_smiles
  - generate_focused_library
  - find_matched_pairs
  - find_similar_compounds
  - substructure_search
  - match_smarts_catalog
  - classify_compound
  - run_chemspace_screen
  - enqueue_batch
  - inspect_batch
  - workflow_define
  - workflow_run
  - workflow_inspect
  - workflow_pause_resume
  - workflow_modify
max_steps_override: 25
---

# Library Design Planner

Activated when the user asks to design or screen a focused library:
"propose 50 ligand variants of BINAP", "build a small library around this
fragment and tell me which to make first", "what bioisosteres of this
group are worth trying?".

## Approach

The Phase 5 generative MCP (`mcp-genchem`) gives you five generators
behind one tool (`generate_focused_library`):

| kind          | when to use                                                |
|---------------|------------------------------------------------------------|
| `scaffold`    | A known scaffold with `[*:N]` attachment points, R-groups. |
| `rgroup`      | Same as scaffold; explicit R-group lists.                  |
| `bioisostere` | A complete molecule + curated SMARTS rewrites.             |
| `grow`        | A small fragment to extend via BRICS.                      |
| `link`        | Two fragments to connect with short linkers.               |

Pair each generated set with **classification + scoring** before showing
the user: the agent should never dump 200 raw SMILES.

### 1. Canonical workflow

```json
{
  "name": "ligand-bioisostere-rank",
  "steps": [
    {"id": "gen", "kind": "tool_call", "tool": "generate_focused_library",
     "args": {"kind": "bioisostere", "seed_smiles": "<seed>", "max_proposals": 50}},
    {"id": "screen", "kind": "tool_call", "tool": "run_chemspace_screen",
     "args": {
       "name": "bioisostere-rank",
       "candidates": {"from": "list", "inchikeys": ["<from steps.gen>"]},
       "scoring_pipeline": [
         {"kind": "qm_single_point", "params": {"method": "GFN2"}}
       ],
       "top_k": 10
     }},
    {"id": "wait", "kind": "wait", "for": {"batch_id": "steps.screen.batch_id"}}
  ]
}
```

### 2. Filtering by role

Before scoring, narrow the candidate set to a chemotype — most "ligand"
questions don't want random scaffolds. Use
`find_similar_compounds` (Morgan r2) or `match_smarts_catalog` to filter,
then feed the InChIKeys into `run_chemspace_screen` with
`candidates: {from: "class", class_name: "Tertiary phosphine ligand"}`
or `{from: "list", inchikeys: [...]}`.

### 3. Picking the scoring pipeline

| User intent                         | Pipeline                            |
|-------------------------------------|-------------------------------------|
| "Quick triage"                      | `qm_single_point` only              |
| "Best binders"                      | `qm_geometry_opt` + `qm_frequencies`|
| "Most reactive site"                | `qm_fukui`                          |
| "Best electrochemical mediator"     | `qm_redox_potential`                |

Prefer cheaper steps first; the cache means the agent can always go
deeper on the top 5 hits in a follow-up turn.

### 4. Ask before committing

Library design is destructive of the user's CPU budget. For >50
proposals or any pipeline that runs frequencies, ASK the user (`ask_user`)
to confirm the chemistry intent before calling `workflow_run`.

### 5. Promote to tool

After a successful design + rank session, `promote_workflow_to_tool` so
future "library design" requests can call your forged tool by name
without rebuilding the JSON DSL.

## Examples

- *"Design 20 fluorine bioisosteres of compound X and tell me the three
  most likely to keep activity."*
  → bioisostere generator → score with `qm_single_point` → keep top 3.

- *"Build a small library around fragment Y and pick the one with the
  best HOMO-LUMO gap match to the target."*
  → BRICS grow → opt + single-point → sort by HOMO-LUMO delta.

- *"Find matched-molecular-pairs around our hit and surface the +1 logP
  transformations."*
  → `find_matched_pairs` → filter by delta_property → no QM needed.
