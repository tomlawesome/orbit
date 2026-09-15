# Hold-out 3 cost re-check under the whole-commitment rule (owner, 2026-09-13)

Re-check of every `costMinor` truth in `extraction-holdout3-fullpage.ts` against
the cost convention the owner set on 2026-09-13 (ADR-0026, "Amendment,
2026-09-13"): a fixed-term contract costs everything paid over its term, printed
where it is and duration x periodic price where it is not; an offered option is
not the commitment; rolling no-term contracts keep the periodic figure; annual
things keep the year's price. Only `costMinor` and its note were eligible to
change; dates, roles, provider, reference, subtype and recurrence were left as
they were. Author: the hold-out author only; the tuning session has not seen
this file.

Rule numbers below are the six in the brief: (1) printed whole-term total,
(2) unprinted product of periodic price and term, (3) offered option is not the
commitment, (4) rolling/no-term keeps the periodic figure, (5) finance = total
amount payable, (6) annual things unchanged.

| document | old | new | rule | reason |
|---|---|---|---|---|
| allotment-tenancy-agreement | 3800 | 3800 | 6 | yearly tenancy, annual rent £38.00 printed; water rate and key deposit are separate |
| appliance-rental-agreement | 650 | **50700** | 2 | 18-month minimum term at £6.50 a week; 78 Friday collections (18 Sep 2026 to 11 Mar 2028) x 6.50 = £507.00, never printed |
| appliance-repair-invoice | 13500 | 13500 | -- | one-off invoice; the printed total charged is already the whole cost |
| car-park-season-ticket | 78000 | 78000 | 6 | 12-month season ticket, annual price printed |
| charity-giving-confirmation | 1200 | 1200 | 4 | monthly Direct Debit, cancel at any time, no term |
| cycle-insurance-certificate | 6420 | 6420 | 6 | 12-month policy, annual premium paid in full; no monthly option offered |
| domestic-cleaning-contract | 2800 | 2800 | 4 | rolling contract, two weeks' notice; the six-month price fix is a review date, not a term |
| health-screening-clinic-invoice | 24900 | 24900 | -- | one-off invoice; the recommended next screening is not a commitment |
| music-tuition-invoice | 22500 | 22500 | 1 | the invoice total already covers the whole term of lessons |
| school-meals-account-statement | 740 | 740 | -- | account statement; the balance is the only cost-like figure and there is no term |
| social-club-subscription-renewal | 6500 | 6500 | 6 | 12-month membership, annual subscription printed |
| will-storage-receipt | 1500 | 1500 | 6 | annual storage fee, invoiced every 12 months, no fixed term |

## Judgement calls

1. **Appliance rental, weekly price over a monthly term.** Rule 2 is written
   for a monthly price; this page prints a weekly one and an 18-month minimum
   term. Two readings agree: 18 months is 78 weeks (52 x 1.5), and counting the
   actual Friday collections from the first (18 September 2026) to the term end
   (11 March 2028) also gives 78. So 78 x £6.50 = £507.00 with no rounding
   question. The delivery charge (£20.00) is a one-off fee and excluded, as the
   gym's joining fee and the broadband activation charge are. The agreement
   rolls weekly after the minimum term, as the gym rolls monthly after its
   12-month minimum; the tuning corpus prices the gym by its minimum term, so
   the same applies here.

2. **Domestic cleaning, six-month price fix.** The price is fixed for six months
   and reviewed on 7 March 2027, but the contract itself "continues on a
   rolling basis until ended by either party giving two weeks' written
   notice". A price fix is not a minimum term (no early-termination charge,
   nothing owed if cancelled), so rule 4 applies and the per-visit price stays.
   If the owner reads the six-month fix as a term, the alternative would be
   26 weekly visits x £28.00 = £728.00 (72800), before any Christmas surcharge.

3. **Charity regular gift.** Monthly with no term and cancellable at any time:
   rule 4, unchanged. It is not an "annual thing" (rule 6) even though it will
   run for years.

4. **Will storage and allotment.** Both recur yearly with no fixed multi-year
   term; the year's price is the commitment (rule 6), matching the season
   ticket and the club subscription.

## Tests

- There is no hold-out 3 equivalent of `four-field-contract.test.ts`'s
  `COST_BY_ARITHMETIC` table (that test walks `EXTRACTION_CORPUS` only, and the
  only hold-out test file is `extraction-holdout-2.test.ts`, which scores
  hold-out 2), so no test change was needed. If a hold-out 3 contract test is
  ever added, the appliance rental's cost is a product of a printed weekly price
  and a printed month count, and a `[minor, months]` table cannot express it:
  the table would need a `[minor, weeks]` form or a per-document total.
- `scripts/corpus/verify.mjs` still requires `costMinor` to be printed on the
  page, so it would flag this document, exactly as it flags the four
  tuning-set documents whose cost is now an unprinted product. That is a
  pre-existing gap in the verifier, not something to fix here.
- The generated module was edited by hand to match the source
  `.truth.json` (only the `costMinor` line and its note), since regenerating
  needs Playwright and Tika; `text` is untouched.

## Amendment, 2026-09-15: the appliance rental declares no cost

`verify.mjs` failed the appliance rental agreement on the 50700 this re-check
gave it: the whole-term total is never printed, and the only unprinted cost the
corpus allows is a fixed-term total left as price x months, declared as
`costArithmetic` so each printed price and month count can be checked. That
form cannot state this page. The price is weekly and the term is in months, so
there is no printed monthly price and no printed week count for the arithmetic
to stand on; `[650, 78]` would claim 78 months, which the page does not say.

Rule 2 applies to the commitment but the page does not support it in any form
the corpus can verify, and the page prints several rival amounts (weekly
rental, one-off delivery, unselected damage cover, early-termination charge).
Under the standing rule that a page with rival amounts and no supportable
commitment figure is left undeclared rather than guessed at, `costMinor` and
`currency` were removed and the note now says why. The weekly rental is not
restored: this is a fixed-term agreement, so the instalment was never the
commitment.

The note in the row above stands as the record of what was tried; the truth is
now no cost. Nothing else about the document changed -- same HTML, same text,
same dates, roles, provider, reference and subtype.
