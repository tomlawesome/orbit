# #862 — reworking the first-run card · round 3

Rounds 1 and 2 are both dead. This round is not a set of options: the owner
gave a design, and this is that design drawn.

> Make the Orbit logo circle on the login screen much bigger, same line
> weight, same size of rotating orb. the inside of the ring is a glassed
> background over the night's sky, with the fields inside it.
>
> The name box has the suggestion 'Your world' and it's clear what each box is
> for. The create button is the same style as the login button, the same size,
> everything. Except it says create. On clicking create, the circle animates
> inward, get increasingly smaller as it transitions into the normal login
> 'launch'. — owner, 2026-09-06

`ring.html`.

## The geometry, measured rather than guessed

The ratified login glyph is an SVG 420px wide on a 200 viewBox, so it draws at
2.1×:

| | login ring | this ring |
|---|---|---|
| circle | 302.4px | **500px** |
| line weight | 4.2px | 4.2px |
| orb | 29.4px across | 29.4px across |
| orb station | 151.2px out, −30.1° | same angle, on the ring |

500px is 1.65× the login's and the largest circle that still leaves the fields
a comfortable rectangle inside it.

Holding the line weight and the orb still while the diameter moves is why the
ring is drawn in **CSS rather than as a scaled SVG**: a border measured in
pixels does not thin when its element shrinks, and the orb is its own element
stationed by percentage, so it keeps its place on the ring at any size.
Scaling the SVG would have thinned both, which the owner ruled out in the same
breath as asking for the bigger ring.

## The glass

The night sky itself, held still and quieted, inside the ring and nowhere
else. It is a *darkening*, not a paint — so a light pack cannot wash it out,
and the per-pack opacity exception that opened this issue cannot recur here.

## The hand-over

On create the circle animates inward to exactly 302.4px, in the login ring's
place, and the glass clears as it closes. The two rings are the same circle at
the end of that move, so the changeover is invisible only if it happens *then*:
the big ring holds full strength while it travels and clears in 0.16s once it
has arrived, and the ratified login chrome is held back to meet it there rather
than appearing at full size beside a ring still moving. Both land before the
ascent starts at 620ms, so the launch runs unchanged.

## The words

The name's suggestion is **`Your world`**. Every field keeps a visible label —
`name`, `time zone`, `currency` — because the owner asked that it be clear what
each box is for; "what is it" was the unclear one and it is gone. The act is
the ratified gate rule verbatim, at its own size, saying **`Create`**, and it
no longer grows to "create Lawson Home →": §15 requires the two surfaces to
carry the identical control.

## Checked

Rendered at 1600×1000 on after dark, dawn and clouds, and mid-hand-over. The
dawn, the stars, the reclaim and the ascent are the sheet's own, untouched;
`build.py` is the record of exactly what changed.

## Verdicts

Awaiting round 3.
