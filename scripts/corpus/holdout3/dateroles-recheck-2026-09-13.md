# Hold-out 3 date-role re-check under the kind-of-thing rule (owner, 2026-09-13)

Re-check of every `dateRoles` and `scheduleKind` truth in
`extraction-holdout3-fullpage.ts` against the date-role conventions the owner
set on 2026-09-13. Only roles, `scheduleKind` and the `recurrenceMonths` that
depends on a schedule were eligible to change; dates, provider, reference,
`costMinor` and subtype were left as they were. Author: the hold-out author
only; the tuning session has not seen this file.

Rule numbers below are the four in the brief: (1) an end-of-term date is
`renewal` when the thing continues only if the household acts again and
`expiry` when the thing is simply over when it is over, decided by the kind of
thing and never by the word printed on the page; (2) `service` is the NEXT
visit the household must act on, while the day work was already done is the
record's own `issued` date; (3) a finance agreement's final-payment / end date
is `expiry`, not `due`; (4) `scheduleKind` is derived -- `renewal` if any role
is renewal, else `service` if any role is service, else absent -- and a
`recurrenceMonths` cannot outlive its schedule.

| document | date | old | new | rule | reason |
|---|---|---|---|---|---|
| allotment-tenancy-agreement | rent due | due | due | 1 | first rent under a brand-new tenancy, payable before the term starts; a payment that gets the household in, not a repeat that keeps it in |
| appliance-rental-agreement | minimum-term end | renewal | **expiry** | 1, 4 | renting an appliance is a lease of goods, and the agreement rolls on without the household acting; `scheduleKind` and `recurrenceMonths` go with it |
| appliance-repair-invoice | parts-warranty end | expiry | expiry | 1 | warranty: over when it is over |
| car-park-season-ticket | renewal date | renewal | renewal | 1 | season ticket: no renewal, no parking |
| charity-giving-confirmation | first collection | due | due | -- | a payment date, not an end of term |
| cycle-insurance-certificate | renewal date | renewal | renewal | 1 | insurance: cover stops unless the household renews |
| domestic-cleaning-contract | price review | other | other | 1 | a rolling contract with no end of term; a price review is neither an ending nor a visit |
| health-screening-clinic-invoice | next screening | service | service | 2 | the next screen is the one to act on; the appointment already held is the record's own `issued` date |
| music-tuition-invoice | payment due | due | due | -- | invoice payment date; the course's own term dates are not declared |
| school-meals-account-statement | statement date | issued | issued | -- | one date, the record's own |
| social-club-subscription-renewal | renewal due | renewal | renewal | 1 | membership, and a repeat payment to keep an existing one alive |
| will-storage-receipt | next storage fee | renewal | renewal | 1 | an annual service charge on an ongoing safe-custody service: it continues only while the household keeps paying |

One document changed: one role label, one `scheduleKind` removed, one
`recurrenceMonths` removed with it. Eleven were already right.

## Judgement calls

1. **Appliance rental, minimum term that rolls on.** This is the only change,
   and it is a close one. The seen corpus ends the broadband and mobile
   minimum terms on `renewal`, and this document's old truth cited the alarm
   monitoring agreement's minimum term as its precedent. Two things separate
   it from those. First, rule 1's own test: at the term end the household does
   not have to do anything -- the agreement "continues on a rolling weekly
   basis until either party gives 28 days' notice" at the same price -- so
   "continues only if the household acts again" is simply false, where an
   out-of-contract broadband tariff does put the household to an election.
   Second, the kind of thing: broadband and mobile are tariffs and the alarm
   is a monitoring subscription, all on the renewal side of the rule, whereas
   renting a washing machine is a hire of goods, which is the "lease" on the
   expiry side. Both routes give `expiry`, so that is what it now says.
   The name in the truth file calls the agreement "rent-to-own", but the page
   says ownership "remains with Homestead Rental Solutions Ltd at all times",
   so rule 3 (finance agreements) was not the route taken; the name is loose
   and was left alone, being outside this re-check.

2. **Allotment rent versus will storage fee.** Both are annual payments on
   things that continue only while they are paid, and they were deliberately
   given different roles. The allotment rent is the first payment under a new
   tenancy, falling due the day before that tenancy starts, so nothing is
   being renewed yet: it is `due`, like the charity's first Direct Debit
   collection. The storage fee falls on the first anniversary of a deposit
   already made, so it is the repeat payment that keeps an existing service
   running: `renewal`, like the social club's subscription. The dividing line
   is whether the payment gets the household in or keeps it in.

3. **Domestic cleaning price review.** Left as `other`. The contract is
   rolling with no end of term, so rule 1 has nothing to act on, and a price
   review is not a visit to act on either.

4. **Health screening, recommendation not appointment.** Rule 2 asks for the
   next visit the household must act on. The recommended screen a year out is
   not booked, but it is still the next one and the only thing to act on, so
   `service` stands and `scheduleKind` stays `service`.

## Tests and regeneration

- `node scripts/corpus/generate.mjs --dir holdout3` rewrites
  `src/server/documents/extraction-holdout3-fullpage.ts` from the
  `.truth.json` and `.txt` files. It needs neither Playwright nor Tika, since
  the `.txt` fixtures already exist, so this time the module was regenerated
  rather than hand-edited.
- `node scripts/corpus/verify.mjs --dir holdout3` was run on the directory.
- `src/server/documents/four-field-contract.test.ts` walks `EXTRACTION_CORPUS`
  only, so it does not see hold-out 3; there is still no hold-out 3 equivalent
  of its role/scheduleKind consistency check. It was run anyway to confirm the
  seen set is unaffected.
