"""Dynamic loader for per-source extractor modules.

Each extractor module registered in `extraction_registry.extractor_module`
must expose a top-level callable:

    def extract(result: dict, ctx: ExtractionContext) -> list[FactDraft]: ...

Where `ExtractionContext` and `FactDraft` are the dataclasses defined in
`services.projectors.tool_result_extractor.main`. The contract is import-time
duck-typed so an extractor can live in any package without taking an
intra-repo dependency on the projector (Phase 1+ extractors will land in
`services/projectors/fact_extractor/<source>.py` or similar).

Phase 0 ships with NO registered extractors — the registry is empty and
this loader is exercised only by unit tests. Phase 1+ wires real extractors.
"""

from __future__ import annotations

import importlib
import threading
from types import ModuleType

_cache: dict[str, ModuleType] = {}
_cache_lock = threading.Lock()


def load_extractor(module_path: str) -> ModuleType:
    """Import (and cache) the named module.

    Raises:
        ImportError: if the module cannot be imported.
        AttributeError: if the module does not expose a top-level
            `extract(result, ctx) -> list[FactDraft]` callable.

    The cache is process-local and intentionally never evicts entries —
    extractor modules are pure-Python functions and re-importing them on
    every event would be a performance footgun. Use `clear_cache()` only
    in tests; never in production.
    """
    with _cache_lock:
        cached = _cache.get(module_path)
        if cached is not None:
            return cached
        module = importlib.import_module(module_path)
        if not hasattr(module, "extract"):
            raise AttributeError(
                f"{module_path} does not expose `extract(result, ctx)`"
            )
        _cache[module_path] = module
        return module


def clear_cache() -> None:
    """For tests; never call in production."""
    with _cache_lock:
        _cache.clear()
