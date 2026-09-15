# #989 word-run bins: ranking a provider shortlist by how often a name is printed

Status: adopted for provider (owner, 2026-09-11). A working note under
ADR-0026: the method, the measurements that justified it, and where else it
may apply. ADR-0026 carries the amendment; this holds the detail.

## The method

Owner's design, 2026-09-11, tried in `tmp/provider-word-bins.ts` and built as
`src/server/documents/extraction-provider-runs.ts`.

1. **Stage 1** -- the loose sieve finds every organisation-shaped string on
   the page, one candidate per printing.
2. **Stage 2** -- keep only the candidates at least one provider sieve read
   as `provider`. This is a shrink, not a choice: several sieves, any one of
   them keeps a name.
3. **Split the words** in the kept names into two sets:
   - *describers* -- words that say what kind of thing it is: every word of
     every name and synonym in `subtype-taxonomy.json` (kinds and
     qualifiers), plus company-form words (ltd, limited, plc, llp, co,
     company, group, the, of, and, &, uk, for, a);
   - *name words* -- everything else.

   The describer list is generic on purpose. Nothing in it comes from any
   one document.
4. **Bin the runs.** For every kept candidate, take every run of consecutive
   words, case folded (`Kestrel Broadband`, `KESTREL BROADBAND` and
   `kestrel broadband` are one run). Keep a run only if it holds at least
   one name word. Count how many times each run appears across all kept
   candidates. Ties go to the longer run.
5. **Stage 3** -- the top few runs, each with its count, its most frequent
   printed spelling and the blocks it came from, are the shortlist. The
   model picks one, or none. A rule answers alone only where a single run
   stands above count one.

## Why it works

A household document prints the organisation it is from more often than any
other organisation on the page -- header, footer, sign-off, contact block,
small print -- and prints it the same way each time. Rivals (underwriter,
regulator, parent, ombudsman) appear once or twice. Counting repeated runs
of the *name* words measures exactly that, and ignoring describer words
stops "insurance" or "council" (which every organisation on the page shares)
from winning the bin.

It keys on repetition and on a generic word list, not on where anything
sits on a page or how any tuning document happens to be laid out. That is
why it generalised where the earlier provider rules did not.

## Measurements, 2026-09-11

Six tuning pages, four biggest bins:

| step | top bin is the provider's name |
|---|---|
| single-word bins over stage 1 | distinctive word in the top four on 6/6; the top bin a kind word (warranty, broadband, council) on 4/6 |
| single-word bins over stage 2 | same, provider word one place higher on 3/6 |
| word-run bins over stage 2, describers split out | **exact provider top on 5/6**, the short form ("Colworth & Drake") on the sixth |

Six-page checks are no longer evidence here (owner, 2026-09-12): a result on
six unseen pages is half the hold-out, where one document moves the number by
17 points. Results are measured on all twelve.

On all twelve unseen pages, measured 2026-09-12 (`npm run eval:provider-bins
-- --holdout`): the answer reaches the top two runs **4 of 12**, against 22 of
24 on the tuning pages, with 2.6 entries offered a page against 5.7. The
method does not carry over. For comparison, the provider rules built on the
24 scored -25% on the hold-out and the whole-page model blind scored 66.7%.

## Where else it may apply

- **Subtype** -- the describer bins are the leftover of the split: the most
  repeated describer words (dental plan, warranty, broadband) are a "what
  kind of thing" shortlist for free. Untried.
- **Reference** -- the household's number is often printed more than once
  as the same token; counting repeats may rank it above one-off company
  numbers. Untried.
- **Dates and cost** -- probably not: the answer is usually printed once,
  and repetition there is already one sieve among several.

## Traps

- The count is per candidate stage 1 found, not per page occurrence: a name
  printed inside running prose that the sieve did not cut as an
  organisation is not counted.
- Short forms and long forms are separate runs. Where the page prints
  "Colworth & Drake" more often than the full name, the short form wins the
  bin; the scorer accepts either with or without the legal suffix, but not a
  missing "Insurance Services". Which cut to answer with is the model's
  question, and what #993 (correction feedback) would learn per household.
