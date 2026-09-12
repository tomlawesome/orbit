// GENERATED FILE — do not edit by hand.
//
// A HOLD-OUT set: full-page documents written after the extractor was
// tuned, by someone who had not read `scripts/corpus/sources/` (or, for a
// later hold-out, any earlier hold-out either -- `holdout` is the first).
// They are the generalisation measurement, so they are deliberately NOT part
// of `EXTRACTION_CORPUS`: nothing tuning against the tuning set pulls them
// in, and tuning against a hold-out would destroy the only unseen number the
// project has for it.
//
// Score with `npm run eval:holdout`. Regenerate with:
//
//   node scripts/corpus/generate.mjs --dir holdout
//
// Each document was written as HTML, rendered to PDF with Playwright at A4,
// and parsed with the real Tika using the request in `tika.ts`. The `text`
// below is Tika's output byte for byte — escapes, flattened table columns,
// repeated page headers and all. That is the point: the fixture is what
// production actually sees, not a tidied version of it.
//
// The originals live in `scripts/corpus/holdout/`. Never edit
// `text` here; edit the HTML and regenerate, so the fixture and the document
// it came from cannot drift apart.

import type { CorpusDocument } from "./extraction-corpus";

export const EXTRACTION_HOLDOUT_FULLPAGE: CorpusDocument[] = [
  {
    // Ground-truth notes:
    // - Start date 2026-03-02 is printed as 'Monitoring Start Date 02/03/2026' and repeated in the customer signature date.
    // - Service date 2027-03-02 is printed as 'Annual Maintenance Visit Due 02/03/2027'.
    // - Renewal/term-end date 2028-03-01 is printed within 'Minimum Term: 24 month minimum term, ending 01/03/2028'.
    // - recurrenceMonths 24 is printed in digits as '24 month minimum term' — the length of the agreement, not the monthly billing cycle.
    // - Provider is 'Northgate Home Security', the trading name in the header and footer strip — not the Alarm Receiving Centre or insurer named elsewhere.
    // - Reference 'NGS-CA-20456' is printed as the Contract Number field and repeated in the footer strip.
    // - costMinor 2499 is the 'Monthly Monitoring Charge... £24.99 per month' field.
    // - Trap: the 'Installation Charge £199.00 — paid in full, receipt no. RCT-30442' is a rival, one-off cost already settled.
    // - Trap: the 'Callout Charge (outside agreement) £65.00 + VAT per visit' is a rival recurring-looking cost.
    // - Trap: the 'total payable over the 24 month minimum term of £599.76' is a rival aggregate cost figure.
    // - Trap: 'Alarm Receiving Centre: Beacon Watch Monitoring Centre' is a rival organisation name.
    // - Trap: 'Police URN: 1234567/26' is a rival reference number.
    // - Trap: 'Insurer Requiring Monitoring: Hearthstone Home Insurance' is a rival organisation name.
    // - Trap: the engineer 'D. Sutton — commissioning visit 28/02/2026' gives a rival name and a rival date close to the monitoring start.
    // - Trap: 'Right to Cancel... up to and including 16/03/2026' is a rival date.
    // - Trap: the keyholders 'Mrs Diane Whitlock — 07700 900142' and 'Mr Colin Whitlock — 07700 900873' are named with phone numbers as rival contacts.
    // - Trap: 'Control Panel Manufactured 11/2025 — parts warranty ends 03/03/2027' gives a rival date one day after the true service date.
    name: "Intruder Alarm Monitoring Agreement",
    filename: "alarm-monitoring-agreement.pdf",
    text: "Intruder Alarm Monitoring Agreement  \n\nNORTHGATE  HOME  SECURITY Unit 6, Foundry Business Park, Elmscote, EL4 2RJ  ·  01632 960377  ·  northgatesecurity.example \n\nINTRUDER ALARM MONITORING AGREEMENT \n\nCustomer Mr & Mrs D. Whitlock \n\nInstallation Address 17 Peartree Close, Elmscote, EL5 8HN \n\nContract Number NGS-CA-20456 \n\nEngineer D. Sutton — commissioning visit 28/02/2026 \n\nMonitoring Start Date 02/03/2026 \n\nMinimum Term 24 month minimum term, ending 01/03/2028 \n\nAnnual Maintenance Visit Due 02/03/2027 \n\nMonthly Monitoring Charge £24.99 per month, collected by direct debit \n\nInstallation Charge £199.00 — paid in full, receipt no. RCT-30442 \n\nCallout Charge (outside agreement) £65.00 + VAT per visit \n\nAlarm Receiving Centre Beacon Watch Monitoring Centre \n\nPolice URN 1234567/26 \n\nInsurer Requiring Monitoring Hearthstone Home Insurance \n\nKeyholder 1 Mrs Diane Whitlock — 07700 900142 \n\nKeyholder 2 Mr Colin Whitlock — 07700 900873 \n\nControl Panel Manufactured 11/2025 — parts warranty ends 03/03/2027 \n\nRight to Cancel Within 14 days of signing, up to and including 16/03/2026 \n\nThis agreement is for monitoring of the above installation  address only . The Customer agrees to pay  the monthly  monitoring charge shown  above for \n\nthe minimum  term  stated, giving a total payable over the 24  month minimum  term  of £599.76. Northgate Home Security  will notify  the Customer in \n\nadvance of the annual maintenance visit. The alarm  signal is received and verified by  the Alarm  Receiving Centre named above before the Police are \n\nalerted under the Police URN shown , where applicable. This agreement may  be required by  the Customer's household insurer as a condition  of cover. \n\nTerms: The Customer may cancel this Agreement without charge within 14 days of the date of signing. After that period, cancellation before the end of the minimum \n\nterm is subject to payment of the outstanding monitoring charges for the remainder of the term. Any engineer visit not covered by this Agreement, including call- \n\nouts for false alarms caused by user error, will be charged at the Callout Charge shown above. The parts warranty on the control panel is provided by the \n\nmanufacturer and is separate from this monitoring Agreement. \n\nSignature of Customer  ·  D. Whitlock  ·  02/03/2026 Signature for Northgate Home Security  ·  D. Sutton \n\nPad  No. 004821 — Form  NGS/M3 \n\nCUSTOMER COPY · PINK \n\nNorthgate Home Security  ·  Contract NGS-CA-20456  ·  Pink copy retained by Customer\n",
    expected: {
    dates: ["2026-03-02","2027-03-02","2028-03-01"],
    provider: "Northgate Home Security",
    reference: "NGS-CA-20456",
    dateRoles: [
      { date: "2026-03-02", role: "start" },
      { date: "2027-03-02", role: "service" },
      { date: "2028-03-01", role: "renewal" },
    ],
    subtype: {"kinds":["Contract","Maintenance contract"],"qualifiers":["Security","Home"]},
    costMinor: 2499,
    currency: "GBP",
    recurrenceMonths: 24,
    scheduleKind: "renewal",
    },
  },
  {
    // Ground-truth notes:
    // - Declared date: 'your next service is due on 14 October 2026', repeated on the slip as 'Next service due 14/10/2026' — role service.
    // - Declared recurrence: 'your boiler and controls are serviced every 12 months' — recurrenceMonths 12, scheduleKind service.
    // - Declared provider: the letterhead brand 'HEARTHWELL HOME CARE', repeated in the reference box and slip.
    // - Declared reference: 'Plan reference: HHC-4471-2298', repeated identically on the slip.
    // - Declared cost: the slip's 'This month's instalment £14.99' — costMinor 1499, currency GBP.
    // - Trap: 'Date of this letter: 2 September 2026' is the letter's own date, not the service date.
    // - Trap: 'Your last visit was on 16 October 2025' is the previous service, not the one due.
    // - Trap: 'Thermex Pro 30 boiler (installed 2019)' gives an installation year and model, not a date to extract.
    // - Trap: 'please telephone us within 28 days of the date of this letter' is a call-by window, not a due date.
    // - Trap: 'Gas Safe registered engineers (registration number 745213)' is the engineer's registration, not the plan reference.
    // - Trap: 'non-members pay a callout charge of £90' prices a different audience's callout, not the plan cost.
    // - Trap: 'this service would otherwise cost £148 if booked separately from the plan' is the non-plan price.
    // - Trap: the slip's 'Annual total if paid monthly £179.88' is the yearly total, not the monthly instalment.
    // - Trap: 'collected on the 1st of each month' is the Direct Debit collection day, not a service date.
    // - Trap: 'Hearthwell Home Care is a trading name of Castlemere Assurance Group plc' names the parent company, a rival provider candidate.
    // - Trap: 'call our 24-hour emergency line on 01632 960455' is a different phone number from the booking line 01632 960112.
    name: "Boiler service plan letter",
    filename: "boiler-service-plan-letter.pdf",
    text: "Boiler Service Plan Letter  \n\nHEARTHWELL HOME CARE BO I L ER  &  CONTROLS  COVER \n\nPlan reference: HHC-4471-2298 \n\nAccount no: 3300 5521 \n\nDate of this letter: 2 September 2026 \n\nMr J. Whitfield \n\n14 Sycamore Close \n\nHallowfield \n\nHF3 2QT \n\nDear Mr Whitfield, \n\nYour annual boiler service is due \n\nAs a member of the Hearthwell Home Care plan, your boiler and controls are serviced every 12 months. Our records \n\nshow that your next service is due on 14 October 2026. \n\nOne of our Gas Safe registered engineers (registration number 745213) will call to carry out the service. Your last visit \n\nwas on 16 October 2025, when your Thermex Pro 30 boiler (installed 2019) was found to be in good working order. \n\nTo book your appointment, please telephone us within 28 days of the date of this letter on 01632 960112. If you do not \n\nhear from us within that time, please call anyway, as our booking lines are frequently busy at this time of year. \n\nYour plan covers your boiler and controls, and is paid monthly by Direct Debit, collected on the 1st of each month. \n\nMembers are not charged a callout fee for their annual service; non-members pay a callout charge of £90, and this \n\nservice would otherwise cost £148 if booked separately from the plan. \n\nIf your boiler breaks down before your service date, please do not use the number above — call our 24-hour emergency \n\nline on 01632 960455 instead. \n\nYours sincerely, \n\nHearthwell Home Care Customer Services \n\non behalf of the Hearthwell Home Care team \n\nHearthwell Home Care is a trading name of Castlemere Assurance Group plc, registered in England and Wales. Registered office: 8 Foundry Row, \n\nHallowfield, HF1 9AB. \n\n✂  please detach and return the slip below with your payment \n\nBoiler Care Plan — Payment Slip \n\nPLAN REFERENCE \n\nHHC-4471-2298 \n\nNEXT SERVICE DUE \n\n14/10/2026 \n\nTHIS MONTH 'S INSTALMENT \n\n£14.99 \n\nANNUAL TOTAL IF PAID  MONTHLY \n\n£179.88 \n\n⑆  4 4 7 1  2 2 98  07  ⑆  00 1 4 99  ⑆ \n\nPlease quote your plan reference on all correspondence and payments.\n",
    expected: {
    dates: ["2026-10-14"],
    provider: "Hearthwell Home Care",
    reference: "HHC-4471-2298",
    dateRoles: [
      { date: "2026-10-14", role: "service" },
    ],
    subtype: {"kinds":["Maintenance contract","Plan","Service"],"qualifiers":["Boiler","Home"]},
    costMinor: 1499,
    currency: "GBP",
    recurrenceMonths: 12,
    scheduleKind: "service",
    },
  },
  {
    // Ground-truth notes:
    // - dates: agreement date 20 February 2026 printed as 'Agreement date: 20 February 2026' (role start), and optional final payment date 5 March 2030 printed in the financial table row 'Optional final payment (due 5 March 2030)' (role renewal).
    // - provider is the finance house the household pays and contacts, Bracken Vale Finance plc, not the dealer.
    // - reference is the agreement number printed top right as 'BVF-PCP-208841'.
    // - costMinor is the monthly payment '£279.42' i.e. 27942 pence.
    // - recurrenceMonths 48 printed as 'Number of monthly payments: 48'.
    // - scheduleKind renewal reflects the optional final payment / balloon structure ending 5 March 2030.
    // - trap: cash price of the vehicle '£18,995.00'.
    // - trap: deposit '£2,500.00' and part-exchange allowance '£1,200.00'.
    // - trap: total amount payable '£24,730.16'.
    // - trap: optional final payment amount '£8,245.00'.
    // - trap: representative APR '10.9% APR' and fixed rate of interest '7.5% per annum'.
    // - trap: date of first payment '05/04/2026'.
    // - trap: 14-day right to withdraw, 'You may withdraw from this agreement ... within 14 days'.
    // - trap: annual mileage allowance '8,000 miles' and excess mileage charge '6p per mile'.
    // - trap: option-to-purchase fee '£10.00'.
    // - trap: dealer name, address and own reference, 'Thornfield Motors Limited ... Dealer reference: TM-CAR-55021'.
    // - trap: vehicle registration 'OV72 KLM', first registered '14/06/2022' and mileage '21,340 miles'.
    // - trap: FCA authorisation sentence naming FRN 305512.
    // - trap: company number '04471822'.
    name: "Personal Contract Purchase Agreement - Bracken Vale Finance",
    filename: "car-finance-agreement.pdf",
    text: "Personal Contract Purchase Agreement  \n\nPERSONAL CONTRACT PURCHASE AGREEMENT \n\nRegulated by the Consumer Credit Act 1974 \n\nAgreement date: 20 February 2026 \n\nAgreement number \n\nBVF-PCP-208841 \n\nCREDITOR (LENDER) \n\nBracken Vale Finance plc 1 Millrace House, Doverton DV4 7QS Company number 04471822 Authorised and regulated by the Financial Conduct Authority, FRN 305512. Customer Service: 01632 960228 \n\nSUPPLIER (DEALER) \n\nThornfield Motors Limited Unit 4, Ferrymead Trading Estate, Kelverton KV11 9RT Dealer reference: TM-CAR-55021 Tel: 01632 960117 \n\nCUSTOMER \n\nMr David Coulson 14 Sycamore Grove, Wakemoor WM2 8LN \n\nFinancial details \n\nCash price of the vehicle £18,995.00 \n\nCash deposit £2,500.00 \n\nPart-exchange allowance £1,200.00 \n\nAmount of credit £15,295.00 \n\nFixed rate of interest 7.5% per annum \n\nRepresentative APR 10.9% APR \n\nDuration of agreement 49 months \n\nNumber of monthly payments 48 \n\nAmount of each monthly payment £279.42 \n\nDate of first payment 05/04/2026 \n\nOptional final payment (due 5 March 2030) £8,245.00 \n\nTotal amount payable £24,730.16 \n\nOption-to-purchase fee (payable with final payment) £10.00 \n\nYOUR RIGHT TO WITHDRAW \n\nYou may withdraw from this agreement without giving any reason within 14 days of the date the agreement is signed. Contact Bracken Vale Finance plc on 01632 960228 to withdraw. \n\nMISSING PAYMENTS \n\nMissing payments could affect your credit rating and your ability to obtain credit in future. If you fall behind, contact us straight away on 01632 960228. \n\nTERMINATION: YOUR RIGHTS \n\nYou may end this agreement at any time before the final payment is due by giving notice in writing to Bracken Vale Finance plc and returning the vehicle. \n\nVEHICLE TO BE SUPPLIED \n\nMake/model: Marenta Vela 1.5 TSi Registration: OV72 KLM First registered: 14/06/2022 \n\nMileage at supply: 21,340 miles Colour: Pure Grey Dealer stock ref: TM-CAR-55021 \n\nAnnual mileage allowance: 8,000 miles. Excess mileage charge: 6p per mile over the allowance, payable at the end of the agreement. \n\nBracken Vale Finance plc — Agreement BVF-PCP-208841 Page 1 of 2\n\nPERSONAL CONTRACT PURCHASE AGREEMENT (continued) \n\nBracken Vale Finance plc \n\nAgreement number \n\nBVF-PCP-208841 \n\nUSE OF THE VEHICLE \n\nThe vehicle must be kept in the United Kingdom unless we agree otherwise in \n\nwriting, and must be taxed, insured and maintained by you throughout the \n\nagreement. \n\nThe annual mileage allowance under this agreement is 8,000 miles. Mileage \n\nrecorded in excess of the allowance at the end of the agreement will be \n\ncharged at 6p per mile. \n\nOPTIONAL FINAL PAYMENT \n\nIf you wish to keep the vehicle at the end of the agreement, you may pay the \n\noptional final payment of £8,245.00, due 5 March 2030, together with an \n\noption-to-purchase fee of £10.00. \n\nOWNERSHIP \n\nThe vehicle remains the property of Bracken Vale Finance plc until all sums \n\ndue under this agreement, including any optional final payment, have been \n\npaid in full. \n\nINSURANCE AND MAINTENANCE \n\nYou must insure the vehicle comprehensively at your own expense and \n\nmaintain it in accordance with the manufacturer's service schedule. \n\nTERMINATION CHARGES \n\nIf this agreement is terminated early, you may be required to pay the \n\ndifference between payments already made and 50% of the total amount \n\npayable, subject to fair wear and tear. \n\nCOMPLAINTS \n\nAny complaint about this agreement should be addressed in the first instance \n\nto Bracken Vale Finance plc, 1 Millrace House, Doverton DV4 7QS. \n\nThornfield Motors Limited cannot amend the terms of this agreement. \n\nRIGHT TO WITHDRAW — REMINDER \n\nYour right to withdraw within 14 days is described on page 1 of this agreement. \n\nCustomer signature & date Authorised signatory, Bracken Vale Finance plc & date \n\nBracken Vale Finance plc is authorised and regulated by the Financial Conduct Authority (FRN 305512) and is registered in England and Wales, company number 04471822. Registered office: 1 Millrace House, Doverton DV4 7QS. \n\nBracken Vale Finance plc — Agreement BVF-PCP-208841 Page 2 of 2\n",
    expected: {
    dates: ["2026-02-20","2030-03-05"],
    provider: "Bracken Vale Finance plc",
    reference: "BVF-PCP-208841",
    dateRoles: [
      { date: "2026-02-20", role: "start" },
      { date: "2030-03-05", role: "renewal" },
    ],
    subtype: {"kinds":["Loan","Contract"],"qualifiers":["Motor"]},
    costMinor: 27942,
    currency: "GBP",
    recurrenceMonths: 48,
    scheduleKind: "renewal",
    },
  },
  {
    // Ground-truth notes:
    // - dates: quote date printed as 'Quote date: 6 October 2026' (role issued) and printed as 'Valid until: 6 November 2026' (role expiry).
    // - provider is the advice firm that prepared and would administer the cover, Amberleigh Financial Advisers Ltd, not the underwriter Carrick Life Assurance plc.
    // - reference is the quote reference 'AMB-CI-2026-77410' printed on page 1 and repeated on the reply slip.
    // - costMinor is the recommended Option B monthly premium '£34.62' i.e. 3462 pence.
    // - trap: sum assured '£150,000'.
    // - trap: term of 25 years and cover ending in 2051, 'with cover ending in 2051'.
    // - trap: total premiums payable over the term '£10,386.00'.
    // - trap: alternative Option A premium '£28.15' and Option C premium '£41.90'.
    // - trap: 'Reply by 31 October 2026 to hold this price'.
    // - trap: proposed policy start date '1 December 2026'.
    // - trap: insurer's name 'Carrick Life Assurance plc'.
    // - trap: adviser's name, phone number and firm's FCA reference, 'Mr Callum Ridgeway ... telephone 01632 960482 ... FCA Reg No. 558214'.
    // - trap: survival period 'the survival period of 14 days from diagnosis'.
    // - trap: generic competitor comparison 'could cost up to 15% less than a typical high-street provider's equivalent cover'.
    name: "Critical Illness Cover - Personal Quotation for Mrs Joanne Pickering",
    filename: "critical-illness-quote.pdf",
    text: "Critical Illness Cover - Personal Quotation  \n\nProtecting what matters \n\nQuotation prepared for: Mrs Joanne Pickering 12 Fenwick Road, Netherbourne NB6 5DA \n\nQuote reference: AMB-CI-2026-77410 Quote date: 6 October 2026 Valid until: 6 November 2026 \n\nCover underwritten by Carrick Life Assurance plc. Sum assured: £150,000 over a term of 25 years. \n\nOPTION A OPTION B — RECOMMENDED OPTION C \n\nSum assured £100,000 £150,000 £200,000 \n\nTerm 25 years 25 years 25 years \n\nYour monthly premium £28.15 £34.62 £41.90 \n\nOption B is the option recommended by your adviser and shown throughout this illustration as your quote. Based on a 25-year term, total premiums payable under Option B would be £10,386.00, with cover ending in 2051. \n\nWhat critical illness cover pays for \n\nA lump sum on diagnosis \n\nPays £150,000 if you are diagnosed with a \n\ncovered condition and survive the survival period of 14 days from diagnosis. \n\nCovered conditions \n\nIncludes heart attack, stroke, certain cancers, \n\nand other specified illnesses as set out in the policy conditions. \n\nValue for money \n\nThis plan could cost up to 15% less than a \n\ntypical high-street provider's equivalent cover over the same term. \n\nWhat is not covered \n\nConditions diagnosed before the policy start date, self-inflicted injury, and conditions not meeting the definitions set out in the policy document are not covered. \n\nNo claim is payable for a condition not surviving the 14-day survival period. \n\nYOUR  PE RSONA L  I LLUSTRAT ION \n\nA critical illness quotation prepared for you by Amberleigh Financial Advisers Ltd \n\nAmberleigh Financial Advisers Ltd — Quote AMB-CI-2026-77410 Page 1 of 2\n\nYour adviser and next steps \n\nYour quotation was prepared by Mr Callum Ridgeway of Amberleigh Financial Advisers Ltd, telephone 01632 960482. Amberleigh Financial \n\nAdvisers Ltd is authorised and regulated by the Financial Conduct Authority, FCA Reg No. 558214. \n\nIf you would like to proceed, your proposed policy start date would be 1 December 2026. Reply by 31 October 2026 to hold this price — premiums shown are not guaranteed after that date. \n\nCover would be provided by Carrick Life Assurance plc, but your plan is arranged and administered by Amberleigh Financial Advisers Ltd, who you should contact with any questions about this quotation or a future claim. \n\nReply slip — return to hold your quote \n\nI would like to proceed with Option B, monthly premium £34.62, quote reference AMB-CI-2026-77410. \n\nSignature \n\nDate \n\nFREEPOST AMBERLEIGH ADVISERS \n\nNo stamp required \n\nThis is a quotation only and does not create a contract of insurance. Cover is subject to underwriting and acceptance by Carrick Life Assurance plc. Amberleigh Financial Advisers \n\nLtd, registered in England and Wales, 9 Quayside Court, Netherbourne NB1 3DE. Critical illness cover pays out once during the life of the policy for a covered condition, subject to \n\nthe 14-day survival period and the policy definitions. Premiums are not guaranteed to remain unchanged for the whole term. \n\nAmberleigh Financial Advisers Ltd — Quote AMB-CI-2026-77410 Page 2 of 2\n",
    expected: {
    dates: ["2026-10-06","2026-11-06"],
    provider: "Amberleigh Financial Advisers Ltd",
    reference: "AMB-CI-2026-77410",
    dateRoles: [
      { date: "2026-10-06", role: "issued" },
      { date: "2026-11-06", role: "expiry" },
    ],
    subtype: {"kinds":["Quote","Insurance"],"qualifiers":["Critical illness","Life"]},
    costMinor: 3462,
    currency: "GBP",
    },
  },
  {
    // Ground-truth notes:
    // - Registered on 18 January 2019 ('Registered on 18 January 2019') -- dateRoles start.
    // - Renews on 18 January 2027 ('Renews on 18 January 2027') -- dateRoles renewal.
    // - recurrenceMonths 12 printed as 'This domain renews every 12 months.'
    // - provider is the control-panel operator 'Foxglove Hosting', the registrar/hosting company.
    // - reference is the customer account number 'ACC-3348217'.
    // - costMinor is the plain domain renewal price 'Domain renewal (12 months) £12.99', not the VAT-inclusive total.
    // - subtype Domain+Subscription/Domain from the domain renewal control-panel content.
    // - Trap: hosting plan's own price and different renewal date 'Business Hosting Plan — £89.99 per year, renews 2 November 2026'.
    // - Trap: SSL certificate expiry 'Foxglove Domain SSL — expires 5 December 2026'.
    // - Trap: VAT-inclusive basket total 'Total due today £15.59', a rival amount to the plain renewal price.
    // - Trap: invoice number 'INV-2027-004471', a rival reference.
    // - Trap: domain ID 'D4471982-EXPL', another rival reference.
    // - Trap: DNS TTL '3600'.
    // - Trap: '60 days after registration or transfer' transfer restriction.
    // - Trap: price rising at next renewal 'From 18 January 2028 this domain is expected to renew at £14.99', a rival future date and amount.
    // - Trap: promotional price ending date 'Promotional price of £9.99 was available until 1 October 2026'.
    // - No password, API key or EPP/auth code is printed on this document.
    name: "Foxglove Hosting — Domain Renewal",
    filename: "domain-hosting-renewal.pdf",
    text: "Foxglove Hosting — Domain Renewal  \n\nhttps://panel.foxglovehosting.example/domains/brindlewood-supplies.example/renewal Printed 11 September 2026 \n\nHome / Domains / brindlewood-supplies.example / Renewal \n\nFoxglove Hosting brindlewood-supplies.example \n\nAccount number ACC-3348217 \n\nDomain brindlewood-supplies.example \n\nDomain ID D4471982-EXPL \n\nRegistered on 18 January 2019 \n\nRenews on 18 January 2027 \n\nRenewal period This domain renews every 12 months. \n\nAuto-renew On \n\nNameservers ns1.foxglovehosting.example \n\nns2.foxglovehosting.example \n\nDNS TTL 3600 \n\nThis domain cannot be transferred to another registrar until 60 days after registration or transfer. \n\nHosting plan Business Hosting Plan — £89.99 per year, renews 2 November 2026 \n\nSSL certificate Foxglove Domain SSL — expires 5 December 2026 \n\nPromotional price of £9.99 was available until 1 October 2026 for new domain registrations and \n\ndoes not apply to renewals of existing domains. \n\nDomain renewal prices are reviewed annually. From 18 January 2028 this domain is expected to \n\nrenew at £14.99. \n\nRenew now \n\nOrder Summary \n\nDomain renewal (12 months) £12.99 \n\nVAT (20%) £2.60 \n\nTotal due today £15.59 \n\nInvoice INV-2027-004471 will be issued once \n\npayment for this renewal is taken. \n\nFoxglove Hosting Limited. help@foxglovehosting.example. 01632 960118. Page 1 of 1\n",
    expected: {
    dates: ["2019-01-18","2027-01-18"],
    provider: "Foxglove Hosting",
    reference: "ACC-3348217",
    dateRoles: [
      { date: "2019-01-18", role: "start" },
      { date: "2027-01-18", role: "renewal" },
    ],
    subtype: {"kinds":["Domain","Subscription"],"qualifiers":["Domain"]},
    costMinor: 1299,
    currency: "GBP",
    recurrenceMonths: 12,
    scheduleKind: "renewal",
    },
  },
  {
    // Ground-truth notes:
    // - Declared issued date: 'Assessment date / certificate issued: 12 May 2026'.
    // - Declared expiry date: 'Valid until: 11 May 2036' and 'This certificate is valid for 10 years.'
    // - Declared provider: 'This certificate was produced by Greenline Energy Assessments Ltd', printed with its address and phone number as the firm to contact — not the accreditation scheme or the register.
    // - Declared reference: the RRN '8823-4471-9902-1156-3390', printed identically on both pages.
    // - No cost is declared: this document has no price, only cost estimates about the property.
    // - Trap: the cost panel's 'Per year £871', 'Over 3 years £2,614' and 'Potential saving £456 / year' are energy-cost estimates, not a price for the certificate.
    // - Trap: indicative improvement costs such as 'Solar water heating... £4,000–£6,000' price recommended work, not the certificate.
    // - Trap: 'Accredited by the Home Energy Assessors Scheme (HEAS)... lodged on the National Energy Performance Register (NEPR)' names the scheme and the register, both rival provider candidates.
    // - Trap: 'Assessor: Priya Nandakumar, membership number HEAS/2018/004471' is the individual assessor's own membership number, not the certificate reference.
    // - Trap: 'This property's previous certificate was issued on 4 April 2016' is an earlier, superseded certificate's date.
    // - Trap: 'Total floor area 94 m²' is a property detail, not a date or reference.
    // - Trap: 'Year built 1938' is the property's age, not the certificate's issue date.
    // - Trap: 'call the national helpline on 01632 960900' is a different phone number from the assessment firm's own 01632 960777.
    name: "Energy Performance Certificate",
    filename: "energy-performance-certificate.pdf",
    text: "Energy Performance Certificate  \n\nEnergy Performance Certificate \n\n24 Larkspur Avenue, Hallowfield, HF3 4RT \n\nReport Reference Number \n\n8823-4471-9902-1156-3390 \n\nAssessment date / certificate issued: 12 May 2026 Valid until: 11 May 2036 This certificate is valid for 10 years. \n\nEnergy efficiency rating \n\nA 92–100 \n\nB 81–91 POTENTIAL 84 · B \n\nC 69–80 \n\nD 55–68 CURRENT 63 · D \n\nE 39–54 \n\nF 21–38 \n\nG 1–20 \n\nEstimated energy costs for this property \n\nPER Y EAR \n\n£871 OVER 3  Y EARS \n\n£2,614 POTENTI AL SAVI NG \n\n£456 / year \n\nProperty summary \n\nDwelling type Mid-terrace house Total floor area 94 m² \n\nWalls Cavity, filled Year built 1938 \n\nRoof Pitched, 150mm loft insulation Main heating \n\nGas boiler, radiators \n\nFloor Suspended, no insulation \n\nHot water From main system \n\nWindows Fully double glazed \n\nLighting 62% low energy bulbs \n\n24 Larkspur Avenue, Hallowfield, HF3 4RT — RRN 8823-4471-9902-1156-3390 Page 1 of 2\n\nEnergy Performance Certificate \n\n24 Larkspur Avenue, Hallowfield, HF3 4RT \n\nReport Reference Number \n\n8823-4471-9902-1156-3390 \n\nRecommended improvements \n\nIMPROVEMENT TYPICAL SAVING INDICATIVE COST \n\nTop up loft insulation to 270mm £26 / year £100–£350 \n\nCavity wall insulation top-up £115 / year £500–£1,500 \n\nSuspended floor insulation £62 / year £800–£1,200 \n\nSolar water heating £48 / year £4,000–£6,000 \n\nSolar photovoltaic panels, 2.5 kWp £270 / year £3,500–£5,500 \n\nAssessor and accreditation \n\nThis certificate was produced by Greenline Energy Assessments Ltd, 12 Riverside Court, Hallowfield, HF4 7QP. Telephone 01632 960777. \n\nAssessor: Priya Nandakumar, membership number HEAS/2018/004471. \n\nAccredited by the Home Energy Assessors Scheme (HEAS). This certificate has been lodged on the National Energy Performance Register (NEPR). \n\nThis property's previous certificate was issued on 4 April 2016. \n\nFor general information about Energy Performance Certificates, call the national helpline on 01632 960900. \n\nAbout this certificate \n\nThis certificate records how energy efficient a property is as a building, rather than how it is used and run by the people living in it. It gives a rating from A (most efficient) to G (least \n\nefficient). The estimated energy costs shown are calculated using standard assumptions about occupancy and heating patterns, and actual costs will depend on how the property is \n\nused. \n\nThe recommendations above are generic measures for a property of this type and construction. Indicative costs are approximate and will vary according to the installer chosen, the \n\nspecification of materials and local conditions. \n\n24 Larkspur Avenue, Hallowfield, HF3 4RT — RRN 8823-4471-9902-1156-3390 Page 2 of 2\n",
    expected: {
    dates: ["2026-05-12","2036-05-11"],
    provider: "Greenline Energy Assessments Ltd",
    reference: "8823-4471-9902-1156-3390",
    dateRoles: [
      { date: "2026-05-12", role: "issued" },
      { date: "2036-05-11", role: "expiry" },
    ],
    subtype: {"kinds":["Certificate","Inspection"],"qualifiers":["Energy performance","Home"]},
    },
  },
  {
    // Ground-truth notes:
    // - dates: invoice date printed as 'Invoice date: 02/09/2026' (role issued) and due date printed as 'Due date: 15/09/2026' (role due).
    // - provider is the nursery itself, 'Little Acorns Day Nursery', not the 'Bramblewood Childcare Group' it belongs to.
    // - reference is the account number '1044829', printed in the invoice grid and repeated in the remittance panel, not the invoice number.
    // - costMinor is the total payable '£1,087.60' i.e. 108760 pence.
    // - trap: invoice number 'INV-045821'.
    // - trap: session rate '£68.50 / day'.
    // - trap: funded-hours credit shown as a negative amount '−£190.40'.
    // - trap: balance brought forward from August 2026 '£45.00'.
    // - trap: late payment charge 'A late payment charge of £25.00 applies to any balance left unpaid 7 days after the due date'.
    // - trap: autumn term dates '2 September 2026 to 18 December 2026'.
    // - trap: fee increase notice 'fees will increase from 1 January 2027'.
    // - trap: registration fee mention 'Registration fees (one-off, charged on enrolment) are non-refundable'.
    // - trap: the group's name 'Bramblewood Childcare Group'.
    // - trap: early years registration number 'EY-558214'.
    // - trap: bank details 'Sort code: 40-51-62, Account number: 20194837'.
    name: "Little Acorns Day Nursery - September 2026 fees invoice",
    filename: "nursery-fees-invoice.pdf",
    text: "Little Acorns Day Nursery - Invoice  \n\nLittle Acorns Day Nursery part of the Bramblewood Childcare Group \n\n22 Orchard Lane, Bexdale BX3 7QL \n\nTel: 01632 960774  |  billing@littleacorns-bexdale.example \n\nEarly years registration: EY-558214 \n\nInvoice number INV-045821 \n\nAccount number 1044829 \n\nInvoice date 02/09/2026 \n\nDue date 15/09/2026 \n\nChild Freddie Marsh \n\nFEES FOR SEPTEMBER 2026 \n\nDESCRIPTION QTY RATE AMOUNT \n\nFull day sessions (8:00–18:00), 18 days 18 £68.50 / day £1,233.00 \n\nFunded hours credit (15 hrs/week government funding) – – −£190.40 \n\nBalance brought forward from August 2026 – – £45.00 \n\nSubtotal £1,087.60 \n\nTotal payable £1,087.60 \n\nAutumn term dates: 2 September 2026 to 18 December 2026. \n\nPlease note: fees will increase from 1 January 2027. Revised rates will be sent separately. \n\nA late payment charge of £25.00 applies to any balance left unpaid 7 days after the due date. \n\nRegistration fees (one-off, charged on enrolment) are non-refundable and are not included on this invoice. \n\nChildcare vouchers: we accept salary-sacrifice childcare vouchers. Please ask your voucher provider to quote account number 1044829. \n\nREMITTANCE ADVICE \n\nPay to: Little Acorns Day Nursery \n\nSort code: 40-51-62 \n\nAccount number: 20194837 \n\nReference: 1044829 \n\nAmount due: £1,087.60 \n\nDue date: 15 September 2026 \n\nPlease quote your account number 1044829 with all payments.\n",
    expected: {
    dates: ["2026-09-02","2026-09-15"],
    provider: "Little Acorns Day Nursery",
    reference: "1044829",
    dateRoles: [
      { date: "2026-09-02", role: "issued" },
      { date: "2026-09-15", role: "due" },
    ],
    subtype: {"kinds":["Fees","Bill"],"qualifiers":["Childcare"]},
    costMinor: 108760,
    currency: "GBP",
    },
  },
  {
    // Ground-truth notes:
    // - Cover starts 1 April 2026 ('Cover starts: 1 April 2026') -- dateRoles start.
    // - Renewal date 1 April 2027 ('Your renewal date is 1 April 2027') -- dateRoles renewal.
    // - recurrenceMonths 12 printed as 'This is a 12 month policy.'
    // - provider is the trading name that sells and administers ('THORNBURY PET COVER' banner), not the parent it is a trading name of and not the underwriter.
    // - reference is the policy number 'TPC-2026-0447182'.
    // - costMinor is the annual premium 'Annual premium (paid in full): £287.64.'
    // - subtype Insurance/Pet from the 'Thornbury Pet Cover' pet insurance schedule content.
    // - Trap: cover end date 31 March 2027 printed as 'Cover ends: 31 March 2027', a plausible wrong renewal/expiry date.
    // - Trap: direct debit collection date 'collected by direct debit on the 1st of each month'.
    // - Trap: pet's date of birth '14 June 2019', a plausible wrong start date.
    // - Trap: microchip date '2 July 2019', another plausible wrong date.
    // - Trap: 14-day cooling-off period ('You have a 14-day cooling-off period'), a rival number to recurrenceMonths.
    // - Trap: vet fee limit '£7,500', a plausible wrong costMinor.
    // - Trap: excess 'An excess of £95 applies per condition'.
    // - Trap: monthly instalment price '£26.15' and the higher 'Total payable if you pay monthly: £313.80', both rival amounts to the annual premium.
    // - Trap: separate quotation reference 'Q-8820193', a rival reference.
    // - Trap: parent 'Millbrace Insurance Services Limited' and underwriter 'Coldharbour Insurance Limited', both rival providers.
    // - Trap: company number '04471829' and VAT number 'GB 774 4471 82', rival reference-shaped numbers.
    name: "Thornbury Pet Cover — Policy Schedule",
    filename: "pet-insurance-schedule.pdf",
    text: "Thornbury Pet Cover — Policy Schedule  \n\nTHORNBURY PET COVER Thornbury Pet Cover is a trading name of Millbrace Insurance Services Limited. \n\nPolicies are underwritten by Coldharbour Insurance Limited. \n\nPOLICY  SCHEDULE \n\nPOLICYHOLDER Mrs Eleanor Whitfield \n\nADDRESS 14 Sycamore Grove, Bramfield, \n\nBF12 4QW \n\nPOLICY NUMBER TPC-2026-0447182 \n\nQUOTATION REF. Q-8820193 \n\nPET'S NAME Bramble \n\nSPECIES / BREED Dog — Cocker Spaniel \n\nSEX Male, neutered \n\nDATE OF BIRTH 14 June 2019 \n\nMICROCHIP NUMBER 900215001234567 \n\nMICROCHIP DATE 2 July 2019 \n\nPERIOD OF COVER \n\nCover starts: 1 April 2026. Cover ends: 31 March 2027. \n\nThis is a 12 month policy. \n\nYour renewal date is 1 April 2027. \n\nPREMIUM AND PAYMENT \n\nAnnual premium (paid in full): £287.64. \n\nAlternatively, pay by 12 monthly instalments of £26.15, collected by direct debit on the 1st of each month. Total payable if you \n\npay monthly: £313.80. \n\nBENEFITS SUMMARY \n\nBenefit Limit \n\nVet fees, per condition per year £7,500 \n\nComplementary treatment £500 per year \n\nThird-party liability (dogs only) £1,000,000 \n\nDeath of your pet from illness or injury up to £2,000 \n\nOverseas travel (up to 30 days) £1,000 \n\nAdvertising and reward if your pet goes missing £750 \n\nBoarding fees if you are hospitalised £500 \n\nAn excess of £95 applies per condition, per year of insurance, and is payable towards each claim. \n\nThornbury Pet Cover, PO Box 4471, Bramfield, BF1 9ZZ. Telephone 01632 960221. Page 1 of 2\n\nTHORNBURY PET COVER — POLICY SCHEDULE (continued) Policy number: TPC-2026-0447182 \n\nWHAT IS NOT COVERED \n\nThis policy does not cover: pre-existing conditions present or showing signs before 1 April 2026; routine or preventive treatment, including \n\nvaccinations and worming; dental treatment unless the optional dental add-on is shown on this schedule; costs arising from breeding or \n\npregnancy; cosmetic procedures; and claims made after the period of cover shown above has ended. \n\nHOW TO CLAIM \n\nSubmit your claim form within 30 days of treatment, together with the itemised invoice from your vet. Claims line: 0808 157 0142. Quote your \n\nclaims reference, which begins TPC-CLM- followed by your policy number. \n\nYOUR RIGHT TO CANCEL \n\nYou have a 14-day cooling-off period, starting on the day the policy begins or the day you receive your policy documents, whichever is later. If you \n\ncancel after this period, a proportional charge for the time you have been covered will apply, and any instalments already collected are non- \n\nrefundable in part. \n\nCOMPLAINTS \n\nIf you are unhappy with our service, write to the Customer Relations Team at the address below. If we cannot resolve things to your satisfaction, \n\nyou may refer your complaint to the Financial Ombudsman Service. \n\nREGULATORY  AND COMPANY  INFORMATION \n\nThornbury Pet Cover is authorised and regulated by the Financial Conduct Authority. Coldharbour Insurance Limited, the underwriter of this \n\npolicy, is authorised and regulated by the Financial Conduct Authority. Millbrace Insurance Services Limited is registered in England and Wales, \n\ncompany number 04471829. VAT registration number GB 774 4471 82. \n\nYour quotation reference was Q-8820193. Please keep this schedule with your policy documents. \n\nThornbury Pet Cover, PO Box 4471, Bramfield, BF1 9ZZ. help@thornburypet.example Page 2 of 2\n",
    expected: {
    dates: ["2026-04-01","2027-04-01"],
    provider: "Thornbury Pet Cover",
    reference: "TPC-2026-0447182",
    dateRoles: [
      { date: "2026-04-01", role: "start" },
      { date: "2027-04-01", role: "renewal" },
    ],
    subtype: {"kinds":["Insurance"],"qualifiers":["Pet"]},
    costMinor: 28764,
    currency: "GBP",
    recurrenceMonths: 12,
    scheduleKind: "renewal",
    },
  },
  {
    // Ground-truth notes:
    // - Ticket valid from 01/09/2026 ('VALID FROM 01/09/2026') -- dateRoles start.
    // - Ticket valid until 31/08/2027 ('VALID UNTIL 31/08/2027') -- dateRoles expiry.
    // - No scheduleKind or recurrenceMonths declared: an annual season ticket does not print a recurring instalment count.
    // - provider is the issuing train operator 'ISSUED BY CHEDDLETON RAIL', who would be contacted.
    // - reference is the season ticket number 'ST-0294817-6'.
    // - costMinor is the price paid, 'Annual season ticket £3,412.00'.
    // - subtype Season ticket/Transport from the annual rail season ticket content.
    // - Trap: date of purchase 'Date of purchase: 24 August 2026', a plausible wrong start date.
    // - Trap: photocard number 'PHOTOCARD PC 552013847' with its own different expiry 'EXPIRES 14/02/2028'.
    // - Trap: delay compensation line 'Claims for delay compensation must be submitted within 28 days'.
    // - Trap: equivalent monthly price '£322.50', a rival amount to the annual cost.
    // - Trap: first class upgrade price '£5,120.00 per year', another rival amount.
    // - Trap: refund administration fee '£10.00', another rival amount.
    // - Trap: industry body name 'the Interoperator Ticketing Council', a rival organisation to the operator.
    // - Trap: station names 'MILLBROOK CROSS' and 'FENWICK PARKWAY'.
    // - Trap: railcard discount code 'RC-229104', a rival reference-shaped code.
    name: "Cheddleton Rail — Annual Season Ticket",
    filename: "rail-season-ticket.pdf",
    text: "Cheddleton Rail — Season Ticket  \n\nANNUAL SEASON TICKET \n\nTICKET NO. ST-0294817-6 \n\nFROM MILLBROOK CROSS \n\nTO FENWICK PARKWAY \n\nROUTE ANY PERMITTED \n\nVALID FROM 01/09/2026 \n\nVALID UNTIL 31/08/2027 \n\nCLASS STANDARD \n\nRAILCARD COASTWAY SAVER RC-229104 \n\nISSUED BY CHEDDLETON RAIL \n\nPHOTOCARD PC 552013847   —   EXPIRES 14/02/2028 \n\nTICKET OFFICE  RECEIPT \n\nIssued at Millbrook Cross ticket office — till 4, agent ID 118. \n\nDate of purchase: 24 August 2026. \n\nItem: Annual Season Ticket, Millbrook Cross to Fenwick Parkway, Standard Class. \n\nRailcard discount applied: Coastway Saver Railcard, code RC-229104. \n\nAnnual season ticket £3,412.00 \n\nEquivalent monthly price (for comparison only) £322.50 \n\nFirst class upgrade, per year, if purchased separately £5,120.00 \n\nRefund administration fee (applies to any refund) £10.00 \n\nPayment method: debit card ending 4471. Amount charged today: £3,412.00. \n\nCONDITIONS OF USE \n\nThis ticket is issued subject to Cheddleton Rail's Conditions of Carriage and the rules of the Interoperator Ticketing Council. It is not \n\ntransferable and must be produced, together with your photocard, whenever asked by railway staff. If your photocard is lost or damaged, a \n\nreplacement must be obtained before you travel; your photocard shown above expires separately from this season ticket. \n\nClaims for delay compensation must be submitted within 28 days of the date of travel affected, quoting your season ticket number. \n\nRefunds on unused season tickets are calculated on a daily basis from the date the ticket is returned, less the refund administration fee \n\nshown above. \n\nCheddleton Rail. Lost photocards: 01632 960774. www.cheddletonrail.example\n",
    expected: {
    dates: ["2026-09-01","2027-08-31"],
    provider: "Cheddleton Rail",
    reference: "ST-0294817-6",
    dateRoles: [
      { date: "2026-09-01", role: "start" },
      { date: "2027-08-31", role: "expiry" },
    ],
    subtype: {"kinds":["Season ticket"],"qualifiers":["Transport"]},
    costMinor: 341200,
    currency: "GBP",
    },
  },
  {
    // Ground-truth notes:
    // - Declared start date: the permit panel's 'Valid from 01/07/2026'.
    // - Declared expiry date: the permit panel's 'Expires 30/06/2027'.
    // - Declared provider: 'MARCHFORD BOROUGH COUNCIL — PARKING SERVICES', named throughout the permit and covering notice.
    // - Declared reference: the permit panel's 'Permit number RP-2026-118824'.
    // - Declared cost: the permit panel's 'Annual permit fee paid: £45.00' — costMinor 4500, currency GBP.
    // - Trap: 'We received your application on 14 June 2026 and your permit was issued on 22 June 2026' are processing dates, not the validity window.
    // - Trap: the vehicle details table's 'Vehicle tax due 01/09/2026' and 'MOT expiry 14/03/2027' are vehicle dates, not permit dates.
    // - Trap: 'A second permit for another vehicle at this household costs £90.00 per year' prices a different permit.
    // - Trap: 'A book of 20 visitor permits... costs £25.00' prices a different product entirely.
    // - Trap: 'Penalty Charge Notice of £70, reduced to £35 if paid within 14 days' is a fine, not the permit fee.
    // - Trap: 'Zone F restrictions operate Monday to Saturday, 8:30am to 6:30pm' is the zone's operating hours, not part of the permit's own dates.
    // - Trap: 'Permits... are printed and posted on the council's behalf by Northgate Civic Services Ltd' names a contractor, not the issuing provider.
    // - Trap: 'issued on production of a Council Tax bill dated 3 June 2026' is a proof-of-residency document with its own date.
    name: "Residents' parking permit",
    filename: "residents-parking-permit.pdf",
    text: "Residents Parking Permit  \n\nCovering notice — your residents' parking permit Council ref: PKS/2026/07182 \n\nDear Mr Whitfield, \n\nWe received your application on 14 June 2026 and your permit was issued on 22 June 2026, on production of a \n\nCouncil Tax bill dated 3 June 2026 as proof of residency. Your permit is enclosed above; please detach it along the \n\nperforation and display it flat on your dashboard so that the registration and expiry date are clearly visible through the \n\nwindscreen. \n\nVehicle details held on file \n\nRegistration LT19 KXM \n\nVehicle tax due 01/09/2026 \n\nMOT expiry 14/03/2027 \n\nZone F rules \n\nThis permit is valid only for parking within Zone F — Marchford North, in marked resident bays. \n\nZone F restrictions operate Monday to Saturday, 8:30am to 6:30pm. Parking is unrestricted outside these hours. \n\nA second permit for another vehicle at this household costs £90.00 per year. \n\nA book of 20 visitor permits, for guests without their own permit, costs £25.00. \n\nVehicles parked in Zone F without a valid permit displayed may receive a Penalty Charge Notice of £70, reduced to \n\n£35 if paid within 14 days. \n\nIf your details change \n\nTell us straight away if you change your vehicle or move address, so your permit can be reissued. Write to Marchford \n\nBorough Council, Parking Services, 40 Guildhall Square, Marchford, MF2 1AA, call 01632 960223, or email \n\nparking@marchford.example. \n\nPermits for Marchford Borough Council are printed and posted on the council's behalf by Northgate Civic Services Ltd. This notice is not a VAT invoice. \n\nMARCHFORD BOROUGH COUNCIL — PARKING SERVICES RES IDENT  PERM IT \n\nZONE F — MARCHFORD NORTH \n\nVEHICLE  REG ISTRATION \n\nLT19 KXM PERMIT  NUMBER \n\nRP-2026-118824 VEHICLE  MAKE/MODEL \n\nFORD FOCUS \n\nVAL ID  FROM \n\n01/07/2026 EXPIRES \n\n30/06/2027 \n\nAnnual permit fee paid: £45.00 \n\n✂  detach along this line  and display in the  windscreen,  facing outward\n",
    expected: {
    dates: ["2026-07-01","2027-06-30"],
    provider: "Marchford Borough Council",
    reference: "RP-2026-118824",
    dateRoles: [
      { date: "2026-07-01", role: "start" },
      { date: "2027-06-30", role: "expiry" },
    ],
    subtype: {"kinds":["Parking permit","Permit"],"qualifiers":["Parking","Council"]},
    costMinor: 4500,
    currency: "GBP",
    },
  },
  {
    // Ground-truth notes:
    // - Issued date 2026-08-03 is printed as the mail Date header '3 August 2026, 09:14' and again as the summary table's 'Payment date'.
    // - Renewal date 2027-08-03 is printed in the summary table as 'Plan renews on 3 August 2027'.
    // - recurrenceMonths 12 is the plan's own term, printed in digits twice as '12 month plan' — not the monthly billing frequency.
    // - Provider is the streaming brand Northlight+, shown in the brand bar and From address — not the billing entity named later.
    // - Reference is the account number 'NL-ACC-771049-2' printed in the summary table, not the invoice number.
    // - costMinor 999 is the 'Amount charged £9.99' in the summary table, matching the monthly payment described in the greeting.
    // - Trap: an 'Invoice number: NL-INV-2208453' sits beside the account number as a rival reference.
    // - Trap: a 'VAT registration: GB 234 5678 90' is a rival identifier, and 'VAT of £1.67' is a rival money figure within the same charge.
    // - Trap: the charge is described as 'billed by Meridian Payments Limited on behalf of Northlight+', a rival provider name.
    // - Trap: 'debit card ending 4471 (expires 09/28)' gives a rival date in card-expiry form.
    // - Trap: the card was 'taken ... on 4 August 2026', a rival date one day after the stated payment date.
    // - Trap: 'equivalent to £119.88 a year' is a rival annual cost figure.
    // - Trap: 'Northlight+ Ultra is available for £13.99 a month' is a rival plan and price.
    // - Trap: the promotion 'offer ends 31 August 2026' is a rival date.
    // - Trap: the app store mention directs cancellation elsewhere, a rival management channel.
    // - Trap: the support address 'support@northlight-help.example' uses a different domain from the billing address 'billing@northlightplus.example'.
    name: "Northlight+ payment receipt",
    filename: "streaming-subscription-invoice.pdf",
    text: "Your Northlight+ payment receipt  \n\nmail.example/mail/u/0/#inbox/17c9f2a41d 1 of 1 \n\nYour Northlight+ payment receipt \n\nFrom: Northlight+ <billing@northlightplus.example> \n\nTo: Priya Chandra <priya.chandra83@mailbox.example> \n\nDate: 3 August 2026, 09:14 \n\nNORTHLIGHT+ \n\nHi Priya, \n\nThanks for being a Northlight+ member. We've taken your monthly payment for your 12 month plan — \n\nhere's your receipt. \n\nPlan Northlight+ Standard (12 month plan) \n\nAccount number NL-ACC-771049-2 \n\nPayment date 3 August 2026 \n\nPlan renews on 3 August 2027 \n\nAmount charged £9.99 \n\nManage your plan \n\nInvoice number: NL-INV-2208453  ·  VAT registration: GB 234 5678 90 \n\nYour payment of £9.99 includes VAT of £1.67. This charge was billed by Meridian Payments Limited on behalf of \n\nNorthlight+ and was taken from your debit card ending 4471 (expires 09/28) on 4 August 2026. \n\nPaid monthly, your 12 month plan is equivalent to £119.88 a year. Fancy more channels? Northlight+ Ultra is available for \n\n£13.99 a month. \n\nQuote code SUMMER26 before the offer ends 31 August 2026 to add a second screen at no extra cost. \n\nSubscribed through the app store instead? Manage and cancel your plan via your device account settings rather than \n\nthrough Northlight+ directly. \n\nQuestions about this receipt? Contact our support team at support@northlight-help.example. \n\nNorthlight+ is a trading name of Northlight Media Group, 4 Aldergate House, Brentmoor, BM1 6QF. \n\nYou're receiving this email because you have an active Northlight+ subscription. Unsubscribe from receipts  |  Privacy policy\n",
    expected: {
    dates: ["2026-08-03","2027-08-03"],
    provider: "Northlight+",
    reference: "NL-ACC-771049-2",
    dateRoles: [
      { date: "2026-08-03", role: "issued" },
      { date: "2027-08-03", role: "renewal" },
    ],
    subtype: {"kinds":["Subscription"],"qualifiers":["Streaming","TV"]},
    costMinor: 999,
    currency: "GBP",
    recurrenceMonths: 12,
    scheduleKind: "renewal",
    },
  },
  {
    // Ground-truth notes:
    // - Term is a fixed term of 12 months, printed in the particulars as 'A fixed term of 12 months, commencing 15/06/2026 and expiring 14/06/2027' — start date 2026-06-15, renewal/expiry date 2027-06-14.
    // - Provider is the managing agent, Thornfield Lettings & Management, who receives rent and handles notices per clause 1 and 3 — not the private landlord Graham Pettifer.
    // - Reference THN-2026-0458 is printed as the 'Tenancy Reference' in the particulars and repeated in every page footer.
    // - Rent is £975.00 per calendar month, printed in the particulars 'Rent' row and restated in clause 3, giving costMinor 97500.
    // - Trap: the 'Date of this Agreement' (signing date) is printed as 02/06/2026, a rival date near but not equal to the tenancy start.
    // - Trap: the Inventory / Check-in appointment is printed as '14/06/2026 at 10:00am', the day before the tenancy actually starts.
    // - Trap: the Break Clause date '15/12/2026 (six months after commencement)' is a plausible but wrong renewal-like date.
    // - Trap: the deposit amount '£1,125.00' and its '30 days of receipt' protection deadline are printed in the particulars and clause 4, a rival cost figure to the rent.
    // - Trap: the holding deposit '£225.00, received 18/05/2026' is a third rival money figure and date.
    // - Trap: 'First Payment Due 02/06/2026' is a rival date for the first rent payment, distinct from the recurring rent date of the 15th.
    // - Trap: the landlord's own name and address, 'Mr Graham Pettifer, 22 Larch Avenue, Barchester, BR2 9LH', is printed prominently as a rival provider.
    // - Trap: the deposit protection scheme, 'Home Deposits Custodial Scheme', is a rival organisation name.
    // - Trap: the agent's redress scheme, 'National Letting Redress Service, membership no. NLRS-88213', is a rival organisation and reference.
    // - Trap: the agent's client money protection scheme, 'Lettings Client Money Protect, certificate no. LCMP-4471', is a second rival organisation and reference.
    // - Trap: the break clause notice period 'giving 2 months' written notice' is a rival number to the 12-month recurrence.
    // - Trap: the late payment interest rate '3% above the Bank of England base rate' is a rival numeric figure.
    // - Trap: the total rent over the term, '£11,700.00', is a rival cost figure to the monthly rent.
    name: "Assured Shorthold Tenancy Agreement",
    filename: "tenancy-agreement.pdf",
    text: "Assured Shorthold Tenancy Agreement  \n\nTHORNFIELD LETTINGS & MANAGEMENT 8 High Street, Barchester, BR1 4DA  ·  01632 960214  ·  lettings@thornfield-lettings.example \n\nASSURED SHORTHOLD TENANCY AGREEMENT \n\nSCHEDULE OF PARTICULARS \n\nThe Property Flat 4, 12 Mulberry Court, Barchester, BR3 7QW \n\nThe Landlord Mr Graham Pettifer, 22 Larch Avenue, Barchester, BR2 9LH \n\nThe Tenant Ms Eleanor Vance \n\nThe Managing Agent Thornfield Lettings & Management, 8 High Street, Barchester, BR1 4DA \n\nTenancy Reference THN-2026-0458 \n\nTerm A fixed term of 12 months, commencing 15/06/2026 and expiring 14/06/2027 \n\nRent £975.00 per calendar month, payable in advance on the 15th day of each month. Total rent payable over the term: £11,700.00 \n\nFirst Payment Due 02/06/2026 — first month's rent, deposit and remaining holding deposit balance payable on signing \n\nDeposit £1,125.00, to be protected within 30 days of receipt under the Home Deposits Custodial Scheme \n\nHolding Deposit £225.00, received 18/05/2026, credited against the first month's rent \n\nDate of this Agreement 02/06/2026 \n\nInventory / Check-in Appointment 14/06/2026 at 10:00am, Thornfield representative to attend with the Tenant \n\nBreak Clause Exercisable on or after 15/12/2026 (six months after commencement) by either party giving 2 months' written notice \n\nLate Payment Interest charged at 3% above the Bank of England base rate on rent more than 14 days in arrears \n\nAgent's Redress Scheme National Letting Redress Service, membership no. NLRS-88213 \n\nAgent's Client Money \n\nProtection \n\nLettings Client Money Protect, certificate no. LCMP-4471 \n\nThis Schedule of Particulars is incorporated into and forms part of the attached Tenancy Agreement (clauses 1–13). \n\nThornfield Lettings & Management  ·  Tenancy Reference THN-2026-0458  ·  Page 1 of 3\n\nTenancy Agreement — Flat 4, 12 Mulberry Court, Barchester, BR3 7QW Reference THN-2026-0458 \n\n1. Definitions \n\nIn this Agreement, \"the Landlord\" means Mr Graham Pettifer of 22 Larch Avenue, Barchester, BR2 9LH; \"the Tenant\" means \n\nMs Eleanor Vance; \"the Agent\" means Thornfield Lettings & Management of 8 High Street, Barchester, BR1 4DA, acting \n\nthroughout as managing agent for the Landlord and as the Tenant's first point of contact for all rent payments, repairs and \n\nnotices; and \"the Property\" means Flat 4, 12 Mulberry Court, Barchester, BR3 7QW, together with its fixtures and fittings as \n\nrecorded in the inventory. \n\n2. Term and Commencement \n\nThe Property is let for a fixed term of 12 months, commencing on 15 June 2026 and expiring on 14 June 2027, unless \n\nterminated earlier in accordance with clause 10 (Break Clause) or extended by a further written agreement between the parties. \n\nThe Tenant shall not be entitled to occupy the Property before the commencement date without the Agent's prior written \n\nconsent. \n\n3. Rent \n\nThe Tenant shall pay to the Agent, on behalf of the Landlord, rent of £975.00 per calendar month, in advance, on the 15th day \n\nof each month, by standing order to the Agent's client account. The first payment, comprising the balance of the first month's \n\nrent after crediting the holding deposit, falls due on 2 June 2026, being the date of signing. Should any instalment remain \n\nunpaid more than 14 days after its due date, interest shall accrue at 3% above the Bank of England base rate from the due date \n\nuntil payment. Were the Tenant to remain for the whole of the fixed term, the total rent payable would be £11,700.00. \n\n4. Deposit \n\nThe Tenant shall pay a deposit of £1,125.00, equivalent to just under six weeks' rent, prior to the commencement of the \n\ntenancy. The Agent shall protect the deposit within 30 days of receipt under the Home Deposits Custodial Scheme and shall \n\nprovide the Tenant with the scheme's prescribed information within the same period. Subject to deductions properly made \n\nfor damage, arrears or breach of this Agreement, the deposit shall be returned within 10 days of the end of the tenancy. \n\n5. Tenant's Obligations \n\nThe Tenant shall keep the interior of the Property in good and tenantable condition, shall not keep any pet without the \n\nLandlord's prior written consent, shall not smoke within the Property, and shall not assign, sublet or part with possession of the \n\nProperty or any part of it without the Agent's prior written consent. The Tenant shall permit the Landlord, the Agent or their \n\nappointed contractors to enter the Property to inspect its condition or carry out repairs, on not less than 24 hours' written \n\nnotice save in an emergency. \n\n6. Landlord's Obligations \n\nThe Landlord shall keep in repair the structure and exterior of the Property, including drains, gutters and external pipes, and \n\nthe installations for the supply of water, gas, electricity and sanitation. The Landlord shall provide a valid gas safety record and \n\nelectrical installation condition report before the Tenant takes occupation and at the intervals required by law thereafter. \n\n7. Insurance \n\nThe Landlord shall maintain buildings insurance over the Property. The Tenant is responsible for insuring their own contents \n\nand personal possessions and acknowledges that the Landlord's policy does not extend to them. \n\nThornfield Lettings & Management  ·  Tenancy Reference THN-2026-0458  ·  Page 2 of 3\n\nTenancy Agreement — Flat 4, 12 Mulberry Court, Barchester, BR3 7QW Reference THN-2026-0458 \n\n8. Right of Entry \n\nSave in an emergency, the Landlord and the Agent shall give the Tenant not less than 24 hours' written notice before entering \n\nthe Property, and shall attend only at reasonable hours of the day. \n\n9. Assignment and Subletting \n\nThe Tenant shall not assign, underlet, charge or part with possession of the whole or any part of the Property without the prior \n\nwritten consent of the Landlord, such consent to be given through the Agent and not to be unreasonably withheld. \n\n10. Break Clause \n\nEither party may terminate this Agreement by serving not less than 2 months' written notice on the other, provided that such \n\nnotice may not expire earlier than 15 December 2026, being six months after the commencement date. Notice under this \n\nclause shall be served on the Agent at the address in clause 1 and shall be treated as effective on the date of delivery. \n\n11. Termination and Holding Over \n\nIf the Tenant remains in occupation after expiry of the fixed term with the Landlord's consent, a periodic tenancy shall arise on \n\nthe same terms unless a new fixed term agreement is signed. The Landlord shall not seek possession under section 21 of the \n\nHousing Act 1988 by notice expiring earlier than 2 months from the date of service. \n\n12. Notices \n\nAny notice under this Agreement shall be in writing and shall be validly served if delivered by hand or sent by first class post \n\nto the Agent at 8 High Street, Barchester, BR1 4DA, or to the Tenant at the Property. \n\n13. Governing Law \n\nThis Agreement is governed by the law of England and Wales, and the parties submit to the exclusive jurisdiction of its courts. \n\nSigned as an Agreement dated 02/06/2026: \n\nSigned by the Landlord: G. Pettifer \n\nSigned by the Tenant: E. Vance \n\nSigned for the Agent: R. Okafor, Thornfield Lettings \n\nThornfield Lettings & Management  ·  Tenancy Reference THN-2026-0458  ·  Page 3 of 3\n",
    expected: {
    dates: ["2026-06-15","2027-06-14"],
    provider: "Thornfield Lettings & Management",
    reference: "THN-2026-0458",
    dateRoles: [
      { date: "2026-06-15", role: "start" },
      { date: "2027-06-14", role: "renewal" },
    ],
    subtype: {"kinds":["Tenancy","Contract"],"qualifiers":["Tenancy","Home"]},
    costMinor: 97500,
    currency: "GBP",
    recurrenceMonths: 12,
    scheduleKind: "renewal",
    },
  },
];
