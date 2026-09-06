# Invitation mail — visioning round 3

Tracking issue: #481. Round 2's verdict split the two directions: D's style
(the card, the wordmark, the white serif headline, a filled button) is the
one to keep and develop; E's motion (rings widening from the sun, the marker
arriving, the words settling) is the better motion but "not exciting,
inspiring". The outlined button is dead.

## What changed this round

- The mail tells a story instead of decorating a card: the sky is already
  alive (stars twinkling on their own clocks), the sun ignites from an ember
  and its warmth blooms outward, three rings widen from it, then the reader
  arrives as a comet with a short tail that settles on the innermost ring.
  Only then do the words come — the headline draws in with its letter-spacing
  closing, the rest settles, and the button rises and blooms once.
- The still (Gmail, Outlook for Windows) is the finished frame and stands on
  its own.
- Constraints as before: tables, inline styles, no SVG/images/web fonts/
  gradients/absolute positioning. The glow and the comet tail are stacked
  circles placed with margins and padding (no `position`). Nothing animates
  opacity on an element whose child must stay bright.

## Directions

| | Concept | Idea |
|---|---|---|
| F | **ignition** | The six-second story above, played once; D's card exactly. |
| G | **the living system** | F, but the system never stops: the marker keeps orbiting (one lap per forty seconds), the sun breathes, the stars twinkle. Style pushed a step: the household name on its own line at display size, a gold hairline along the card's top edge. |

Files: `f-ignition.html`, `g-the-living-system.html`. Renders at 720 and 390
wide plus frames at 1.2 s, 3.2 s and 4.6 s.

Data story unchanged: Sam Okafor invites priya@example.com to Harbour House;
the link is good until 20 September 2026.

## Verdicts

Owner, 2026-09-06, on #481:

- F ignition — "I like this!"
- G the living system — "even better!! This is the one." **Ratified: the
  template in `src/server/invitations/mail.ts` is built from
  `g-the-living-system.html`.**
- On the gold hairline along the card's top: "Why are they randomly yellow
  at the top on phones?" — it is deliberate (the sun's colour on the card
  edge, on desk too); kept or dropped on the owner's word.
