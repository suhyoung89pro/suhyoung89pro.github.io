# PDF Figure Worker Operations

The `Extract PDF figure candidates` workflow runs daily at 05:17 KST and can
also be started from the GitHub Actions UI.

The public Apps Script PDF queue is used by default, so no URL setup is
required. To use another queue, create a repository **variable** (not a secret)
named `YOLO_PDF_QUEUE_URL` containing its HTTPS URL.

GitHub Actions must be allowed to write repository contents. If `main` is
protected, allow this workflow's bot commit or replace the direct push with the
repository's required pull-request flow.

The workflow stages only
`automation/pdf-figure-worker/output/candidates.json` and files under
`assets/yolo-research/auto/`. It fails if the worker changes another tracked or
untracked path, emits symbolic links or unsupported asset types, or exceeds the
configured output size limits. It does not commit when those outputs are
unchanged.
