"""Per-scheme transport backends for mcp-doc-fetcher.

Holds:
  - ``fetch_file``: jailed local-filesystem reads (``file://``).
  - ``fetch_https``: HTTP(S) downloads with manual redirect re-validation.
  - ``get_pdf_bytes``: scheme-agnostic PDF byte fetch.
  - ``build_page_offset_table`` / ``offset_to_page``: PDF byte-offset →
    page-index helpers used by ``/byte_offset_to_page``.

Validation lives in ``validators.py`` — every public entry point here
calls ``parse_and_validate_uri`` / ``validate_network_host`` before any
I/O.

DNS rebinding (TOCTOU) defense:
    A naive flow ``resolve(host) → validate IPs → httpx.get(host)`` is
    exploitable: the attacker's DNS server returns 1.2.3.4 (public) at
    validate-time and 169.254.169.254 (cloud metadata) at connect-time.
    We close the window by capturing the validated IP list and pinning
    every TCP connect made inside the request scope to that set via a
    thread-local override of ``socket.getaddrinfo``. The override is
    installed only for the duration of one fetch and reverted in a
    ``finally`` so unrelated code paths (other threads, post-fetch
    cleanup) see the unmodified resolver.

Split from main.py during PR-7 (Python God-file split).
"""

from __future__ import annotations

import contextlib
import logging
import socket
import threading
import urllib.parse
from pathlib import Path
from typing import Iterator

import httpx

from .validators import (
    FILE_ROOTS,
    HARD_MAX_BYTES,
    MAX_REDIRECTS,
    WIRED_SCHEMES,
    is_under,
    validate_network_host,
)


log = logging.getLogger("mcp-doc-fetcher.fetchers")


# --------------------------------------------------------------------------
# DNS rebinding mitigation: pin getaddrinfo to a validated IP set
# for the duration of a fetch. Thread-local so concurrent requests
# in the same process don't trample each other's pin set.
# --------------------------------------------------------------------------
_PIN_LOCK = threading.Lock()
_pin_state = threading.local()
_ORIGINAL_GETADDRINFO = socket.getaddrinfo


def _pinned_getaddrinfo(host, port, *args, **kwargs):  # type: ignore[no-untyped-def]
    """Replacement for socket.getaddrinfo that returns ONLY validated IPs
    when the calling thread has installed a pin via ``pin_resolution``.

    For any host not in the pin map, falls through to the original
    resolver — this matters because httpx may also resolve the proxy
    host or do DNS for unrelated calls inside the same thread.
    """
    pinned: dict[str, list[str]] = getattr(_pin_state, "pinned", {}) or {}
    addrs = pinned.get(host.lower() if isinstance(host, str) else host)
    if not addrs:
        return _ORIGINAL_GETADDRINFO(host, port, *args, **kwargs)
    out: list[tuple] = []
    for ip in addrs:
        try:
            ip_addr_info = _ORIGINAL_GETADDRINFO(
                ip, port, *args, **kwargs,
            )
        except socket.gaierror:
            continue
        out.extend(ip_addr_info)
    if not out:
        # Fall closed: if the validated IPs no longer resolve as themselves
        # (shouldn't happen — they're literal IPs), refuse rather than
        # silently fall back to public DNS.
        raise socket.gaierror(
            f"pinned IPs {addrs} for host {host!r} did not yield a usable "
            "addrinfo; refusing to fall back to public resolution"
        )
    return out


@contextlib.contextmanager
def pin_resolution(host: str, validated_ips: list[str]) -> Iterator[None]:
    """Install a thread-local DNS pin for ``host`` → ``validated_ips``.

    The pin is active for the duration of the ``with`` block. Inside,
    every call to ``socket.getaddrinfo(host, ...)`` from this thread
    returns only the validated IPs. The pin is removed on exit so other
    code paths see the standard resolver again.

    The first call also swaps the module-level ``socket.getaddrinfo``;
    this is process-global so it has to be done under a lock to avoid
    a benign race with another thread doing the same swap. The override
    is idempotent — once installed it stays installed (cheap pass-through
    when no pin is set on the calling thread).
    """
    if not validated_ips:
        # Literal-IP path or unresolvable host: nothing to pin.
        yield
        return

    # Install the override the first time we need it (process-global,
    # but the wrapper is a no-op for unpinned threads / hosts).
    with _PIN_LOCK:
        if socket.getaddrinfo is not _pinned_getaddrinfo:
            socket.getaddrinfo = _pinned_getaddrinfo  # type: ignore[assignment]

    pinned: dict[str, list[str]] = getattr(_pin_state, "pinned", None) or {}
    key = host.lower()
    prev = pinned.get(key)
    pinned[key] = list(validated_ips)
    _pin_state.pinned = pinned
    try:
        yield
    finally:
        if prev is None:
            pinned.pop(key, None)
        else:
            pinned[key] = prev
        _pin_state.pinned = pinned


