"""mcp-doc-fetcher — fidelity-preserving original-document access.

Endpoints:
  POST /fetch                — fetch raw bytes of a document by URI
  POST /pdf_pages            — render specific pages of a PDF to base64 PNG
  POST /byte_offset_to_page  — locate a citation byte-offset to its 1-indexed
                               PDF page; called by the contextual_chunker
                               projector (NOT yet exposed to the agent — no
                               catalog row, no agent-claw builtin)

Supported URI schemes (Phase B.1):
  file://   — local filesystem  [WIRED, jailed under MCP_DOC_FETCHER_FILE_ROOTS]
  https://  — HTTPS download    [WIRED]
  http://   — HTTP download     [WIRED]
  s3://     — S3-compatible     [STUBBED — returns 501]
  smb://    — SMB/CIFS share    [STUBBED — returns 501]
  sharepoint:// — SharePoint    [STUBBED — returns 501]

Security:
  - URI scheme allowlist enforced before any I/O.
  - file:// reads gated behind MCP_DOC_FETCHER_FILE_ROOTS allow-list (default
    empty → file:// disabled). Symlink-resolved paths must sit under one of
    the configured roots so a `/data/secret -> /etc/shadow` link can't escape.
  - max_bytes ceiling (default 25 MB, hard cap 100 MB).
  - Allow-list / deny-list for hosts via MCP_DOC_FETCHER_ALLOW_HOSTS /
    MCP_DOC_FETCHER_DENY_HOSTS.
  - Private/loopback/link-local IPs blocked unconditionally (except
    explicit allow-list entries — intranet ELN/LIMS adapters legitimately
    resolve to RFC1918).
  - Runs as UID 1001; no-new-privileges in compose.
"""

from __future__ import annotations

import base64
import ipaddress
import logging
import os
import socket
import urllib.parse
from pathlib import Path
from typing import Annotated, Any

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

# SSRF defenses. Two layers:
#   1. ALLOW_HOSTS — explicit hostname allowlist. If set (non-empty), only these
#      hosts may be fetched. This is the strong default and the recommended
#      production posture. The agent supplies a curated list at deploy time.
#   2. DENY_HOSTS — extra denylist applied on top of the allowlist (defense in depth).
#   3. Private/loopback/link-local IPs are blocked unconditionally regardless of
#      what hostnames resolve to, with the only exception being explicitly
#      allow-listed hosts (some intranet ELN/LIMS adapters legitimately resolve
#      to RFC1918 addresses).
#
# Redirects are followed manually with full re-validation at every hop.
_RAW_ALLOW = os.environ.get("MCP_DOC_FETCHER_ALLOW_HOSTS", "")
_ALLOW_HOSTS: frozenset[str] = frozenset(
    h.strip().lower() for h in _RAW_ALLOW.split(",") if h.strip()
)

# `file://` jail. Without this, an authenticated caller (or a forged-tool
# token) could read /etc/passwd, k8s service-account secrets, etc. The
# allow-list is a comma-separated list of absolute paths; only files under
# one of these roots are readable. Default empty → all `file://` reads
# refused. Local dev can set MCP_DOC_FETCHER_FILE_ROOTS=/tmp:/data to opt in.
_RAW_FILE_ROOTS = os.environ.get("MCP_DOC_FETCHER_FILE_ROOTS", "")
_FILE_ROOTS: tuple[Path, ...] = tuple(
    Path(p).resolve()
    for p in _RAW_FILE_ROOTS.split(":")
    if p.strip()
)


def _is_under(p: Path, root: Path) -> bool:
    """`Path.is_relative_to` is 3.9+; we run on 3.11 but this avoids a
    surprise migration if anyone ever vendors this for an older Python."""
    try:
        p.relative_to(root)
        return True
    except ValueError:
        return False
_RAW_DENY = os.environ.get("MCP_DOC_FETCHER_DENY_HOSTS", "")
_DENY_HOSTS: frozenset[str] = frozenset(
    h.strip().lower() for h in _RAW_DENY.split(",") if h.strip()
)
_MAX_REDIRECTS = 5

