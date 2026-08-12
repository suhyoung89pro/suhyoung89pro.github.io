#!/usr/bin/env python3
"""Extract reviewable qualitative figures from allowlisted preprint PDFs.

The worker deliberately produces candidates, never approvals.  It accepts a
small public JSON queue, verifies the publisher page and its CC BY 4.0 notice,
downloads the official PDF, and writes one deterministic WebP candidate per
paper when a qualitative results caption can be identified confidently.
"""

from __future__ import annotations

import argparse
import hashlib
import html
from html.parser import HTMLParser
import ipaddress
import json
import os
from pathlib import Path
import re
import socket
import sys
from dataclasses import dataclass
from datetime import datetime, timezone
from typing import Any, Iterable, Mapping, Sequence
from urllib.error import HTTPError, URLError
from urllib.parse import urljoin, urlsplit, urlunsplit
from urllib.request import HTTPRedirectHandler, HTTPSHandler, Request, build_opener

import fitz
from PIL import Image


SCHEMA_VERSION = 1
RAW_ASSET_BASE = (
    "https://raw.githubusercontent.com/suhyoung89pro/"
    "suhyoung89pro.github.io/main/assets/yolo-research/auto"
)

MAX_QUEUE_BYTES = 2 * 1024 * 1024
MAX_QUEUE_ITEMS = 50
MAX_HTML_BYTES = 3 * 1024 * 1024
MAX_PDF_BYTES = 30 * 1024 * 1024
MAX_PDF_PAGES = 80
MAX_REDIRECTS = 3
HTTP_TIMEOUT_SECONDS = 20
MAX_PAGE_POINTS = 2_500
MAX_RENDER_PIXELS = 12_000_000
MAX_OUTPUT_BYTES = 2 * 1024 * 1024
MAX_OUTPUT_EDGE = 1_600
RENDER_SCALE = 2.0

PAGE_HOSTS = frozenset(
    {
        "engrxiv.org",
        "www.engrxiv.org",
        "researchsquare.com",
        "www.researchsquare.com",
    }
)
QUEUE_HOSTS = frozenset(
    {
        "script.google.com",
        "script.googleusercontent.com",
    }
)
INPUT_PAPER_HOSTS = PAGE_HOSTS | frozenset({"doi.org"})
PDF_HOSTS = frozenset(
    {
        "engrxiv.org",
        "www.engrxiv.org",
        "researchsquare.com",
        "www.researchsquare.com",
        "assets.researchsquare.com",
        "assets-eu.researchsquare.com",
    }
)

CC_BY_4_RE = re.compile(
    r"(?:creative\s+commons\s+attribution\s+4\.0|"
    r"cc\s*by\s*4\.0|creativecommons\.org/licenses/by/4\.0)",
    re.IGNORECASE,
)
FIGURE_RE = re.compile(
    r"^\s*(?:figure|fig\.?)\s*([0-9]+[a-z]?)\s*[.\-:)]*\s*(.+)",
    re.IGNORECASE | re.DOTALL,
)

POSITIVE_PATTERNS: tuple[tuple[re.Pattern[str], int], ...] = tuple(
    (re.compile(pattern, re.IGNORECASE), score)
    for pattern, score in (
        (r"\b(?:object|defect|target)\s+detection\s+results?\b", 10),
        (r"\bdetection\s+results?\b", 8),
        (r"\b(?:inference|prediction|recognition)\s+results?\b", 8),
        (r"\bqualitative\s+(?:results?|comparison|evaluation)\b", 8),
        (r"\bvisual(?:ized|ization)?\s+(?:results?|comparison)\b", 7),
        (r"\bshows?\s+the\s+visuali[sz]ation\b", 7),
        (r"\bvisuali[sz]ation\s+of\s+.+\b(?:model|detector)\b.+\bdataset\b", 7),
        (r"\bcomparison\s+of\s+(?:the\s+)?detection\s+results?\b", 8),
        (r"\b(?:detected|predicted|recognized)\s+(?:images?|samples?|objects?|defects?)\b", 6),
        (r"\b(?:sample|actual|test)\s+detection\b", 6),
        (r"\bdetection\s+(?:effect|output|examples?)\b", 6),
        (r"\bground\s+truth\b", 3),
        (r"\bbounding\s+box(?:es)?\b", 3),
    )
)

