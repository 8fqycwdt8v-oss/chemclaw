"""URL / scheme / SSRF validators + Pydantic IO models for mcp-doc-fetcher.

This is the security focal point of the service. Centralising the URL,
scheme, and SSRF guards here lets reviews concentrate on a single ~150-LOC
surface and makes it straightforward to lift into
``services/mcp_tools/common/network_safety.py`` when a second
network-fetching MCP comes online. The Pydantic request/response models
live here too because each ``uri`` field's validator dispatches through
``parse_and_validate_uri`` — they share the validation cohesion.

Defenses:
  - URI scheme allowlist (``ALLOWED_SCHEMES``).
  - file:// jail under ``FILE_ROOTS`` (default empty → file:// disabled).
  - Host allow-list (``ALLOW_HOSTS``) + deny-list (``DENY_HOSTS``).
  - Private/loopback/link-local network block (``BLOCKED_NETWORKS``)
    with explicit allow-list override for intranet ELN/LIMS adapters
    that legitimately resolve to RFC1918.
  - IPv4-mapped IPv6 normalisation so ``::ffff:10.0.0.1`` is correctly
    matched against the IPv4 RFC1918 networks (defensive — see PR-0
    SSRF hotfix).

Split from main.py during PR-7 (Python God-file split).
"""

from __future__ import annotations

import ipaddress
import os
import socket
import urllib.parse
from pathlib import Path

from pydantic import BaseModel, Field, field_validator


# --------------------------------------------------------------------------
# Configuration constants
# --------------------------------------------------------------------------
ALLOWED_SCHEMES = frozenset({"file", "http", "https", "s3", "smb", "sharepoint"})
WIRED_SCHEMES = frozenset({"file", "http", "https"})
HARD_MAX_BYTES = 100_000_000   # 100 MB absolute ceiling
DEFAULT_MAX_BYTES = 25_000_000  # 25 MB default
MAX_PDF_PAGES = 1000
MAX_PDF_PAGES_PER_REQUEST = 50
MAX_REDIRECTS = 5

# Hostname allow-list. If non-empty, only these hosts may be fetched.
_RAW_ALLOW = os.environ.get("MCP_DOC_FETCHER_ALLOW_HOSTS", "")
ALLOW_HOSTS: frozenset[str] = frozenset(
    h.strip().lower() for h in _RAW_ALLOW.split(",") if h.strip()
)

# `file://` jail. Default empty → all `file://` reads refused so a fresh
# deploy is safe-by-default. Local dev opts in via
# MCP_DOC_FETCHER_FILE_ROOTS=/tmp:/data .
_RAW_FILE_ROOTS = os.environ.get("MCP_DOC_FETCHER_FILE_ROOTS", "")
FILE_ROOTS: tuple[Path, ...] = tuple(
    Path(p).resolve()
    for p in _RAW_FILE_ROOTS.split(":")
    if p.strip()
)

# Hostname deny-list (defense-in-depth on top of ALLOW_HOSTS).
_RAW_DENY = os.environ.get("MCP_DOC_FETCHER_DENY_HOSTS", "")
DENY_HOSTS: frozenset[str] = frozenset(
    h.strip().lower() for h in _RAW_DENY.split(",") if h.strip()
)

# Block fetches that resolve to these networks even if the hostname looks fine.
# Cloud metadata is the highest-impact target.
BLOCKED_NETWORKS = (
    ipaddress.ip_network("169.254.0.0/16"),     # link-local incl. cloud metadata 169.254.169.254
    ipaddress.ip_network("127.0.0.0/8"),        # loopback
    ipaddress.ip_network("10.0.0.0/8"),         # RFC1918
    ipaddress.ip_network("172.16.0.0/12"),      # RFC1918
    ipaddress.ip_network("192.168.0.0/16"),     # RFC1918
    ipaddress.ip_network("0.0.0.0/8"),          # "this network"
    ipaddress.ip_network("100.64.0.0/10"),      # CGNAT / shared address space (RFC 6598)
    ipaddress.ip_network("224.0.0.0/4"),        # IPv4 multicast (RFC 5771)
    ipaddress.ip_network("255.255.255.255/32"), # broadcast
    ipaddress.ip_network("198.18.0.0/15"),      # IETF benchmarking (RFC 2544)
    ipaddress.ip_network("192.0.0.0/24"),       # IETF protocol assignments (RFC 6890)
    ipaddress.ip_network("::1/128"),            # IPv6 loopback
    ipaddress.ip_network("::/128"),             # IPv6 unspecified
    ipaddress.ip_network("fe80::/10"),          # IPv6 link-local
    ipaddress.ip_network("fc00::/7"),           # IPv6 unique local
    ipaddress.ip_network("ff00::/8"),           # IPv6 multicast
)

