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
  for ticking off in a spreadsheet, and a "top three" column per field.
- `out\truth.csv` — the same answers again, for correcting by hand so the
  reader can be scored against them, and `out\truth-help.txt` explaining
  the columns. See "Telling it the right answers" below.

Under each document's answers come the **top three** for provider,
reference, subtype, cost and dates: the answer it chose first, marked `*`,
then the next two it would have offered. This is the list the review
screen will show, with the first pre-selected. When you check a document,
count it as *first* (the `*` is right), *in three* (right one is 2 or 3),
*wrong* (not in the three) or *blank*.

Add `--keep-text` (run it from a PowerShell or command prompt in the unzipped folder: `.\run.cmd --keep-text`) to
also save the text Tika pulled out of each file in `out\text\`, which shows
what the reader was actually looking at.

Add `--candidates` (`.\run.cmd --candidates`) to lengthen each list to the
whole shortlist it weighed (up to eight), with the reasons beside each. Use
it to see why a field came out blank or wrong -- whether the right value was
never on the shortlist, or was on it and passed over.

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

## Telling it the right answers, and getting a score

The reader cannot mark its own homework, so the first run also writes
`out\truth.csv`: one row per document, pre-filled with the answers it just
gave, plus `out\truth-help.txt` saying what each column is for.

1. Open `out\truth.csv` in Excel.
2. Correct the cells that are wrong. Blank the ones the page does not
   answer -- a blank means "there is no right answer here", and those are
   passed over rather than counted against the reader.
3. Save it, then run `.\run.cmd --score` (from a PowerShell or command
   prompt in the unzipped folder).

Nothing ever writes over `truth.csv` once it exists: those are your answers,
and every later run leaves them alone. Delete the file if you want a fresh
pre-filled one.

`--score` reads it back, reads the same documents again, and prints:

    real 23: sieve+tag+choose: 74.1% (152/205) [provider 78.3% (18/23), ...]

Twenty-three documents; of the 205 answers the truth file asks for, 152 were
right; then the same per field. It is the same measurement, by the same code,
that the project's own test documents get -- so this number can be put beside
theirs and mean the same thing.

Under it comes a table: per field, how often the right answer was the one
offered first, in the first two, in the first three, or anywhere on the list
the reader weighed. The review screen offers three, so "top-3" is how often
you would find the right answer without typing it in yourself.

Then every miss, naming the document and the field.

The same lines go to `out\score.txt`. The score line and the table say
nothing about your documents except how many there are, so they are safe to
send us; the misses under them quote your own paperwork, so send the top of
the file rather than the whole of it.

## Privacy

`out` holds names, references and amounts from your documents -- in
`results.txt`, `results.csv`, `truth.csv` and the misses in `score.txt`. It
stays on this machine; do not copy it into the repository or an issue.

Tika 4.0.0 (Apache 2.0) and Node 22 (MIT) are redistributed with their
licences in `tika` and `node`.
