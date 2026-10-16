# ADR-0038: The PDF structure check opens the file in a memory-capped, killable worker

**Status:** Proposed (implemented with the #1316 fix; accepted when it merges)
**Date:** 2026-10-15
**Amends:** [ADR-0033](0033-document-safety-standard-patterns.md) item 3 (the
open check's resource limits)
**Relates to:** #1316 (hostile cross-reference data), #1427 (the page renderer
gets the same treatment, and each job becomes a child process killed at a
process-memory ceiling, amendments below); `docs/document-threat-model.md`

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
5. *(Withdrawn by the second amendment, item 3: the heap caps are now the
   child process's own flags, which a flag on the server cannot override.)*
   **A heap flag disables the memory cap.** Node silently ignores a worker's
   heap limits when the process runs with `--max-old-space-size` or a similar
   flag, directly or in `NODE_OPTIONS`. Production runs plain `node`; boot
   checks the cap with a trivial worker and logs a warning if it is not
   enforced, and the project's agent instructions forbid the flag in test runs.
   The wall clock still applies either way.
6. *(Superseded by the second amendment, item 2: the watchdog now reads the
   child process's whole resident memory.)*
   **V8's heap limits do not count ArrayBuffer memory, so a watchdog does.**
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

   *(This paragraph is superseded by the second amendment, item 2: the canvas
   booking is removed, and the process-memory ceiling counts canvases with
   everything else.)* Skia's canvas memory is counted by no V8 figure, so every scratch canvas
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

- **`RLIMIT_AS` on the child process.** Rejected (reason corrected in the
  second amendment): on glibc, malloc arenas put a fresh child at 3.5 GB of
  address space, so Node fails at start under 2 GB; on musl a child starts,
  but every page draw fails, because pdf.js reserves a WebAssembly memory with
  a guard region of about 10 GB while drawing an image. A legitimate scan
  needs 12-14 GB of address space, so no limit that bounds anything lets it
  draw (measured at 1.5, 2, 4 and 16 GB).
- **`RLIMIT_DATA` on the child process.** Adopted as a backstop, not as the
  fence (second amendment, item 4): verified in the production image, where
  BusyBox `sh` applies `ulimit -d`. Not the fence because kernels before 4.7
  count only `brk` and Skia's bitmaps are `mmap`ed, because its value depends
  on V8's untouched reservations, which a Node upgrade can move, and because
  it ends the child with an allocator error rather than a clean stop.
- **A decoded-length limit in pdf.js.** pdf.js has none to set.
- **Pre-scanning streams for their decoded size.** Unsound, for the same
  reason as item 4: it models a lenient parser and would chase every filter
  chain.

- **Keep extending the pre-parse bound.** Rejected: it models a lenient parser
  and kept missing paths; this is the treadmill ADR-0033 retired for content
  checks.
- **A child process or container per check.** First rejected as heavier
  start-up for the same failure classes. Adopted for the child process by the
  second amendment: a process costs only 50-100 ms more than a worker thread
  (Node boot), and only a process has a memory figure of its own; a worker
  thread's share of the process cannot be measured, so every worker-side fence
  counted one allocator at a time and the round-4 review found native memory
  each of them missed. A container per job is still not used: it would need
  a container runtime inside the image.
- **A long-lived worker pool.** Faster, but a worker that has parsed one
  hostile file is not trusted with the next, and a fresh worker per check is
  what makes the kill simple. The same holds for child processes: one per job,
  no pool.

## Amendment, 2026-10-15: one process per job, killed at a process-memory ceiling (#1427, round-4 review)

Owner decisions 5a and 6a (2026-10-15): the ceilings below, shipped in v0.3.

1. **The worker thread becomes a child process,** one per job (`node -e`,
   the same source strings, the same file-URL imports for pdf.js and the
   canvas backend), started through `/bin/sh -c 'ulimit -d N; exec node …'`
   with an empty environment, stdout discarded and the file sent over the IPC
   channel. The reason: canvas, pattern, image and font memory is native
   memory no V8 figure or allocator hook sees, and a worker thread's share of
   the process cannot be measured; a process's can. The round-4 finding:
   pattern and shading snapshots kept native pixel copies the canvas booking
   never saw; a 1 KB tiling file reached 1.4-1.9 GB, and the soft-mask file
   the booking was built for drew at 1.5 GB without it. The child does not
   inherit the server's environment; it runs as the same user, so this is
   not isolation from the server's files or /proc (or the network).
2. **The fence is a process-memory watchdog,** the standard supervisor that
   kills, as a cgroup `memory.max` does: every 25 ms the server reads the
   child's memory, resident plus swapped (`VmRSS` plus `VmSwap`, from one
   read of `/proc/<pid>/status`, kB whatever the page size; no `VmSwap` line
   counts as none, so a child cannot slip under the ceiling by being swapped
   out; round-5 review, #1316) and kills it with SIGKILL once it passes `renderMemoryMb` (768 MB) plus the
   file's size or `structureMemoryMb` (320 MB) plus **five times** the file's
   size (owner decision 7a, 2026-10-15; see the sizing note below); the stop is
   logged as memory. This replaces both the `external_memory`
   watchdog (item 6) and the canvas allowance (first amendment, item 2),
   whose paragraphs are marked superseded. Measured child RSS, glibc host and
   the production (musl) image:

   | Case | Peak RSS | Time | Note |
   |---|---|---|---|
   | child ready | 85 MB musl / 94 MB glibc | 0.23-0.38 s | baseline |
   | one-page text PDF, render | 105-119 MB | 0.47-0.63 s total | about 0.1 s more than the worker |
   | 1-bit mask 5316x7522 (largest the 40 Mpx cap admits) | 398-458 MB | 1.1-1.5 s | drawn |
   | 1-bit gray 5316x7522 | 406-410 MB | 1.1-1.6 s | drawn |
   | 300 dpi RGB, image soft mask and group | 187-219 MB | 1.1-1.4 s | drawn |
   | 8-bit RGB 5316x7522 | 280-357 MB | times out | #1434, unchanged |
   | structure: 98 MB legitimate file | 293 MB musl / 393 MB glibc (file included) | 0.6-0.9 s | ceiling 320 + 5 x 98 = 810; on glibc the freed IPC buffers are not returned to the system |
   | structure: 54 MB, 1,000 pages | 257 MB | 1.3 s | ceiling 320 + 5 x 54 = 590 |
   | structure: 55 MB, startxref off by a few bytes | 394 MB | | pdf.js re-indexes the whole file; ceiling 320 + 5 x 55 = 595 |
   | structure: 70 MB, same | 465 MB | | ceiling 670 |
   | structure: 96 MB, same | 589 MB | | ceiling 800 |
   | 128 MB object-stream bomb, render, no limit | 355-371 MB | 2.6-3.0 s | draws a blank page; bounded under 768 |
   | same, structure at 256 MB | killed at 264 MB | 0.72 s | at 320: killed in about 1.5 s |
   | heap bomb (2 M xref entries), heap flag 128 | 209-233 MB | 1.1-1.5 s | V8 aborts it, saying so |
   | tiling 3000 px, n=60, at 512 / 256 | 515-530 / 259 MB | 2.4-2.7 / 0.83 s | killed |
   | axial shading, n=150, at 512 / 256 | 515-517 / 257 MB | 2.8-3.2 / 1.2 s | killed |
   | soft mask, n=80, at 512 / 256 | 517-519 / 260 MB | 1.9-2.3 / 0.89 s | killed |

   The server process does not grow during any of these: the memory is the
   child's. Sizing follows the usual rule for resource limits (ImageMagick's
   `policy.xml`, Ghostscript's `-dMaxBitmap`): the largest legitimate input
   measured, with headroom of about its own size. The structure check's file
   multiple is five, not one (owner decision 7a, 2026-10-15): a clean file
   peaks at about three times its size, but pdf.js repairs a PDF whose
   `startxref` is off by a few bytes by re-indexing the whole file, holding
   about five times its size (measured above: 55 MB peaks at 394 MB, 70 MB at
   465 MB, 96 MB at 589 MB). With one times the file, such a file near the
   upload limit was killed and refused; the renderer keeps one times the file
   because it opens a page, not the whole index. The fixed allowance stays
   320 MB, so the hostile-file stops above (killed at 256 MB, and in about
   1.5 s at 320 MB for a 128 MB bomb) are measured on small files and
   unchanged; the cost is that a file near the limit may use up to about
   five times its size before it is stopped. Reducing these figures is
   #1436 (v0.4). A poll costs 0.4-6 ms on a loaded host; overshoot past the
   ceiling was 3-18 MB at 150-190 MB/s of growth. A failed read is skipped
   and the clock still applies.
3. **The heap caps are the child's own flags** (`--max-old-space-size=128`,
   `--max-semi-space-size=8`, `--stack-size=3900`), honoured whatever the
   server runs with, so item 5 is withdrawn: a heap flag on the server no
   longer disables anything. A child that dies of its heap cap prints V8's
   fixed message, which the server recognises in an in-memory tail of the
   child's stderr (never logged) and logs as memory. The boot check becomes
   a sandbox self-check: a trivial child started through the same wrapper
   reports its `VmRSS` and data limit from `/proc`, and boot warns if
   `/bin/sh` is missing, `ulimit -d` did not apply or `/proc` is unreadable.
4. **`RLIMIT_DATA` at the ceiling plus 1.5 GB** (and the file multiple above) is a
   kernel-enforced backstop, set by `ulimit -d` in the wrapper: `VmData` sits
   about 1.05 GB above RSS (V8's untouched reservations), so it bites about
   0.5 GB above the watchdog, at allocation time, even if the server's event
   loop is too busy to poll. Legitimate peak `VmData` measured 1.55 GB, so
   768 + 1,536 leaves 750 MB. Kernels from 4.7 count `mmap` under it; older
   ones bound nothing extra. When it fires, a musl child aborts with
   `std::bad_alloc` (logged as memory); a glibc child usually answers a render
   error instead, a rare misclassification accepted as such. `RLIMIT_AS`
   stays rejected, for the measured reason now under "Alternatives considered".
   The same wrapper also sets **`RLIMIT_CPU`** (`ulimit -t`) to the job's
   start-up and wall clocks, rounded up to whole seconds, plus 5 s (70 s for
   a 60 s render budget and 5 s start-up), so a child orphaned by a dead
   server stops on its own (round-5 review). Both values reach the shell as
   positional arguments, never as part of its script.
5. **Answers** (first amendment, item 3): a memory stop answers
   `document_preview_failed` logged as `processing_interrupted`, not as a
   parser fault; the sandbox's own `document.preview` record names memory.
   A render answer is checked like any other input from a child that read
   a hostile file (round-5 review): width and height whole numbers from 1 to
   the asked-for long edge, and the bytes starting with the 8-byte PNG
   signature; anything else is a failed render, the same 422, logged without
   any of the answer.
6. **Consequences.** Each job costs about 50-100 ms more than the worker did
   (process start; ready in 0.23-0.38 s) plus about 3 ms per MB of file to
   hand over, paid before the clock starts; the start-up deadline covers it.
   Two child processes of about 90 MB each run while jobs run, none between
   them. The ADR's alternative of no pool stands: a child that has read one
   hostile file is not trusted with the next. A container memory limit
   (#1429) now has the kernel's OOM killer pick the largest process, which
   is the renderer child, not the server. `/bin/sh` and `/proc` become
   requirements; both are in the image, and a host without `/proc` (macOS
   development) loses the watchdog, which the self-check reports.
