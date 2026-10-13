# How established projects keep hostile PDFs and images safe

For Orbit's PDF structure checker (worktree `pdf-structure`), 2026-10-07.
Primary sources only; "unverified" marks anything not confirmed.

Commits read: paperless-ngx `dev@d7a9894` (latest release v3.3.0,
2026-10-06); dangerzone `main@5f4e277`; docspell `master@f3cc63c`;
mayan-edms `master@834ffec` (GitLab); papermerge-core `master@c75ba84`;
nextcloud/files_pdfviewer `master@0003876`. Single files fetched from
GitHub for dangerzone-image, Stirling-PDF, Immich, OCRmyPDF, qpdf, pdf.js.

## Summary table

Key: **Y** = does it; **-** = does not; **opt** = optional/admin setting.

| Project | Type by magic | Rejects active content | Mature-library parse as validation | Serves a derived copy | Rasterise and rebuild | Viewer disables scripting | Parser sandbox (beyond app container) | AV scan |
|---|---|---|---|---|---|---|---|---|
| paperless-ngx | Y (libmagic) | - | - (only for octet-stream rescue) | opt (PDF/A archive; not for born-digital PDFs by default) | - | Y (no scripting manager) | - | - |
| Dangerzone | Y (libmagic, in sandbox) | - (by design) | - | Y (only output) | **Y** | n/a | **Y** (gVisor in rootless Podman, no network) | - (by design) |
| Docspell | Y (Tika) | - | - | Y (converted PDF is the default view) | - | browser-native viewer by default | - | - |
| Mayan EDMS | Y (`file`) | - | - | Y (page images) | page images for viewing only | n/a (no pdf.js) | - | opt (ClamAV, recorded as metadata) |
| Papermerge | Y (own magic table) | - | **Y** (pikepdf/qpdf opens it, has ≥1 page; Pillow `verify()`) | page images (unverified for viewer) | - | default pdf.js API | - | - |
| Nextcloud | n/a (file sync) | - | - | - | - | **Y** (scripting off by default, admin toggle) | - | opt (separate app, not checked) |
| Stirling-PDF | n/a (tool) | strips on request | - | Y (sanitised output) | opt (convert to image) | n/a | - | - |
| Immich (images) | Y | n/a | decode via libvips | **Y** (re-encoded thumbnails/previews) | n/a | n/a | - | - |
| **Orbit today** | Y | **Y** (byte/regex + pdf.js object walk) | partial (pdf.js `stopAtErrors`) | Y (server-drawn page-one image) | page one only | n/a (server-side pdf.js; downloads are attachments) | - (Tika only) | **Y** (ClamAV, fail-closed) |

No project surveyed rejects PDFs for containing JavaScript, launch actions,
XFA or attachments at upload time. Orbit's checker is the outlier.

## Per-project notes

### paperless-ngx (GPL-3.0-only, Docker image label)

- **Type**: libmagic at upload (`src/documents/serialisers.py`
  `validate_document` ~L2354) and again in the consumer
  (`src/documents/consumer.py` L423). qpdf runs only to rescue a `.pdf` that
  libmagic calls `application/octet-stream` (`consumer.py` L427-458).
- **No structural or active-content validation found.** Preflight = file
  exists, duplicate SHA-256, directories, ASN (`consumer.py` L1017-1135).
  Encrypted/signed PDFs accepted; OCR skipped (`src/paperless/parsers/
  tesseract.py` `parse()`); the viewer accepts a `password`.
- **Parsers run on the original**: `pdftotext` (`parsers/utils.py` L72-108),
  pikepdf for page count and XMP (~L240-330), ImageMagick → Ghostscript
  thumbnail with Ghostscript fallback (`src/documents/parsers.py`).
- **Normalisation optional, skipped for born-digital PDFs by default**:
  `PAPERLESS_ARCHIVE_FILE_GENERATION=auto` makes a PDF/A archive (OCRmyPDF/
  Ghostscript) only for scans; "Born-digital PDF: No"
  (`docs/configuration.md` L931-960; `should_produce_archive`,
  `consumer.py` L127-160); OCRmyPDF is then skipped entirely.