# --------------------------------------------------------------------------
# file:// transport
# --------------------------------------------------------------------------
def fetch_file(parsed: urllib.parse.ParseResult, max_bytes: int) -> tuple[bytes, str]:
    """Fetch a local file. Returns (bytes, content_type).

    Jailed under ``MCP_DOC_FETCHER_FILE_ROOTS`` (colon-separated absolute
    paths). Default empty → all ``file://`` reads refused so a fresh
    deploy is safe-by-default; local dev opts in by setting the env. The
    realpath of the requested file must be ``is_under`` one of the
    configured roots — this catches symlink-escapes
    (``/data/secret -> /etc/shadow``) since ``Path.resolve()`` follows
    symlinks before the containment check.
    """
    raw = urllib.parse.unquote(parsed.netloc + parsed.path)
    path = Path(raw)
    if not FILE_ROOTS:
        raise ValueError(
            "file:// access disabled — set MCP_DOC_FETCHER_FILE_ROOTS to a "
            "colon-separated allow-list of absolute paths to enable"
        )
    try:
        resolved = path.resolve(strict=True)  # follows symlinks; raises if missing
    except (OSError, RuntimeError) as exc:
        raise ValueError(f"file not found or unreadable: {path}") from exc
    if not any(is_under(resolved, root) for root in FILE_ROOTS):
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


