---
id: qc
description: "Analytical question routing — HPLC, NMR, MS, KF data triage and method validation lookup."
version: 1
tools:
  - search_knowledge
  - query_kg
  - analyze_csv
  - check_contradictions
  - fetch_original_document
  - fetch_full_document
max_steps_override: 25
---

# QC / Analytical skill

Activated when the user asks about analytical data, method validation, instrument results, or specifications, or uses `/qc`.

## Scope

Covers HPLC (purity, impurity profiling), NMR (structure confirmation, purity), MS (mass confirmation, fragmentation), Karl Fischer (water content), dissolution, particle size, and general method validation topics.

## Approach

- Identify the analytical technique from the user's question first.
- For data files (CSV, tabular): use `analyze_csv` to compute summary statistics and triage anomalies before interpreting.
- For method validation or specification questions: use `search_knowledge` to retrieve SOPs, validation reports, and pharmacopeial references.
- For structured entity queries (compound specs, lot results): use `query_kg` to pull KG facts directly.
- When two sources disagree on a specification or result: use `check_contradictions` before advising.
- For figures or chromatograms referenced in documents: use `fetch_original_document` with `format="pdf_pages"` to retrieve the image directly.

## Output conventions

- For numerical data: include mean, range, and flag any out-of-spec values explicitly.
- For method validation: cite the ICH guideline or pharmacopeial chapter, then the project-specific SOP.
- For contradictions: present both sources, their confidence tiers, and a recommended resolution path.
- Do not assert "pass" or "fail" without citing a specification limit with a source ID.
