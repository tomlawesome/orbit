import { describe, expect, it } from "vitest";
import { EXTRACTION_CORPUS } from "./extraction-corpus";
import {
  comparableText,
  modelProposalFromText,
  type ModelGenerateRequest,
  type ModelReply,
  type ModelTransport,
} from "./model-extraction";
import { safeDocumentEvidence } from "./suggestions";

/**
 * #965: when the extraction evaluation reports a field as `got "none"
 * (blank)`, that single symptom covers two different failures with opposite
 * fixes -- the model said nothing, or the model said something and our own
 * grounding/validation threw it away. This file answers only the second
 * question: can a perfect answer survive the real path?
 *
 * For every document in `EXTRACTION_CORPUS`, this builds the object an ideal
 * model would return -- each expected value paired with a literal evidence
 * span copied from that document's own `text` -- and runs it through the
 * real `modelProposalFromText`, with a fake transport standing in for the
 * network exactly as `model-extraction.test.ts` does. A failing assertion
 * here means validation dropped a value a perfect model supplied; that is
 * the finding, not a bug to work around.
 */

const MODEL_ENVIRONMENT = { OLLAMA_MODEL: "a-local-model:latest" } as NodeJS.ProcessEnv;

// --- Copied from model-extraction.test.ts: the transport/envelope fakes
// around the real modelProposalFromText path. Not reinvented here. ---
async function* chunksOf(bytes: Buffer, size = 4_096): AsyncGenerator<Uint8Array> {
  for (let offset = 0; offset < bytes.byteLength; offset += size) {
    yield new Uint8Array(bytes.subarray(offset, Math.min(bytes.byteLength, offset + size)));
  }
}

function replyOf(payload: Buffer, overrides: Partial<ModelReply> = {}): ModelReply {
  return {
    status: 200,
    contentType: "application/json",
    contentLength: String(payload.byteLength),
    body: chunksOf(payload),
    ...overrides,
  };
}

function envelopeOf(generated: unknown): Buffer {
  return Buffer.from(JSON.stringify({
    model: "a-local-model:latest",
    created_at: "2026-09-09T00:00:00Z",
    response: JSON.stringify(generated),
    done: true,
  }), "utf8");
}

function transportReturning(reply: ModelReply): ModelTransport & { requests: ModelGenerateRequest[] } {
  const requests: ModelGenerateRequest[] = [];
  return {
    requests,
    async send(request) {
      requests.push(request);
      return reply;
    },
  };
}

// --- Two of model-extraction.ts's own fixed bounds, mirrored rather than
// imported: neither is exported (ADR-0025 keeps them out of configuration
// surface on purpose), so they are pinned here as plain numbers. If either
// changes in model-extraction.ts, the spans below need re-checking -- that
// is the point of pinning rather than re-deriving them. ---
const EVIDENCE_SPAN_MAX_CHARACTERS = 200;
const INPUT_CHARACTER_BUDGET = 12_000;

function collapseWhitespace(value: string): string {
  return value.replace(/\s+/gu, " ").trim();
}

/**
 * Finds a hand-picked needle -- a snippet copied verbatim from a corpus
 * document's own `text` -- inside that document's normalised text, and
 * returns it collapsed the same way `safeDocumentEvidence` collapses the
 * document (whitespace runs to one space). Throws, naming the document and
 * the needle, when it is not actually present. On this corpus that is a bug
 * in the needle below; on a corpus where a ground-truth value truly cannot
 * be quoted from its own text, the same throw is the finding the task asked
 * for -- no model could ground that field either.
 */
function span(filename: string, rawNeedle: string, normalizedText: string): string {
  const needle = collapseWhitespace(rawNeedle);
  if (needle.length > EVIDENCE_SPAN_MAX_CHARACTERS) {
    throw new Error(
      `[${filename}] evidence needle exceeds the ${EVIDENCE_SPAN_MAX_CHARACTERS}-character span cap ` +
      `(${needle.length}): ${JSON.stringify(needle)}`,
    );
  }
  if (!normalizedText.includes(needle)) {
    throw new Error(
      `[${filename}] ground-truth value's evidence is not present verbatim in the document's ` +
      `normalised text -- no model could quote this: ${JSON.stringify(needle)}`,
    );
  }
  return needle;
}

