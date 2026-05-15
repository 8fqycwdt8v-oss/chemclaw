"""Per-source fact extractors for the Universal Knowledge Accumulation
pipeline (Phase 1+).

Each module in this package exposes:

    def extract(result: dict, ctx: ExtractionContext) -> list[FactDraft]: ...

…where `ExtractionContext` and `FactDraft` are imported from the
`tool_result_extractor` projector (Phase 0). The shared dispatching
projector resolves the appropriate module via the `extraction_registry`
table and invokes the extractor with the redacted tool result + the
invocation context (user, project, tool args, invocation_id, duration).

Extractors are pure functions: they MUST NOT touch the DB, MUST NOT
raise on malformed input (return [] and log), and MUST NOT depend on
network / disk. All persistence + event emission happens in the
dispatching projector inside the work_conn transaction so a single
failed extractor doesn't poison the projection_acks chain.
"""
