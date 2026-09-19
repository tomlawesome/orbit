# Administration operations — round 2 (#1055)

Round 1 (`../round-1/`) was killed: its verdicts were small mono strings
that appeared under a row and went away, and the owner reads that as
noise trained out of sight. Round 2 speaks only in the screen's own
grammar — the People and Systems cards: a readable row, one subtext line,
a state pill, a button at the card head, a button on the row — and
nothing appears-then-vanishes. One direction, F. The build script
(`build.py`) splices the ratified mockup and `web/src/lib/packs.css` so
the #1055 layer can be diffed against the base.

Served at
`http://<LAN address>:8336/1055-admin-ops/design/v19/administration-ops/round-2/<file>`.
The scene bar (sheet furniture) steps through: idle · checking · relay
failed · mailbox passed · after retry · with document names. `?shot`
hides the bar.

## The one data story (as round 1)

Tom Lawson's instance. The virus scanner was away 09:40–10:05; it is
10:12. The snapshot (`GET /api/admin/operations`, 25 most recently
touched jobs) holds two failed jobs (a scan that used its five tries
during the outage; a purge that failed at 08:10), one retrying re-key,
one running scan, and done ones. The relay test (`POST …/smtp-test`)
comes back `smtp_rejected`; the mailbox test (`POST …/imap-test`) comes
back `available` and, since it verifies both halves, says so.

## Direction F — the screen's grammar (`f-the-screens-grammar.html`)

**Document jobs** are a card, sibling to People and Systems, in the grid
cell that was empty beside Public contact — so on the desk its head and
first rows sit above the fold at 1600×1000. Each job is a People row
without an avatar: what it is at reading size (*Virus scan*), one
subtext line (*couldn't reach the virus scanner · 5 of 5 tries · last
tried 6m ago*), a state pill in the ADMIN pill's family (FAILED red,
RETRYING amber, RUNNING blue, DONE plain), and on a failed row the row
button *retry* where People has *place in a system…*. The failed row's
plain-words reason lives in its subtext permanently; there is no callout
to open or miss. Rows are ordered by what needs the reader — failed,
retrying, running, done, newest first within each — and the head counts
them (*2 failed · 1 retrying · 1 running · 41 done*). Pressing *retry*
sends `{action:"retry"}`; the row's pill becomes QUEUED, its subtext
*attempt 1 · queued just now*, the button goes, the counts recount.

**Mail tests** are two card-head buttons on Mail machinery, in the
*invite someone* style: *test this mailbox* and *test the relay*. While
one runs both are disabled and the row's pill reads CHECKING…; the
result is a pill on the row that stays until the next test — *PASSED ·
just now*, *FAILED · just now* — with the failure's reason in the row's
subtext at the screen's one subtext size (*the relay refused the sign-in
details*). To carry a pill and a subtext the five machinery rows are
drawn in the row grammar (*Incoming mailbox / enabled · polling every
30s*), same content as the ratified `.kv` rows, and *rotate every
address* becomes a row button. That is the one departure from §15's
register; the Operations half is untouched.

**The duplication is folded.** *test this mailbox* is the shipped *check
connection* and the ingest preflight in one press: `imap-test` already
runs the same IMAP verify and the relay's too, so the shipped button
goes and this one replaces it. *run setup probe* is a different act and
stays.

**The tell.** Under the page subline, pills in the same family, each a
link to its card: *2 JOBS FAILED*, *RELAY FAILED*, *MAILBOX FAILED*.
They exist only while something needs the reader; a failure is visible
from the top of the page at both sizes without scrolling, and on the
pocket, where every card is below the fold, they are how the reader is
told.

**The fork shown, not drawn twice.** The coordinator's row example named
the document (*Virus scan · MOT certificate 2025*). The information
boundary (`docs/administrator-operations.md`) keeps document names out
of administrator responses and the route does not return them, so the
resting sheet names the kind only. The *with document names* scene shows
the row as it would read if the owner relaxes the boundary for
administrators (the page's own subline says they see everything by
design). Same sheet, one toggle; a second direction would differ by that
string alone.

## Gates

- Dataviz palette validator: N/A — pills use the packs' `--overdue`,
  `--warm`, `--upcoming`, `--ok` and their text grades; spot-checked in
  Clouds as well as After Dark.
- Screenshots: six scenes × 1600×1000 and 390×844 captured and reviewed
  (`review/`, untracked). Fixed before this commit: the jobs card widening
  its grid column; failed-row reasons cut by the ratified subtext
  ellipsis (they now wrap); the two head buttons spreading apart; the
  pocket's 44px row buttons opening gaps in the People rows (now scoped
  to the new rows); disabled head buttons not reading as disabled.
- `prefers-reduced-motion`: the CHECKING… pill's breathing is off.
- The tells row is labelled; pills are text; disabled buttons are
  disabled, not hidden; nothing is icon-only.

## Deliberately not done

- Retry only on FAILED rows: the route refuses anything else (409
  `operation_conflict`) and processing work is never mutated by an
  administrator. No confirm step: retry is cheap and idempotent.
- No *discard* on the row — round 1's open question is still open;
  adding a destructive row button unasked would be a decision.
- Test pills are per session; the API does not record the last test.

## Floors not met

- The ratified sheet overflows at 390px on its own; the pocket wraps from
  round 1 are carried (a base defect for an issue of its own).

## Open questions for the owner

- Relax the information boundary so job rows can name the document
  (the *with document names* scene), or keep the kind-only row?
- Machinery rows redrawn in the row grammar (content verbatim) — is that
  departure from §15's key/value register accepted?
- Should the server remember the last test result so the pill survives a
  reload?
