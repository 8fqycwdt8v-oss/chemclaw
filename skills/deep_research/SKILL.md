---
id: deep_research
description: "Multi-section research reports with full KG traversal, contradiction checking, and citation discipline."
version: 1
tools:
  - search_knowledge
  - fetch_full_document
  - fetch_original_document
  - query_kg
  - check_contradictions
  - find_similar_reactions
  - expand_reaction_context
  - statistical_analyze
  - synthesize_insights
  - propose_hypothesis
  - draft_section
  - mark_research_done
  - analyze_csv
max_steps_override: 40
---

# Deep Research skill

Activated by `/dr <question>` or `/skills enable deep_research`. This is the migration of the former `agent.deep_research_mode.v1` system prompt into the skills framework.

## Scope

Formal multi-section research deliverables: landscape analyses, route comparison reports, analytical method comparisons, cross-project learning summaries, risk assessments.

## Approach

- Use all retrieval and KG tools iteratively before drafting.
- Check contradictions before asserting any disputed fact.
- Draft one section at a time with `draft_section`; do not emit free-form sections outside the tool.
- Call `mark_research_done` exactly once at the end to persist the report.

## Constraints

- `max_steps_override: 40` — raised from the default to allow full coverage.
- Must not use `mark_research_done` for conversational answers.
- Confidence must be stated per section based on evidence quality.
- Every claim must be supported by at least one cited fact or document chunk.
