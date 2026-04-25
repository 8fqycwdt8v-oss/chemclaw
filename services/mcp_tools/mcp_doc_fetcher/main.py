"""mcp-doc-fetcher — fidelity-preserving original-document access.

Endpoints:
  POST /fetch      — fetch raw bytes of a document by URI
  POST /pdf_pages  — render specific pages of a PDF to base64 PNG

Supported URI schemes (Phase B.1):
  file://   — local filesystem  [WIRED]
  https://  — HTTPS download    [WIRED]
  http://   — HTTP download     [WIRED]
  s3://     — S3-compatible     [STUBBED — returns 501]
  smb://    — SMB/CIFS share    [STUBBED — returns 501]
  sharepoint:// — SharePoint    [STUBBED — returns 501]

Security:
  - URI scheme allowlist enforced before any I/O.
  - max_bytes ceiling (default 25 MB, hard cap 100 MB).
  - Deny-list for hosts configurable via MCP_DOC_FETCHER_DENY_HOSTS.
  - Runs as UID 1001; no-new-privileges in compose.
"""

from __future__ import annotations

import base64
import logging
import os
import urllib.parse
from pathlib import Path
from typing import Annotated

import httpx
from fastapi import Body
from fastapi.responses import JSONResponse
from pydantic import BaseModel, Field, field_validator

from services.mcp_tools.common.app import create_app
from services.mcp_tools.common.settings import ToolSettings

log = logging.getLogger("mcp-doc-fetcher")
settings = ToolSettings()

# --------------------------------------------------------------------------
# Configuration
# --------------------------------------------------------------------------

_ALLOWED_SCHEMES = frozenset({"file", "http", "https", "s3", "smb", "sharepoint"})
_WIRED_SCHEMES = frozenset({"file", "http", "https"})
_HARD_MAX_BYTES = 100_000_000   # 100 MB absolute ceiling
_DEFAULT_MAX_BYTES = 25_000_000  # 25 MB default
_MAX_PDF_PAGES = 1000
_MAX_PDF_PAGES_PER_REQUEST = 50

# Deny list — comma-separated hostnames from env. Prevents SSRF to internal services.
_RAW_DENY = os.environ.get("MCP_DOC_FETCHER_DENY_HOSTS", "")
_DENY_HOSTS: frozenset[str] = frozenset(
    h.strip().lower() for h in _RAW_DENY.split(",") if h.strip()
)

# --------------------------------------------------------------------------
# App
# --------------------------------------------------------------------------

app = create_app(
    name="mcp-doc-fetcher",
    version="0.1.0",
    log_level=settings.log_level,
)

# --------------------------------------------------------------------------
# Helpers
# --------------------------------------------------------------------------


def _parse_and_validate_uri(uri: str) -> urllib.parse.ParseResult:
    """Parse URI and enforce scheme allowlist + deny-list. Raises ValueError."""
    if not uri or not uri.strip():
        raise ValueError("uri must be a non-empty string")

    parsed = urllib.parse.urlparse(uri)
    scheme = parsed.scheme.lower()

    if scheme not in _ALLOWED_SCHEMES:
        raise ValueError(
            f"URI scheme {scheme!r} is not in the allowed set "
            f"{sorted(_ALLOWED_SCHEMES)}"
        )

    # Check deny list for network schemes.
    if scheme in ("http", "https", "smb", "sharepoint", "s3"):
        host = parsed.hostname or ""
        if host.lower() in _DENY_HOSTS:
            raise ValueError(f"host {host!r} is in the deny list")

    return parsed


