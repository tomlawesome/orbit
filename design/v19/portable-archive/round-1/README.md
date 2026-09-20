# The portable archive — round 1 (#1002 export, import and preview)

One direction, A: **the archive card**. `household-manage.html` ("your
system") verbatim, plus one owner-only card across both columns between the
ordinary cards and the danger line. Two halves: *Take it with you* (export)
on the left, *Bring one in* (import) on the right. Each is a sentence and a
quiet button at rest; the fields open only for the person who steps toward
the act, the way the danger line already behaves on this page.

Served at
`http://<LAN address>:8336/1002-portable-archive/design/v19/portable-archive/round-1/a-the-archive-card.html`.
Scenes: `?scene=rest|out|written|in|inside|armed|brought|wrong|big|notours|member`
(also the ARCHIVE dropdown on the demo rail); packs via the rail's swatches.

## What it reads

Facts from the code, not invented: an export holds the household's entries,
sections, due dates, reminder rules and the *list* of its documents
(`src/server/portable-archive-repository.ts:103-129`); document contents are
optional there and **excluded here with no switch** (issue #1002,
requirement 10). Passphrase 12–256 characters (`portable-archive.ts:18`);
the written file lives 24 hours (`portable-archive-repository.ts:16`).
The preview returns the source household's name, counts, and the entries
that clash by reference or by name (`:334-341`); the import route can only
**skip** a clashing entry — any clash not skipped is refused (`:364`) — so
the card names the clashes and says they stay out, rather than drawing a
choice the server does not offer. An archive holds no people, so nothing in
it can grant access (requirement 3); the card says so before a file is
chosen.

## What it shows

**Take it with you.** "One file holds Lawson Home — 6 entries, 3 sections,
their dates and reminders, and the list of 4 documents. Not the documents
themselves, and not the people." → `write an archive →` opens: *your
password again · nothing leaves without it* (requirement 2, re-authenticate
at the point of export); *a passphrase for the file · 12 characters or
more* with a live meter ("7 of 12" → "12 or more · both match"); *the
passphrase again*; then in warm, on the surface (requirement 9): **Orbit
never keeps this passphrase.** Lose it and the file can never be opened —
not by you, not by anyone, and Orbit holds nothing that changes that.
`write the archive` wakes only when the password is typed and both
passphrases match at 12+. Afterwards the said line: *written ·
orbit-export-lawson-home.json · 212 KB · here for **24 hours**, then gone ·
on the household's record: you, today, documents not included* and a
`download the file` button.

**Bring one in.** "An archive from another Orbit — or an older one of this
— merges into Lawson Home. It brings entries, never people: nothing in a
file can give anyone access here." → `bring in an archive →` opens: *the
file* (`choose a file`, the chosen name printed beside it), *its
passphrase*, `look inside` (the preview route; requirement 7 — same checks
as the import). Inside: *Seaside Cottage · 14 entries · 3 sections · 9
documents listed* / *written 3 March 2026 · the documents' contents did not
travel, only their names*, then the clashing entries each marked *already
here · stays out*. `bring in 11 entries` asks twice ("tap again to bring in
11 entries", with the moment line *this can't be undone as one act — each
entry would have to go separately*). Said line: *brought in · 11 entries
and 3 sections from Seaside Cottage · 3 left out because they were already
here · documents are listed, not restored*.

**Refusals**, in the preview's place, in `--overdue`: *that passphrase
doesn't open this file · nothing was read*; *this file is larger than Orbit
will open · the limit is 128 MB · nothing was read* (requirement 5, bounded
before parsing); *this isn't an Orbit archive · nothing was read*.

**Non-owner:** the card is absent, not greyed (`own-only`, as sections and
the danger line are). Requirement 1 is enforced by the route as well.

## Measured (`.capture/shoot.mjs`)

| screen | at rest | export open | inside | halves |
|---|---|---|---|---|
| 1093×614 (owner) | 1012×199 | 1012×543 | 1012×567 | side by side, 468 each |
| 1600×1000 | 1012×199 | 1012×543 | 1012×567 | side by side |
| 390×844 (phone) | 388×370 | 388×728 | 388×779 | stacked, rule between |

The danger line sits below the card on every screen. Page overflow on the
phone (412 vs 390) is the base file's backdrop SVG, unchanged. Captured in
starchart, afterdark, atlas, dawn and retrograde; nothing hand-coloured —
the warning is `--warm`, refusals `--overdue`, the meter's "both match"
`--ok-text`.

## Build notes (for the issue once ratified)

- The routes change, not just the surface: export owner-only; the export
  route takes the password and checks it (and the second factor once #1033
  lands); preview and import owner-only with the same bounds.
- The client sends every clash id as `conflictItemIds`; there is no other
  path through the import route.
- The file input's name and size are known before upload, so the 128 MB
  refusal can be said before any bytes leave the browser, and again by the
  route.

## Verdict

Owner, 2026-09-20, verbatim: "63. What's the point in exporting if there's
no documents?" then "The UI itself is fine otherwise". The card stands; the
documents go in, both ways, always — `../round-2/`.
