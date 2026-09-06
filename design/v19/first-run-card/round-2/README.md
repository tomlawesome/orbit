# #862 — reworking the first-run card · round 2

## Round 1's verdict, and what it got wrong

> "No, these are all very poor for 862. Generic boxes with clumsy wording that
> doesn't tie into the login screen in any way." — owner, 2026-09-06

Fair, and the diagnosis is exact. Round 1 changed the card's **ground** — the
panel, the blur, the veil — and left its **form** and its **words** alone. It
was still a left-aligned stack of labelled boxes speaking utility English, in
an idiom belonging to no other screen in Orbit. Fixing the wash-out is not the
same as reworking the card, and the issue asked for the rework.

## Where the tie has to come from

The first-run card stands in exactly one place: over the dawn, on the login
screen's own frame. And by standing ruling it cannot borrow the mark —

> "no orbit word, no orbit logo, this little window pops up, the user fills it
> in, the orbit logo and text reappear and we run the login intro" — owner,
> quoted in the sheet

— so the ring and the word are *gone* while the card shows, not receded. The
tie therefore has to be made from everything else the login screen is, which
is a very short list:

- centred in the viewport, nothing off to a side;
- **one** line of display type at 72px;
- **one** small pill 74px beneath it — 12px display, dark ink on gold, 99px
  radius — and no other control anywhere;
- no labels, no boxes, no footer, no explanation.

So: **the name the reader types stands exactly where `orbit` stands, at its
size; and the act beneath it is that same pill, in the same place, holding one
short word.** The window pops up in the word's own slot. That is the tie, and
it is a composition rather than a decoration.

Every direction here drops the panel entirely, so there is no per-pack opacity
left to be wrong and no exception list left to forget clouds in. The pill keeps
the ratified gold on every pack, because §15 requires the two surfaces to carry
the identical control and the login's pill never varied either.

The name steps down as it grows — 72px, 52px, 38px — so a sixty-character name
still sits on one line. That is the display word behaving like a field, rather
than a field borrowing a font.

## The wording

Round 1 kept "what is it", "time zone", "currency", "4 sections to start ·
change them later", "create this system". All of it goes.

- No label above the name. The placeholder is **`name it`**.
- The act is **`Create`** — one word, like `Sign in`, and it no longer grows to
  "create Lawson Home →", because the login's pill is fixed and §15 wants the
  two identical.
- What used to be three labelled controls becomes one quiet line in the
  sheet's own caption register, stating what was assumed rather than asking.

## The three positions

### G · the word — `g-the-word.html`

The login screen's spacing exactly: name, pill, and one quiet line beneath —
`Europe/London · GBP · four sections to start`, with the first two changeable
in place. Nothing sits under the pill on the login screen, so this is the only
addition, and it is a caption.

### H · the ledger — `h-the-ledger.html`

The same composition, with what was assumed stated **before** the act: three
engraved readings — time, money, sections — separated by hairlines, the values
the only bright thing in the line. The eye reads name, then readings, then act.

### I · one question — `i-one-question.html`

The login screen asks exactly one thing, so this asks exactly one thing. Time
and money are read off the browser and simply stated in a sentence under the
act, with no control here at all: both are right nearly always and both move
to settings. The fewest possible elements — the login screen's argument rather
than its decoration.

## Checked

Rendered and inspected at 1600×1000 on after dark, dawn and clouds, with a
short name and a sixty-character one. The dawn, the stars, the reclaim and both
hand-over beats are the sheet's own, carried forward untouched; `build.py`
performs the edits and is the record of exactly what changed.

## Verdicts

Awaiting round 2.
