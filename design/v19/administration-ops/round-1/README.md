# Administration operations — round 1 (#1055)

Two composition calls on the ratified `/administration` sheet
(`design/v19/administration.html`, §13, as changed by #1052): where the
two mail tests sit and how they answer, and where document jobs live, how
one failed job explains itself, and when retry is offered. Everything the
sheet already carries is verbatim — the build script (`build.py`) splices
the ratified mockup and `web/src/lib/packs.css` and adds only the #1055
layer, so the two sheets can be diffed against the base by anyone.

Served at
`http://<LAN address>:8336/1055-admin-ops/design/v19/administration-ops/round-1/<file>`.
Each sheet's scene bar (foot of page; sheet furniture, not design) steps
through: idle · checking · relay failed · mailbox test passed · jobs
list · one failed job open · after retry. `?shot` hides the bar.

## The one data story (identical across directions)

Tom Lawson's instance, five people, five systems, as the sheet already
shows. This morning the virus scanner was away between 09:40 and 10:05;
it is 10:12 now. The operations snapshot (`GET /api/admin/operations`,
25 most recently touched jobs) therefore holds:

| Kind (plain) | State | Row words | API status / code |
|---|---|---|---|
| virus scan | failed | scanner unreachable · 6m ago | `scan` `failed` `scanner_unavailable`, attempts 5 |
| delete bytes | failed | deletion failed · 2h ago | `purge` `failed` `purge_failed`, attempts 1 |
| re-key | retrying | attempt 2 of 5 · next in 40s | `rewrap` `retry`, nextAttemptAt |
| virus scan | running | attempt 1 · 20s ago | `scan` `processing` |
| virus scan, encrypt | done | 3m ago | `completed` |
| (41 more) | done | — | `documentJobCounts` |

The failed scan's detail says, in plain words: *"The virus scanner
couldn't be reached, five times over 26 minutes. The upload is held,
unscanned, until this succeeds or it is discarded."* — then *attempt 5 of
5 · first tried 32m ago · last tried 6m ago · job 8f3a12c4*, the two
acts, and *"Retry queues it as attempt 1 right away. Discard rejects the
document and deletes its bytes."* No document name, no recipient, no
provider text: the row carries only what the route returns (kind, state,
attempts, bounded reason), per `docs/administrator-operations.md`.

The relay test (`POST …/smtp-test`) comes back `smtp_rejected`; the
mailbox test (`POST …/imap-test`) comes back `available`. The mailbox
test verifies both halves, so its verdict is read off the snapshot's
`mailboxIngestion.imap` / `.smtp` and says which answered.

Refusal vocabulary, one line per result: `smtp_rejected` → "refused
sign-in"; `smtp_unavailable` / `provider_unavailable` → "didn't answer";
`smtp_unconfigured` / `not_configured` → "isn't set up"; `unsafe_input` →
"the saved settings can't be used"; `verification_pending` / `retrying` →
"still checking". The strings are Orbit's own; nothing from the provider
is shown.

## Directions

**A — on the row** (`a-on-the-row.html`). Each test is its row's own
trailing act, exactly where "rotate every address" already sits: `ingest`
gets *test this mailbox*, `outbound reminders` gets *test the relay*. The
button says *checking…* and breathes while it runs; the verdict lands as
a quiet sub-line under the row (*relay refused sign-in · just now*, red;
*mailbox and relay answered · just now*, green), and the button becomes
*test again*. Document jobs join the Operations half as a sixth service
row — *document jobs · 2 failed · 1 retrying · 1 running · show…* — and
unfold in place: only rows needing attention are listed (failed, retrying,
running), the done ones summarised in a foot line. A failed row is a
button; pressing it unfolds the detail (words, meta, *retry* / *discard…*,
the consequence line) under the row. After retry the row reads *queued ·
attempt 1 · just now*, the summary recounts, the detail folds. Nothing on
the sheet moves until the operator asks. Cost: with a failed job open the
Operations half runs to twice the machinery half's height — this is the
"threatens balance" case the issue asked about, and B is the alternative.

**B — the verdict line and the jobs card** (`b-the-jobs-card.html`).
The two tests are chips under the machinery rows, in the sheet's own
`.placerow` register, and speak through the one outcome line the shipped
route already has (`.adminproblem`): *Testing the relay… no message is
sent* while running, *The relay refused sign-in · just now* after. Both
chips disable while either test runs; there is only ever one verdict.
Document jobs take the empty grid cell beside Public contact as a half
card of their own — head *Document jobs · 2 failed · 1 retrying · 1
running · 41 done*, all six rows in snapshot order, foot *the 25 most
recently touched jobs; older ones are not kept*. A failed row opens a
callout (the account card's raised-panel furniture) beside the card on
the desk and as a bottom sheet with a grab bar on the pocket, with the
same words and acts as A; retry closes it and the row becomes *queued*.
The machinery panel keeps its ratified height; the jobs list can grow to
25 without touching it.

**C — a route** (not drawn). `/administration/operations` was
considered and dropped: the snapshot is at most 25 rows with no filters,
so a screen of its own would be a screen for nothing, and the observatory
that would justify it is parked.

## Gates

- Dataviz palette validator: N/A — no data palette; dots and text inks
  are the packs' own `--overdue/--warm/--upcoming/--ok` and their text
  grades. Both sheets inline `packs.css` verbatim and were spot-checked
  in Clouds and Dawn (`data-theme`) as well as After Dark.
- Screenshots: every direction × seven scenes × 1600×1000 and 390×844
  captured and reviewed (`review/`, untracked). Fixed before this commit:
  A's state word colliding with its meta on a failed row; A's verdict
  squeezing label, value and button into three wrapped columns (now a
  sub-line); A's jobs row wrapping on the desk (the row no longer repeats
  the done count); B's callout running off the 1600px sky; Public
  contact stretching to the jobs card's height; pocket wraps for both
  jobs lists and the jobs card head; the scene bar overprinting full-page
  shots.
- `prefers-reduced-motion`: the breathing button and the verdict fade
  are off; the sheet still steps through every scene.
- Verdicts are `role="status"` `aria-live="polite"`; failed rows are
  real buttons with `aria-expanded` / `aria-controls`; B's callout is
  `role="dialog"` with a labelled close, focus moved in, Escape and scrim
  to close; every button carries its words, none is icon-only.

## Deliberately not done

- Retry is offered on `failed` rows only. Running, retrying and done rows
  are not pressable: the route refuses anything but `failed` (409
  `operation_conflict`), and "processing work is never mutated by an
  administrator".
- Discard is kept quiet — a second chip in the detail, never on the row —
  and its consequence is stated in the same breath.
- The mailbox test does not send a message and neither sheet says it
  would; the relay test says *no message is sent* while it runs.
- No provider or error detail anywhere, per the information boundary.

## Floors not met

- Row buttons on the ratified sheet are 26px tall on the desk; neither
  direction changes that (the ratified register). On the pocket both
  sheets raise the test buttons and the jobs toggle to 44px.
- The ratified sheet itself overflows at 390px (`.kv` rows with buttons,
  `.person` rows); both sheets add a pocket wrap so the #1055 layer can be
  judged on a page that fits, and nothing above 560px moves. That is a
  defect of the base, for an issue of its own.

## Open questions for the owner

- Which jobs home: A's unfolding service row or B's card in the empty
  cell beside Public contact?
- Which verdict register: A's per-row sub-line or B's single outcome line?
- *Test this mailbox* overlaps the shipped *check connection* on the same
  half (both run the cheap IMAP verify). Keep both, or fold the shipped
  one into this?
- Does discard belong in the failed-job detail at all?
- Server nuance, not design: `imap-test` collapses `credential_locked`
  into `unsafe_input`, so the verdict cannot say "the saved sign-in is
  locked" as the mailbox row can.

## Verdict (owner, 2026-09-19)

Both directions killed. In the owner's own words: *"Neither of the Admin
panels are acceptable either, they're not in keeping with the rest of the
UI and they're unclear. Random text strings that appear and disappear are
easily missed - if you're trained not to see anything there you don't
even scroll down to check."*

What went wrong: both directions spoke in the machinery panel's small
mono sublines — a verdict was a grey string that appeared under a row and
later went away. The rest of the screen does not talk like that. The
People and Systems cards are the screen's grammar: readable rows, state
pills, a button at the card head, a row button. Round 2 reuses that
grammar verbatim and nothing appears-then-vanishes.