def _fetch_file(parsed: urllib.parse.ParseResult, max_bytes: int) -> tuple[bytes, str]:
    """Fetch a local file. Returns (bytes, content_type)."""
    # urllib.parse.urlparse("file:///path/to/file") → path=/path/to/file
    path = Path(urllib.parse.unquote(parsed.netloc + parsed.path))
    if not path.exists():
        raise ValueError(f"file not found: {path}")
    if not path.is_file():
        raise ValueError(f"path is not a regular file: {path}")

    size = path.stat().st_size
    if size > max_bytes:
        raise ValueError(
            f"file size {size} bytes exceeds max_bytes limit {max_bytes}"
        )

    data = path.read_bytes()
    # Rudimentary content-type by extension.
    suffix = path.suffix.lower()
    ct_map = {
        ".pdf": "application/pdf",
        ".docx": "application/vnd.openxmlformats-officedocument.wordprocessingml.document",
        ".pptx": "application/vnd.openxmlformats-officedocument.presentationml.presentation",
        ".xlsx": "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet",
        ".txt": "text/plain",
        ".md": "text/markdown",
        ".csv": "text/csv",
        ".png": "image/png",
        ".jpg": "image/jpeg",
        ".jpeg": "image/jpeg",
    }
    content_type = ct_map.get(suffix, "application/octet-stream")
    return data, content_type


def _fetch_https(parsed: urllib.parse.ParseResult, uri: str, max_bytes: int) -> tuple[bytes, str]:
    """Fetch via HTTP/HTTPS. Returns (bytes, content_type)."""
    # Use streaming to enforce max_bytes without loading full response.
    headers: dict[str, str] = {"User-Agent": "ChemClaw-DocFetcher/0.1"}
    with httpx.Client(follow_redirects=True, timeout=30) as client:
        with client.stream("GET", uri, headers=headers) as response:
            if response.status_code >= 400:
                raise ValueError(
                    f"HTTP {response.status_code} fetching URI"
                )
            content_type = response.headers.get("content-type", "application/octet-stream")
            # Strip parameters from content-type.
            content_type = content_type.split(";")[0].strip()

            chunks: list[bytes] = []
            total = 0
            for chunk in response.iter_bytes(chunk_size=65536):
                total += len(chunk)
                if total > max_bytes:
                    raise ValueError(
                        f"response size exceeds max_bytes limit {max_bytes}"
                    )
                chunks.append(chunk)
    return b"".join(chunks), content_type


# --------------------------------------------------------------------------
# /fetch — raw bytes
# --------------------------------------------------------------------------


class FetchIn(BaseModel):
    uri: str = Field(min_length=1, max_length=4096)
    max_bytes: int = Field(default=_DEFAULT_MAX_BYTES, ge=1, le=_HARD_MAX_BYTES)

    @field_validator("uri")
    @classmethod
    def uri_scheme_allowed(cls, v: str) -> str:
        _parse_and_validate_uri(v)  # raises ValueError on bad scheme/host
        return v


class FetchOut(BaseModel):
    content_type: str
    base64_bytes: str
    byte_count: int


@app.post("/fetch", response_model=FetchOut, tags=["fetch"])
async def fetch(req: Annotated[FetchIn, Body(...)]) -> FetchOut:
    """Fetch the raw bytes of a document by URI.

    Supports: file://, http://, https://
    Stubbed (501): s3://, smb://, sharepoint://
    """
    parsed = _parse_and_validate_uri(req.uri)
    scheme = parsed.scheme.lower()

    if scheme not in _WIRED_SCHEMES:
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

    try:
        if scheme == "file":
            data, content_type = _fetch_file(parsed, req.max_bytes)
        else:  # http / https
            data, content_type = _fetch_https(parsed, req.uri, req.max_bytes)
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


# --------------------------------------------------------------------------
# /pdf_pages — render PDF pages to base64 PNG
# --------------------------------------------------------------------------


class PdfPagesIn(BaseModel):
    uri: str = Field(min_length=1, max_length=4096)
    pages: list[int] = Field(min_length=1, max_length=_MAX_PDF_PAGES_PER_REQUEST)

    @field_validator("uri")
    @classmethod
    def uri_scheme_allowed(cls, v: str) -> str:
        _parse_and_validate_uri(v)
        return v

    @field_validator("pages")
    @classmethod
    def pages_positive(cls, v: list[int]) -> list[int]:
        if any(p < 0 for p in v):
            raise ValueError("page indices must be non-negative (0-based)")
        return v


class PdfPageResult(BaseModel):
    page: int
    base64_png: str
    width: int
    height: int


class PdfPagesOut(BaseModel):
    pages: list[PdfPageResult]
    warning: str | None = None


