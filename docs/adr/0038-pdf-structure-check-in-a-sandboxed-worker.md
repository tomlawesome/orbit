# ADR-0038: The PDF structure check opens the file in a memory-capped, killable worker

**Status:** Proposed (implemented with the #1316 fix; accepted when it merges)
**Date:** 2026-10-15
**Amends:** [ADR-0033](0033-document-safety-standard-patterns.md) item 3 (the
open check's resource limits)
**Relates to:** #1316 (hostile cross-reference data), #1427 (the page renderer
gets the same treatment, amendment below); `docs/document-threat-model.md`

## Context

ADR-0033 made the structure check pattern E: pdf.js opens the file and finds
page one, in Orbit's own process, under a five-second timer. The timer cannot
stop synchronous work, so item 3 added one bespoke bound: a file whose
cross-reference data declares over 1,250,000 entries is refused before pdf.js
opens it.

That bound is a model of how pdf.js reads a file, and pdf.js reads leniently:
it recovers from broken offsets, scans for objects, and accepts separators and
number forms a strict reader would not. Each round of review found another way
in that the model did not follow, and each fix trained it on the last specimen.
Meanwhile the cost of a miss was the whole server: a few-kilobyte file, which
mail-in accepts from anyone, could freeze the single Node process or exhaust its
memory.

## Decision

1. **Parse untrusted input in an isolated, memory-capped, killable worker.**
   The standard pattern for a parser that may misbehave (browsers' utility
   processes, Dangerzone's containers; ADR-0033's pattern G). The structure
   check's pdf.js open runs in a Node worker thread
   (`src/server/documents/pdf-structure-sandbox.ts`), one per check, with its
   own heap limits. The server's thread never runs the parser for this check.
2. **Limits, and why.** 128 MB old-generation heap, 16 MB young generation and
   4 MB of stack: legitimate files, a thousand pages included, parse in about
   20 MB, and a runaway allocation hits the cap within a second. A five-second
   wall clock from the moment the worker is running (its `online` event), the
   check's existing budget: a worker can be terminated mid-loop, unlike a
   promise, and a slow thread start-up does not eat the budget. At most two checks at once, so a
   burst of hostile files costs two capped heaps, not one per file; the rest
   wait, and waiting does not count against their limit.
3. **Running out of memory, timing out or crashing refuses the file** as
   `unsupported_structure`, and logs one bounded record naming which of the
   three it was and no file detail. A crash logs as a warning, because a
   parser that cannot load would refuse every PDF.
4. **The entry-count bound of ADR-0033 item 3 stays, frozen,** as a cheap first
   fence that refuses the known shapes before a worker starts. It is no longer
   the thing that keeps the server up, so it is not extended to chase further
   entry paths.
5. **A heap flag disables the memory cap.** Node silently ignores a worker's
   heap limits when the process runs with `--max-old-space-size` or a similar
   flag, directly or in `NODE_OPTIONS`. Production runs plain `node`; boot
   checks the cap with a trivial worker and logs a warning if it is not
   enforced, and the project's agent instructions forbid the flag in test runs.
   The wall clock still applies either way.
6. **V8's heap limits do not count ArrayBuffer memory, so a watchdog does.**
   `resourceLimits` caps the JavaScript heap only; typed arrays and their
   buffers live outside it, and pdf.js decodes a compressed stream into a
   growing buffer until the stream ends. A file of about 130 KB grew the
   process to 391 MB and was accepted in 2.8 s; two 510 KB ones at
   once reached 2,211 MB. The fix is the standard resource watchdog, as a
   cgroup memory limit kills a process (here the worker is the unit): from
   the moment the worker is online the server polls
   `worker.getHeapStatistics()` every 25 ms and kills the worker, logging a
   memory stop, once its `external_memory` passes the file's own size plus
   64 MB. The file counts because the worker holds it (a 98 MB legitimate
   file measured 104 MB in all). Measured with the watchdog: the 130 KB file
   is stopped at 0.54 s with the process at 184 MB, the two 510 KB ones at once
   peak at 274 MB, and every legitimate test file still passes. A Node that
   lacks `getHeapStatistics` on workers leaves only the heap cap and the
   clock; boot logs a warning.
7. **The worker gets an empty environment** (`env: {}`). By default a worker
   sees a copy of `process.env`, which holds the server's secrets; the parser
   needs none of it.

## Consequences

- A hostile file costs at most one capped worker and a few hundred
  milliseconds; the server keeps answering.
- Each PDF check costs about 300 ms more (starting a worker and loading pdf.js
  in it), on top of the scan that already precedes it. The preview path runs
  the check before each render, so a page preview pays it too. Test suites
  that open many PDFs are slower by the same amount per check.
- The worker is evaluated from source text, because the bundled server emits
  no separate worker file; it imports pdf.js by the file URL the server
  resolves. `scripts/web-pdfjs-runtime-check.mjs` calls the built server's
  check to prove that resolution survives the build.
- The page renderer runs in the same sandbox (amendment below, #1427), so
  pdf.js never runs on the server's thread.

## Amendment, 2026-10-15: the page renderer runs in the sandbox too (#1427)

Owner decision 5a (2026-10-15). The renderer (`preview.ts`) opened PDFs on the
server's thread after the same bytes passed the check, and drawing a page
decodes what the check never opens: content streams, fonts and images. A
131 KB content-stream bomb passed the check and decoded 260 MB in 2.0 s on the
server's thread when its preview was opened, beyond the reach of the render
budget's timer. The standard pattern applies unchanged: render untrusted
documents in an isolated, memory-capped, killable worker, as browsers do.

1. **One worker run per preview,** in `pdf-structure-sandbox.ts`: open, the
   check's own gate (no password, 1 to 1,000 pages, page one found), the
   asked-for page, drawn on white to a PNG at most 1,200 pixels a side, sent
   back as a transferred buffer. The preview path no longer runs a separate
   check first, so a preview costs one worker, not two (about 0.4 s for a
   text page). The pre-parse entry-count bound still runs first.
2. **Limits.** The same heap caps, two-at-once slots (shared with the check),
   `env: {}` and 25 ms memory poll. The wall clock is the render budget
   (`DOCUMENT_PREVIEW_RENDER_BUDGET_MS`, ten seconds, from `online`). The
   off-heap allowance is the file's size plus twice the check's
   (`externalAllowanceMb`, so 128 MB at the defaults): a 300 dpi A4 scan
   measured 55 MB, and the 128 MB content-stream bomb is stopped in about a
   second with the process growing about 155 MB. A scan large enough to pass
   128 MB already overruns the ten-second budget.

   Skia's canvas memory is counted by no V8 figure, so every scratch canvas
   pdf.js draws on is booked by the worker's own canvas factory
   (width x height x 4 bytes; `create` adds, `reset` adjusts, `destroy`
   subtracts, the preview's own page canvas booked first) against
   `canvasAllowanceMb`, 256 MiB by default (owner decision 3c, 2026-10-15). A
   request past it is refused before anything is allocated, and the render
   is stopped as a memory stop. pdf.js's `maxImageSize` (40 Mpx) stays as the
   bound on one image. Measured peak live canvas, the 848x1200 page canvas
   (3.9 MiB) included: a 1-bit image mask of 4960x7016, 182 MiB; of 5316x7522
   (the largest A4-shaped image the 40 Mpx cap admits), 208 MiB; a 1-bit or
   8-bit DeviceGray or RGB image at 5316x7522, 204 MiB; a 300 dpi RGB page
   with a soft-masked transparency group, 53 MiB. A reported 3 KB soft-mask
   file (80 soft-masked fills; pdf.js keeps every group's scratch canvas until
   the page ends) reached 1.5 GB in 9.8 s before the allowance. With it, the
   test suite's copy of that file is stopped as memory in about five seconds
   at 256 MiB, and well under a second at 32 MiB: live canvas grows at about
   50 MiB a second, so the stop comes when the allowance is reached, not by
   the clock. The process bound measured on glibc
   is roughly four times the allowance, because freed ImageData chunks are
   not returned to the operating system; the production image's allocator
   was not measured.
3. **Answers.** A refusal the check would make answers
   `document_preview_unsupported` with the check's reason; a page past the
   end, `document_preview_page_not_found`; a timeout, `document_preview_failed`
   logged as `processing_interrupted`; a memory stop, a crash or a render
   error, `document_preview_failed`. A memory or crash stop also logs one
   bounded `document.preview` record naming which it was; a timeout is
   already named by the refusal record.
4. **The canvas backend loads in the worker** by the file URL the server
   resolves, like pdf.js; the worker pins its own `Path2D`, `DOMMatrix` and
   canvas factory to that copy (#476, #493). The image gate
   (`scripts/web-pdfjs-runtime-check.mjs`) draws a page through the built
   server's renderer to prove the bundle still finds both.
5. **A start-up deadline, for both jobs.** A worker that is not online within
   five seconds (`startupMs`) is stopped and counted as a crash: before this,
   a worker that never came online had no clock and held its slot.
6. **No in-process reader.** `tests/unit/pdf-no-in-process-reader.test.mjs`
   fails if anything under `src/server` other than the sandbox names
   `pdfjs-dist` outside a type-only import.

## Alternatives considered

- **`RLIMIT_AS` on the process.** Rejected: Node crashes at start under any
  useful limit, because V8 reserves large address ranges it never touches.
- **`RLIMIT_DATA` on a child process per check.** Rejected for now: the
  image's Alpine/BusyBox userland could not be verified to apply it here, and
  it costs a full Node start per check.
- **A decoded-length limit in pdf.js.** pdf.js has none to set.
- **Pre-scanning streams for their decoded size.** Unsound, for the same
  reason as item 4: it models a lenient parser and would chase every filter
  chain.

- **Keep extending the pre-parse bound.** Rejected: it models a lenient parser
  and kept missing paths; this is the treadmill ADR-0033 retired for content
  checks.
- **A child process or container per check.** Stronger isolation, but heavier
  start-up and more moving parts for the same failure classes (memory, time,
  crash); a worker thread with heap limits covers them. Revisit if pdf.js ever
  needs native code for the open.
- **A long-lived worker pool.** Faster, but a worker that has parsed one
  hostile file is not trusted with the next, and a fresh worker per check is
  what makes the kill simple.
