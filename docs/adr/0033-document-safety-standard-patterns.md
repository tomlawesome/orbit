# ADR-0033: Uploaded PDFs and images are kept safe the way established document systems do it, not by a checker of our own

**Status:** Accepted (owner, 2026-10-07, with the scan-first amendment)
**Date:** 2026-10-07
**Relates to:** #1291 (ordinary PDF refused), #1292 (encrypted object streams
refused), #1293 (checker and renderer can disagree), #1294 (`isEvalSupported`
is a dead option); `docs/document-threat-model.md`; ADR-0010 (scanning);
research note `pdf-safety-research.md` (paperless-ngx, Dangerzone, Docspell,
Mayan, Papermerge, Nextcloud, Stirling-PDF, Immich)

## Context

Orbit refuses a PDF at upload if its own byte-and-regex checker
(`src/server/documents/validation.ts`) finds JavaScript, actions, XFA,
embedded files, encryption, or a layout it cannot read. Twice on 2026-10-07
it refused ordinary real-world PDFs (#1291); it still refuses "no editing"
certificates (#1292); and because it reads the file front to back while the
renderer follows the cross-reference table, a crafted file can show the two
different things (#1293). The checker is roughly 500 lines of PDF, JPEG and
PNG parsing that nobody else maintains.

The survey of eight open-source document systems found that none of them
refuses a PDF for active content at upload. The standard controls are, in
the research note's names: **A. detect type from magic bytes**; **B. keep
the original, show a derived copy**; **C. disable active features in the
viewer instead of rejecting files** (pdf.js's own advisories give "scripting
off, or a content security policy" as the fix); **D. resource limits**;
**F. antivirus scan** (less common); and, where a file must be proven
openable, **E. a mature library opens it and finds at least one page**
(Papermerge). Only Dangerzone sandboxes parsers (**G**) and rebuilds files
from pixels (**H**); only Orbit rejects active content (**I**).

What Orbit already has: A, B (a server-drawn page-one picture is the only
thing a browser ever renders; downloads are attachments under
`default-src 'none'; sandbox` and `nosniff`), D, F (ClamAV, fail-closed),
and part of G (Tika in an isolated container). Orbit has no in-browser PDF
viewer; pdf.js runs only in the server, drawing page one.

## Decision

1. **Adopt patterns A, B, C, D, E and F; retire I.** Orbit stops refusing
   PDFs for what they contain and relies on what every surveyed project
   relies on: the file is shown through a derived picture, the renderer runs
   nothing a PDF carries, limits bound the cost, and ClamAV catches known
   malware (it also looks inside a PDF's embedded streams).
2. **Scan first; nothing opens the file before it passes.** The owner's
   amendment on #1293: "ideally we should virus scan first before
   _anything_ opens it. We keep the user informed, then tell them we've moved
   onto generating a preview." The order for every route in is: type the file
   by its magic bytes; ClamAV scans it; only then does the renderer (pdf.js
   for a PDF, the image decoder for a JPEG or PNG) open it and find a page;
   then the preview is drawn. No parser, decoder or Tika sees a byte of the
   file until the scan has passed. Where the scan is held for recovery
   (ADR-0010), the open check waits for the recovery scan; a file that has
   not been scanned is never opened. The reading card tells the reader it is
   scanning, and then that it has moved on to generating the preview.
3. **The bespoke checker is retired.** `classifyDocumentStructure` keeps its
   signature (five call sites: upload, repository, drafts, mail-in,
   preview) but its body becomes pattern E: pdf.js, the library that will
   draw the file, opens it with no password and reports at least one page;
   for an image, the header's dimensions are within the cap and the preview
   renderer's own decoder reads it. The regex name scan, the hand-written
   cross-reference and object-stream readers, and the JPEG marker and PNG
   chunk walkers are deleted. Bespoke remainder, with the one-sentence
   reason: resource limits (page count, pixel cap read from the image header
   before decoding, byte and time budgets) stay local configuration because
   no library sets them for us.
4. **The viewer is the server-side renderer, and it must enforce C.** One
   option set (`PDF_STRUCTURE_PARSER_OPTIONS`) serves the open check and the
   page-one renderer: `enableXfa: false`, no worker, no network or range
   fetching, no system or browser fonts, no WebAssembly. Scripts need no
   switch: pdf.js runs document scripts only through the viewer's annotation
   layer and scripting manager, which Orbit never builds, so nothing a PDF
   carries can run in the server (#1294 found that `isEvalSupported` and
   `enableScripting` are not options of the installed pdf.js at all, and
   removed both). The option object is typed with `satisfies` against
   pdf.js's own parameter type, so an option the pinned version does not
   know fails the type check instead of silently doing nothing. Preview and
   download headers stay as they are. If Orbit ever adds an in-browser PDF
   view, it gets pdf.js with scripting off plus a page CSP, as Nextcloud
   does.
5. **No normalised copy is served.** Orbit serves no PDF inline, so a qpdf or
   Ghostscript rewrite would add a native dependency for no user-visible
   change. Not adopted now; any future addition goes through the owner's
   dependencies-and-data process (qpdf is Apache-2.0, Ghostscript AGPL,
   both compatible with Orbit's AGPL-3.0-or-later).
6. **Refusals that remain at upload, and why:** not a PDF, JPEG or PNG by
   magic bytes (A); over the size limit, over 1,000 pages, over the pixel
   cap (20,000 pixels a side, 40 million in all), or over the five-second
   time budget (D); pdf.js or the image decoder cannot open it, or it has no
   pages (E, `unsupported_structure`); it needs a password to open
   (`password_required`), because nothing in Orbit could show, read or scan
   it (product reason, not a safety one); ClamAV reports malware, or is
   required and unreachable (F, unchanged). `prohibited_content` no longer
   refuses anything and is gone from the vocabulary.
7. **#1292 resolves** by the same step: pdf.js decrypts an owner-password-only
   PDF itself, so "no editing" certificates are accepted. **#1293 resolves**
   by removing the second reader: with one parser there is nothing for it to
   disagree with, and the scan now runs before that parser. Both close on
   this ADR, with a fixture each proving the new behaviour.
   `docs/document-threat-model.md` is rewritten to match.

## Consequences

- Accepted from now on: ordinary modern PDFs, forms, PDFs with scripts,
  open actions, XFA, attachments, owner-password-only encryption or
  encrypted object streams, as long as pdf.js opens them. Their scripts never run in Orbit; a household member
  who downloads the original and opens it in another reader is in the same
  position as with any email attachment, which is the position paperless,
  Docspell and Nextcloud users are in. The threat model says so plainly.
- Images are accepted if the header dimensions are within the cap and the
  preview renderer decodes them.
- Scan first changes the order of every route in: upload, the create form's
  inspection, mail-in and the pre-attachment preview all scan before the
  open check, and an upload held for a scanner outage is opened only after
  its recovery scan. A file the open check then refuses still leaves no
  durable metadata. The reading card shows two stages to the reader,
  scanning and then generating the preview, so a wait is never unexplained.
- A scanner outage still holds or refuses the file exactly as before (held
  for recovery on upload, refused on inspection, preview and mail-in); the
  difference is that nothing else touches the file in the meantime.
- Roughly 500 lines of parsing code and their tests are deleted.
- pdf.js remains the one parser of untrusted bytes in Orbit's own process,
  as it is today for previews, and it now opens only files ClamAV has
  passed; keeping it patched is the standing cost.
- The upload error vocabulary loses `prohibited_content`; the messages for
  "could not open this document" (`unsupported_structure`) and "needs a
  password" (`password_required`) are new and plain.

## Alternatives considered

- **Keep the checker and fix its bugs** (#1291's route). Rejected: it is
  pattern I, which no surveyed project uses, and each fix trains it to the
  last specimen rather than to the format (the owner's point on #1293).
- **Rewrite through qpdf or OCRmyPDF (E in full)** as paperless and Docspell
  offer optionally. Deferred: it buys a canonical file for downstream
  parsers Orbit does not have, at the cost of a native dependency.
- **Rasterise and rebuild in a sandbox (G + H, Dangerzone).** Rejected as
  disproportionate for a household app on modest hardware: it loses links,
  forms and the text layer, and needs per-document container orchestration.
- **Strip scripts and attachments from downloads (Stirling-PDF's sanitise).**
  Not now: it needs a PDF-writing library and changes the user's own file.
- **Warn on download that a file carries scripts or attachments.** Not
  adopted: no surveyed project does it; may be revisited as a product idea.