REJECT_PATTERNS: tuple[re.Pattern[str], ...] = tuple(
    re.compile(pattern, re.IGNORECASE)
    for pattern in (
        r"\b(?:network|model|system)\s+(?:architecture|structure|framework)\b",
        r"\b(?:architecture|flowchart|pipeline|block\s+diagram|schematic)\b",
        r"\b(?:module|backbone|neck|head|attention\s+mechanism)\s+(?:design|structure|architecture|overview)\b",
        r"\b(?:training|validation)\s+(?:process|workflow)\b",
        r"\b(?:precision[\s-]*recall|roc|loss|accuracy|fitness)\s+curves?\b",
        r"\b(?:confusion\s+matrix|feature\s+maps?|feature\s+fusion)\b",
        r"\b(?:bar|line|scatter|radar|box)\s+(?:plot|chart|graph)\b",
        r"\b(?:plot|chart|graph)\s+of\b",
        r"\b(?:ablation|benchmark|parameter|complexity|performance)\s+(?:study|comparison|analysis|results?)\b",
        r"\b(?:map|fps|precision|recall|f1[\s-]*score)\s+(?:comparison|curve|results?)\b",
    )
)

THIRD_PARTY_PATTERNS: tuple[re.Pattern[str], ...] = tuple(
    re.compile(pattern, re.IGNORECASE)
    for pattern in (
        r"\b(?:adapted|modified|reproduced|redrawn|taken)\s+from\b",
        r"\b(?:reprinted|used)\s+with\s+permission\b",
        r"\bcopyright\b|\u00a9",
        r"\bsource\s*:",
        r"\bet\s+al\.\s*(?:\(|\[|,)",
        r"\[[0-9]+(?:\s*[-,]\s*[0-9]+)*\]",
        r"\([A-Z][A-Za-z-]+(?:\s+et\s+al\.)?,?\s+20[0-9]{2}\)",
    )
)


class WorkerError(RuntimeError):
    """An expected validation or extraction failure for one queue item."""


@dataclass(frozen=True)
class HttpResponse:
    url: str
    content_type: str
    body: bytes


@dataclass(frozen=True)
class QueueItem:
    paper_id: str
    title: str
    paper_url: str
    doi: str
    pdf_url: str


@dataclass(frozen=True)
class FigureCaption:
    page_index: int
    number: str
    text: str
    bbox: fitz.Rect
    score: int

    @property
    def label(self) -> str:
        return f"Figure {self.number}"


class _LinkParser(HTMLParser):
    def __init__(self) -> None:
        super().__init__()
        self.links: list[tuple[str, str]] = []
        self.meta_pdf_urls: list[str] = []
        self._href = ""
        self._text: list[str] = []

    def handle_starttag(self, tag: str, attrs: list[tuple[str, str | None]]) -> None:
        if tag.lower() == "meta":
            values = dict(attrs)
            if (values.get("name") or "").lower() == "citation_pdf_url" and values.get("content"):
                self.meta_pdf_urls.append(values["content"] or "")
            return
        if tag.lower() != "a":
            return
        self._href = dict(attrs).get("href") or ""
        self._text = []

    def handle_data(self, data: str) -> None:
        if self._href:
            self._text.append(data)

    def handle_endtag(self, tag: str) -> None:
        if tag.lower() == "a" and self._href:
            self.links.append((self._href, " ".join(self._text)))
            self._href = ""
            self._text = []


