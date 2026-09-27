# Orbit on a phone — round 3: prose, the break, the way home, the star

Written 2026-09-26 for #1142 (the manifest/signals break and the pocket's
prose), #1140 (the way home from the review page) and the owner's open
question about the north star, against the live build the owner browsed
and the shots in `/tmp/orbit-phone-vision/review-2/` (390×664 and 360×640,
after dark / starchart / clouds). Opus builds from this; nothing here is
re-decided at build time. Where a ruling below overturns the proposal or
the review round it says so; everything else in those two documents stands.

The owner's finding, in one line: the desk's prose survives on the phone,
and on a phone it is clutter. The desk has the room to explain; the phone
has room for the thing and its number. So §1 is one rule set for words on
the pocket, and §3 applies it screen by screen with the new words written
out.

Measurements used throughout: 13px JetBrains Mono is 7.8px a character;
13px Inter is about 6.3px. The column is 358px at 390 and 336px at 360; a
card's inside is 32px less; a row's text edge is 36px in from that (mark
plus gap), and a trailing value takes 96px plus a 12px gap. Every cap below
is set at 360, so a line that obeys it never wraps at either width.

---

## 1. Prose on the pocket — the rules

**What prose is.** A sentence: words with a verb in them. Data has no verb:
a name, a date, an amount, a count, a role, a file name, a status word, and
those joined with `·`. The rules are about sentences; data is untouched.

**R1. A screen at rest shows things and their numbers, not explanations.**
At rest — nothing opened, no sheet up — every line on a pocket screen is a
title, a value, a one-line meta, a caps head, a pill word, or a hint. No
sentence sits between rows, under a card head, or under a control. The
desk's explaining sentences do one of three things on the pocket: move,
shorten to a line, or go (R2–R4).

**R2. Sentences live one level down.** A sentence that a reader needs
before acting goes where the act is: the row's tap-to-open panel (as
`.p-prose`), or the sheet the control raises. A row's panel holds at most
two sentences; a sheet's body at most two above its fields. The panel and
the sheet are the pocket's "read more"; there is no other.

**R3. One line under a title; one line at the foot; or none.** A page
subtitle, a hint under a list, a footnote: 13px mono, `--ink-quiet`, one
line of **at most 40 characters**, never wrapping. Where the desk's line is
longer it is rewritten to a line, not squeezed; where it only reassures
(R4) it goes. A screen has at most one footnote.

**R4. A promise is said once, on the screen that owns it.** "nothing is
added without you", "originals stay in your mailbox", "nothing leaves this
machine" are the product's promises, and the desk repeats them at the foot
of several pages. On the pocket each is said once — question **10** picks
where — and never as a footnote to a list it does not belong to.

