# Orbit on a phone — the vision

Written 2026-09-25 for #1120. Words only, no mockups: Opus draws and builds
from this. The bar the owner set: a professional, slick phone UX/UI that
matches the desk site. "Matches" means the same identity, vocabulary and
decisions — the pocket is a dialect of v19, not a second app.

How to read it: §1 is the system every screen obeys. §2 is one section per
screen. §3 is the order to draw in. §4 is the short list of choices that are
the owner's. Where an owner decision already binds, it is cited by section
of `design/owner-decisions.md` (§n) or by issue; nothing here re-opens one.

Terms: **pocket** = the phone dialect (CON-10: ≤900px wide or ≤600px tall;
both dialects are server-rendered and CSS picks one). **Desk** = everything
else. **Sheet** = a panel that rises from the bottom edge and sits over the
page. **Row** = one line of a list. **The hatch** = the account sheet the
avatar opens. **Approach** = go to a thing's own screen (CON-5's second
tap). **Arm** = a dangerous act's first tap, which changes the button to
"tap again to …" and does nothing else.

---

## 1. The phone system

### 1.1 One app, one address book

Every URL is the same on a phone. Nothing lives at a phone-only address
(`/mobile` redirects for that reason). The four redirect routes
(`/documents`, `/due-next`, `/mobile`, `/admin`) need no drawing.

### 1.2 Navigation model

The pocket is a **hub and hops** model, not tabs:

- **Home is the hub** (the pocket sky). Everything is one hop from it and
  every hop returns to it.
- **The hatch** (avatar orb, top right, every signed-in screen) is the only
  menu: who you are · Add an item · Inbox (with count) · Settings ·
  Administration (admins only) · theme swatches · sign out. It exists
  already; it stays. It is a sheet, so it obeys the sheet rules below.
- **The way back** is the top-left link, worded for where you came from
  (`← your sky`, `← settings`), exactly as `Chrome.svelte` does today. The
  OS back gesture and browser back do the same thing. A sheet pushes a
  history entry so that back closes the sheet before it leaves the page.
- **No bottom tab bar.** Desk has none; sheets own the foot (CON-10); a bar
  would fight the keyboard and every sheet. The foot is reserved for
  sheets, the keyboard and the film's transport.
- **The north star** — desk's create handle — returns on the pocket home as
  a fixed body at the bottom right (see §2.1 and owner question 1). It is
  the one floating control in the app and appears only on home.
- **Approach is a real navigation.** Tapping `open` on an item's sheet goes
  to `/item/<id>` (the belt), with the sheet morphing into the item card
  (§2.3). Leaving the belt returns to home with no sheet raised.

Depth is never more than three hops from home: home → settings → household
→ (sheet). Anything deeper is a sheet, not a page.

### 1.3 Top chrome

- Height 56px + top safe-area inset. Left: back link, 44px hit, 13px mono
  caps with the halo the desk uses on star fields. Right: the orb, drawn
  36px, hit 44px. Home shows the wordmark instead of a back link.
- The chrome **scrolls away** with the page and **returns when you scroll
  up** (a glass strip over the sky, POL-12's retract-on-scroll carried to
  the top). Reason: 56px is 7% of a 780px screen; long pages
  (administration, settings, household) need the height, and "scroll up a
  little to get the chrome" is the phone convention people already have.
- The door, sign-out, 404, maintenance and the film's playback have no
  chrome (pre-auth or full-screen personalities).

### 1.4 Sheets

One sheet component, three sizes, used everywhere a desk callout, drawer,
panel or dialog exists:

| size | height | used for |
| --- | --- | --- |
| callout | content height, ≤45% of screen | item sheet, suggestion sheet, confirmations, single forms (rename, invite someone) |
| list | 60% of screen, drags to full | document list, search results, the hatch, section-mark tray, timezone/currency pickers |
| full | full height minus safe area, page scrolls inside | edit item, review-and-amend, import preview, the reader's document list |

Rules:

- Radius 18px top corners, grab handle 36×4 centred 8px from the top, glass
  background (`--panel` at 92% + blur 16px on the GPU lane only). Scrim
  behind at 45% `--bg`.
- Rise 300ms `cubic-bezier(.3,.7,.3,1)`; the same curve the pocket already
  ships. Reduced motion: appear in place.
- Dismiss: drag the handle or the sheet down; tap the scrim; the `close`
  word inside the sheet; Escape; OS back. All four always exist.
- One sheet at a time. A sheet that needs another (item sheet → documents)
  **grows** rather than stacking.
- Sheets **stand on the keyboard** (track `visualViewport`), never under it.
  The sheet's primary action sits in its last row so it is above the
  keyboard and in thumb reach.
- Sheets are dialogs: `role=dialog`, labelled by their title, focus moves
  in on open and returns to the opener on close; the page behind is
  `inert`.
- Every button inside a sheet is 44px tall. The shipped item sheet's
  buttons are ~36px; that is a defect to fix, not a size to copy.

### 1.5 Lists and rows

One row grammar for the whole app (home manifest, inbox lanes, members,
sections, sessions, people, systems, documents, search results):

```
 ┌──────────────────────────────────────────────┐
 │ ●  Title in 16px ui, one line, ellipsis      T-16d │
 │    meta · in 13px ink-quiet, mono for data   29 Aug│
 └──────────────────────────────────────────────┘
   24px mark column · 12px gap · 56px min height · 16px side padding
```

- The leading mark is the body glyph, an asterism, an avatar ring (36px)
  or a paper (◆). The trailing column is a mono value (T-label, date, size,
  role badge, a switch). Never a chevron: the desk has none, and the
  trailing value is the affordance.
- The **whole row** is the tap target when the row navigates or summons a
  sheet. Press state: `--panel-raised` for 120ms.
- **Row acts (remove, hand over, resend, withdraw, disable, new setup link,
  sign out this device, remove a section)** are revealed only by a
  horizontal swipe, per §25 / #1122 (owner, 2026-09-25): no tap-to-open,
  no visible extra buttons. The row slides 40% to expose one or two 44px
  pills on the trailing side; it springs back on tap elsewhere, on scroll,
  or after 6s. A swipe never *performs* an act — dangerous acts still arm
  on first tap and fire on the second. Keyboard: focus the row, ← or →
  reveals, Tab walks the revealed pills, Escape hides. Screen readers: each
  act is a real button in the accessible tree, named with its object
  ("Remove Rob Lawson"), reachable by swipe-navigation but not in the
  sighted Tab order. Voice control users say the button's name. This is
  the accepted WCAG 2.5.1 departure; it is recorded once (§25) and applies
  to every row with management acts on the pocket.
- **Acts that are the point of the row stay visible**: approve/decline a
  knock, Add to orbit / Dismiss on a review, restore a household on the
  clock, accept a reading in create. Half-width pills on a second line
  under the row's sentence. Never behind a swipe.
- Reorder (sections): long-press lifts the row (haptic where the platform
  gives one), drag, drop. Keyboard: focus + Alt-↑/↓. Screen readers: "move
  up / move down" buttons on the same hidden path as the acts.
- Long lists never paginate on the pocket; they scroll. A count line
  ("12 members") sits in the card head as on desk.

### 1.6 Type scale and the legibility floor

Fonts are the desk's: Inter for prose, JetBrains Mono for anything you
might read back to someone, Space Grotesk for display. The pocket scale:

| role | size | face | notes |
| --- | --- | --- | --- |
| page title | 28px / 1.15 | display | one per page |
| card title, item name | 21px | display | wraps to three lines, never ellipsis |
| body, row title, inputs | 16px | ui | 16px on inputs stops iOS zooming on focus |
| sheet title | 18px | ui 600 | |
| meta, T-label, values | 13px | mono or ui | ink-quiet grade tokens from `packs.css` |
| caps label (card heads, group heads) | 12px, tracking .14em | mono | the floor |
| button | 15px | mono for ghost pills, ui 600 for filled | |

**Floor: nothing under 12px, and 12px only for tracked caps labels.
Anything a person must read to act — a date, an amount, an address, a
name — is 13px or larger.** The shipped pocket home is below this (13.5px
titles, 11px meta, 9.5px dates, 10px group heads); it is lifted to this
scale (§2.1, owner question 2). Sizes are in `rem`; layouts must survive
the platform's larger text settings to 130% without clipping, which the
row grammar (title ellipsis, meta wraps) guarantees.

