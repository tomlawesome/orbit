# First-run tour — round 3 (#866)

Rounds 1–2 ratified **B — across the ship**, **watch-only**, ten beats and the
Car MOT data story (verdicts in `../round-1/README.md` and `../round-2/README.md`).
Round 3 reopens none of that. It settles one thing: **how the film moves**.

Today every beat is a still, a hard cut, a veil and a fixed card bottom-right.
The owner's steer on 2026-09-16: *"move through the site with people,
explaining along the way. The tour fills in the info, it clicks the buttons for
you. Useful information and explanation shows at the right times, it's
animated, clear and helpful."*

So the tour now **does** things. One scene, two ways, four beats:

| # | Beat | What happens |
|---|---|---|
| 1 | arrive on the empty sky | the chart is lit, then the sun |
| 2 | the tour adds the MOT itself | the north star is pressed, the drawer fills, **add** is pressed |
| 3 | it lands where its date falls | the body draws onto the ring at T−381 |
| 7 | the tour opens the body's belt | the body is pressed, the belt opens |

The round stops after beat 7. Beats 4–6 and 8–10 follow the same rules and are
not redrawn here.

Served at:

- Guide — http://192.168.11.30:8335/v19/tour/round-3/c-guide.html
- Lift — http://192.168.11.30:8335/v19/tour/round-3/d-lift.html

Reviewer controls as rounds 1–2: next / back / skip, `←` `→` `Esc`, `#beat-n`
in the address bar (1, 2, 3, 7), plus **`r` to replay the current beat** —
these are films, so you will want to watch one twice.

## The two concepts

**Guide** (`c-guide.html`). A visible tour pointer travels between controls and
presses them: a 14px ring, 1px accent stroke at 85%, a 3px centre dot, a soft
10px accent glow at 25%. It moves along a gentle arc, never jerks, and settles
by easing its glow to 45%. A press tightens the ring to 10px and releases, with
one faint ripple — no flash, no arrow, nothing shaped like a mouse cursor.
While a field is being typed the pointer parks below-right of it; while a
callout is being read it rests still, 16px lower-right of the callout's target.
Cost: something that is not the reader's cursor moves the reader's screen.

**Lift** (`d-lift.html`). No pointer at all. The control itself acts: a 6px
accent dot glides from the last control along the same path, grows into the
next control's outline over 200ms, and the control lifts 2px with a stronger
glow before it presses. Typing happens with the field lifted. Cost: with
nothing travelling but a dot, the eye has less to follow between two distant
controls.

Everything else is identical between the two.

## The rules both directions share

- **Callouts replace the card.** Explanation is pinned to the thing just acted
  on: max 260px wide, raised-panel glass, 1px line border, 12px radius, 13.5px
  ink, a 10px stem pointing at the target, on whichever side has room. It
  arrives 120ms after the action lands (fade plus a 6px slide from the target
  side) and leaves as the next travel begins.
- **The copy is the ratified copy**, split so the first line arrives with the
  action and the second with the result. Nothing here is new prose: beat 1 is
  `stops.js`'s "This is your star chart." and "Every sun is a household you
  belong to."; beats 2, 3 and 7 are round 1's own beat lines.
- **No bottom-right card.** A 2px accent progress strip grows along the top
  edge of the stage, and the beat counter and **skip** sit top-right, clear of
  the account and inbox orbs.
- **Doing, not cutting.** Beat 2 presses the north star, crossfades the drawer
  in, types the name, presses **inspection**, types the date, types the cost,
  presses **every year**, presses **add**, crossfades back to the sky and blooms
  the new body onto the ring. Beat 7 presses that body and crossfades to the
  belt. Every press scales the pressed control to .96 and back.
- **Veil and cut-outs are round 1's**, unchanged, at `.62`, so the acted-on
  control stays at full strength.
- **Reduced motion**: no travel, no typing animation. Each state appears
  complete and is held 1200ms; callouts appear without the slide.

## Timing (owner's steer, 2026-09-18)

*"the pointer needs to be elegant and the tour needs to be timed for the
average human."* Every number below is that steer, and the pointer
specification above is too.

- Typing 70ms per character, 300ms before the first one.
- 350ms hover on a control before it is pressed.
- A callout is held 1000ms plus 350ms per word, never under 2400ms.
- 600ms between fields in the drawer; 350ms crossfades; travel is 500ms plus
  0.6ms per stage-pixel, eased `cubic-bezier(.25,.1,.25,1)`.

Measured running time of the four beats: **Guide 37.9s, Lift 41.6s** (Lift is
longer because every control is lifted before it is pressed). That is under the
60–75s the steer expected, because this round plays four of the ten beats and
five callouts; the six beats not drawn here are single-callout beats shaped
like 1, 3 and 7, so the whole walk at this pace is roughly twice these numbers.
Say the word and the holds go up.

## Backdrops

`shots/` is round 1's capture of the fixture app at 1280×800: `home-empty.png`
(beat 1 and the north star press), `create.png` (beat 2), `home.png` (beat 3
and the body press), `belt.png` (beat 7). Every coordinate was measured off
those files.

Two things the shots cannot show, drawn in rather than invented around:

- `create.png` is the drawer the instant the north star opens it — type chips
  and a drop zone, and no name, date, cost, repeat or add. Those five are
  blanked in with round 1's `.field-blank` and drawn in the drawer's own
  chrome, which is how round 1 typed the name over the heading.
- Beats 4–6 are not in this round, so the body is still at T−381 when beat 7
  opens its belt. `belt.png` is the shipped shot and says T−16d; the tour does
  not draw round it, as round 2 did not draw round #1035.

One change to round 1's framing: the belt's two circular cut-outs grew from
124px to 140px. At 124 the veil cut the caption to "T certificate 2025".

## Verdicts (owner, 2026-09-19)

*"The lift tour is better but it's still not right. You didn't show any of the
stuff below the dial, nor click on any of the documents or cycle through any of
the items in the meteor belt. You didn't show how to get to the inbox, or show
the menu with the themes. I also prefer the idea of the tour being one
continuous uninterrupted journey. There should be a little more information
along the way, and I'd like to try having a time bar and a play/pause/stop
button instead of next back and skip."*

- **Lift survives; Guide is closed.** The control acts; nothing that is not the
  reader's cursor travels the screen.
- Beats are closed as a mechanic: round 4 is one continuous film with a time
  bar and play / pause / stop.
- Round 4 must show: the manifest below the dial, a document brought in from
  the belt and the belt cycled, the way to the inbox, the account menu and its
  themes — and carry more of the ratified copy along the way.

Written by Claude Opus 5, 2026-09-18.
