# Private local evaluation (issue #938)

This is a tool for the owner, run on the owner's own machine, against the
owner's own real paperwork. **Your documents never leave your computer.**
Nothing here sends them anywhere, pastes them into an assistant session, or
writes them into this repository. The harness reads a directory you choose,
prints a handful of numbers to your terminal, and writes nothing to disk
itself.

Every other extraction measurement in Orbit (`extraction-accuracy.test.ts`,
`extraction-holdout.test.ts`) runs against invented documents committed to
the repository, because that is the only thing safe to share and run in CI.
This tool exists because invented documents share blind spots with the code
that invents them — real paperwork is the only way to find out whether
extraction actually works on the letters and certificates that land on your
own doormat.

## The documents stay local

- You point the harness at a directory **outside this repository**. It
  refuses to run against any path inside the repo, including symlinks that
  resolve back into it — this is enforced in code
  (`src/server/documents/private-eval/run.ts`), not just an instruction to
  follow.
- The harness prints only counts and percentages: how many fields it got
  right, out of how many. It never prints document text, the value it
  matched or failed to match, or a file name from your directory.
- It writes nothing to disk anywhere — no report file, no log, nothing that
  could later be committed by mistake. Everything it produces goes to your
  terminal for you to read and then let scroll away.
- Nothing about your directory's location, contents, or the numbers it
  produces is sent anywhere. There is no network call in this tool.

If you want a permanent local record of a run, copy the printed numbers
somewhere of your own choosing outside the repository — the tool will not do
that for you, deliberately.

## Directory layout

Pick any directory outside your Orbit checkout, for example
`~/orbit-private-eval/`. For each document you want to score, create two
files sharing the same name (the "stem"):

```
~/orbit-private-eval/
  boiler-service-2025.txt
  boiler-service-2025.json
  car-insurance-renewal.txt
  car-insurance-renewal.json
  ...
```

- `<stem>.txt` — the text layer of the document: the words a computer would
  read off the page, as plain text. If Orbit's own document parser (Tika)
  already produced text you trust for this document, use that; otherwise
  type or copy the relevant text by hand. There is no requirement to
  reproduce the whole document — enough text for the fields below to be
  present is sufficient.
- `<stem>.json` — the ground truth: what a correct extraction should find in
  that text, written by hand.

Every `.txt` file needs a matching `.json` file and vice versa, or the
harness refuses to run and tells you how many files are unpaired (never
which ones — check your directory yourself).

The file names themselves are never read by the harness beyond pairing
`.txt` with `.json`; internally, and in every message it can print, each
document is addressed only as "document 1", "document 2", and so on. Even
so, prefer non-identifying stems (`document-01`, `renewal-3`) over ones that
name a person, an account, or a provider — belt and braces.

## Writing ground truth by hand

`<stem>.json` is a JSON object with up to three fields, matching what Orbit's
extractor is scored on everywhere else in the codebase:

```json
{
  "dates": ["2026-09-14"],
  "provider": "Shield Motor Insurance",
  "reference": "SM-2291-X"
}
```

- `dates` — every date a correct extraction should surface, as `YYYY-MM-DD`
  strings, in any order. If the document genuinely has no dates worth
  extracting, use `"dates": []` — the harness scores "correctly found
  nothing" as its own point, the same rule the committed corpora use.
- `provider` — the company or organisation the document is from, exactly as
  a correct extraction should render it. Omit the field entirely (not an
  empty string) if there is no provider to extract.
- `reference` — the policy, invoice, or certificate number, exactly as a
  correct extraction should render it. Omit the field entirely if there is
  none.

Write what a *correct* extraction should produce, not what today's extractor
actually produces — copying the extractor's current output would only prove
the tool agrees with itself.

## Running it

From the repository root, with dependencies installed:

```
node node_modules/tsx/dist/cli.mjs src/server/documents/private-eval/cli.ts ~/orbit-private-eval
```

Replace `~/orbit-private-eval` with your own directory. A successful run
prints something like:

```
Private evaluation: 12 document(s)
  dates    : 91.7% (33/36)
  provider : 100.0% (10/10)
  reference: 87.5% (7/8)
  overall  : 90.9% (50/55)
```

## What the output means

- **Per field** (`dates`, `provider`, `reference`): of every point available
  for that field across your whole directory, how many the extractor got
  right. A missing `provider` or `reference` line's percentage of `n/a`
  means no document in your directory declared ground truth for that field.
- **Overall**: the same earned/possible count summed across all three
  fields — one number for "how well does extraction do on my real
  paperwork", directly comparable in spirit (not in exact value — the
  documents differ) to the floor `extraction-accuracy.test.ts` holds against
  the synthetic corpus.
- There is no pass/fail threshold here, and none is enforced. This tool
  reports; it does not gate anything. If a number surprises you, that is a
  finding to act on (file an issue, add a synthetic fixture that reproduces
  the shape of the miss without your real data in it), not something the
  tool judges for you.

## What this is not

- **Not training or fine-tuning.** This only measures the existing
  extractor against your documents; nothing here changes how extraction
  works or learns from what you feed it. [ADR-0025](adr/0025-local-model-extraction.md)
  rules out training on personal data, and this tool does not reopen that.
- **Not a replacement for the committed hold-out corpus**
  (`extraction-holdout-corpus.ts`), which stays as the shared, synthetic
  measure CI can run. This tool is the opposite: private, local-only, never
  shared, and never run in CI (CI has no access to your paperwork, by
  design).
