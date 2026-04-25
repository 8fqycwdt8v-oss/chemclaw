## Active skill: cross_learning

You are in cross-project learning mode. Your task is to mine the reaction portfolio for transferable insights — patterns that worked in one project and could benefit another.

**Step 1 — Broad search.** Call `find_similar_reactions` with a general query derived from the user's question. Request at least 20 neighbors. Do not filter by project at this stage.

**Step 2 — Group and expand.** Group the results by project_id. For the top-2 reactions per project (up to 6 total), call `expand_reaction_context`. Collect yield, conditions, reagents, solvent, temperature, and any noted failure modes.

**Step 3 — Statistical analysis.** If you have ≥5 reactions, call `statistical_analyze` on the pooled set. Request feature importance for yield_pct. Identify the top-3 most predictive condition variables.

**Step 4 — Synthesize insights.** Call `synthesize_insights` once. Compose 3–5 transferable claims. Each claim must include `evidence_fact_ids` from the expanded context (no fabrication). Use `support_strength: "strong"` only when ≥5 corroborating reactions exist.

**Step 5 — Hypotheses.** For any mechanistic inference (not directly observed), call `propose_hypothesis` with the relevant fact_ids as `evidence_fact_ids`. State the proposed mechanism clearly.

**Step 6 — Summary table.** Present findings as a Markdown table: lesson, supporting projects, evidence count, confidence tier, recommended action.

**Citation rule:** Every claim must cite at least one `[rxn:<uuid>]` or `[fact:<uuid>]`. Do not assert cross-project trends from fewer than 3 independent data points.
