# First-run tour — round 4 (#866)

Rounds 1–3 ratified **across the ship**, **watch-only**, the ten beats, the Car
MOT data story and the **Lift** mechanic — no pointer, the control itself rises,
glows and presses (verdicts in `../round-1/`, `../round-2/`, `../round-3/`).
Round 4 changes the shape of the thing: beats are gone, and the walk is one
continuous film with a transport under it.

One direction: **E — one take**, at
http://192.168.11.30:8335/v19/tour/round-4/e-one-take.html

## The owner's steer (2026-09-19, verbatim)

*"The lift tour is better but it's still not right. You didn't show any of the
stuff below the dial, nor click on any of the documents or cycle through any of
the items in the meteor belt. You didn't show how to get to the inbox, or show
the menu with the themes. I also prefer the idea of the tour being one
continuous uninterrupted journey. There should be a little more information
along the way, and I'd like to try having a time bar and a play/pause/stop
button instead of next back and skip."*

## The film

Twelve chapters, arrival to end, with nothing between them — no next, no back,
no skip, no `#beat-n`. Everything the tour does it does by pressing a real
control the way round 3 did. Measured length **3:34**; measured chapter starts:

| # | Chapter | Starts | What it shows |
|---|---------|--------|---------------|
| 1 | Arrive | 0:00 | the chart, the sun, the four households around it, Gran's Flat |
| 2 | Add | 0:22 | the north star pressed, the drawer filled by hand, **add** pressed |
| 3 | Lands | 0:47 | the body blooms onto the ring at its date; the ring lit |
| 4 | Below the dial | 0:57 | the page scrolls past the search to the manifest, and back |
| 5 | Time runs | 1:11 | the ring turns to a month out, the body warms, the reminder |
| 6 | Paper by post | 1:27 | the relay address, and the envelope that is never redirected |
| 7 | Inbox | 1:41 | the **inbox orb** pressed, the three lanes named, **add to orbit** |
| 8 | The belt | 2:04 | the belt opens, **Service history** brought to centre, `← →` stepped |
| 9 | Done | 2:33 | **complete** pressed; the body swings out to next year |
| 10 | Other households | 2:50 | Gran's Flat pressed, ask-to-join shown |
| 11 | Your sky | 3:03 | the account menu, the five swatches, **dawn** worn and returned |
| 12 | Yours | 3:22 | the year in one turn of the ring, and the closing line |

3:34 is over the 2:30–3:00 the brief expected. Nothing was shortened to hit a
number: the holds are round 3's (1000ms + 350ms a word, never under 2400ms),
and the round carries five more chapters and eleven more callouts than round 3
did — "a little more information along the way" costs time.

**The copy is the ratified copy.** `stops.js`'s chart, sun, dial, manifest,
inbox, relay and create lines, and round 1's own beat lines for time, done and
the close. Three lines are split across two callouts each (dial, create, the
close), which the round allows. Four short mono labels are the only text that
is neither: the three inbox lane names (**Filed**, **For your review**, **Still
reading** — the app's own headings), the theme roster (**star chart · after
dark · clouds · dawn · retrograde** — the pack names), **← → step through the
belt**, and *click one to bring it in*, which is the belt screen's own sentence.

## The transport

A 36px glass bar across the bottom of the stage, 16px in from each side and
16px up from the bottom, above the veil.

- **play/pause** (one button, ▶ / ❚❚ as inline SVG) and **stop** (■) at the
  left; then a 2px track with a 6px playhead, a 1px chapter tick at each
  chapter's start, the current chapter's name in 10.5px mono above the
  playhead, and `m:ss / m:ss` at the right end.
- Hovering a tick names that chapter in accent above it; clicking it jumps to
  that chapter's start. Space toggles play/pause, Esc stops. Focus order is
  play, stop, ticks.
- **Pause freezes the film where it is** — the callout stays, the lift stays,
  the veil stays, typing stops mid-word. Nothing on the page is interactive;
  watch-only is unchanged.
- **Stop** clears everything, leaves the sky as it is and fades the bar. The
  end does the same. A faded bar comes back on hover, so the film can be
  replayed from a tick.

Underneath: **one film clock**. A single `w(ms)` that only advances while
playing, a `tween` on the same clock for the scroll and the ring's turns, and
`pause()` on every animation in flight. The time bar reads the film's own
budget, not the wall clock, and every chapter's start and the total are
measured by a dry run at load — so a tick jump lands on exactly the reading
that chapter begins at, and pause holds the reading dead still.

