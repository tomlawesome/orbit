// A hold-out corpus is a set of documents the extractor is scored against but
// must never be tuned on. Its whole value is that nobody adjusted the
// extraction rules (or the documents themselves) to make the score come out
// well — the number it produces is only meaningful as long as that stays
// true. Extraction-improvement work must not read this file's contents, and
// must not be adjusted to raise the score this corpus produces.
//
// This corpus was written on 2026-09-10 by an agent that had not read, and
// was instructed not to read, the extractor's rules (suggestions.ts,
// model-extraction.ts), the tuning corpus (extraction-corpus.ts document
// bodies) or the previous hold-out (extraction-holdout-corpus.ts). The
// documents below are invented household paperwork, not derived from or
// checked against how Orbit currently extracts data. Every name, company,
// address and reference number is fictitious.

import type { CorpusDocument } from "./extraction-corpus";

export const EXTRACTION_HOLDOUT_CORPUS_2: CorpusDocument[] = [
  {
    name: "Electricity bill with tabular charges",
    filename: "meridian-power-bill-2026-08.pdf",
    text: `MERIDIAN POWER
Customer Services, PO Box 4192, Leeds, LS1 9ZZ
meridianpower.co.uk | 0345 600 1122

Account name: Mr D Ashworth
Supply address: 14 Larch Grove, Reading, RG6 3PL

Account number: 8823 4410 771
Billing period: 01 July 2026 to 31 July 2026
Bill date: 03 August 2026

Electricity charges
Standing charge (31 days @ 27.84p)        £8.63
Usage: 312 kWh @ 24.91p                   £77.72
VAT at 5%                                 £4.32

Total amount due: £90.67
Payment due date: 17 August 2026

Your next meter reading is due around 01 September 2026.
If you pay by direct debit no action is needed.`,
    expected: {
      dates: ["2026-08-03", "2026-08-17"],
      provider: "Meridian Power",
      reference: "8823 4410 771",
    },
  },
  {
    name: "Gas bill written as a prose letter",
    filename: "northfield-gas-letter.pdf",
    text: `Northfield Gas & Energy Ltd
1 Furnace Court, Sheffield, S3 8AL
Registered in England No. 04471829

Dear Ms Okafor,

Thank you for your continued custom. This letter confirms your latest gas charges for the property at 22 Pinewood Close, Sheffield, S6 4DQ, account reference GAS-661204-9.

We read your meter on 12 September 2026 and calculated usage of 1,142 kWh since your last reading on 14 June 2026. Charges for this period come to £61.84 including VAT. Payment will be collected by direct debit from your nominated account on 26 September 2026, so no action is required unless your details have changed.

We are also writing to let you know that your fixed-rate tariff ends on 30 November 2026. After this date you will move to our standard variable tariff unless you choose a new deal. We will contact you again nearer the time.

Kind regards,
Customer Billing Team
Northfield Gas & Energy`,
    expected: {
      dates: ["2026-09-26", "2026-11-30"],
      provider: "Northfield Gas & Energy",
      reference: "GAS-661204-9",
    },
  },
  {
    name: "Car insurance auto-renewal notice with several reference numbers",
    filename: "castlegate-motor-renewal.pdf",
    text: `CASTLEGATE INSURANCE GROUP
Motor Renewals Department
Pinnacle House, 40 Exchange Street, Bristol, BS1 1DA

Policyholder: Mr S Bhatt
Vehicle: Ford Focus, registration LM19 XRP

Your car insurance policy CG-MTR-702215 is due for renewal. Cover under your current policy ends at 23:59 on 09 October 2026. To keep you protected without a break in cover, we will automatically renew your policy from 00:01 on 10 October 2026 at a premium of £412.60, and collect this by the payment method we hold on file, unless you tell us not to by calling 0330 100 2244.

Your renewal quote reference is RNQ-88231, which you can use if you call to discuss your cover. Your customer account number is 5591027.

Please read the enclosed policy summary carefully. If you do nothing, your policy will renew automatically.`,
    expected: {
      dates: ["2026-10-09", "2026-10-10"],
      provider: "Castlegate Insurance Group",
      reference: "CG-MTR-702215",
    },
  },
  {
    name: "Home insurance policy schedule in table form",
    filename: "hearthstone-policy-schedule.pdf",
    text: `HEARTHSTONE HOME INSURANCE
Policy Schedule

Insured:              Mr and Mrs T Lindqvist
Property insured:     7 Meadowcroft, York, YO24 1RN
Policy number:        HHI-2026-334871
Period of insurance:  From 22 August 2026 to 21 August 2027
Buildings sum insured: £310,000
Contents sum insured:  £60,000
Excess (standard):     £250
Annual premium:        £284.15

This schedule should be read together with your policy booklet and any endorsements. Please check all details are correct and contact us within 14 days if anything needs amending.`,
    expected: {
      dates: ["2026-08-22", "2027-08-21"],
      provider: "Hearthstone Home Insurance",
      reference: "HHI-2026-334871",
    },
  },
  {
    name: "Broadband end-of-contract notice",
    filename: "vantage-fibre-contract-update.pdf",
    text: `Vantage Fibre
Your contract update

Account holder: Priya Nair
Account number: VF-770234
Service address: Flat 3, 18 Union Street, Glasgow, G1 3RB

Your current 24-month contract for Vantage Fibre 500 ends on 05 November 2026. From 06 November 2026, unless you choose a new plan, you'll move onto our rolling monthly contract at the standard out-of-contract price of £52.00 a month (currently £34.99 a month on your existing deal).

We'll email you nearer the time with the latest deals available to you. You can also call us any time on 0800 052 0500 or check your options online.

Thanks for being with Vantage Fibre.`,
    expected: {
      dates: ["2026-11-05", "2026-11-06"],
      provider: "Vantage Fibre",
      reference: "VF-770234",
    },
  },
  {
    name: "Mobile plan email notice with sender in header, not letterhead",
    filename: "skylark-mobile-plan-email.pdf",
    text: `From: Skylark Mobile <noreply@skylarkmobile.co.uk>
Subject: Your SIM plan is changing soon

Hi Tom,

Just a heads up - your 12-month SIM only plan (reference SKY-SIM-40218) is coming to the end of its minimum term on 03 December 2026.

After that date, you're free to leave any time, or do nothing and stay on your current allowance of 50GB data, unlimited minutes and texts for £11 a month.

Want to switch plans? Log in to My Skylark or call 333 free from your Skylark phone.

Thanks,
The Skylark Mobile Team`,
    expected: {
      dates: ["2026-12-03"],
      provider: "Skylark Mobile",
      reference: "SKY-SIM-40218",
    },
  },
  {
    name: "Council tax annual bill with a ten-line instalment table",
    filename: "broomfield-council-tax-2026-27.pdf",
    text: `BROOMFIELD BOROUGH COUNCIL
Council Tax Bill 2026/27

Account reference: 771002-BB
Property: 9 Chapel Row, Broomfield, BR3 7HL
Band: D

Annual charge: £1,884.60
Payable by 10 monthly instalments as follows:

01 May 2026     £188.46
01 Jun 2026     £188.46
01 Jul 2026     £188.46
01 Aug 2026     £188.46
01 Sep 2026     £188.46
01 Oct 2026     £188.46
01 Nov 2026     £188.46
01 Dec 2026     £188.46
01 Jan 2027     £188.48
01 Feb 2027     £188.48

This bill covers the period 01 April 2026 to 31 March 2027. If you think your bill is wrong, contact us within 21 days of the date of this notice, 15 March 2026.`,
    expected: {
      dates: ["2026-04-01", "2027-03-31"],
      provider: "Broomfield Borough Council",
      reference: "771002-BB",
    },
  },
  {
    name: "MOT reminder with no account reference",
    filename: "fenwick-motors-mot-reminder.pdf",
    text: `Fenwick Motors Ltd
Unit 4, Riverside Trading Estate
Northampton NN1 5EF
Tel: 01604 555 019

Dear Customer,

Our records show that the MOT test certificate for your vehicle, registration WX68 KLP, expires on 27 September 2026.

We'd be happy to book your car in for its next MOT and, if convenient, a service at the same time. Please call us or book online to arrange a slot before your current certificate runs out.

Regards,
Fenwick Motors`,
    expected: {
      dates: ["2026-09-27"],
      provider: "Fenwick Motors",
    },
  },
  {
    name: "DVLA vehicle tax reminder",
    filename: "dvla-vehicle-tax-reminder.pdf",
    text: `Driver and Vehicle Licensing Agency
Correspondence Team, Swansea, SA99 1AR

Vehicle Tax Reminder

Registration number: EN15 GHT
Make: Volkswagen Golf

Your vehicle tax runs out at the end of 31 October 2026.

You must tax your vehicle again even if you do not have to pay anything, for example if you have a disability exemption.

Tax your vehicle at www.gov.uk/vehicle-tax or at a Post Office branch. You will need the 11-digit reference number from your last vehicle tax reminder or your log book (V5C), document reference number 294771860213.

Do not ignore this reminder. If your vehicle is untaxed and not declared SORN, you risk a fine.`,
    expected: {
      dates: ["2026-10-31"],
      provider: "Driver and Vehicle Licensing Agency",
      reference: "294771860213",
    },
  },
  {
    name: "Boiler cover plan renewal notice",
    filename: "warmworks-boiler-plan-renewal.pdf",
    text: `WarmWorks Cover Plan
Annual renewal notice

Plan holder: Mr R Okonkwo
Plan number: WW-BLR-551209
Appliance covered: Worcester Bosch Greenstar boiler, installed 2019
Address: 3 Elm Terrace, Cardiff, CF10 2AB

Your WarmWorks Boiler Care plan renews on 19 September 2026 for a further 12 months at £16.50 a month (£198.00 a year), which includes an annual service visit and unlimited call-outs for breakdowns.

Your next annual service is due to be booked between 01 October 2026 and 30 November 2026 - we'll be in touch to arrange a convenient date.

To make any changes to your plan before it renews, call us on 0333 202 9091.`,
    expected: {
      dates: ["2026-09-19"],
      provider: "WarmWorks Cover Plan",
      reference: "WW-BLR-551209",
    },
  },
  {
    name: "Streaming subscription payment receipt",
    filename: "streamly-plus-receipt.pdf",
    text: `Streamly+
Your payment receipt

Hi Aiden,

Thanks for being a Streamly+ member. We've successfully charged your card on file £8.99 for your monthly subscription, covering 14 August 2026 to 13 September 2026.

Your next payment will be taken on 14 September 2026.

Order reference: STRM-99213-AB

Manage your subscription any time at streamlyplus.com/account.

The Streamly+ Team`,
    expected: {
      dates: ["2026-09-14"],
      provider: "Streamly+",
      reference: "STRM-99213-AB",
    },
  },
  {
    name: "Dental appointment reminder letter",
    filename: "willowbrook-dental-reminder.pdf",
    text: `Willowbrook Dental Practice
22 High Street, Norwich, NR2 1AB
01603 771 224

Dear Mrs Fairweather,

This is a reminder that you have a dental check-up appointment booked with Dr. Patel on Thursday 08 October 2026 at 10:40am.

If you need to rearrange, please give us at least 24 hours' notice by calling the practice.

We also recommend booking a hygienist visit; your last one was on 02 April 2026, over six months ago.

See you soon,
Willowbrook Dental Practice`,
    expected: {
      dates: ["2026-10-08"],
      provider: "Willowbrook Dental Practice",
    },
  },
  {
    name: "Annual mortgage statement with multiple dates",
    filename: "cornerstone-mortgage-statement-2026.pdf",
    text: `Cornerstone Building Society
Mortgage Services, PO Box 771, Peterborough, PE1 1AA

Annual Mortgage Statement

Mortgage account: 6650192837
Property: 5 Foxglove Way, Peterborough, PE3 9QL
Borrower: Mr and Mrs Delacroix

This statement covers the period 01 April 2025 to 31 March 2026.

Balance outstanding at 01 April 2025: £184,502.11
Balance outstanding at 31 March 2026: £178,910.44
Interest rate: 4.85% fixed until 31 May 2028

Your current monthly payment is £1,042.18, next due on 01 October 2026.

If your fixed rate is ending soon, we will write to you around three months beforehand with your new options.`,
    expected: {
      dates: ["2026-10-01", "2028-05-31"],
      provider: "Cornerstone Building Society",
      reference: "6650192837",
    },
  },
  {
    name: "Tenancy renewal and rent increase letter",
    filename: "alderman-lettings-tenancy-renewal.pdf",
    text: `Alderman Lettings
14 Market Square, Exeter, EX1 1GF

Dear Mr Whitmore,

We are writing regarding your tenancy at 8b Riverside Court, Exeter, EX2 4LJ, under agreement reference ALD-TEN-33018.

Your current fixed-term tenancy agreement ends on 31 October 2026. Your landlord has asked us to offer you a further 12-month term at a revised rent of £975 per calendar month, an increase from your current rent of £925, effective from 01 November 2026 should you choose to renew.

Please let us know your decision by 10 October 2026 so that we have time to prepare new paperwork if needed. If we do not hear from you, your tenancy will continue on a rolling monthly basis under the terms of the Housing Act 1988 once the fixed term ends.

Kind regards,
Alderman Lettings`,
    expected: {
      dates: ["2026-10-31", "2026-10-10", "2026-11-01"],
      provider: "Alderman Lettings",
      reference: "ALD-TEN-33018",
    },
  },
  {
    name: "Pet insurance renewal schedule in table form",
    filename: "pawtect-renewal-schedule.pdf",
    text: `PAWTECT INSURANCE
Renewal Schedule

Policyholder:        Ms H Osei
Pet:                  Biscuit (Cocker Spaniel, DOB 04/2019)
Policy number:        PWT-88410-K9
Current period ends:  16 September 2026
New period:           17 September 2026 to 16 September 2027
Cover level:          Lifetime, £6,000 per condition
Renewal premium:      £34.60 per month

To renew, no action is needed - we'll collect your first payment on 17 September 2026 using your existing details. To make changes or cancel, contact us before 10 September 2026.`,
    expected: {
      dates: ["2026-09-16", "2026-09-17", "2026-09-10"],
      provider: "Pawtect Insurance",
      reference: "PWT-88410-K9",
    },
  },
];
