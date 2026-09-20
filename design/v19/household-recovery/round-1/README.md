# Household recovery on administration — round 1 (#1001)

Where an instance admin restores a household that is on its 30-day clock,
and where hard delete lives. Two directions, both drawn on
`design/v19/administration-iss.html` verbatim (nothing above the ROUND 1
marker in either file is changed), and both obeying the standing ruling in
`design/owner-decisions.md` §15: hard delete is admin-only and appears in no
household UI; restore-from-deletion lives on the admin panel only.

Served at
`http://<LAN address>:8336/1001-household-recovery/design/v19/household-recovery/round-1/<file>?scene=…`.
Scenes: `clock` (one system on the clock, the default) · `none` (nothing
scheduled — the screen is administration-iss unchanged) · `two` · `armed`
(delete now opened, the name typed, the button armed) · `restored` · `deleted`.
The demo rail's CLOCK group switches them; the sky, freeze and packs are the
base file's own.

## The data story

The Lawson instance from administration-iss. Emma Lawson asked to delete
**Gran's Flat** on 12 September 2026 from the household's own danger line;
today is 20 September; it is gone for good on 12 October (22 days left). The
`two` scene adds Seaside Cottage, asked 19 September (29 days left).

## What the server already does (`src/server/household-lifecycle.ts`)

- `RECOVERY_WINDOW_MS` is 30 days (line 22). A request sets
  `deletionRequestedAt` and `deleteAfter`; `purgeExpiredHouseholds` hard
  deletes on the day.
- `restoreHousehold` — owner or admin may call it; the ruling shows it only
  on administration. `hardDeleteHousehold` — admin only, requires
  `deletionRequestedAt` and the name typed exactly (422 otherwise).
- All three are one endpoint: `POST /api/households/{id}/lifecycle` with
  `action: delete | restore | hard_delete`.

So this round draws no new server work: two buttons on two existing calls.

## Shared grammar (both directions)

- **Restore is the safe act** — the card family's ordinary button in the
  pack's accent, one tap. Its said-line: "restored · Gran's Flat is back
  exactly as it was".
- **Delete now is the danger line's own protocol**, copied from
  `household-manage.html`: a red-outlined opener; pressing it prints what the
  act costs ("Deleting now skips the 22 days. Nothing comes back after this —
  not for you, not for anyone."), asks for the system's name typed exactly,
  and only then wakes the button, which asks twice ("tap again to delete for
  good", disarming after four seconds). Said-line: "deleted · Gran's Flat is
  gone for good · its members keep their accounts".
- The row in Systems marks the state either way: dashed red ring, red sun,
  and the line "on the clock · 22 days left · gone for good 12 October" in
  place of the members/owner/items line.
- Nothing is drawn when nothing is scheduled. `?scene=none` is the proof.

## A — the banner (`a-the-banner.html`)

What §15 literally named. One wide danger card across the top of the grid
per household on the clock: hazard ticks, red rule, flat red wash, the
heading ON THE CLOCK, both acts up on the heading line, one sentence saying
who asked, when it stops, when it is gone and that restore is exact. The
confirm opens inside the banner. The Systems row only says so; the acts are
on the banner.

Weakness, drawn deliberately in `?scene=two`: each doomed household is a
whole loud card above everything else, so two of them push People and
Systems below the fold on the owner's laptop.

## B — the row on the clock (`b-the-row-on-the-clock.html`)

No banner. The household's own row in Systems carries the state and both
acts on a line beneath the name; delete now opens its confirm inside the row.
The Systems card itself is untouched, and a second doomed household costs
one more row, not one more card. Recommended: the thing being administered
is the system, and Systems is where an admin already looks for it.

## Measured (`.capture/shoot.mjs`)

Desk 1600×1000, the owner's 1093×614, phone 390×844 (touch). No horizontal
overflow in any scene after the phone fixes (the confirm input is
box-sized; the armed button may wrap under 560px). B's doomed row: 115px at
rest, 267px with the confirm open on a desk; restored row 95px.

## Gates

- Base verbatim; danger grammar verbatim from household-manage; packs from
  the base file's own tokens (`--overdue`, `--accent`, `--ok-text`);
  `--on-danger` added per pack as household-manage defines it.
- Buttons are real `<button>`s; the name field is labelled; said-lines are
  `aria-live="polite"`; reduced motion drops the button's colour transition.
- Every scene shot on all three screens and looked at.

## Open for the owner

**56** A or B?

**57** Restore: the server lets a household owner restore too, but §15 shows
the act on administration only, and the household's danger line says so ("an
instance admin can turn this back until then"). Keep it that way? If yes,
nothing changes; the build simply never draws restore on the household page.

## Verdict

Owner, 2026-09-20, verbatim: "56 b the row." B — the row on the clock — is
the direction. A stays as the record.

Question 57, owner, 2026-09-20, verbatim: "57 admin only." Restore is drawn
on administration only; the household page never shows it, whatever the
server would allow.