**Reduced motion**: no travel, no typing animation, no tweens, no crossfade —
each state arrives complete. One change from round 3: reading time is not
motion, so callouts are held for exactly as long in either mode. Round 3
collapsed every hold to 1200ms, which left its own copy unreadable there. The
bar still runs and pause and stop still work; the film measures **2:03**.

## Backdrops

`shots/` at 1280×800, after dark, from the fixture app (`ORBIT_FIXTURES=1`
against the adapter-node build, driven with Playwright chromium — the same boot
`web/playwright.config.js` gives the fidelity gate). Four are round 1's,
carried forward unchanged; the rest were captured on **2026-09-19**:

| File | Origin | Route and state |
|------|--------|-----------------|
| `home-empty.png` | round 1 | `/home`, the sky with nothing on it |
| `create.png` | round 1 | `/home`, the drawer the north star opens |
| `inbox.png` | round 1 | `/inbox` |
| `relay.png` | round 1 | `/settings/mail` |
| `home.png` | **new** | `/home`, settled, re-captured so the scroll strip's top half matches it exactly |
| `home-scroll.png` | **new** | `/home` as one 1280×1689 strip: sky over manifest |
| `belt.png` | **new** | `/item/i-mot`, at rest |
| `belt-doc.png` | **new** | the same, Service history clicked — the document takes the centre card, the MOT takes the left ring |
| `belt-n1.png` | **new** | `→` once: Boiler service |
| `belt-n2.png` | **new** | `→` twice |
| `menu.png` | **new** | `/home`, account orb pressed |
| `home-dawn.png` | **new** | `/home` in the dawn pack |
| `menu-dawn.png` | **new** | `/home` in dawn with the menu open |

The belt set is captured in the design's own reduced-motion state, which is how
the fidelity gate photographs that screen too (#458): its ambient bed drifts on
a canvas clock, and four shots that have to crossfade into one another need the
same bed.

Three things the fixture could not give, drawn in the app's own chrome rather
than invented, the way round 3 drew the drawer's fields:

- **The drawer's name, date, cost, repeat and add.** `create.png` is the drawer
  the instant it opens; those five are blanked and drawn, exactly as round 3.
- **The scroll's two orbs.** A full-page capture re-lays the hero out and
  shrinks the dial, so `home-scroll.png` is stitched — the sky from a real
  viewport capture, the manifest from the full-page one, both taken with the
  page's `position:fixed` chrome hidden. The inbox and account orbs are drawn
  back over the moving strip, because on the real page they do not scroll.
- **Ask to join.** The fixture harness makes the reader a member of every
  household, so there is no ask-to-join state to photograph: clicking another
  sun flies the sky to it. The affordance is drawn as the create drawer's own
  accent-outline button, in place beside Gran's Flat.

Two things the shots say that the film does not draw round, as round 3 did not
draw round its own:

- The manifest in chapter 4 lists the fixture's MOT at **T−16d**, because the
  fixture household already holds one; the tour's own MOT is at T−381 until
  chapter 5 runs time forward.
- The `explore your world` search sits at y 744–776 on the real page, under the
  transport bar. Chapter 4 scrolls past it rather than lighting it.

## Self-review

Every chapter photographed plus paused mid-typing, paused with a callout, a
tick hover, the bar at 0:00 and at the end, and reduced motion — in
`shots/review/`, all taken through the design host. Collisions found and fixed:
six callouts that covered the thing they pointed at, the inbox orb's badge
falling outside its cut-out, a fill-forwards fade that left the drawn body
invisible for the rest of the film, the reviewer tag sitting under the bar (now
removed), and the transport reading as a grey slab on the dawn sky (it now
wears the pack).

The film runs headless end to end with **no console errors**, ends on
`3:34 / 3:34`, holds its reading dead still for three seconds when paused, and
lands on chapters 4, 8 and 11 from their ticks.

## Verdict

Owner, 2026-09-19, verbatim:

> "Your is very close now. Some things:
> Why is some of it in star chart theme not the default after dark?
> The play bar button is ENORMOUS. Far far too big. It should be a much
> smaller thing centralised at the bottom.
> The transition to the relay is not smooth.
> The belt tour doesn't show off the document preview nicely - no image loads
> and the image off to the side doesn't show?"

Round 4 is closed; the four fixes are round 5 (`../round-5/`).