interface DocEvidence {
  provider?: string;
  reference?: string;
  subtype?: string;
  cost?: { amount: string; needle: string };
  recurrence?: { months: number; needle: string };
  /** Evidence needles, one per entry of `expected.dateRoles`, same order. */
  dates?: string[];
}

/**
 * Hand-picked evidence per document, keyed by filename (unique across the
 * corpus). Each needle is a snippet copied verbatim from that document's own
 * `text` above and containing the ground-truth value -- this is the "ideal
 * model" this test stands in for: one that always quotes real text.
 */
const EVIDENCE: Record<string, DocEvidence> = {
  // --- Full-page documents (#981) ---------------------------------------
  //
  // Needles here are cut from the real Tika output by
  // `scripts/corpus/generate-evidence.mjs`, not written by hand, so they
  // quote the page exactly as production sees it -- including broken words
  // like `Pu r beck` and `E X PI RY D ATE`, which is what CSS letter-spacing
  // does to a PDF's text layer. Real letterspaced headings extract this way;
  // it is a genuine difficulty, not damage.
  "fullpage-broadband-contract.pdf": {
    provider: "Kestrel Broadband — Contract Summary and Terms Kestrel Broadband Contract Summary Order",
    reference: "number KB-771049-3 Order reference ORD-2026-0417726 Billing address Flat 2, 9 Thornfield Close, Marlcombe, Warwickshire,",
    subtype: "Kestrel Broadband — Contract Summary and Terms Kestrel Broadband Contract Summary Order date 14 April 2026 Document",
    cost: { amount: "34.99", needle: "2026 24-Month Fibre & Phone Contract Key contract information — Ofcom-format summary MONTHLY PRICE, MINIMUM TERM £34.99 per month, includes line" },
    recurrence: { months: 24, needle: "SPEED 502 Mbps average upload speed 74 Mbps MINIMUM TERM 24 months ends 21 April 2028 CUSTOMER AND" },
    dates: [
      "Warwickshire, CV9 7QL Service start (activation) 22 April 2026 Minimum term 24 months",
      "upload speed 74 Mbps MINIMUM TERM 24 months ends 21 April 2028 CUSTOMER AND ACCOUNT",
    ],
  },
  "fullpage-gas-safety-record.pdf": {
    provider: "Date of issue 03/08/2026 BUSINESS NAME Fenwick & Vale Gas Services Ltd GAS SAFE REGISTERED BUSINESS, REGISTRATION NUMBER 512864 BUSINESS",
    reference: "RECORD LANDLORD / DUTYHOLDER COPY No. GSR-2026-04471 CP12 Date of issue 03/08/2026 BUSINESS NAME Fenwick & Vale Gas Services",
    subtype: "Landlord's Gas Safety Record — CP12 LANDLORD'S GAS SAFETY RECORD LANDLORD / DUTYHOLDER COPY No.",
    recurrence: { months: 12, needle: "safety or of efficient operation. This record is valid for 12 months from the date of inspection shown" },
    dates: [
      "safe to use on the date shown DATE OF INSPECTION 03 August 2026 This record confirms",
    ],
  },
  "fullpage-home-insurance-schedule.pdf": {
    provider: "Policy Schedule — Thornfield Assurance plc Thornfield Assurance plc — Policy schedule Policy TA-HH-7734291 — Page",
    reference: "Assurance plc — Policy schedule Policy TA-HH-7734291 — Page 1 of 3 THORNFIELD ASSURANCE PLC Registered office: Thornfield",
    subtype: "Policy Schedule — Thornfield Assurance plc Thornfield Assurance plc — Policy schedule",
    cost: { amount: "412.99", needle: "L PR E M IUM Net premium (excluding Insurance Premium Tax) £368.74 Insurance Premium Tax at 12% £44.25 Annual premium £412.99 Annual premium payable" },
    dates: [
      "R IOD Policy number TA-HH-7734291 Period of insurance 14 March 2026 to 14 March 2027 Renewal",
      "TA-HH-7734291 Period of insurance 14 March 2026 to 14 March 2027 Renewal date 14 March",
    ],
  },
  "fullpage-mot-certificate.pdf": {
    provider: "STATION AND TESTER 1. TEST STATION Calderwell Motor Services Ltd 2. VTS NUMBER V-441829 3. ADDRESS Unit 7, Brandmoor Industrial Estate,",
    reference: "— MOT test certificate Test number 1847 2205 9631 — Page 1 of 2 DVTA Driver & Vehicle Testing Authority Statutory",
    subtype: "MOT Test Certificate VT20 Driver & Vehicle Testing Authority — MOT test certificate Test",
    dates: [
      "time. E X PI RY D ATE 08 September 2027 Test date 09 September 2026 VEHICLE DETAILS 1.",
      "condition at any other time. E X PI RY D ATE 08 September 2027 Test date 09 September",
    ],
  },
  "fullpage-pet-vaccination-card.pdf": {
    provider: "bring this card to every appointment Hawksmoor Cross Veterinary Centre 22 Thornfield Road, Bramcote St Giles, Wyvern DE7 4PL Telephone 01159",
    reference: "· Labrador Retriever · Microchip 977200005841236 Vaccination & health record · Page 1 of 2 Vaccination & Health Record",
    subtype: "Vaccination & Health Record Bramble · Labrador Retriever · Microchip 977200005841236 Vaccination &",
    dates: [
      "(DHPPi/L4 + kennel cough) NEXT VACCINATION DUE 18 May 2027 Book in the two weeks",
    ],
  },
  "fullpage-service-charge-demand.pdf": {
    provider: "22 Petersgate Road Alderwick WX7 4LP Purbeck & Vane Property Management Ltd · Account TFC-014-2627 Page 1 of 4 Pu r beck & Vane Prop erty",
    reference: "14, Thornfield Court Account reference TFC-014-2627 · Lease reference TFC/14/LR-1998 · First instalment (1 of 2) We write",
    subtype: "Service Charge Demand — Thornfield Court P&V Pur beck & Vane Pro p erty Management Ltd 14",
    cost: { amount: "3,930.00", needle: "then falling due. Your apportioned share of the service charge budgeted for the development for that year is £3,930.00, as shown in the" },
    recurrence: { months: 12, needle: "This demand covers the service charge year running for a 12-month period from 1 April 2026 to 31" },
    dates: [
      "the service charge year running from 1 April 2026 to 31 March 2027. This demand is issued",
    ],
  },

  "policy-schedule.pdf": {
    provider: "Provider: Acme Cover Ltd",
    reference: "Policy number: HI-9284712",
    subtype: "HOME INSURANCE — SCHEDULE OF COVER",
    dates: [
      "Period of insurance: 02/10/2025 to 02/10/2026",
      "Renewal date: 02/10/2026",
    ],
  },
  "mot-certificate.pdf": {
    subtype: "MOT TEST CERTIFICATE",
    dates: [
      "Expiry date: 28 August 2026",
      "Issued: 29 August 2025 at Hartswood Garage",
    ],
  },
  "boiler-service-invoice.pdf": {
    provider: "Supplier: British Gas",
    reference: "Invoice ref: INV-88213",
    subtype: "INVOICE — ANNUAL BOILER SERVICE",
    cost: { amount: "120.00", needle: "Amount due: £120.00" },
    dates: [
      "Service completed 04.09.2025.",
      "Next service due 04.09.2026.",
    ],
  },
  "car-insurance-renewal.pdf": {
    provider: "Your insurer: Shield Motor Insurance",
    reference: "Your reference: SM-2291-X",
    subtype: "Your car insurance is due for renewal on September 14, 2026.",
    cost: { amount: "642.18", needle: "Annual premium £642.18" },
    dates: [
      "Your car insurance is due for renewal on September 14, 2026.",
    ],
  },
  "energy-bill.pdf": {
    reference: "Account no: 300481292",
    subtype: "ENERGY STATEMENT",
    cost: { amount: "163.90", needle: "Total: £163.90" },
    dates: [
      "Billing period 2026-06-01 to 30/06/2026",
      "Billing period 2026-06-01 to 30/06/2026",
      "Payment due by 21/07/2026",
    ],
  },
  "warranty-dishwasher.pdf": {
    subtype: "WARRANTY CERTIFICATE",
    dates: [
      "Warranty valid until 3rd March 2027.",
    ],
  },
  "tv-licence.pdf": {
    reference: "Licence number: TVL-04482913",
    subtype: "Your TV Licence",
    cost: { amount: "169.50", needle: "A colour licence costs £169.50 a year." },
    dates: [
      "Expires: 30 Nov 2026",
    ],
  },
  "home-emergency-cover.pdf": {
    reference: "Quote reference HS-77120 when you call.",
    dates: [
      "Your cover began on\n12 January 2026 and runs until 11 January 2027 unless renewed.",
      "Your cover began on\n12 January 2026 and runs until 11 January 2027 unless renewed.",
    ],
  },
  "chimney-sweep-receipt.pdf": {
    cost: { amount: "90", needle: "J. Marsh & Son. 12/10/2025. £90 cash." },
    dates: [
      "J. Marsh & Son. 12/10/2025. £90 cash.",
    ],
  },
  "council-tax.pdf": {
    reference: "Account reference: 55018824",
    subtype: "COUNCIL TAX DEMAND 2026/27",
    dates: [
      "First instalment due 01/04/2026, final instalment 01/01/2027.",
      "First instalment due 01/04/2026, final instalment 01/01/2027.",
    ],
  },
  "pet-insurance.pdf": {
    provider: "Insurer - PawGuard",
    reference: "Policy no. PG881122",
    subtype: "PET INSURANCE CERTIFICATE",
    dates: [
      "Cover start 15/02/2026 — renews automatically 15/02/2027",
      "Cover start 15/02/2026 — renews automatically 15/02/2027",
    ],
  },
  "smoke-alarm-manual.pdf": {},
  "water-statement.pdf": {
    provider: "Provider: Clearspring Water Ltd",
    reference: "Account number: CW-0099-4471",
    subtype: "CLEARSPRING WATER — STATEMENT OF ACCOUNT",
    dates: [
      "Charges for the period 2026-04-01 to 2027-03-31.",
      "Charges for the period 2026-04-01 to 2027-03-31.",
      "Your next statement is due 2026-10-01. Balance carried forward £0.00.",
    ],
  },
  "mot-reminder.pdf": {
    provider: "Sent 12 August 2026 by Hartswood Garage Services, Westhaven.",
    dates: [
      "Sent 12 August 2026 by Hartswood Garage Services, Westhaven.",
      "Our records show your vehicle was last tested on 28 August 2025.",
      "The certificate on file expires 28 August 2026. Book early to avoid a lapse.",
    ],
  },
  "council-tax-demand.pdf": {
    provider: "BOROUGH OF WESTHAVEN",
    reference: "Council tax reference 8802 5514 9",
    subtype: "COUNCIL TAX DEMAND NOTICE 2027/28",
    dates: [
      "Issued 09 March 2027",
      "Ten instalments are payable from 1 April 2027 to 1 January 2028.",
      "Ten instalments are payable from 1 April 2027 to 1 January 2028.",
    ],
  },
  "broadband-agreement.pdf": {
    provider: "Supplier: Northgate Fibre Ltd",
    reference: "Customer account 4471-8820-3390",
    subtype: "NORTHGATE FIBRE — SERVICE AGREEMENT",
    dates: [
      "Service start date 2 October 2026. Minimum term ends 31-03-2028.",
      "Service start date 2 October 2026. Minimum term ends 31-03-2028.",
    ],
  },
  "life-cover-statement.pdf": {
    provider: "Provider: Acorn Mutual Assurance Society",
    reference: "Plan number LC/2291/443",
    subtype: "ACORN MUTUAL — LIFE COVER STATEMENT",
    dates: [
      "Your plan started on 06/05/24 and the premium is fixed for life.",
      "The next annual review is 6 May 2027.",
    ],
  },
  "buildings-renewal.pdf": {
    provider: "Insurer: Northern Shire Mutual Insurance Society",
    reference: "Policy: NSM 44/22910",
    subtype: "NORTHERN SHIRE MUTUAL — BUILDINGS COVER",
    cost: {
      amount: "412.00",
      needle: "from 22 Feb 2027 for a further twelve months at £412.00.",
    },
    dates: [
      "Quotation prepared 04 Feb 2027",
      "Your current policy expires 21 Feb 2027. If you do nothing we will renew it\nfrom 22 Feb 2027 for a further twelve months at £412.00.",
      "Your current policy expires 21 Feb 2027. If you do nothing we will renew it\nfrom 22 Feb 2027 for a further twelve months at £412.00.",
    ],
  },
  "thermostat-quick-start.pdf": {},
  "gym-membership.pdf": {
    provider: "Provider: Riverbank Leisure Club",
    reference: "Membership number: RLC-7781-22",
    subtype: "RIVERBANK LEISURE CLUB — MEMBERSHIP AGREEMENT",
    dates: [
      "Signed at the club on 24 September 2026.",
      "Your twelve-month membership begins on the 1st of October 2026 and ends on\nthe 30th of September 2027. One calendar month's notice applies.",
      "Your twelve-month membership begins on the 1st of October 2026 and ends on\nthe 30th of September 2027. One calendar month's notice applies.",
    ],
  },
  "contents-renewal-invitation.pdf": {
    provider: "Insurer: Kestrel Mutual (administered by Faircross Broking Ltd)",
    reference: "Policy number 88-2291-KM",
    subtype: "RENEWAL INVITATION — CONTENTS INSURANCE",
    cost: { amount: "318.40", needle: "Please check your details before 23 September 2026. New premium £318.40." },
    dates: [
      "Your cover ends on 30-09-2026 and the new policy year starts 01-10-2026.",
      "Your cover ends on 30-09-2026 and the new policy year starts 01-10-2026.",
      "Please check your details before 23 September 2026. New premium £318.40.",
    ],
  },
  "roofing-agreement.pdf": {
    provider: "Supplier: Fairweather Roofing Ltd",
    reference: "Agreement reference FR/2026/0418",
    subtype: "FAIRWEATHER ROOFING — MAINTENANCE AGREEMENT",
    dates: [
      "Signed 18 April 2026 at Westhaven.",
      "Annual inspection due 2026/07/15, with a second visit on 2027/01/20 if the\nfirst identifies work.",
      "Annual inspection due 2026/07/15, with a second visit on 2027/01/20 if the\nfirst identifies work.",
    ],
  },
  "dental-plan.pdf": {
    provider: "Provider: Brightmoor Dental Care Ltd",
    reference: "Membership number: BDC-771244",
    subtype: "BRIGHTMOOR DENTAL PLAN",
    cost: { amount: "18.50", needle: "Payments of £18.50 are collected on the 1st of each month." },
    dates: [
      "Your plan renews on 1 December 2026.",
    ],
  },
  "holdout-buildings-contents-schedule.pdf": {
    provider: "Larkfield Mutual Insurance",
    reference: "Policy LKM/44-12-8890",
    subtype: "SCHEDULE OF INSURANCE — BUILDINGS AND CONTENTS",
    cost: {
      amount: "412.66",
      needle: "Premium         £412.66, payable as 12 monthly instalments of £34.39",
    },
    dates: [
      "Cover starts    1 February 2026",
      "Cover ends      31 January 2027",
    ],
  },
  "holdout-mot-certificate.pdf": {
    provider: "Issued by Cobbledown Motors, VTS 74129",
    reference: "Test number         4471 8802 5590",
    subtype: "MOT TEST CERTIFICATE                                          VT20",
    dates: [
      "Test date           14.02.2026",
      "Expiry date         13.02.2027",
    ],
  },
  "holdout-council-tax.pdf": {
    provider: "MELBURY BOROUGH COUNCIL",
    reference: "Account number   MB-8827441",
    subtype: "Council Tax Demand Notice 2026/27",
    cost: { amount: "1,381.62", needle: "Amount to pay                                              £1,381.62" },
    dates: [
      "Date of issue    12 March 2026",
      "Charge for the period 1 April 2026 to 31 March 2027         £1,842.15",
      "Charge for the period 1 April 2026 to 31 March 2027         £1,842.15",
      "Payable by 10 monthly instalments. The first instalment is due on\n1 April 2026 and the final instalment is due on 1 January 2027.",
    ],
  },
  "holdout-broadband-order.pdf": {
    provider: "Ferngate Broadband",
    reference: "Account number  FG 5512 8830 41",
    subtype: "Your package    Ferngate Fibre 500 with unlimited calls",
    cost: { amount: "38.00", needle: "Monthly price   £38.00 for the first 18 months, then our standard price" },
    dates: [
      "We'll switch you over on the 3rd of June 2026. Your new router should\narrive a couple of days before that, and there is nothing you need to do\non the day.",
      "Prices change each April in line with inflation plus 3.9%. The first\nchange will apply from 1 April 2027.",
      "Your 14-day cancellation period runs from the day you placed the order,\n27 May 2026.",
    ],
  },
  "holdout-water-bill.pdf": {
    provider: "WEXLEY WATER",
    reference: "Customer   Ms A Quilliam                 Account 55 214 887 3",
    cost: { amount: "389.46", needle: "Total now due                                            £389.46" },
    dates: [
      "Charges for the period 3 December 2025 to 4 June 2026",
      "Charges for the period 3 December 2025 to 4 June 2026",
      "Please pay by 30/06/26. If you pay by Direct Debit we will collect on or\njust after 15/07/26.",
      "Please pay by 30/06/26. If you pay by Direct Debit we will collect on or\njust after 15/07/26.",
    ],
  },
  "holdout-gas-safety-record.pdf": {
    provider: "ASHCOMBE GAS SERVICES — GAS SAFETY RECORD",
    reference: "Certificate no. AGS-2026-0442",
    subtype: "ASHCOMBE GAS SERVICES — GAS SAFETY RECORD",
    recurrence: { months: 12, needle: "Next inspection due within 12 months of the date above." },
    dates: [
      "Inspected    9 September 2026",
    ],
  },
  "holdout-appliance-warranty.pdf": {
    provider: "MARROW & FINCH",
    reference: "Plan reference   W-0099-2841",
    subtype: "Extended warranty confirmation",
    dates: [
      "Purchased        2026/03/09 at our Northmoor store",
      "Cover            5 years parts and labour, expiring 2031/03/08",
    ],
  },
  "holdout-pet-insurance-renewal.pdf": {
    provider: "Pinfold Pet Insurance",
    reference: "Policy number 8841-QP-77",
    cost: {
      amount: "31.44",
      needle: "Your new premium is £31.44 a month, up from £28.90. We have written to\nyou at least 21 days before renewal, as the rules require.",
    },
    dates: [
      "Your policy for Biscuit (Border Terrier) is due to renew on 1st October\n2026. Cover under your current policy ends at midnight on 30th September\n2026.",
      "Your policy for Biscuit (Border Terrier) is due to renew on 1st October\n2026. Cover under your current policy ends at midnight on 30th September\n2026.",
      "If you would rather not renew, tell us before 24 September 2026.",
    ],
  },
  "holdout-mobile-airtime.pdf": {
    provider: "QUILLET MOBILE",
    reference: "Account\nnumber           QM-4471-0088-2",
    subtype: "Airtime plan summary",
    dates: [
      "Plan started     18\nAugust 2025",
      "Minimum term ends 17 August 2027",
    ],
  },
  "holdout-tariff-label.pdf": {
    provider: "TRELLIS ENERGY — TARIFF INFORMATION LABEL",
    subtype: "Tariff name             Trellis Fixed Saver",
  },
  "holdout-structural-warranty.pdf": {
    provider: "STONEPATH STRUCTURAL GUARANTEES LIMITED",
    reference: "Certificate number   SP/NH/118420",
    subtype: "Certificate of Insurance — New Home Warranty",
    dates: [
      "Structural insurance period   20 May 2024 to 20 May 2034",
      "Structural insurance period   20 May 2024 to 20 May 2034",
    ],
  },
  "holdout-heating-plan.pdf": {
    provider: "Halverston Home Cover",
    reference: "Plan number      HHC 60 4471 22",
    subtype: "Boiler and heating plan — annual statement",
    cost: { amount: "26.50", needle: "Monthly payment  £26.50, collected on or around the 4th" },
    dates: [
      "Plan year        01 Jul 26 – 30 Jun 27",
      "Plan year        01 Jul 26 – 30 Jun 27",
      "Last year's visit: an engineer attended on Thu 11 Sep 2025 and passed the\nboiler as serviced. This year's service is not yet booked — book online\nor call us.",
      "We wrote to you about this plan on 03 June 2026.",
    ],
  },
  "holdout-imported-warranty-card.pdf": {
    provider: "VANTERRA APPLIANCES",
    reference: "Registration ref   VA-UK-778120",
    subtype: "Limited warranty card (UK edition)",
    dates: [
      "Date of purchase   03/15/2026  (mm/dd/yyyy)",
      "Warranty expires   03/15/2028  (mm/dd/yyyy)",
    ],
  },
};