- **Original always kept** ("will never overwrite that document",
  `docs/usage.md` ~L148). `preview` serves the archive if any, else the
  original, inline (`src/documents/views.py` L1795-1813, `serve_file`
  L4948-5002). UI: `pdfjs-dist ^6.3.289`, default `getDocument` options,
  `PDFViewer` with no scripting manager, so PDF JS never runs
  (`src-ui/.../pdf-viewer.component.ts` L187-239); optional browser-native
  `<object>` mode. No CSP on file responses found.
- **Limits**: Pillow pixel cap "intended to prevent malicious files from
  consuming system resources" (`docs/configuration.md` L1072-1095);
  `PAPERLESS_OCR_PAGES`; ImageMagick policy capping memory/area and
  disabling SVG/MVG/MSL/PS/XPS/URL coders, PDF allowed
  (`docker/rootfs/etc/ImageMagick-6/paperless-policy.xml`).
- **No sandbox** beyond the one container (consumer as user `paperless`,
  `s6-rc.d/svc-consumer/run` L16); **no antivirus** (none in `src/`, `docs/`).
- **Advisories**: 16 GHSAs, none about document content (authorisation,
  IDOR, XSS, path traversal; `gh api .../security-advisories`). No paperless
  response to Ghostscript CVE-2023-36664 found.

### Dangerzone (AGPL-3.0)

- Pattern: render every page to raw RGB pixels **inside a sandbox**, rebuild
  a PDF from pixels **outside** it (`docs/explanation/how-dangerzone-works.md`).
- Explicitly rejects AV and partial disarm: "content disarm software assumes
  that file formats have 'safe' and 'unsafe' parts ... file parsers can have
  implementation bugs even on relatively simple parts of a specification"
  (`docs/explanation/security-model.md`, Assumptions).
- Sandbox: Podman, `--network=none`, `--cap-drop all`, `no-new-privileges`,
  seccomp, `--userns nomap`, gVisor inside (`docs/reference/sandbox-protocol.md`).
- Narrow channel: only page count, width, height and RGB bytes come out,
  bounds-checked (pages ≤ 10000, width/height ≤ 10000); 150 DPI (same file).
- Converter uses PyMuPDF (`import fitz`) and libmagic
  (`dangerzone-image: src/dangerzone_insecure_converter/doc_to_pixels.py`).
- Cost: links, forms, bookmarks, attachments, metadata lost; text only via
  OCR ("What's lost"). Advisories are all sandbox-internal CVEs (Ghostscript
  CVE-2023-43115, gst-plugins-base) fixed by image updates (`docs/advisories/`).

### Docspell (AGPL-3.0-or-later, `build.sbt` L20-23)

- Type by Apache Tika (`modules/files/.../FileSupport.scala` L19-33).
- Every file converted to PDF; PDFs optionally through OCRmyPDF to PDF/A;
  original kept as an archive file (`website/.../joex/file-processing.md`
  L97-195; ADR `dev/adr/0015_convert_pdf_files.md`).
- The default attachment URL is the converted file; `/original` is separate
  (`modules/restserver/.../AttachmentRoutes.scala` L60-72). Viewer: browser
  native (iframe) when supported, else bundled pdf.js `viewer.html`
  (`modules/webapp/.../Data/Pdf.elm`; `AttachmentRoutes.scala` L144).
- No active-content validation found.

### Mayan EDMS (GPL-2.0, `LICENSE`)

- Type via `file` command or Perl mimeinfo backends
  (`mayan/apps/mime_types/backends/`).
- Pages rendered server-side with poppler `pdftoppm` (300 DPI default, command
  timeout) and Pillow with a configurable `MAX_IMAGE_PIXELS`
  (`mayan/apps/converter/backends/python.py` L26-90; `converter/literals.py`
  L90); UI fetches page images (`documents/api_views/*PageImageView`).
- ClamAV is a "file metadata" driver: results are recorded
  (`mayan/apps/file_metadata_clamav/drivers.py`). Whether it blocks: unverified.

### Papermerge (Apache-2.0)

- Closest to "validate by parsing with a mature library":
  `detect_from_content` (own magic-byte table: PDF, JPEG, PNG, TIFF), then
  `validate_file_structure` opens PDFs with **pikepdf (qpdf)** and requires ≥1
  page; images get Pillow `verify()` and a dimension check
  (`papermerge/core/features/document/mime_detection.py` L65-165).
- No active-content checks. Page images via `pdf2image` (poppler,
  `papermerge/core/utils/image.py`); pdf.js with default options for upload
  previews (`frontend/apps/ui/src/utils/pdf.ts`).