def _canonical_host(url: str) -> str:
    parsed = urlsplit(url)
    if parsed.scheme.lower() != "https" or not parsed.hostname:
        raise WorkerError("only HTTPS URLs are accepted")
    try:
        port = parsed.port
    except ValueError as error:
        raise WorkerError("invalid URL port") from error
    if parsed.username or parsed.password or port not in (None, 443):
        raise WorkerError("URL credentials and non-standard ports are not accepted")
    try:
        return parsed.hostname.encode("idna").decode("ascii").lower().rstrip(".")
    except UnicodeError as error:
        raise WorkerError("invalid URL hostname") from error


def validate_url(url: str, allowed_hosts: frozenset[str]) -> str:
    host = _canonical_host(url)
    if host not in allowed_hosts:
        raise WorkerError(f"host is not allowlisted: {host}")
    parsed = urlsplit(url)
    return urlunsplit(("https", parsed.netloc.lower(), parsed.path or "/", parsed.query, ""))


def _validate_public_dns(host: str) -> None:
    try:
        addresses = {entry[4][0] for entry in socket.getaddrinfo(host, 443, type=socket.SOCK_STREAM)}
    except OSError as error:
        raise WorkerError(f"DNS lookup failed for {host}") from error
    if not addresses:
        raise WorkerError(f"DNS lookup returned no addresses for {host}")
    for raw_address in addresses:
        address = ipaddress.ip_address(raw_address.split("%", 1)[0])
        if not address.is_global:
            raise WorkerError(f"host resolved to a non-public address: {host}")


class _RestrictedRedirectHandler(HTTPRedirectHandler):
    def __init__(self, client: "SafeHttpClient") -> None:
        super().__init__()
        self.client = client
        self.redirects = 0

    def redirect_request(self, req, fp, code, msg, headers, newurl):  # noqa: ANN001
        self.redirects += 1
        if self.redirects > MAX_REDIRECTS:
            raise WorkerError("too many HTTP redirects")
        destination = urljoin(req.full_url, newurl)
        self.client.validate_destination(destination)
        return super().redirect_request(req, fp, code, msg, headers, destination)


class SafeHttpClient:
    """Small HTTPS client with host, DNS, redirect, time, and byte limits."""

    def __init__(self) -> None:
        self.allowed_hosts = PAGE_HOSTS

    def validate_destination(self, url: str) -> str:
        normalized = validate_url(url, self.allowed_hosts)
        _validate_public_dns(_canonical_host(normalized))
        return normalized

    def get(self, url: str, *, max_bytes: int, allowed_hosts: frozenset[str]) -> HttpResponse:
        self.allowed_hosts = allowed_hosts
        normalized = self.validate_destination(url)
        redirect_handler = _RestrictedRedirectHandler(self)
        opener = build_opener(HTTPSHandler(), redirect_handler)
        request = Request(
            normalized,
            headers={
                "Accept": "text/html,application/pdf,application/json;q=0.9,*/*;q=0.1",
                "User-Agent": "YOLOResearchFigureWorker/1.0 (+https://suhyoung89pro.github.io/)",
            },
        )
        try:
            with opener.open(request, timeout=HTTP_TIMEOUT_SECONDS) as response:
                final_url = self.validate_destination(response.geturl())
                content_length = response.headers.get("Content-Length")
                if content_length and int(content_length) > max_bytes:
                    raise WorkerError("remote resource exceeds the byte limit")
                body = response.read(max_bytes + 1)
                if len(body) > max_bytes:
                    raise WorkerError("remote resource exceeds the byte limit")
                return HttpResponse(
                    url=final_url,
                    content_type=response.headers.get_content_type().lower(),
                    body=body,
                )
        except WorkerError:
            raise
        except (HTTPError, URLError, TimeoutError, ValueError) as error:
            raise WorkerError(f"download failed: {error}") from error