describe("an ideal model's reply survives modelProposalFromText's grounding and validation (#965)", () => {
  for (const doc of EXTRACTION_CORPUS) {
    it(`grounds every expected field of "${doc.name}" (${doc.filename})`, async () => {
      const evidence = EVIDENCE[doc.filename];
      if (!evidence) {
        throw new Error(`[${doc.filename}] no EVIDENCE table entry -- add one`);
      }
      const normalizedText = safeDocumentEvidence(doc.text, INPUT_CHARACTER_BUDGET);
      const generated: Record<string, unknown> = {};

      if (doc.expected.provider !== undefined) {
        if (!evidence.provider) throw new Error(`[${doc.filename}] expected.provider set but no evidence.provider needle`);
        generated.provider = { value: doc.expected.provider, evidence: span(doc.filename, evidence.provider, normalizedText) };
      }
      if (doc.expected.reference !== undefined) {
        if (!evidence.reference) throw new Error(`[${doc.filename}] expected.reference set but no evidence.reference needle`);
        generated.reference = { value: doc.expected.reference, evidence: span(doc.filename, evidence.reference, normalizedText) };
      }
      if (doc.expected.subtype !== undefined) {
        if (!evidence.subtype) throw new Error(`[${doc.filename}] expected.subtype set but no evidence.subtype needle`);
        generated.subtype = { value: doc.expected.subtype, evidence: span(doc.filename, evidence.subtype, normalizedText) };
      }
      if (doc.expected.costMinor !== undefined) {
        if (!evidence.cost) throw new Error(`[${doc.filename}] expected.costMinor set but no evidence.cost needle`);
        generated.cost = { amount: evidence.cost.amount, evidence: span(doc.filename, evidence.cost.needle, normalizedText) };
      }
      if (doc.expected.recurrenceMonths !== undefined) {
        if (!evidence.recurrence) throw new Error(`[${doc.filename}] expected.recurrenceMonths set but no evidence.recurrence needle`);
        generated.recurrenceMonths = {
          months: evidence.recurrence.months,
          evidence: span(doc.filename, evidence.recurrence.needle, normalizedText),
        };
      }
      if (doc.expected.dateRoles?.length) {
        if (!evidence.dates || evidence.dates.length !== doc.expected.dateRoles.length) {
          throw new Error(`[${doc.filename}] evidence.dates length does not match expected.dateRoles length`);
        }
        generated.dates = doc.expected.dateRoles.map((role, index) => ({
          date: role.date,
          role: role.role,
          evidence: span(doc.filename, evidence.dates![index], normalizedText),
        }));
      }

      const transport = transportReturning(replyOf(envelopeOf(generated)));
      const result = await modelProposalFromText(doc.text, doc.filename, {
        environment: MODEL_ENVIRONMENT,
        transport,
      });

      expect(
        result.status,
        `[${doc.filename}] a schema-conforming, fully grounded reply must not fail whole: ${JSON.stringify(result)}`,
      ).toBe("ready");
      if (result.status !== "ready") return;
      const { proposal } = result;

      const mismatches: string[] = [];

      function textFieldDiagnosis(value: string, evidenceSpan: string): string {
        return comparableText(evidenceSpan).includes(comparableText(value))
          ? "its evidence span quotes the value; the drop happened downstream in safeStoredDocumentProposal (bounds, markup or length), not in grounding"
          : `its evidence span (${JSON.stringify(evidenceSpan)}) does not literally quote the value -- a bug in this test's needle, not a validation finding`;
      }

      if (doc.expected.provider !== undefined && proposal.provider !== doc.expected.provider) {
        const evidenceSpan = (generated.provider as { evidence: string }).evidence;
        mismatches.push(
          `provider: expected ${JSON.stringify(doc.expected.provider)}, got ${JSON.stringify(proposal.provider)} -- ` +
          textFieldDiagnosis(doc.expected.provider, evidenceSpan),
        );
      }
      if (doc.expected.reference !== undefined && proposal.reference !== doc.expected.reference) {
        const evidenceSpan = (generated.reference as { evidence: string }).evidence;
        mismatches.push(
          `reference: expected ${JSON.stringify(doc.expected.reference)}, got ${JSON.stringify(proposal.reference)} -- ` +
          textFieldDiagnosis(doc.expected.reference, evidenceSpan),
        );
      }
      if (doc.expected.subtype !== undefined && proposal.subtype !== doc.expected.subtype) {
        const evidenceSpan = (generated.subtype as { evidence: string }).evidence;
        mismatches.push(
          `subtype: expected ${JSON.stringify(doc.expected.subtype)}, got ${JSON.stringify(proposal.subtype)} -- ` +
          textFieldDiagnosis(doc.expected.subtype, evidenceSpan),
        );
      }
      if (doc.expected.costMinor !== undefined &&
        (proposal.costMinor !== doc.expected.costMinor || proposal.currency !== doc.expected.currency)) {
        const costCandidate = generated.cost as { amount: string; evidence: string };
        const hasDigits = costCandidate.evidence.includes(costCandidate.amount);
        const hasCurrency = /[£$€]/u.test(costCandidate.evidence) || /\b(GBP|USD|EUR)\b/u.test(costCandidate.evidence.toUpperCase());
        const reason = !hasDigits
          ? `its evidence span does not contain the printed amount "${costCandidate.amount}" -- a bug in this test's needle`
          : !hasCurrency
          ? "its evidence span carries no currency symbol or code, so the cost check refuses it"
          : "amount and currency are both present in the span; the drop happened elsewhere (a bounds check, or the amount format did not match the printed-amount pattern)";
        mismatches.push(
          `cost: expected costMinor=${doc.expected.costMinor} currency=${doc.expected.currency}, ` +
          `got costMinor=${proposal.costMinor} currency=${proposal.currency} -- ${reason}`,
        );
      }
      if (doc.expected.recurrenceMonths !== undefined && proposal.recurrenceMonths !== doc.expected.recurrenceMonths) {
        const recCandidate = generated.recurrenceMonths as { months: number; evidence: string };
        const hasDigits = recCandidate.evidence.includes(String(recCandidate.months));
        const reason = hasDigits
          ? "digits are present in the span; the drop happened elsewhere (bounds, or no schedule date for it to attach to)"
          : "its evidence span does not contain the month count in digits -- a bug in this test's needle";
        mismatches.push(
          `recurrenceMonths: expected ${doc.expected.recurrenceMonths}, got ${proposal.recurrenceMonths} -- ${reason}`,
        );
      }

      const expectedDates = [...doc.expected.dates].sort();
      const actualDates = [...proposal.dates].sort();
      if (JSON.stringify(actualDates) !== JSON.stringify(expectedDates)) {
        mismatches.push(
          `dates: expected ${JSON.stringify(expectedDates)}, got ${JSON.stringify(actualDates)} -- ` +
          "a date reported with a known role and a grounded span should only be dropped for an invalid calendar date",
        );
      }
      if (doc.expected.dateRoles?.length) {
        const expectedRoles = doc.expected.dateRoles.map((r) => `${r.date}:${r.role}`).sort();
        const actualRoles = (proposal.dateRoles ?? []).map((r) => `${r.date}:${r.role}`).sort();
        if (JSON.stringify(actualRoles) !== JSON.stringify(expectedRoles)) {
          mismatches.push(`dateRoles: expected ${JSON.stringify(expectedRoles)}, got ${JSON.stringify(actualRoles)}`);
        }
      }

      expect(mismatches, `[${doc.name} / ${doc.filename}] field(s) an ideal reply supplied did not survive`).toEqual([]);
    });
  }
});
