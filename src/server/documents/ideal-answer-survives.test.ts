import { describe, expect, it } from "vitest";
import { EXTRACTION_CORPUS, type SubtypeSpec } from "./extraction-corpus";
import { classifySubtype, isSubtypeSpec, subtypeAnswers } from "./extraction-scoring";
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

/** A model reply can only offer one phrase. Ground truth may accept several
 * (a literal set, #989/#992) or name taxonomy groups instead of phrases
 * (#989). For the object form, an "ideal" reply still has to be one this
 * test can ground: given the document's own text, prefer whichever accepted
 * phrase (kind, qualifier, or their combination) is actually printed on the
 * page, and fall back to the first synonym of the first listed kind only
 * when nothing in the accepted set is -- which happens for a document whose
 * subtype is deliberately never spelled out (see SUBTYPE_NOT_GROUNDABLE). */
function firstSubtypePhrase(expected: string | string[] | SubtypeSpec, groundingText?: string): string {
  if (isSubtypeSpec(expected)) {
    if (groundingText !== undefined) {
      const haystack = groundingText.toLowerCase();
      for (const candidate of subtypeAnswers(expected)) {
        const escaped = candidate.toLowerCase().replace(/[.*+?^${}()|[\]\\]/gu, "\\$&");
        if (new RegExp(`\\b${escaped}\\b`, "u").test(haystack)) return candidate;
      }
    }
    return subtypeAnswers({ kinds: [expected.kinds[0]] })[0];
  }
  return Array.isArray(expected) ? expected[0] : expected;
}

/** Two documents whose object-form subtype has no accepted taxonomy phrase
 * -- kind, qualifier, or any combination of them -- printed anywhere on the
 * page, by design: #989 ruled that a kind such as "Insurance" need not be
 * printed at all, and a document must not explain its own trap. No model,
 * however good, could ground this one field there, so it is excluded from
 * the assertions below for these two filenames only; every other field on
 * both documents is still checked in full. */
const SUBTYPE_NOT_GROUNDABLE = new Set([
  "fullpage-satellite-tv-subscription-invoice.pdf",
  "fullpage-self-storage-agreement.pdf",
]);

/** Four fixed-term contracts whose cost truth is the total over the term
 * (owner, 2026-09-13: Orbit tracks the whole commitment) but whose page
 * prints only the monthly price and the term, never the product. An ideal
 * model can quote the two factors but no span contains the amount, so the
 * cost assertion is skipped for these filenames; every other field is still
 * checked in full. */
