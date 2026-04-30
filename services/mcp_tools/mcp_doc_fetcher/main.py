"""mcp-doc-fetcher — fidelity-preserving original-document access.

Endpoints: POST /fetch, /pdf_pages, /byte_offset_to_page. Schemes wired:
file://, http://, https://. Stubbed (501): s3://, smb://, sharepoint://.

After PR-7 split: main.py owns the FastAPI app + endpoint handlers;
validators.py owns URI / scheme / SSRF validation + Pydantic IO models;
fetchers.py owns per-scheme transports + PDF helpers. The trailing ``_*``
aliases re-export private helpers consumed by
``tests/unit/test_mcp_doc_fetcher.py`` so the split kept the
``services.mcp_tools.mcp_doc_fetcher.main`` import surface unchanged.
"""

from __future__ import annotations

import base64
import logging
from typing import Annotated

# httpx is imported here (not just in fetchers.py) because the test suite
# monkey-patches ``services.mcp_tools.mcp_doc_fetcher.main.httpx.Client``.
import httpx  # noqa: F401 — re-exported for tests
from fastapi import Body
from fastapi.responses import JSONResponse

from services.mcp_tools.common.app import create_app
from services.mcp_tools.common.settings import ToolSettings

from .fetchers import (
    build_page_offset_table,
    fetch_file,
    fetch_https,
    get_pdf_bytes,
    offset_to_page,
    render_pdf_pages,
)
from .validators import (
    ALLOWED_SCHEMES,
    DENY_HOSTS,
    MAX_PDF_PAGES,
    WIRED_SCHEMES,
    ByteOffsetToPageIn,
    ByteOffsetToPageOut,
    FetchIn,
    FetchOut,
    PdfPageResult,
    PdfPagesIn,
    PdfPagesOut,
    parse_and_validate_uri,
)


log = logging.getLogger("mcp-doc-fetcher")
settings = ToolSettings()


app = create_app(
    name="mcp-doc-fetcher",
    version="0.1.0",
    log_level=settings.log_level,
    required_scope="mcp_doc_fetcher:fetch",
)


def _not_implemented_for(scheme: str) -> JSONResponse:
    """Standard 501 body for an allowed-but-not-yet-wired URI scheme."""
    return JSONResponse(
        status_code=501,
        content={
            "error": "not_implemented",
            "detail": (
                f"URI scheme {scheme!r} is not yet wired in B.1. "
                "Phase F adds smb/sharepoint/s3 providers."
            ),
        },
    )


@app.post("/fetch", response_model=FetchOut, tags=["fetch"])
async def fetch(req: Annotated[FetchIn, Body(...)]) -> FetchOut:
    """Fetch the raw bytes of a document by URI."""
    parsed = parse_and_validate_uri(req.uri)
    scheme = parsed.scheme.lower()
    if scheme not in WIRED_SCHEMES:
        return _not_implemented_for(scheme)
    try:
        if scheme == "file":
            data, content_type = fetch_file(parsed, req.max_bytes)
        else:  # http / https
            data, content_type = fetch_https(parsed, req.uri, req.max_bytes)
    except ValueError:
        raise
    except Exception as exc:
        # Surface transport errors as 400 (create_app converts ValueError → 400).
        raise ValueError(f"fetch failed: {exc}") from exc
    return FetchOut(
        content_type=content_type,
        base64_bytes=base64.b64encode(data).decode("ascii"),
        byte_count=len(data),
    )


@app.post("/pdf_pages", response_model=PdfPagesOut, tags=["pdf"])
async def pdf_pages(req: Annotated[PdfPagesIn, Body(...)]) -> PdfPagesOut:
    """Render specific pages of a PDF to base64 PNGs (text-extract fallback)."""
    parsed = parse_and_validate_uri(req.uri)
    scheme = parsed.scheme.lower()
    if scheme not in WIRED_SCHEMES:
        return _not_implemented_for(scheme)
    try:
        pdf_bytes = get_pdf_bytes(req.uri, parsed)
    except ValueError:
        raise
    except Exception as exc:
        raise ValueError(f"fetch failed: {exc}") from exc
    raw_results, warning = render_pdf_pages(
        pdf_bytes, req.pages, max_pdf_pages=MAX_PDF_PAGES
    )
    return PdfPagesOut(
        pages=[PdfPageResult(**r) for r in raw_results], warning=warning
    )


@app.post("/byte_offset_to_page", response_model=ByteOffsetToPageOut, tags=["pdf"])
async def byte_offset_to_page(
    req: Annotated[ByteOffsetToPageIn, Body(...)],
) -> ByteOffsetToPageOut:
    """Map PDF byte offsets to 1-indexed page numbers.

    Used by the contextual_chunker projector for canonical chunk-to-page mapping.
    """
    parsed = parse_and_validate_uri(req.uri)
    scheme = parsed.scheme.lower()
    if scheme not in WIRED_SCHEMES:
        return _not_implemented_for(scheme)

    try:
        pdf_bytes = get_pdf_bytes(req.uri, parsed)
    except ValueError:
        raise
    except Exception as exc:
        raise ValueError(f"fetch failed: {exc}") from exc

    warning: str | None = None
    try:
        page_starts = build_page_offset_table(pdf_bytes)
    except Exception as exc:
        log.warning("byte_offset_to_page: could not build page table: %s", exc)
        warning = (
            f"Could not build canonical page offset table ({exc}); "
            "returning heuristic 1-indexed page numbers."
        )
        page_starts = [0, len(pdf_bytes)]

    pages = [offset_to_page(off, page_starts) for off in req.byte_offsets]
    return ByteOffsetToPageOut(pages=pages, warning=warning)


# --------------------------------------------------------------------------
# Backward-compatible private aliases (test imports rely on these)
# --------------------------------------------------------------------------
_parse_and_validate_uri = parse_and_validate_uri
_fetch_file = fetch_file
_fetch_https = fetch_https
_get_pdf_bytes = get_pdf_bytes
_build_page_offset_table = build_page_offset_table
_offset_to_page = offset_to_page
_ALLOWED_SCHEMES = ALLOWED_SCHEMES
_WIRED_SCHEMES = WIRED_SCHEMES
_DENY_HOSTS = DENY_HOSTS


if __name__ == "__main__":
    import uvicorn

    uvicorn.run(
        "services.mcp_tools.mcp_doc_fetcher.main:app",
        host=settings.host,
        port=settings.port,
        log_level=settings.log_level.lower(),
    )