**R5. A row's meta is one line of data, never a sentence.** Cap **20
characters beside a trailing value, 34 without one**. Put the fixed data
first and the elastic part (a file name, a person's name) last, so the
guard (below) trims the name and never the number. What does not fit is
the panel's first line. The one standing exception is an email address
(proposal §2.12): it takes the meta line alone and may wrap once.

**R6. A failure speaks its first clause at rest and the rest when opened.**
A server message on a row (a mail that could not be read, a job that
failed) shows on the meta line only up to its first comma, dash or full
stop; the whole message is the panel's `.p-prose`, above the act. An error
line under a control (`.p-error`) is one sentence and may take two lines,
because it arrives after the act and vanishes with the next.

**R7. Alerts are the exception, and they are short.** An alert card
(administration's four; the danger line's "requested" state) may keep one
sentence of at most two lines at rest, because it is the reason the card
exists. Anything longer goes to the sheet its pill opens.

**R8. The guard is CSS, the fix is the words.** `Row.svelte`'s `.meta`,
the new `.p-sub` (subtitle), `.p-hint` and `.p-foot` (footnote) take
`white-space:nowrap; overflow:hidden; text-overflow:ellipsis` and one line
of height. A line that ellipsises in the fixtures is a defect in the words,
not a feature of the guard; the fidelity gate's phone check fails on any
visible ellipsis outside a row title or a file name.

New kit classes (`kit.css`): `.p-sub` (13px mono quiet, under a page
title, `margin:4px 0 0`), `.p-hint` (13px mono quiet, `margin:8px 0 0
calc(var(--p-row-mark) + var(--p-row-gap))` so it sits at the rows' text
edge), `.p-foot` (13px mono quiet, centred, `margin:16px 8px 0`). All three
carry the R8 guard. Home's `.burnup` and the screens' `.hh-sub`, `.in-sub`
and the like become these.

---

## 2. Home: the break, and the signals cut down

**Overturns** proposal §2.1 steps 6–7 (signal rows as built, the footnote)
under #1142. The dial, chips, search line and the manifest are unchanged.

**The break is a pen.** The manifest is rows on the sky. The signals go
into one card, `.p-card.proposed` — the dashed pen the inbox already draws
round "not yet in orbit", the brand's own mark for anything Orbit proposes
(principle 5). Between the manifest's last row and the pen's top edge is a
clear **32px** of sky with nothing in it, and the pen's caps head is
*inside* the pen (`.p-card > .p-caps:first-child`, 0 0 12px). So the
reader sees: rows, a gap, a dashed box. Two different things.

- Head: `SIGNALS` with the count bead (review round §1.6), the bead counting
  the suggestions only — decisions waiting. "— your relay caught" goes.
- Rows inside the pen are the kit's card rows: transparent faces, hairline
  between at the text edge. The per-row dashed border (`.pk-sugg .p-row`)
  and the accent-coloured meta (`.pk-sugg .meta`) go; the hollow accent
  mark and the pen say "proposed". The open row keeps its accent rail.
- A **suggestion row** at rest: title (ellipsis), meta `burns up in 43d`
  (15 characters; the file name moves to the panel), trail as built
  (`~£400.00` over `renews 03 Oct`). Its panel is as the review round has
  it, with one correction: the attachment line prints the paper's name —
  `◆ policy-schedule.pdf · scanned clean` — not "1 forwarded document"
  (review round §6.f: print what the data holds). Pills `Add to orbit`,
  `Dismiss`; quiet line `review & amend →`, which now raises the sheet
  (§4), not a page.
- **Reading and failed rows leave home.** They are the inbox's matter (no
  decision on them here, only `remove`), and their sentences were most of
  the clutter. In their place, at most **one summary row**, last in the
  pen, `href=/inbox`, no panel: title `2 messages couldn't be read` /
  `reading a message` / `reading 1 · 2 couldn't be read`, meta `inbox →`
  in `--accent-text`, mark the breathing dot while anything is reading,
  else the amber failed dot. Question **12** confirms this, since home is a
  ratified surface.
- The footnote "unreviewed arrivals burn up after 45 days · nothing is
  added without you" goes. The row says when it burns up; the promise goes
  where question **10** puts it.
- The pen is omitted when there is nothing to show, as the group is now.
- The foot of the page pads by the star (§5) so the pen scrolls clear.

At 390×664 that turns the shot's four signal rows (eleven lines of text)
into one dashed pen holding one row and a summary — three lines — under a
visible gap.

---

## 3. Per screen

Each line: the words as built → what happens. **Keep** means as built.
Sheet titles and pill words are unchanged unless listed.

### 3.1 Home
- `NEEDS ATTENTION`, row metas (`Home · £150.00`), the "nothing needs you /
  next up Boiler service, T−22d" row: keep.
