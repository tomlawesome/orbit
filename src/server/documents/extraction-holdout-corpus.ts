// HOLD-OUT extraction corpus (ADR-0025 section 6, issue #934).
//
// THE RULE: a session doing extraction improvement work — tuning the
// heuristics in `suggestions.ts`, writing or iterating a model prompt,
// choosing a model, changing the parser — DOES NOT READ THIS FILE. Read
// `extraction-corpus.ts` instead. That one is the tuning set: it exists to
// be read, iterated against and extended freely.
//
// What the rule is for. `extraction-corpus.ts` scores 1.00, but only
// because the heuristics were improved against those exact documents,
// twice (#929). A score you revised the paper for measures nothing. The
// documents below are paper no extractor has been fitted to, so the number
// they produce is the first honest estimate of how extraction handles
// household documents it has never seen. It is also the only place
// ADR-0025's gate can be measured at all: the model path must beat the
// heuristic baseline by 0.05, and a baseline already sitting at 1.00
// leaves no room for any margin to exist.
//
// What breaking the rule costs. Reading these documents while improving
// extraction destroys the measurement silently. No test turns red, no
// pipeline fails, and afterwards the score itself cannot tell you it
// happened — the number just quietly goes back to meaning "handles these
// documents". So if it happens, say so: move the document that was tuned
// against into `extraction-corpus.ts`, write a replacement here, and note
// it. That is cheap. Staying quiet is the expensive option, because every
// later decision about promoting the model path rests on a number nobody
// can then trust.
//
// Enforcement is this comment plus review — nothing in a repository can
// stop a person opening a file. That is exactly why the rule is written
// where a reader lands rather than left to convention.
//
// Ground truth here is what a careful person reading the paperwork would
// say is correct, written down before any extractor was run against it.
// It is not what the current extractor happens to return. A document is
// never weakened, reworded or dropped to raise the score; a document that
// turns out to be genuinely ambiguous is replaced by a clearer one, and
// the replacement is recorded as such.
//
// Everything is synthetic. The providers, people, addresses, reference
// numbers and amounts are invented, and are meant to read as invented.

import type { CorpusDocument } from "./extraction-corpus";

