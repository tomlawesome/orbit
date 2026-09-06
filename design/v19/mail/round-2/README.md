# Invitation mail — visioning round 2

Tracking issue: #481. Round 1's **A the sun** survived with three asks from
the owner (2026-09-06): can the mail move; centre the action; give the button
more elegant words. B and C were killed.

## On animation in email

CSS `@keyframes` in a `<style>` block plays in Apple Mail (Mac and iPhone),
Samsung Mail, Thunderbird and Outlook for Mac. Gmail (web and apps) and
Outlook for Windows drop the block and show the first frame. So motion is a
progressive enhancement: the still frame is the design, the motion is a gift
to the clients that render it, and `prefers-reduced-motion` stops it. An
animated GIF would reach more clients but is an image, which the mail
deliberately does not carry. Both directions here take the CSS route.

## Constraints (unchanged from round 1)

Tables, inline styles, `width:100%; max-width:560px`, no SVG, no images, no
web fonts, no gradients, no absolute positioning. Same data story: Sam Okafor
invites priya@example.com to Harbour House, link good until 20 Sep 2026.

## Directions

| | Concept | Idea |
|---|---|---|
| D | **the sun, in motion** | Round 1's card, centred on its axis. The marker makes one slow lap of the ring and settles at its place; the sun breathes once; the words settle in after. Button: filled, serif, "Take your place". |
| E | **the arrival** | No card — the whole mail is the sky. Three rings widen out from the sun, the marker appears on the innermost, and the household name is the largest thing on the page. Button: outlined in the sun's colour, "Step into Harbour House". |

Files: `d-the-sun-in-motion.html`, `e-the-arrival.html`. Renders checked at
720 and 390 wide, and mid-animation at 1.5 s.

## Verdicts

_Awaiting the owner (posted on #481, 2026-09-06)._

## Verdicts

Owner, 2026-09-06, on #481:

- D the sun in motion — "No." As a whole; but "the style in [D] is fine
  tbh, though could be developed further to be more impressive." **Style
  survives into round 3.**
- E the arrival — "This is better but it's still a bit meh. and the bright
  yellow button thats just an outline sucks." And: "The animation is
  better in [E]. But again, it's just … lacking, it's not exciting,
  inspiring." **Motion survives into round 3; the outlined button is
  dead — filled from here on.**
