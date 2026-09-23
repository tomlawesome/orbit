# First-run tour — round 7 (#1097): the film for a screen reader

Round 5 is the ratified film and round 6 re-cut chapter 8. Neither says
what a reader who cannot see the screen gets. As built, they get nothing:
the layer holding every chapter's words is `aria-hidden`, nothing announces
that the screen has dimmed, and nothing says how to make it stop.

The owner ruled the approach on 2026-09-23 (#1097, "5b"): **the film is not
narrated. A screen reader gets the script instead**, to move through at
their own pace. This round draws that surface.

## The ruling in one line

The film stays a film. Beside it, for the whole time it is mounted, sits its
**script** — every line of every chapter, in order, as ordinary readable
text — and the film **announces itself once** when it starts, saying what
is happening, how to stop it, and that the script is there.

## The script

**What it is.** One region, `aria-label="Tour script"`, holding twelve
headings — one per chapter, numbered and named exactly as the transport's
ticks name them (`Chapter 3: Lands`) — each followed by that chapter's
lines as paragraphs. Nothing else: no timings, no stage directions, no
"the dot travels to". The lines are the words a sighted reader sees in the
callouts, and only those.

**Where it lives.** Inside the transport pill's root (`#orbit-tour-transport`),
after the controls, so it is one thing to a reader: the transport, then its
script. It is visually hidden (the usual clipped 1px box, never
`display:none`, never `aria-hidden`) so the film's picture is unchanged.
This round does **not** add a visible transcript panel; that is a separate
enhancement for sighted readers, not part of the ruling, and would need its
own drawing.

**How a reader reaches it.** Three ways, none of them a trap:

1. The announcement (below) tells them it exists.
2. Heading navigation: twelve `h3`s under one `h2` ("Tour script"), so a
   reader jumps chapter to chapter with the key they already use for that.
3. A **Script** button on the pill, after Stop, labelled `Script`, which
   moves focus to the script's heading. It is the keyboard route for a
   reader who is on the pill already. `aria-controls` names the region. It
   is drawn the way a skip link is: visually hidden until it has focus,
   then shown in the pill's own type beside Stop — so the picture of the
   pill, which the fidelity frames photograph, does not change for anyone
   who has not tabbed to it.

**How it stays in step with the film.** The script is not a second copy of
the copy. The player already plays every chapter once against a stopped
clock before the film starts (`player.js`, `measure()`; the vocabulary
stubs itself out in dry mode). In that pass the vocabulary records every
`callout` text it is handed, per chapter, and the player hands the
transcript back beside the offsets. The transport draws the script from
that. A chapter that changes a line changes the script in the same commit,
with no second file to forget; `tests/unit/v19-tour-script.test.mjs` pins
that the transcript of the real CHAPTERS registry is non-empty for every
chapter and that no line is a label-only beat (see below).

**What a line is.** A `callout(text, …)` with `label: false` (the default)
is a line. A `label: true` callout — the small uppercase tags the film
pins on lanes and papers ("later →", "service history") — is not a
sentence and is **not** in the script; it is the picture naming a part,
which the sentence beside it already says. Typed text (`typeInto`) and
ghost fields are stage action, not lines.

## The announcement

One live region, `role="status"` (polite), mounted **empty with the pill**
and filled a tick after the film starts — the same rule Dawn.svelte's
`.state` and Newcomer's `.note` follow (#788, §23): the element must exist
before the text changes for the change to be spoken.

The copy, verbatim:

> Orbit's tour is playing on screen: a short film over your own sky, with a
> transport at the bottom. Press Escape to stop it. The full script is in
> the tour transport, under "Tour script".

On stop or finish the same region says:

> Tour stopped. Your sky is back.

or

> Tour finished. Your sky is back.

The film's clock-driven words are never sent to this region. That is the
ruling: nothing is read at the reader on a timer.

**Focus does not move.** The reader arrived on `/home`; the film is over
it, not instead of it. Moving focus into the pill would be the walk's
trap by another name. The announcement names the routes in; the reader
takes one or ignores the film. (Round 5's Escape and the pill's Stop
already work from anywhere.)

## The callout layer stays out of the tree

`vocabulary.js` marks the film's chrome layer — rings, dot, callouts,
ghost fields — `aria-hidden="true"`. #1097 called that the defect. With the
script in place it is the right call, for the reason captions are: the
layer is a picture that changes on a clock, and its words exist verbatim
in the script, at the reader's pace. Left in the tree, a virtual cursor
would find a callout that vanishes mid-sentence and no way to get it back.
The attribute stays; the comment beside it now says why, and points here.

## What the build does

- `vocabulary.js`: in dry mode, `callout` pushes `text` onto a transcript
  when `o.label` is not set; `createFilmContext` exposes
  `transcript()` / `resetTranscript()`. Nothing drawn, nothing timed.
- `player.js`: `measure()` resets the transcript before each chapter and
  collects it after, returning `{ offsets, total, script }` where `script`
  is `string[][]`, one array per chapter. `script()` getter beside
  `offsets()`.
- `transport.js`: after the controls, the Script button and the
  visually-hidden script region drawn from `player.script()`; the status
  region, empty at mount; `refresh()` fills the script once measured;
  the start announcement on the first `onChapter`, the end announcement on
  `onEnd(true)`.
- `film.js`: `window.__script` beside the other review hooks, so the e2e
  and the design host can read it.
- Tests: `tests/unit/v19-tour-script.test.mjs` (transcript per chapter,
  labels excluded, headings match tick labels); `tests/e2e/v19-screen-reader.spec.ts`
  regains a tour assertion: the script region exists with twelve headings
  and the status region carries the start copy.

## What it does not do

No narration on the clock. No focus move. No modal, no trap. No visible
transcript panel. No change to the film's picture or timing: the fidelity
frames `tour-dark` / `tour-light` must measure 0 pixels moved.