def _read_queue_source(source: str, http: SafeHttpClient) -> bytes:
    if source.lower().startswith("https://"):
        response = http.get(source, max_bytes=MAX_QUEUE_BYTES, allowed_hosts=QUEUE_HOSTS)
        return response.body
    path = Path(source)
    if not path.is_file() or path.stat().st_size > MAX_QUEUE_BYTES:
        raise WorkerError("queue file is missing or exceeds the byte limit")
    return path.read_bytes()


def load_queue(source: str, http: SafeHttpClient) -> list[QueueItem]:
    try:
        payload = json.loads(_read_queue_source(source, http).decode("utf-8"))
    except (UnicodeDecodeError, json.JSONDecodeError) as error:
        raise WorkerError("queue is not valid UTF-8 JSON") from error

    if isinstance(payload, list):
        raw_items = payload
    elif isinstance(payload, dict):
        raw_items = next(
            (payload[key] for key in ("items", "queue", "candidates") if isinstance(payload.get(key), list)),
            None,
        )
        if raw_items is None:
            raise WorkerError("queue JSON must contain an items array")
    else:
        raise WorkerError("queue JSON must be an object or array")

    if len(raw_items) > MAX_QUEUE_ITEMS:
        raise WorkerError("queue contains too many items")

    items: list[QueueItem] = []
    for index, raw in enumerate(raw_items):
        if not isinstance(raw, Mapping):
            raise WorkerError(f"queue item {index} is not an object")
        paper_id = _limited_text(raw.get("paperId") or raw.get("id"), 200)
        title = _limited_text(raw.get("title"), 500)
        paper_url = _limited_text(raw.get("paperUrl"), 2_000)
        doi = _limited_text(raw.get("doi"), 300)
        pdf_url = _limited_text(raw.get("pdfUrl"), 2_000)
        if not paper_id or not title or not paper_url:
            raise WorkerError(f"queue item {index} is missing paperId, title, or paperUrl")
        validate_url(paper_url, INPUT_PAPER_HOSTS)
        if pdf_url:
            validate_url(pdf_url, PDF_HOSTS)
        items.append(QueueItem(paper_id, title, paper_url, doi, pdf_url))
    return items


def _limited_text(value: Any, limit: int) -> str:
    text = str(value or "").strip()
    if len(text) > limit:
        raise WorkerError("queue field exceeds its length limit")
    return text


def _decode_html(response: HttpResponse) -> str:
    try:
        return response.body.decode("utf-8")
    except UnicodeDecodeError:
        return response.body.decode("utf-8", errors="replace")


def official_page_url(item: QueueItem) -> str:
    """Resolve only publisher-owned paper pages from a queue paper URL/DOI."""
    paper_url = validate_url(item.paper_url, INPUT_PAPER_HOSTS)
    if _canonical_host(paper_url) != "doi.org":
        return validate_url(paper_url, PAGE_HOSTS)

    parsed_path = urlsplit(paper_url).path.lstrip("/")
    queue_doi = item.doi.strip().lower()
    path_doi = parsed_path.strip().lower()
    if queue_doi and queue_doi != path_doi:
        raise WorkerError("DOI URL and queue DOI do not match")
    doi = queue_doi or path_doi
    engrxiv = re.fullmatch(r"10\.31224/(\d+)", doi)
    if engrxiv:
        return f"https://engrxiv.org/preprint/view/{engrxiv.group(1)}"
    research_square = re.fullmatch(r"10\.21203/rs\.3\.(rs-\d+)/v(\d+)", doi)
    if research_square:
        return (
            "https://www.researchsquare.com/article/"
            f"{research_square.group(1)}/v{research_square.group(2)}"
        )
    raise WorkerError("DOI does not map to an allowlisted engrXiv or Research Square paper")