- Signals: §2.
- Search sheet: `nothing in your orbit is called "x"` keep (`.p-empty`;
  may wrap, it carries the reader's own words). `→ add an item`, `add "x"
  as an item`: keep.
- Adrift sky: `the systems around you are labels until someone lets you in
  — or start your own system →` → the rows already say "tap to ask to
  join"; the line becomes `— or start your own system →` alone, 44px hit.

### 3.2 Item (the belt)
- `6 ITEMS · IN DATE ORDER, SOONER TO LATER` (two lines) → `6 ITEMS ·
  SOONER TO LATER`.
- Card meta `Vehicles · inspection`, the kv rows, `ACTIONS`: keep.
- `2 documents ride in the belt · see them ›` → `2 documents · see them ›`.
- Empty band `nothing in orbit yet` + pills: keep.
- Retire sheet "Retire Car MOT? It leaves the dial; its documents stay in
  the belt for 30 days": keep — a sheet carries the consequence (R2).
- Preview's `still checking`, the kept-until line, `restore`: keep.

### 3.3 Review & amend — the inbox sheet and the receipt page
The inbox's full sheet `Review & amend` (create's form pre-filled) stands.
The receipt page `/item/<receiptId>` is rebuilt for the pocket in §4; its
desk words on a phone:
- `suggested from your documents · policy-schedule.pdf` → the review card's
  `caught 11 Aug · burns up in 43d`.
- `◆ policy-schedule.pdf will be attached on acceptance` → the attachment
  line `◆ policy-schedule.pdf · scanned clean`.
- `accept into orbit` → `Add to orbit`; `dismiss` → `Dismiss` (the inbox's
  words; one vocabulary).
- `nothing is created without your acceptance — an unaccepted suggestion
  simply expires and is purged` → cut (the caught line says when it burns
  up; question **10**).
- `← back to your orbit` → `← your sky` (§4).
- Sheet: `required · choose one`, `not yet — give it a name`: keep.

### 3.4 Household
- Subtitle `your system · you own it · 4 members · 6 entries in orbit` (two
  lines) → `owner · 4 members · 6 entries`; member view `member · 4 members
  · 6 entries`.
- Invited meta `sent 2d ago · expires 18 Sept 2026` → `sent 2d ago · expires
  18 Sept`.
- Leave panel `nothing you added goes with you · the entries stay with
  Lawson Home` → keep, as `.p-prose`: `Nothing you added goes with you; the
  entries stay with Lawson Home.` `an owner can't leave · hand the system
  over first`: keep.
- Knock row `Gran asked to join · 2d ago`, `approve` / `decline`: keep.
- Sections meta `3 entries · shown`, `12 is the most a system can hold`:
  keep. Edit-section sheet notes: keep (sheet).
- Archive, export tab: `One encrypted file with everything in Lawson Home,
  to keep or to bring into another Orbit.` → cut; the four count rows and
  the pill say it. Import tab: its intro sentence → cut; `choose a file`
  and the preview card carry it.
- Danger line: `Deleting stops everything in Lawson Home at once. There are
  30 days to change your mind.` → cut at rest; the delete sheet's two
  sentences stand (R2). Requested state `requested · Lawson Home stops now,
  and is gone for good in 30 days · an instance admin can turn this back
  until then` → `requested · gone for good in 30 days` (R7, one line).
- Invite sheet `the link admits only someone signed in with this exact
  address`, handover sheet prose: keep (sheet).

### 3.5 Inbox
- Subtitle `what your relay has caught · nothing enters your orbit without
  your say-so` (two lines) → question **10**: `nothing enters without your
  say-so` (a) or cut (b).
- Review card: `caught 11 Aug · burns up in 43d`, readings: keep.
  Attachment `policy-schedule.pdf · 812 KB · scanned clean` (wraps) →
  `◆ policy-schedule.pdf · scanned clean`, the size dropped.
- Still reading: title `A message arrived 4m ago`, meta `still reading`
  (mono). The sentence "Orbit is reading its document — it will appear for
  review when it's done" goes.
- Failed rows: title `A message from 09 Aug`, meta the first clause (R6):
  `Its attachment is a picture-only scan`, `It carried no document Orbit
  can read`; panel: the whole message as `.p-prose`, then `the original
  stays in your mailbox` as a `.p-hint`, then `remove` (arms). Durable fix,
  filed as a follow-up not built here: give a failure a reason code so the
  pocket can print `picture-only scan` / `no readable document` instead of
  a clause.
- Hint `tap a message to remove it · the original stays in your mailbox` →
  `tap a message to remove it`.
- Filed meta `from mot-reminder.pdf · added 30 Aug 2025` → `added 30 Aug ·
  mot-reminder.pdf` (date first, name last for the guard).
- Filed hint `every item the relay has fed into your orbit · its documents
  ride with it` → cut. Empty `nothing filed yet · add an arrival to your
  orbit and it lands here` → `nothing filed yet`.
- Footnote `unreviewed arrivals burn up after 45 days · originals stay in
  your mailbox, Orbit only ever reads copies` → `unreviewed arrivals burn
  up after 45 days`; the mailbox promise → question **10**.
- Empty inbox: `your relay is listening · nothing waiting` → `relay
  listening · nothing waiting`; the sentence `Forward a bill, a renewal or a
  certificate to your relay address and it lands here for your say-so.` →
  cut; `open the relay →` stays.

### 3.6 Create
- `add something to your orbit`: keep.
- Document row `photo or file · dates, amounts and references read for you`
  (two lines) → `photo or file · read for you`.
- No household `you are not in a household yet · an entry needs one to live
  in` → `no household yet · an entry needs one`, `find a household →` keep.
- Error `Orbit could not read your households, so there is nowhere to file
  this yet.`: keep (R6, an error line). Leave sheet: keep.
- Placeholders (`optional · e.g. Kwik Fit`, `anything else worth keeping`),
  `required · choose one`, reminders `before` / `change`: keep.

### 3.7 Settings
- Subtitle `your controls, and only yours · the instance's levers live on
  administration` (two lines) → `your controls, and only yours`.
- Sign-in rows: `set · changed 24 Aug 2026` keep; `identity provider ·
  linked 2 Jun 2026` (wraps) → `provider · linked 2 Jun`; `every password
  sign-in` keep.
- Reminders: `on · to tom@lawson.example`, `before closest approach`, `set
  by your administrator`: keep. Both-off `both switches are off · nothing
  more will be sent until one is on` → `both off · nothing will be sent`.
- Sent tab: null `Orbit can't show what it has sent you yet. Your reminders
  still go out as set on the first tab.` → `Couldn't load what's been sent.
  Reminders still go out as set.` (R6). Empty `nothing sent yet · the first
  warning goes out … if they are on` → `nothing sent yet`.
- First/final warning sheets' two sentences: keep (sheet).
- Relay: `arrivals in your inbox` keep; `rotate · pause · what couldn't be
  read` → cut; `open the relay →` is a title-only row.
- Systems metas, signed-in metas, hint `tap a device to sign it out`: keep.
- Remove-password / unlink sheets and `Orbit asks you to confirm it's you
  before a way in changes.`: keep (sheet).

### 3.8 Settings › mail
- `Forward a document to your private address and it arrives in your
  review queue.` (three lines) → `forward a document to this address`.
- `TAP TO COPY`, the label-above-value rows: keep. `nothing yet — forward a
  document to try it` → `nothing yet · forward one to try`.
- `ARRIVED, BUT COULD NOT BE READ` → `COULDN'T BE READ` with the bead; its
  rows take the inbox's failed-row grammar (title the date, meta the first
  clause, panel the message and `remove`) — one shared piece, not a third
  drawing of it. The red four-line paragraphs go.