### 1.7 Tap targets and spacing

- 44×44px minimum for everything tappable, including dial bodies (44px hit
  circle round a 7–9px body), belt papers, swatches, the orb, switches
  (52×32 drawn, 44 tall hit), pill buttons (44 tall, 16px side padding),
  and quiet mono lines like "local login" (44px hit around 13px text).
- Two hit circles never overlap. On the dial, if two bodies would sit
  closer than 48px centre to centre, the pocket keeps the nearer-due one on
  the dial and the other stays in the manifest only (the pocket already
  shows "fewer, bigger bodies"; this makes the rule explicit). Same law on
  the belt.
- Page gutters 16px at ≥390 wide, 12px at 360. Card padding 16px, radius
  16px, 12px between cards, 24px above a group head and 8px below. Pills
  8px apart, wrapping to a second line at full width, never shrinking.
- Column max-width 480px centred, so a tablet in portrait still reads as
  the pocket without stretching rows.

### 1.8 Thumb reach

- The last row of every sheet and the foot of every card holds the primary
  action. Page-level primary actions (Add to orbit, Save, Approve) are
  full-width pills at the foot of their card, never in the header.
- Destructive acts sit last, are ghost pills with `--overdue` text, and arm
  before they fire. The armed state reads "tap again to remove" and disarms
  after 4s, on scroll, or on any other tap.
- The only controls out of one-thumb reach are the back link and the orb,
  neither of which is urgent; the OS back gesture and the retracting chrome
  cover them.

### 1.9 Motion

Same rules as desk (§5, POL-11, POL-13), pocket budgets:

- The sky drifts on every page, perceptible in 3–5s, canvas or transform
  only (GPU law, §15). Grain fades in. Nothing beats in sync.
- Sheet rise 300ms; approach morph 300ms (§2.3); row swipe follows the
  finger and springs at 200ms; chrome retract 200ms; arm/disarm 150ms
  crossfade; the wake (toast) 250ms up, 4s hold, 250ms down.
- Page arrivals are the platform's own navigation — no page transition is
  drawn — except the door's dawn (once on load), the sign-out sunset, the
  404 infall (1–1.5s, §16) and the film.
- `prefers-reduced-motion`: sheets appear, morphs cut, drift stops, the
  film uses its 2:09 reduced cut, rows still swipe (that is input, not
  decoration).

### 1.10 The space language at 390 and 360

