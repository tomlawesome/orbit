// Extraction evaluation corpus (issue #319): synthetic but representative
// household documents, as the text layer a parser would emit, with the
// fields a correct extraction should find. Accuracy against this corpus is
// the measured number behind every extraction change — heuristic, parser,
// or model. Add documents freely; never tune a fixture to make a parser
// look better.

import type { DocumentDateRole } from "./suggestions";
import type { ScheduleKind } from "@/lib/domain";

export interface CorpusExpectation {
  // ISO dates that a correct extraction should surface (order-free).
  dates: string[];
  provider?: string;
  reference?: string;
  // --- The rest is the contract ADR-0025 section 7 gives the model path
  // (issue #960). The heuristics never attempt any of it, by the owner's
  // decision on #319, so every one of these is a blank for `proposalFromText`
  // — that is the measurement, not a defect.
  //
  // Ground truth here is what a careful human reading the page would say,
  // and it is declared only where the page actually says it. Two rules keep
  // it from asking for something the design forbids producing:
  //
  //  - a `costMinor` is declared only where the amount is plainly THE cost of
  //    the thing (a premium, a total due, the monthly price) AND its line
  //    carries a currency symbol or code. A sum insured, an excess, an exit
  //    fee or a balance is not the cost, and a page with several rival
  //    amounts is left undeclared rather than guessed at.
  //  - a `recurrenceMonths` is declared only where the page prints the month
  //    count in DIGITS (the grounding rule needs them in the evidence span)
  //    and the item has a scheduled date to repeat. "Annual", "twelve-month"
  //    and "each month" therefore declare nothing.
  //
  // Every date carries a role naming what kind of date it is, regardless of
  // whether it has already happened: a service date is a service date
  // whether the engineer came last year or comes next year. Choosing which
  // of them becomes the item's scheduled event is the application's job, not
  // the label's.
  //
  // Known thin spot: exactly one of the 36 documents states a recurrence in
  // a form the contract can produce (the gas safety record's "within 12
  // months"), so `recurrence` is measured on a single point. Household
  // paperwork mostly writes "annual" or "twelve-month" in words, which the
  // digits-in-the-span rule refuses on purpose. The fix is more documents,
  // not a looser rule — a document that prints its interval in digits is
  // welcome here.
  /** One role per expected date, in the order the document prints them. */
  dateRoles?: Array<{ date: string; role: DocumentDateRole }>;
  subtype?: string;
  /** Minor units. Always declared together with `currency`, never alone. */
  costMinor?: number;
  currency?: string;
  recurrenceMonths?: number;
  /** Derived from the roles above; the model never emits it. */
  scheduleKind?: ScheduleKind;
}

export interface CorpusDocument {
  name: string;
  filename: string;
  text: string;
  expected: CorpusExpectation;
}

