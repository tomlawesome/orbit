# The portable archive — round 4 (#1002): two tabs

Round 3's card with the two halves as tabs in the card head — *take it
with you* · *bring one in* — one panel showing at a time. Answers the
round-3 verdict (owner, 2026-09-20): "I don't hate it but this could be two
tabs on the same card". Every line of copy, the manifest, the fields, the
refusals and the two-tap are round 3 verbatim.

Served at
`http://<LAN address>:8336/1002-portable-archive/design/v19/portable-archive/round-4/d-two-tabs.html`.
Scenes: `?scene=rest|restin|out|written|outbig|in|inside|armed|brought|wrong|big|notours|member`
(`restin` is the second tab at rest; import scenes select it themselves).

## The tabs — v19's first

No v19 surface had tabs before this. The grammar, so the next one copies it:

- They live in the card head, after the card's heading, in the heading's
  own mono uppercase; the chosen tab is `--ink` with a 2px `--accent` rule
  under it, the other `--ink-faint`. No pill, no box.
- `role="tablist"` labelled by the card heading; each tab `role="tab"`,
  `aria-selected`, `aria-controls`; the panel `role="tabpanel"` labelled by
  its tab. One tab in the Tab order; ← → move between them and focus
  follows; the panel that is not chosen is `hidden`.
- Opening an act on a panel selects its tab, so a deep link or a scene
  never shows a field on a hidden panel.
- Under 560px the head wraps: heading on one line, the two tabs on the
  next, the small count dropped.

## Measured (`.capture/shoot.mjs`)

Owner's 1093×614: at rest 1012×301 (take it with you) / 1012×185 (bring
one in); export open 1012×645; inside 1012×644; brought 1012×297. Content
sits left in a 600px column, the danger line's own manner on this page.
Phone 390: 388×346 / 388×230 at rest; danger line below; no new overflow.

## Verdict

Owner, 2026-09-20, verbatim: "I like it, just need a small tweak. This
makes it look like it's three tabs but the archive is just a heading."
Answered in `../round-5/`.
