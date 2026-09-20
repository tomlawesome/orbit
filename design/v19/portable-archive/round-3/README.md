# The portable archive — round 3 (#1002): as a list

Round 2 with the owner's two rulings applied (2026-09-20): documents are
always in the file ("64a … zero point in an export without them, as there's
nothing to then import"), and what a file holds "read[s] more as a list".
Nothing else moved.

Served at
`http://<LAN address>:8336/1002-portable-archive/design/v19/portable-archive/round-3/c-as-a-list.html`.
Scenes: `?scene=rest|out|written|outbig|in|inside|armed|brought|wrong|big|notours|member`.

## The manifest

Wherever the card said what a file holds, it now lists it — a figure, a
name, and a small note at the row's end — one grammar (`.man`) in four
places:

- **Take it with you**, at rest: "One file holds Lawson Home, sealed with a
  passphrase you choose:" then `6 entries · 9 dates (and the 6 reminders
  set on them) · 3 sections · 4 documents 38 MB · 0 people — never in the
  file`. Over the cap (`?scene=outbig`) the documents row reads `31 · 212
  MB` in warm, the button is absent and the refusal sits under the list.
- **What's inside** an import: a head row `Seaside Cottage · written 3
  March 2026`, then `14 entries — 3 already here · they stay out` (warm),
  `3 sections`, `9 documents — 61 MB · back through the scanner, like an
  upload`, `0 people`; the three clashing entries are indented under it.
- **Written**: `written · orbit-export-lawson-home.json · 38 MB`, then `24
  hours here, then gone` and `1 line on the household's record — you ·
  today · documents included`, and the download button.
- **Brought in from Seaside Cottage**: `11 entries — 3 left out · already
  here`, `3 sections`, `7 documents — 2 left out with their entries · the
  rest show as they clear the scanner`.

Fixed before this commit: the said blocks were `<p>` elements holding a
list, which the parser splits, so the written and brought-in lists showed
at rest. They are `<div class="said">` now.

## Measured (`.capture/shoot.mjs`)

Owner's 1093×614: at rest 1012×315 (was 199 — the list costs 116px);
written 1012×447; inside 1012×658; brought 1012×325. Halves side by side
at 468px each; the phone stacks them (388 wide, rule between); the danger
line is below on every screen; no new overflow. Five packs captured — the
figures are `--ink`, the notes `--ink-faint`, the clash note `--warm`.

## Build notes

Round 1's and round 2's stand. The manifest's figures come from what the
loader already knows (entry, event, rule, section and document counts and
the documents' byte total) for export, and from the preview response for
import; the preview needs to return the source household's export date and
the documents' byte total, which it does not today.

## Verdict

Owner, 2026-09-20, verbatim: "I don't hate it but this could be two tabs on
the same card". Drawn as tabs in `../round-4/`.