def _is_cc_by_4_page(page_html: str) -> bool:
    visible = html.unescape(re.sub(r"<[^>]+>", " ", page_html))
    if not CC_BY_4_RE.search(visible + " " + page_html):
        return False
    if re.search(r"\bCC\s*BY[-\s](?:SA|NC|ND)\s*4\.0\b", visible, re.IGNORECASE):
        return False
    return True


def _walk_json(value: Any) -> Iterable[Mapping[str, Any]]:
    if isinstance(value, Mapping):
        yield value
        for child in value.values():
            yield from _walk_json(child)
    elif isinstance(value, list):
        for child in value:
            yield from _walk_json(child)


def _research_square_pdf_urls(page_html: str, base_url: str) -> list[str]:
    candidates: list[str] = []
    next_match = re.search(
        r'<script[^>]+id=["\']__NEXT_DATA__["\'][^>]*>(.*?)</script>',
        page_html,
        re.IGNORECASE | re.DOTALL,
    )
    if next_match:
        try:
            data = json.loads(html.unescape(next_match.group(1)))
        except json.JSONDecodeError:
            data = None
        if data is not None:
            for entry in _walk_json(data):
                role_text = " ".join(
                    str(entry.get(key, "")) for key in ("role", "type", "fileType", "name", "filename")
                ).lower()
                if "pdf" not in role_text and "manuscript" not in role_text:
                    continue
                for key in ("url", "downloadUrl", "fileUrl", "href", "path"):
                    value = entry.get(key)
                    if isinstance(value, str) and value:
                        candidates.append(urljoin(base_url, value))

    parser = _LinkParser()
    parser.feed(page_html)
    for href, label in parser.links:
        joined = urljoin(base_url, href)
        if "pdf" in label.lower() or ".pdf" in urlsplit(joined).path.lower():
            candidates.append(joined)
    return _unique(candidates)


def _engrxiv_pdf_urls(page_html: str, base_url: str) -> list[str]:
    parser = _LinkParser()
    parser.feed(page_html)
    candidates = [urljoin(base_url, value) for value in parser.meta_pdf_urls]
    candidates.extend(
        urljoin(base_url, href)
        for href, label in parser.links
        if "/preprint/download/" in href or "pdf" in label.lower()
    )
    return _unique(candidates)


def _unique(values: Iterable[str]) -> list[str]:
    seen: set[str] = set()
    result: list[str] = []
    for value in values:
        if value not in seen:
            seen.add(value)
            result.append(value)
    return result


def resolve_official_pdf(item: QueueItem, http: SafeHttpClient) -> tuple[str, bytes]:
    page_url = official_page_url(item)
    page_host = _canonical_host(page_url)
    page_response = http.get(page_url, max_bytes=MAX_HTML_BYTES, allowed_hosts=PAGE_HOSTS)
    page_html = _decode_html(page_response)
    if not _is_cc_by_4_page(page_html):
        raise WorkerError("the official paper page does not verify CC BY 4.0")

    if item.pdf_url:
        candidates = [item.pdf_url]
    elif page_host in {"engrxiv.org", "www.engrxiv.org"}:
        candidates = _engrxiv_pdf_urls(page_html, page_response.url)
    else:
        candidates = _research_square_pdf_urls(page_html, page_response.url)
    if not candidates:
        raise WorkerError("the official paper page contains no PDF URL")

    last_error: WorkerError | None = None
    for candidate in candidates[:5]:
        try:
            pdf_url = validate_url(candidate, PDF_HOSTS)
            pdf_host = _canonical_host(pdf_url)
            if page_host.endswith("engrxiv.org") and pdf_host not in {"engrxiv.org", "www.engrxiv.org"}:
                raise WorkerError("engrXiv PDF must remain on engrxiv.org")
            if page_host.endswith("researchsquare.com") and not pdf_host.endswith("researchsquare.com"):
                raise WorkerError("Research Square PDF must remain on researchsquare.com")
            response = http.get(pdf_url, max_bytes=MAX_PDF_BYTES, allowed_hosts=PDF_HOSTS)
            if not response.body.startswith(b"%PDF-"):
                raise WorkerError("downloaded resource is not a PDF")
            return response.url, response.body
        except WorkerError as error:
            last_error = error
    raise last_error or WorkerError("no valid official PDF could be downloaded")


