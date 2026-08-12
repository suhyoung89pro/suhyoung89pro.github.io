from __future__ import annotations

import importlib.util
import io
import json
from pathlib import Path
import sys
import tempfile
import unittest

import fitz
from PIL import Image, ImageDraw


MODULE_PATH = Path(__file__).resolve().parents[1] / "extract_figures.py"
SPEC = importlib.util.spec_from_file_location("extract_figures", MODULE_PATH)
worker = importlib.util.module_from_spec(SPEC)
assert SPEC and SPEC.loader
sys.modules[SPEC.name] = worker
SPEC.loader.exec_module(worker)


class FakeHttpClient:
    def __init__(self, responses):
        self.responses = responses
        self.requested = []

    def get(self, url, *, max_bytes, allowed_hosts):
        normalized = worker.validate_url(url, allowed_hosts)
        self.requested.append(normalized)
        response = self.responses.get(normalized)
        if response is None:
            raise worker.WorkerError(f"missing fake response: {normalized}")
        if len(response.body) > max_bytes:
            raise worker.WorkerError("remote resource exceeds the byte limit")
        return response


def response(url: str, content_type: str, body: bytes):
    return worker.HttpResponse(url=url, content_type=content_type, body=body)


def raster_bytes() -> bytes:
    image = Image.new("RGB", (900, 430), "#eff6ff")
    draw = ImageDraw.Draw(image)
    for index, color in enumerate(("#ef4444", "#22c55e", "#3b82f6")):
        left = 70 + index * 270
        draw.rectangle((left, 80, left + 190, 340), outline=color, width=12)
        draw.text((left + 20, 20), f"sample {index + 1}", fill="#111827")
    output = io.BytesIO()
    image.save(output, format="PNG")
    return output.getvalue()


def synthetic_pdf(captions, *, pages=None) -> bytes:
    document = fitz.open()
    count = pages if pages is not None else max(1, len(captions))
    image = raster_bytes()
    for index in range(count):
        page = document.new_page(width=612, height=792)
        page.insert_text((54, 45), "Synthetic preprint - CC BY 4.0", fontsize=9)
        if index < len(captions):
            page.insert_image(fitz.Rect(60, 155, 552, 390), stream=image)
            page.insert_textbox(
                fitz.Rect(60, 410, 552, 470),
                captions[index],
                fontsize=11,
            )
    data = document.tobytes(garbage=4, deflate=True)
    document.close()
    return data


def write_queue(path: Path, item: dict) -> None:
    path.write_text(json.dumps({"schemaVersion": 1, "items": [item]}), encoding="utf-8")


