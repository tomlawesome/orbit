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
];