### Nextcloud (files_pdfviewer AGPL-3.0)

- No content validation; the viewer is the control. pdf.js viewer in an
  iframe, `enableScripting` from admin setting `enable_scripting`, default
  `no` (`lib/Controller/DisplayController.php` L67); admin text warns of
  "security risks with untrusted PDFs" (`src/components/AdminSettings.vue`
  L16); CSP set (`DisplayController.php` L72; `lib/Listeners/CSPListener.php`).
- Server-side PDF thumbnails (`OC\Preview\PDF`) are **off by default** "due
  to performance or privacy concerns" (`nextcloud/server config/config.sample.php`,
  `enabledPreviewProviders`).

### Stirling-PDF (MIT core; some directories proprietary, `LICENSE`)

- A user-invoked "sanitize" tool using Apache PDFBox: removes JavaScript name
  tree, JS open/additional actions, embedded files, XMP/info metadata, links,
  fonts (`app/core/.../api/security/SanitizeController.java` L67-160). This
  is targeted disarm (remove known-bad parts, rewrite), not rejection.

### Immich (AGPL-3.0) — images

- Original kept and served for download; thumbnails and previews are decoded
  and re-encoded with sharp/libvips, only an ICC profile attached
  (`server/src/repositories/media.repository.ts` ~L197-250).
- Notably **disables** libvips decompression-bomb limits:
  `limitInputPixels: false, unlimited: true` (same file L230-234, L436).
  Metadata stripping on derived copies follows from sharp's default of not
  copying metadata (sharp behaviour: unverified here).

### Tools and references

