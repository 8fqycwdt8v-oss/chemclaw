"""Parser dispatch: (path, bytes) → (title, markdown, source_type).

Handlers by extension:
  .pdf   → pypdf
  .docx  → python-docx (with defusedxml for defence-in-depth XML parsing)
  .md    → passthrough
  .txt   → passthrough (prefixed with a `# <basename>` heading so the chunker
            has a boundary to anchor on)

Each parser is expected to return a tuple (title, markdown). Unknown
extensions raise `UnsupportedFormatError`.

Security posture:
- PDF: pypdf is pure-Python BSD-3; no subprocess; no network. Safe.
- DOCX: python-docx uses lxml internally; we pre-scan with defusedxml to
  detect XML bombs / external entities BEFORE handing off to python-docx.
  The internal DOCX parts are zip-compressed XML; we inspect the main
  `word/document.xml` for obvious threats.
- All parsers receive a bounded-size file (the caller has already enforced
  `max_file_bytes`).
"""

from __future__ import annotations

import io
import logging
import zipfile
from pathlib import Path

from defusedxml import ElementTree as DefusedET

log = logging.getLogger("doc_ingester.parsers")


class UnsupportedFormatError(ValueError):
    """Raised for file extensions we don't know how to parse."""


class UnsafeDocumentError(ValueError):
    """Raised when the defusedxml pre-scan flags an XML document as unsafe."""


# --------------------------------------------------------------------------
# Source-type inference — aligned with documents.source_type CHECK constraint
# --------------------------------------------------------------------------
_SOURCE_TYPE_RULES: list[tuple[tuple[str, ...], str]] = [
    (("sop",), "SOP"),
    (("validation", "method_validation", "method-validation"), "method_validation"),
    (("report",), "report"),
    (("literature", "paper", "journal"), "literature_summary"),
    (("slide", "presentation", ".pptx"), "presentation"),
    (("sheet", ".xlsx", "spreadsheet"), "spreadsheet"),
]


def infer_source_type(path: Path) -> str:
    needle = f"{path.stem.lower()} {path.suffix.lower()}"
    for keywords, stype in _SOURCE_TYPE_RULES:
        if any(k in needle for k in keywords):
            return stype
    return "other"


# --------------------------------------------------------------------------
# PDF
# --------------------------------------------------------------------------
def _parse_pdf(path: Path) -> tuple[str, str]:
    from pypdf import PdfReader

    reader = PdfReader(str(path))
    # Title fallback: first page's first non-empty line, or filename.
    parts: list[str] = []
    title_candidate = path.stem
    for i, page in enumerate(reader.pages):
        try:
            text = page.extract_text() or ""
        except Exception as exc:  # noqa: BLE001
            log.warning("pdf page %d of %s: extract failed (%s)", i, path, exc)
            continue
        if i == 0:
            for line in text.splitlines():
                line = line.strip()
                if line:
                    title_candidate = line[:200]
                    break
        parts.append(f"## Page {i + 1}\n\n{text}")
    title = _extract_pdf_title(reader) or title_candidate
    markdown = f"# {title}\n\n" + "\n\n".join(parts)
    return title, markdown


def _extract_pdf_title(reader) -> str | None:  # noqa: ANN001 — pypdf private type
    try:
        meta = reader.metadata or {}
        title = (meta.get("/Title") or "").strip()
        return title or None
    except Exception:  # noqa: BLE001
        return None


# --------------------------------------------------------------------------
# DOCX
# --------------------------------------------------------------------------
def _preflight_docx_with_defusedxml(path: Path) -> None:
    """Scan the main document part with defusedxml before python-docx opens it.

    defusedxml raises on XML billion-laughs, external entities, and recursive
    entity expansion. If it parses cleanly here, python-docx's lxml parsing
    is safe for our purposes.
    """
    try:
        with zipfile.ZipFile(path, "r") as z:
            # docx main content part.
            if "word/document.xml" not in z.namelist():
                # Not a classic docx — let python-docx report the real error.
                return
            with z.open("word/document.xml") as f:
                data = f.read()
    except zipfile.BadZipFile as exc:
        raise UnsafeDocumentError(f"{path.name}: not a valid docx (bad zip)") from exc

    try:
        DefusedET.fromstring(data)
    except DefusedET.EntitiesForbidden as exc:
        raise UnsafeDocumentError(f"{path.name}: XML entities forbidden") from exc
    except DefusedET.DTDForbidden as exc:
        raise UnsafeDocumentError(f"{path.name}: XML DTD forbidden") from exc
    except DefusedET.ExternalReferenceForbidden as exc:
        raise UnsafeDocumentError(f"{path.name}: XML external ref forbidden") from exc
    except DefusedET.ParseError as exc:
        raise UnsafeDocumentError(f"{path.name}: XML parse error") from exc


def _parse_docx(path: Path) -> tuple[str, str]:
    _preflight_docx_with_defusedxml(path)
    from docx import Document

    doc = Document(str(path))
    title_candidate = path.stem
    lines: list[str] = []
    for para in doc.paragraphs:
        text = (para.text or "").strip()
        if not text:
            continue
        style = (para.style.name if para.style else "").lower()
        if style.startswith("heading"):
            level = 1
            for token in style.split():
                if token.isdigit():
                    level = max(1, min(6, int(token)))
                    break
            lines.append(f"{'#' * level} {text}")
            if title_candidate == path.stem and level == 1:
                title_candidate = text[:200]
        else:
            lines.append(text)
    markdown = "\n\n".join(lines) if lines else f"# {title_candidate}\n\n(empty document)"
    return title_candidate, markdown


# --------------------------------------------------------------------------
# Plaintext / Markdown
# --------------------------------------------------------------------------
def _parse_markdown(path: Path) -> tuple[str, str]:
    text = path.read_text(encoding="utf-8", errors="replace")
    title = path.stem
    for line in text.splitlines():
        line = line.strip()
        if line.startswith("# "):
            title = line[2:].strip()[:200]
            break
    return title, text


def _parse_txt(path: Path) -> tuple[str, str]:
    text = path.read_text(encoding="utf-8", errors="replace")
    title = path.stem
    # Prefix a H1 so the chunker has a real heading to anchor the ancestry.
    if not text.lstrip().startswith("#"):
        text = f"# {title}\n\n{text}"
    return title, text


# --------------------------------------------------------------------------
# Dispatch
# --------------------------------------------------------------------------
_PARSERS = {
    ".pdf": _parse_pdf,
    ".docx": _parse_docx,
    ".md": _parse_markdown,
    ".markdown": _parse_markdown,
    ".txt": _parse_txt,
}


def parse_document(path: Path) -> tuple[str, str, str]:
    """Return (title, markdown, source_type)."""
    ext = path.suffix.lower()
    parser = _PARSERS.get(ext)
    if parser is None:
        raise UnsupportedFormatError(f"no parser for extension {ext!r}")
    title, markdown = parser(path)
    source_type = infer_source_type(path)
    return title, markdown, source_type


def supported_extensions() -> set[str]:
    return set(_PARSERS.keys())