- The sky is full-bleed behind every page; cards are glass panels on it.
  Backdrop art (administration's ISS labels, create's constellation names,
  the household's H2 year) is **hidden below 901px** wherever a label would
  be cut by the screen edge — the audit's "clipped text" is all this. Art
  that survives whole (the relay's dish, the door's dawn, the H2 ring)
  stays, dimmed one step so text on it passes the packs' contrast grades.
- The dial owns the width on home; the belt is a low arc across the top of
  the item screen; households are a chip strip; the door's ring rides high
  with its card beneath; the inbox orb becomes the count on the orb.
- Page personalities (CON-9) are kept: dawn on the door, sunset on
  sign-out, totality on maintenance, the gravity well on 404, observatory
  on administration, genesis on create, relay on settings › mail.

### 1.11 Safe areas, standalone, keyboard

- `viewport-fit=cover`; top chrome, sheet feet, the north star and the
  film's transport all pad by `env(safe-area-inset-*)`. `theme-color` per
  pack so the status bar matches the sky.
- Installed (PWA standalone) the app has no browser back; every page's
  back link and every sheet's close must therefore be visible without
  scrolling once the chrome has returned — which the retract-on-scroll-up
  rule guarantees.
- On-screen keyboard: inputs are 16px; the focused field scrolls to sit
  12px above the keyboard; sheets stand on it; `enterkeyhint` matches the
  action (go / search / done / next); `inputmode` is `email`, `decimal`
  (cost), `numeric` (days, codes); dates use the native picker; the door's
  ring closes to its small form on focus (§2.14).

### 1.12 Accessibility, per §25

Real access means every path exists for keyboard, screen reader, voice and
switch users, tested on a real iPhone, a real Android and the desk, and
recorded on the issue:

- The manifest list, not the dial, is the source of truth (§7). Every dial
  and belt body has a list twin.
- Focus ring 2px `--accent` outside the element on every control; sheets
  trap and return focus; the wake is `aria-live=polite`, failures
  `assertive`.
- Colour is never the only signal (urgency has T-labels; sections have
  asterisms; readings have "sure / unsure" words).
- No-JS and reduced-motion degrade to the plain list (§7): every page
  still reads and every form still submits.
- Text-grade tokens (`--ink-quiet`, `--accent-text`, `--ok-text`) for any
  text under 18px; raw `--ink-faint` is decoration only.

### 1.13 States, one grammar

- **Loading**: the sky is there from the first frame; a card shows three
  unlit rows (hairline placeholders at row height) instead of a spinner.
  Never a blank screen, never a spinner over the sky.
- **Empty**: one quiet mono sentence in the card and one pill, e.g.
  "nothing in orbit yet · add an item". Blame-free wording, as the search
  sheet's "nothing in your orbit is called …".
- **Error inside a card**: a red-text line (`--overdue`) under the control
  that failed, plus the control stays enabled. Save failures are loud
  (#1058): the line stays until the next attempt.
- **The wake** (toast): a one-line bar rising from the foot, 4s, with
  "undo" where the act is reversible (complete, dismiss, section toggle,
  theme change is instant so no wake). Above any sheet.
- **Page-level failure**: the `+error` page (§2.19).
- **Long content**: pages scroll; no accordions, no "show more" except
  where the desk already folds (maintenance's earlier updates).

---

## 2. The screens

Each section: purpose on a phone · what carries from desk and what changes ·
layout top to bottom · actions · gestures · states · reached from / leaves
to · verdict on any existing phone round · what Opus must not get wrong.

### 2.1 Home — the pocket sky (`/home`, and `/` when signed in)

**Purpose.** Glance: what needs me, what my relay caught, and one tap to
anything. Built and gate-checked; this is a lift, not a redraw.

**Carries / changes.** Wordmark + orb, dial, other-skies chips, search line,
Needs attention, Signals all stay in that order. Changes: the type scale
(§1.6) — row titles 16px, meta 13px, T-labels 13px mono, dates 13px, group
heads 12px, search line 16px; the orb's 44px hit; the dial body spacing
law; the chips become live; the search line becomes the search sheet; the
item sheet is wired; the north star arrives.

**Layout.**
1. Top row: wordmark (22px glyph + 15px word) left, orb right. When the
   inbox has unread arrivals the orb wears a 2px `--accent` ring and a
   count bead (13px mono) at its lower right — the pocket's inbox orb.
2. The dial, full width, aspect 1:1, quarter labels 13px mono. Bodies as
   built; a caught relay signal is the hollow ring body; the sun is lit,
   never pressed. First tap on a body: item sheet. Second tap on the lit
   body, or `open`: approach.
3. Other skies: horizontal chip strip, 44px tall chips with the ring glyph
   and name (14px mono). Tapping flies to that household's sky (desk
   behaviour; see owner question 3 on #1118). The current household is not
   in the strip. When the strip is empty the row is omitted.
4. Search line: "explore your world", 16px mono, hairline underneath, 44px
   hit. Tap raises the search sheet (§2.4). It is not an input on the
   page; it is a button drawn as the desk's field, so iOS never scrolls to
   a field that is about to move.
5. NEEDS ATTENTION rows, row grammar, trailing T-label over date.
6. SIGNALS — YOUR RELAY CAUGHT: suggestion rows (dashed, hollow mark),
   reading rows (breathing mark), failed rows (amber mark, message text in
   13px, `remove` as a swipe act).
7. The burn-up footnote, 13px mono, centred.
8. The north star: fixed bottom right, 24px inset + safe area, a 56px glass
   disc with the 12px four-point star and its soft halo; opens create
   (§2.5). It hides while any sheet is up and while the film plays.

**Item sheet** (callout size): title 18px, meta line 13px mono (T-label ·
date · cost · ◆ N documents), then three 44px pills: `open` (filled
accent), `documents`, `close`. `documents` grows the sheet to list size
with the papers as rows (name, size · pages, tap → preview §2.3). Suggestion
sheet: title, "caught 11 Aug · burns up in 43d", the readings as rows with
sure/unsure words, attachment row, then `Add to orbit` (filled, arms →
"tap again to add"), `Dismiss` (ghost, arms), `review & amend →` (link to
create pre-filled, §2.5), `close`.

**States.** Adrift (no household): the dial is replaced by SYSTEMS AROUND
YOU rows "tap to ask to join" / "asked to join · waiting" as built, at the
new scale. Nothing needs attention: the group shows "nothing needs you ·
next up Boiler service, T-22d" as one quiet row. No signals: group omitted.
Refused sign-in notice: a card above the dial, dismissable. Loading: the
dial draws its rings and the rows are unlit.

**Reached from.** The door, every back link, the film's end. **Leaves to.**
Item (approach), create (north star / hatch), inbox, settings,
administration (hatch), another sky (chip), search results.

**Verdict.** The built pocket home stands with the changes above. The
item-phone round's `home` scenes (which restage this screen) stand.

**Must not get wrong.** Do not shrink the dial to make room; the manifest
is below the fold and that is fine (the tab title and badge carry the
count, §3). Do not add a count anywhere on the sky. Do not make the search
line a real input on the page.

### 2.2 The hatch — account sheet (every signed-in screen)

List size. Rows in order: name (18px) and "Lawson Home · owner" (13px);
divider; `Add an item`, `Inbox · 1 waiting`, `Settings`, `Administration`
(admins) as 56px rows; divider; THEME label and the five swatches as 44px
rings in a row (current one accent-ringed, names as tooltips and in the
accessible name); `sign out →` as a ghost pill that arms ("tap again to
sign out"). The current page's row is marked with the accent text grade,
not hidden. Reached from the orb; leaves by any dismiss. On the sub-screens
this replaces `Chrome.svelte`'s dropdown below 901px; the markup and
behaviour are shared with home's `#maccount` rather than duplicated a
fourth time.

### 2.3 Item and the belt (`/item/<id>`, `/item`)

**Purpose.** One item's full command surface, its documents, and the way to
its neighbours in date order. `/item` without an id opens the nearest-due
item (as `+page.js` already does).

**Carries / changes.** Belt as a low arc across the top with the card
hanging beneath; end-caps at the shoulders; papers beside the apex; the
card's rows and five acts; preview sheet and reader (§18). Changes from
round 1: the type scale (card rows 16/13, not the drawn 13.5-ish mono
pairs); the find line is the search sheet's button; the acts are laid out
primary-first; action panels are sheets.

**Layout.**
1. Chrome: `← your sky` and the orb.
2. Find line: "find an item", same drawing and behaviour as home's search
   line; results approach directly (the belt is already the item screen).
3. Count line 12px caps: "6 ITEMS · IN DATE ORDER, SOONER TO LATER".
4. The belt band (≈150px tall): apex item as the lit body at top centre,
   its papers (44px hit, ringed, breathing glow) at ±20% of width, the two
   neighbours (17px rocks with 13px name and T-label under them) anchored
   at the edges, next-but-ones half off-screen and decorative. Three or
   more documents: the two nearest papers plus a "+N" clump at the crest
   which opens the document list sheet.
5. End-caps `← sooner` / `later →` as 44px ghost pills at the band's
   shoulders.
6. The card: title 21px display, section · type 13px mono, rows (due,
   orbital period, cost, reminders, provider, reference, notes when set)
   label left 13px ink-quiet / value right 15px mono. Then ACTIONS:
   `complete` filled `--ok-text` on `--ok` tint, full width; then a row of
   `reschedule` · `snooze`; then `edit` · `retire` (retire in `--overdue`
   text). All 44px. Then "2 documents ride in the belt · see them ›" as a
   row that opens the document list sheet.
7. Below the card: nothing. The sky.

**Actions as sheets.** `complete` is one tap → the record sheet (callout:
date done, optional cost and note, `record` filled) — items with nothing to
record complete on the tap with an undo wake. `reschedule`: callout with a
date field and three quick pills (+1 month, +3 months, +1 year).
`snooze`: callout with 1 week / 1 month / until a date. `edit`: full sheet
with create's form (§2.5) in edit mode, `save` at the foot. `retire`: arms
on the pill; second tap opens a callout "Retire Car MOT? It leaves the
dial; its documents stay in the belt for 30 days" with `retire` (overdue
tint) and `keep`.

**Gestures.** Horizontal swipe on the band or the card steps the belt (the
card slides out and the next slides in, 300ms; the URL updates). Vertical
scroll is the page. Tap a neighbour rock to bring it to the apex. Tap a
paper → preview sheet (list size: the page image nearly edge to edge on the
cream sheet, `fit −%+` at its head, page number and round arrows at the
foot only when there is a next page, `download` and `remove` as pills at
the right of the foot, remove arms). Tap the page → the reader: full
screen, belt dimmed and blurred behind, pinch to zoom, same foot. The
reader is the one full-screen window in the app.

**States.** Empty household: the band is drawn empty with "nothing in
orbit yet" and `add an item` / `set up your relay` pills. Removed document:
the preview shows the kept-until line and `restore` as one word (§18).
Scanning: the paper shows the sweep and the preview says "still checking".
Long name: wraps to three lines. Many documents: clump + list sheet.
Loading: band rings draw, card rows unlit. Unknown id: `+error` 404.

**Reached from.** Home (approach from the sheet, morph: the sheet lifts and
becomes the card while the dial fades and the band draws, 300ms), inbox's
filed rows, reminder links, search. **Leaves to.** Home (`← your sky`),
another item (belt), preview/reader (sheets).

**Verdict on round 1 (#1072/#1119, "the belt in the pocket").** **Stands
with changes:** lift the card's rows and pills to the §1.6 scale; acts laid
out complete-first as above; the three open questions are answered here —
(1) `documents` on the home sheet grows the sheet into the list (as
drawn), (2) more than two documents = the clump and the list sheet (as
drawn), (3) panels are sheets (as drawn). The inherited dial-spacing
defect is fixed by §1.7's spacing law, on home. The reader stands as §18.

**Must not get wrong.** Nothing tappable outside 0–390. Papers are 44px.
The end-caps live at the shoulders, never in the top row. The band is not
a carousel of cards; only the card moves.

### 2.4 Search — the sheet (`/home`, `/item`)

Ratified (#1057, owner 2026-09-19): the palette as a bottom sheet standing
on the keyboard, field at the top, results downward, first tap summons the
item's sheet, second tap approaches. **Stands with changes:** result rows
use the §1.5 grammar at 16/13 (not 13.5/11); the item sheet's buttons are
44px (the round flagged them at 36); the field is 16px. Before typing: the
two nearest attention rows and `→ add an item`. Typing: items, then
documents (◆), then one accent action row for the top match that arms.
No match: "nothing in your orbit is called 'x'" + `add "x" as an item`.
On the belt the first tap approaches directly. Dismiss drops the keyboard
too. Keyboard users: ↑↓ move, Enter opens, Escape closes.

### 2.5 Create (`/create`) and edit

**Purpose.** Add an item by hand or from a document; the same form edits an
item and amends a review.

**Carries / changes.** Genesis personality; type chips; the document drop
becomes a picker; progressive disclosure; the reading card. Changes: one
column, the reading card sits **below** the fields (desk's second lane),
the save bar is fixed at the foot, and the constellation names are hidden.

**Layout.**
1. Chrome. Title "New entry" 28px, "add something to your orbit" 13px.
2. TYPE: five chips, 44px tall, two rows, `aria-pressed`, glyph + word.
3. "add a document" row: a dashed 56px row with ◆ "photo or file · dates,
   amounts and references read for you"; tap opens the native picker with
   `accept` for PDF/images and `capture` offered by the platform (this is
   not ORB-FUT-007's capture flow; it is the picker).
4. The reading card (only once a document is chosen): the paper's name
   and size, then the readings as rows — label, value, "sure/unsure" 12px
   caps, and `accept` as the visible act per row (review-candidates C:
   every reading visible, no fold). A progress row while reading.
5. Fields, each label-above-field, 16px inputs 48px tall, full width: name;
   section (a chip strip with asterism marks, required per #1058, "tap to
   swap"); household (only when the reader is in more than one — a chip
   strip); provider; reference; due date (native date); recurrence ("every
   N months" — a stepper row with − / value / + at 44px, and "once" as its
   zero); cost (`inputmode=decimal`, currency from the household); reminders
   (two chips 21d · 7d default, editable in a callout); notes.
6. The save bar: fixed at the foot, glass, 44px filled pill `Add to orbit`
   (or `save` in edit mode, `add to orbit` from a review) and a ghost
   `never mind`. It stands on the keyboard.

**States.** Reading: progress row. Save failure: red line above the save
bar that stays (loud, #1058). Unsaved changes on back: a callout "Leave
without adding?" (`leave`, `stay`). Edit mode: title "Edit Car MOT", type
chips locked, `retire` not here (it lives on the item). Loading a review:
fields pre-filled with the accepted readings.

**Reached from.** North star, hatch, empty states, inbox `review & amend`,
item `edit`, search's `add as an item`. **Leaves to.** The new item on the
belt (approach after save, wake "added to your orbit"), or back.

**Must not get wrong.** Chips are 44px. The reading card is never beside
the form. The save bar never hides under the keyboard.

### 2.6 Inbox (`/inbox`)

**Purpose.** Decide on what the relay caught; see what it has fed in.

**Carries / changes.** The three lanes stack in **priority** order, not desk
order: FOR YOUR REVIEW, STILL READING, FAILED TO PROCESS, then FILED. The
relay bar shows only when the queue is empty (as desk). Inbox orb becomes
the orb's count.

**Layout.**
1. Chrome. Title "Inbox" 28px, the say-so line 13px.
2. FOR YOUR REVIEW · N: one card per receipt — title 18px, "caught 11 Aug
   · burns up in 43d" 13px (amber when under 14 days), readings as rows
   (label 13px ink-quiet, value 15px, sure/unsure caps), attachment row
   (◆ name · size · "scanned clean" in `--ok-text`), then `Add to orbit`
   filled full width, `Dismiss` ghost full width, `review & amend →` as a
   13px mono link row. Both acts arm.
3. STILL READING: rows with the breathing mark.
4. FAILED TO PROCESS: rows, amber mark, the message in 13px; `remove` is a
   swipe act.
5. FILED · N: rows "Car MOT — Volvo V60 / from mot-reminder.pdf · added 30
   Aug", tap → item.
6. Footnote.

**States.** Empty queue: the dish and "your relay is listening · nothing
waiting" with `open the relay →`. Busy per receipt: the pills show a
breathing dot and lock. Problem: red line under the pills. Many filed:
scrolls; the FILED head shows the count.

**Reached from.** Hatch, orb count, film. **Leaves to.** Item, create,
settings › mail.

**Must not get wrong.** The review's readings must not wrap label/value
into four-line pairs (the current squeeze). Buttons never side by side
under 200px each.

### 2.7 Settings (`/settings`)

**Purpose.** Your own controls, in the order you use them.

**Carries / changes.** Same cards, reordered for the pocket: You · Your sky
· Reminders · Your relay · Your systems · Where you're signed in. Sign-in
methods folds into You. Theme cards (five 300px slabs in the squeeze)
become a swatch strip. Reminders carries the ratified second tab (§20,
§22). "Take the walk again" stays hidden until #1083 ships (§24).

**Layout.**
1. Chrome. Title "Settings" 28px, the levers line 13px.
2. YOU: avatar ring 44px, name 18px, email 13px mono; `edit name` opens a
   callout. SIGN-IN METHODS as rows: password ("set · changed 24 Aug",
   swipe acts `change`, `remove`), identity provider ("linked 2 Jun",
   swipe act `unlink`), email approval (switch). A recent-authentication
   challenge is a callout sheet holding the door's card (§17).
3. YOUR SKY: a horizontal strip of five tiles 112×88 (sky swatch above,
   name 13px below, current one accent-ringed), 44px hit each.
4. REMINDERS with the pill-pair tabs `reminders · sent to you lately` wrapped
   under the heading (§22 under 560px): tab one — email reminders
   (switch), browser alerts · this device (switch; "not available in this
   browser" state), first warning / final warning as rows opening a
   callout picker, outbound mail status row; tab two — §2.8.
5. YOUR RELAY: address (13px mono, tap copies, wake "copied"), status,
   waiting-for-review count, `open the relay →` row.
6. YOUR SYSTEMS: rows with the ring glyph, name 16px, "2 members · 6
   items" 13px, role badge; tap → household.
7. WHERE YOU'RE SIGNED IN: rows "Chrome · Linux / this device", "Safari ·
   iPhone / last seen 45 days ago"; `sign out` is a swipe act per row
   (the visible-act exception does not apply: it is management). Then
   `sign out of every device →` as a ghost pill that arms.

**States.** Field save: the wake "saved". Failure: red line. No other
sessions: the card shows only this device.

**Verdict.** No round exists. **Must not get wrong.** No label/value wrap
into stacked mono fragments; every row is one line + one meta line.

### 2.8 Sent to you lately (Reminders, second tab)

Ratified list (§20, "61 approved"). On the pocket: rows "Car MOT — Volvo
V60 / email · 21 days before · 08 Aug 09:00", newest first, 13px mono meta;
empty: "nothing sent yet"; failures carry an amber mark and the reason.
Tap → the item. Nothing else changes.

### 2.9 Settings › mail — the relay (`/settings/mail`)

**Purpose.** Your listening address and whether it is working.

**Layout.** Chrome; the dish (art kept, dimmed); "Your relay" 21px and the
sentence 13px; the address as a full-width dashed pill (14px mono, tap
copies, `share` on platforms that have it); rows status / last received /
ingest, label-above-value when a value is long (a file name) so nothing
wraps mid-word; two 44px pills `rotate address` (arms) and `pause ingest`;
ARRIVED, BUT COULD NOT BE READ rows (date mark, message 13px); footnotes.
The star labels are hidden. **States.** Never received: "nothing yet —
forward a document to try it". Paused: the dish stops breathing and the
pill reads `resume`.

### 2.10 Household (`/household/<id>`)

**Purpose.** Manage one system: its identity, sections, people, archive and
the danger line.

**Carries / changes from round 1.** The H2 backdrop (faint); the system
card; sections with asterisms and switches; members; knocks visible;
invite; the archive card with tabs; the danger line. Round 1's recorded
owner decisions stand: **2b** the save control is a bar rising from the
foot ("unsaved changes · undo · save"), **3b** members first. Its
directions A (acts behind a tap) and B (acts on the row) are both
superseded by §25: **acts are behind a swipe**.

**Layout (owner view).**
1. Chrome `← settings`. Ring glyph, name 28px, "your system · you own it ·
   4 members · 6 entries" 13px.
2. MEMBERS · 4: rows avatar / name (· you) / role badge; swipe acts
   `hand over` (owners, on members), `remove`; on your own row `leave`
   (arms; the "nothing you added goes with you" sentence appears under
   the armed row). KNOCKING rows: "Gran asked to join · 2d ago" with
   `approve` / `decline` half-width pills visible. INVITED rows: email,
   "sent 3d ago · lapses 4d", swipe acts `resend`, `withdraw`.
   `invite someone` as a ghost pill at the card foot → callout sheet
   (email, name, `send`); `add an existing account` beneath it → callout
   with a search field.
3. THE SYSTEM: name (field, 48px), time zone and currency as rows that open
   a list sheet with a filter field (native `<select>` is acceptable for
   build one; the sheet is the target).
4. SECTIONS · 5 of 12: rows asterism / name 16px / "3 entries · shown"
   13px / switch; long-press to reorder; swipe act `remove` on custom
   sections; `add a section` ghost pill → callout (name + "tap to swap"
   mark tray, 44px marks, 4 per line). Toggles and reorders collect into
   the rising save bar (2b).
5. ARCHIVE (owner only): heading with the pill pair `export · import`
   wrapped beneath (§22). Export: one sentence, `export this system`
   pill (arms; then a progress row; then a `download` row with size).
   Import: `choose a file` pill → preview card (what it contains, counts)
   → `import` (arms). Both require the recent-authentication callout
   (§17) before the act fires.
6. THE DANGER LINE: sentence 13px, `delete this system` ghost pill in
   `--overdue`; tap → callout asking the name to be typed exactly, then
   `delete` (arms once more).

**Member view.** Same, without fields (values as text), without archive and
danger; `leave` on your own row.

**States.** Save bar states: hidden / "2 changes · undo · save" / saving /
"not saved — …" red. Empty invitations/knocks: omitted. Hidden section:
"0 entries · hidden" and the row dims.

**Verdict on round 1 (#1122).** **Needs a redraw** for the acts (swipe per
§25) and the type scale; the cards, the system card, the knock rule, the
mark tray, the save bar (2b) and members-first (3b) carry over as drawn.

**Must not get wrong.** No row act visible at rest except approve/decline.
Reorder handles are not 20px drag nubs; the row itself lifts on long
press. The `×` at x=446 must not exist.

### 2.11 Household recovery — the row on the clock

Ratified (§19, "56 b the row" / "57 admin only"): a deleted household shows
in Administration › Systems as a row with a clock — "Gran's Flat · deleted
2d ago · 13 days left" — and `restore` as a **visible** pill on a second
line (it is the point of the row), arms then fires; `delete now` is a swipe
act. Never on the household page.

### 2.12 Administration (`/administration`)

**Purpose.** The instance from above, for admins, on a phone mostly to
answer "is it healthy" and to let someone in.

**Carries / changes.** Observatory personality; the same cards; ratified
ops grammar (#1071, round 2); recovery rows (§2.11). Changes: the ISS
backdrop labels hide; alerts first; a **jump strip** under the title (the
only page with one) because it is the longest screen; the invite form is a
sheet; people and systems rows use swipe acts.

**Layout.**
1. Chrome. Title "Administration" 28px, "the instance from above · 5
   people · 5 systems" 13px.
2. Jump strip: horizontal 36px chips `people · systems · contact · mail ·
   operations · documents` that scroll to the card (anchors; works
   without JS).
3. Alert cards, when any: key rotation in progress, encrypted details
   locked, damaged values, no recovery bundle — amber-edged cards with one
   sentence and one pill each.
4. PEOPLE · 5: `invite someone` ghost pill in the card head → callout
   (email, display name, link valid for N days stepper, `create`; the
   shown-once setup link appears as a copy row). Rows avatar / name (· you)
   / email 13px / role badge; swipe acts `place in a system` (→ list
   sheet of systems), `new setup link`, `disable`.
5. SYSTEMS · 5: `new system` pill → callout. Rows ring glyph / name /
   "2 members · owner Tom Lawson · 6 items"; deleted ones as §2.11.
6. PUBLIC CONTACT: row with the address or "not set"; `set…` → callout.
7. MAIL MACHINERY: rows label / value; `rotate every address` as a pill
   that arms; document jobs rows per the ratified ops grammar.
8. OPERATIONS: rows service / status word in `--ok-text` or amber / "40s
   ago". Tap a row → callout with the last check's detail.
9. Version line 12px caps.

**States.** API failures per card: the card shows its red line, the rest
of the page still renders. Empty people (fresh instance): the invite pill
plus "only you so far".

**Verdict.** No round; #1068 (mockup overflow at 390) is answered by this
layout. **Must not get wrong.** Rows never truncate the email; it is the
meta line and wraps to two lines if it must. The jump strip is not tabs.

### 2.13 The door — signed out (`/`, `/login`)

**Purpose.** The hero moment (§4) on the device most people will meet Orbit
on first. Dawn breaks once on load.

**Carries / changes.** Round 1's "the ring rides high": the ring is fixed
in one station near the top on every door screen; the card sits beneath it
on the ring's axis; the ring closes to its small form when a field takes
focus. Every mode of §17 is the same card.

**Layout.** Safe-area gap → the ring (≈300px at 390, 4px stroke, the mark's
orb turning once per 40s) holding the word `orbit` on the bare door, or the
card's question ("Sign in to Orbit", 22px display) when a card is open →
the card: label-above-field, 48px fields at 16px, `Sign in` filled pill
44px full width, quiet lines ("local login", "send it again", "forgot?")
at 13px mono with 44px hits → the dawn beneath, horizon in the bottom fifth.

Modes: bare door (Sign in gate, "local login" line when local accounts
exist); local sign-in; sign-in with email/password; claim code (unclaimed
instance, pre-filled from `#claim=`); first administrator (email, name,
password; "continue with your identity provider" line instead of a gate
when one exists); waiting for email approval (countdown; "send it again");
too many attempts (backoff line, fields locked); refused / lapsed /
disabled (the held dawn, §2.17). Password fields have a 44px reveal control.

**Gestures.** Focus closes the ring to 96px and the card rises above the
keyboard; blur reopens it. Nothing else moves.

**States.** Busy: the pill shows the breathing dot and locks. Error: the
red line under the field it belongs to. Backoff: the line counts down.

**Reached from.** Cold start, `/logout`'s `Sign back in`, any signed-out
hit with `?returnTo`. **Leaves to.** Home (launch flight), the create-system
card (§2.16), the newcomer's ask-to-join climb.

**Verdict on round 1 (#1127).** **Stands with changes:** the two open
questions are answered — (1) the ring holds the **question** (heading
replaces the word; "the ring holds the questions" is the desk's own rule),
(2) the ring **rides high** and never travels. Changes: quiet lines lifted
from 10.5px to 13px; fields to 48px; the reveal control added.

**Must not get wrong.** Nothing under the drawn keyboard. The ring is not
the card. Dawn plays once, not on every mode change.

### 2.14 Setup — choose a password (`/setup/<token>`)

The door's fourth mode (§17), drawn in round 1's `setup*` scenes: the ring
holds "Choose a password", two 48px fields, `Continue` full width. States:
mismatch (red line under the second field), spent link (held dawn: "this
link has been used" + `sign in` line), lapsed. **Stands** with the same
lifts as §2.13. The current build's 38px fields and 115px button are the
defects.

### 2.15 Invite outcome (`/invite/<token>`)

Shown only when a link no longer works. The door station: the ring holds
one line ("This invitation has been used" / "…has lapsed" / "…was
withdrawn" / "This link isn't one we know"), one sentence 15px beneath, and
one full-width pill `Go to Orbit`. Mismatch (signed in as someone else):
"You're signed in as tom@… · this invitation is for someone else" with
`sign out and try again` (arms) and `stay signed in`. No chrome.

### 2.16 Approve a sign-in (`/approve/<token>`)

Already ruled phone-first (2026-09-18): one column, big `Approve`, equal
`This wasn't me` beneath. In this system: the door station, the ring holds
"Let this browser in?", a card with rows browser / place / asked (13px
label, 15px value), the lapse line, then `Approve` filled 52px full width,
`This wasn't me` ghost 44px full width. Phases: approved ("The browser that
asked is being let in — you can close this"), denied ("Nobody was let in.
Change your password" + `open settings`), spent/unknown. Busy locks both.
No chrome. This is the screen most likely to be opened from a phone's mail
app in a hurry; it must read at arm's length.

### 2.17 The held dawn — auth errors (`/login` states)

Ratified (#1056: B, no contact address). The door station with the sun
held under the horizon: "didn't complete" carries `try again` as a pill;
"account disabled" carries no pill, one sentence, and the word `orbit`
stays in the ring. Nothing else on screen.

### 2.18 Sign-out (`/logout`)

The sunset (CON-17) plays over the same station; the ring holds "signed
out"; `Sign back in` full-width pill in the lower third, above the ember
rim. No chrome. The two-tap sign-out that leads here is the hatch's.

### 2.19 Off the chart — 404 and other errors (`+error.svelte`)

404: the gravity well (§16) scaled to width — the spiral canvas fills the
screen, the hole centred in the upper half, everything crossing travels
behind the text; "off the chart" 28px display, one line 15px, `plot a
course home →` as a 44px pill; arrival in 1–1.5s. Other statuses: the door
station with the status number 48px mono in the ring, one sentence ("Orbit
couldn't answer that · 500"), `return home` pill. No chrome. **Stands** for
404 (built); the other-status face is new.

### 2.20 Maintenance (`/maintenance`)

Totality; built and gate-checked; **stands**. Two fixes: the earlier
updates fold (`<details>`) gets a 44px summary row with the chevron, and
its paragraphs are 15px, not clipped. The moon's transit stays the
progress bar.

### 2.21 First-run film — the pocket cut

**Purpose.** The one welcome (§23), on the real pocket screens.

**Verdict on round 8 (#1083, "the pocket cut").** **Stands with changes**,
all already ruled by the owner on 2026-09-25: transport docks to the top
while a sheet is up and returns after (Q1 a), with the two timing fixes;
chapter 8 is **re-cut against the redrawn belt** (Q2 c) once §2.3 is
built; the phone line reads "later → steps the belt" without the
arrow-keys clause (Q3 b). Further changes from this system: the film is
restaged once home's type lift and the north star land (it plays over the
real screens, so they must be final first); chapter 1/10's "tap to ask to
join" copy follows owner question 3; the transport pill's chapter name and
time are 13px mono, its buttons 44px; the transport sits above the safe
area; the north star hides while the film plays.

**Must not get wrong.** `tourSeenAt` is spent only when the film ends or
is skipped (§24). Nothing plays on a phone until this ships.

### 2.22 Portable archive, review candidates, sections mark, mail template

Covered inside their host screens: the archive card is §2.10 step 5 (round
7 grammar); review candidates C is the readings list in §2.5/§2.6;
asterisms are the marks in §2.5's section chips and §2.10's rows; the mail
template (#1055 round 3) is an email, not a screen — its phone check (the
gold outline) is done and out of this document's scope.

---

## 3. Drawing order for Opus

Each round is one mockup file per screen at 390 and 360, self-measured
(nothing outside 0–width, nothing under 44px, nothing under 12px, no
overlaps), in the ui-visioning round format.

1. **The kit** — §1 as one page of parts: top chrome (rest, retracted,
   returned), the three sheet sizes, the row grammar with a swiped row and
   its armed act, the type scale, pills, switches, the wake, unlit rows,
   the north star. Everything after copies from it, so it goes first and
   is verdicted first.
2. **Home lift + item sheet + search sheet** — small, unblocks #1119 and
   #1057, and the film restages over it.
3. **Item and the belt, preview and reader** — needed before home→item is
   real and before the film's chapter 8 (owner: belt first, Q2 c).
4. **Create / edit** — item's `edit` and inbox's `review & amend` reuse it.
5. **Inbox** — depends on the row grammar and create.
6. **Household** — the first full use of swipe acts and the save bar;
   includes the archive card and the recent-authentication callout, which
   settings and administration then reuse.
7. **Settings, sent-to-you-lately, settings › mail** — reuse the callout
   and the tabs.
8. **Administration** — reuses everything above plus the jump strip and
   recovery rows.
9. **The door family** — door modes, setup, invite, approve, held dawn,
   sign-out, 404/other errors, maintenance fixes. Independent of 2–8, so it
   can run in parallel with them once the kit is verdicted; it is listed
   here so the first-impression screens are not last by accident.
10. **The film's pocket cut** — last, because it plays over final screens
    and chapter 8 needs the built belt.

Build follows the same order; the fidelity gate gains a phone check for
each screen as it lands (#1120's last row).

---

## 4. Questions for the owner

**1** The north star on the pocket home (§2.1 step 8) — a fixed "add"
body at the bottom right. Home is ratified and built, so adding a control
to it is yours.
 a) Add it, as described (my recommendation: adding is the second most
    common thing a phone does here, and two taps through a menu is not
    slick; it is also the desk's own create chrome carried over).
 b) Keep add inside the hatch only.

**2** Lifting the pocket home's type to the §1.6 scale (row titles 13.5→16,
meta 11→13, dates 9.5→13, group heads 10→12). It changes a ratified
surface's proportions: the manifest gets about 20% taller.
 a) Lift it (my recommendation: 9.5px dates fail the "real access" bar on
    any phone, and the desk's own rows are 14.5px).
 b) Keep the built sizes on home and use the new scale only elsewhere.

**3** #1118 — what an other-skies chip does. There is no ask-to-join flow
for someone who already has a household, on desk or phone; desk's chips
fly to that sky.
 a) Chips fly to that household's sky, as desk; fix the film's chapter 1/10
    copy to say so (my recommendation).
 b) Build an ask-to-join flow behind the chips and keep the film's copy.

---

## 5. Carrying the desk's character (after the kit build)

Written 2026-09-25 against the built kit (`web/src/lib/pocket/`, shots at
390 wide) and the desk's fidelity baselines. The owner's verdict on the kit:
acceptable for now, but basic next to the main site. This section says what
"basic" is, part by part, and the CSS-level rules that fix it in the kit so
every screen inherits the fix. Nothing here re-opens §1: the floor (12px,
13px for anything read to act), 44px targets, the swipe-only row acts and
the rest of §25 stand, and every rule below was checked against them.

### 5.1 What the desk does that the kit does not

Looking at `home.png`, `item.png`, `household.png`, `settings.png` and
`inbox.png` next to `01-kit-rest.png` through `13-reorder-lifted.png`, the
difference is not the components; it is everything around and inside them.

- **The sky.** Every signed-in desk page stands on a fixed, drifting, seeded
  star field (`lib/sky.js`: two tiled layers, 95 far and 46 near stars over
  a 1600×1000 tile, `driftf` 400s and `driftn` 195s from `atmosphere.css`)
  and a vignette (`radial-gradient(ellipse at 50% 34%, transparent 55%,
  rgba(0,0,0,.28) 100%)`, off on dawn and clouds). The kit route draws
  neither: `body{background:var(--bg)}` and nothing else. The built pocket
  home has a sky (`pocket.svelte`, a 400×850 field), so the character
  exists; it is just not a kit part, and every other pocket screen would
  currently arrive on a flat colour. On a flat colour, glass is invisible:
  `--panel` at 55% over `--bg` is `--bg`, so the cards read as hairline
  boxes, which is the "basic" the owner sees.
- **Glass, and what sits on it.** Desk cards are `var(--panel)` +
  `backdrop-filter:blur(8px)` + `1px solid var(--line-soft)` + radius 16
  (`household.css`, `settings.css`), and rows inside them are transparent
  with a `--line-soft` hairline between. The kit's `.p-card` matches, but
  `Row.svelte` paints every row face opaque
  (`linear-gradient(var(--panel),var(--panel)), var(--bg)`) so the acts
  never show through. Inside a card that makes each row a solid strip, one
  tone darker than the card, and there is no hairline between rows. That is
  the second half of "basic".
- **Colour on acts.** Desk act pills each carry their act's colour
  (`item.css`: `--act` on the border at 40%, `--act-text` on the word,
  `--panel` behind; complete is `--ok`, reschedule `--upcoming`, snooze
  `--warm`, edit `--accent`, retire `--overdue`). Every kit pill is
  `--line` grey with `--ink-mid` mono; only `.danger` differs. The pills
  card in `01-kit-rest.png` is a row of grey.
- **Marks.** Desk bodies are layered: a core with a halo ring
  (`box-shadow:0 0 0 2.5px var(--bg)`), status variants (`.ter` half-lit,
  `.con` ringed, `.exp` dashed, `.sug` hollow accent), avatar rings with
  mono initials, the paper `◆` in `--paper`. The kit's rows use a flat
  10px dot and a 24px ring; the pocket home's `.pk-dot` variants already
  carry the status forms but they live in `pocket.css`, not the kit.
- **Depth.** Desk drawers and callouts are `--panel-raised` at blur 14 to
  16 over a scrim of `rgba(4,7,16,.55)`, with a lifted shadow
  (`0 18px 44px rgba(0,0,0,.45)` on the belt's card) and a top hairline.
  The kit's sheet is the same tone as the page's cards, has no shadow and
  no edge light, so in `07-sheet-list.png` the sheet and the card behind
  it are one flat plane.
- **Typography.** The desk pairs Space Grotesk for the page title and
  filled buttons (`household.css .btn`: `600 13px var(--display)`) with
  mono for everything that is data (brand principle 4, "mono is memory":
  `.kv`, `.sub`, dates, amounts, roles) and caps tracked at `.18em`. The
  kit's title and card title are right; the filled pill is `--ui` 600, row
  meta ("Home · £84", "member") is `--ui`, and caps track at `.14em`. The
  effect is that the kit reads as a system font UI with a display heading
  on top, not as the desk's mono-and-display pairing.
- **Chrome.** The desk orb is 40px glass on the sky with an `--accent`
  hover ring; the back link carries a three-layer `--bg` halo. The kit's
  orb and back link match. What the kit lacks is the returned chrome's
  ground: `color-mix(--bg 70%)` + blur 16 over scrolling content is both
  the most expensive rule in the kit and the least desk-like (the desk
  never puts a glass strip over content; it lets the halo do the work).
- **Signatures.** The desk's small habits: `→` at the end of a pill word
  that leaves the page, `·` as the separator, dashed borders on anything
  Orbit proposes (`.pk-sugg`, the joiner's ring, the empty seat), the
  hazard rule along the top of a danger card
  (`repeating-linear-gradient(115deg, var(--overdue) 0 2px, transparent
  2px 6px)`, 6px tall) with a red wash at 8.5%, the accent ring on the
  orb when the inbox waits, retrograde's bloom on accent things only, and
  the north star's glint. The kit has the halo, the dashed suggestion and
  the glint; it has none of the others.
- **Motion.** The desk's sky drifts on two periods; the pocket home's
  drifts on one (`drift` 180s, 40px). Row press is 120ms; hover states
  exist on pills but a phone has no hover, so a pressed pill shows nothing.
- **Grain.** Not a gap. `Grain.svelte` mounts only on the door, sign-in
  flight, sign-out, `+error` and maintenance; signed-in desk pages have no
  grain. §1.9 said "grain fades in" for every page; that overstated the
  desk. The pocket matches the desk: grain on the same five personalities,
  none on signed-in screens (owner question 4).

### 5.2 The rules, part by part

Tokens and classes named here are the desk's own unless marked **new**. New
tokens go in `pocket/tokens.css`; new rules in `pocket/kit.css` or the part's
own `<style>`.

**Surfaces: the sky and the vignette.**

- **new** `pocket/Sky.svelte`: lift `pocket.svelte`'s `.sky` into the kit.
  A fixed `inset:-5%` SVG, `viewBox 0 0 400 850`, `preserveAspectRatio
  xMidYMid slice`, two `<g>` layers filled `var(--star-far)` and
  `var(--star-near)`, stars from `fillStarTiles` (`lib/sky.js`) with the
  counts scaled to the tile: 40 far, 20 near. Layer drift as the desk's
  two periods, transform only: far `translateX(-400px)` over 400s, near
  over 195s, each tile repeated once with `<use x="400">` so the wrap is
  seamless. Opacity `var(--stars)` (afterdark's .6 comes free). Below the
  stars a **new** `.p-vignette`: the desk's radial rule verbatim,
  `display:none` on dawn and clouds, as `inbox.css` does.
- Dawn and clouds: apply the desk's sky masks (`home.css` `[data-theme=dawn]
  .desk .sky` and clouds) to `.p-sky` so stars fade toward the ground.
- Every pocket screen mounts `Sky` first in its markup; the kit route too.
  The five personality screens (door, sign-out, 404, maintenance, the
  film) keep their own skies and are the only ones that also mount
  `Grain`.
- `theme-color` per pack is `--bg` (§1.11); unchanged.

**Cards.**

- `.p-card` keeps `--panel` + blur 8 + `--line-soft` + radius 16. Add the
  light packs' edge light from `home.css` 1051: on dawn and clouds
  `box-shadow:inset 0 1px 0 rgba(255,255,255,.72), 0 8px 20px
  rgba(48,66,98,.07)`; on the dark packs `inset 0 1px 0 rgba(255,255,255,
  .05)`. One rule, per theme, in `kit.css`.
- Card heads: `.p-caps` tracking to `.18em` (the desk's `card h2`). 12px
  stays. Inside a card the head's margin is `0 0 12px`; between cards it
  keeps `--p-group-above`.
- Rows inside a card: transparent faces (below) with `border-top:1px solid
  var(--line-soft)` on every row after the first, at the row's text edge
  (`margin-left:calc(var(--p-row-mark) + var(--p-row-gap))`) so the mark
  column reads as a rail, as the desk's members list does.
- Danger card, **new** `.p-card.danger`: the household's rule verbatim,
  `border:1.5px solid var(--overdue)`, `::after` wash `--overdue` at .085
  (.12 on dawn and clouds), `::before` hazard rule 6px along the top. Used
  by the household's deletion card, settings' danger line and any card
  whose primary act cannot be undone.
- Proposal card, **new** `.p-card.proposed`: `border-style:dashed;
  border-color:color-mix(in srgb, var(--accent) 45%, var(--line-soft))`,
  already the pocket home's `.pk-sugg`; move it into the kit.

**Rows.**

- `Row.svelte` `.face`: `background:transparent` at rest. While
  `[data-swiping]` or `[data-open]`, `background:linear-gradient(
  var(--panel),var(--panel)), var(--bg)` so the acts under it stay hidden
  where the face still covers them. The acts are `opacity:0` at rest, so
  nothing shows through a transparent face; this changes no behaviour §25
  relies on.
- Press: `--panel-raised` for 120ms, unchanged.
- `.meta`: `var(--mono)` when the meta is data (section · amount, date,
  size, role, address); `var(--ui)` only for a sentence ("still reading its
  document"). Expose it as a prop `metaFace="mono"|"ui"`, default mono.
- `.trail`: unchanged (mono, 13px), but the T-label takes its urgency ink
  as the pocket home already does: `--overdue-text`, `--warm`,
  `--upcoming`, `--ok-text`.
- Marks, **new** `pocket/Mark.svelte` or classes in `kit.css`, lifted from
  `pocket.css` and `home.css`'s corridor: `.p-body` 10px core with
  `box-shadow:0 0 0 2.5px var(--bg)` (the halo ring), colour from the
  urgency token; `.p-body.ter` half-lit gradient; `.p-body.con` ringed
  radial; `.p-body.exp` `1.6px dashed currentColor`; `.p-body.sug` hollow
  `--accent`; `.p-body.breathing` the 2.4s pulse; `.p-body.failed`
  `--degraded`. Avatar ring `.p-avatar`: 24px, `1px solid var(--line)`,
  `--panel` fill, `600 .75rem var(--mono)` initials, `--ink-mid`; the
  owner's ring `--accent`. Paper `.p-paper`: `◆` in `--accent-text`
  (`--paper` where the belt defines it). Asterism `.p-aster`: `--accent`.
  Rule: a mark is never a plain filled circle.
- Long-press lift: keep the shadow; add `background:var(--panel-raised)`
  on the lifted face so it reads as picked up off the glass.

**Pills.**

- Ghost pill takes an act colour the desk way. **new** on `.p-pill`:
  `border-color:color-mix(in srgb, var(--act, var(--line)) 40%,
  transparent); color:var(--act-text, var(--ink-mid));
  background:var(--panel)`. Callers set `--act`/`--act-text` per act,
  exactly as `item.css` does: complete `--ok`/`--ok-text`, reschedule
  `--upcoming`/`--upcoming`, snooze `--warm`/`--warm`, edit and open
  `--accent`/`--accent-text`, remove/retire/sign out `--overdue`/
  `--overdue-text`. `.p-pill.danger` becomes the `--overdue` case of the
  same rule. Navigational pills (documents, settings) stay unset, so grey.
- Filled primary: `font:600 var(--p-type-button) var(--display)`,
  `letter-spacing:.01em`, text `var(--bg)` (the desk's `.btn`); add
  `box-shadow:0 0 28px -8px color-mix(in srgb, var(--accent) 35%,
  transparent)` on the dark packs only (`ringcard.css`'s `.act` glow, cut
  to a third). No glow on dawn or clouds.
- Press state, since there is no hover: `.p-pill:active{border-color:
  var(--act, var(--accent)); background:color-mix(in srgb, var(--act,
  var(--accent)) 14%, transparent)}` (the desk's `aria-pressed` look);
  `.p-pill.filled:active{filter:brightness(.92)}`.
- A pill whose word leaves the page ends in `→` (open, sign out, review &
  amend); a pill that acts in place does not. Text, not CSS.
- Armed: `ArmButton` keeps the crossfade; while armed the border is
  `--overdue` at full and the wash `color-mix(--overdue 12%)`, so "tap
  again to remove" reads as lit, not just red text.

**Sheets.**

- `.panel` background `var(--panel-raised)` (not `--panel`), blur 16
  stays: one fixed element, the one place a big blur is worth its cost.
  Add `box-shadow:0 -18px 44px rgba(0,0,0,.45), inset 0 1px 0
  rgba(255,255,255,.06)`; dawn and clouds `inset 0 1px 0
  rgba(255,255,255,.78), 0 -16px 36px rgba(48,66,98,.10)`.
- Scrim `rgba(4,7,16,.55)` on dark packs (`home.css` `.askcard`'s), `color-
  mix(var(--bg) 45%)` on the light packs. No blur on the scrim.
- Head: title in `600 var(--p-type-sheet) var(--display)`, the desk's
  card title face; the `close` word stays mono. Under the head a
  `--line-soft` hairline, full width, as the hatch already draws.
- Key/value lines inside a sheet, **new** `.p-kv`: the belt's `.kv` at the
  floor size: `display:flex; justify-content:space-between;
  font:var(--p-type-meta) var(--mono); color:var(--ink-mid); padding:8px
  2px; border-bottom:1px solid var(--line-soft)`, value `b` in `--ink`,
  status classes `.over .soon .up .ok .clean .ended` with the belt's inks.
  The item sheet's "T-16d · 29 Aug · £84" line becomes three `.p-kv` rows
  only where the sheet grows to full; the callout keeps the one-line
  `.pk-meta`.
- The grab handle takes `--line` (unchanged) and, on retrograde, `box-
  shadow:0 0 8px var(--bloom)`.

**Top chrome.**

- Rest: unchanged (halo on the back link, orb 36 drawn, 44 hit).
- Returned after a scroll (`.scrolled`): drop the blur. Ground is
  `linear-gradient(var(--bg) 60%, transparent)` with the halo doing the
  legibility work, the way the desk's back link sits on stars. Keep the
  `--line-soft` hairline only on the light packs, where the gradient alone
  is too soft.
- The orb: drop its `backdrop-filter:blur(8px)`; `--panel` over the sky is
  enough at 36px and it removes a blur from a fixed layer that repaints on
  every scroll. Inbox waiting: the `--accent` 2px ring and count bead as
  the pocket home does; on retrograde the bead takes `box-shadow:0 0 9px
  var(--bloom)`.
- Wordmark on home: the desk's mark at 22px beside the word, `--display`
  600, unchanged.

**The hatch.**

- The head is the account: `.p-avatar` at 36px before the name, the name
  in display 600 18px, the role line under it in mono 13px (`--ink-quiet`).
- Menu rows use the row grammar with marks: `+` for Add an item
  (`--accent-text` mono), the inbox row's trail is the count in an accent
  bead when it is above zero, Administration takes the station's mark.
- Swatches: 30px discs stay; the chosen one takes the desk's ring
  (`outline:2px solid var(--accent); outline-offset:3px`, unchanged) and
  each disc paints the pack's `--bg` plus its swatch shadow from
  `theme-swatches.js` (retrograde's magenta ring is the tell).
- Sign out is the `--overdue` act pill with `→`, armed as now.

**The wake.**

- `--panel-raised`, no blur (it is opaque enough at 75–86%), keep the
  shadow. A 2px inset rule on the leading edge in the act's colour:
  `box-shadow:inset 3px 0 0 var(--act, var(--accent))`, `--ok` for
  completed, `--accent` for reversible, `--overdue` for a failure (which
  also keeps its red border). `undo` is the `--accent` act pill.

**Empty, loading and error states.**

- Unlit rows: keep; the leading placeholder becomes a hollow `.p-body`
  ring in `--line-soft`, not a 24px circle, so it matches the lit row.
- Empty: the mono sentence stays; its pill (`add an item`) carries
  `--accent`. The card that is empty takes `.p-card.proposed`'s dashed
  edge, the desk's "nothing here yet" pen (the empty seat, the joiner).
- Error line: keep; add the desk's `errin` entrance (`opacity 0 → 1,
  translateY(-4px) → 0`, 200ms) so a failure arrives rather than appears.
- No spinners, no skeleton shimmer: the desk has neither.

**The north star.**

- Keep the disc and the glint. Add the pocket's `--stars`-independent
  halo: `box-shadow:0 6px 20px rgba(0,0,0,.3), 0 0 0 1px var(--line), 0 0
  24px -6px color-mix(in srgb, var(--accent) 40%, transparent)` on the
  dark packs; on retrograde the glint takes `filter:drop-shadow(0 0 2.5px
  var(--bloom))`, the desk's rule. Dawn and clouds: the first two shadows
  only.

**Page personalities on the pocket.**

- Where a desk page has backdrop art (administration's station, create's
  constellations, the household's H2 year, the relay's dish), the pocket
  shows the art only where it survives whole at 390 (§1.10), dimmed one
  step (`opacity:.6` on the art's root), never labelled text that the edge
  would cut. Art is `position:fixed`, transform-only motion, under the
  vignette and above the stars. Where the art is hidden the sky and
  vignette alone carry the page.

**Retrograde, once.** The desk's bloom law (`home.css` §3): accent things
only, small radius, low alpha, no animation, always `var(--bloom)`. In the
kit that is: the filled pill, the armed act's border, the orb's waiting
ring, the wake's accent rule, the north star, the grab handle, `.p-body.sug`
and the T-label when it is the accent. Never on greens, reds or ink.

### 5.3 What stays, and what to avoid

- The floor: nothing under 12px; 12px only for tracked caps; anything read
  to act 13px or larger. Colour on a pill word always uses the `-text`
  companion (`packs.css` #491), so every act colour passes 4.5:1 on every
  pack, including dawn and clouds where `--accent` alone fails.
- 44px targets and the swipe-only row acts (§25 / #1122): untouched. The
  transparent face changes how a row looks, not what it does.
- Focus rings, `inert`, live regions, reduced motion: unchanged. Under
  `prefers-reduced-motion` the sky's drift, the glint, the breathing body
  and the arrival of the error line all stop; rows still swipe.
- Performance, the budget: one `backdrop-filter` per fixed layer at most
  (sheet 16, nothing else fixed), cards at blur 8 and never more than the
  viewport's worth, and no blur on anything that scrolls inside a
  scroller (rows, pills, marks, the orb) or on the scrim. The sky is one
  SVG of ~60 circles animated by `transform` on two `<g>`s; the vignette
  and every glow is a static gradient or `box-shadow`. No `filter` on
  moving elements outside retrograde's three drop-shadows. No `will-change`
  on rows. Measure on the lowest device in the test set (§1.12): sixty
  frames while scrolling the household page with the chrome returning.
- Nothing decorative on the dial (owner §12): every body is a real item.
  The rules above dress the marks; they add no bodies.

### 5.4 Priority order

The five that do most of the lift, in order; each is one change to one kit
file and every screen inherits it.

1. **The sky and vignette as a kit part** (`Sky.svelte`, `.p-vignette`),
   mounted on every pocket screen. Without it nothing else reads as glass.
2. **Transparent row faces and the hairline rail** (`Row.svelte`, `kit.css`).
   Turns solid strips back into rows on a card.
3. **Act colour on pills** (`--act`/`--act-text` on `.p-pill`, display face
   on the filled pill, `:active` states). The desk's "more colour on the
   action buttons" (owner, 2026-08-15) carried over.
4. **Sheet depth** (`--panel-raised`, shadow, edge light, dark scrim,
   display-face title).
5. **Marks** (`.p-body` variants, `.p-avatar`, `.p-paper`) and the north
   star's halo.

Then, as one pass: caps tracking `.18em`, mono meta, the danger and
proposal cards, the wake's leading rule, the chrome's returned ground, the
hatch head, retrograde's bloom list.

### 5.5 Questions for the owner (continuing §4's numbering)

**4** Grain on signed-in pocket screens. The desk has none there (grain is
the door, sign-in, sign-out, error and maintenance only); §1.9 said every
page.
 a) Match the desk: no grain on signed-in screens (my recommendation; it is
    also the cheapest choice on a phone).
 b) Grain everywhere on the pocket, at the desk's opacity.

**5** The filled primary's soft accent glow on the dark packs (§5.2, pills).
It is the door's sign-in button glow at a third strength, on every
"Add to orbit" and "Save".
 a) Yes, on the dark packs (my recommendation).
 b) No glow on filled pills anywhere; keep the bloom to retrograde.