class WorkerTests(unittest.TestCase):
    maxDiff = None

    def test_engrxiv_extracts_deterministic_qualitative_result(self):
        paper_url = "https://engrxiv.org/preprint/view/6685"
        pdf_url = "https://engrxiv.org/preprint/download/6685/100/200"
        page = b'<p>This work is licensed under a Creative Commons Attribution 4.0 International License.</p><a href="/preprint/download/6685/100/200">PDF</a>'
        pdf = synthetic_pdf(["Figure 4. Detection results for welding defects with bounding boxes."])
        fake = FakeHttpClient(
            {
                paper_url: response(paper_url, "text/html", page),
                pdf_url: response(pdf_url, "application/pdf", pdf),
            }
        )
        item = {
            "paperId": "paper-6685",
            "title": "Welding defect detection",
            "paperUrl": paper_url,
            "doi": "10.31224/6685",
        }

        with tempfile.TemporaryDirectory() as directory:
            root = Path(directory)
            queue = root / "queue.json"
            output = root / "candidates.json"
            assets = root / "assets"
            write_queue(queue, item)
            first = worker.run(str(queue), output, assets, http=fake, raw_asset_base="https://raw.test/auto")
            first_asset = next(assets.glob("*.webp"))
            first_bytes = first_asset.read_bytes()
            second = worker.run(str(queue), output, assets, http=fake, raw_asset_base="https://raw.test/auto")

            self.assertEqual(len(first["candidates"]), 1)
            candidate = first["candidates"][0]
            self.assertEqual(candidate["license"], "CC BY 4.0")
            self.assertEqual(candidate["figureLabel"], "Figure 4")
            self.assertEqual(candidate["sourceUrl"], paper_url)
            self.assertTrue(candidate["imageUrl"].startswith("https://raw.test/auto/figure-"))
            self.assertEqual(first_asset.read_bytes(), first_bytes)
            self.assertEqual(
                first["candidates"][0]["imageUrl"],
                second["candidates"][0]["imageUrl"],
            )
            with Image.open(first_asset) as rendered:
                self.assertEqual(rendered.format, "WEBP")
                self.assertGreater(rendered.width, 500)

    def test_rejects_chart_architecture_and_third_party_captions(self):
        captions = [
            "Figure 1. Network architecture and feature fusion module design.",
            "Figure 2. Precision-recall curve and performance comparison results.",
            "Figure 3. Detection results reproduced from Smith et al. [12].",
        ]
        document = fitz.open(stream=synthetic_pdf(captions), filetype="pdf")
        try:
            self.assertEqual(worker.find_figure_captions(document), [])
        finally:
            document.close()

    def test_accepts_dataset_visualization_caption_and_rejects_body_reference(self):
        caption = "Fig. 18 Shows the visualization of DCUE-YOLO model on the PCB dataset."
        document = fitz.open(stream=synthetic_pdf([caption]), filetype="pdf")
        try:
            found = worker.find_figure_captions(document)
            self.assertEqual([candidate.label for candidate in found], ["Figure 18"])
        finally:
            document.close()

    def test_crop_unions_connected_multi_panel_result_images(self):
        document = fitz.open()
        page = document.new_page(width=612, height=792)
        image = raster_bytes()
        rectangles = [
            fitz.Rect(60, 40, 220, 150),
            fitz.Rect(230, 60, 390, 170),
            fitz.Rect(395, 75, 520, 165),
            fitz.Rect(370, 150, 520, 225),
            fitz.Rect(85, 160, 235, 252),
            fitz.Rect(238, 154, 375, 246),
        ]
        for rectangle in rectangles:
            page.insert_image(rectangle, stream=image, keep_proportion=False)
        page.insert_textbox(
            fitz.Rect(120, 246, 500, 275),
            "Figure 4. Qualitative detection results on unseen weld images.",
            fontsize=10,
        )
        rebuilt = fitz.open(stream=document.tobytes(garbage=4, deflate=True), filetype="pdf")
        document.close()
        try:
            caption = worker.find_figure_captions(rebuilt)[0]
            clip = worker.figure_clip(rebuilt[0], caption)
            self.assertLessEqual(clip.x0, 54)
            self.assertGreaterEqual(clip.x1, 526)
            self.assertLessEqual(clip.y0, 34)
            self.assertGreaterEqual(clip.y1, 258)
        finally:
            rebuilt.close()

        body_reference = (
            "Figure 18. Shows the visualization of the model on the PCB dataset; "
            "Fig. 19 presents another experiment."
        )
        document = fitz.open(stream=synthetic_pdf([body_reference]), filetype="pdf")
        try:
            self.assertEqual(worker.find_figure_captions(document), [])
        finally:
            document.close()

    def test_rejects_non_cc_by_license_page(self):
        paper_url = "https://engrxiv.org/preprint/view/1"
        pdf_url = "https://engrxiv.org/preprint/download/1/2/3"
        fake = FakeHttpClient(
            {
                paper_url: response(
                    paper_url,
                    "text/html",
                    f'<p>Licensed under CC BY-SA 4.0</p><a href="{pdf_url}">PDF</a>'.encode(),
                ),
                pdf_url: response(pdf_url, "application/pdf", synthetic_pdf(["Figure 1. Detection results."])),
            }
        )
        item = worker.QueueItem("one", "Paper", paper_url, "", "")
        with self.assertRaisesRegex(worker.WorkerError, "does not verify CC BY 4.0"):
            worker.resolve_official_pdf(item, fake)

    def test_engrxiv_reads_citation_pdf_meta(self):
        paper_url = "https://engrxiv.org/preprint/view/6685"
        pdf_url = "https://engrxiv.org/preprint/download/6685/10950"
        page = (
            '<meta name="citation_pdf_url" '
            f'content="{pdf_url}"><p>Licensed under CC BY 4.0</p>'
        ).encode()
        pdf = synthetic_pdf(["Figure 4. Qualitative detection results."])
        fake = FakeHttpClient(
            {
                paper_url: response(paper_url, "text/html", page),
                pdf_url: response(pdf_url, "application/pdf", pdf),
            }
        )
        item = worker.QueueItem("one", "Paper", paper_url, "10.31224/6685", "")
        resolved, body = worker.resolve_official_pdf(item, fake)
        self.assertEqual(resolved, pdf_url)
        self.assertTrue(body.startswith(b"%PDF-"))

    def test_research_square_next_data_resolves_official_pdf(self):
        paper_url = "https://www.researchsquare.com/article/rs-5790775/v1"
        pdf_url = "https://assets.researchsquare.com/files/rs-5790775/v1/manuscript.pdf"
        next_data = {
            "props": {
                "initialData": {
                    "license": "CC BY 4.0",
                    "files": [{"role": "manuscript pdf", "url": pdf_url}],
                }
            }
        }
        page = (
            '<p>This work is licensed under a CC BY 4.0 License</p>'
            f'<script id="__NEXT_DATA__" type="application/json">{json.dumps(next_data)}</script>'
        ).encode()
        fake = FakeHttpClient(
            {
                paper_url: response(paper_url, "text/html", page),
                pdf_url: response(
                    pdf_url,
                    "application/pdf",
                    synthetic_pdf(["Fig. 18: Qualitative detection results on industrial defects."]),
                ),
            }
        )
        item = worker.QueueItem("rs", "DCUE", paper_url, "10.21203/rs.3.rs-5790775/v1", "")
        resolved_url, body = worker.resolve_official_pdf(item, fake)
        self.assertEqual(resolved_url, pdf_url)
        self.assertTrue(body.startswith(b"%PDF-"))

    def test_rejects_disallowed_urls_before_network(self):
        with self.assertRaisesRegex(worker.WorkerError, "host is not allowlisted"):
            worker.validate_url("https://127.0.0.1/paper.pdf", worker.PDF_HOSTS)
        with self.assertRaisesRegex(worker.WorkerError, "only HTTPS"):
            worker.validate_url("http://engrxiv.org/paper.pdf", worker.PDF_HOSTS)

    def test_known_doi_urls_map_to_official_pages_only(self):
        engrxiv = worker.QueueItem(
            "one", "Paper", "https://doi.org/10.31224/6685", "10.31224/6685", ""
        )
        research_square = worker.QueueItem(
            "two",
            "Paper",
            "https://doi.org/10.21203/rs.3.rs-5790775/v1",
            "10.21203/rs.3.rs-5790775/v1",
            "",
        )
        unknown = worker.QueueItem(
            "three", "Paper", "https://doi.org/10.1234/example", "10.1234/example", ""
        )
        self.assertEqual(
            worker.official_page_url(engrxiv),
            "https://engrxiv.org/preprint/view/6685",
        )
        self.assertEqual(
            worker.official_page_url(research_square),
            "https://www.researchsquare.com/article/rs-5790775/v1",
        )
        with self.assertRaisesRegex(worker.WorkerError, "does not map"):
            worker.official_page_url(unknown)

    def test_remote_queue_uses_google_script_host_allowlist(self):
        queue_url = "https://script.google.com/macros/s/example/exec?mode=pdf-queue"
        payload = json.dumps(
            {
                "items": [
                    {
                        "paperId": "one",
                        "title": "Paper",
                        "paperUrl": "https://doi.org/10.31224/6685",
                        "doi": "10.31224/6685",
                    }
                ]
            }
        ).encode()
        fake = FakeHttpClient({queue_url: response(queue_url, "application/json", payload)})
        items = worker.load_queue(queue_url, fake)
        self.assertEqual(items[0].paper_id, "one")
        self.assertEqual(fake.requested, [queue_url])

    def test_rejects_oversized_page_count(self):
        document = fitz.open(stream=synthetic_pdf([], pages=worker.MAX_PDF_PAGES + 1), filetype="pdf")
        try:
            with self.assertRaisesRegex(worker.WorkerError, "page count"):
                worker.find_figure_captions(document)
        finally:
            document.close()

    def test_queue_size_and_required_fields_are_bounded(self):
        class NoNetwork:
            pass

        with tempfile.TemporaryDirectory() as directory:
            queue = Path(directory) / "queue.json"
            queue.write_text(json.dumps({"items": [{}]}), encoding="utf-8")
            with self.assertRaisesRegex(worker.WorkerError, "missing paperId"):
                worker.load_queue(str(queue), NoNetwork())

    def test_unchanged_candidates_preserve_timestamp_and_existing_assets(self):
        class EmptyClient:
            pass

        with tempfile.TemporaryDirectory() as directory:
            root = Path(directory)
            queue = root / "queue.json"
            output = root / "candidates.json"
            assets = root / "assets"
            assets.mkdir()
            queue.write_text('{"schemaVersion":1,"items":[]}', encoding="utf-8")
            original = (
                '{\n  "schemaVersion": 1,\n  "generatedAt": "2026-01-01T00:00:00Z",'
                '\n  "candidates": []\n}\n'
            )
            output.write_text(original, encoding="utf-8")
            orphan = assets / "figure-0123456789abcdef0123.webp"
            manual = assets / "manual.webp"
            orphan.write_bytes(b"old")
            manual.write_bytes(b"keep")

            payload = worker.run(str(queue), output, assets, http=EmptyClient())

            self.assertEqual(payload["generatedAt"], "2026-01-01T00:00:00Z")
            self.assertEqual(output.read_text(encoding="utf-8"), original)
            self.assertEqual(orphan.read_bytes(), b"old")
            self.assertEqual(manual.read_bytes(), b"keep")

if __name__ == "__main__":
    unittest.main()
