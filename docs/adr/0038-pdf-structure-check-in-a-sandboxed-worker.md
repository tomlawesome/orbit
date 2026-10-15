# ADR-0038: The PDF structure check opens the file in a memory-capped, killable worker

**Status:** Proposed (implemented with the #1316 fix; accepted when it merges)
**Date:** 2026-10-15
**Amends:** [ADR-0033](0033-document-safety-standard-patterns.md) item 3 (the
open check's resource limits)
**Relates to:** #1316 (hostile cross-reference data), #1427 (the page renderer
gets the same treatment); `docs/document-threat-model.md`

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
- The page renderer (`preview.ts`) still opens PDFs on the server's thread,
  after the same bytes passed this check; #1427 moves it into the same kind
  of worker.

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
