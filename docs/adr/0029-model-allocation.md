# ADR-0029: One extraction queue, one job at a time, turns by who is waiting; the GPU is observed, never declared

**Status:** Accepted (owner, 2026-09-16, ratifying #984's premise on #974; drafted on #974).
Premise: #984's direction, proposed by the owner on 2026-09-11 and not yet
ratified -- an upload joins the same queue as a mailed-in item. Ratifying
this ADR ratifies that premise and replaces ADR-0025 section 6's hardware
split.
**Date:** 2026-09-16
**Relates to:** #974; #984; #410; ADR-0025 (unchanged except section 6)

## Context

The model server runs one inference at a time (`OLLAMA_NUM_PARALLEL: 1`)
with no priority. A mail-in pass may hold the slot for 300 s; the upload
screen waits 8 s. The mail-in worker (`src/server/mail-in/imap-ingestion.ts`)
calls the model inline. Nothing in Orbit knows whether a GPU exists;
Compose grants no device.

ADR-0025 section 6 split the model path by hardware only because the 8 s
budget forced a fork. #984 removes the budget, so a GPU decides how fast
the queue drains, not who may ask. Held throughout: at most two passes per
document; a failed pass is never re-attempted; the Compose profile is the
only switch.

## Decision

### 1. One queue, in the database

An `extraction_jobs` table: one row per document (unique on the document or
receipt reference), submitter, class (`upload` or `mail_in`), state
`queued -> running -> done | failed | skipped`, lease token, `locked_at`,
and result statistics. A row is created when an upload lands in the review
queue or a mail-in receipt is staged. The inline model calls in
`item-document-inspection.ts` and `imap-ingestion.ts` go; both enqueue.

### 2. One job at a time

One extraction worker per instance claims one row (`SKIP LOCKED`) and runs
both passes in sequence inside ADR-0025's whole-flow deadline, 300 s for
both classes. The 8 s constant retires. Concurrency is not a knob.

### 3. Turn order: round-robin by submitter, oldest first within one

A submitter is the user who uploaded; the mail-in lane is one submitter of
its own. One person's forty-document drop never starves anyone: another
person's upload waits behind at most one document per other waiting
submitter, and mail-in gets a turn each cycle. "Live takes preference"
survives as: nobody waits behind somebody else's pile.

### 4. What the reader sees

The document is in the review queue at once with the heuristic
suggestions, marked "waiting for suggestions -- N ahead, about X minutes"
(N in turn order; X from the average of the last 20 completed jobs,
"unknown" until five), then "reading now", then the model's suggestions
land as ADR-0025 section 4 describes, or "no model suggestion" if the pass
failed. Saving or deleting before its turn marks the job `skipped`; no
inference is spent.

### 5. What a job holds, and what releases it

A running job holds its lease row and one in-flight request. It is
released by completion; the whole-flow deadline; the reader saving or
deleting (request aborted, reply discarded); or a worker crash, seen as a
lease older than deadline plus 60 s and marked `failed` (`lease_expired`).
A job never returns to `queued`: `failed` is final and the heuristics
stand. The row is the pass counter; that is how the two-pass cap and the
no-retry rule hold.

### 6. The GPU is asked for by configuration, observed by the worker, and never a gate

An `ai-gpu` Compose profile adds the NVIDIA device reservation to
`orbit-ollama` (alongside `ai`). Docker refuses to start the container on a
host without the toolkit and a card, so a mis-set profile fails loudly at
`up` rather than lying. Whether the card is actually used is a fact only
the model server has: during each job, once the first pass has started, the
worker reads `/api/ps` -- `size_vram > 0` is `gpu`, loaded with none is
`cpu` -- and health shows the latest as `acceleration: gpu | cpu | unknown`.
Read mid-job because `OLLAMA_KEEP_ALIVE` is 0 and the model is unloaded
between jobs. No code path branches on the value.

### 7. No GPU, and the operator's view

Without a card the same queue drains at CPU pace; every instance with the
`ai` profile runs the model for both classes. This replaces ADR-0025
section 6's "CPU-only runs mailed-in items only; live upload requires a
GPU". `document-health.modelExtraction` gains acceleration, queue depth,
running job age and average job seconds. The only controls are the `ai`
and `ai-gpu` profiles and `OLLAMA_MODEL`: no priority, concurrency,
deadline or cancel controls.

## Consequences

- Tests: a job arriving against a running job waits its turn; two
  submitters plus mail-in alternate; an expired lease is `failed`, never
  re-queued; a fake `/api/ps` reports gpu and cpu.
- #410 draws the states in section 4; #984 decides the rest of the surface.
- If the owner keeps a "do this one now" affordance, it is a third class,
  `now`, at the head of the turn order: it waits for the running job (no
  pre-emption) and gets heuristics if its short deadline passes first.

## Superseded / rejected

- **An environment variable saying "I have a GPU":** the second toggle
  ADR-0025 section 5 forbids; settable on a host with no card.
- **The profile declares the capability:** the profile grants the device;
  the observation is the fact.
- **Pre-emption:** throws away up to five minutes of work, and the
  abandoned pass counts as failed under the no-retry rule. With no
  interactive budget there is nothing to pre-empt for.
- **Mail-in defers while live is pending; live gives up when busy:**
  subsumed by the turn order.
- **Strict upload-before-mail-in:** mail-in starves during a big drop.
  **Pure first-come:** one person's pile blocks everyone for hours.
- **Ollama's queue as the queue:** no order, no visibility, lost on restart.
