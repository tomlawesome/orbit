# Orbit document reader — try it on real documents

Reads every PDF, JPG or PNG in the `docs` folder the way Orbit does, and
lists what it read from each one so you can check the answers against the
paper. Nothing leaves your machine.

## What you need

One of these, for turning the file into text (Orbit uses Apache Tika for
that, and this runs the same version with the same settings):

1. **Docker Desktop** — the bundle starts the exact image Orbit runs. The
   first run downloads it (about 1 GB).
2. **Java 17 or later** — the bundle carries its own copy of the Tika server
   and runs it with Java. Free from <https://adoptium.net/> if you have none.

Node is included, so nothing else to install.

## How to run it

1. Unzip the bundle anywhere.
2. Copy your documents into the `docs` folder.
3. Double-click `run.cmd`.

It prints one block per document as it goes, then leaves:

- `out\results.txt` — the same blocks.
- `out\results.csv` — one row per document, with an empty "right?" column
  for ticking off in a spreadsheet.

Add `--keep-text` (run it from a command prompt: `run.cmd --keep-text`) to
also save the text Tika pulled out of each file in `out\text\`, which shows
what the reader was actually looking at.

## Reading the answers

- **provider, reference, subtype, cost** — blank means it found nothing it
  trusted; a blank is deliberately preferred to a guess.
- **cost** on a fixed-term contract is everything paid over the term
  (monthly price × months), as Orbit records it; a rolling monthly thing
  shows the monthly figure.
- **dates** — every date it took to be about the item, each with its role:
  `renewal` and `service` set a reminder, `expiry` marks when a one-off
  thing is over, `due` is a payment date, `issued` and `start` are facts.
- **schedule** — what Orbit would remind you about (`renewal` or `service`),
  taken from the dates.
- **recurrence** — how often it repeats, only when a schedule is found.
- **text characters: 0** — Tika got no text at all, usually a scanned image;
  Orbit does not read those either (no OCR).

## Privacy

`out` holds names, references and amounts from your documents. It stays on
this machine; do not copy it into the repository or an issue.

Tika 4.0.0 (Apache 2.0) and Node 22 (MIT) are redistributed with their
licences in `tika` and `node`.
