# The portable archive — round 2 (#1002): documents in

Round 1's card, unchanged in shape, with the documents in the file — both
ways, always, no switch. Answers the round-1 verdict (owner, 2026-09-20):
"What's the point in exporting if there's no documents?" / "The UI itself
is fine otherwise".

Served at
`http://<LAN address>:8336/1002-portable-archive/design/v19/portable-archive/round-2/b-documents-in.html`.
Scenes as round 1 plus `outbig`: `?scene=rest|out|written|outbig|in|inside|armed|brought|wrong|big|notours|member`.

## What changed

- **Export sentence** names the documents and their size: "… and its **4
  documents (38 MB)**. Not the people." The said line reports the file at
  38 MB and "documents included" on the record.
- **Over the cap** (`?scene=outbig`): a household whose documents come to
  more than one archive holds (128 MB, `portable-archive-repository.ts`)
  sees no button at all — the sentence says "31 documents (212 MB)" and the
  refusal beneath it: *212 MB of documents is more than one archive holds ·
  the limit is 128 MB · nothing can be written until it is under*. Nobody
  types a password to learn that.
- **Import sentence**: "It brings entries and their documents, never people".
- **Inside**: "Seaside Cottage · 14 entries · 3 sections · 9 documents
  (61 MB)" / "documents come back through the scanner, like an upload".
- **Brought in**: "11 entries, 3 sections and 7 documents from Seaside
  Cottage · 3 entries left out because they were already here, their 2
  documents with them · the documents show as they clear the scanner".

Everything else — the password again, the passphrase twice and its
warning, the clashes that stay out, asking twice, the three import
refusals, the non-owner seeing nothing — is round 1 verbatim.

## Measured (`.capture/shoot.mjs`)

Owner's 1093×614: at rest 1012×199; export open 1012×543; over the cap
1012×218; inside 1012×567; halves side by side at 468px each. Phone
390×844: stacked, danger line below. No new overflow. Five packs captured.

## What this costs to build (beyond round 1's notes)

- **Import must restore document bytes.** Today the import route drops
  them (`portable-archive-repository.ts`, `documentsExcluded`). Restored
  documents go in through the same path as an upload — scan, encrypt,
  store — so they carry the existing "still scanning" state and appear as
  they clear. Skip a document whose `contentSha256` is already held.
- **Export always sends `includeDocuments: true`** and the route stops
  offering the option to owners' clients; the 128 MB cap is checked and
  said before the fields open (the household's document total is known to
  the loader).
- Bounds (requirement 5) now matter more: the 128 MB file is decrypted and
  parsed in memory today; the build should stream or chunk the document
  bytes rather than base64 the lot in one JSON body.

## Verdict

Owner, 2026-09-20, verbatim: "I'd rather it read more as a list." then
"64a yeah documents always in because there's zero point in an export
without them, as there's nothing to then import." Documents always in is
ratified; the counts become a manifest list in `../round-3/`.
