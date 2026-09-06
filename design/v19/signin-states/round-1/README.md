# Sign-in door states — round 1 (#788)

Wording and placement for the three states where the v19 door cannot open,
per the owner's 2026-09-05 decision: all three live on the door, the button
is hidden while sign-in is unavailable, fixed Orbit-owned wording styled to
match the door. Artwork in every sheet is the shipped door verbatim
(`web/src/lib/flight/` — Dawn sky, first-light choreography, seeded
starfield); only the state layer differs.

Served at `http://<LAN address>:8312/v19/signin-states/round-1/<file>`.
Each sheet's demo bar (foot of page; sheet furniture, not design) switches
between: not configured · starting → recovers by itself (~6.5s) · could not
open · the shipped door.

## The one wording story (identical across directions)

| State | Primary | Subline |
|---|---|---|
| Not configured | Sign-in isn’t set up yet. | The administrator needs to configure authentication before the door can open. |
| Starting | Orbit is waking up. | Sign-in will appear by itself in a moment. |
| Could not open safely | Orbit couldn’t open safely. | It’s not you, it’s us. If it keeps happening, let us know at «public contact address». |

Fixed copy Orbit owns; provider-supplied text appears nowhere (the
zero-occurrence assertion survives). The guidance names the administrator's
action and never blames the visitor.

The table above is the copy the owner ratified on 2026-09-06, not the copy
this round proposed. The round wrote "whoever runs this Orbit" on the
reasoning that self-hosted, the reader often is that person; the owner
rejected it ("crap") in favour of naming the administrator plainly, and
replaced the third state's subline outright. That third line needs a
setting that does not exist yet — see the dependency below.

## Directions

**A — quiet words** (`a-quiet-words.html`). The words stand exactly where
the handle stood: primary line in the dusk farewell's voice inside the
ring, mono subline below the ring. Nothing added to the artwork. Waking:
the line breathes on the sun's period; ready: words exhale 0.7s, pill
returns with its ratified 10px rise at dusk-farewell tempo.

**B — on the horizon** (`b-on-the-horizon.html`). The ring is left as the
create path already shows it — word alone, no button — and the message is
written on the planet's edge in the flight's void-inscription voice
(letterspaced small caps, gold glow). Both lines sit in the inscription's
own shade — a soft pool of the void behind the words, as a cut inscription
holds its shadow — keeping them AA-legible over the bloom. The condition
belongs to the world, not to a missing control.
Waking: the inscription's glow pulses with the sun; ready: the words set
below the horizon and the pill rises in the ring.

**C — the held dawn** (`c-the-held-dawn.html`). The sky tells the state:
while the door cannot open, first light never fully breaks (dawn layer
held low, rays folded, sun dim — only opacities the lit sequence already
animates). Text set as in A so the comparison isolates the sky. Waking:
the pre-dawn swells and ebbs; ready: the full ratified first light plays —
recovery IS a sunrise, pill on its own 3.6s beat. Deliberately the
furthest-leaning direction; flagged in the sheet header as possibly
reading as "redesigning the door".

**D — the dormant handle** (`d-the-dormant-handle.html`). The pill never
leaves: its silhouette stays in place as a thin gold outline holding the
primary line in the pill's own type — the handle is dark, not removed.
Waking: a spark (the limb's shimmer) travels the outline; ready: the
vessel fills to gold, the words crossfade to "Sign in", and it becomes the
real pressable gate behind identical pixels.

## Gates

- Dataviz palette validator: N/A — no data palette on this surface; text
  inks are the door's own ratified tokens (#e9edf8/#cfd3e4/#8791b3 on
  #04060e all ≥6:1; gold #d8b45a on #04060e 10:1).
- Screenshots: every direction × every state (incl. mid-waking and
  post-recovery) × desktop 1440×900 and mobile 390×844 captured and
  reviewed; fixed before this commit: grain tile defaulting to 300×150,
  B's subline washing into the sun bloom (the first cut — halo shadows +
  brighter ink — still measured 3.3–3.9:1 at the bloom's peak; now a soft
  shade pool behind the inscription + #cfd3e4 ink, measured ≥7.4:1 in
  every B state at 1280×800 and 390×844), D's
  sweep drawing square corners half a pixel off the border, demo-bar
  overflow on mobile.
- `prefers-reduced-motion`: animations off, staging kept; starting still
  recovers by itself on a shorter timer.
- The live region (`role="status"` `aria-live="polite"`) announces state
  text and its clearing; the sign-in button is not rendered while
  unavailable (not merely hidden).

## Deliberately not done

- No "Try again" control (the old surface had one): the decision says the
  degraded state recovers by itself, and the other two states offer the
  visitor nothing a retry would fix. A quiet re-check could be automatic in
  the product; nothing on the page asks the reader to act.
- No distinct visual identity per state beyond wording (C's held sky
  applies equally to "not configured" and "could not open"): three moods on
  one door would read as an instrument, not artwork.
- No provider or error detail anywhere, per the security property.

## Verdicts (owner, 2026-09-06)

**C — the held dawn is ratified.** In the owner's own words: *"the choice
for 788 is the held dawn"*. The sheet's own flag — that holding the sky
might read as redesigning the door — is answered by the choice: it does
not. Recovery being a real sunrise is the direction, not a decoration on
it.

A, B and D are dropped. They are kept in this round as the browsable
record of what was considered; nothing is carried forward from them.

Wording, same message: *"'Whoever runs' is .. crap"*, so the second state's
subline names the administrator. The third state's subline is replaced
wholesale with the owner's own line, quoted in the table above, and with it
a new requirement: the address shown there is a **public contact address an
administrator sets**, never a private administrator mailbox scraped from an
account.

## Dependency this round created

The "could not open safely" line cannot ship until an instance carries a
public contact address as a setting (#860). Until then the first two states
are implementable and the third is not, because the alternative — showing a
real administrator's own email on a signed-out page — is exactly what the
owner ruled out.