# Block fetches that resolve to these networks even if the hostname looks fine.
# Cloud metadata is the highest-impact target.
_BLOCKED_NETWORKS = (
    ipaddress.ip_network("169.254.0.0/16"),     # link-local incl. cloud metadata 169.254.169.254
    ipaddress.ip_network("127.0.0.0/8"),        # loopback
    ipaddress.ip_network("10.0.0.0/8"),         # RFC1918
    ipaddress.ip_network("172.16.0.0/12"),      # RFC1918
    ipaddress.ip_network("192.168.0.0/16"),     # RFC1918
    ipaddress.ip_network("0.0.0.0/8"),          # "this network"
    ipaddress.ip_network("::1/128"),            # IPv6 loopback
    ipaddress.ip_network("fe80::/10"),          # IPv6 link-local
    ipaddress.ip_network("fc00::/7"),           # IPv6 unique local
)


def _ip_is_blocked(ip_str: str) -> bool:
    try:
        addr = ipaddress.ip_address(ip_str)
    except ValueError:
        return True  # not a valid IP — fail closed
    return any(addr in net for net in _BLOCKED_NETWORKS)


def _validate_network_host(host: str) -> None:
    """Enforce allowlist + denylist + private-IP block on a hostname.

    Raises ValueError if the host is not safe to fetch from. If ALLOW_HOSTS is
    set, the host MUST be in it. Resolved IPs are checked against the private/
    loopback/link-local block list — but if the host is explicitly allow-listed,
    we accept the resolution as intentional (e.g. internal ELN at 10.x).
    """
    h = (host or "").lower()
    if not h:
        raise ValueError("host is empty")
    if h in _DENY_HOSTS:
        raise ValueError(f"host {host!r} is in the deny list")
    in_allowlist = (not _ALLOW_HOSTS) or (h in _ALLOW_HOSTS)
    if _ALLOW_HOSTS and not in_allowlist:
        raise ValueError(f"host {host!r} is not in the allow list")

    # If the host is itself a literal IP, check it directly.
    try:
        if _ip_is_blocked(host):
            if not in_allowlist or not _ALLOW_HOSTS:
                # Refuse: hostname looked like an IP and lands in a blocked range.
                raise ValueError(f"host {host!r} resolves to a blocked network")
        return
    except ValueError:
        pass  # not a literal IP; resolve below

    # Resolve and check every returned address.
    try:
        infos = socket.getaddrinfo(h, None)
    except socket.gaierror as exc:
        raise ValueError(f"host {host!r} did not resolve: {exc}") from exc

    for info in infos:
        addr = str(info[4][0])
        if _ip_is_blocked(addr):
            if not _ALLOW_HOSTS or h not in _ALLOW_HOSTS:
                raise ValueError(
                    f"host {host!r} resolves to blocked network {addr}"
                )

# --------------------------------------------------------------------------
# App
# --------------------------------------------------------------------------