# IPv6 NAT64 well-known prefix (RFC 6052 §2.1). The lower 32 bits carry the
# embedded IPv4 in the same way as ``::ffff:0:0/96``, but the stdlib
# ``ipv4_mapped`` helper does not normalise it. ``ip_is_blocked`` extracts
# the IPv4 explicitly for membership against ``BLOCKED_NETWORKS``.
_NAT64_WELL_KNOWN = ipaddress.ip_network("64:ff9b::/96")


# --------------------------------------------------------------------------
# Helpers
# --------------------------------------------------------------------------
def is_under(p: Path, root: Path) -> bool:
    """True iff ``p`` is contained in ``root``. Robust replacement for
    ``Path.is_relative_to`` (which is 3.9+) so callers don't depend on
    a specific Python version."""
    try:
        p.relative_to(root)
        return True
    except ValueError:
        return False


def _embedded_ipv4(addr: ipaddress.IPv6Address) -> ipaddress.IPv4Address | None:
    """Return the IPv4 address tunnelled inside ``addr`` if any.

    Covers four IPv4-in-IPv6 encodings that have all been used to bypass
    SSRF allow/deny lists:

    - IPv4-mapped (``::ffff:0:0/96``) via ``IPv6Address.ipv4_mapped``.
    - 6to4 (``2002::/16`` — RFC 3056) via ``IPv6Address.sixtofour``.
    - Teredo (``2001::/32`` — RFC 4380) via ``IPv6Address.teredo``;
      the second tuple element is the client's IPv4.
    - NAT64 well-known prefix (``64:ff9b::/96`` — RFC 6052) — extract
      the lower 32 bits manually since the stdlib has no helper.
    """
    if addr.ipv4_mapped is not None:
        return addr.ipv4_mapped
    if addr.sixtofour is not None:
        return addr.sixtofour
    teredo = addr.teredo
    if teredo is not None:
        return teredo[1]
    if addr in _NAT64_WELL_KNOWN:
        return ipaddress.IPv4Address(int(addr) & 0xFFFFFFFF)
    return None


def ip_is_blocked(ip_str: str) -> bool:
    """True iff ``ip_str`` parses to an IP address inside ``BLOCKED_NETWORKS``.

    Normalises IPv4-mapped, 6to4, Teredo, and NAT64 IPv6 addresses to
    their tunnelled IPv4 form before the membership check so an attacker
    can't bypass the RFC1918 / loopback / metadata block by wrapping an
    IPv4 destination inside one of those IPv6 transition mechanisms.
    """
    try:
        addr = ipaddress.ip_address(ip_str)
    except ValueError:
        return True  # not a valid IP — fail closed
    if isinstance(addr, ipaddress.IPv6Address):
        v4 = _embedded_ipv4(addr)
        if v4 is not None:
            # Check the embedded IPv4 first (the actual destination once the
            # OS unwraps the transition encoding) and the raw IPv6 second
            # (so e.g. 2002::/16 itself can also be denied via BLOCKED_NETWORKS).
            if any(v4 in net for net in BLOCKED_NETWORKS if isinstance(net, ipaddress.IPv4Network)):
                return True
    return any(addr in net for net in BLOCKED_NETWORKS)


