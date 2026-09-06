# Invitation mail — visioning round 1

Tracking issue: #481 (invitations to join a household). The owner asked for
the mail to be "styled elegantly, beautifully — it's the very first part of
someone's orbit experience", and for a hosted mockup approved on the issue
before the template is built.

## Constraints every direction meets

- Table layout, every style inline, no `<style>` block a client can drop.
- No SVG, no remote images, no web fonts, no gradients, no absolute
  positioning: Gmail and Outlook strip all of them. The ring and sun are CSS
  circles; on a client without `border-radius` (old Outlook) they read as
  squares and the words still carry the whole message.
- One column, `width:100%; max-width:560px`, so it fits a phone without a
  media query.
- Preheader line, one action, the facts in mono, a plain footer with the
  raw link for clients that block the button.
- `text.txt` is the plain-text alternative sent alongside whichever HTML
  wins.

## Data story (shared)

Sam Okafor (owner of Harbour House) invites priya@example.com. The link is
good until 20 September 2026. Fictional; consistent across rounds.

## Directions

| | Concept | Idea |
|---|---|---|
| A | **the sun** | Dark card. The household drawn as it sits on the chart: one ring, one bright sun, a blue marker where Priya will be. Serif headline, filled pill button. |
| B | **the letter** | Light paper (dawn pack's warmth, not an inverted dark). A short letter from Sam in serif; the ring is a small seal; the button is an outlined line, not a pill. |
| C | **the chart** | A slice of the star chart itself: Harbour House as a labelled sun with two dim systems Priya does not belong to, mono chart labels, one line of prose. |

Files: `a-the-sun.html`, `b-the-letter.html`, `c-the-chart.html`,
`text.txt`. Renders checked at 720 and 390 wide.

## Verdicts

Owner, 2026-09-06, on #481:

- A the sun — "Not bad, but we can do much better I know it. Can html emails
  have animation? At the bare minimum the open invitation button needs
  centralisation, and the text on it changing to something much more
  elegant." **Survives; round 2 carries it forward.**
- B the letter — "No." Killed.
- C the chart — "No." Killed. Feature idea kept: the dim neighbouring
  systems as a way of saying "you are joining one of several".
