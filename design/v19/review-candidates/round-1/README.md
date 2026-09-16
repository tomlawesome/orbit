# Three readings per field — round 1 (#1008)

Owner's decision of 2026-09-13: each field on the review card shows the top
three readings with the best already chosen; if another is right, tap it;
if none is, type it. This round answers the two open design calls: **how
much of each reading to show**, and **how a field with fewer than three
readings, or none, reads**.

Served at `http://<LAN address>:8335/v19/review-candidates/round-1/<file>`.
Pack switcher top right. The receipt card is `design/v19/inbox.html`
verbatim; the fields go from two columns to one so the readings have room.

Data story: two receipts caught by the relay. **Home insurance renewal**
(provider ×3, renews ×3, cost ×2, kind ×1) and **Boiler service —
Worcester** (provider ×1, next due ×3, cost none).

## A — values (`a-values.html`)

Each reading is a chip; the best is ringed. One faint line under the chips
says where the *ringed* reading came from, in the document's own words;
tap another chip and the line follows. "other…" is a dashed chip that
opens a typing box in place. Fewer readings, fewer chips — no empty slots.
None: the typing box is already open and the line says "not read — nothing
in the document looked like a cost".

## B — lines (`b-lines.html`)

Every reading is a row: the value, then its line from the document. The
reader judges all three at once without tapping. Costs height — the
insurance card is nearly twice as tall as A — and the lines compete with
the values for the eye.

Fable's recommendation: **A**. The line answers "why does Orbit think
that?" for the reading in force, which is the only one the reader must
trust before pressing Add; the other two are one tap away and then show
theirs.

## Verdicts

(pending)
