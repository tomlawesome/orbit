# What the belt is for — round 1 (#1304, the wider question)

The owner, 2026-10-08: the belt as the item screen repeats home's drawer,
so it is either a papers-only belt with management moved into home's
drawer, or no belt at all. Both are mocked up here, for v0.3. The owner
also asked that search becomes one piece of code shown the same way on
home and on the belt: today home's "explore your world" and the belt's
"find an item" are two features and about twice the code.

Three files, one data story (the household of `../../home.html` and
`../../document-card/round-6/h-preview-and-reader.html`: the Volvo MOT,
the boiler service, the insurances). Each carries the same search box,
markup and behaviour identical, so the owner sees it in both places.

- `a-papers-belt.html` — direction A, the belt: papers only. Every
  document in the household rides the band, scattered, in date order of
  the item it belongs to. A paper at rest is a small page on the cream
  sheet with its name and its item under it; a seated paper is round 6's
  preview card at the apex (the page, `1 of 3`, arrows only where there
  is a page), and pressing the page opens round 6's reader unchanged.
  No item card, no edit, snooze, complete, attach or retire on the belt.
  Under the seated paper: `open the item →` (to home's drawer). The
  search box is the shared one; a paper hit seats it, an item hit goes
  to home's drawer for that item.
- `b-home-drawer-edit.html` — home's corridor row expanded, in both
  directions: the drawer holds everything the belt's card holds today.
  `edit` turns the fields into inputs in place (title, section, type,
  due, orbital period, cost, provider, reference, reminders, notes) with
  `save` / `cancel`; action pills `snooze`, `complete`, `attach a
  document`, `retire` as the belt's card has them. Document rows are
  links: `open on the belt →`, which flies to that paper seated (A).
  `manage this item →` is gone.
- `c-home-no-belt.html` — direction C, the belt canned: B's drawer, but
  a readable document row opens round 6's preview card over home, and
  the page opens the reader over home. Scanning, removed and refused
  rows stay text with their state word. The menu has no belt entry.

Scenes: `?scene=` per file, listed at the top of each. Desk and phone
widths both proved; packs by `?theme=`.

## Notes from the build

- A: the five new papers have no real page renders, so their pages are
  drawn in the browser in the existing style. ← → walk paper to paper, so
  the seated card's own pages turn by PageUp/PageDown (inside the reader
  ← → still turn pages). On a phone the seated paper stays at the apex,
  with neighbours peeking in at the edges, since there is no item card
  for the ratified bottom sheet to sit beside. A caption the screen edge
  or the card would cut is hidden. The search dropdown opens only once
  there is text in the box (one line of home's script; markup and CSS
  are home's). Extra scenes: `focusing`, `undrawable`, `zoom`.

- B and C: home's menu never had a belt entry (Inbox, Settings,
  Administration), so C removes nothing there. The `attach a document`
  pill has no belt twin; it uses the pill style in the upcoming colour.
  The MOT item was given a provider, a reference, notes and a third,
  still-scanning paper so every field shows. C's preview card sits
  centred over the drawer, nothing dimmed beneath: there is no room
  beside the drawer, and the dim stays the create drawer's.
- The page cannot be forced narrow: `?scene=phone` is the `open` (B) or
  `preview` (C) scene at a 390px viewport.

## Verdicts

(none yet)