def _normalized_caption(text: str) -> str:
    return re.sub(r"\s+", " ", text).strip()


def score_caption(caption: str) -> int | None:
    normalized = _normalized_caption(caption)
    if any(pattern.search(normalized) for pattern in THIRD_PARTY_PATTERNS):
        return None
    if any(pattern.search(normalized) for pattern in REJECT_PATTERNS):
        return None
    score = sum(weight for pattern, weight in POSITIVE_PATTERNS if pattern.search(normalized))
    return score if score >= 6 else None


def _block_caption(block_text: str) -> tuple[str, str] | None:
    normalized = _normalized_caption(block_text)
    match = FIGURE_RE.match(normalized)
    if not match:
        return None
    body = match.group(2)
    # get_text("blocks") occasionally joins the next paragraph to a caption.
    body = re.split(r"\s+(?=(?:[A-Z][a-z]+\s+){1,3}(?:is|are|was|were)\s)", body, maxsplit=1)[0]
    return match.group(1), body[:1_500]


def find_figure_captions(document: fitz.Document) -> list[FigureCaption]:
    if document.needs_pass:
        raise WorkerError("password-protected PDFs are not accepted")
    if document.page_count < 1 or document.page_count > MAX_PDF_PAGES:
        raise WorkerError("PDF page count is outside the allowed range")

    candidates: list[FigureCaption] = []
    for page_index in range(document.page_count):
        page = document.load_page(page_index)
        if page.rect.width > MAX_PAGE_POINTS or page.rect.height > MAX_PAGE_POINTS:
            raise WorkerError("PDF page dimensions exceed the limit")
        blocks = page.get_text("blocks", sort=True)
        if sum(len(str(block[4])) for block in blocks) > 200_000:
            raise WorkerError("PDF page text exceeds the limit")
        for block in blocks:
            block_bbox = fitz.Rect(block[:4])
            if block_bbox.height > 60:
                continue
            parsed = _block_caption(str(block[4]))
            if not parsed:
                continue
            number, caption = parsed
            if len(caption) > 500 or re.search(r"\b(?:fig(?:ure)?\.?)\s*\d+", caption, re.IGNORECASE):
                continue
            score = score_caption(caption)
            if score is None:
                continue
            candidates.append(
                FigureCaption(
                    page_index=page_index,
                    number=number,
                    text=caption,
                    bbox=block_bbox,
                    score=score,
                )
            )
    return sorted(candidates, key=lambda candidate: (-candidate.score, candidate.page_index, candidate.number))


def _horizontal_overlap(first: fitz.Rect, second: fitz.Rect) -> float:
    overlap = max(0.0, min(first.x1, second.x1) - max(first.x0, second.x0))
    return overlap / max(1.0, min(first.width, second.width))


def _vertical_gap(first: fitz.Rect, second: fitz.Rect) -> float:
    if first.y1 < second.y0:
        return second.y0 - first.y1
    if second.y1 < first.y0:
        return first.y0 - second.y1
    return 0.0


