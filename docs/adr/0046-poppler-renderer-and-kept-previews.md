# ADR-0046: PDF checks and page draws run poppler in a kernel-limited child; page previews are drawn once and kept encrypted

**Status:** Accepted (owner decision, 2026-10-15; ceilings and cap, owner, 2026-11-07)
**Date:** 2026-11-07
**Supersedes in part:** [ADR-0038](0038-pdf-structure-check-in-a-sandboxed-worker.md):
the renderer, the structure check, the pre-parse index bound and the memory
fences. The supervisor, the empty environment, the stop-is-no-verdict rule
and the logging vocabulary of ADR-0038 stand.
**Amends:** [ADR-0033](0033-document-safety-standard-patterns.md) item 3 (the
open check is `pdfinfo`; the index bound is retired)
**Relates to:** #1436 (memory a check or preview needs), #1433 (previews drawn
once and kept), #1434 (600 dpi scans must preview inside the budget);
`docs/document-threat-model.md`

## Context

ADR-0038 moved PDF parsing into a supervised Node child running pdf.js with a
process-memory watchdog. Measured on the shapes the product is for (phone
photos, home-scanner output, emailed bills), the child needed 105-120 MB for
a one-page text file, 213-280 MB for a 300-600 dpi scan, 400-590 MB for a
1-bit scan or a damaged 97 MB index, and failed the 600 dpi colour scan
inside 30 s. The ceilings were set at 320 MB (+5x file) for a check and
768 MB (+1x file) for a draw, which on the 2 GB default memory limit left room
for two jobs at a time, shared by upload checks, mail-in checks and page
turns; thirty page turns delayed an upload check by 6.8 s. pdf.js's memory
shape also made the kernel's address-space limit unusable (V8 reserves tens of
GB of address space), so the only limit was `RLIMIT_DATA` plus the watchdog.

The owner decided (2026-10-15) that the renderer becomes poppler's `pdftoppm`
as a separate program, and that every page is drawn once and kept, encrypted
at rest, so a page turn does not draw.

## Part A: poppler as the renderer and the checker (#1436)

### Decision

1. **Page draws run `pdftoppm`, one process per page**, through the
   `/bin/sh` wrapper of ADR-0038 with `ulimit -t` (CPU) and `ulimit -v`
   (address space), an empty environment, the plaintext handed over as an
   inherited read-only descriptor (`/dev/fd/4`) to an unlinked file on the
   memory-backed quarantine, and the page returned on stdout as JPEG
   (quality 85, long edge `DOCUMENT_PREVIEW_MAX_EDGE` = 1,200 px, `-cropbox`).
   The input is never piped through stdin: poppler then holds the whole file
   in memory and rebuilds a damaged index twelve times slower.
2. **The structure check runs `pdfinfo -f 1 -l 1`**: exit 0 with `Pages: N`
   (1 <= N <= cap) and page one's size is `supported_structure` and carries
   the page count, which is stored on the document; exit 1 with `Incorrect
   password` is `password_required`; any other answer is `unsupported_structure`;
   a stop is `structure_check_unavailable`, no verdict, as before.
   Owner-password-only files open, as before.
3. **The pre-parse index bound (`hasPdfIndexBudget`) is retired.** It
   modelled pdf.js's cross-reference reading; pdf.js reads nothing now, and
   poppler rebuilds a damaged 97 MB index in 0.9 s inside 13 MiB. ADR-0033
   item 3 and ADR-0038 item 4 are amended accordingly.
4. **Fences**, in the order that fires first: wall clock from spawn (check
   5 s, draw 15 s, SIGKILL); process-memory watchdog (`VmRSS`+`VmSwap` every
   25 ms; check 64 MiB, draw 256 MiB, no file multiple); `RLIMIT_AS` at the
   ceiling plus 128 MiB; `RLIMIT_CPU` at the wall clock plus 5 s; and the
   answer checked (exit 0, no `Out of memory` on stderr, a JPEG of 3 bytes
   to 4 MiB with a long edge of at most 1,200 px). poppler survives a failed
   allocation by printing `Out of memory` and drawing a blank, so that string
   on stderr is a memory stop whatever the exit code says. `RLIMIT_DATA` is
   dropped.
