# ADR-0030: Every document takes the queue; the upload form keeps a quick rules-only read as the lesser choice

**Status:** Accepted (owner rulings of 2026-09-16 on #984)
**Date:** 2026-09-16
**Relates to:** #984 (deferred upload); ADR-0029 (the queue itself); ADR-0025
Consequences, hardware paragraph (which this retires); ADR-0026 (what the
rules and the model each do); #1008 (the review card); #993 (learning from
corrections); #977 (the bake-off)

## Context

Upload today is interactive: the user waits while extraction runs inside an
8-second budget, and the model only takes part if the box can answer in
time. Mailed-in documents take a queue with a five-minute budget instead.
ADR-0025's Consequences scope the model by hardware for that reason: a
CPU-only instance runs the model for mail-in only; live upload needs a GPU.

The owner's case on #984: that split is a product fork, not a hardware
fact. The same three things happen on every box — upload, a suggestion
appears, you edit it — and hardware should only decide how long the wait
is. A wait the user has agreed to (a queue with honest progress) costs far
less than a spinner for a result they asked for now.

Measured on 2026-09-16 (`npm run eval:shortlist`): the rules alone take
about 0.2 s a page and put the right answer in their top three on most
fields (tuning 60: reference 59/60, dates 86/102, cost 44/54, provider
46/60; hold-out 4: dates 20/28, reference 8/12, cost 7/12, provider 8/12).
What is slow is the model pass, and today it is also the weaker chooser
(E111–E113). So the fast, rough answer is cheap to keep.

## Decision

1. **One route in.** An uploaded document joins the same extraction queue as
   a mailed-in one (ADR-0029: one queue, one job at a time, turns by
   submitter, the GPU observed not declared). Both passes of ADR-0026 run
   there under one deadline. The result arrives as a card in *For your
   review*, in the #1008 shape: up to three readings per field, the pick in
   force, "type it" last.
2. **The upload form stays, with two buttons.** The first, primary, sends
   the document down the queue and says how long that is likely to take
   (ADR-0029's estimate). The second runs the rules only — no model — and
   returns the same card at once. Its wording says it is the rougher choice:
   the owner's ruling is that the user must understand it is poorer than
   waiting for the normal route. Proposed labels, to be settled in build:
   **Read it properly · about 4 min** and **Quick read now — rougher**.
3. **No hardware gate.** ADR-0025's rule that live upload needs a GPU is
   retired. Every instance runs the model in the queue; a CPU-only box is
   slower, not lesser. The 8-second interactive budget goes with it: the
   quick read has no model call to bound, and the queue has ADR-0029's.
4. **Both routes feed #993.** Whichever route produced the card, what the
   user leaves, swaps or types is kept beside what was proposed, with which
   route proposed it.
5. **A document with no readable text** (a scanned image, say) yields the
   same card with every field on "type it" from either route. No retry; a
   failed queue job is marked failed and never re-queued (ADR-0029).

## Consequences

- #974's ADR-0029 stands as written; this ADR is the premise it names.
- ADR-0025 §5 (heuristics per upload when the model is unavailable)
  becomes the quick-read route rather than a degradation; `document-health`
  still reports the model's state to the administrator.
- The review queue is now the main working surface for documents, not an
  inbox sideline (#410).
- A 40-document drop is 40 cards draining in turn; one failing does not
  stop the next.
- If #977's bake-off finds the model never beats the rules on a field,
  that field is rules-first in the queue too (the bake-off's own rule) —
  the two routes then differ only where the model earns its place.

## Superseded / rejected

- **Remove the interactive form entirely** (ruled 37, 2026-09-16; reversed
  the same day once the rules' speed was measured). One route with no
  quick option makes every box wait minutes for an answer the rules give in
  a second.
- **Rules-only everywhere, model shelved** until the bake-off. Owner:
  mail-in and non-instant use the same route, model included.
- **Keep a full "do it now" (model) path where a GPU is present.** That is
  the hardware fork this ADR deletes.
- **Show the rules' card at once and let the model re-order it later while
  untouched.** Folded into the two buttons instead: the user chooses which
  they want, and a card never changes under them.