- Footnotes `Every person gets their own relay. Nothing is created without
  your review.` and `Outbound reminder email is set by your administrator.`
  → cut (the second is settings' outbound row). Question **9a** gives this
  page `originals stay in your mailbox` as its one footnote.

### 3.9 Administration
- Subtitle `the instance from above · 5 people · 5 systems` → `5 people · 5
  systems`.
- Tells strip, jump strip: keep. Alert cards: head, one sentence of at most
  two lines, one pill — as built (R7); the `what to do` sheet keeps its
  paragraphs.
- People rows: meta the email alone (§2.12 exception); `in 5 systems` /
  `owns 2 systems` → the panel's first `.p-kv` line. Setup-link line
  `setup link sent to x · valid until …` → `setup link sent · lapses 3 Oct`.
- Systems rows `2 members · owner Tom Lawson · 6 items` (wraps) → `2 members
  · 6 items`; `owner · Tom Lawson` → the panel's first `.p-kv` line.
- Clock row `on the clock · 13 days left · gone for good 26 Aug` (wraps) →
  `deleted · 13 days left`; `gone for good 26 Aug` → the panel, beside
  `delete now`. `past its window · waiting to be removed for good` → `past
  its window · removing`. `restore` stays visible (§2.11).
- Public contact `shown on the sign-in door if it can't open safely` → cut;
  the `set` sheet carries it. Its error line: keep.
- Mail machinery rows: keep. Rotate meta `issue every member a new relay
  address; the old ones keep working for a while` → cut at rest; it is the
  rotate sheet's sentence.
- Document jobs: `couldn't reach the virus scanner · 5 tries · last tried
  6m ago` (wraps) → `couldn't reach the scanner · 6m ago`; tries go in the
  service sheet the row opens. `retry` stays visible (#1071). Foot `the 25
  most recently touched jobs are kept; older ones are not` → cut.
- Version line (three lines of caps) → `ORBIT 1.3.0 · PREVIEW · FD6A7E6`;
  `self-hosted — nothing leaves this machine` → question **10**.
- Invite sheet note (two sentences): keep (sheet).

### 3.10 The door family
- Sign-in modes, setup, invite outcome, held dawn, sign-out, 404, other
  statuses: keep — each is already one line and one sentence.
- Approve: the rows keep. `Lapses 25 Sep 2026, 21:29 UTC. Nobody gets in
  until you approve.` (two lines, meeting the horizon in the shot) →
  `lapses 21:29 UTC`, one mono line; the second sentence is the button.
- Maintenance: keep; its sentence is the page.
- The hatch: keep.

---

## 4. The way home (#1140)

**What the owner met.** `/item/<receiptId>` — the page a suggestion's
`review & amend →` and a tap on the dial's hollow body both go to — is
`Suggestion.svelte`, a desk page. On the pocket it mounts no top chrome at
all (the `Chrome` in `+page.svelte` sits in the belt branch only), so the
only way home is the desk's 11px `← back to your orbit` after the two acts
inside the card. That is the "there but not obvious".

**The rule, for every pocket screen reached from home:**

1. **The top chrome is on every hop screen, no exceptions**, with the way
   back worded for where you came from: `← your sky` from home, `←
   settings` from settings. It is the kit's `TopChrome` (retracts on
   scroll-down, returns on scroll-up). The review page mounts it like every
   other hop, with the orb. The film's playback and the door family are
   not hops (no chrome, as before).
2. **The back link reads as a control, not a label.** `TopChrome`'s
   `.back` takes `--ink-mid` (one grade up from `--ink-quiet`), keeps the
   mono caps, halo and 44px hit. Same on the desk's `Chrome.svelte` pocket
   branch, since it is the same component.
3. **A decision screen ends with the way home.** Where a screen's pills all
   leave the page on success (the review page), the last line of its card
   is the quiet line `← your sky` (`.p-quiet`, 44px, `--accent-text`) —
   "decide later", in thumb reach, under the acts. Nowhere else: a screen
   with a save bar or a foot of its own does not repeat the link.
4. **One word for home.** The pocket says `your sky` everywhere (the
   chrome, the quiet line, the 404's `plot a course home →` stays as the
   404's own). `← back to your orbit` goes.

**The review page itself, on the pocket** (kept as a page, since its address
is what the dial and a reminder link reach): the top chrome, then the
inbox's review card verbatim — title 18px, `caught 11 Aug · burns up in
43d`, readings as `.p-kv` with `sure` / `unsure`, the attachment line,
`Add to orbit` (filled, arms), `Dismiss` (danger, arms), `review & amend →`
raising the same full sheet the inbox raises, then `← your sky`. On
success: the wake and home. The inbox's card and sheet become one shared
piece (`lib/pocket/ReviewCard.svelte` and the sheet beside it) that home,
the inbox and this page all mount; home's `review & amend →` and the
dial's hollow body raise the sheet in place (proposal §2.5's intent) rather
than navigate, so the page is reached by address only.

---

## 5. The north star — ruling

**At rest it sits in the sky; afloat it rides at your thumb.** Two
stations, one element.

- **Rest station**: in flow, in the dial square's empty bottom-right
  corner — right edge at the gutter, bottom edge on the dial's bottom edge,
  56px as built. The corner is clear at both widths: the ring passes about
  30px (390) and 22px (360) from the disc's nearest corner, and `NOV` and
  `FEB` are over 100px away. Nothing is under it.
- **Afloat station**: fixed bottom-right as built, from the moment the
  dial's bottom edge has scrolled above the top chrome
  (`scrollY > dialBottom − chromeHeight`, read on the chrome's own scroll
  frame). Enter: 200ms opacity 0→1 and translateY(8px)→0; leave: 150ms
  the reverse. Reduced motion: appear and vanish. The star at the corner
  simply scrolls off with the dial; the afloat one fades in at the foot.
- **Hides** while any sheet is up, while the film plays (as built) and,
  new, while any row is open — the suggestion-row-open shot has it over
  the `Dismiss` pill. `data-northstar` on `<body>` (the wake's clearance,
  review round §1.3) is set only while afloat.
- **The page's foot pads** by `calc(20px + 56px + 20px +
  env(safe-area-inset-bottom))` on home, so the last row and the pen
  scroll clear of the afloat star.

Why not the two answers the owner weighed: a **list cannot leave room** for
a fixed control — whatever scrolls under it is covered at some position;
only the foot can be padded, and that is done. **Always fixed** hides the
first attention row's date at first glance at both 390×664 and 360×640,
and that date is the thing the manifest is for. A star in the sky beside
the dial is the desk's own idea of the north star and covers nothing; the
afloat station keeps the reason the star exists (add from anywhere in the
list, one tap). Question **11** offers the owner the plain alternative.

---

## 6. Build order

1. **Kit**: `.p-sub` / `.p-hint` / `.p-foot` and the R8 guard on `.meta`;
   `.back` to `--ink-mid`; the shared failed-row piece (title, first-clause
   meta, panel with `.p-prose` and `remove`); the phone fidelity check
   gains "no visible ellipsis outside a title or file name" and "no
   sentence at rest" (a `.meta` or `.p-sub` over its cap).
2. **Home** (§2, §5): the pen, the summary row, the footnote gone, the
   star's two stations and its row-open hide, the foot pad.
3. **Review** (§4): `ReviewCard` shared; the receipt page on the pocket
   with chrome and the quiet line; home and the dial raise the sheet.
4. **Inbox, settings › mail** (§3.5, §3.8): the shared failed row, the
   new lines.
5. **Settings, household, administration, create, item** (§3.2, §3.4,
   §3.6, §3.7, §3.9): the new words; nothing structural.
6. **Approve** (§3.10) and the reshoot at 390×664 and 360×640; the owner
   judges home and the review page from that set.

Follow-up to file, not to build here: a reason code on mail failures and
document-job failures (§3.5).

---

## 7. Questions for the owner

Numbering continues the session's (9 upward).

**Answered by the owner, 2026-09-26: 10b, 11a, 12a.** Question 10 went against the recommendation: every promise line is cut from the pocket, and the acts carry the promise. Wherever the per-screen lists above say a promise line is kept or moved "per question **10**", read it as cut.

**10** The promise lines — "nothing is added without you", "originals stay
in your mailbox, Orbit only reads copies", "self-hosted — nothing leaves
this machine". The desk says them at the foot of several pages.
 a) Say each once, on the screen that owns it: the inbox's subtitle reads
    `nothing enters without your say-so`; settings › mail's one footnote
    is `originals stay in your mailbox`; administration's version line
    keeps `SELF-HOSTED` as a fourth word. Everywhere else they go (my
    recommendation: the promise is worth one line each; repeated it is the
    clutter you saw).
 b) Cut them all from the pocket; the acts (`Add to orbit`) are the promise.

**11** The north star's rest station (§5).
 a) In the sky at the dial's corner at rest, afloat at the bottom right once
    the dial has scrolled off (my recommendation: covers nothing at first
    glance, still one tap from anywhere in the list).
 b) Keep it fixed at the bottom right always, with the foot pad only, and
    accept that at rest it covers the first row's date.

**12** Reading and failed mail on home (§2). The proposal listed them as
rows under Signals; they carry the sentences that crowded the manifest.
 a) One summary row in the pen (`2 messages couldn't be read · inbox →`);
    the rows themselves live in the inbox (my recommendation: home shows
    decisions; a message that failed needs none).
 b) Keep them as rows on home, cut to one meta line each under §1.

---

## 8. Caps: the lines that broke them (decided 2026-09-26)

Built to §1 and 10b, these lines still broke §1's own caps in the fixtures
(the gate, `pocket-measure.spec.js`, is right; the words give). One line
each: the words as built → the treatment, and why. A row that navigates or
raises a sheet has no panel (`Row.svelte`), so its meta is rewritten, not
moved.

- Settings `first warning` / `final warning` meta `before closest approach`
  → `before it’s due`; 23 beside a value, and the row opens a picker, so
  there is no panel to move it to. `the day itself` stands.
- Settings `outbound mail` meta `set by your administrator` →
  `administrator’s setting`; 25 in the body face beside `configured`, and
  the reader only needs to know the switch is not theirs.
- Settings `waiting for review` meta `arrivals in your inbox` →
  `in your inbox`; 22 beside the count, and the row already leads there.
- Settings `email approval` meta `this instance has no mail relay
  configured` → `no mail relay set up`; 41 beside `off`.
- Settings › sent meta `browser alert · 14 days before` → `alert · 14 days`
  (`email · on the day`); 30 beside the date, and the reminders tab's own
  trail already says days that way, so `before` is understood.
- Administration `ingest` meta `enabled · polling every 30s` →
  `every 30s` on the pocket only (`words.js`); 27 beside `on`, and `on`
  already says enabled. The desk keeps its words: they sit in its mockup.
- Administration `verification` meta `verified · 12/08/2026, 09:00:00` →
  `verified · 12 Aug`, and `credential set` `01/08/2026, 09:00:00 · Tom
  Lawson` → `1 Aug · Tom Lawson`; the pocket's date is day and month
  (§3.9's `lapses 3 Oct`), and the name goes last for the guard (R5).
- Administration document job `couldn’t reach the scanner · 6m ago` →
  the reason alone at rest, `last tried · 6m ago` a `.p-kv` in the panel
  beside `tries`; the state pill takes the width the time needed, and the
  reason is what R6 puts at rest. The reason words (`JOB_REASONS`, pocket
  only) are each cut to at most 26 characters so every one fits beside
  `retrying`.
- Administration service sheet `Checked by this instance itself; nothing
  here leaves the machine.` → cut; 10b reaches sheets — a promise is the
  same sentence wherever it sits, and the sheet's `.p-kv` lines are the
  check.
- Inbox footnote `unreviewed arrivals burn up after 45 days` → `unreviewed
  arrivals burn up after 45d`; 41, and the review card already counts in
  `43d`.
- Inbox dismiss wake `dismissed · <title> · the original stays in your
  mailbox` → `dismissed · <title>`; a promise line (10b).
- Home search, a paper's meta `Car MOT — Volvo V60 · 88 KB · added 12 Jun`
  → the item's title alone; the size went in §3.5, the date is the paper's
  own sheet's, and an item title is elastic but not a file name, so it
  cannot be the trimmed tail.
- Kit `from bill-sept.pdf · burns up in 12d` → `burns up in 12d ·
  bill-sept.pdf`; 36, and the file name goes last (R5). Kit `Its attachment
  is a picture-only scan, and Orbit couldn't read …` → the first clause
  through `firstClause()` (R6); the specimen shows the rule it names.

No exemption was needed: no cap was wrong for its case.