const COST_NOT_PRINTED = new Set([
  "fullpage-broadband-contract.pdf",
  "fullpage-car-lease-statement.pdf",
  "fullpage-gym-membership-agreement.pdf",
  "fullpage-mobile-airtime-plan.pdf",
]);

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
  "alarm-monitoring-agreement.pdf": {
    provider: "Intruder Alarm Monitoring Agreement NORTHGATE HOME SECURITY Unit 6, Foundry Business Park, Elmscote, EL4 2RJ · 01632 960377 ·",
    reference: "Elmscote, EL5 8HN Contract Number NGS-CA-20456 Engineer D. Sutton — commissioning visit 28/02/2026 Monitoring Start",
    subtype: "17 Peartree Close, Elmscote, EL5 8HN Contract Number NGS-CA-20456 Engineer D. Sutton — commissioning visit 28/02/2026",
    cost: { amount: "599.76", needle: "the minimum term stated, giving a total payable over the 24 month minimum term of £599.76. Northgate Home Security will notify" },
    recurrence: { months: 24, needle: "28/02/2026 Monitoring Start Date 02/03/2026 Minimum Term 24 month minimum term, ending 01/03/2028 Annual" },
    dates: [
      "commissioning visit 28/02/2026 Monitoring Start Date 02/03/2026 Minimum Term 24 month",
      "term, ending 01/03/2028 Annual Maintenance Visit Due 02/03/2027 Monthly Monitoring",
      "02/03/2026 Minimum Term 24 month minimum term, ending 01/03/2028 Annual Maintenance Visit",
    ],
  },
  "fullpage-appliance-warranty-certificate.pdf": {
    provider: "on behalf of the retailer by Bellward Warranty Administration Ltd of Norwich, and underwritten by Corvane Insurance plc, authorised and",
    reference: "WARRANTY CERTIFICATE Certificate No. EWC-2025-118823 This is to certify that the appliance described below, purchased from",
    subtype: "Extended Warranty Certificate — Ashfield Domestic Appliances ASHFIELD DOMESTIC APPLIANCES",
    cost: { amount: "69.99", needle: "APPLIANCE £549.99 MANUFACTURER'S GUARANTEE 12 months parts & labour, ends 13 June 2026 EXTENDED WARRANTY PRICE PAID £69.99 (inc. IPT) EXCESS" },
    dates: [
      "and below, for a period of five years, commencing on 14 June 2026 and expiring on 13 June",
      "years, commencing on 14 June 2026 and expiring on 13 June 2031. Authorised signatory,",
    ],
  },
  "boiler-service-plan-letter.pdf": {
    subtype: "Boiler Service Plan Letter HEARTHWELL HOME CARE BO I L ER & CONTROLS COVER Plan reference: HHC-4471-2298 Account no: 3300 5521 Date of this",
    provider: "Boiler Service Plan Letter HEARTHWELL HOME CARE BO I L ER & CONTROLS COVER Plan reference: HHC-4471-2298 Account no:",
    reference: "L ER & CONTROLS COVER Plan reference: HHC-4471-2298 Account no: 3300 5521 Date of this letter: 2 September 2026 Mr J.",
    cost: { amount: "179.88", needle: "NEXT SERVICE DUE 14/10/2026 THIS MONTH 'S INSTALMENT £14.99 ANNUAL TOTAL IF PAID MONTHLY £179.88" },
    recurrence: { months: 12, needle: "Care plan, your boiler and controls are serviced every 12 months. Our records show that your next" },
    dates: [
      "Our records show that your next service is due on 14 October 2026. One of our Gas Safe",
    ],
  },
  "fullpage-breakdown-cover-renewal.pdf": {
    provider: "Milldown Motoring Club — Your Breakdown Cover Renewal MILLDOWN MOTORING CLUB Your breakdown",
    reference: "Prepared 2 September 2026 Membership MDC-4471-8823 THIS OFFER ENDS 30 SEPTEMBER 2026 Renew now and keep last year's",
    subtype: "as at 28 August 2026 and include Insurance Premium Tax where applicable. Prices may change at your next renewal.",
    cost: { amount: "84.99", needle: "LINE AND KEEP THIS CARD IN YOUR GLOVEBOX Choose your cover for the year ahead Your current cover Roadside Assist £84.99 per year · you paid" },
    recurrence: { months: 12, needle: "TO 04/11/2026 24HR: 0330 555 0198 Roadside & Recovery £129.99 or £11.99 a month Save £30 — renew" },
    dates: [
      "J. ASHWORTH MDC 4471 8823 MEMBER SINCE 2018 VALID TO 04/11/2026 24HR: 0330 555 0198",
    ],
  },
  "fullpage-broadband-contract.pdf": {
    provider: "Kestrel Broadband — Contract Summary and Terms Kestrel Broadband Contract Summary Order",
    reference: "number KB-771049-3 Order reference ORD-2026-0417726 Billing address Flat 2, 9 Thornfield Close, Marlcombe, Warwickshire,",
    subtype: "Kestrel Broadband — Contract Summary and Terms Kestrel Broadband Contract Summary Order date 14",
    cost: { amount: "839.76", needle: "2026 24-Month Fibre & Phone Contract Key contract information — Ofcom-format summary MONTHLY PRICE, MINIMUM TERM £34.99 per month, includes line" },
    recurrence: { months: 24, needle: "SPEED 502 Mbps average upload speed 74 Mbps MINIMUM TERM 24 months ends 21 April 2028 CUSTOMER AND" },
    dates: [
      "Warwickshire, CV9 7QL Service start (activation) 22 April 2026 Minimum term 24 months",
      "upload speed 74 Mbps MINIMUM TERM 24 months ends 21 April 2028 CUSTOMER AND ACCOUNT",
    ],
  },
  "car-finance-agreement.pdf": {
    subtype: "Personal Contract Purchase Agreement PERSONAL CONTRACT PURCHASE AGREEMENT Regulated by the Consumer Credit Act 1974 Agreement date: 20 February 2026",
    provider: "BVF-PCP-208841 CREDITOR (LENDER) Bracken Vale Finance plc 1 Millrace House, Doverton DV4 7QS Company number 04471822 Authorised",
    reference: "20 February 2026 Agreement number BVF-PCP-208841 CREDITOR (LENDER) Bracken Vale Finance plc 1 Millrace House, Doverton",
    cost: { amount: "24,730.16", needle: "Optional final payment (due 5 March 2030) £8,245.00 Total amount payable £24,730.16 Option-to-purchase fee (payable with final payment) £10.00" },
    recurrence: { months: 48, needle: "Duration of agreement 49 months Number of monthly payments 48 Amount of each monthly payment £279.42" },
    dates: [
      "by the Consumer Credit Act 1974 Agreement date: 20 February 2026 Agreement number",
      "first payment 05/04/2026 Optional final payment (due 5 March 2030) £8,245.00 Total amount",
    ],
  },
  "fullpage-car-insurance-renewal.pdf": {
    provider: "renewal — policy MTR-8823-0145 Colworth & Drake Insurance Services Ltd — policy administration Document RNW/MTR/0926 — Page 1 of 3 COLWORTH &",
    reference: "Your motor insurance renewal — policy MTR-8823-0145 Colworth & Drake Insurance Services Ltd — policy administration",
    subtype: "Your motor insurance renewal — policy MTR-8823-0145 Colworth & Drake Insurance Services Ltd",
    cost: { amount: "612.40", needle: "you will need to arrange new insurance before driving the vehicle. YOUR RENEWAL PREMIUM ANNUAL PREMIUM, PAID IN FULL £612.40 Net premium £546.79 +" },
    dates: [
      "2018 Current period of insurance 15 October 2025 to 15 October 2026 Renewal period offered",
      "2026 Renewal period offered 15 October 2026 to 15 October 2027 No claims discount 7",
    ],
  },
  "fullpage-car-lease-statement.pdf": {
    provider: "which the vehicle must be returned to Wraxall Vehicle Finance plc; this is a hire agreement and you do not own the vehicle at any point.",
    reference: "Lease statement WVF-PCH-220154 DriveEasy Leasing Personal contract hire brokers · 0800 552 7734 ·",
    subtype: "Lease statement WVF-PCH-220154 DriveEasy Leasing Personal contract hire",
    cost: { amount: "11,844.00", needle: "MONTHLY RENTAL £329.00 PAYMENT HISTORY, YEAR 2" },
    dates: [
      "hybrid estate, registration LV73 KFM Agreement start 1 June 2025 Agreement end 31 May",
      "LV73 KFM Agreement start 1 June 2025 Agreement end 31 May 2028 Contract mileage 10,000",
    ],
  },
  "fullpage-cavity-wall-insulation-guarantee.pdf": {
    provider: "Insulation\" is a trading name of Bassington Energy Solutions Ltd, registered in England and Wales No. 06612940, registered office 4",
    reference: "Guarantee certificate WC-GTE-08823 WarmCore Insulation Cavity wall & loft insulation specialists · est.",
    subtype: "Guarantee certificate WC-GTE-08823 WarmCore Insulation Cavity wall & loft",
    cost: { amount: "2,340.00", needle: "confirmed by borescope survey 28 April 2026 Guarantee period 25 years, from 12 May 2026 to 12 May 2051 Contract price £2,340.00, paid in full 12 May" },
    dates: [
      "Job reference WCI-2026-4471 Date of installation 12 May 2026 Certificate issued 19",
      "2026 Guarantee period 25 years, from 12 May 2026 to 12 May 2051 Contract price",
    ],
  },
  "fullpage-chimney-sweep-certificate.pdf": {
    provider: "Chimney sweep certificate CSS-0417 CSS Chimney and flue sweeping, servicing wood and multi-fuel",
    reference: "Chimney sweep certificate CSS-0417 CSS Chimney and flue sweeping, servicing wood and multi-fuel appliances",
    subtype: "Chimney sweep certificate CSS-0417 CSS Chimney and flue sweeping, servicing wood and multi-fuel",
    cost: { amount: "65.00", needle: "on 18 November 2025, which is a separate visit from a sweep and does not replace one. Fee charged for this visit: £65.00, paid by card on the" },
    dates: [
      "Cravenshire CV2 4RD Certificate CSS-0417 Date swept 1 September 2026 Previous sweep 3 March",
      "2026 Previous sweep 3 March 2026 Next sweep due 1 March 2027 APPLIANCE DETAILS Item",
    ],
  },
  "fullpage-council-tax-demand.pdf": {
    provider: "Precepting authority 2025/26 2026/27 Calderhythe District Council (district services) £298.61 £312.44 Wealdshire County Council £1,412.87",
    reference: "Pemberton COUNCIL TAX ACCOUNT NUMBER 8845612033 PROPERTY CHARGED 14 Sedge Close Marlpool Calderhythe CH3 7QD Valuation",
    subtype: "Council Tax Demand Notice 2026/27 C ALDE RHYTHE COUNCIL TAX — BILLING AUTHORITY",
    cost: { amount: "2,159.07", needle: "Rescue Authority £78.04 £81.33 Marlpool Parish Council £39.80 £42.10 Total council tax charge for the year £2,056.30 £2,159.07 Pay by ten monthly" },
    recurrence: { months: 12, needle: "person(s) Mr D. Pemberton COUNCIL TAX ACCOUNT NUMBER 8845612033 PROPERTY CHARGED 14 Sedge Close" },
    dates: [
      "COUNCIL TAX DEMAND NOTICE Charge for the year 1 April 2026 to 31 March 2027 Notice",
      "TAX DEMAND NOTICE Charge for the year 1 April 2026 to 31 March 2027 Notice issued 10 March",
    ],
  },
  "critical-illness-quote.pdf": {
    provider: "illness quotation prepared for you by Amberleigh Financial Advisers Ltd Amberleigh Financial Advisers Ltd — Quote AMB-CI-2026-77410 Page 1 of 2",
    reference: "Netherbourne NB6 5DA Quote reference: AMB-CI-2026-77410 Quote date: 6 October 2026 Valid until: 6 November 2026 Cover",
    subtype: "12 Fenwick Road, Netherbourne NB6 5DA Quote reference: AMB-CI-2026-77410 Quote date: 6 October 2026 Valid until: 6",
    cost: { amount: "10,386.00", needle: "Based on a 25-year term, total premiums payable under Option B would be £10,386.00, with cover ending in 2051." },
    dates: [
      "5DA Quote reference: AMB-CI-2026-77410 Quote date: 6 October 2026 Valid until: 6 November",
      "Quote date: 6 October 2026 Valid until: 6 November 2026 Cover underwritten by",
    ],
  },
  "fullpage-dental-plan-statement.pdf": {
    provider: "and administered on its behalf by Northgate Dental Plan Administration Ltd, PO Box 1156, Newbury Park, NP3 9ZZ, company number 04471102. The",
    reference: "14 August 2026 · Membership number NDPA-208467 Plan Aldermoor Complete Care Plan Plan start date 1 March 2020 Monthly",
    subtype: "Annual Plan Statement — Aldermoor Complete Care Plan Aldermoor Dental Practice 14",
    cost: { amount: "114.00", needle: "2026 · Membership number NDPA-208467 Plan Aldermoor Complete Care Plan Plan start date 1 March 2020 Monthly payment £9.50 Plan year value £114.00" },
    recurrence: { months: 12, needle: "taken every month by Direct Debit. Your plan year runs for 12 months from your start date shown above, and" },
    dates: [
      "Next payment due 1 September 2026 Plan renewal date 1 March 2027 Last check-up 12 May",
    ],
  },
  "domain-hosting-renewal.pdf": {
    provider: "Foxglove Hosting — Domain Renewal",
    reference: "Account number ACC-3348217 Domain brindlewood-supplies.example Domain ID D4471982-EXPL Registered",
    subtype: "Foxglove Hosting — Domain Renewal",
    cost: { amount: "15.59", needle: "Renew now Order Summary Domain renewal (12 months) £12.99 VAT (20%) £2.60 Total due today £15.59 Invoice INV-2027-004471 will be issued once" },
    recurrence: { months: 12, needle: "on 18 January 2027 Renewal period This domain renews every 12 months. Auto-renew On Nameservers" },
    dates: [
      "Domain ID D4471982-EXPL Registered on 18 January 2019 Renews on 18 January",
      "D4471982-EXPL Registered on 18 January 2019 Renews on 18 January 2027 Renewal period This",
    ],
  },
  "fullpage-driving-lessons-invoice.pdf": {
    subtype: "Driving lessons invoice PL-INV-2249 C. Lewis Approved Driving Instructor, ADI badge no. 449213 · bookings@pass2drive.co.uk · www.pass2drive.co.uk ·",
    provider: "ADI badge no. 449213 · bookings@pass2drive.co.uk · www.pass2drive.co.uk · 07700 900412 Invoice for driving lessons",
    reference: "Driving lessons invoice PL-INV-2249 C. Lewis Approved Driving Instructor, ADI badge no. 449213 ·",
    cost: { amount: "360.00", needle: "1-hour lessons, paid up front 360.00 Total paid, received 2 September 2026 £360.00 Thanks for booking" },
    dates: [
      "Cravenshire CV9 3TL Invoice PL-INV-2249 Invoice date 2 September 2026 Pick-up point: Penbury",
      "from this block must be used within 6 months, by 2 March 2027, after which any unused",
    ],
  },
  "fullpage-electrical-condition-report.pdf": {
    provider: "· ISSUE 6 No. EICR-2026-071842 Thornleigh Electrical Contractors Ltd Page 1 of 12 ELECTRICAL INSTALLATION CONDITION REPORT for a domestic",
    reference: "Installation Condition Report — EICR-2026-071842 NATIONAL ELECTRICAL INSTALLERS REGISTER — DOMESTIC ELECTRICAL",
    subtype: "SECTION D — PURPOSE AND EXTENT OF THE INSPECTION PURPOSE OF REPORT Change of tenancy — periodic condition report",
    recurrence: { months: 60, needle: "further inspected and tested at an interval not exceeding 60 months from the date of this inspection, or" },
    dates: [
      "REF. INS-22841 DATE(S) OF INSPECTION AND TESTING 02 September 2026 TIME ON SITE 09:15 to",
      "60 months RECOMMENDED DATE OF NEXT INSPECTION 02 September 2031 DECLARATION AND REPORT",
    ],
  },
  "energy-performance-certificate.pdf": {
    provider: "This certificate was produced by Greenline Energy Assessments Ltd, 12 Riverside Court, Hallowfield, HF4 7QP. Telephone 01632 960777.",
    reference: "HF3 4RT Report Reference Number 8823-4471-9902-1156-3390 Assessment date / certificate issued: 12 May 2026 Valid until: 11 May",
    subtype: "Energy Performance Certificate Energy Performance Certificate 24 Larkspur Avenue, Hallowfield, HF3 4RT",
    dates: [
      "Assessment date / certificate issued: 12 May 2026 Valid until: 11 May 2036",
      "date / certificate issued: 12 May 2026 Valid until: 11 May 2036 This certificate is",
    ],
  },
  "fullpage-energy-tariff-end.pdf": {
    provider: "Achebe Head of Customer Pricing, Kittiwake Energy Ltd Rosalind AchebeKittiwake Energy Ltd, registered in England & Wales No.",
    reference: "Norfolk NR14 9QP Account number: 7724 6650 18 8 September 2026 Dear Mr Voss, Thank you for being a Kittiwake Energy",
    subtype: "onto our standard variable tariff, unless you choose a new plan with us before then. If you would rather",
    cost: { amount: "1,284.00", needle: "and what we are able to offer you if you fix your prices again today. Your current plan, Kittiwake Fixed October 2024 £1,284.00 a year Our standard" },
    dates: [
      "runs. Based on our records, your fixed price ends on 14 November 2026, and from the next day",
    ],
  },
  "fullpage-funeral-plan-certificate.pdf": {
    provider: "Funeral Plans\" is a trading name of Millstone Prepaid Services Ltd, registered in England and Wales No. 05712834, registered office 9",
    reference: "Evergreen Funeral Plans — certificate EFP-0091234 Evergreen Funeral Plans A pre-paid funeral plan, fixing today's cost",
    subtype: "Evergreen Funeral Plans — certificate EFP-0091234 Evergreen Funeral Plans A pre-paid funeral",
    cost: { amount: "3,995.00", needle: "Funeral Service PLAN DETAILS Plan type Simple Choice, unattended committal with optional service Total plan price £3,995.00, fixed at today's prices" },
    dates: [
      "CV11 5FT Plan number EFP-0091234 Plan commenced 3 November 2024 Certificate issued 10",
      "Plan commenced 3 November 2024 Certificate issued 10 November 2024 Nominated director:",
      "monthly instalments of £166.46 Final instalment due 3 October 2026 Funds held by",
    ],
  },
  "fullpage-gas-safety-record.pdf": {
    provider: "Date of issue 03/08/2026 BUSINESS NAME Fenwick & Vale Gas Services Ltd GAS SAFE REGISTERED BUSINESS, REGISTRATION NUMBER 512864 BUSINESS",
    reference: "RECORD LANDLORD / DUTYHOLDER COPY No. GSR-2026-04471 CP12 Date of issue 03/08/2026 BUSINESS NAME Fenwick & Vale Gas Services",
    subtype: "safe to use on the date shown DATE OF INSPECTION 03 August 2026 This record confirms only that the appliances listed",
    recurrence: { months: 12, needle: "safety or of efficient operation. This record is valid for 12 months from the date of inspection shown" },
    dates: [
      "safe to use on the date shown DATE OF INSPECTION 03 August 2026 This record confirms",
    ],
  },
  "fullpage-gym-membership-agreement.pdf": {
    provider: "Cresswell Fitness Club — Membership Agreement CFC Cresswell Fitness Club I NDEPENDENT HEALTH &",
    reference: "member (for office use) MEMBER COPY CFC-004821 Daniel Ostrowski 12 Vale Road, Bournholt, BH4 2LN 14 July 1988 01284",
    subtype: "Cresswell Fitness Club — Membership Agreement CFC Cresswell Fitness Club I NDEPENDENT HEALTH & F I TNESS",
    cost: { amount: "510.00", needle: "Monthly membership fee, collected by Direct Debit £42.50 Annual membership, paid" },
    recurrence: { months: 1, needle: "is due in January 2027. We will give you not less than 1 month's written notice of any increase, which" },
    dates: [
      "771 903 07700 900 442 d.ostrowski@mailbox.example 02 March 2026 Anna Ostrowski, 07700",
      "from your start date. Your minimum term will end on 2 March 2027 , after which your",
    ],
  },
  "fullpage-health-cash-plan-certificate.pdf": {
    provider: "Cash Plan is a trading name of Bramwell Friendly Society Ltd, incorporated under the Friendly Societies Act 1992, registered number",
    reference: "Cash Plan — membership certificate FGP-MEM-338420 FeelGood Cash Plan Everyday healthcare cover for you and your family",
    subtype: "FeelGood Cash Plan — membership certificate FGP-MEM-338420 FeelGood Cash Plan Everyday",
    cost: { amount: "14.50", needle: "osteopathy £400 Consultations and diagnostic tests £300 Health screening (once every 2 years) £120 MONTHLY PREMIUM £14.50 Your plan is billed 1" },
    recurrence: { months: 1, needle: "2 years) £120 MONTHLY PREMIUM £14.50 Your plan is billed 1 month at a time by direct debit and renews" },
    dates: [
      "FGP-MEM-338420 Cover level: Family Plus Plan start 6 April 2026 Renewal date 6 April",
      "Family Plus Plan start 6 April 2026 Renewal date 6 April 2027 What you can claim back",
    ],
  },
  "fullpage-holiday-lodge-site-licence.pdf": {
    provider: "Site licence renewal — pitch FSH-0412 ✆ FENWATER SHORES HOLIDAY PARK LTD Fenwater Lane, Marsh Cove, Aldreth Bay, Cravenshire CV31 8QT · 01924",
    reference: "Site licence renewal — pitch FSH-0412 ✆ FENWATER SHORES HOLIDAY PARK LTD Fenwater Lane, Marsh Cove, Aldreth",
    subtype: "Site licence renewal — pitch FSH-0412 ✆ FENWATER SHORES HOLIDAY PARK LTD Fenwater",
    cost: { amount: "4,150.00", needle: "Static unit ABI Fenwater 38x12 holiday lodge, plate number AL-2019-3307, sited since 22 April 2019 Annual pitch fee £4,150.00, due in full by 1 March" },
    dates: [
      "FSH-0412 Pitch number 412, Willow Row Issued 14 January 2026 Superseding licence",
      "OF THIS LICENCE Licence period 14 January 2026 to 10 January 2027, subject to the park's",
    ],
  },
  "fullpage-home-emergency-cover-schedule.pdf": {
    provider: "also raise a claim by emailing claims@homeguard365.co.uk with photographs of the fault, or through our online portal at",
    reference: "Home emergency cover schedule HG365-POL-552017 HOME EMERGENCY RESPONSE SCHEME 24-hour cover for boilers, plumbing,",
    subtype: "scheme is underwritten by Casterbridge Insurance plc, registered in England and Wales No. 03217740, authorised by the",
    cost: { amount: "186.00", needle: "glazing) £250 per claim, up to 2 claims a year Pest control call-out £120 per claim, 1 claim a year ANNUAL PREMIUM £186.00 This schedule confirms" },
    dates: [
      "CV2 5JD Policy number HG365-POL-552017 Cover start 4 October 2026 Renewal date 4 October",
      "Cover start 4 October 2026 Renewal date 4 October 2027 Schedule issued 21",
    ],
  },
  "fullpage-home-insurance-schedule.pdf": {
    provider: "IN TE R M E DIA RY Intermediary Hedgerow Home Insurance Services Ltd Intermediary address 8 Silvermead Court, Oakenfold, Drewshire DR1 2LP",
    reference: "Assurance plc — Policy schedule Policy TA-HH-7734291 — Page 1 of 3 THORNFIELD ASSURANCE PLC Registered office: Thornfield",
    subtype: "· This schedule, the statement of insurance and the policy booklet HB-14 together form your contract. POL ICY N UM",
    cost: { amount: "412.99", needle: "L PR E M IUM Net premium (excluding Insurance Premium Tax) £368.74 Insurance Premium Tax at 12% £44.25 Annual premium £412.99 Annual premium payable" },
    dates: [
      "R IOD Policy number TA-HH-7734291 Period of insurance 14 March 2026 to 14 March 2027 Renewal",
      "TA-HH-7734291 Period of insurance 14 March 2026 to 14 March 2027 Renewal date 14 March",
    ],
  },
  "fullpage-life-cover-booklet.pdf": {
    provider: "Ashcombe Life Assurance plc — Life and Critical Illness Cover: Policy Booklet Life and Critical",
    reference: "Staffordshire, ST9 4LP Policy number ALA-662048-13 Type of policy Life cover policy, with critical illness cover",
    subtype: "booklet is, by itself, a contract of insurance. Your contract is made up of this booklet, your policy schedule, the",
    cost: { amount: "7,800.00", needle: "Total premiums payable over full term approximately £7,800.00 Underwriting basis Full medical" },
    dates: [
      "illness cover (accelerated) Policy start date 18 October 2026 Policy end date 17",
      "Policy start date 18 October 2026 Policy end date 17 October 2046 Policy term 20 years Sum",
    ],
  },
  "fullpage-mobile-airtime-plan.pdf": {
    provider: "Fenwick Mobile – Mobile Plan Summary | My Account Fenwick Mobile – Mobile Plan Summary",
    reference: "rise takes effect. Account number 7734 2210 91 · Mobile number 07700 900123 Fenwick Mobile is a trading name of Anglia",
    subtype: "Fenwick Mobile – Mobile Plan Summary | My Account Fenwick Mobile – Mobile Plan Summary | My Account",
    cost: { amount: "498.00", needle: "YOUR PLAN SIM Only 30GB Flex £14.00/mo for your first 6 months £23.00/mo standard monthly" },
    recurrence: { months: 24, needle: "month 7 onward Plan started 20 March 2025 Minimum term 24 months — ends 20 March 2027 Data allowance" },
    dates: [
      "started 20 March 2025 Minimum term 24 months — ends 20 March 2027 Data allowance 30GB /",
    ],
  },
  "fullpage-mortgage-annual-statement.pdf": {
    provider: "Kelbridge Home Loans — Mortgage Annual Statement Kelbridge Home Loans Residential mortgage",
    reference: "STATEMENT DATE 06/04/2026 ACCOUNT 7738 2204 91 PAGE 1 OF 3 MORTGAGE ANNUAL STATEMENT For the statement period 1 April",
    subtype: "Kelbridge Home Loans — Mortgage Annual Statement Kelbridge Home Loans Residential mortgage lending",
    cost: { amount: "742.18", needle: "June 2049 (23 years remaining) OUTSTANDING BALANCE AT 31 MARCH 2026 £164,611.07 YOUR PAYMENTS CURRENT MONTHLY PAYMENT £742.18 Collected by direct" },
    recurrence: { months: 1, needle: "lending STATEMENT DATE 06/04/2026 ACCOUNT 7738 2204 91 PAGE 1 OF 3 MORTGAGE ANNUAL STATEMENT" },
    dates: [
      "Year Fixed 4.19% Fixed rate period 20 June 2024 to 19 June 2026 Early repayment charge",
    ],
  },
  "fullpage-mot-certificate.pdf": {
    provider: "STATION AND TESTER 1. TEST STATION Calderwell Motor Services Ltd 2. VTS NUMBER V-441829 3. ADDRESS Unit 7, Brandmoor Industrial Estate,",
    reference: "— MOT test certificate Test number 1847 2205 9631 — Page 1 of 2 DVTA Driver & Vehicle Testing Authority Statutory",
    subtype: "2026 in accordance with the statutory inspection manual in force on that date, and that it met the prescribed",
    dates: [
      "time. E X PI RY D ATE 08 September 2027 Test date 09 September 2026 VEHICLE DETAILS 1.",
      "condition at any other time. E X PI RY D ATE 08 September 2027 Test date 09 September",
    ],
  },
  "nursery-fees-invoice.pdf": {
    provider: "Little Acorns Day Nursery - Invoice Little Acorns Day Nursery part of the Bramblewood Childcare",
    reference: "number INV-045821 Account number 1044829 Invoice date 02/09/2026 Due date 15/09/2026 Child Freddie Marsh FEES",
    subtype: "date 15/09/2026 Child Freddie Marsh FEES FOR SEPTEMBER 2026 DESCRIPTION QTY RATE AMOUNT Full day sessions",
    cost: { amount: "1,087.60", needle: "credit (15 hrs/week government funding) – – −£190.40 Balance brought forward from August 2026 – – £45.00 Subtotal £1,087.60 Total payable £1,087.60" },
    dates: [
      "£1,087.60 Total payable £1,087.60 Autumn term dates: 2 September 2026 to 18 December 2026.",
      "Reference: 1044829 Amount due: £1,087.60 Due date: 15 September 2026 Please quote your",
    ],
  },
  "fullpage-pension-benefit-statement.pdf": {
    provider: "Marlestone Workplace Pensions Ltd — Annual Benefit Statement Marlestone Workplace Pensions Ltd",
    reference: "DATE 5 April 2026 PLAN NUMBER WPP-0077410-6 PAGE 1 OF 4 Annual Benefit Statement For the scheme year 6 April 2025",
    subtype: "Marlestone Workplace Pensions Ltd — Annual Benefit Statement Marlestone Workplace Pensions Ltd",
    cost: { amount: "215.42", needle: "3 for what your pension could be worth at your selected retirement date. Your contributions YOUR MONTHLY CONTRIBUTION £215.42 EMPLOYER'S MONTHLY" },
    dates: [
      "defined contribution pension scheme STATEMENT DATE 5 April 2026 PLAN NUMBER",
    ],
  },
  "pet-insurance-schedule.pdf": {
    provider: "Thornbury Pet Cover — Policy Schedule THORNBURY PET COVER Thornbury Pet Cover is a trading",
    reference: "Bramfield, BF12 4QW POLICY NUMBER TPC-2026-0447182 QUOTATION REF. Q-8820193 PET'S NAME Bramble SPECIES / BREED Dog —",
    subtype: "Cover is a trading name of Millbrace Insurance Services Limited. Policies are underwritten by Coldharbour Insurance",
    cost: { amount: "287.64", needle: "This is a 12 month policy. Your renewal date is 1 April 2027. PREMIUM AND PAYMENT Annual premium (paid in full): £287.64. Alternatively, pay by" },
    recurrence: { months: 12, needle: "starts: 1 April 2026. Cover ends: 31 March 2027. This is a 12 month policy. Your renewal date is 1 April" },
    dates: [
      "DATE 2 July 2019 PERIOD OF COVER Cover starts: 1 April 2026. Cover ends: 31 March",
      "2027. This is a 12 month policy. Your renewal date is 1 April 2027. PREMIUM AND PAYMENT",
    ],
  },
  "fullpage-pet-vaccination-card.pdf": {
    provider: "bring this card to every appointment Hawksmoor Cross Veterinary Centre 22 Thornfield Road, Bramcote St Giles, Wyvern DE7 4PL Telephone 01159",
    reference: "· Labrador Retriever · Microchip 977200005841236 Vaccination & health record · Page 1 of 2 Vaccination & Health Record",
    subtype: "Vaccination & Health Record Bramble · Labrador Retriever · Microchip",
    dates: [
      "(DHPPi/L4 + kennel cough) NEXT VACCINATION DUE 18 May 2027 Book in the two weeks",
    ],
  },
  "rail-season-ticket.pdf": {
    provider: "Cheddleton Rail — Season Ticket ANNUAL SEASON TICKET TICKET NO. ST-0294817-6 FROM",
    reference: "Ticket ANNUAL SEASON TICKET TICKET NO. ST-0294817-6 FROM MILLBROOK CROSS TO FENWICK PARKWAY ROUTE ANY PERMITTED VALID FROM",
    subtype: "Cheddleton Rail — Season Ticket ANNUAL SEASON TICKET TICKET NO. ST-0294817-6 FROM MILLBROOK CROSS TO",
    cost: { amount: "3,412.00", needle: "Parkway, Standard Class. Railcard discount applied: Coastway Saver Railcard, code RC-229104. Annual season ticket £3,412.00 Equivalent monthly price" },
    dates: [
      "TO FENWICK PARKWAY ROUTE ANY PERMITTED VALID FROM 01/09/2026 VALID UNTIL 31/08/2027",
      "ROUTE ANY PERMITTED VALID FROM 01/09/2026 VALID UNTIL 31/08/2027 CLASS STANDARD RAILCARD",
    ],
  },
  "residents-parking-permit.pdf": {
    provider: "your permit can be reissued. Write to Marchford Borough Council, Parking Services, 40 Guildhall Square, Marchford, MF2 1AA, call 01632",
    reference: "REG ISTRATION LT19 KXM PERMIT NUMBER RP-2026-118824 VEHICLE MAKE/MODEL FORD FOCUS VAL ID FROM 01/07/2026 EXPIRES 30/06/2027",
    subtype: "Residents Parking Permit Covering notice — your residents' parking permit Council ref:",
    cost: { amount: "45.00", needle: "NUMBER RP-2026-118824 VEHICLE MAKE/MODEL FORD FOCUS VAL ID FROM 01/07/2026 EXPIRES 30/06/2027 Annual permit fee paid: £45.00 ✂ detach along this line" },
    dates: [
      "VEHICLE MAKE/MODEL FORD FOCUS VAL ID FROM 01/07/2026 EXPIRES 30/06/2027",
      "MAKE/MODEL FORD FOCUS VAL ID FROM 01/07/2026 EXPIRES 30/06/2027 Annual permit fee paid:",
    ],
  },
  "fullpage-satellite-tv-subscription-invoice.pdf": {
    subtype: "Starview Satellite TV — invoice STV-AC-774213 Starview Satellite TV Freedom Package · 0800 220 1187 · www.starviewtv.example Your monthly invoice",
    provider: "Starview Satellite TV — invoice STV-AC-774213 Starview Satellite TV Freedom Package · 0800",
    reference: "Starview Satellite TV — invoice STV-AC-774213 Starview Satellite TV Freedom Package · 0800 220 1187 ·",
    cost: { amount: "42.99", needle: "billed 1 month in advance 39.99 Sports add-on 15.00 Multiscreen box rental 6.00 Loyalty discount -18.00 Total due £42.99 DIRECT DEBIT COLLECTION" },
    recurrence: { months: 1, needle: "THIS MONTH'S CHARGES Item Amount Freedom Package, billed 1 month in advance 39.99 Sports add-on 15.00" },
    dates: [
      "Invoice date 5 September 2026 Contract start 12 March 2026 Minimum term ends 12",
      "2026 Contract start 12 March 2026 Minimum term ends 12 March 2027 THIS MONTH'S CHARGES",
    ],
  },
  "fullpage-self-storage-agreement.pdf": {
    subtype: "Storage licence agreement SSL-BX-3390 SSL Fenmouth Self Storage Centre · Unit 14, Quayside Industrial Estate, Fenmouth, Cravenshire CV2 7RL Storage",
    provider: "Storage licence agreement SSL-BX-3390 SSL Fenmouth Self Storage Centre · Unit 14, Quayside Industrial",
    reference: "Storage licence agreement SSL-BX-3390 SSL Fenmouth Self Storage Centre · Unit 14, Quayside Industrial Estate,",
    cost: { amount: "68.00", needle: "hours 06:00 to 22:00 daily, including bank holidays Insurance Included up to £2,000 contents value M ON TH LY R E N T £68.00 This storage licence is" },
    dates: [
      "CV2 6PN Unit reference SSL-BX-3390 Move-in date 15 August 2026 Next payment due 15",
      "Move-in date 15 August 2026 Next payment due 15 September 2026 Agreement prepared 12",
    ],
  },
  "fullpage-service-charge-demand.pdf": {
    provider: "22 Petersgate Road Alderwick WX7 4LP Purbeck & Vane Property Management Ltd · Account TFC-014-2627 Page 1 of 4 Pu r beck & Vane Prop erty",
    reference: "14, Thornfield Court Account reference TFC-014-2627 · Lease reference TFC/14/LR-1998 · First instalment (1 of 2) We write",
    subtype: "Service Charge Demand — Thornfield Court P&V Pur beck & Vane Pro p erty Management Ltd",
    cost: { amount: "3,930.00", needle: "then falling due. Your apportioned share of the service charge budgeted for the development for that year is £3,930.00, as shown in the" },
    recurrence: { months: 12, needle: "This demand covers the service charge year running for a 12-month period from 1 April 2026 to 31" },
    dates: [
      "the service charge year running from 1 April 2026 to 31 March 2027. This demand is issued",
    ],
  },
  "fullpage-skip-hire-contract.pdf": {
    provider: "and collected by our local partner, Corvedale Skips & Aggregates Ltd, registered waste carrier CBDU887214. SkipFinder Ltd arranges this",
    reference: "Skip hire order confirmation SKF-ORD-661204 SkipFinder Compare and book local skip hire · 0800 552 0198 ·",
    subtype: "Order confirmation and hire contract Delivery address Mrs Elin Thomas 7 Orchard Way, Penbury, Cravenshire",
    cost: { amount: "285.00", needle: "210.00 Waste transfer and disposal charge 55.00 Booking service fee (SkipFinder) 20.00 Total charged to your card £285.00 If the skip is not" },
    dates: [
      "Cravenshire CV9 1HL Order SKF-ORD-661204 Booked 2 September 2026 Booking made via",
      "BOOKING Skip size 8 yard builder's skip Delivery date 9 September 2026, between 7am and 1pm",
      "1pm Hire period 14 days from delivery Collection due 23 September 2026, unless you request an",
    ],
  },
  "fullpage-solar-export-statement.pdf": {
    provider: "then- current default export tariff. Millbrook Energy Ltd is a licensed electricity supplier, registered in England & Wales No.",
    reference: "Export Statement GENERATION ACCOUNT SEG-4471-0932 STATEMENT PERIOD 01/04/2025 – 31/03/2026 STATEMENT DATE 24/04/2026 Mrs",
    subtype: "Q2 25/26 Q3 25/26 Q4 25/26 Your export tariff explained Payments in this statement are calculated by multiplying the",
    cost: { amount: "343.64", needle: "payment, four quarters £361.64 Less: annual metering & data administration charge −£18.00 Total paid to you this year £343.64 Estimated total for" },
    recurrence: { months: 12, needle: "Export meter EM2205968 Export meter last verified 12 May 2022 Your quarterly export and" },
    dates: [
      "1 April 2023 for a fixed term of 4 years and ends on 31 March 2027. Shortly before your",
    ],
  },
  "streaming-subscription-invoice.pdf": {
    provider: "Your Northlight+ payment receipt mail.example/mail/u/0/#inbox/17c9f2a41d 1 of 1 Your",
    reference: "(12 month plan) Account number NL-ACC-771049-2 Payment date 3 August 2026 Plan renews on 3 August 2027 Amount charged",
    subtype: "because you have an active Northlight+ subscription. Unsubscribe from receipts | Privacy policy",
    cost: { amount: "119.88", needle: "Paid monthly, your 12 month plan is equivalent to £119.88 a year. Fancy more channels?" },
    recurrence: { months: 12, needle: "member. We've taken your monthly payment for your 12 month plan — here's your receipt. Plan" },
    dates: [
      "Priya Chandra priya.chandra83@mailbox.example Date: 3 August 2026, 09:14 NORTHLIGHT+ Hi",
      "Payment date 3 August 2026 Plan renews on 3 August 2027 Amount charged £9.99",
    ],
  },
  "tenancy-agreement.pdf": {
    provider: "Assured Shorthold Tenancy Agreement THORNFIELD LETTINGS & MANAGEMENT 8 High Street, Barchester, BR1 4DA · 01632 960214 ·",
    reference: "Barchester, BR1 4DA Tenancy Reference THN-2026-0458 Term A fixed term of 12 months, commencing 15/06/2026 and expiring",
    subtype: "Assured Shorthold Tenancy Agreement THORNFIELD LETTINGS & MANAGEMENT 8 High Street, Barchester,",
    cost: { amount: "11,700.00", needle: "payable in advance on the 15th day of each month. Total rent payable over the term: £11,700.00 First Payment Due 02/06/2026" },
    recurrence: { months: 12, needle: "4DA Tenancy Reference THN-2026-0458 Term A fixed term of 12 months, commencing 15/06/2026 and expiring" },
    dates: [
      "is let for a fixed term of 12 months, commencing on 15 June 2026 and expiring on 14 June",
      "12 months, commencing on 15 June 2026 and expiring on 14 June 2027, unless terminated",
    ],
  },
  "fullpage-travel-insurance-certificate.pdf": {
    provider: "Travel Insurance Certificate KESTREL TRAVEL INSURANCE SERVICES LTD Administrator of your annual multi-trip travel insurance policy",
    reference: "insurance policy Certificate number KTL/AMT/449108 ANNUAL MULTI-TRIP TRAVEL INSURANCE CERTIFICATE P OLIC YHOLD E R Mr",
    subtype: "Annual Multi-Trip Travel Insurance Certificate KESTREL TRAVEL INSURANCE SERVICES LTD Administrator of your",
    cost: { amount: "159.60", needle: "per incident £95.00 Premium excluding Insurance Premium Tax £133.00 Annual premium, including Insurance Premium Tax £159.60 Underwritten by Palisade" },
    recurrence: { months: 12, needle: "Canada, the Caribbean and Mexico P E RIOD OF INSURANC E 12 months, from 1 April 2026 to 1 April 2027 RE" },
    dates: [
      "and Mexico P E RIOD OF INSURANC E 12 months, from 1 April 2026 to 1 April 2027 RE NE",
      "E RIOD OF INSURANC E 12 months, from 1 April 2026 to 1 April 2027 RE NE WAL D ATE — C OV E",
    ],
  },
  "fullpage-tv-licence-confirmation.pdf": {
    provider: "contact us using the address below. Colefield Broadcast Licensing Authority Limited · Confirmation issued 10 March 2026 · Enquiries 0300 555 0148",
    reference: "Television Licence Licence number CBL-774-2091 Valid from 1 April 2026 Valid to 31 March 2027 Fee £182.00 £45.50 by",
    subtype: "Television Licence Confirmation COLEF I ELD L ICENSING Television Licence Licence number",
    cost: { amount: "182.00", needle: "I ELD L ICENSING Television Licence Licence number CBL-774-2091 Valid from 1 April 2026 Valid to 31 March 2027 Fee £182.00 £45.50 by quarterly" },
    recurrence: { months: 12, needle: "or record programmes as they are broadcast. It runs for 12 months from the start date shown in the panel" },
    dates: [
      "number CBL-774-2091 Valid from 1 April 2026 Valid to 31 March 2027 Fee £182.00 £45.50 by",
    ],
  },
  "fullpage-university-halls-invoice.pdf": {
    subtype: "Previous invoice 2 June 2026 PAYMENT DUE 1 October 2026 Charges this term Item Period Amount",
    provider: "Bay Halls is managed under contract by Bridgewater Living Services Ltd, company number 07734512, registered office 14 Quayside Chambers,",
    reference: "Halls Student number 20261847 Invoice BLS-INV-24-1187 Tenancy ref AB-KC-214-26 Issued 3 September 2026 Previous invoice 2",
    cost: { amount: "2,450.00", needle: "insurance (compulsory) autumn term 45.00 Common room and laundry levy autumn term 225.00 Total due this instalment £2,450.00 This is the first of" },
    dates: [
      "BLS-INV-24-1187 Tenancy ref AB-KC-214-26 Issued 3 September 2026 Previous invoice 2 June",
      "2026 Previous invoice 2 June 2026 PAYMENT DUE 1 October 2026 Charges this term Item",
    ],
  },
  "fullpage-vehicle-tax-reminder.pdf": {
    provider: "Vehicle Tax Reminder Highways and Vehicle Licensing Authority Executive agency for vehicle registration and taxation · Northgate",
    reference: "A T IO N D O C U MEN T R EF ER EN C E 4471 8823 0519 C A S E R EF ER EN C E HVLA-2026-661452 R EG IS T R A T IO N MA R K",
    subtype: "Vehicle Tax Reminder Highways and Vehicle Licensing Authority Executive agency for",
    cost: { amount: "180.00", needle: "2026 RATE FOR THIS VEHICLE — TICK ONE AND PAY BY THE METHODS OVERLEAF PAYMENT OPTION AMOUNT ☐ Single 12 month payment £180.00 ☐ Single 6 month payment" },
    recurrence: { months: 12, needle: "PAY BY THE METHODS OVERLEAF PAYMENT OPTION AMOUNT ☐ Single 12 month payment £180.00 ☐ Single 6 month" },
    dates: [
      "S IN C E 22 June 2021 C U R R EN T T A X EX P IR ES 31 October 2026 MO T EX P IR ES 19",
    ],
  },
  "fullpage-water-bill.pdf": {
    provider: "ClearBourne Water — Water and Wastewater Bill ClearBourne Water Water and wastewater",
    reference: "region BILL DATE 09/06/2026 ACCOUNT 8847 2210 55 TARIFF CODE WV-M-04 PAGE 1 OF 2 Mr J Whitcombe 12 Silverdale Close",
    subtype: "Water — Water and Wastewater Bill ClearBourne Water Water and wastewater services for the Bourne Valley",
    cost: { amount: "163.37", needle: "M-2291487 Supply type Metered, combined Direct debit Collecting 23/06/2026 AMOUNT NOW DUE Payment due by 30/06/2026 £163.37 METER READINGS ON YOUR" },
    dates: [
      "Collecting 23/06/2026 AMOUNT NOW DUE Payment due by 30/06/2026 £163.37 METER READINGS",
    ],
  },
  "fullpage-window-installation-guarantee.pdf": {
    provider: "Guarantee Issued by the National Fenestration Guarantee Scheme Ltd following notification of the work described below under the competent",
    reference: "and Insurance-Backed Guarantee — IBG-2026-337215 NFGS National Fenestration Guarantee Scheme Competent person scheme for",
    subtype: "of Compliance and Insurance-Backed Guarantee — IBG-2026-337215 NFGS National Fenestration Guarantee Scheme Competent",
    dates: [
      "SCHEME POLICY NO. GPS-0417-2261 Date of installation 14 March 2026 Guarantee expires 14",
      "Date of installation 14 March 2026 Guarantee expires 14 March 2036 Certificate of",
    ],
  },
};