# --------------------------------------------------------------------------
# https:// transport
# --------------------------------------------------------------------------
def fetch_https(
    parsed: urllib.parse.ParseResult, uri: str, max_bytes: int
) -> tuple[bytes, str]:
    """Fetch via HTTP/HTTPS, manually walking redirects with full re-validation.

    Defenses:
      - SSRF: every hop is re-validated against the allow/deny/IP-block rules.
      - DNS rebinding: each hop's host is resolved once, the IP set is
        validated, and a thread-local pin forces httpx's underlying socket
        connect to use ONLY those IPs. Without the pin, an attacker-controlled
        DNS server can return a public IP at validate-time and a private/
        loopback IP a few milliseconds later at connect-time — closing the
        TOCTOU window between resolution and connect is the only structural
        defence against rebinding (re-resolving alone doesn't help: a TTL=0
        zone returns whatever the attacker wants on each query).
      - Redirect-loop bound: at most ``MAX_REDIRECTS`` hops.
      - Streaming with max_bytes guard.
    """
    headers: dict[str, str] = {"User-Agent": "ChemClaw-DocFetcher/0.1"}
    current_uri = uri
    current_host = (parsed.hostname or "").lower()
    # Resolve + validate the initial host. validate_network_host returns the
    # IP list that survived the BLOCKED_NETWORKS / allow-list filter; we pin
    # the socket layer to that set for every connect inside this fetch.
    current_pin = validate_network_host(current_host)
    redirect_count = 0
    # follow_redirects=False — we walk redirects ourselves so each hop gets
    # the full validate_network_host treatment (an attacker-controlled
    # redirect to e.g. http://169.254.169.254/ would otherwise slip past).
    with httpx.Client(follow_redirects=False, timeout=30) as client:
        while True:
            with pin_resolution(current_host, current_pin):
                with client.stream("GET", current_uri, headers=headers) as response:
                    # Manual redirect handling.
                    if response.status_code in (301, 302, 303, 307, 308):
                        redirect_count += 1
                        if redirect_count > MAX_REDIRECTS:
                            raise ValueError(
                                f"too many redirects (>{MAX_REDIRECTS}) starting from {uri}"
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
                        next_host = (next_parsed.hostname or "").lower()
                        # Re-validate AND re-resolve at every hop so the
                        # next iteration's pin reflects the current resolver
                        # state (the prior pin is dropped when the
                        # contextmanager exits below).
                        next_pin = validate_network_host(next_host)
                        current_uri = next_uri
                        current_host = next_host
                        current_pin = next_pin
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
# Scheme-agnostic byte fetch
# --------------------------------------------------------------------------
def get_pdf_bytes(uri: str, parsed: urllib.parse.ParseResult) -> bytes:
    """Fetch PDF bytes regardless of scheme."""
    scheme = parsed.scheme.lower()
    if scheme not in WIRED_SCHEMES:
        raise ValueError(
            f"URI scheme {scheme!r} is not yet wired in B.1"
        )
    if scheme == "file":
        raw, _ = fetch_file(parsed, HARD_MAX_BYTES)
    else:
        raw, _ = fetch_https(parsed, uri, HARD_MAX_BYTES)
    return raw


# --------------------------------------------------------------------------
# PDF byte-offset → page-index table
# --------------------------------------------------------------------------
def build_page_offset_table(pdf_bytes: bytes) -> list[int]:
    """Return a sorted list of byte offsets where each page begins.

    Uses pypdf to identify page-object byte offsets. Falls back to a uniform
    distribution if pypdf cannot determine exact positions.

    Returns a list of length == total_pages where element i is the byte
    offset at which page i+1 (1-indexed) starts in the PDF stream.
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
        xref = reader.xref  # type: ignore[attr-defined]
        for page in reader.pages:
            ref = page.indirect_reference  # type: ignore[attr-defined]
            if ref is None:
                break
            obj_num = ref.idnum
            # Try various xref shapes (pypdf 3.x uses a list-of-lists internally).
            pos: int | None = None
            for tbl in (xref if isinstance(xref, list) else []):
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


def offset_to_page(byte_offset: int, page_starts: list[int]) -> int:
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


# --------------------------------------------------------------------------
# PDF page rendering (pdf2image with pypdf text fallback)
# --------------------------------------------------------------------------
def render_pdf_pages(
    pdf_bytes: bytes, pages: list[int], *, max_pdf_pages: int
) -> tuple[list[dict], str | None]:
    """Render specific pages of a PDF to base64 PNGs.

    Returns ``(results, warning)``. Falls back to pypdf text extraction
    if pdf2image / poppler is unavailable; in that case ``base64_png``
    contains the page text encoded as UTF-8 and ``warning`` is set.

    ``results`` is a list of dicts shaped
    ``{"page": int, "base64_png": str, "width": int, "height": int}``.
    """
    import base64
    import io

    try:
        import pypdf
    except ImportError:
        raise ValueError("pypdf is not installed; cannot process PDF pages")

    reader = pypdf.PdfReader(io.BytesIO(pdf_bytes))
    total_pages = len(reader.pages)
    if total_pages > max_pdf_pages:
        raise ValueError(f"PDF has {total_pages} pages; limit is {max_pdf_pages}")
    out_of_range = [p for p in pages if p >= total_pages]
    if out_of_range:
        raise ValueError(
            f"Page indices {out_of_range} are out of range "
            f"(PDF has {total_pages} pages, 0-indexed)"
        )

    try:
        from pdf2image import convert_from_bytes  # type: ignore[import-untyped]
        import PIL.Image  # type: ignore[import-untyped]  # noqa: F401

        images = convert_from_bytes(
            pdf_bytes,
            first_page=min(pages) + 1,   # pdf2image is 1-indexed
            last_page=max(pages) + 1,
            dpi=150,
        )
        min_page = min(pages)
        page_map = {min_page + i: img for i, img in enumerate(images)}

        results: list[dict] = []
        for p in pages:
            img = page_map.get(p)
            if img is None:
                continue
            buf = io.BytesIO()
            img.save(buf, format="PNG")
            b64 = base64.b64encode(buf.getvalue()).decode("ascii")
            results.append(
                {"page": p, "base64_png": b64, "width": img.width, "height": img.height}
            )
        return results, None

    except ImportError:
        log.warning(
            "pdf2image is not available; falling back to pypdf text extraction"
        )
        results = []
        for p in pages:
            text = reader.pages[p].extract_text() or ""
            b64 = base64.b64encode(text.encode("utf-8")).decode("ascii")
            results.append({"page": p, "base64_png": b64, "width": 0, "height": 0})
        return results, (
            "pdf2image/poppler is not installed; returning UTF-8 text "
            "encoded as base64 instead of PNG images. "
            "Install poppler and pdf2image for visual rendering."
        )