def _get_pdf_bytes(uri: str, parsed: urllib.parse.ParseResult) -> bytes:
    """Fetch PDF bytes regardless of scheme."""
    scheme = parsed.scheme.lower()
    if scheme not in _WIRED_SCHEMES:
        raise ValueError(
            f"URI scheme {scheme!r} is not yet wired in B.1"
        )
    if scheme == "file":
        raw, _ = _fetch_file(parsed, _HARD_MAX_BYTES)
    else:
        raw, _ = _fetch_https(parsed, uri, _HARD_MAX_BYTES)
    return raw


@app.post("/pdf_pages", response_model=PdfPagesOut, tags=["pdf"])
async def pdf_pages(req: Annotated[PdfPagesIn, Body(...)]) -> PdfPagesOut:
    """Render specific pages of a PDF to base64 PNGs.

    Falls back to text extraction via pypdf if pdf2image/poppler is
    unavailable at runtime. In that case, base64_png contains the page
    text encoded as UTF-8 and a warning is set.
    """
    # Validate scheme first.
    parsed = _parse_and_validate_uri(req.uri)
    scheme = parsed.scheme.lower()
    if scheme not in _WIRED_SCHEMES:
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

    # Fetch the PDF bytes.
    try:
        pdf_bytes = _get_pdf_bytes(req.uri, parsed)
    except ValueError:
        raise
    except Exception as exc:
        raise ValueError(f"fetch failed: {exc}") from exc

    # Validate page count with pypdf.
    import io

    try:
        import pypdf

        reader = pypdf.PdfReader(io.BytesIO(pdf_bytes))
        total_pages = len(reader.pages)
        if total_pages > _MAX_PDF_PAGES:
            raise ValueError(
                f"PDF has {total_pages} pages; limit is {_MAX_PDF_PAGES}"
            )
        # Validate requested indices.
        out_of_range = [p for p in req.pages if p >= total_pages]
        if out_of_range:
            raise ValueError(
                f"Page indices {out_of_range} are out of range "
                f"(PDF has {total_pages} pages, 0-indexed)"
            )
    except ImportError:
        raise ValueError("pypdf is not installed; cannot process PDF pages")

    # Try pdf2image for PNG rendering; fall back to pypdf text extraction.
    try:
        from pdf2image import convert_from_bytes  # type: ignore[import-untyped]
        import PIL.Image  # type: ignore[import-untyped]

        images = convert_from_bytes(
            pdf_bytes,
            first_page=min(req.pages) + 1,   # pdf2image is 1-indexed
            last_page=max(req.pages) + 1,
            dpi=150,
        )
        # Build a mapping from 0-based page index → PIL image.
        # convert_from_bytes returns pages in order from first_page to last_page.
        min_page = min(req.pages)
        page_map = {min_page + i: img for i, img in enumerate(images)}

        results: list[PdfPageResult] = []
        for p in req.pages:
            img = page_map.get(p)
            if img is None:
                continue
            buf = io.BytesIO()
            img.save(buf, format="PNG")
            b64 = base64.b64encode(buf.getvalue()).decode("ascii")
            results.append(
                PdfPageResult(page=p, base64_png=b64, width=img.width, height=img.height)
            )
        return PdfPagesOut(pages=results)

    except ImportError:
        # pdf2image / poppler not available — fall back to text extraction.
        log.warning(
            "pdf2image is not available; falling back to pypdf text extraction"
        )
        results = []
        for p in req.pages:
            text = reader.pages[p].extract_text() or ""
            b64 = base64.b64encode(text.encode("utf-8")).decode("ascii")
            results.append(
                PdfPageResult(page=p, base64_png=b64, width=0, height=0)
            )
        return PdfPagesOut(
            pages=results,
            warning=(
                "pdf2image/poppler is not installed; returning UTF-8 text "
                "encoded as base64 instead of PNG images. "
                "Install poppler and pdf2image for visual rendering."
            ),
        )


# --------------------------------------------------------------------------
# Entry point (local dev)
# --------------------------------------------------------------------------

if __name__ == "__main__":
    import uvicorn

    uvicorn.run(
        "services.mcp_tools.mcp_doc_fetcher.main:app",
        host=settings.host,
        port=settings.port,
        log_level=settings.log_level.lower(),
    )