/**
 * Documents whose answers sit past `INPUT_CHARACTER_BUDGET`, so no model --
 * however good -- can quote them. `safeDocumentEvidence` keeps the head and
 * drops the tail, silently.
 *
 * This is not a test being excused. It is #981's point 4 made into an
 * assertion: the budget had never once fired, because the longest document in
 * the old corpus was 668 characters. The life cover booklet is 26,939
 * characters with its policy schedule on page 13, exactly where a real
 * twenty-page policy puts it, and the extractor cannot see that page at all.
 *
 * The expectation is inverted rather than skipped, so this list cannot quietly
 * grow and cannot quietly become wrong: raise the budget, or window the input
 * instead of truncating it, and the entry below starts failing and tells you
 * to remove it.
 */
const ANSWERS_PAST_THE_INPUT_BUDGET = new Set(["fullpage-life-cover-booklet.pdf"]);

describe("the input budget silently truncates a long document's answers (#981)", () => {
  for (const filename of ANSWERS_PAST_THE_INPUT_BUDGET) {
    it(`${filename}: its evidence is unquotable, because the budget cut the page it is on`, () => {
      const doc = EXTRACTION_CORPUS.find((d) => d.filename === filename);
      expect(doc, `${filename} is no longer in the corpus -- drop it from the list`).toBeDefined();
      const full = doc!.text;
      const truncated = safeDocumentEvidence(full, INPUT_CHARACTER_BUDGET);
      expect(full.length).toBeGreaterThan(INPUT_CHARACTER_BUDGET);
      const needle = collapseWhitespace(EVIDENCE[filename]!.reference!);
      expect(collapseWhitespace(full)).toContain(needle);
      expect(truncated).not.toContain(needle);
    });
  }
});