5. **Three slot pools** replace the shared pair: `check` (2: structure and
   image checks), `view` (2: a page someone is looking at), `background`
   (1, `nice -n 10`: Part B's drawer). A check never waits behind a draw.
6. **The page cap is 100** (`PDF_STRUCTURE_MAX_PAGES`), bounding kept-preview
   storage and background work, not memory.
7. **Dependencies.** Alpine packages `poppler-utils` and `poppler` 25.12.0-r1
   (GPL-2.0-or-later) and `font-liberation` 2.1.5-r2 (OFL-1.1, metric
   substitutes for the base-14 fonts), installed in the runner stage, with
   `fc-cache -f`. The libraries they pull in were read from the installed
   package database of the production base image (Alpine 3.24.4):
   `fontconfig` 2.17.1-r1 (MIT), `lcms2` 2.19-r0 (MIT), `libjpeg-turbo`
   3.1.3-r0 (BSD-3-Clause AND IJG AND Zlib), `openjpeg` 2.5.4-r2
   (BSD-2-Clause). `poppler-data` (the CJK CMaps, Adobe licences) is not
   installed and not needed for the shapes measured. Provenance: poppler is
   freedesktop.org's, the PDF library of most Linux desktops, maintained for
   two decades by a team; Liberation is Red Hat's. The owner chose poppler
   (2026-10-15).
   Orbit executes `pdftoppm` and `pdfinfo` as separate programs over argv, a
   descriptor and pipes and links nothing of poppler: arm's-length use,
   separate works. The image distributes GPL binaries whose source is
   Alpine's aports at the installed versions; `docs/supply-chain.md` records
   it. `pdfjs-dist` is removed; `@napi-rs/canvas` stays for image documents.
   **Staying behind upstream, deliberately.** Upstream poppler is 26.11.0;
   the image takes 25.12.0 because it installs from the base image's Alpine
   release, which pins 25.12 and backports security fixes (what blocks the
   upgrade). Staying costs the parser improvements of eleven monthly
   releases, none of them security fixes Alpine has not carried (the risk).
   The trigger to reconsider is the base image moving to Alpine 3.25, or a
   poppler CVE Alpine has not backported, which is a reason to rebuild early.

### Measured (production base image, 2026-11-07)

Peak resident memory of the child, one page at 1,200 px: text page 14 MiB
(57 ms); 12 Mpx photo 20 MiB (258 ms); 300 dpi colour scan 17 MiB (152 ms);
600 dpi colour scan 18 MiB (406 ms, was 31-44 s and failing); 1-bit 40 Mpx
16 MiB; page 100 of 100 14 MiB; 97 MB file with a broken index 13 MiB
(0.9 s). `pdfinfo` 6-8 MiB, 11-23 ms. Hostile shapes (128 MB content
stream, 900 Mpx image, 150 shadings, 80 soft masks, tiling bombs) all under
20 MiB; the cost is CPU, bounded by the clock. The one legitimate shape that
needs memory is JPEG 2000, which OpenJPEG decodes whole before poppler
scales it: 122 MiB at 300 dpi colour, 508 MiB at 40 Mpx; the 256 MiB ceiling
refuses JPX above about 18 Mpx.

### Implementation notes

- The wrapper also unsets `PWD` and `SHLVL` before `exec`: dash and BusyBox
  ash export them even when started with an empty environment, and the
  child's environment must be empty.
- A page draw also runs `pdfinfo` only when the caller has no stored page
  count (a document from before this change) or `pdftoppm` exits 99 (page
  out of range), so a page past the end answers with the count.
- Plaintext the server holds only as bytes (the preview of a stored
  document or a mail-in attachment) is written to an owner-only file in the
  quarantine root and unlinked before the child starts; the child reads it
  through descriptor 4.
- Image documents keep their Node sandbox child with its own process-memory
  ceiling (768 MB, `imageMemoryMb`), separate from the 256 MiB PDF draw
  ceiling, and take the `check` or `view` pool.
- `scripts/pdf-renderer-runtime-check.mjs` replaces the pdf.js runtime check
  in the image build: `pdfinfo` and `pdftoppm` through the same wrapper on a
  Helvetica text page, the JPEG decoded with the shipped canvas, and
  `fc-match Helvetica` naming Liberation Sans.

### Consequences

- Memory per PDF job falls from 320-768 MB (+file) to 64-256 MiB with a hard
  kernel backstop; the 2 GB default limit now holds five children in the
  worst case with room to spare.
- A 600 dpi colour scan previews in well under a second (#1434 closed by
  measurement).
- One PDF parser is patched and trusted, not two; the index-bound treadmill
  ends.
- The image is about 10 MB smaller (pdf.js out, poppler and its libraries in).
- A GPL program is in the image; Orbit's code does not link it.
- A JPEG 2000 page above about 18 Mpx is refused rather than drawn.