def validate_network_host(host: str) -> list[str]:
    """Enforce allowlist + denylist + private-IP block on a hostname.

    Raises ``ValueError`` if the host is not safe to fetch from. If
    ``ALLOW_HOSTS`` is set, the host MUST be in it. Resolved IPs are
    checked against ``BLOCKED_NETWORKS`` — but if the host is explicitly
    allow-listed, we accept the resolution as intentional (e.g. internal
    ELN at 10.x).

    Returns the list of validated IP strings (for the caller to pin the
    actual TCP connect to one of these, closing the DNS-rebinding TOCTOU
    where the resolver returns a public IP at validate time and a
    private IP at connect time). Empty list when the host is itself a
    literal IP and was accepted.
    """
    h = (host or "").lower()
    if not h:
        raise ValueError("host is empty")
    if h in DENY_HOSTS:
        raise ValueError(f"host {host!r} is in the deny list")
    in_allowlist = (not ALLOW_HOSTS) or (h in ALLOW_HOSTS)
    if ALLOW_HOSTS and not in_allowlist:
        raise ValueError(f"host {host!r} is not in the allow list")

    # If the host is itself a literal IP, check it directly.
    try:
        if ip_is_blocked(host):
            if not in_allowlist or not ALLOW_HOSTS:
                # Refuse: hostname looked like an IP and lands in a blocked range.
                raise ValueError(f"host {host!r} resolves to a blocked network")
        # Literal IP: caller can use it directly; nothing to pin.
        return [host]
    except ValueError:
        pass  # not a literal IP; resolve below

    # Resolve and check every returned address.
    try:
        infos = socket.getaddrinfo(h, None)
    except socket.gaierror as exc:
        raise ValueError(f"host {host!r} did not resolve: {exc}") from exc

    validated: list[str] = []
    seen: set[str] = set()
    for info in infos:
        addr = info[4][0]
        if ip_is_blocked(addr):
            if not ALLOW_HOSTS or h not in ALLOW_HOSTS:
                raise ValueError(
                    f"host {host!r} resolves to blocked network {addr}"
                )
        if addr not in seen:
            seen.add(addr)
            validated.append(addr)
    return validated


def parse_and_validate_uri(uri: str) -> urllib.parse.ParseResult:
    """Parse URI and enforce scheme allowlist + host validation.
    Raises ``ValueError`` on rejection."""
    if not uri or not uri.strip():
        raise ValueError("uri must be a non-empty string")

    parsed = urllib.parse.urlparse(uri)
    scheme = parsed.scheme.lower()

    if scheme not in ALLOWED_SCHEMES:
        raise ValueError(
            f"URI scheme {scheme!r} is not in the allowed set "
            f"{sorted(ALLOWED_SCHEMES)}"
        )

    # Allow/deny + private-IP enforcement for network schemes.
    if scheme in ("http", "https", "smb", "sharepoint", "s3"):
        host = parsed.hostname or ""
        validate_network_host(host)

    return parsed


# --------------------------------------------------------------------------
# Pydantic IO models
# --------------------------------------------------------------------------
class FetchIn(BaseModel):
    uri: str = Field(min_length=1, max_length=4096)
    max_bytes: int = Field(default=DEFAULT_MAX_BYTES, ge=1, le=HARD_MAX_BYTES)

    @field_validator("uri")
    @classmethod
    def uri_scheme_allowed(cls, v: str) -> str:
        parse_and_validate_uri(v)  # raises ValueError on bad scheme/host
        return v


class FetchOut(BaseModel):
    content_type: str
    base64_bytes: str
    byte_count: int


class PdfPagesIn(BaseModel):
    uri: str = Field(min_length=1, max_length=4096)
    pages: list[int] = Field(min_length=1, max_length=MAX_PDF_PAGES_PER_REQUEST)

    @field_validator("uri")
    @classmethod
    def uri_scheme_allowed(cls, v: str) -> str:
        parse_and_validate_uri(v)
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


class ByteOffsetToPageIn(BaseModel):
    uri: str = Field(min_length=1, max_length=4096)
    byte_offsets: list[int] = Field(
        min_length=1, max_length=10_000,
        description="List of byte offsets (0-based) to map to page numbers.",
    )

    @field_validator("uri")
    @classmethod
    def uri_scheme_allowed(cls, v: str) -> str:
        parse_and_validate_uri(v)
        return v

    @field_validator("byte_offsets")
    @classmethod
    def offsets_nonnegative(cls, v: list[int]) -> list[int]:
        if any(o < 0 for o in v):
            raise ValueError("byte_offsets must all be non-negative")
        return v


class ByteOffsetToPageOut(BaseModel):
    """1-indexed page numbers (0 = before first page, -1 = beyond last)."""

    pages: list[int]
    warning: str | None = None