describe("an ideal model's reply survives modelProposalFromText's grounding and validation (#965)", () => {
  for (const doc of EXTRACTION_CORPUS) {
    if (ANSWERS_PAST_THE_INPUT_BUDGET.has(doc.filename)) continue;
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
      if (doc.expected.subtype !== undefined && !SUBTYPE_NOT_GROUNDABLE.has(doc.filename)) {
        if (!evidence.subtype) throw new Error(`[${doc.filename}] expected.subtype set but no evidence.subtype needle`);
        const subtypeAnswer = firstSubtypePhrase(doc.expected.subtype, normalizedText);
        generated.subtype = { value: subtypeAnswer, evidence: span(doc.filename, evidence.subtype, normalizedText) };
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
      if (doc.expected.subtype !== undefined && !SUBTYPE_NOT_GROUNDABLE.has(doc.filename) &&
        classifySubtype(doc.expected.subtype, proposal.subtype) !== "correct") {
        const evidenceSpan = (generated.subtype as { evidence: string }).evidence;
        const subtypeAnswer = firstSubtypePhrase(doc.expected.subtype, normalizedText);
        mismatches.push(
          `subtype: expected ${JSON.stringify(doc.expected.subtype)}, got ${JSON.stringify(proposal.subtype)} -- ` +
          textFieldDiagnosis(subtypeAnswer, evidenceSpan),
        );
      }
      if (doc.expected.costMinor !== undefined && !COST_NOT_PRINTED.has(doc.filename) &&
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
