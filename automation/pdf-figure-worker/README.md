# PDF figure candidate worker

This worker fills the gap left by publisher web pages that expose a paper only
as a PDF. It creates review candidates; it does not approve or publish them.

Supported sources are intentionally narrow:

- engrXiv (`engrxiv.org`)
- Research Square (`researchsquare.com` and its official asset hosts)

For every queue item the worker verifies a CC BY 4.0 notice on the official
paper page. It then accepts only qualitative result/detection captions. Charts,
model architecture diagrams, and captions containing third-party attribution
signals are rejected.

## Queue contract

```json
{
  "schemaVersion": 1,
  "generatedAt": "2026-08-13T00:00:00Z",
  "items": [
    {
      "paperId": "row-12",
      "title": "Paper title",
      "paperUrl": "https://engrxiv.org/preprint/view/6685",
      "doi": "10.31224/6685",
      "pdfUrl": ""
    }
  ]
}
```

`pdfUrl` is optional. If absent, the worker discovers the official PDF link on
the paper page. A supplied URL is still checked against the publisher allowlist.

## Run

```powershell
python automation/pdf-figure-worker/extract_figures.py `
  --queue-url "https://example.invalid/pdf-queue.json" `
  --output automation/pdf-figure-worker/output/candidates.json `
  --assets-dir assets/yolo-research/auto
```

Install exact runtime dependencies with:

```powershell
python -m pip install -r automation/pdf-figure-worker/requirements.txt
```

Run the synthetic-PDF tests with:

```powershell
python -m unittest discover -s automation/pdf-figure-worker/tests -p "test_*.py"
```

Safeguards include HTTPS and exact-host validation, public-DNS checks, bounded
redirects/downloads, queue and page-count limits, raster-only crop selection,
render pixel/output limits, and hash-derived filenames.

Generated assets are intentionally append-only. A candidate may already be
approved and referenced by a published Sheet row after it disappears from a
later queue, so this worker never deletes an existing WebP asset.