// Same shape as the tuning corpus on purpose, so one harness
// (`extraction-scoring.ts`) scores both.
export const EXTRACTION_HOLDOUT_CORPUS: CorpusDocument[] = [
  {
    name: "buildings and contents schedule, provider only on the letterhead, reference in the footer",
    filename: "holdout-buildings-contents-schedule.pdf",
    text: `Larkfield Mutual Insurance
Bexhall House, 4 Tannery Row, Northmoor NM2 6TX

SCHEDULE OF INSURANCE — BUILDINGS AND CONTENTS

Prepared for    Ms A. Quilliam
Risk address    14 Ferndale Rise, Marchbourne MB4 7QT

Cover starts    1 February 2026
Cover ends      31 January 2027
Premium         £412.66, payable as 12 monthly instalments of £34.39
Excess          £250, rising to £1,000 for subsidence

This schedule replaces any earlier schedule issued for the same period.

Larkfield Mutual Insurance is a trading name of Larkfield Mutual Ltd,
registered in England no. 2214887.
Policy LKM/44-12-8890                                        Page 1 of 3`,
    expected: {
      dates: ["2026-02-01", "2027-01-31"],
      provider: "Larkfield Mutual Insurance",
      reference: "LKM/44-12-8890",
    },
  },
  {
    name: "MOT certificate, grouped test number among a registration mark and an odometer",
    filename: "holdout-mot-certificate.pdf",
    text: `MOT TEST CERTIFICATE                                          VT20
Issued by Cobbledown Motors, VTS 74129

Test number         4471 8802 5590
Registration mark   QX07 HRV
Make and model      FORD FOCUS
Odometer            84,213 miles at test
Test date           14.02.2026
Expiry date         13.02.2027

Advisory: nearside front tyre close to the legal limit of 1.6mm.`,
    expected: {
      dates: ["2026-02-14", "2027-02-13"],
      provider: "Cobbledown Motors",
      reference: "4471 8802 5590",
    },
  },
  {
    name: "council tax demand, four dates across a charge period and an instalment plan",
    filename: "holdout-council-tax.pdf",
    text: `MELBURY BOROUGH COUNCIL
Council Tax Demand Notice 2026/27

Account number   MB-8827441
Property         14 Ferndale Rise, Marchbourne MB4 7QT
Band             D
Date of issue    12 March 2026

Charge for the period 1 April 2026 to 31 March 2027         £1,842.15
Less single person discount (25%)                            -£460.53
Amount to pay                                              £1,381.62

Payable by 10 monthly instalments. The first instalment is due on
1 April 2026 and the final instalment is due on 1 January 2027.
Cheques payable to Melbury Borough Council.`,
    expected: {
      dates: ["2026-03-12", "2026-04-01", "2027-03-31", "2027-01-01"],
      provider: "Melbury Borough Council",
      reference: "MB-8827441",
    },
  },
  {
    name: "broadband order confirmation, conversational dates among contract-length distractors",
    filename: "holdout-broadband-order.pdf",
    text: `Ferngate Broadband
Thanks — your order is confirmed

Hello Ms Quilliam,

We'll switch you over on the 3rd of June 2026. Your new router should
arrive a couple of days before that, and there is nothing you need to do
on the day.

Your package    Ferngate Fibre 500 with unlimited calls
Monthly price   £38.00 for the first 18 months, then our standard price
Minimum term    24 months from the switch date
Account number  FG 5512 8830 41

Prices change each April in line with inflation plus 3.9%. The first
change will apply from 1 April 2027.

Your 14-day cancellation period runs from the day you placed the order,
27 May 2026.`,
    expected: {
      dates: ["2026-06-03", "2027-04-01", "2026-05-27"],
      provider: "Ferngate Broadband",
      reference: "FG 5512 8830 41",
    },
  },
  {
    name: "water bill, two-digit years beside meter readings",
    filename: "holdout-water-bill.pdf",
    text: `WEXLEY WATER
Your bill                                        Bill number 7714/22

Customer   Ms A Quilliam                 Account 55 214 887 3
Supply     14 Ferndale Rise, Marchbourne

Meter readings
  Previous   03/12/25    000914   (actual)
  Current    04/06/26    001073   (actual)
  Used       159 cubic metres

Charges for the period 3 December 2025 to 4 June 2026
  Water                                                    £201.44
  Wastewater                                               £188.02
  Total now due                                            £389.46

Please pay by 30/06/26. If you pay by Direct Debit we will collect on or
just after 15/07/26.`,
    expected: {
      dates: ["2025-12-03", "2026-06-04", "2026-06-30", "2026-07-15"],
      provider: "Wexley Water",
      reference: "55 214 887 3",
    },
  },
  {
    name: "gas safety record, one real date and a deadline expressed as a duration",
    filename: "holdout-gas-safety-record.pdf",
    text: `ASHCOMBE GAS SERVICES — GAS SAFETY RECORD
Gas Safe registration 903117

Engineer     D. Marsh (licence 903117/4)
Appliance    Combi boiler, kitchen
Inspected    9 September 2026
Next inspection due within 12 months of the date above.

Certificate no. AGS-2026-0442
Issued to Ms A. Quilliam, 14 Ferndale Rise

This record confirms only that the appliance is safe on the day of the
inspection. It says nothing about how efficiently it runs.`,
    expected: {
      dates: ["2026-09-09"],
      provider: "Ashcombe Gas Services",
      reference: "AGS-2026-0442",
    },
  },
  {
    name: "extended warranty confirmation, year-first dates and a serial number that is not the reference",
    filename: "holdout-appliance-warranty.pdf",
    text: `MARROW & FINCH
Extended warranty confirmation

Appliance        Frostline 340 fridge freezer, serial FL340-9928471
Purchased        2026/03/09 at our Northmoor store
Cover            5 years parts and labour, expiring 2031/03/08
Plan reference   W-0099-2841

Keep this confirmation with your receipt. When you claim, quote the plan
reference rather than the serial number.`,
    expected: {
      dates: ["2026-03-09", "2031-03-08"],
      provider: "Marrow & Finch",
      reference: "W-0099-2841",
    },
  },
  {
    name: "pet insurance renewal invitation, ordinal dates in prose",
    filename: "holdout-pet-insurance-renewal.pdf",
    text: `Pinfold Pet Insurance
PO Box 4412, Southgate Vale SV1 9RR

Your renewal invitation

Dear Ms Quilliam

Your policy for Biscuit (Border Terrier) is due to renew on 1st October
2026. Cover under your current policy ends at midnight on 30th September
2026.

Your new premium is £31.44 a month, up from £28.90. We have written to
you at least 21 days before renewal, as the rules require.

Policy number 8841-QP-77
If you would rather not renew, tell us before 24 September 2026.`,
    expected: {
      dates: ["2026-10-01", "2026-09-30", "2026-09-24"],
      provider: "Pinfold Pet Insurance",
      reference: "8841-QP-77",
    },
  },
  {
    name: "mobile airtime summary, label and date broken across lines by the text layer",
    filename: "holdout-mobile-airtime.pdf",
    text: `QUILLET MOBILE
Airtime plan summary

Plan holder      Ms A Quilliam
Mobile number    07700 900482
Account
number           QM-4471-0088-2

Plan started     18
August 2025
Minimum term ends 17 August 2027
Monthly airtime £14.00, device plan £22.50

Your device plan and your airtime plan end on different dates. The
device plan is paid off on 17 August 2027.`,
    expected: {
      dates: ["2025-08-18", "2027-08-17"],
      provider: "Quillet Mobile",
      reference: "QM-4471-0088-2",
    },
  },
  {
    name: "tariff information label, no dates at all and prices that look like them",
    filename: "holdout-tariff-label.pdf",
    text: `TRELLIS ENERGY — TARIFF INFORMATION LABEL

Tariff name             Trellis Fixed Saver
Tariff type             Fixed
Payment method          Monthly Direct Debit
Unit rate, electricity  24.31p per kWh
Standing charge         60.10p per day
Exit fee                £30 per fuel

The price is guaranteed until the end of the fixed term shown on your
contract. This label is a summary. It is not a contract, and it is not
personalised: your account number and your dates are on your welcome
letter.`,
    expected: {
      dates: [],
      provider: "Trellis Energy",
    },
  },
  {
    name: "structural warranty certificate, ten-year span with a builder as a rival provider",
    filename: "holdout-structural-warranty.pdf",
    text: `STONEPATH STRUCTURAL GUARANTEES LIMITED
Certificate of Insurance — New Home Warranty

Certificate number   SP/NH/118420
Property             14 Ferndale Rise, Marchbourne MB4 7QT
Builder              Corley & Sons (Northmoor) Ltd

Period of cover
  Defects insurance period      two years from 20 May 2024
  Structural insurance period   20 May 2024 to 20 May 2034

Claims must be notified in writing. Nothing in this certificate extends
cover beyond the periods stated above.`,
    expected: {
      dates: ["2024-05-20", "2034-05-20"],
      provider: "Stonepath Structural Guarantees Limited",
      reference: "SP/NH/118420",
    },
  },
  {
    name: "heating plan statement, en-dashed short dates and a weekday prefix",
    filename: "holdout-heating-plan.pdf",
    text: `Halverston Home Cover
Boiler and heating plan — annual statement

Plan number      HHC 60 4471 22
Plan year        01 Jul 26 – 30 Jun 27
Monthly payment  £26.50, collected on or around the 4th

Last year's visit: an engineer attended on Thu 11 Sep 2025 and passed the
boiler as serviced. This year's service is not yet booked — book online
or call us.

We wrote to you about this plan on 03 June 2026.`,
    expected: {
      dates: ["2026-07-01", "2027-06-30", "2025-09-11", "2026-06-03"],
      provider: "Halverston Home Cover",
      reference: "HHC 60 4471 22",
    },
  },
  {
    name: "imported appliance warranty card, month-first dates labelled as such",
    filename: "holdout-imported-warranty-card.pdf",
    text: `VANTERRA APPLIANCES
Limited warranty card (UK edition)

Model              VT-CS9 coffee system
Serial             9928-4471-0092
Date of purchase   03/15/2026  (mm/dd/yyyy)
Warranty period    24 months
Warranty expires   03/15/2028  (mm/dd/yyyy)
Registration ref   VA-UK-778120

Issued by Vanterra Appliances. Warranty service in the United Kingdom is
carried out by Vanterra Service UK.`,
    expected: {
      dates: ["2026-03-15", "2028-03-15"],
      provider: "Vanterra Appliances",
      reference: "VA-UK-778120",
    },
  },
];