export const EXTRACTION_CORPUS: CorpusDocument[] = [
  {
    name: "home insurance schedule, labelled fields",
    filename: "policy-schedule.pdf",
    text: `HOME INSURANCE — SCHEDULE OF COVER
Provider: Acme Cover Ltd
Policy number: HI-9284712
Period of insurance: 02/10/2025 to 02/10/2026
Renewal date: 02/10/2026
Buildings sum insured £450,000`,
    expected: {
      dates: ["2025-10-02", "2026-10-02"],
      provider: "Acme Cover Ltd",
      reference: "HI-9284712",
      dateRoles: [
        { date: "2025-10-02", role: "start" },
        { date: "2026-10-02", role: "renewal" },
      ],
      subtype: "Home insurance",
      scheduleKind: "renewal",
    },
  },
  {
    name: "MOT certificate, written month dates",
    filename: "mot-certificate.pdf",
    text: `MOT TEST CERTIFICATE
Test number 7213 9982 0417
Vehicle: VOLVO V60
Expiry date: 28 August 2026
Issued: 29 August 2025 at Hartswood Garage`,
    expected: {
      dates: ["2026-08-28", "2025-08-29"],
      dateRoles: [
        { date: "2026-08-28", role: "expiry" },
        { date: "2025-08-29", role: "issued" },
      ],
      subtype: "MOT test certificate",
    },
  },
  {
    name: "boiler service invoice, dotted numeric date",
    filename: "boiler-service-invoice.pdf",
    text: `INVOICE — ANNUAL BOILER SERVICE
Supplier: British Gas
Invoice ref: INV-88213
Service completed 04.09.2025. Next service due 04.09.2026.
Amount due: £120.00`,
    expected: {
      dates: ["2025-09-04", "2026-09-04"],
      provider: "British Gas",
      reference: "INV-88213",
      dateRoles: [
        { date: "2025-09-04", role: "service" },
        { date: "2026-09-04", role: "service" },
      ],
      subtype: "Annual boiler service",
      costMinor: 12_000,
      currency: "GBP",
      scheduleKind: "service",
    },
  },
  {
    name: "car insurance renewal letter, month-first date",
    filename: "car-insurance-renewal.pdf",
    text: `Dear Mr Lawson,
Your car insurance is due for renewal on September 14, 2026.
Your insurer: Shield Motor Insurance
Your reference: SM-2291-X
Annual premium £642.18`,
    expected: {
      dates: ["2026-09-14"],
      provider: "Shield Motor Insurance",
      reference: "SM-2291-X",
      dateRoles: [
        { date: "2026-09-14", role: "renewal" },
      ],
      subtype: "Car insurance",
      costMinor: 64_218,
      currency: "GBP",
      scheduleKind: "renewal",
    },
  },
  {
    name: "energy bill, ISO and slash dates mixed",
    filename: "energy-bill.pdf",
    text: `ENERGY STATEMENT
Account no: 300481292
Billing period 2026-06-01 to 30/06/2026
Payment due by 21/07/2026
Total: £163.90`,
    expected: {
      dates: ["2026-06-01", "2026-06-30", "2026-07-21"],
      reference: "300481292",
      dateRoles: [
        { date: "2026-06-01", role: "start" },
        { date: "2026-06-30", role: "other" },
        { date: "2026-07-21", role: "due" },
      ],
      subtype: "Energy statement",
      costMinor: 16_390,
      currency: "GBP",
    },
  },
  {
    name: "appliance warranty card, ordinal date",
    filename: "warranty-dishwasher.pdf",
    text: `WARRANTY CERTIFICATE
Product: QuietWash 700 Dishwasher
Warranty valid until 3rd March 2027.
Register your appliance to extend cover.`,
    expected: {
      dates: ["2027-03-03"],
      dateRoles: [
        { date: "2027-03-03", role: "expiry" },
      ],
      subtype: "Warranty certificate",
    },
  },
  {
    name: "TV licence, abbreviated month",
    filename: "tv-licence.pdf",
    text: `Your TV Licence
Licence number: TVL-04482913
Expires: 30 Nov 2026
A colour licence costs £169.50 a year.`,
    expected: {
      dates: ["2026-11-30"],
      reference: "TVL-04482913",
      dateRoles: [
        { date: "2026-11-30", role: "expiry" },
      ],
      subtype: "TV Licence",
      costMinor: 16_950,
      currency: "GBP",
    },
  },
  {
    name: "home emergency cover, prose-embedded dates",
    filename: "home-emergency-cover.pdf",
    text: `Thank you for choosing HomeSafe Assist. Your cover began on
12 January 2026 and runs until 11 January 2027 unless renewed.
Questions? Quote reference HS-77120 when you call.`,
    expected: {
      dates: ["2026-01-12", "2027-01-11"],
      reference: "HS-77120",
      dateRoles: [
        { date: "2026-01-12", role: "start" },
        { date: "2027-01-11", role: "expiry" },
      ],
    },
  },
  {
    name: "chimney sweep receipt, minimal structure",
    filename: "chimney-sweep-receipt.pdf",
    text: `Received with thanks — chimney swept and certified.
J. Marsh & Son. 12/10/2025. £90 cash.
We recommend annual sweeping.`,
    expected: {
      dates: ["2025-10-12"],
      dateRoles: [
        { date: "2025-10-12", role: "service" },
      ],
      costMinor: 9_000,
      currency: "GBP",
      scheduleKind: "service",
    },
  },
  {
    name: "council tax bill, financial-year dates",
    filename: "council-tax.pdf",
    text: `COUNCIL TAX DEMAND 2026/27
Account reference: 55018824
First instalment due 01/04/2026, final instalment 01/01/2027.`,
    expected: {
      dates: ["2026-04-01", "2027-01-01"],
      reference: "55018824",
      dateRoles: [
        { date: "2026-04-01", role: "due" },
        { date: "2027-01-01", role: "due" },
      ],
      subtype: "Council tax",
    },
  },
  {
    name: "pet insurance, mixed labels",
    filename: "pet-insurance.pdf",
    text: `PET INSURANCE CERTIFICATE
Insurer - PawGuard
Policy no. PG881122
Cover start 15/02/2026 — renews automatically 15/02/2027`,
    expected: {
      dates: ["2026-02-15", "2027-02-15"],
      provider: "PawGuard",
      reference: "PG881122",
      dateRoles: [
        { date: "2026-02-15", role: "start" },
        { date: "2027-02-15", role: "renewal" },
      ],
      subtype: "Pet insurance",
      scheduleKind: "renewal",
    },
  },
  {
    name: "smoke alarm manual page, no obligations",
    filename: "smoke-alarm-manual.pdf",
    text: `User guide — Model SA-10 smoke alarm.
Test the alarm weekly using the test button.
Replace the battery when the unit chirps.`,
    expected: {
      dates: [],
    },
  },
  // --- Harder documents (issue #319, slice 1). Ground truth here is what a
  // careful human reading the page would say, not what today's heuristics
  // return. Some of these are expected to miss; that is the measurement.
  {
    name: "water statement, fully labelled with ISO dates",
    filename: "water-statement.pdf",
    text: `CLEARSPRING WATER — STATEMENT OF ACCOUNT
Provider: Clearspring Water Ltd
Account number: CW-0099-4471
Charges for the period 2026-04-01 to 2027-03-31.
Your next statement is due 2026-10-01. Balance carried forward £0.00.`,
    expected: {
      dates: ["2026-04-01", "2027-03-31", "2026-10-01"],
      provider: "Clearspring Water Ltd",
      reference: "CW-0099-4471",
      dateRoles: [
        { date: "2026-04-01", role: "start" },
        { date: "2027-03-31", role: "other" },
        { date: "2026-10-01", role: "due" },
      ],
      subtype: "Statement of account",
    },
  },
  {
    name: "MOT reminder letter, three dates, garage named in prose",
    filename: "mot-reminder.pdf",
    text: `VEHICLE MOT REMINDER
Sent 12 August 2026 by Hartswood Garage Services, Westhaven.
Our records show your vehicle was last tested on 28 August 2025.
The certificate on file expires 28 August 2026. Book early to avoid a lapse.
Test slots are held for 48 hours.`,
    expected: {
      dates: ["2026-08-12", "2025-08-28", "2026-08-28"],
      provider: "Hartswood Garage Services",
      dateRoles: [
        { date: "2026-08-12", role: "issued" },
        { date: "2025-08-28", role: "service" },
        { date: "2026-08-28", role: "expiry" },
      ],
      scheduleKind: "service",
    },
  },
  {
    name: "council tax demand, space-separated reference and letterhead issuer",
    filename: "council-tax-demand.pdf",
    text: `BOROUGH OF WESTHAVEN
COUNCIL TAX DEMAND NOTICE 2027/28
Issued 09 March 2027
Property: 14 Larkspur Way, Westhaven WH4 2QP
Council tax reference 8802 5514 9
Ten instalments are payable from 1 April 2027 to 1 January 2028.`,
    expected: {
      dates: ["2027-03-09", "2027-04-01", "2028-01-01"],
      provider: "Borough of Westhaven",
      reference: "8802 5514 9",
      dateRoles: [
        { date: "2027-03-09", role: "issued" },
        { date: "2027-04-01", role: "due" },
        { date: "2028-01-01", role: "due" },
      ],
      subtype: "Council tax demand notice",
    },
  },
  {
    name: "broadband agreement, hyphenated numeric date",
    filename: "broadband-agreement.pdf",
    text: `NORTHGATE FIBRE — SERVICE AGREEMENT
Supplier: Northgate Fibre Ltd
Customer account 4471-8820-3390
Service start date 2 October 2026. Minimum term ends 31-03-2028.
Speeds quoted are estimates and are not guaranteed.`,
    expected: {
      dates: ["2026-10-02", "2028-03-31"],
      provider: "Northgate Fibre Ltd",
      reference: "4471-8820-3390",
      dateRoles: [
        { date: "2026-10-02", role: "start" },
        { date: "2028-03-31", role: "expiry" },
      ],
      subtype: "Service agreement",
    },
  },
  {
    name: "life cover statement, two-digit year and slashed plan number",
    filename: "life-cover-statement.pdf",
    text: `ACORN MUTUAL — LIFE COVER STATEMENT
Provider: Acorn Mutual Assurance Society
Plan number LC/2291/443
Your plan started on 06/05/24 and the premium is fixed for life.
The next annual review is 6 May 2027.`,
    expected: {
      dates: ["2024-05-06", "2027-05-06"],
      provider: "Acorn Mutual Assurance Society",
      reference: "LC/2291/443",
      dateRoles: [
        { date: "2024-05-06", role: "start" },
        { date: "2027-05-06", role: "due" },
      ],
      subtype: "Life cover",
    },
  },
  {
    name: "buildings renewal, reference with an internal space",
    filename: "buildings-renewal.pdf",
    text: `NORTHERN SHIRE MUTUAL — BUILDINGS COVER
Insurer: Northern Shire Mutual Insurance Society
Quotation prepared 04 Feb 2027
Your current policy expires 21 Feb 2027. If you do nothing we will renew it
from 22 Feb 2027 for a further twelve months at £412.00.
Policy: NSM 44/22910`,
    expected: {
      dates: ["2027-02-04", "2027-02-21", "2027-02-22"],
      provider: "Northern Shire Mutual Insurance Society",
      reference: "NSM 44/22910",
      dateRoles: [
        { date: "2027-02-04", role: "issued" },
        { date: "2027-02-21", role: "expiry" },
        { date: "2027-02-22", role: "renewal" },
      ],
      subtype: "Buildings cover",
      costMinor: 41_200,
      currency: "GBP",
      scheduleKind: "renewal",
    },
  },
  {
    name: "thermostat quick-start card, firmware version shaped like a date",
    filename: "thermostat-quick-start.pdf",
    text: `SMART THERMOSTAT — QUICK START CARD
Hold the dial for five seconds to pair the thermostat with your hub.
Firmware on this unit: 2.4.2026. Check the app for updates.
Support line 0800 118 2255, open 8am to 8pm every day.
Keep this card with your appliance paperwork.`,
    expected: {
      dates: [],
    },
  },
  {
    name: "gym membership, dates written as the 1st of October",
    filename: "gym-membership.pdf",
    text: `RIVERBANK LEISURE CLUB — MEMBERSHIP AGREEMENT
Provider: Riverbank Leisure Club
Membership number: RLC-7781-22
Signed at the club on 24 September 2026.
Your twelve-month membership begins on the 1st of October 2026 and ends on
the 30th of September 2027. One calendar month's notice applies.`,
    expected: {
      dates: ["2026-09-24", "2026-10-01", "2027-09-30"],
      provider: "Riverbank Leisure Club",
      reference: "RLC-7781-22",
      dateRoles: [
        { date: "2026-09-24", role: "issued" },
        { date: "2026-10-01", role: "start" },
        { date: "2027-09-30", role: "expiry" },
      ],
      subtype: "Membership agreement",
    },
  },
  {
    name: "renewal invitation, insurer and administrator on one line",
    filename: "contents-renewal-invitation.pdf",
    text: `RENEWAL INVITATION — CONTENTS INSURANCE
Insurer: Kestrel Mutual (administered by Faircross Broking Ltd)
Policy number 88-2291-KM
Your cover ends on 30-09-2026 and the new policy year starts 01-10-2026.
Please check your details before 23 September 2026. New premium £318.40.`,
    expected: {
      dates: ["2026-09-30", "2026-10-01", "2026-09-23"],
      provider: "Kestrel Mutual",
      reference: "88-2291-KM",
      dateRoles: [
        { date: "2026-09-30", role: "expiry" },
        { date: "2026-10-01", role: "renewal" },
        { date: "2026-09-23", role: "due" },
      ],
      subtype: "Contents insurance",
      costMinor: 31_840,
      currency: "GBP",
      scheduleKind: "renewal",
    },
  },
  {
    name: "roofing agreement, year-first slashed dates",
    filename: "roofing-agreement.pdf",
    text: `FAIRWEATHER ROOFING — MAINTENANCE AGREEMENT
Supplier: Fairweather Roofing Ltd
Agreement reference FR/2026/0418
Signed 18 April 2026 at Westhaven.
Annual inspection due 2026/07/15, with a second visit on 2027/01/20 if the
first identifies work.`,
    expected: {
      dates: ["2026-04-18", "2026-07-15", "2027-01-20"],
      provider: "Fairweather Roofing Ltd",
      reference: "FR/2026/0418",
      dateRoles: [
        { date: "2026-04-18", role: "issued" },
        { date: "2026-07-15", role: "service" },
        { date: "2027-01-20", role: "service" },
      ],
      subtype: "Maintenance agreement",
      scheduleKind: "service",
    },
  },
  {
    name: "dental plan, single renewal date among undated payment terms",
    filename: "dental-plan.pdf",
    text: `BRIGHTMOOR DENTAL PLAN
Provider: Brightmoor Dental Care Ltd
Membership number: BDC-771244
Your plan renews on 1 December 2026.
Payments of £18.50 are collected on the 1st of each month.`,
    expected: {
      dates: ["2026-12-01"],
      provider: "Brightmoor Dental Care Ltd",
      reference: "BDC-771244",
      dateRoles: [
        { date: "2026-12-01", role: "renewal" },
      ],
      subtype: "Dental plan",
      costMinor: 1_850,
      currency: "GBP",
      scheduleKind: "renewal",
    },
  },
  // --- Retired hold-out documents (issue #937). These thirteen were the
  // hold-out corpus of #934. Commit 2c66021 fixed the three weaknesses they
  // exposed, which tuned the extractor against them and spent them as an
  // independent measure, so they were retired here into the tuning set.
  // Their `holdout-*.pdf` filenames are historical and are deliberately
  // left as they are: renaming would change what the extractor is fed.
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
      dateRoles: [
        { date: "2026-02-01", role: "start" },
        { date: "2027-01-31", role: "expiry" },
      ],
      subtype: "Buildings and contents",
      costMinor: 41_266,
      currency: "GBP",
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
      dateRoles: [
        { date: "2026-02-14", role: "service" },
        { date: "2027-02-13", role: "expiry" },
      ],
      subtype: "MOT test certificate",
      scheduleKind: "service",
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
      dateRoles: [
        { date: "2026-03-12", role: "issued" },
        { date: "2026-04-01", role: "start" },
        { date: "2027-03-31", role: "other" },
        { date: "2027-01-01", role: "due" },
      ],
      subtype: "Council tax demand notice",
      costMinor: 138_162,
      currency: "GBP",
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
      dateRoles: [
        { date: "2026-06-03", role: "start" },
        { date: "2027-04-01", role: "other" },
        { date: "2026-05-27", role: "issued" },
      ],
      subtype: "Ferngate Fibre 500",
      costMinor: 3_800,
      currency: "GBP",
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
      dateRoles: [
        { date: "2025-12-03", role: "other" },
        { date: "2026-06-04", role: "other" },
        { date: "2026-06-30", role: "due" },
        { date: "2026-07-15", role: "due" },
      ],
      costMinor: 38_946,
      currency: "GBP",
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
      dateRoles: [
        { date: "2026-09-09", role: "service" },
      ],
      subtype: "Gas safety record",
      scheduleKind: "service",
      recurrenceMonths: 12,
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
      dateRoles: [
        { date: "2026-03-09", role: "start" },
        { date: "2031-03-08", role: "expiry" },
      ],
      subtype: "Extended warranty",
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
      dateRoles: [
        { date: "2026-10-01", role: "renewal" },
        { date: "2026-09-30", role: "expiry" },
        { date: "2026-09-24", role: "due" },
      ],
      costMinor: 3_144,
      currency: "GBP",
      scheduleKind: "renewal",
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
      dateRoles: [
        { date: "2025-08-18", role: "start" },
        { date: "2027-08-17", role: "expiry" },
      ],
      subtype: "Airtime plan",
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
      subtype: "Trellis Fixed Saver",
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
      dateRoles: [
        { date: "2024-05-20", role: "start" },
        { date: "2034-05-20", role: "expiry" },
      ],
      subtype: "New Home Warranty",
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
      dateRoles: [
        { date: "2026-07-01", role: "start" },
        { date: "2027-06-30", role: "expiry" },
        { date: "2025-09-11", role: "service" },
        { date: "2026-06-03", role: "issued" },
      ],
      subtype: "Boiler and heating plan",
      costMinor: 2_650,
      currency: "GBP",
      scheduleKind: "service",
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
      dateRoles: [
        { date: "2026-03-15", role: "start" },
        { date: "2028-03-15", role: "expiry" },
      ],
      subtype: "Limited warranty",
    },
  },
];