def figure_clip(page: fitz.Page, caption: FigureCaption) -> fitz.Rect:
    page_rect = page.rect
    images: list[fitz.Rect] = []
    for info in page.get_image_info(xrefs=True):
        bbox = fitz.Rect(info["bbox"])
        if bbox.width < 40 or bbox.height < 40:
            continue
        if bbox.y1 <= caption.bbox.y0 + 8 and caption.bbox.y0 - bbox.y1 <= page_rect.height * 0.55:
            if _horizontal_overlap(bbox, caption.bbox) >= 0.05:
                images.append(bbox)
    if not images:
        raise WorkerError("the selected caption has no nearby raster result image")

    nearest_gap = min(abs(caption.bbox.y0 - bbox.y1) for bbox in images)
    nearest = [bbox for bbox in images if abs(caption.bbox.y0 - bbox.y1) <= nearest_gap + 2]
    primary = max(nearest, key=lambda bbox: bbox.width * bbox.height)
    selected = [primary]
    changed = True
    while changed:
        changed = False
        for bbox in images:
            if bbox in selected:
                continue
            if any(_vertical_gap(bbox, member) <= 24 for member in selected):
                selected.append(bbox)
                changed = True
    clip = fitz.Rect(primary)
    for bbox in selected:
        clip.include_rect(bbox)
    padding = 6
    clip = fitz.Rect(clip.x0 - padding, clip.y0 - padding, clip.x1 + padding, clip.y1 + padding)
    clip &= page_rect
    if clip.width < 80 or clip.height < 80:
        raise WorkerError("the selected result image is too small")
    return clip


def _deterministic_name(item: QueueItem, caption: FigureCaption) -> str:
    identity = "\n".join(
        (
            item.paper_id.strip().lower(),
            item.doi.strip().lower(),
            item.paper_url.strip().lower(),
            caption.label.lower(),
            _normalized_caption(caption.text).lower(),
        )
    ).encode("utf-8")
    return f"figure-{hashlib.sha256(identity).hexdigest()[:20]}.webp"


def render_candidate(
    document: fitz.Document,
    item: QueueItem,
    caption: FigureCaption,
    assets_dir: Path,
) -> tuple[Path, str]:
    page = document.load_page(caption.page_index)
    clip = figure_clip(page, caption)
    target_pixels = int(clip.width * RENDER_SCALE) * int(clip.height * RENDER_SCALE)
    if target_pixels > MAX_RENDER_PIXELS:
        raise WorkerError("candidate render exceeds the pixel limit")
    pixmap = page.get_pixmap(matrix=fitz.Matrix(RENDER_SCALE, RENDER_SCALE), clip=clip, alpha=False)
    if pixmap.width * pixmap.height > MAX_RENDER_PIXELS:
        raise WorkerError("candidate render exceeds the pixel limit")
    image = Image.frombytes("RGB", (pixmap.width, pixmap.height), pixmap.samples)
    if max(image.size) > MAX_OUTPUT_EDGE:
        ratio = MAX_OUTPUT_EDGE / max(image.size)
        image = image.resize(
            (max(1, round(image.width * ratio)), max(1, round(image.height * ratio))),
            Image.Resampling.LANCZOS,
        )

    filename = _deterministic_name(item, caption)
    assets_dir.mkdir(parents=True, exist_ok=True)
    output_path = assets_dir / filename
    temporary_path = assets_dir / f".{filename}.tmp"
    image.save(temporary_path, format="WEBP", quality=82, method=6, exact=True)
    if temporary_path.stat().st_size > MAX_OUTPUT_BYTES:
        temporary_path.unlink(missing_ok=True)
        raise WorkerError("candidate WebP exceeds the byte limit")
    temporary_path.replace(output_path)
    return output_path, hashlib.sha256(output_path.read_bytes()).hexdigest()