- **pdf.js**: GHSA-wgrm-67xf-hhpq / CVE-2024-4367 — arbitrary JS in the
  hosting origin when `isEvalSupported` was `true` (the default); fixed by
  removing eval (PR #18015). GHSA-hq66-cqwq-w95j / CVE-2026-16633 (published
  2026-07-28) — arbitrary JS when `enableScripting` is true "and no CSP for
  disallowing script-src"; affects `>= 5.6.83`, patched `6.2.108`;
  workaround "Set `enableScripting` to `false` or set a CSP". In
  `pdfjs-dist` 6.3.289 (Orbit's pin) the string `isEvalSupported` no longer
  appears anywhere in the package, so Orbit's `isEvalSupported: false` is
  inert; the removal coincides with PR #21005 dropping the PostScript
  compiler (2026-04-04) — link between the two is inference, unverified.
  `PDFViewer` defaults `enableScripting = false` (`web/pdf_viewer.mjs` L1826).
- **OCRmyPDF** (MPL-2.0): "should only be used on PDFs you trust"; repairs
  via pikepdf/qpdf, rasterises with Ghostscript `-dSAFER`, "is not a tool
  designed for sanitizing PDFs" (`docs/pdfsecurity.md`).
- **qpdf** (Apache-2.0): `--check` "merely checks that the PDF file is
  syntactically valid", no page-content or semantic validation
  (`manual/cli.rst` L3380-3390). Has `--decrypt`, `--remove-restrictions`,
  `--flatten-annotations`, `--remove-acroform`, `--remove-info`,
  `--remove-metadata` (same file). pikepdf (MPL-2.0) is its Python binding.
- Licences: Ghostscript AGPL-3.0-or-later (`ghostpdl/LICENSE`); PyMuPDF
  AGPL-3.0; pdf.js, Tika Apache-2.0. Gotenberg (MIT) is a containerised
  conversion API wrapping Chromium, LibreOffice, qpdf, pdfcpu (`pkg/modules/`).
- **pdfid** (Didier Stevens): "not a PDF parser ... scan[s] a file to look
  for certain PDF keywords" (/JS, /JavaScript, /AA, /OpenAction, /Launch,
  /EmbeddedFile, /XFA, /ObjStm, /Encrypt ...), handles `#xx` name
  obfuscation, "will also generate false positives"; purpose is triage
  before manual analysis (https://blog.didierstevens.com/programs/pdf-tools/).
  peepdf: not checked.
- **CDR as industry pattern**: UK NCSC "Pattern: Safely Importing Data" —
  "transforming complex file formats into simple ones", syntactic and
  semantic verification, and "transformation should be a low side activity
  because it is inherently risky to parse and process untrusted content"
  (https://www.ncsc.gov.uk/guidance/pattern-safely-importing-data).

## Patterns

Ranked by how common they are in the projects surveyed.

**A. Detect type from magic bytes.** Universal. Stops wrong-parser routing;
costs nothing; says nothing about safety.

**B. Keep the original; show a derived copy.** paperless (PDF/A archive when
made, thumbnails), Docspell, Mayan, Papermerge, Immich, Orbit (page-one
image). Protects what people *see* (viewer exploits, metadata); the
original stays downloadable, so downloads need their own headers. Cost:
storage, CPU, a renderer (Ghostscript/poppler GPL-family; pdf.js/libvips
permissive).

**C. Disable active features in the viewer instead of rejecting files.**
paperless (pdf.js, no scripting manager), Nextcloud (scripting off + CSP);
pdf.js's own advisories give "disable scripting or set a CSP" as the fix.
Covers JS, actions and XFA where they would run. No fidelity cost; needs
pdf.js kept patched (two origin-level script CVEs since 2024). No help for
a downloaded file opened in another reader.

**D. Resource limits.** Pixel caps (paperless, Mayan, Orbit), ImageMagick
policy (paperless), page caps (Dangerzone, Orbit), timeouts (Mayan,
Dangerzone). Addresses bombs and exhaustion. Common but not universal
(Immich turns libvips limits off). Always bespoke configuration.

**E. Normalise through a mature library.** OCRmyPDF = pikepdf/qpdf repair +
Ghostscript PDF/A rewrite (paperless and Docspell, optional); Papermerge
uses "qpdf opens it" as validity. Addresses malformed structure and
parser differentials (downstream reads one canonical rewrite); OCRmyPDF
says it is *not* a sanitiser. Cost: Ghostscript is AGPL (compatible with
Orbit's AGPL-3.0-or-later) with a steady CVE record; qpdf is Apache-2.0
C++ (sidecar or native binding from Node); PDF/A drops encryption and
breaks signatures.

**F. Antivirus scan.** Orbit (fail-closed), Mayan (optional). Not in
paperless, Docspell, Papermerge; Dangerzone rejects it (misses 0-days).
Known malware only. Cost: ClamAV memory and updates.

**G. Sandbox the parsers.** Only Dangerzone (gVisor, no network, narrow
pixel channel). Others run Ghostscript/poppler/ImageMagick in the app
container; Orbit isolates Tika but runs pdf.js in-process. The only
pattern that addresses parser code execution. Cost: orchestration,
per-document latency.

**H. Rasterise and rebuild (CDR).** Dangerzone, after Qubes trusted PDF;
NCSC recommends transformation generally. Removes every active and
structural threat from the output. Lossy (links, forms, text layer without
OCR, metadata), CPU-heavy, and only safe together with G. Rare.

**I. Reject files containing active content.** Only Orbit. Stirling-PDF
*removes* such parts on request; pdfid flags them for triage. Cost: false
refusals of ordinary PDFs (forms, attachments, modern object/xref
streams) and a second parser whose reading can differ from the renderer's.

## Where Orbit's checker sits

- Orbit already has A, B (page-one image), D, F and part of G (Tika). The
  checker is pattern I built as pdfid-style keyword scanning plus a pdf.js
  object walk, with its own object-stream decoder and xref reader.
- **The standard patterns would make unnecessary**: rejecting JS, actions
  and XFA for viewing (C: Orbit shows a server-drawn image and downloads
  are attachments, so no Orbit-origin pdf.js runs document scripts); the
  hand-written object-stream/xref parsing and much malformed-structure
  refusal (E: a qpdf rewrite gives downstream one canonical file, removing
  the checker-versus-renderer differential instead of guarding it).
- **Orbit would still need**: A; D (page, pixel, decoded-bytes, time limits
  stay bespoke everywhere); F; download headers (attachment, nosniff, CSP);
  a decision on encrypted PDFs (paperless accepts them); a decision on
  whether attachments/launch actions in a downloaded original are stripped
  (E/H), refused (I) or accepted (paperless, Docspell, Nextcloud); and
  isolation (G) for whatever parses the original — every project except
  Dangerzone accepts parser-RCE risk in the main container.
- Fact check against the brief: in this worktree pdf.js runs only
  server-side (`validation.ts`, `preview.ts`); no browser pdf.js import
  found; downloads are `Content-Disposition: attachment`
  (`docs/document-threat-model.md`, "Download safety").
