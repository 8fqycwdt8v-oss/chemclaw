## Active skill: code_mode

You can replace a chain of 3+ read-only tool calls with **one** call to `run_orchestration_script` that runs a short Python script inside the Monty sandbox. The script calls allow-listed tools as `external_function("<tool_id>", {...})` and returns a dict of named outputs.

**Decision rule (in this exact order):**

1. **One-step task?** Call the tool directly. Skip the script.
2. **2 calls and the second only uses the first's output?** Call them sequentially.
3. **3+ read-only calls composed via filter / sort / dedupe / top-k / join?** Use `run_orchestration_script`.
4. **Any mutating tool, any `ask_user`, any generative chemistry, any branch that depends on you reasoning between calls?** Stay sequential.

**Script conventions:**

- Set the variable named in `expected_outputs` before the script ends — that becomes the `outputs` map.
- `external_function(name, args)` returns the tool's parsed output as a Python dict (or list / scalar). It raises an exception if the tool denies, errors, or is not in `allowed_tools`.
- Stdlib only: `json`, `re`, `datetime`, `os`, `sys`, `typing`, `asyncio`. **No third-party packages, no classes, no `@dataclass`, no match statements.** Use plain dicts and lists.
- Avoid `itertools.groupby` (may not be available). Use a manual `dict[key] = []` pattern.
- Cap your script at ~80 lines. If it grows past that, the task probably has a branch — go back to sequential.

**Allow-list:** declare exactly the tool ids you'll call in `allowed_tools`. Listing more than you need invites preflight denials.

**Failure surface:** the call returns `{outcome, outputs?, stdout, stderr, external_calls, error?, ...}`. On `outcome != "ok"`, do **not** silently retry — read the `error` field and either fix the script (if it's a logic bug) or fall back to sequential calls (if the runtime is disabled / a tool is denied).

---

### Good example — retrieve, filter, rank

User asks: "fetch reactions similar to CC(=O)c1ccc(O)cc1 with yield > 60% and rank by recency, top 10."

```python
target = external_function("canonicalize_smiles", {"smiles": "CC(=O)c1ccc(O)cc1"})["canonical_smiles"]
hits = external_function("find_similar_reactions", {"rxn_smiles": target, "k": 50})["reactions"]
filtered = [r for r in hits if r.get("yield_pct", 0) >= 60]
filtered.sort(key=lambda r: r.get("recorded_at", ""), reverse=True)
top10 = filtered[:10]
```

`expected_outputs: ["top10"]`. One LLM round-trip instead of four.

### Bad example — branchy, stay sequential

User asks: "find similar reactions to X; if any have yield > 80%, deep-research the conditions; otherwise propose a new route."

This branches on a value you compute mid-stream. Stay sequential — the model needs to read the yields before deciding whether to deep-research vs propose.