def extract_item(
    item: QueueItem,
    http: SafeHttpClient,
    assets_dir: Path,
    raw_asset_base: str,
) -> dict[str, Any]:
    _pdf_url, pdf_bytes = resolve_official_pdf(item, http)
    try:
        document = fitz.open(stream=pdf_bytes, filetype="pdf")
    except (RuntimeError, ValueError) as error:
        raise WorkerError("PDF parser rejected the document") from error
    try:
        captions = find_figure_captions(document)
        if not captions:
            raise WorkerError("no eligible qualitative result caption was found")
        last_error: WorkerError | None = None
        for caption in captions[:5]:
            try:
                asset_path, digest = render_candidate(document, item, caption, assets_dir)
                return {
                    "paperId": item.paper_id,
                    "doi": item.doi,
                    "paperUrl": item.paper_url,
                    "imageUrl": f"{raw_asset_base.rstrip('/')}/{asset_path.name}",
                    "sourceUrl": official_page_url(item),
                    "license": "CC BY 4.0",
                    "figureLabel": caption.label,
                    "note": (
                        f"PDF p.{caption.page_index + 1}; {_normalized_caption(caption.text)}; "
                        f"sha256:{digest[:16]}"
                    ),
                }
            except WorkerError as error:
                last_error = error
        raise last_error or WorkerError("no selected caption could be rendered")
    except WorkerError:
        raise
    except (RuntimeError, ValueError, OSError) as error:
        raise WorkerError("PDF extraction failed safely") from error
    finally:
        document.close()


def _generated_at() -> str:
    source_epoch = os.environ.get("SOURCE_DATE_EPOCH")
    if source_epoch:
        moment = datetime.fromtimestamp(int(source_epoch), tz=timezone.utc)
    else:
        moment = datetime.now(timezone.utc)
    return moment.replace(microsecond=0).isoformat().replace("+00:00", "Z")


def run(
    queue_source: str,
    output_path: Path,
    assets_dir: Path,
    *,
    http: SafeHttpClient | None = None,
    raw_asset_base: str = RAW_ASSET_BASE,
) -> dict[str, Any]:
    client = http or SafeHttpClient()
    items = load_queue(queue_source, client)
    candidates: list[dict[str, Any]] = []
    for item in items:
        try:
            candidates.append(extract_item(item, client, assets_dir, raw_asset_base))
        except WorkerError as error:
            print(f"skip {item.paper_id}: {error}", file=sys.stderr)
    candidates.sort(key=lambda candidate: (candidate["paperId"], candidate["figureLabel"]))
    previous: Mapping[str, Any] | None = None
    if output_path.is_file() and output_path.stat().st_size <= MAX_QUEUE_BYTES:
        try:
            loaded_previous = json.loads(output_path.read_text(encoding="utf-8"))
            if isinstance(loaded_previous, Mapping):
                previous = loaded_previous
        except (OSError, UnicodeDecodeError, json.JSONDecodeError):
            previous = None

    previous_generated_at = previous.get("generatedAt") if previous is not None else None
    if (
        previous is not None
        and previous.get("schemaVersion") == SCHEMA_VERSION
        and isinstance(previous_generated_at, str)
        and re.fullmatch(r"\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}Z", previous_generated_at)
        and previous.get("candidates") == candidates
    ):
        return dict(previous)

    payload = {
        "schemaVersion": SCHEMA_VERSION,
        "generatedAt": _generated_at(),
        "candidates": candidates,
    }
    output_path.parent.mkdir(parents=True, exist_ok=True)
    output_path.write_text(json.dumps(payload, ensure_ascii=False, indent=2) + "\n", encoding="utf-8")
    return payload


def parse_args(argv: Sequence[str] | None = None) -> argparse.Namespace:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--queue-url", required=True, help="HTTPS queue URL or a local JSON file")
    parser.add_argument("--output", required=True, type=Path, help="candidates.json output path")
    parser.add_argument("--assets-dir", required=True, type=Path, help="directory for deterministic WebP assets")
    parser.add_argument("--raw-base-url", default=RAW_ASSET_BASE, help=argparse.SUPPRESS)
    return parser.parse_args(argv)


def main(argv: Sequence[str] | None = None) -> int:
    args = parse_args(argv)
    try:
        payload = run(
            args.queue_url,
            args.output,
            args.assets_dir,
            raw_asset_base=args.raw_base_url,
        )
    except WorkerError as error:
        print(f"error: {error}", file=sys.stderr)
        return 2
    print(f"wrote {len(payload['candidates'])} candidate(s) to {args.output}")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