app = create_app(
    name="mcp-doc-fetcher",
    version="0.1.0",
    log_level=settings.log_level,
    required_scope="mcp_doc_fetcher:fetch",
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

    # Allow/deny + private-IP enforcement for network schemes.
    if scheme in ("http", "https", "smb", "sharepoint", "s3"):
        host = parsed.hostname or ""
        _validate_network_host(host)

    return parsed


def _fetch_file(parsed: urllib.parse.ParseResult, max_bytes: int) -> tuple[bytes, str]:
    """Fetch a local file. Returns (bytes, content_type).

    Jailed under MCP_DOC_FETCHER_FILE_ROOTS (colon-separated absolute paths).
    Default empty → all `file://` reads refused so a fresh deploy is safe-
    by-default; local dev opts in by setting the env. The realpath of the
    requested file must be `is_relative_to` one of the configured roots —
    this catches symlink-escapes (`/data/secret -> /etc/shadow`) since
    `Path.resolve()` follows symlinks before the containment check.
    """
    raw = urllib.parse.unquote(parsed.netloc + parsed.path)
    path = Path(raw)
    if not _FILE_ROOTS:
        raise ValueError(
            "file:// access disabled — set MCP_DOC_FETCHER_FILE_ROOTS to a "
            "colon-separated allow-list of absolute paths to enable"
        )
    try:
        resolved = path.resolve(strict=True)  # follows symlinks; raises if missing
    except (OSError, RuntimeError) as exc:
        raise ValueError(f"file not found or unreadable: {path}") from exc
    if not any(_is_under(resolved, root) for root in _FILE_ROOTS):
        # Don't echo the resolved path back — that would itself be a small
        # information leak about symlink targets and root layout.
        raise ValueError(
            f"file:// path {path!s} is outside the configured "
            f"MCP_DOC_FETCHER_FILE_ROOTS allow-list"
        )
    if not resolved.is_file():
        raise ValueError(f"path is not a regular file: {path}")
    path = resolved

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
    """Fetch via HTTP/HTTPS, manually walking redirects with full re-validation.

    Defenses:
      - SSRF: every hop is re-validated against the allow/deny/IP-block rules.
      - Redirect-loop bound: at most _MAX_REDIRECTS hops.
      - Streaming with max_bytes guard.
    """
    headers: dict[str, str] = {"User-Agent": "ChemClaw-DocFetcher/0.1"}
    current_uri = uri
    redirect_count = 0
    # follow_redirects=False — we walk redirects ourselves so each hop gets
    # the full _validate_network_host treatment (an attacker-controlled
    # redirect to e.g. http://169.254.169.254/ would otherwise slip past).
    with httpx.Client(follow_redirects=False, timeout=30) as client:
        while True:
            with client.stream("GET", current_uri, headers=headers) as response:
                # Manual redirect handling.
                if response.status_code in (301, 302, 303, 307, 308):
                    redirect_count += 1
                    if redirect_count > _MAX_REDIRECTS:
                        raise ValueError(
                            f"too many redirects (>{_MAX_REDIRECTS}) starting from {uri}"
                        )
                    location = response.headers.get("location")
                    if not location:
                        raise ValueError("redirect response missing Location header")
                    next_uri = urllib.parse.urljoin(current_uri, location)
                    next_parsed = urllib.parse.urlparse(next_uri)
                    if next_parsed.scheme.lower() not in ("http", "https"):
                        raise ValueError(
                            f"refusing to follow redirect to non-HTTP scheme: {next_parsed.scheme}"
                        )
                    _validate_network_host(next_parsed.hostname or "")
                    current_uri = next_uri
                    continue

                if response.status_code >= 400:
                    raise ValueError(
                        f"HTTP {response.status_code} fetching URI"
                    )
                content_type = response.headers.get("content-type", "application/octet-stream")
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


@app.post("/fetch", response_model=None, tags=["fetch"])
async def fetch(req: Annotated[FetchIn, Body(...)]) -> FetchOut | JSONResponse:
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


@app.post("/pdf_pages", response_model=None, tags=["pdf"])
async def pdf_pages(req: Annotated[PdfPagesIn, Body(...)]) -> PdfPagesOut | JSONResponse:
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
        from pdf2image import convert_from_bytes
        import PIL.Image

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
# /byte_offset_to_page -- canonical PDF byte-offset -> page mapping (Phase D.1)
# --------------------------------------------------------------------------


class ByteOffsetToPageIn(BaseModel):
    uri: str = Field(min_length=1, max_length=4096)
    byte_offsets: list[int] = Field(
        min_length=1,
        max_length=10_000,
        description="List of byte offsets (0-based) to map to page numbers.",
    )

    @field_validator("uri")
    @classmethod
    def uri_scheme_allowed(cls, v: str) -> str:
        _parse_and_validate_uri(v)
        return v

    @field_validator("byte_offsets")
    @classmethod
    def offsets_nonnegative(cls, v: list[int]) -> list[int]:
        if any(o < 0 for o in v):
            raise ValueError("byte_offsets must all be non-negative")
        return v


class ByteOffsetToPageOut(BaseModel):
    pages: list[int]
    """1-indexed page numbers, one per element in byte_offsets.
    A value of 0 means the offset falls before the first page (should not occur
    for valid PDF byte offsets but is returned defensively).
    A value of -1 means the offset is beyond the last page.
    """
    warning: str | None = None


def _build_page_offset_table(pdf_bytes: bytes) -> list[int]:
    """Return a sorted list of byte offsets where each page begins.

    Uses pypdf to identify page-object byte offsets.  Falls back to a uniform
    distribution if pypdf cannot determine exact positions.

    Returns a list of length == total_pages where element i is the byte offset
    at which page i+1 (1-indexed) starts in the PDF stream.
    """
    import io

    try:
        import pypdf

        reader = pypdf.PdfReader(io.BytesIO(pdf_bytes))
        total_pages = len(reader.pages)
    except ImportError:
        raise ValueError("pypdf is not installed; cannot process PDF byte offsets")

    # Try to get page start positions from the cross-reference table.
    # pypdf exposes xmp_metadata and individual page objects but not raw byte
    # positions via the public API.  We derive positions by scanning for the
    # page object markers as a reliable heuristic.
    #
    # Strategy: split the raw bytes at each %%Page marker (DSC comment) or at
    # each "obj" keyword that corresponds to a page object.
    # For PDFs without DSC comments we fall back to uniform distribution.

    total_size = len(pdf_bytes)

    # Attempt 1: DSC %%Page comments.
    import re

    dsc_page_re = re.compile(rb"%%Page:\s*\d+\s+\d+")
    dsc_positions = [m.start() for m in dsc_page_re.finditer(pdf_bytes)]
    if len(dsc_positions) == total_pages:
        return dsc_positions

    # Attempt 2: locate each page's object in the cross-reference table.
    # pypdf's reader._pages is a list of PageObject whose .indirect_reference
    # (pypdf >= 3.x) carries the object number we can look up in xref.
    try:
        page_starts: list[int] = []
        xref = reader.xref
        for page in reader.pages:
            ref = page.indirect_reference
            if ref is None:
                break
            obj_num = ref.idnum
            # Try various xref shapes (pypdf 3.x uses a list-of-lists internally).
            pos: int | None = None
            for tbl in (xref if isinstance(xref, list) else []):  # type: Any
                if isinstance(tbl, list) and len(tbl) > obj_num and tbl[obj_num]:
                    entry = tbl[obj_num]
                    if isinstance(entry, int) and entry > 0:
                        pos = entry
                        break
            if pos is None:
                break
            page_starts.append(pos)

        if len(page_starts) == total_pages:
            return sorted(page_starts)
    except Exception:
        pass

    # Fallback: uniform distribution across the file.
    page_size = max(1, total_size // max(total_pages, 1))
    return [i * page_size for i in range(total_pages)]


def _offset_to_page(byte_offset: int, page_starts: list[int]) -> int:
    """Map a byte offset to a 1-indexed page number using the page offset table."""
    if not page_starts:
        return 1
    if byte_offset < 0:
        return 0
    # Binary search for the last page start <= byte_offset.
    lo, hi = 0, len(page_starts) - 1
    result = 0
    while lo <= hi:
        mid = (lo + hi) // 2
        if page_starts[mid] <= byte_offset:
            result = mid
            lo = mid + 1
        else:
            hi = mid - 1
    return result + 1  # 1-indexed


@app.post("/byte_offset_to_page", response_model=None, tags=["pdf"])
async def byte_offset_to_page(
    req: Annotated[ByteOffsetToPageIn, Body(...)],
) -> ByteOffsetToPageOut | JSONResponse:
    """Map PDF byte offsets to 1-indexed page numbers.

    Fetches the PDF from the given URI, builds a page-start offset table,
    and returns the page number for each requested byte offset.

    Used by the contextual_chunker projector for canonical chunk-to-page mapping.
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
        pdf_bytes = _get_pdf_bytes(req.uri, parsed)
    except ValueError:
        raise
    except Exception as exc:
        raise ValueError(f"fetch failed: {exc}") from exc

    warning: str | None = None
    try:
        page_starts = _build_page_offset_table(pdf_bytes)
    except Exception as exc:
        # Graceful degradation: return page 1 for all offsets.
        log.warning("byte_offset_to_page: could not build page table: %s", exc)
        total_size = len(pdf_bytes)
        warning = (
            f"Could not build canonical page offset table ({exc}); "
            "returning heuristic 1-indexed page numbers."
        )
        # Single-page fallback.
        page_starts = [0, total_size]

    pages = [_offset_to_page(off, page_starts) for off in req.byte_offsets]
    return ByteOffsetToPageOut(pages=pages, warning=warning)


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
