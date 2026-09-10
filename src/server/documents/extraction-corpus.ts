// Extraction evaluation corpus (issue #319): synthetic but representative
// household documents, as the text layer a parser would emit, with the
// fields a correct extraction should find. Accuracy against this corpus is
// the measured number behind every extraction change — heuristic, parser,
// or model. Add documents freely; never tune a fixture to make a parser
// look better.

export interface CorpusExpectation {
  // ISO dates that a correct extraction should surface (order-free).
  dates: string[];
  provider?: string;
  reference?: string;
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
    },
  },
];
