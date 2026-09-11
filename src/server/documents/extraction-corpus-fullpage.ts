// GENERATED FILE — do not edit by hand.
//
// Full-page extraction fixtures for #981. Regenerate with:
//
//   node scripts/corpus/generate.mjs
//
// Each document was written as HTML, rendered to PDF with Playwright at A4,
// and parsed with the real Tika using the request in `tika.ts`. The `text`
// below is Tika's output byte for byte — escapes, flattened table columns,
// repeated page headers and all. That is the point: the fixture is what
// production actually sees, not a tidied version of it.
//
// The originals live in `scripts/corpus/sources/`. Never edit `text` here;
// edit the HTML and regenerate, so the fixture and the document it came from
// cannot drift apart.
//
// These six replace nothing. They sit alongside the short documents in
// `extraction-corpus.ts`, which remain useful for exactly the labelled,
// single-fact cases they cover.

import type { CorpusDocument } from "./extraction-corpus";

export const FULL_PAGE_CORPUS: CorpusDocument[] = [
  {
    // Ground-truth notes:
    // - dates are the day the extended cover commences (14 June 2026) and the day it expires (13 June 2031), five years apart, both stated in the ceremonial paragraph and repeated in the terms. Three nearby dates are deliberately not declared: the date of purchase (14 June 2025), the date the manufacturer's 12-month guarantee ends (13 June 2026, one day before cover starts), and the date the certificate was issued (16 June 2025) -- a reader has to notice the extended cover starts the day after the guarantee lapses, not on the purchase date or the guarantee-end date itself, both of which are printed just as prominently. Also withheld: the appliance's date of manufacture (03/2025, not a full date so it never even reaches ISO form), the 14-day cancellation deadline (28 June 2025), the 30-day certificate-registration deadline (14 July 2025), the terms' effective-from date (01/03/2025), and the final claim-notification date (13 July 2031, 30 days after expiry and easily mistaken for a second expiry). provider is Bellward Warranty Administration Ltd, the claims administrator named as the contact throughout -- not Ashfield Domestic Appliances Ltd, the retailer, whose name is set far larger at the top of the page as the point-of-sale brand, and not Corvane Insurance plc, the underwriter named only once in the small print. reference is the warranty certificate number (EWC-2025-118823), which is also the number printed under the certificate title. costMinor is the £69.99 paid for the extended warranty itself, not the £549.99 price of the washing machine it covers (printed four times, always in a larger or bolder type than the warranty price), not the £60.00 excess payable per claim, and not either of the £549.99 or £1,099.98 claim-value ceilings. recurrenceMonths and scheduleKind are both omitted: a five-year warranty certificate does not recur and is not itself a serviced item -- it simply expires.
    name: "appliance extended warranty certificate, cover start pinned to guarantee expiry",
    filename: "fullpage-appliance-warranty-certificate.pdf",
    text: "Extended Warranty Certificate — Ashfield Domestic Appliances  \n\nASHFIELD DOMESTIC APPLIANCES BR IS TO L  ·  CR IB B S  CAUSEWAY   —    SO LD  W ITH  CONFIDENC E  S INC E  1 9 9 4 \n\nEXTENDED WARRANTY CERTIFICATE Certificate No. EWC-2025-118823 \n\nThis is to certify that \n\nthe appliance described below, purchased from Ashfield Domestic Appliances Ltd on 14 June 2025, is protected \n\nagainst the cost of mechanical and electrical breakdown by an Extended Warranty administered on behalf of the \n\nretailer by Bellward Warranty Administration Ltd of Norwich, and underwritten by Corvane Insurance plc, \n\nauthorised and regulated by the Financial Conduct Authority (FRN 512837). \n\nThis cover takes effect immediately on expiry of the manufacturer's guarantee and continues, subject to the terms \n\noverleaf and below, for a period of five years, commencing on 14 June 2026 and expiring on 13 June 2031. \n\nAuthorised signatory, for and on behalf of \n\nBellward Warranty Administration Ltd \n\nCertificate issued 16 June 2025 \n\nAPPLIANCE  AND  COVER DETAILS  — PLEASE  RETAIN WITH YOUR PROOF OF PURCHASE \n\nAPPLIANCE \n\nKestrel Home 9kg 1400 Washing Machine \n\nMODEL / SERIAL NO. \n\nKHW-9142S / KHW9142S-0038871 \n\nRETAILER BRANCH \n\nAshfield Domestic Appliances, Bristol — Cribbs Causeway \n\nDATE OF MANUFACTURE \n\n03/2025 \n\nDATE OF PURCHASE \n\n14 June 2025 \n\nPRICE PAID FOR APPLIANCE \n\n£549.99 \n\nMANUFACTURER'S GUARANTEE \n\n12 months parts & labour, ends 13 June 2026 EXTENDED WARRANTY PRICE PAID \n\n£69.99 (inc. IPT) \n\nEXCESS PAYABLE PER CLAIM \n\n£60.00 \n\nMAXIMUM CLAIM VALUE PER INCIDENT \n\n£549.99, the price of the appliance when new \n\nMAXIMUM LIFETIME CLAIM VALUE \n\n£1,099.98 (twice the purchase price) \n\nWARRANTY CERTIFICATE NUMBER \n\nEWC-2025-118823 \n\nTERMS AND CONDITIONS \n\nThis certificate evidences a contract of insurance between the policyholder named on the retailer's sale record and Corvane Insurance plc (company number 04471822, \n\nregistered in England and Wales), administered day to day by Bellward Warranty Administration Ltd , Bellward House, 14 Mercer Row, Norwich , NR2 1QJ (company number \n\n03318456). Enquiries and claims: 0345 601 8822, Monday to Friday 9am–5.30pm. Ashfield Domestic Appliances Ltd acted only as an introducer at the point of sale and is not a \n\nparty to the insurance contract and does not handle claims. \n\nCover under this certificate runs from 14 June 2026 to 13 June 2031 and applies only after the appliance's manufacturer's guarantee, which runs for 12 months from the date of \n\npurchase (14 June 2025 to 13 June 2026), has expired . No claim can be made against this certificate while the manufacturer's guarantee remains in force. This document does not \n\nextend , replace or duplicate the manufacturer's guarantee. \n\nYou have a legal right to cancel this policy within 14 days of the date of purchase (by 28 June 2025) for a full refund of the price paid for the warranty, provided no claim has \n\nbeen made. This certificate should be registered online at bellwardwarranty.example within 30 days of purchase, by 14 July 2025, or a processing fee may apply to a first claim. \n\nTerms correct as at 01/03/2025 and superseding all previous editions. \n\nMAKING  A CLAIM \n\nNotify Bellward Warranty Administration Ltd of any fault as soon as it becomes apparent and , in any event, no later than 13 July 2031. Claims notified after that date, or after \n\nthe expiry of the period of cover, will not be considered . An excess of £60.00 is payable towards the cost of each repair. This certificate does not cover accidental damage, \n\ncosmetic defects, consumables, commercial use, or faults arising from misuse, and repairs may be carried out using non-original parts where the original is no longer available. If \n\nthe appliance cannot be economically repaired , Bellward Warranty Administration Ltd will, at its discretion, arrange a replacement or a cash settlement not exceeding the \n\nmaximum claim value shown above. \n\nIf you are unhappy with how a claim has been handled , write to the Complaints Manager at the address above. If your complaint is not resolved to your satisfaction within \n\neight weeks you may refer it to the Financial Ombudsman Service. This policy is not a savings or investment product and has no cash-in value beyond a claim properly made \n\nunder it. © 2025 Bellward Warranty Administration Ltd . All rights reserved . \n\nB E L L W \n\nA R \n\nD \n\nW A \n\nR R \n\nA N \n\nT Y \n\nA D \n\nM I \n\nN \n\nI \n\nS T \n\nR A \n\nTIONLT D \n\n✦ \n\nC \n\nL A \n\nI M \n\nS A \n\nD M \n\nI N \n\nI S \n\nT \n\nR \n\nA T \n\nO R \n\n✦ \n\nSEAL  OF \n\nAUTHENTICITY \n\nESTABLISHED  1998\n",
    expected: {
    dates: ["2026-06-14","2031-06-13"],
    provider: "Bellward Warranty Administration Ltd",
    reference: "EWC-2025-118823",
    dateRoles: [
      { date: "2026-06-14", role: "start" },
      { date: "2031-06-13", role: "expiry" },
    ],
    subtype: "Extended warranty certificate",
    costMinor: 6999,
    currency: "GBP",
    },
  },
  {
    // Ground-truth notes:
    // - dates: the only date declared is 4 November 2026, the day the member's current cover ends, printed once as 'VALID TO 04/11/2026' on the membership card mock and nowhere else in that exact form — it is never restated in a labelled field. Six other printed dates are deliberately not declared: the letter's own preparation date (2 September 2026), the 'renew by' deadline to avoid a break in cover (14 October 2026), the price-lock deadline on the upgrade tier ('renew before 5 October 2026'), the start of the current (outgoing) membership period (4 November 2025), the price-basis stamp ('correct as at 28 August 2026'), the date the terms and conditions were last updated (3 March 2026), the data protection policy review date (1 February 2026), and the award date (12 May 2026); the member-joined year (2018) and the testimonial-giver's membership year (2011) and review month (June 2026) are also left undeclared. provider is 'Milldown Motoring Club', the trading name on the letterhead and the card mock, not 'Castlebridge Assistance Underwriting Ltd', the company that actually underwrites the cover and is named only in the page 2 small print alongside its FCA reference. reference is the membership number MDC-4471-8823, printed on the card mock and repeated on the payment slip; the slip also carries a rival code in the same dash-grouped format, MDC-7734-1102, labelled 'Offer code' for phone payment — that is a campaign code, not the membership number, and is not declared. subtype is 'Breakdown cover renewal', printed in running text on page 1 ('Your breakdown cover renewal notice') rather than as its own heading. costMinor is £84.99, the coming year's price for Roadside Assist, the tier the member is already on and the cheapest of the three, marked only with a small 'Your current cover' tag. It is not any of the rival amounts sitting beside it: last year's price for the same tier (£74.99), the 'most popular' middle tier's discounted price (£129.99) or its struck-through 'was' price (£159.99) or its monthly instalment (£11.99) or its 'save £30' figure, the top tier's annual price (£169.99) or its monthly instalment (£15.99), the £19.99 Home Start add-on, or the £5 cancellation admin charge. recurrenceMonths is 12, printed in digits on the payment slip ('Roadside Assist, 12 months'), not from the several spelled-out 'twelve months' references. scheduleKind is 'renewal' because the only dateRole is 'renewal'.
    name: "breakdown cover renewal, upgrade tier comparison outshines the current-cover price",
    filename: "fullpage-breakdown-cover-renewal.pdf",
    text: "Milldown Motoring Club — Your Breakdown Cover Renewal  \n\nMILLDOWN MOTORING CLUB Your breakdown cover renewal notice \n\nPrepared 2 September 2026 \n\nMembership MDC-4471-8823 \n\nTHIS OFFER ENDS 30 SEPTEMBER 2026 Renew now and keep last year's benefits at this year's price — plus the chance to upgrade below \n\nDear Mr Ashworth, \n\nYour Milldown membership has kept you moving for years, and it's nearly time to renew again. We've kept your \n\nRoadside Assist cover exactly as it is, so all you need to do is renew — or use this letter to move up a level before \n\nthe price goes up. To keep your cover running without a break, please renew by 14 October 2026. Your \n\nreplacement card is ready to cut out below. \n\n✂  CUT ALONG  THE  DASHED  LINE  AND  KEEP  THIS  CARD  IN  YOUR  GLOVEBOX \n\nChoose your cover for the year ahead \n\nYour current cover \n\nRoadside Assist \n\n£84.99 \n\nper year · you paid £74.99 last year \n\nRoadside repair, any vehicle you're in \n\nUnlimited call-outs \n\nRecovery to a garage \n\nHome start \n\nOnward travel & overnight cover \n\nRoadside, Recovery & At \n\nHome \n\n£169.99 \n\nper year · or £15.99 a month \n\nRoadside repair, any vehicle you're in \n\nUnlimited call-outs \n\nRecovery to a garage, home or a \n\ndestination \n\nHome start \n\nOnward travel & overnight cover \n\nJust in — add Home Start for £19.99 a year. Nearly a third of call-outs happen right outside the front door. Add it to any \n\nrenewal by calling the number below, or tick the box on your payment slip overleaf. \n\n“They reached me within twenty minutes on the coldest morning of the year and \n\nhad me back on the road before the school run.” \n\n— Mrs D. Farrow, Milldown member  since 2011 · review given June 2026 \n\nMILLDOWN ROADSIDE ASSIST \n\nJ. ASHWORTH \n\nMDC  4471  8823 \n\nMEMBER SINCE 2018 \n\nVALID TO 04/11/2026 24HR: 0330 555 0198 \n\nRoadside & Recovery \n\n£129.99 \n\nor £11.99 a month \n\nSave £30 — renew before 5 October 2026 \n\nRoadside repair, any vehicle you're in \n\nUnlimited call-outs \n\nRecovery to a garage, home or a \n\ndestination \n\nHome start \n\nOnward travel & overnight cover \n\nMOST POPULAR \n\nwas £159.99 \n\nMilldown Motoring Club · PO Box 4471, Bristol, BS99 7ZZ Page 1 of 2\n\nMILLDOWN  MOTORING CLUB  — YOUR  RENEWAL Membership MDC-4471-8823 · Page 2  of  2 \n\nWhat 's covered with Roadside Assist \n\nRoadside repair for the vehicle named on your \n\nmembership \n\nUnlimited call-outs across the year \n\nCover for you as a driver in any car, as a named benefit \n\nAdvice line open 24 hours a day, every day \n\nTowing to a garage or your home address \n\nA replacement vehicle while yours is repaired \n\nCall-outs if your car won't start at home \n\nOnward travel if you can't be fixed at the roadside \n\nMilldown attended over 410,000 roadside call-outs last year, with an average arrival time of 34 minutes. Members who added Recovery \n\ncover were rescued from the roadside 60% more often than those on Roadside Assist alone — see the upgrade offer on the facing page. \n\nTerms you should know \n\nWho provides this cover. Milldown Motoring Club, of PO Box 4471, Bristol, BS99 \n\n7ZZ, arranges and administers this membership. Roadside assistance under this \n\nagreement is provided and underwritten by Castlebridge Assistance Underwriting \n\nLtd, registered in England and Wales, company number 07741820, registered \n\noffice Unit 7 Farrow Point, Bellingham Road, Preswick, Lancashire, PR4 8QJ. \n\nCastlebridge Assistance Underwriting Ltd is authorised and regulated by the \n\nFinancial Conduct Authority, firm reference number 559214. \n\nRenewal. Your current annual membership period began on 4 November 2025 and \n\nthis letter offers the twelve months that follow it. Membership renews annually \n\nunless you tell us otherwise at least 14 days before your card's valid-to date. There \n\nis no fixed contract term beyond each twelve-month period. \n\nPrice. The prices on the facing page are correct as at 28 August 2026 and include \n\nInsurance Premium Tax where applicable. Prices may change at your next renewal. \n\nPaying monthly costs more over a year than paying annually. \n\nCancelling. You may cancel within 14 days of renewing for a full refund provided \n\nyou have not made a claim. After that, refunds are given for full remaining months \n\nonly, less a £5 administration charge. \n\nChanges to cover. You can move between Roadside Assist, Roadside & Recovery \n\nand Roadside, Recovery & At Home at any time; the new price applies from your \n\nnext payment. \n\nComplaints. Write to the Membership Services Manager at the address above. If we \n\ncannot resolve things, you may refer your complaint to the Financial Ombudsman \n\nService. \n\nThese terms and conditions were last updated on 3 March 2026 and replace all \n\nearlier versions. Milldown Motoring Club is a trading name used since 1974. \n\nRegistered in England and Wales, company number 05512207. \n\nData and awards. Our data protection policy was last reviewed on 1 February 2026; \n\na copy is available on request. Milldown was voted the UK's most trusted \n\nbreakdown provider by Driver Weekly readers, an award received on 12 May 2026. \n\nRenewal payment slip — return with your payment \n\nMEMBERSHIP NUMBER \n\nMDC-4471-8823 \n\nNAME \n\nMr J. Ashworth \n\nAMOUNT DUE (ROADSIDE ASSIST, 12 \n\nMONTHS) \n\n£84.99 \n\nOFFER  CODE (QUOTE WHEN PAYING BY \n\nPHONE) \n\nMDC-7734-1102 \n\nHOME START ADD-ON \n\n&#32;add for £19.99 \n\nSIGNATURE \n\n&#32;Cheque enclosed, payable to Milldown Motoring Club  Card  Direct Debit \n\n✂\n",
    expected: {
    dates: ["2026-11-04"],
    provider: "Milldown Motoring Club",
    reference: "MDC-4471-8823",
    dateRoles: [
      { date: "2026-11-04", role: "renewal" },
    ],
    subtype: "Breakdown cover renewal",
    costMinor: 8499,
    currency: "GBP",
    recurrenceMonths: 12,
    scheduleKind: "renewal",
    },
  },
  {
    // Ground-truth notes:
    // - costMinor is the £34.99 monthly price during the minimum term ('Monthly price during minimum term' price box and the 'Total during minimum term' table row), not the £46.99 after-term price, not the £4.99 activation charge, and not any of the 24 early-termination amounts — those sit right next to the real price precisely to test whether an extractor grabs the wrong one.
    // - recurrenceMonths is declared as 24 because the document prints 'Minimum term 24 months' in digits, but this is the length of the fixed commitment, not a repeating interval — after it, billing continues monthly on a rolling basis at a different price. A parser that reads 24 as 'this item recurs every 24 months' would be wrong; flagging this as the real judgement call.
    // - 2028-04-21 is labelled 'renewal' rather than 'expiry' because the document explicitly says the contract 'continues and renews automatically on a rolling 30-day basis' at that point (page 1 callout and page 3 'Contract renewal' paragraph) — an actual renewal event, not just a term ending.
    // - Distractors left in deliberately and excluded from dates[]: order date 14 April 2026, document-issued date 15 April 2026, cooling-off deadline 28 April 2026, the 1 April annual price-rise date, the Direct Debit collection day, and the 24 contract-month numbers (1-24) in the exit-fee table, which are month indices, not dates.
    // - Provider is given as the trading name 'Kestrel Broadband' (the letterhead brand and what the customer would call it), not the legal entity 'Alderway Communications Ltd', though both appear verbatim in the document.
    // - Reference is the order reference ORD-2026-0417726 rather than the account number KB-771049-3; both are printed and either would be a defensible choice, but the order reference is what the document itself repeats in every running header.
    // - Subtype corrected: the original ground truth said 'Broadband and phone contract', which the document never prints. The page prints 'Contract Summary and Terms', matching the existing corpus convention of taking the subtype from the document's own heading ('Service agreement' on broadband-agreement).
    // - The richer heading '24-MONTH FIBRE & PHONE CONTRACT' was deliberately NOT used as the subtype: Tika escapes the ampersand (#982), so the field would score wrong for a reason that has nothing to do with extraction. The ampersand stays in the document text as a live example of that defect. Revisit once #982 lands.
    // - 2028-04-21 is role 'renewal', not 'expiry', because this document says the contract renews automatically on a rolling basis at that point. The existing broadband-agreement entry uses 'expiry' because its document only says 'Minimum term ends'. The rule: label what the page says happens, not what kind of document it is.
    name: "24-month broadband contract, exit fees as rival amounts",
    filename: "fullpage-broadband-contract.pdf",
    text: "Kestrel Broadband — Contract Summary and Terms  \n\nKestrel Broadband Contract Summary \n\nOrder date 14 April 2026 \n\nDocument issued 15 April 2026 \n\n24-Month Fibre & Phone Contract Key contract information — Ofcom-format summary \n\nMONTHLY PRICE,  MINIMUM TERM \n\n£34.99 per month, includes line rental \n\nAVERAGE DOWNLOAD SPEED \n\n502 Mbps average upload speed 74 Mbps \n\nMINIMUM TERM \n\n24 months ends 21 April 2028 \n\nCUSTOMER AND ACCOUNT \n\nAccount holder  Ms Priya Nandakumar \n\nAccount number  KB-771049-3 \n\nOrder reference  ORD-2026-0417726 \n\nBilling address  Flat 2, 9 Thornfield Close, \n\nMarlcombe, Warwickshire, CV9 \n\n7QL \n\nInstallation address  Flat 2, 9 Thornfield Close, \n\nMarlcombe, Warwickshire, CV9 \n\n7QL \n\nService start (activation)  22 April 2026 \n\nMinimum term  24 months \n\nMinimum term ends  21 April 2028 \n\nYOUR PACKAGE \n\nKestrel Fibre 500 & Talk — fibre broadband with an average download speed of 502 Mbps and an average upload speed of 74 \n\nMbps, plus a standard landline with inclusive evening and weekend UK calls. Contract length: 24 months. After your minimum \n\nterm your contract continues and renews automatically on a rolling 30-day basis at the out-of-contract price shown below, \n\nunless you tell us to change or leave. \n\nMONTHLY PRICE DURING MINIMUM TERM \n\n£34.99 per month, includes line rental \n\nPRICE AFTER MINIMUM TERM ENDS \n\n£46.99 per month, from 22 April 2028 billing cycle \n\nROUTER DELIVERY / ACTIVATION \n\n£4.99 one-off, added to first bill \n\nKestrel Broadband · Company no. 08847215 · VAT GB 234 5566 12 Account KB-771049-3 · Page 1 of 3 \n\nA trading name of Alderway Communications Ltd · Registered office: Unit 14 Bracken Business Park, Sowerby Lane, Halford, Merseyside, HL6 2QF \n\nRegistered in England and Wales, company number 08847215 · VAT registration number GB 234 5566 12 \n\nCustomer services 0330 660 4192 · kestrelbroadband.example · Regulated under Ofcom's General Conditions of Entitlement\n\nKESTREL BROADBAND — CONTRACT SUMMARY ORDER REFERENCE ORD-2026-0417726 — PAGE 2 OF 3 \n\nWHAT MAKES UP YOUR MONTHLY PRICE \n\nCOMPONENT DESCRIPTION MONTHLY AMOUNT \n\nBroadband Kestrel Fibre 500 service charge \n\n£15.00 \n\nLine rental Standard landline, number retained or newly allocated \n\n£19.99 \n\nTotal during minimum term \n\n£34.99 \n\nPrices shown include VAT at the prevailing rate. Your first bill may be a different amount \n\nbecause it covers a part month from your activation date plus the router delivery \n\ncharge. \n\nPRICE CHANGES \n\nEach year on 1 April, during and after your minimum \n\nterm, we increase all our advertised prices, \n\nincluding your monthly price, by the Consumer Price \n\nIndex rate of inflation published by the Office for \n\nNational Statistics in the preceding January, plus \n\n3.9%. We will write to you at least 30 days before \n\nany in-contract price rise takes effect. If CPI is 0% \n\nor negative, only the 3.9% element applies. This is \n\nseparate from, and additional to, the out-of- \n\ncontract price shown on page 1, which already \n\nreflects prior annual increases. \n\nOTHER CHARGES THAT MAY APPLY \n\nCHARGE WHEN IT APPLIES AMOUNT \n\nRouter delivery / activation One-off, on your first bill £4.99 \n\nEngineer home visit Where a visit beyond standard self-install is needed £65.00 \n\nMissed engineer appointment No access or cancellation inside 24 hours £25.00 \n\nPaper billing Per bill, if you opt out of paperless billing £1.50 \n\nNon-Direct Debit payment Per payment, if you do not pay by Direct Debit £3.00 \n\nCalls to UK mobiles (out of bundle) Per minute, plus connection charge below 15p/min \n\nCall connection charge Per call, all out-of-bundle calls 19p \n\nInternational calls Per minute, destination-dependent, from 20p/min \n\nDirectory enquiries (1471/118 services) Per call, provider-set from £1.10 \n\nEvening and weekend calls to other UK landlines and to Kestrel mobile numbers are included in your package at no extra charge. All other call types are billed as \n\nshown above and appear as itemised charges on your monthly statement. \n\nYOUR RIGHT TO CANCEL — 14-DAY COOLING-OFF PERIOD \n\nYou have 14 calendar days from the day after this order was placed on 14 April 2026 to cancel this contract without giving any \n\nreason and without charge, under the Consumer Contracts Regulations 2013. This cooling-off period ends on 28 April 2026. If you \n\nask us to begin the service before the cooling-off period ends and you then cancel, you may be asked to pay for the service \n\nprovided up to the date you cancelled. To cancel, contact customer services on 0330 660 4192 or write to the registered office \n\naddress on page 1 quoting your order reference ORD-2026-0417726. \n\nSPEED GUARANTEE \n\nWe estimate your download speed range at 380–590 Mbps, with a guaranteed minimum download speed of 220 Mbps at your \n\ninstallation address, in line with Ofcom's voluntary Broadband Speeds Code of Practice. If your speed falls below the guaranteed \n\nminimum and we cannot fix this within 30 days of you reporting it, you have the right to leave your contract within the following \n\n30 days without paying an early termination charge. This right does not apply to temporary or scheduled network slowdowns, or \n\nto issues caused by your in-home wiring or equipment. \n\nKestrel Broadband · Company no. 08847215 · VAT GB 234 5566 12 Account KB-771049-3 · Page 2 of 3\n\nKESTREL BROADBAND — CONTRACT SUMMARY ORDER REFERENCE ORD-2026-0417726 — PAGE 3 OF 3 \n\nCOMPLAINTS CODE OF PRACTICE \n\nIf something goes wrong, contact customer services first on 0330 660 4192 or via kestrelbroadband.example/complaints. We aim \n\nto resolve most complaints within 10 working days. If your complaint is not resolved within 8 weeks, or we agree it is deadlocked \n\nsooner, we will issue a deadlock letter and you may refer the matter, free of charge, to our independent Alternative Dispute \n\nResolution scheme, CISAS (Communications and Internet Services Adjudication Scheme). Full details are set out in our Complaints \n\nCode of Practice, available at kestrelbroadband.example/complaints-code or by post on request. \n\nOTHER THINGS YOU SHOULD KNOW \n\nContract renewal. Around 10 to 40 days before your minimum \n\nterm ends on 21 April 2028, we will write to you with your options, \n\nincluding the best deals we can offer you at that time. If you do \n\nnothing, your contract continues on a rolling monthly basis at the \n\nafter-minimum-term price shown on page 1. \n\nPayment. Charges are collected by Direct Debit on or around the \n\n3rd of each month, in advance for line rental and broadband and \n\nin arrears for call charges. \n\nEquipment. The router remains the property of Alderway \n\nCommunications Ltd and must be returned within 14 days of the \n\ncontract ending. A non-return charge of £40.00 applies if it is \n\nnot returned in working condition. \n\nMoving home. You can normally take your contract with you if you \n\nmove within our coverage area, at no extra charge and without \n\nrestarting your minimum term. A new engineer visit charge may \n\napply at the new address if one is needed. \n\nFair use. This package is for normal residential use. There is no \n\ndata cap, but a fair use policy applies to prevent abuse that \n\naffects other customers. \n\nNetwork maintenance. We may need to interrupt your service for \n\nplanned maintenance. Where possible we will give at least 48 \n\nhours' notice by email or text. \n\nEARLY TERMINATION CHARGES \n\nIf you end this contract before your minimum term ends on 21 April 2028, an early termination charge applies. It is calculated from the contract \n\nmonth you are in when you give notice, and reflects the monthly charges you would otherwise have paid for the rest of your minimum term, less \n\nan early-settlement reduction. The table below shows the charge that applies if you leave during each contract month. This charge is separate \n\nfrom, and is not, your ordinary monthly price of £34.99 shown on page 1. \n\nContract month Months remaining on minimum term Early termination charge (inc. VAT) \n\n1 24 £806.17 \n\n2 23 £772.58 \n\n3 22 £738.99 \n\n4 21 £705.40 \n\n5 20 £671.81 \n\n6 19 £638.22 \n\n7 18 £604.63 \n\n8 17 £571.04 \n\n9 16 £537.45 \n\n10 15 £503.86 \n\n11 14 £470.27 \n\n12 13 £436.68 \n\nContract month Months remaining on minimum term Early termination charge (inc. VAT) \n\n13 12 £403.08 \n\n14 11 £369.49 \n\n15 10 £335.90 \n\n16 9 £302.31 \n\n17 8 £268.72 \n\n18 7 £235.13 \n\n19 6 £201.54 \n\n20 5 £167.95 \n\n21 4 £134.36 \n\n22 3 £100.77 \n\n23 2 £67.18 \n\n24 1 £33.59 \n\nCharges are recalculated to the nearest contract month from the date we receive your valid notice to leave, and are added to your final bill. No early termination \n\ncharge applies if you leave during your 14-day cooling-off period, or if you are moving to an address we cannot serve. \n\nORDER CONFIRMATION \n\nBy signing below, or by continuing to use the service after your cooling-off period ends, you confirm you have read and accept \n\nthis contract summary and the full terms and conditions supplied with it. \n\nSignature of account holder — Ms Priya Nandakumar, account KB-771049-3 \n\nA copy of the full terms and conditions, the price list and this contract summary was sent to the email address held on your account on 15 April 2026 and \n\nremains available at kestrelbroadband.example/myaccount at any time during your contract. \n\nKestrel Broadband · Company no. 08847215 · VAT GB 234 5566 12 Account KB-771049-3 · Page 3 of 3\n",
    expected: {
    dates: ["2026-04-22","2028-04-21"],
    provider: "Kestrel Broadband",
    reference: "ORD-2026-0417726",
    dateRoles: [
      { date: "2026-04-22", role: "start" },
      { date: "2028-04-21", role: "renewal" },
    ],
    subtype: "Contract summary and terms",
    costMinor: 3499,
    currency: "GBP",
    recurrenceMonths: 24,
    scheduleKind: "renewal",
    },
  },
  {
    // Ground-truth notes:
    // - dates: the renewal being offered runs 15 October 2026 to 15 October 2027 ('Renewal period offered', page 1, repeated in the page 2 running header); the end is roled 'renewal'. Ten other printed dates are deliberately not declared: notice date (3 Sep 2026), quote-generated date (28 Aug 2026), the reply-by date (24 Sep 2026, three weeks before the 15 Oct 2026 cover date and set in the largest type on page 1 — it is a deadline to respond, not a cover date), the no-claims-discount confirmation date (2 Sep 2026), the driving licence issue date (3 May 2011), the 2023 windscreen claim date (8 Jan 2023), the policy-wording reprint stamp (1 Apr 2026), the current/expiring period's start (15 Oct 2025), the vehicle's first-registration date (14 Mar 2018), and the insurer's PRA authorisation date (19 Jul 1999). provider: Meridian General Insurance Company plc is the underwriting insurer, named as a stylised wordmark ('MERIDIAN COVER') on page 1 and abbreviated ('MGIC') in every running footer, but only spelled out as its registered legal name in the page 3 small print, which is the form declared. Colworth & Drake Insurance Services Ltd, the broker that sends the notice and administers payment, is not the provider despite appearing first and largest on page 1. reference is the policy number MTR-8823-0145, printed beside the recipient's address on page 1 and repeated in every footer; the broker's own client reference (CD-CLI-33920) is a rival identifier for the same customer and is not declared. subtype is 'Motor insurance renewal', not 'Comprehensive' (the cover type printed on page 1) and not a manufacturer or scheme name. costMinor is the annual premium of £612.40 (net £546.79 + IPT £65.61), not the monthly instalment (£54.87) or the total payable if paying monthly (£661.81, which is higher than both and is itself a rival distractor, not the answer) — that ambiguity is tracked as #985. Also undeclared: last year's premium (£578.90) and the many per-section limits and excesses on page 2.
    name: "car insurance renewal, reply-by date outshines the real cover dates",
    filename: "fullpage-car-insurance-renewal.pdf",
    text: "Your motor insurance renewal — policy MTR-8823-0145  \n\nColworth & Drake Insurance Services Ltd — policy administration Document RNW/MTR/0926 — Page 1 of 3 \n\nCOLWORTH & DRAKE INSURANCE SERVICES LTD \n\n19 Sackville Yard, Bellhaven, Roxfordshire RX3 7DE · 01924 660 118 · renewals@colworthdrake.example · Authorised and regulated by the Financial \n\nConduct Authority, firm reference number 441207 \n\nYOUR MOTOR INSURANCE RENEWAL NOTICE \n\nUnderwritten by MERIDIAN COVER · arranged and administered by Colworth & Drake Insurance Services Ltd \n\nMrs Priya Chandaria 27 Bellflower Grove Aldbury Fen Cravenshire CV14 6JP \n\nPolicy number MTR-8823-0145 \n\nClient reference CD-CLI-33920 \n\nNotice date 3 September 2026 \n\nQuote generated 28 August 2026 \n\nPLEASE  REPLY  BY \n\n24 September 2026 to keep your no claims discount and avoid a gap in cover \n\nYOUR CURRENT DETAILS \n\nVehicle PALLENGER Astrion 1.4 Hatchback, registration mark LP68 KXV, first registered 14 March 2018 Current period of insurance 15 October 2025 to 15 October 2026 Renewal period offered 15 October 2026 to 15 October 2027 No claims discount 7 years, 65% discount, confirmed 2 September 2026 Cover type Comprehensive Your current policy ends on 15 October 2026. Based on the details we hold, we are able to offer you renewal terms for a further twelve months from that date. This notice, the schedule of cover overleaf and the policy booklet MC-09 together set out what we are offering. If we do not hear from you by the reply date above, cover will lapse at the end of the current period and you will need to arrange new insurance before driving the vehicle. \n\nYOUR RENEWAL PREMIUM \n\nANNUAL  PREMIUM, PAID IN FULL \n\n£612.40 Net premium £546.79 + IPT £65.61 \n\nMONTHLY INSTALMENT \n\n£54.87 after a deposit of £58.24 \n\nTOTAL  IF PAYING MONTHLY \n\n£661.81 deposit + 11 instalments, 24.9% APR \n\nrepresentative \n\nLast year your annual premium was £578.90. Paying monthly costs more overall than paying in full because interest is charged on the amount financed by our instalment provider, Colworth & Drake Finance. See page 3 for how to pay. \n\nMGIC  · Policy MTR-8823-0145 · RNW/MTR/0926 Page 1 of 3\n\nSchedule of cover proposed from 15 October 2026 to 15 October 2027 Document RNW/MTR/0926 — Page 2 of 3 \n\nSCHEDULE  OF  COVER \n\nPolicy MTR-8823-0145 · PALLENGER Astrion 1.4 Hatchback, LP68 KXV \n\nSection of cover Limit and excess that applies \n\nLiability to third parties Unlimited under the Road Traffic Act. No excess applies to third party injury \n\nclaims. \n\nLoss of or damage to your vehicle Market value at the time of loss, up to £18,500. Compulsory excess £150 \n\nplus voluntary excess £125 (combined £275). \n\nFire and theft Market value, up to £18,500. Excess £350 for theft of the vehicle or its \n\ncontents. \n\nWindscreen and window glass Repair or replacement, no annual limit. Excess £75 per claim; does not affect \n\nno claims discount. \n\nPersonal accident £5,000 death benefit for the policyholder and spouse or partner. No excess. \n\nMedical expenses £250 per person injured while in the insured vehicle. No excess. \n\nPersonal belongings in the vehicle £300 in total. Excess £25. \n\nChild car seats £150 per seat if damaged in an accident, whether or not the seat shows \n\nvisible damage. No excess. \n\nCourtesy car Group A manual, provided while your vehicle is being repaired by an \n\napproved repairer, up to 21 days. Not provided after a total loss. \n\nMotor legal expenses cover Up to £100,000 per claim to pursue an uninsured party. No excess. \n\nUninsured driver promise Excess refunded in full if the other driver is uninsured and identified. No \n\nexcess payable at outset. \n\nKey and lock replacement Up to £1,000 following loss or theft of keys. Excess £50. \n\nDriving other cars Third party only, named driver, car not owned or hired by the driver. No \n\nexcess. \n\nEuropean and foreign use Comprehensive cover for up to 90 days in any one trip within the territorial \n\nlimits shown in the policy booklet. \n\nYoung or inexperienced driver excess Additional excess of £450 applies where the driver is under 25 or holds a \n\nlicence for less than 2 years. \n\nNo claims discount protection Not purchased for this renewal. Discount may be reduced following a claim; \n\nsee page 3. \n\nLimits and excesses shown are per claim unless stated otherwise, and are in addition to any excess or limit shown in the policy booklet MC-09 for a peril not listed above. Where more than one excess applies to the same claim, the excesses are added together unless stated otherwise. \n\nMGIC  · Policy MTR-8823-0145 · RNW/MTR/0926 Page 2 of 3\n\nHow to pay, your rights, and important information Document RNW/MTR/0926 — Page 3 of 3 \n\nHOW TO PAY \n\nBy bank transfer to Colworth & Drake Client Account, sort code 30-77-14, account number 74402281, quoting reference MTR-8823- 0145. \n\nBy debit or credit card using the tear-off slip below, or by telephone on 01924 660 118, option 2. \n\nBy monthly direct debit through Colworth & Drake Finance — complete the slip below and we will contact you to set up the agreement before your first collection date. \n\nYOUR DRIVING LICENCE  AND  CLAIMS HISTORY \n\nLicence holder Mrs Priya Chandaria, driving licence CHAND811123PC9LR, first issued 3 May 2011 \n\nDate Reference Type Outcome \n\n8 January 2023 CLM-2023-0091 Windscreen damage Settled — glass excess only, no effect on no claims discount \n\nThis is the only claim recorded against this policy in the last five years. Your no claims discount has been calculated on this basis; see page 1 for the years and percentage confirmed. \n\nYOUR RIGHT TO CANCEL \n\nCooling-off period. You may cancel within 14 days of the renewal start date shown on page 1, or the day you receive these renewal documents if later, without giving a reason. Provided no claim has been made, we will refund any premium paid for the period after cancellation. \n\nCancelling after the cooling-off period. You may cancel at any time by writing to Colworth & Drake Insurance Services Ltd at the address on page 1. We will refund any premium for the remaining period, less an administration charge of £45.00. No refund is due if you have made a claim during the period of insurance. \n\nComplaints. Contact Colworth & Drake Insurance Services Ltd in the first instance. If unresolved, you may refer your complaint to the Financial Ombudsman Service free of charge, normally within six months of our final response. \n\nFinancial Services Compensation Scheme. Meridian General Insurance Company plc is covered by the Financial Services Compensation Scheme. You may be entitled to compensation if we are unable to meet our obligations. \n\nThis policy is underwritten by Meridian General Insurance Company plc, registered office Meridian House, 4 Cathedral Close, Larchgate, Wexbridge WX9 2QF, registered in England and Wales No. 02841170, VAT registration number GB 601 3382 47, authorised by the Prudential Regulation Authority since 19 July 1999 and regulated by the Financial Conduct Authority and the Prudential Regulation Authority, firm reference number 204471. Colworth & Drake Insurance Services Ltd, registered office 19 Sackville Yard, Bellhaven, Roxfordshire RX3 7DE, company number 06612940, is authorised and regulated by the Financial Conduct Authority, firm reference number 441207. Policy wording edition MC-09, reprinted 1 April 2026. \n\n✂  c ut  a long  th is  line  and  re turn  with  your  payment  ·  keep  the  rest  of  th is  notic e  fo r  your  rec ords \n\nRENEWAL PAYMENT  SLIP \n\nPOLICY NUMBER \n\nMTR-8823-0145 \n\nPOLICYHOLDER NAME \n\nAMOUNT  ENCLOSED \n\n£ ______ . ____ \n\nPAYMENT  METHOD \n\n&#32;Annual, £612.40    Monthly direct debit    Cheque \n\nenclosed \n\nCARD NUMBER (DEBIT/CREDIT) \n\n____ ____ ____ ____  Exp ___/___ \n\nRETURN TO \n\nColworth & Drake Insurance Services Ltd, 19 Sackville Yard, \n\nBellhaven, Roxfordshire RX3 7DE \n\nMGIC  · Policy MTR-8823-0145 · RNW/MTR/0926 Page 3 of 3\n",
    expected: {
    dates: ["2026-10-15","2027-10-15"],
    provider: "Meridian General Insurance Company plc",
    reference: "MTR-8823-0145",
    dateRoles: [
      { date: "2026-10-15", role: "start" },
      { date: "2027-10-15", role: "renewal" },
    ],
    subtype: "Motor insurance renewal",
    costMinor: 61240,
    currency: "GBP",
    scheduleKind: "renewal",
    },
  },
  {
    // Ground-truth notes:
    // - dates is the first and last day of the charge period printed in the header ('Charge for the year 1 April 2026 to 31 March 2027'), roled start and expiry; the ten instalment due dates (15th of each month, April 2026 to January 2027, printed twice over in the schedule table as dd/mm/yyyy) are all excluded even though they are the densest, most date-like block on the page. Also excluded: the notice issue date (10 March 2026), the budget-setting meeting date (25 February 2026), the valuation list effective date (1 April 1993), the 1991 capital value basis date (1 April 1991, printed twice), the banding appeal deadline (10 September 2026), the direct debit first-collection date and single-payment deadline (15 April 2026, same calendar date as instalment 1 but a separate mention), and the second-homes discount withdrawal date (1 April 2024). costMinor is the total council tax charge for 2026/27 (GBP 2,159.07) printed as the bold total row of the charge breakdown table, not last year's total (GBP 2,056.30), not either individual precept figure, not the regular monthly instalment (GBP 215.91) or the different final instalment (GBP 215.88), and not the single-payment total after the prompt payment allowance (GBP 2,137.48, itself distinct from the GBP 21.59 allowance deducted to reach it). provider is Calderhythe District Council, the billing authority that issues and collects the demand, declared under that full name in the small print, and not any of the four precepting authorities (Wealdshire County Council, Wealdshire Police and Crime Commissioner, Wealdshire Fire and Rescue Authority, Marlpool Parish Council) whose amounts it also collects, nor the recovery contractor named in the small print for enforcement action (Halsworth Compliance Services Ltd, contract reference HCS/CT/2244). reference is the council tax account number 8845612033, which is what the liable person quotes when paying or querying the account, not the property reference CH-14-SC-2261 or the recovery contractor's contract reference. recurrenceMonths is 12 because the charge is levied for a 12-month financial year and a further demand follows for the next year; scheduleKind is renewal rather than service because this is a periodic charge, not a service visit. The end date is roled 'renewal' rather than 'expiry' because the household must act again on it, which is the distinction this corpus draws: 'expiry' is reserved for a document that simply runs out (the MOT certificate), and verify.mjs derives scheduleKind from the role.
    name: "council tax demand, ten-instalment schedule and dual-year precepts against a single year total",
    filename: "fullpage-council-tax-demand.pdf",
    text: "Council Tax Demand Notice 2026/27  \n\nC ALDE RHYTHE COUNCIL TAX — BILLING AUTHORITY \n\nCOUNCIL TAX DEMAND NOTICE Charge for the year 1 April 2026 to 31 March 2027 \n\nNotice issued 10 March 2026 \n\nProperty reference  CH-14-SC-2261 Liable person(s)  Mr D. Pemberton \n\nCOUNCIL TAX ACCOUNT NUMBER \n\n8845612033 \n\nPROPERTY CHARGED \n\n14 Sedge Close Marlpool Calderhythe CH3 7QD Valuation band  D Capital value basis  1 April 1991 Days charged this year  365 Discount applied  None \n\nVALUATION BANDS AND PROPORTION OF BAND D CHARGE Band 1991 capital value Proportion \n\nA Up to £40,000 6/9 \n\nB £40,001 – £52,000 7/9 \n\nC £52,001 – £68,000 8/9 \n\nD £68,001 – £88,000 9/9 \n\nE £88,001 – £120,000 11/9 \n\nF £120,001 – £160,000 13/9 \n\nG £160,001 – £320,000 15/9 \n\nH Over £320,000 18/9 \n\nCHARGE BREAKDOWN FOR THE YEAR ENDING 31 MARCH 2027 \n\nPrecepting authority 2025/26 2026/27 \n\nCalderhythe District Council (district services) £298.61 £312.44 \n\nWealdshire County Council £1,412.87 £1,486.05 \n\nWealdshire Police and Crime Commissioner £226.98 £237.15 \n\nWealdshire Fire and Rescue Authority £78.04 £81.33 \n\nMarlpool Parish Council £39.80 £42.10 \n\nTotal council tax charge for the year £2,056.30 £2,159.07 \n\nPay by ten monthly instalments of £215.91 (final instalment £215.88), as scheduled below, or pay the whole year in a single instalment on or before 15 April 2026 and deduct a prompt payment allowance of £21.59, making one payment of £2,137.48. \n\nINSTALMENT SCHEDULE — TEN PAYMENTS, YEAR 2026/27 \n\nNo. Due date Amount \n\n1 15/04/2026 £215.91 \n\n2 15/05/2026 £215.91 \n\n3 15/06/2026 £215.91 \n\n4 15/07/2026 £215.91 \n\n5 15/08/2026 £215.91 \n\nNo. Due date Amount \n\n6 15/09/2026 £215.91 \n\n7 15/10/2026 £215.91 \n\n8 15/11/2026 £215.91 \n\n9 15/12/2026 £215.91 \n\n10 15/01/2027 £215.88 \n\nBILLING AUTHORITY This demand notice is issued by Calderhythe District Council, which is the billing authority for this charge under section 1 of the Local Government Finance Act 1992, and collects the sums shown above on behalf of itself and the precepting authorities listed in the charge breakdown. Calderhythe District Council set its budget requirement for the year 2026/27, and the amount of council tax at each band that follows from it, at its budget meeting on 25 February 2026. \n\nVALUATION AND APPEALS The valuation band shown for this property is taken from the valuation list compiled by the Valuation Office Agency, which took effect on 1 April 1993, and reflects the property’s estimated capital value at 1 April 1991. If you consider the band to be wrong you may propose a change to the Valuation Office Agency; a proposal relating to this notice must reach the Valuation Office Agency no later than 10 September 2026. Making a proposal does not allow you to withhold payment while it is considered. \n\nHOW TO PAY Instalments may be paid by direct debit, standing order, online or at a Post Office, quoting the council tax account number shown above. If you pay by direct debit, your bank will collect each instalment on the dates shown in the schedule above, with the first collection on 15 April 2026. You may ask in writing to pay by twelve monthly instalments instead of ten; a request must be received before 15 April 2026 to apply to this year’s charge. \n\nDISCOUNTS, EXEMPTIONS AND REDUCTIONS A 25% discount applies where only one adult lives in a property as their main home. Certain unoccupied properties, and properties occupied only by full-time students, may be exempt. A reduction may be available where a disabled occupant needs extra space. Support with paying may be available under Calderhythe District Council’s local council tax reduction scheme. None of these applies to this account, as shown by the discount field above. An empty homes premium of up to 100% may be charged on properties empty for more than twelve months. \n\nIF YOU DO NOT PAY If an instalment is missed, a reminder will be sent; a second missed instalment in the same year may cancel the right to pay by instalments and the whole year’s charge shown above will become \n\npayable at once. Unpaid council tax may be recovered through a liability order made by the magistrates’ court under the Council Tax (Administration and Enforcement) Regulations 1992, after which recovery action, including the instruction of enforcement agents, may be referred to the Council’s recovery contractor, Halsworth Compliance Services Ltd, operating under contract reference HCS/CT/2244. Costs incurred at this stage are added to the amount you owe. \n\nDATA PROTECTION AND COMPLAINTS Calderhythe District Council processes the information on this notice to bill and collect council tax under its statutory functions, and may share it with other public bodies for the prevention of fraud. A copy of the Council’s privacy notice is available on request. If you are unhappy with how your account has been handled, write to the Revenues Manager at the address on the reverse of this notice quoting your council tax account number. \n\nCHANGE OF CIRCUMSTANCES Tell Calderhythe District Council within 21 days of any change that may affect your council tax, including a change of address or the end of an exemption or discount. Late reporting may result in a backdated charge and a penalty of £70 added to your account. \n\nSECOND HOMES AND EMPTY PROPERTIES A property that is no one’s main home is normally charged the full amount shown above; the 10% discount previously available for second homes in this area was withdrawn with effect from 1 April 2024. A premium of up to 100% may apply to a furnished second home; none applies here. \n\nHOW THE TOTAL IS MADE UP The amount shown for Calderhythe District Council includes the Council’s general expenses and its share of the cost of local services such as waste collection, recycling, planning and environmental health. The amounts shown for Wealdshire County Council, the Police and Crime Commissioner, the Fire and Rescue Authority and Marlpool Parish Council are set independently by those bodies and collected by Calderhythe District Council on their behalf; the Council has no power to alter them. \n\nFREEDOM OF INFORMATION Information held by the Council, including the figures used to calculate this notice, may be requested under the Freedom of Information Act 2000, subject to the exemptions in that Act. \n\nCalderhythe District Council · Council Tax Section · Account 8845612033 Page 1 of 1 \n\nCH 1894\n",
    expected: {
    dates: ["2026-04-01","2027-03-31"],
    provider: "Calderhythe District Council",
    reference: "8845612033",
    dateRoles: [
      { date: "2026-04-01", role: "start" },
      { date: "2027-03-31", role: "renewal" },
    ],
    subtype: "Council tax demand",
    costMinor: 215907,
    currency: "GBP",
    recurrenceMonths: 12,
    scheduleKind: "renewal",
    },
  },
  {
    // Ground-truth notes:
    // - provider is Northgate Dental Plan Administration Ltd, the scheme administrator named only in the panel's small print and in the Direct Debit Guarantee wording. Aldermoor Dental Practice, named largest at the top of the panel as the masthead, is the practice where treatment happens, not the organisation the plan is with, so it is not the provider.
    // - reference is the membership number NDPA-208467, which is how the member's own record is filed with the administrator, not the plan product name (Aldermoor Complete Care Plan) or the administrator's company number (04471102) or the Direct Debit originator's identification number (934218), none of which a member would quote to identify their plan.
    // - dates/dateRoles carry only the next check-up date (12 November 2026), role 'service', because that is the date this statement is driving the member toward. The statement prints six other dates -- the statement date (14 August 2026), the plan start date (1 March 2020), the last check-up (12 May 2026), the last hygienist visit (30 June 2026), the last payment taken (1 August 2026), the next payment due (1 September 2026), the plan renewal date (1 March 2027) and the fee price-list effective date (1 April 2026) -- none of which is the answer.
    // - costMinor is 950 (the £9.50 monthly payment collected by Direct Debit), not the £114.00 plan-year value, not the practice's £62.00 private examination fee, not the £58.00 hygienist fee, and not the £1,000,000 worldwide dental trauma cover limit -- all printed on the same panel as rival amounts.
    // - recurrenceMonths is 6, the interval between check-ups, which is the schedule this document actually drives (the next-check-up date above). The plan year is separately stated as running 12 months, and the payment is separately stated as taken every month; both are printed but describe the billing and membership-year cycles, not the check-up schedule, so neither is declared.
    // - scheduleKind is 'service' because the tracked date and recurrence both describe the check-up appointment cycle, not a renewal/expiry event.
    name: "dental plan statement, three printed intervals and a hidden administrator",
    filename: "fullpage-dental-plan-statement.pdf",
    text: "Annual Plan Statement — Aldermoor Complete Care Plan  \n\nAldermoor Dental Practice \n\n14 Vicarage Lane, Wexbridge, WX4 2QP · 01926 552 019 \n\nDENTAL PLAN STATEMENT \n\nMr Callum Ashworth · 27 Beech Grove, Wexbridge, WX4 5RT \n\nStatement date 14 August 2026 · Membership number NDPA-208467 \n\nPlan Aldermoor Complete Care Plan Plan start date 1 March 2020 \n\nMonthly payment £9.50 Plan year value £114.00 \n\nLast payment taken 1 August 2026 Next payment due 1 September 2026 \n\nPlan renewal date 1 March 2027 Last check-up 12 May 2026 \n\nLast hygienist visit 30 June 2026 Next check-up due 12 November 2026 \n\nYour monthly payment is taken every month by Direct Debit. Your plan year runs for 12 months from your start date shown above, and \n\nrenews automatically unless you tell us otherwise. Check-ups fall due every 6 months, and one hygienist visit is included between \n\ncheck-ups. \n\nOutside the plan, a private examination at Aldermoor Dental Practice costs £62.00 and a hygienist session £58.00 (fees correct as at 1 \n\nApril 2026). Your plan also includes worldwide dental trauma cover up to £1,000,000. \n\nAldermoor Complete Care Plan is arranged for Aldermoor Dental Practice and administered on its behalf by Northgate Dental Plan Administration Ltd, PO Box 1156, \n\nNewbury Park, NP3 9ZZ, company number 04471102. The payments shown above are collected by Northgate Dental Plan Administration Ltd by Direct Debit. \n\nF O LD F O LD \n\nDIRECT Debit \n\nThe Direct Debit Guarantee \n\nThis Guarantee is offered by all banks and building societies that accept instructions to pay Direct Debits. \n\nIf there are any changes to the amount, date or frequency of your Direct Debit, Northgate Dental Plan Administration Ltd will notify you 10 working days in advance of your account being debited or as otherwise agreed. If you request Northgate Dental Plan Administration Ltd to collect a payment, confirmation of the amount and date will be given to you at the time of the request. \n\nIf an error is made in the payment of your Direct Debit, by Northgate Dental Plan Administration Ltd or your bank or building society, you are entitled to a full and immediate refund of the amount paid from your bank or building society. If you receive a refund you are not entitled to, you must pay it back when Northgate Dental Plan Administration Ltd asks you to. \n\nYou can cancel a Direct Debit at any time by simply contacting your bank or building society. Written confirmation may be required. Please also notify us. \n\nOriginator’s Identification Number 934218 · Northgate Dental Plan Administration Ltd · PO Box 1156, Newbury Park, NP3 9ZZ · Reference NDPA- \n\n208467\n",
    expected: {
    dates: ["2026-11-12"],
    provider: "Northgate Dental Plan Administration Ltd",
    reference: "NDPA-208467",
    dateRoles: [
      { date: "2026-11-12", role: "service" },
    ],
    subtype: "Dental plan statement",
    costMinor: 950,
    currency: "GBP",
    recurrenceMonths: 6,
    scheduleKind: "service",
    },
  },
  {
    // Ground-truth notes:
    // - Date of inspection (page 1 and repeated in the declaration on page 11) and the recommended date of next inspection (page 2 and repeated on page 11) are the only two dates a user would track, both roled 'service'. Three organisations appear and only the contracting firm, Thornleigh Electrical Contractors Ltd, is the provider: Priorswood Lettings & Property Management is the letting agent who commissioned the report (client field, page 1), and the National Electrical Installers Register is the invented certification scheme that publishes the form and guidance notes (page 12), neither of which is the provider. Rival dates deliberately planted against the two answers: the date the report was requested (18 August 2026), the date the report was signed (03 September 2026) and issued (04 September 2026), the previous EICR date (14 March 2021), the tenant's tenancy start date (1 July 2023), the contractor's scheme registration expiry (30 April 2027), the calibration and calibration-due dates of the four test instruments on page 5 (eight dates), the date the wiring code amendment came into force (28 September 2024), and the guidance notes' own issue/copyright date (1 April 2024). The circuit schedules on pages 6-10 also carry dozens of dd/dd- and d.dd/d.dd-shaped readings (CSA pairs, OCPD/RCD ratings like 32/30, Zs max/measured pairs like 1.15/0.34) that read like dates but are not. No cost or price appears anywhere on the document — this is a certificate, not an invoice — so costMinor and currency are omitted.
    name: "electrical installation condition report, twelve pages of circuit grids and tick boxes around two service dates",
    filename: "fullpage-electrical-condition-report.pdf",
    text: "Electrical Installation Condition Report — EICR-2026-071842  \n\nNATIONAL ELECTRICAL INSTALLERS REGISTER — DOMESTIC ELECTRICAL INSTALLATION CONDITION REPORT FORM ECR-1(D) ·  ISSUE 6 \n\nNo. EICR-2026-071842 Thornleigh Electrical Contractors Ltd Page 1 of 12 \n\nELECTRICAL INSTALLATION CONDITION REPORT \n\nfor a domestic electrical installation, issued under the National Wiring Safety Code (NWSC-18) and the rules of the National Electrical Installers Register scheme \n\nSECTION A — CLIENT ORDERING THIS REPORT \n\nCLIENT NAME Priorswood Lettings & Property Management \n\nCLIENT ADDRESS 21 Fenchurch Row, Bramholt, BR2 4JQ \n\nNATURE OF CLIENT’S INTEREST Managing agent, instructed on behalf of the landlord \n\nDATE THIS REPORT REQUESTED 18 August 2026 \n\nSECTION B — LANDLORD AND OCCUPIER \n\nLANDLORD Mr N. Castellan \n\nLANDLORD’S CORRESPONDENCE ADDRESS 14 Overstone Gardens, Milbrook, ML5 2QF \n\nOCCUPIER Ms H. Adeyemi-Prosser \n\nTENANCY START DATE 01 July 2023 \n\nSECTION C — DETAILS OF THE INSTALLATION \n\nADDRESS OF THE INSTALLATION 6 Ashworth Terrace, Bramholt, BR14 6QS \n\nDESCRIPTION OF PREMISES Domestic — mid-terrace house, 3 bedrooms \n\nESTIMATED AGE OF INSTALLATION Circa 1998 (approx. 28 years) \n\nEVIDENCE OF ADDITIONS/ALTERATIONS Kitchen ring and one socket circuit rewired circa 2014; no records of who carried this out \n\nRECORDS AVAILABLE TO THE INSPECTOR Previous EICR dated 14 March 2021 supplied by the client; no earlier records held \n\nSECTION D — PURPOSE AND EXTENT OF THE INSPECTION \n\nPURPOSE OF REPORT Change of tenancy — periodic condition report requested ahead of a new letting \n\nAGREED LIMITATIONS \n\nUnderfloor and roof-space cabling not exposed or accessed; electric shower circuit tested at reduced voltage as isolation of the fixed installation for full insulation resistance testing could not be agreed with the occupier \n\nLIMITATIONS AGREED WITH Priorswood Lettings & Property Management \n\nLIMITATIONS AGREED ON 18 August 2026 \n\nSECTION E — CONTRACTOR AND INSPECTOR \n\nCONTRACTOR Thornleigh Electrical Contractors Ltd \n\nCOMPANY REGISTRATION NO. 07741820 \n\nCONTRACTOR ADDRESS Unit 9, Caldervale Business Park, Bramholt, BR3 7TE · 01924 556 217 · office@thornleighelectrical.example \n\nNEIR SCHEME ENROLMENT NO. NEIR/DOM/48217 \n\nSCHEME REGISTRATION VALID TO 30 April 2027 \n\nINSPECTOR S. Marchetti, Qualified Supervisor \n\nINSPECTOR’S NEIR REF. INS-22841 \n\nDATE(S) OF INSPECTION AND TESTING 02 September 2026 \n\nTIME ON SITE 09:15 to 15:40 \n\nThis report is based on an inspection and testing of the fixed electrical installation only. It does not extend to portable appliances, extra-low-voltage systems installed by others, or to any part of the installation not accessible on the date shown above without unreasonable damage to the fabric of the building. \n\nThornleigh Electrical Contractors Ltd · Report EICR-2026-071842 · 6 Ashworth Terrace, Bramholt Page 1 of 12\n\nNATIONAL ELECTRICAL INSTALLERS REGISTER — DOMESTIC ELECTRICAL INSTALLATION CONDITION REPORT FORM ECR-1(D) ·  ISSUE 6 \n\nNo. EICR-2026-071842 Thornleigh Electrical Contractors Ltd Page 2 of 12 \n\nSUMMARY OF THE CONDITION OF THE INSTALL ATION AND ASSESSMENT \n\nOVERALL ASSESSMENT OF THE INSTALLATION \n\nASSESSMENT \n\nUNSATISFACTORY \n\nThis assessment is given because one or more observations classified C1 (danger present) or C2 (potentially dangerous) have been identified during this inspection — see the observations recorded on pages 3 and 4, and the attached schedules of inspection and test results on pages 5 to 11. \n\nSUMMARY OF CLASSIFICATION CODES RECORDED \n\nCODE MEANING NO. RECORDED \n\nC1 Danger present. Risk of injury. Immediate remedial action required 1 \n\nC2 Potentially dangerous. Urgent remedial action required 4 \n\nC3 Improvement recommended 6 \n\nFI Further investigation required without delay 1 \n\nRECOMMENDATION FOR NEXT INSPECTION \n\nTaking into account the type of installation and equipment, its use and the frequency of maintenance intended, and the result of this inspection, it is recommended that this installation is further inspected and tested at an interval not exceeding 60 months from the date of this inspection, or sooner if any C1 or C2 item recorded above is not remedied in the meantime, whichever is sooner. \n\nRECOMMENDED INTERVAL \n\n60 months RECOMMENDED DATE OF NEXT INSPECTION \n\n02 September 2031 \n\nDECLARATION AND REPORT ISSUE \n\nREPORT COMPLETED BY S. Marchetti \n\nDATE REPORT SIGNED 03 September 2026 \n\nDATE REPORT ISSUED TO CLIENT 04 September 2026 \n\nCOPIES ISSUED TO Priorswood Lettings & Property Management; landlord’s file \n\nThis is an Electrical installation condition report and is issued in respect of, and describes the condition of, the fixed electrical installation only, as found at the date of inspection shown on page 1. It is not a certificate of compliance with any current standard beyond that date, and should be read together with the observations at pages 3 and 4 and the full schedules of inspection and test results that follow at pages 5 to 11. \n\nThornleigh Electrical Contractors Ltd · Report EICR-2026-071842 · 6 Ashworth Terrace, Bramholt Page 2 of 12\n\nNATIONAL ELECTRICAL INSTALLERS REGISTER — DOMESTIC ELECTRICAL INSTALLATION CONDITION REPORT FORM ECR-1(D) ·  ISSUE 6 \n\nNo. EICR-2026-071842 Thornleigh Electrical Contractors Ltd Page 3 of 12 \n\nOBSERVATIONS AND RECOMMENDATIONS FOR ACTION (1 OF 2) \n\nNumbering continues from the schedule of inspections at page 11, item references are given where an observation corresponds to a numbered inspection item. Classification codes: C1 danger present, C2 potentially dangerous, C3 improvement recommended, FI further investigation required. \n\nITEM LOCATION / CIRCUIT OBSERVATION CODE REG. REF. \n\n1 Consumer unit DB1, hallway Live conductor of circuit 7 (immersion heater) found with insulation damaged and copper exposed inside the enclosure, in contact with earthed metal casework. \n\nC1 NWSC-18 526.5 \n\n2 Bathroom, first floor No supplementary bonding present between exposed metal pipework and the earthing terminal, and RCD protection on all circuits serving the location could not be confirmed. \n\nC2 NWSC-18 701.415.2 \n\n3 Kitchen ring final, circuit 1 Socket-outlet fitted adjacent to the sink bowl, within 300mm of the tap, undamaged but not suitably located for its intended use. \n\nC2 NWSC-18 512.2 \n\n4 DB1, circuit 9 (garden office) No RCD protection provided for the buried cable run to the detached garden office, laid at less than 450mm depth without additional mechanical protection. \n\nC2 NWSC-18 522.8.10 \n\n5 Main earthing terminal, understair cupboard \n\nMain protective bonding conductor to the gas installation pipe measured 6mm² where 10mm² is required for this size of supply. \n\nC2 NWSC-18 544.1.1 \n\n6 Consumer unit DB1 Circuits were not identified with an adequate description on the circuit chart at the time of inspection; a corrected chart has since been provided, see page 6. \n\nC3 NWSC-18 514.9.1 \n\nContinued at page 4, items 7 to 12. \n\nThornleigh Electrical Contractors Ltd · Report EICR-2026-071842 · 6 Ashworth Terrace, Bramholt Page 3 of 12\n\nNATIONAL ELECTRICAL INSTALLERS REGISTER — DOMESTIC ELECTRICAL INSTALLATION CONDITION REPORT FORM ECR-1(D) ·  ISSUE 6 \n\nNo. EICR-2026-071842 Thornleigh Electrical Contractors Ltd Page 4 of 12 \n\nOBSERVATIONS AND RECOMMENDATIONS FOR ACTION (2 OF 2) \n\nITEM LOCATION / CIRCUIT OBSERVATION CODE REG. REF. \n\n7 Loft space Cable supporting several lighting points fixed with insufficient clips over a run of approximately 4m; sagging but not damaged. \n\nC3 NWSC-18 522.8.5 \n\n8 Living room, circuit 2 Socket-outlet faceplate cracked at one corner; terminals not exposed and connections found tight on inspection. C3 NWSC-18 621.2 \n\n9 Outbuilding sub-board DB2 RCD test-button function label missing from the enclosure door; the device itself tested and operated correctly. C3 NWSC-18 514.1 \n\n10 Front porch light Light fitting corroded at the fixing point; the luminaire functions correctly and remains adequately supported. C3 NWSC-18 522.8.5 \n\n11 Airing cupboard Cable to the immersion heater not adequately identified where it passes close to the cylinder thermostat. C3 NWSC-18 514.9.1 \n\n12 Loft space, near circuit 9 junction box \n\nA suspected additional lighting point, not shown on the circuit chart, appears spliced into the junction box for circuit 9. Extent could not be established without further investigation and partial removal of loft insulation. \n\nFI NWSC-18 132.16 \n\nAll items above are also referenced against the relevant line of the schedule of inspections at page 11. Remedial work for items classified C1 and C2 should be carried out as a matter of urgency by a competent person; items classified C3 are recommended but not urgent. \n\nThornleigh Electrical Contractors Ltd · Report EICR-2026-071842 · 6 Ashworth Terrace, Bramholt Page 4 of 12\n\nNATIONAL ELECTRICAL INSTALLERS REGISTER — DOMESTIC ELECTRICAL INSTALLATION CONDITION REPORT FORM ECR-1(D) ·  ISSUE 6 \n\nNo. EICR-2026-071842 Thornleigh Electrical Contractors Ltd Page 5 of 12 \n\nSUPPLY CHARACTERISTICS, EARTHING ARRANGEMENTS AND TEST INSTRUMENTS \n\nSUPPLY CHARACTERISTICS AND EARTHING ARRANGEMENTS \n\nNOMINAL VOLTAGE FREQUENCY NO. OF PHASES PFC AT ORIGIN ZE (MEASURED) ZE (BY ENQUIRY) MEANS OF EARTHING \n\n230V 50Hz 1 1.24kA 0.31Ω 0.35Ω PME (TN-C-S) \n\nMAIN PROTECTIVE BONDING —  WATER GAS OIL STRUCTURAL STEEL OTHER MAIN SWITCH \n\n10mm² 6mm² — see item 5 n/a n/a n/a 100A DP, understair cupboard \n\nDISTRIBUTION BOARD DB1 — DETAILS \n\nLOCATION MANUFACTURER / TYPE NO. OF WAYS RCD1 RATING/TYPE RCD2  RATING/TYPE MAIN SWITCH RATING \n\nHallway understair cupboard Crestwood Type CU12M 12 30/A 30/A 100A \n\nSplit-load consumer unit, ways 1-6 protected by RCD1, ways 7-10 protected by RCD2, ways 11-12 spare. Full circuit schedule at pages 6 and 7. \n\nDISTRIBUTION BOARD DB2  — DETAILS (GARDEN OFFICE /  GARAGE SUB-MAIN) \n\nLOCATION MANUFACTURER / TYPE NO. OF WAYS FED FROM RCD RATING/TYPE MAIN SWITCH RATING \n\nGarden office, wall-mounted Crestwood Type CU6S 6 DB1 way 9, via SWA 30/AC 40A \n\nTEST INSTRUMENTS USED FOR THIS INSPECTION \n\nINSTRUMENT MAKE / MODEL SERIAL NO. LAST CALIBRATED CALIBRATION DUE \n\nMultifunction installation tester Duxbury MFT7500 DX-771402 15/01/2026 15/01/2027 \n\nInsulation resistance tester Duxbury IR500 DX-550291 03/11/2025 03/11/2026 \n\nEarth loop / continuity tester Halden EFT-2 HD-229981 20/03/2026 20/03/2027 \n\nRCD tester Halden RCD-Pro HD-114420 08/08/2025 08/08/2026 \n\nAll instruments were within their calibration due date at the time of this inspection. Calibration certificates for each instrument are held on file by Thornleigh Electrical Contractors Ltd and are available to the client on request. \n\nThornleigh Electrical Contractors Ltd · Report EICR-2026-071842 · 6 Ashworth Terrace, Bramholt Page 5 of 12\n\nNATIONAL ELECTRICAL INSTALLERS REGISTER — DOMESTIC ELECTRICAL INSTALLATION CONDITION REPORT FORM ECR-1(D) ·  ISSUE 6 \n\nNo. EICR-2026-071842 Thornleigh Electrical Contractors Ltd Page 6 of 12 \n\nCIRCUIT SCHEDULE — DB1 (1 OF 2): DESCRIPTION, CONDUCTORS, CONTINUITY \n\nWAY CIRCUIT DESCRIPTION WIRING TYPE PTS CSA L/CPC MM² OCPD TYPE OCPD/RCD A/MA R1 Ω RN Ω R2  Ω R1+R2  Ω \n\n1 Ring final — kitchen sockets T&E, clipped direct 12 2.5/1.5 MCB B 32/30 0.42 0.39 0.68 1.10 \n\n2 Ring final — ground floor sockets T&E, clipped direct 12 2.5/1.5 MCB B 32/30 0.38 0.35 0.61 0.99 \n\n3 Ring final — first floor sockets T&E, clipped direct 10 2.5/1.5 MCB B 32/30 0.51 0.48 0.79 1.30 \n\n4 Radial — cooker T&E, clipped direct 1 6.0/2.5 MCB B 32/30 0.18 — 0.29 0.47 \n\n5 Lighting — ground floor T&E, clipped direct 8 1.5/1.0 MCB B 6/30 0.64 — 1.05 1.69 \n\n6 Lighting — first floor T&E, clipped direct 7 1.5/1.0 MCB B 6/30 0.71 — 1.16 1.87 \n\n7 Radial — immersion heater T&E, clipped direct 1 2.5/1.5 MCB B 16/30 0.33 — 0.55 0.88 \n\n8 Radial — electric shower T&E, clipped direct 1 10.0/4.0 RCBO B 40/30 0.09 — 0.15 0.24 \n\n9 Radial — garden office (SWA to DB2) SWA, clipped direct 1 6.0/2.5 RCBO B 32/30 0.61 — 1.02 1.63 \n\n10 Radial — smoke/heat alarms T&E, clipped direct 5 1.5/1.0 MCB B 6/30 0.44 — 0.73 1.17 \n\n11 spare way — — — — — — — — — \n\n12 spare way — — — — — — — — — \n\nContinuity of protective conductors (r2) and ring continuity (r1, rn, r2) measured in ohms at the distribution board with the supply disconnected, per NWSC-18 Chapter 64. Continued overleaf with insulation resistance, earth fault loop impedance and RCD results for the same ways. \n\nThornleigh Electrical Contractors Ltd · Report EICR-2026-071842 · 6 Ashworth Terrace, Bramholt Page 6 of 12\n\nNATIONAL ELECTRICAL INSTALLERS REGISTER — DOMESTIC ELECTRICAL INSTALLATION CONDITION REPORT FORM ECR-1(D) ·  ISSUE 6 \n\nNo. EICR-2026-071842 Thornleigh Electrical Contractors Ltd Page 7 of 12 \n\nCIRCUIT SCHEDULE — DB1 (2 OF 2): INSUL ATION RESISTANCE, LOOP IMPEDANCE, RCD \n\nWAY IR L-L MΩ IR L-E MΩ IR L-N MΩ ZS MAX/MEASURED Ω POLARITY RCD TRIP 1X/5X MS COMMENT \n\n1 >999 >999 >999 1.15/0.34 ✓ 18/9 — \n\n2 >999 >999 >999 1.15/0.31 ✓ 18/9 Item 3 \n\n3 >999 >999 >999 1.15/0.44 ✓ 18/9 — \n\n4 >999 >999 >999 1.15/0.28 ✓ 18/9 — \n\n5 >999 >999 >999 7.28/1.02 ✓ 22/11 — \n\n6 >999 >999 >999 7.28/1.14 ✓ 22/11 — \n\n7 >999 >999 >999 2.87/0.71 ✓ 22/11 Item 1 — C1 \n\n8 198 156 >999 1.09/0.22 ✓ 22/11 Tested at reduced voltage, see page 1 \n\n9 >999 >999 >999 1.15/0.58 ✓ 22/11 Item 4 — C2 \n\n10 >999 >999 >999 7.28/0.95 ✓ 22/11 — \n\n11 spare — — — — — — \n\n12 spare — — — — — — \n\nInsulation resistance tested at 500V d.c. between live conductors and between live conductors and earth, per NWSC-18 Chapter 64, and recorded as >999MΩ where the instrument reading exceeded its display range. Zs shown as tabulated maximum permitted value against measured value at the point furthest from the origin. RCD trip times measured at 1x and 5x rated residual operating current IΔn. \n\nThornleigh Electrical Contractors Ltd · Report EICR-2026-071842 · 6 Ashworth Terrace, Bramholt Page 7 of 12\n\nNATIONAL ELECTRICAL INSTALLERS REGISTER — DOMESTIC ELECTRICAL INSTALLATION CONDITION REPORT FORM ECR-1(D) ·  ISSUE 6 \n\nNo. EICR-2026-071842 Thornleigh Electrical Contractors Ltd Page 8 of 12 \n\nCIRCUIT SCHEDULE — DB2 (GARDEN OFFICE / GARAGE SUB-MAIN) \n\nZs measured at the origin of DB2 (fed from DB1 way 9): 0.58Ω. Prospective fault current at DB2 origin: 0.68kA. No independent earth electrode is installed; earthing at DB2 is by the SWA armour and cpc back to DB1, PME arrangement as recorded at page 5. \n\nWAY CIRCUIT DESCRIPTION WIRING TYPE PTS CSA L/CPC MM² OCPD/RCD A/MA R1/R2  Ω IR L-E MΩ ZS MAX/MEASURED Ω RCD TRIP 1X/5X MS \n\n1 Sockets — office T&E, clipped direct 6 2.5/1.5 20/30 0.31/0.52 >999 1.15/0.72 24/12 \n\n2 Lighting — office & garage T&E, clipped direct 4 1.5/1.0 6/30 0.48/0.79 >999 7.28/1.55 24/12 \n\n3 Radial — garage power tools socket T&E, clipped direct 1 4.0/1.5 32/30 0.22/0.37 >999 1.15/0.61 24/12 \n\n4 spare way — — — — — — — — \n\n5 spare way — — — — — — — — \n\n6 spare way — — — — — — — — \n\nAll ways at DB2 protected by the single 30/AC device fitted at this board. Polarity confirmed correct on all three active ways. See item 9 (page 4) regarding the missing test-button label on this enclosure. \n\nFUNCTIONAL TESTING AT DB2 \n\nTEST RESULT DATE TESTED \n\nRCD test button operated correctly Yes 02/09/2026 \n\nMain switch operated correctly Yes 02/09/2026 \n\nThornleigh Electrical Contractors Ltd · Report EICR-2026-071842 · 6 Ashworth Terrace, Bramholt Page 8 of 12\n\nNATIONAL ELECTRICAL INSTALLERS REGISTER — DOMESTIC ELECTRICAL INSTALLATION CONDITION REPORT FORM ECR-1(D) ·  ISSUE 6 \n\nNo. EICR-2026-071842 Thornleigh Electrical Contractors Ltd Page 9 of 12 \n\nADDITIONAL TEST DATA — RING CONTINUITY AND VOLTAGE DROP \n\nRING FINAL CIRCUIT CONTINUITY — SAMPLE READINGS AT SOCKET-OUTLETS \n\nWAY SAMPLE POINT R1 Ω RN Ω R2  Ω \n\n1 Kitchen, socket nearest DB1 0.11 0.10 0.18 \n\n1 Kitchen, socket mid-run (worktop) 0.21 0.19 0.34 \n\n1 Kitchen, socket furthest point (utility) 0.21 0.20 0.34 \n\n1 Kitchen, spur to washing machine 0.24 0.22 0.38 \n\n2 Hallway, socket nearest DB1 0.10 0.09 0.16 \n\n2 Living room, mid-run 0.19 0.18 0.30 \n\n2 Dining room, furthest point 0.19 0.17 0.31 \n\n3 Landing, socket nearest DB1 0.13 0.12 0.20 \n\n3 Bedroom 1, mid-run 0.26 0.24 0.40 \n\n3 Bedroom 3, furthest point 0.26 0.24 0.40 \n\nEnd-to-end readings taken with the ring temporarily broken at the board confirmed r1 = 0.51Ω, rn = 0.48Ω, r2 = 0.79Ω for way 3, consistent with the figure recorded at page 6. \n\nVOLTAGE DROP CALCULATION — CIRCUIT FURTHEST FROM ORIGIN \n\nCIRCUIT DESIGN CURRENT A CABLE LENGTH M MV/A/M CALCULATED DROP V PERMITTED DROP V \n\nWay 8 — electric shower 39 14 2.60 1.42 11.50 \n\nWay 9 — garden office feeder 28 22 1.15 0.71 11.50 \n\nEARTH ELECTRODE \n\nNot applicable. The installation is supplied under a PME (TN-C-S) arrangement, per page 5, and no independent earth electrode is fitted or required. \n\nFUNCTIONAL TESTING AT DB1 \n\nTEST RESULT DATE TESTED \n\nRCD1 test button operated correctly Yes 02/09/2026 \n\nRCD2 test button operated correctly Yes 02/09/2026 \n\nMain switch operated correctly Yes 02/09/2026 \n\nSmoke/heat alarm interlink function Yes, all 5 points sounded 02/09/2026 \n\nThornleigh Electrical Contractors Ltd · Report EICR-2026-071842 · 6 Ashworth Terrace, Bramholt Page 9 of 12\n\nNATIONAL ELECTRICAL INSTALLERS REGISTER — DOMESTIC ELECTRICAL INSTALLATION CONDITION REPORT FORM ECR-1(D) ·  ISSUE 6 \n\nNo. EICR-2026-071842 Thornleigh Electrical Contractors Ltd Page 10 of 12 \n\nRCD SUMMARY AND COMBINED EARTH FAULT LOOP IMPEDANCE RECAP \n\nRCD /  RCBO DEVICE SUMMARY \n\nBOARD DEVICE RATED A IΔN MA TYPE TRIP 1XIΔN MS TRIP 5XIΔN MS TEST BUTTON \n\nDB1 RCD1 (ways 1-6) 80 30 A 18 9 Pass \n\nDB1 RCD2 (ways 7-10) 80 30 A 22 11 Pass \n\nDB2 Main RCD (all ways) 40 30 AC 24 12 Pass \n\nMaximum permitted disconnection time for a 30mA RCD at 5xIΔn is 40ms; all three devices disconnect well within tolerance. Test button operation confirms the mechanical trip mechanism only and does not replace periodic testing with a calibrated instrument. \n\nCOMBINED EARTH FAULT LOOP IMPEDANCE RECAP, ALL CIRCUITS \n\nBOARD WAY DESCRIPTION ZS MAX/MEASURED Ω DISCONNECTION COMPLIANT \n\nDB1 1 Ring — kitchen 1.15/0.34 Yes \n\nDB1 2 Ring — ground floor 1.15/0.31 Yes \n\nDB1 3 Ring — first floor 1.15/0.44 Yes \n\nDB1 4 Radial — cooker 1.15/0.28 Yes \n\nDB1 5 Lighting — ground floor 7.28/1.02 Yes \n\nDB1 6 Lighting — first floor 7.28/1.14 Yes \n\nDB1 7 Radial — immersion heater 2.87/0.71 Yes \n\nDB1 8 Radial — electric shower 1.09/0.22 Yes \n\nDB1 9 Radial — garden office feeder 1.15/0.58 Yes \n\nDB1 10 Radial — smoke/heat alarms 7.28/0.95 Yes \n\nDB2 1 Sockets — office 1.15/0.72 Yes \n\nDB2 2 Lighting — office & garage 7.28/1.55 Yes \n\nDB2 3 Radial — garage power tools 1.15/0.61 Yes \n\nVerification of prospective fault current: measured PFC at the origin 1.24kA against the lowest rated breaking capacity of any protective device fitted, 6kA on all devices — adequacy confirmed. \n\nThornleigh Electrical Contractors Ltd · Report EICR-2026-071842 · 6 Ashworth Terrace, Bramholt Page 10 of 12\n\nNATIONAL ELECTRICAL INSTALLERS REGISTER — DOMESTIC ELECTRICAL INSTALLATION CONDITION REPORT FORM ECR-1(D) ·  ISSUE 6 \n\nNo. EICR-2026-071842 Thornleigh Electrical Contractors Ltd Page 11 of 12 \n\nSCHEDULE OF INSPECTIONS \n\nOutcome recorded against each item: ✓ satisfactory, C1/C2/C3 as classified at pages 3-4, N/V not verified, N/A not applicable. One column only is marked per item. \n\nITEM ✓ C1 C2 C3 N/V \n\n1.1 Service cable condition and support X \n\n1.2 Condition of service head and metering X \n\n2.1 Presence and condition of main earthing conductor X \n\n2.2 Main protective bonding, water service X \n\n2.3 Main protective bonding, gas service (item 5) X \n\n3.1 Consumer unit DB1, enclosure and labelling X \n\n3.2 Consumer unit DB1, circuit chart accuracy (item 6) X \n\n3.3 Condition of conductors within DB1 (item 1) X \n\n3.4 Sub-board DB2, enclosure and labelling (item 9) X \n\n4.1 Cables adequately supported throughout (item 7) X \n\n4.2 Accessories, condition of faceplates (item 8) X \n\n4.3 Socket-outlet positioning near water source (item 3) X \n\n4.4 RCD protection for buried/outdoor cables (item 4) X \n\n4.5 Identification of unrecorded circuits (item 12) X \n\n5.1 Supplementary bonding, bathroom (item 2) X \n\n5.2 Suitability of accessories in bathroom zones X \n\n6.1 Condition of light fittings (item 10) X \n\n6.2 Identification of cables at appliance connections (item 11) X \n\n6.3 Smoke and heat alarm provision X \n\nDECLARATION \n\nI/we, being the person(s) responsible for the inspection and testing of the electrical installation particulars of which are described above, having exercised reasonable skill and care when carrying out the inspection and testing, hereby declare that the information in this report, including the observations at pages 3-4 and the schedules above, provides an accurate assessment of the condition of the electrical installation, taking into account the extent and limitations recorded in Section D at page 1. \n\nINSPECTION CARRIED OUT ON 02 September 2026 \n\nNEXT INSPECTION RECOMMENDED BY 02 September 2031 \n\nSIGNED S. Marchetti \n\nFOR AND ON BEHALF OF Thornleigh Electrical Contractors Ltd \n\nThornleigh Electrical Contractors Ltd · Report EICR-2026-071842 · 6 Ashworth Terrace, Bramholt Page 11 of 12\n\nNATIONAL ELECTRICAL INSTALLERS REGISTER — DOMESTIC ELECTRICAL INSTALLATION CONDITION REPORT FORM ECR-1(D) ·  ISSUE 6 \n\nNo. EICR-2026-071842 National Electrical Installers Register Page 12 of 12 \n\nGUIDANCE NOTES ISSUED BY THE NATIONAL ELECTRICAL INSTALLERS REGISTER \n\nABOUT THIS REPORT \n\nThis report has been prepared with reference to the National Wiring Safety Code (NWSC-18), Amendment 3, which came into force on 28 September 2024 and supersedes Amendment 2 issued in 2018. Reports completed before that date, including any previous report for this installation, may have been assessed against an earlier edition of the code and should not be assumed to use the same classification thresholds. \n\nWHAT THE CLASSIFICATION CODES MEAN \n\nC1 — Danger present. Risk of injury. Immediate remedial action is required. Where a C1 observation is recorded, the contractor carrying out the inspection should, wherever practicable, make the installation safe before leaving site. \n\nC2 — Potentially dangerous. Urgent remedial action is required. A C2 observation does not present an immediate danger but could do so if left unaddressed. \n\nC3 — Improvement recommended. The item observed does not meet the current edition of the wiring code but does not by itself justify an unsatisfactory assessment. \n\nFI — Further investigation required without delay. Used where the inspector could not, within the extent and limitations of the inspection, determine whether an observed condition is dangerous. \n\nWHAT TO DO WITH THIS REPORT \n\nAny items classified C1 or C2 should be attended to by a competent person as a matter of urgency, and in any event before this installation is next occupied by a new tenant. Items classified C3 should be considered for improvement at a convenient time. This report, once any necessary remedial work has been completed and confirmed, does not need to be reissued; a separate minor works certificate or \n\nelectrical installation certificate should instead be obtained for the remedial work itself and kept alongside this report. \n\nRETENTION OF THIS REPORT \n\nThe client and the landlord should each retain a copy of this report, together with the schedules that form part of it, until it is superseded by a later report. A copy should be provided to the occupier of the installation and, where the property is let, to any new tenant before they take up occupation. \n\nCHECKING A CONTRACTOR’S REGISTRATION \n\nThe enrolment of a contractor with the National Electrical Installers Register can be checked using the scheme enrolment number shown on page 1, by contacting the scheme office below. A contractor whose registration has lapsed since a report was issued does not invalidate that report, but should be checked before further work is instructed from the same firm. \n\nABOUT THE SCHEME \n\nThe National Electrical Installers Register is a certification scheme for electrical contractors working on domestic and commercial installations. It is independent of, and separate from, both the contractor named on page 1 and any letting or managing agent named in this report. The scheme sets the model form on which this report is printed and audits enrolled contractors against the National Wiring Safety Code. \n\nNational Electrical Installers Register, NEIR House, 4 Somerville Court, Bostwick, BW1 4RE. Telephone 0300 456 7890. Website neir.example.org. Registered charity number CHY-441882. \n\nThese guidance notes, version 6, were issued on 01 April 2024 and are reprinted on the reverse of every report issued on this form. © National Electrical Installers Register 2024. Reproduction of this form by an enrolled contractor for the purpose of issuing reports is permitted; reproduction for any other purpose requires the scheme’s written consent. \n\nNational Electrical Installers Register · Form ECR-1(D) Issue 6 · Report EICR-2026-071842 Page 12 of 12\n",
    expected: {
    dates: ["2026-09-02","2031-09-02"],
    provider: "Thornleigh Electrical Contractors Ltd",
    reference: "EICR-2026-071842",
    dateRoles: [
      { date: "2026-09-02", role: "service" },
      { date: "2031-09-02", role: "service" },
    ],
    subtype: "Electrical installation condition report",
    recurrenceMonths: 60,
    scheduleKind: "service",
    },
  },
  {
    // Ground-truth notes:
    // - The only tracked date is 14 November 2026, the day the customer's fixed tariff ends, stated once mid-sentence in the second body paragraph ('your fixed price ends on 14 November 2026, and from the next day...'). It is never labelled, tabulated or bold.
    // - The letter's own date (8 September 2026, top right) is formatted identically to the answer and is a distractor, not a dateRole. The only bold text on the page is the switch-before deadline, 31 October 2026 — a different day from the tariff end date — which a naive extractor keyed on emphasis would wrongly prefer; it is excluded.
    // - Also excluded from `dates`: the plan start date (3 October 2024), the new fixed offer's own term end printed inside the tariff box (14 November 2027), the last statement date, the meter-reading-due date, the Ofgem price cap change date and the Ofgem consultation closing date (all four in the footer) — all texture a careful human would not report as the document's governing date.
    // - costMinor is the current fixed plan's annual cost shown first in the tinted comparison box (£1,284.00), not the standard variable projection shown second (£1,512.00) nor the new fixed offer shown third (£1,336.00).
    // - reference is the customer's account number printed in the address block (7724 6650 18), not the Energy Ombudsman's scheme reference (EOM/2026/774213) named in the footer, which belongs to a different organisation entirely.
    // - provider is Kittiwake Energy Ltd, the supplier issuing the letter and named in both the wordmark and the footer's registered-office text, not the Energy Ombudsman.
    // - scheduleKind is 'renewal' because the letter concerns the customer's tariff-renewal decision at the end of a fixed term, not a service or inspection visit.
    // -  
    // - T
    // - h
    // - e
    // -  
    // - e
    // - n
    // - d
    // -  
    // - d
    // - a
    // - t
    // - e
    // -  
    // - i
    // - s
    // -  
    // - r
    // - o
    // - l
    // - e
    // - d
    // -  
    // - '
    // - r
    // - e
    // - n
    // - e
    // - w
    // - a
    // - l
    // - '
    // -  
    // - r
    // - a
    // - t
    // - h
    // - e
    // - r
    // -  
    // - t
    // - h
    // - a
    // - n
    // -  
    // - '
    // - e
    // - x
    // - p
    // - i
    // - r
    // - y
    // - '
    // -  
    // - b
    // - e
    // - c
    // - a
    // - u
    // - s
    // - e
    // -  
    // - t
    // - h
    // - e
    // -  
    // - h
    // - o
    // - u
    // - s
    // - e
    // - h
    // - o
    // - l
    // - d
    // -  
    // - m
    // - u
    // - s
    // - t
    // -  
    // - a
    // - c
    // - t
    // -  
    // - a
    // - g
    // - a
    // - i
    // - n
    // -  
    // - o
    // - n
    // -  
    // - i
    // - t
    // - ,
    // -  
    // - w
    // - h
    // - i
    // - c
    // - h
    // -  
    // - i
    // - s
    // -  
    // - t
    // - h
    // - e
    // -  
    // - d
    // - i
    // - s
    // - t
    // - i
    // - n
    // - c
    // - t
    // - i
    // - o
    // - n
    // -  
    // - t
    // - h
    // - i
    // - s
    // -  
    // - c
    // - o
    // - r
    // - p
    // - u
    // - s
    // -  
    // - d
    // - r
    // - a
    // - w
    // - s
    // - :
    // -  
    // - '
    // - e
    // - x
    // - p
    // - i
    // - r
    // - y
    // - '
    // -  
    // - i
    // - s
    // -  
    // - r
    // - e
    // - s
    // - e
    // - r
    // - v
    // - e
    // - d
    // -  
    // - f
    // - o
    // - r
    // -  
    // - a
    // -  
    // - d
    // - o
    // - c
    // - u
    // - m
    // - e
    // - n
    // - t
    // -  
    // - t
    // - h
    // - a
    // - t
    // -  
    // - s
    // - i
    // - m
    // - p
    // - l
    // - y
    // -  
    // - r
    // - u
    // - n
    // - s
    // -  
    // - o
    // - u
    // - t
    // -  
    // - (
    // - t
    // - h
    // - e
    // -  
    // - M
    // - O
    // - T
    // -  
    // - c
    // - e
    // - r
    // - t
    // - i
    // - f
    // - i
    // - c
    // - a
    // - t
    // - e
    // - )
    // - ,
    // -  
    // - a
    // - n
    // - d
    // -  
    // - v
    // - e
    // - r
    // - i
    // - f
    // - y
    // - .
    // - m
    // - j
    // - s
    // -  
    // - d
    // - e
    // - r
    // - i
    // - v
    // - e
    // - s
    // -  
    // - s
    // - c
    // - h
    // - e
    // - d
    // - u
    // - l
    // - e
    // - K
    // - i
    // - n
    // - d
    // -  
    // - f
    // - r
    // - o
    // - m
    // -  
    // - t
    // - h
    // - e
    // -  
    // - r
    // - o
    // - l
    // - e
    // - .
    name: "energy tariff end letter, answer date buried mid-sentence against a bold rival deadline",
    filename: "fullpage-energy-tariff-end.pdf",
    text: "Kittiwake Energy — your fixed price is coming to an end  \n\nKittiwake  Energy \n\nMr Aidan Voss 14 Birchmoor Lane Calderwick Norfolk NR14 9QP \n\nAccount number: 7724 6650 18 \n\n8 September 2026 \n\nDear Mr Voss, \n\nThank you for being a Kittiwake Energy customer. We are writing to let you know that the fixed- price plan you joined on 3 October 2024, Kittiwake Fixed October 2024, is coming to the end of its term. This letter explains what happens next and the choices available to you. \n\nYour current plan guarantees the unit rates and standing charges you pay for both your gas and your electricity for as long as it runs. Based on our records, your fixed price ends on 14 November 2026, and from the next day your supply will move automatically onto our standard variable tariff, unless you choose a new plan with us before then. \n\nIf you would rather avoid moving onto the standard variable tariff, or you are thinking of switching to a different supplier, we would ask that you let us know by 31 October 2026. Choosing a new plan by this date, whether with us or elsewhere, means the change can be arranged smoothly and without any gap in your supply. \n\nTo help you decide, the table below sets out what you are paying now on your current fixed plan, what you would pay if you took no action and moved onto our standard variable tariff, and what we are able to offer you if you fix your prices again today. \n\nYour current plan, Kittiwake Fixed October 2024 £1,284.00 a year \n\nOur standard variable tariff, if you take no action £1,512.00 a year \n\nA new fixed plan, Kittiwake Fixed November 2026 (12 months, ending 14 November 2027) \n\n£1,336.00 a year \n\nFigures are annual costs for a medium-use dual-fuel household, based on the typical domestic consumption values published by Ofgem, and are provided for comparison only. Your own costs will depend on how much gas and electricity you use. \n\nPrices on our standard variable tariff can go up or down during the year, in line with Ofgem's price cap, whereas a new fixed plan holds your unit rates and standing charges steady for its whole term. If you would like to fix your prices again, you can do so through your online account or by calling our customer team, and the new plan can start as soon as your current one ends. \n\nWhere we can, we will take a reading from your smart meter automatically so your closing statement is accurate; otherwise we may need to use an estimate, so it is worth checking your online account nearer the time. \n\nIf you have any questions about this letter or the plans available to you, please get in touch with our customer team using the details below. Thank you again for your custom, and we look forward to continuing to supply your home. \n\nYours sincerely, \n\nRosalind Achebe Head of Customer Pricing, Kittiwake Energy Ltd \n\nRosalind AchebeKittiwake Energy Ltd, registered in England & Wales No. 07734215. Registered office: 2 Anchor Quay, Bristol, BS1 4ND. VAT registration No. GB 205 8842 10. \n\nKittiwake Energy Ltd is licensed to supply gas and electricity by Ofgem, the Office of Gas and Electricity Markets. Your last statement was issued on 14 August \n\n2026. Please submit a meter reading by 21 September 2026 so that any closing bill on your current plan is accurate. Ofgem's price cap changes on 1 October \n\n2026 and may affect the standard variable rates referred to in this letter; Ofgem is also currently consulting on further changes to the price cap methodology, \n\nwith responses invited until 2 December 2026. If we have not resolved your complaint to your satisfaction within eight weeks, you may refer it free of charge to \n\nthe Energy Ombudsman, quoting scheme reference EOM/2026/774213. Tariff end notice, form TEN-11-26, issued automatically to customers whose fixed term \n\nends within the next ten weeks.\n",
    expected: {
    dates: ["2026-11-14"],
    provider: "Kittiwake Energy Ltd",
    reference: "7724 6650 18",
    dateRoles: [
      { date: "2026-11-14", role: "renewal" },
    ],
    subtype: "Tariff end notice",
    costMinor: 128400,
    currency: "GBP",
    scheduleKind: "renewal",
    },
  },
  {
    // Ground-truth notes:
    // - Date of inspection, date of issue and the engineer's/receiving person's signature dates are all the same calendar day (03 August 2026), as is normal CP12 practice, so only one ISO date exists on the page and it is labelled once as role 'service'; the issued/signed labels are not treated as separate dateRoles entries since they share the one underlying date. The document never prints a next-inspection or expiry date anywhere (including the running header/footer) — only the digit interval '12 months' in the passband and small print — so recurrenceMonths=12 is declared but no next date is added to `dates`. No cost is stated anywhere on the document, so costMinor/currency are omitted.
    name: "gas safety record, interval in digits and no next date",
    filename: "fullpage-gas-safety-record.pdf",
    text: "Landlord's Gas Safety Record — CP12  \n\nLANDLORD'S GAS SAFETY RECORD LANDLORD / DUTYHOLDER COPY \n\nNo. GSR-2026-04471 CP12 Date of issue 03/08/2026 \n\nBUSINESS NAME \n\nFenwick & Vale Gas Services Ltd GAS SAFE REGISTERED BUSINESS, REGISTRATION NUMBER \n\n512864 \n\nBUSINESS ADDRESS \n\nUnit 4, Bridgewater Trading Estate, Calderbeck, Wynmouth WY7 2QN · Telephone 01947 552 118 · office@fenwickvale.example \n\nRecord of a gas safety check under the Gas Safety (Installation and Use) Regulations 1998 \n\nX RESULT: SATISFACTORY \n\nCertificate GSR-2026-04471 · Property below inspected and found safe to use on the date shown \n\nDATE OF INSPECTION \n\n03 August 2026 \n\nThis record confirms only that the appliances listed were safe to use on the day of inspection. It is not a guarantee of future safety or of efficient operation. This record is valid for 12 months from the date of inspection shown \n\nabove. \n\nENGINEER AND BUSINESS DETAILS \n\nENGINEER NAME \n\nMr R. Thackeray GAS SAFE LICENCE NO. \n\n745231 \n\nBUSINESS NAME \n\nFenwick & Vale Gas Services Ltd BUSINESS REGISTRATION \n\n512864 \n\nBUSINESS ADDRESS \n\nUnit 4, Bridgewater Trading Estate, Calderbeck, Wynmouth WY7 2QN \n\nTELEPHONE \n\n01947 552 118 \n\nCERTIFICATE NO. \n\nGSR-2026-04471 \n\nLANDLORD AND PROPERTY DETAILS \n\nLANDLORD NAME \n\nMr D. Okafor LANDLORD ADDRESS \n\n9 Aldermoor Close, Wynmouth WY4 8RT \n\nPROPERTY INSPECTED \n\nFlat 2, 14 Sycamore Court, Wynmouth WY2 5LB DATE OF INSPECTION \n\n03 August 2026 \n\nAPPLIANCES TESTED \n\nLOCATION APPLIANCE TYPE MAKE MODEL FLUE TYPE OP. PRESSURE SAFETY \n\nDEVICE COMBUSTION ANALYSER RESULT \n\nKitchen Combination boiler \n\nWorcester Bosch \n\nGreenstar 30i Combi \n\nRoom- sealed \n\n20.1 mbar FSD pass \n\nCO 12 ppm, CO₂ 8.9%, ratio 0.0013 \n\nX \n\nPASS \n\nLiving room \n\nInset gas fire Valor Petrus Illumia Balanced flue \n\n20.0 mbar FSD pass \n\nCO 8 ppm, CO₂ 6.1%, ratio 0.0013 \n\nX \n\nPASS \n\nCombustion analyser readings are recorded as measured by the engineer's calibrated analyser at the flue outlet. A CO:CO₂ ratio above 0.004 would require the appliance to be classified as At Risk; both appliances above are well \n\nwithin tolerance. \n\nDEFECTS AND REMEDIAL ACTION \n\nAPPLIANCE DEFECT OBSERVED REMEDIAL ACTION RECOMMENDED CLASSIFICATION \n\nKitchen boiler \n\nSealant around the flue terminal on the external wall is beginning to perish. \n\nRe-seal the flue terminal at the next routine visit; not required before continued use. \n\nNot to current standard, advisory only \n\nLiving room fire \n\nNo defects observed. None required. — \n\nWARNING NOTICE ISSUED: X  No Neither appliance was found to be At Risk or Immediately Dangerous, so no appliance was \n\ndisconnected and no warning notice was issued to the landlord or occupier. \n\nFenwick & Vale Gas Services Ltd · Certificate GSR-2026-04471 · 14 Sycamore Court, Flat 2 Page 1 of 2\n\nNo. GSR-2026-04471 CP12 · page 2 Fenwick & Vale Gas Services Ltd \n\nSAFETY DEVICE AND INSTALLATION CHECKS \n\nCHECK APPLIES TO RESULT \n\nFlame supervision device (FSD) Both appliances X  PASS \n\nSealed system expansion vessel and pressure Kitchen boiler X  PASS \n\nRoom thermostat and boiler controls Kitchen boiler X  PASS \n\nFlue flow and spillage test Both appliances X  PASS \n\nCase seal and door seal condition Living room fire X  PASS \n\nGas tightness test of installation pipework Whole installation X  PASS \n\nVisual inspection of pipework and jointing Whole installation X  PASS \n\nEmergency control valve, accessible and labelled Meter cupboard, hallway X  PASS \n\nAdequacy of ventilation to each appliance Both appliances X  PASS \n\nA gas tightness test was carried out on the whole installation and no leaks were detected. Ventilation was assessed as adequate for both appliances as installed; no permanent vents were found blocked or obstructed. \n\nCERTIFICATION AND SIGNATURES \n\nI certify that the gas appliances and installation pipework listed above were inspected on 03 August 2026 \n\nin accordance with the Gas Safety (Installation and Use) Regulations 1998, and found to be as recorded. \n\nSIGNATURE OF ENGINEER \n\nR. Thackeray, Gas Safe licence 745231 · for and on behalf of Fenwick & Vale Gas Services Ltd, registration 512864 · Signed 03 August 2026 \n\nA copy of this record has been issued to the person named below, receiving it on behalf of the landlord and \n\ntenant. \n\nSIGNATURE OF RECEIVING PERSON \n\nMs K. Adeyemi, letting agent for Mr D. Okafor · Received 03 August \n\n2026 \n\nTHE LANDLORD'S DUTY — SMALL PRINT \n\nAnnual check. Regulation 36 of the Gas Safety (Instal lation and Use) \n\nRegulations 1998 requires a landlord to have every gas appliance and \n\nflue in a rented property checked for safety by a Gas Safe registered \n\nengineer within 12 months of instal lation and at intervals of no more \n\nthan 12 months thereafter. This record is valid for 12 months from the \n\ndate of inspection shown above, and the landlord is responsible for \n\narranging the next check in good time. \n\nCopies to tenants. A copy of this record, or the relevant parts of it, must be \n\ngiven to each existing tenant of the property within 28 days of the check, \n\nand to any new tenant before they move in. A copy has been provided as \n\nrecorded in the signature block above. \n\nRecord retention. The landlord must retain this record, and the two \n\npreceding records where they exist, for at least 2 years from the date of \n\nthis check. Records should be kept safely and produced on request to the \n\nlocal authority or to the Health and Safety Executive. \n\nAccess for the check. A landlord may need to take reasonable steps, \n\nincluding legal advice, to obtain access to the property if a tenant \n\nunreasonably refuses entry for the annual check. Refusal by a tenant \n\ndoes not remove the landlord's duty to have the check carried out. \n\nScope of this record. This record covers only the gas appliances, flues and \n\npipework owned by the landlord and present at the property on the date \n\nof inspection. It does not cover appliances owned and instal led by the \n\ntenant, gas supply pipework beyond the meter which is the supplier's \n\nresponsibility, or electrical safety. \n\nChecking this engineer. The engineer's Gas Safe registration can be \n\nchecked using the licence number shown above. A registered engineer \n\nmust carry a Gas Safe ID card and should be asked to show it before work \n\nbegins. \n\nFenwick & Vale Gas Services Ltd · Certificate GSR-2026-04471 · 14 Sycamore Court, Flat 2 Page 2 of 2\n",
    expected: {
    dates: ["2026-08-03"],
    provider: "Fenwick & Vale Gas Services Ltd",
    reference: "GSR-2026-04471",
    dateRoles: [
      { date: "2026-08-03", role: "service" },
    ],
    subtype: "Gas safety record",
    recurrenceMonths: 12,
    scheduleKind: "service",
    },
  },
  {
    // Ground-truth notes:
    // - provider is the limited company that operates the club (clause 19: 'Cresswell Leisure Ltd, a company registered in England and Wales under company number 08823410'), not the trading name 'Cresswell Fitness Club' on the letterhead, and not the company number itself, which is a rival reference-shaped string. reference is the hand-filled membership number at the top of page 1 ('Membership No. CFC-004821'); price list ref 'PL-2026-03' is a rival. dates/dateRoles: the start date (02 March 2026, hand-filled overleaf) and the minimum-term end date, which is never printed in the member details block -- it appears only inside clause 4's prose, hand-filled into the printed sentence ('Your minimum term will end on 2 March 2027'). Rival, non-answer dates that are hand-filled in the same italic style as the start date: date of birth (14 July 1988, three lines above the start date field), the date the health questionnaire was completed (20 February 2026) and the date the member signed (27 February 2026) -- none of these are tracked. 'January 2027' (next fee review, clause 6) is a further rival close to but distinct from the exact renewal date. costMinor is the monthly Direct Debit fee of £42.50; the joining fee (£25.00), the paid-in-full annual fee (£459.00), the day-pass rate (£12.00) and the cancellation administration fee (£60.00) are rivals on the same price list. recurrenceMonths is 1, matching the monthly Direct Debit collection in clauses 5 and 12; the minimum term (12 months, clauses 1, 4 and 8), the maximum freeze period (3 months, clause 8) and the cancellation/variation notice period (1 calendar month, clauses 12, 6 and 22) are all cited elsewhere and give 12, 3 and 1 as rival period lengths. scheduleKind is 'renewal' because the membership rolls forward monthly after the minimum term (clause 4) rather than being a one-off service.
    name: "gym membership agreement, minimum-term end date only in clause prose",
    filename: "fullpage-gym-membership-agreement.pdf",
    text: "Cresswell Fitness Club — Membership Agreement  \n\nCFC \n\nCresswell Fitness Club I NDEPENDENT  HEALTH  &  F I TNESS  CLUB \n\n14 Foundry Lane, Bournholt, BH3 7QP · 01284 660 512 · desk@cresswellfitness.example \n\nGYM MEMBERSHIP AGREEMENT \n\nMEMBERSHIP NO. \n\nMEMBER DETAILS \n\nFULL NAME \n\nADDRESS \n\nDATE OF BIRTH \n\nHOME TELEPHONE MOBILE TELEPHONE \n\nEMAIL ADDRESS \n\nMEMBERSHIP START DATE \n\nEMERGENCY CONTACT \n\nMEMBERSHIP  TYPE \n\nOff-Peak Full Student Corporate \n\nPAYMENT TERMS \n\nITEM AMOUNT \n\nJoining fee (payable on signing, non-refundable) £25.00 \n\nMonthly membership fee, collected by Direct Debit £42.50 \n\nAnnual membership, paid in full in advance £459.00 \n\nDay-pass / guest rate, per visit £12.00 \n\nCancellation administration fee £60.00 \n\nPrices shown are those on current price list PL-2026-03, displayed at reception, and are subject to change under clause 6 overleaf. Payment method: Direct Debit, collected \n\nin advance on the 1st of each month. \n\nI confirm that I have completed the Club's health declaration questionnaire and disclosed any condition relevant to my use of the \n\nfacilities. \n\nQUESTIONNAIRE COMPLETED \n\nDECLARATION  AND  SIGNATURE \n\nI confirm that the details given above are correct and that I have read and agree to be bound by the terms and conditions of membership \n\noverleaf, which form part of this agreement. \n\nMEMBER'S SIGNATURE DATE SIGNED \n\nStaff member (for office use) \n\nMEMBER  COPY \n\nCFC-004821 \n\nDaniel Ostrowski \n\n12 Vale Road, Bournholt, BH4 2LN \n\n14 July 1988 \n\n01284 771 903 07700 900 442 \n\nd.ostrowski@mailbox.example \n\n02 March 2026 \n\nAnna Ostrowski, 07700 900 118 \n\nX \n\n20 February 2026 \n\nD Ostrowski 27 February 2026 \n\nJ. Traynor \n\nCresswell Fitness Club · 14 Foundry Lane, Bournholt, BH3 7QP Page 1 of 2\n\nCresswell Fitness Club Membership No. CFC-004821 · Daniel Ostrowski \n\nTERMS AND  CONDITIONS OF MEMBERSHIP \n\n1. Definitions. In this agreement, \"the Club\" means Cresswell Fitness Club, a trading name referred to throughout this agreement; \"you\" and \"your\" \n\nmean the member named overleaf; \"membership year\" means each successive 12-month period of your membership; \"we\", \"us\" and \"our\" mean the \n\noperator of the Club identified in clause 19. \n\n2. Membership categories. Membership is available as Full, Off-Peak, Student and Corporate, as marked overleaf. Off-Peak membership permits access \n\nMonday to Friday 09:00–16:00 only; Student membership requires proof of full-time enrolment; all other categories permit access during all published \n\nopening hours. \n\n3. Commencement. Your membership begins on the start date shown overleaf (\"your start date\") and is personal to you; it may not be transferred to, or \n\nused by, any other person. \n\n4. Minimum term. Full, Off-Peak and Student memberships are subject to an initial minimum term of 12 months from your start date. Your minimum term \n\nwill end on 2 March 2027 , after which your membership will continue automatically on a rolling monthly basis until cancelled by you or by us in \n\naccordance with clause 12. \n\n5. Fees and payment. The joining fee is payable in full on signing and is non-refundable. Your monthly membership fee is collected by Direct Debit in \n\nadvance on the 1st of each month for as long as your membership continues, including after your minimum term has ended. You may instead pay the \n\nannual fee in full in advance; the annual fee is discounted against twelve monthly payments but is non-refundable once paid. \n\n6. Price changes. We review our membership fees each January; your next scheduled review is due in January 2027. We will give you not less than 1 \n\nmonth's written notice of any increase, which will take effect from your next payment collection date. \n\n7. Day passes and guests. Non-members may use the Club as the day guest of a member on payment of the day-pass rate shown on the current price \n\nlist at reception, to a maximum of four guest visits per member per calendar month. \n\n8. Freezing your membership. You may freeze your membership on medical or other reasonable grounds for a maximum of 3 months in any period of 12 \n\nmonths, on written application to the Club Manager. No fee is payable during an approved freeze period. \n\n9. Health declaration. You must complete a health declaration questionnaire before your first use of the Club's facilities and update it if your health \n\nchanges materially. The Club may require a further declaration at renewal or after a freeze period. \n\n10. Induction. New members must complete a facility induction with a member of staff within 14 days of their start date before making unsupervised \n\nuse of resistance or cardiovascular equipment. \n\n11. Opening hours. The Club's core opening hours are Monday to Friday 06:00–22:00 and Saturday and Sunday 08:00–20:00, save that the Club is \n\nclosed on 25 December, 26 December and 1 January each year. \n\n12. Cancellation after your minimum term. After the end of your minimum term, you may cancel your membership by giving us not less than 1 \n\ncalendar month's written notice, to take effect from your next payment collection date. \n\n13. Suspension for non-payment. If a Direct Debit payment is returned unpaid, we may suspend your access to the Club until payment, together with \n\nthe applicable administration fee, is received in full. \n\n14. Code of conduct. Members must observe the Club's code of conduct, displayed at reception, including rules on equipment use, appropriate footwear \n\nand towel use in the fitness suite. \n\n15. Guests and children. Guests and children under 16 are admitted only in accordance with the Club's guest and junior access policy, available at \n\nreception, and must at all times be accompanied by a member. \n\n16. Property and lockers. The Club accepts no responsibility for loss of, or damage to, personal property, including items left in lockers, save where \n\ncaused by our negligence. \n\n17. Data protection. Personal data provided on this form is processed in accordance with our privacy notice, available at reception and on request, and \n\nis used to administer your membership and for no other purpose without your consent. \n\n18. CCTV. Closed-circuit television operates throughout the Club's public areas for the safety of members and staff; footage is retained for 31 days \n\nunless required for an investigation. \n\n19. The Club operator. Cresswell Fitness Club is a trading name of Cresswell Leisure Ltd, a company registered in England and Wales under company \n\nnumber 08823410, whose registered office is at 14 Foundry Lane, Bournholt, BH3 7QP. \n\n20. Complaints. Complaints should be addressed in the first instance to the Club Manager. Unresolved complaints may be referred in writing to \n\nCresswell Leisure Ltd at the registered office given in clause 19. \n\n21. Closure. We may close the Club, or any part of it, for maintenance, refurbishment or events beyond our reasonable control, and will give reasonable \n\nnotice where practicable. \n\n22. Variation of terms. We may vary these terms on not less than 1 month's notice, displayed at reception and, where practicable, notified to you in \n\nwriting or by email. \n\n23. Governing law. This agreement is governed by the law of England and Wales, and the courts of England and Wales have exclusive jurisdiction over \n\nany dispute arising from it. \n\nForm CFC-MA-07, terms reviewed January 2026 Page 2 of 2\n",
    expected: {
    dates: ["2026-03-02","2027-03-02"],
    provider: "Cresswell Leisure Ltd",
    reference: "CFC-004821",
    dateRoles: [
      { date: "2026-03-02", role: "start" },
      { date: "2027-03-02", role: "renewal" },
    ],
    subtype: "Gym membership agreement",
    costMinor: 4250,
    currency: "GBP",
    recurrenceMonths: 1,
    scheduleKind: "renewal",
    },
  },
  {
    // Ground-truth notes:
    // - Declared only the renewal date (14 March 2027), matching the task-specified shape; the date of issue (20 February 2026) and period-of-insurance start (14 March 2026) are printed on the schedule but left out of `dates`, even though a sibling corpus entry ('home insurance schedule, labelled fields') does surface a period start as a `start` role — flagging this as the judgement call most worth a second look. costMinor is the 'Annual premium' total (£412.99, net premium plus IPT) rather than the net-of-tax figure, since that is the line a policyholder would read as what they actually owe for the year; net premium, IPT, sums insured, excesses, optional-extra prices, and all monthly-instalment/APR/total-payable-if-monthly figures were left undeclared as distractors per the costMinor rule. provider is the underwriting insurer (Thornfield Assurance plc) rather than the intermediary (Hedgerow Home Insurance Services Ltd) that arranges the policy. reference is the policy number rather than the separate schedule reference (SCH-2027-4417).
    // - Period start 2026-03-14 added. The page prints 'Period of insurance 14 March 2026 to 14 March 2027', and the existing 'home insurance schedule, labelled fields' corpus entry declares both ends of the period. The agent that wrote this file declared only the renewal date and flagged the inconsistency; the existing convention wins.
    // - The date of issue (20 February 2026) is deliberately NOT declared, matching the same existing entry.
    // - Subtype changed from 'Home insurance' to 'Policy schedule'. 'Home insurance' appears nowhere as the document's own title — its only occurrence is inside the intermediary's company name, 'Hedgerow Home Insurance Services Ltd', 16% into the page. Grounding a subtype on that would be grounding it on the wrong company. The page titles itself 'Policy Schedule — Thornfield Assurance plc'.
    name: "home insurance schedule, premium among many amounts",
    filename: "fullpage-home-insurance-schedule.pdf",
    text: "Policy Schedule — Thornfield Assurance plc  \n\nThornfield Assurance plc — Policy schedule Policy TA-HH-7734291 — Page 1 of 3 \n\nTHORNFIELD ASSURANCE PLC \n\nRegistered office: Thornfield House, 12 Aldergate Row, Bristleham, Mercia BR4 9QP · Registered in England and Wales No. 03928471 · VAT registration \n\nnumber GB 528 4471 09 · Authorised by the Prudential Regulation Authority and regulated by the Financial Conduct Authority and the Prudential \n\nRegulation Authority. Firm reference number 187204. \n\nP OL I CY SCH E DUL E  —  H OME  BUI L DI N G S &  CON TE N TS \n\nDate of issue 20 February 2026  ·  Schedule ref SCH-2027-4417  ·  This schedule, the statement of insurance and the policy booklet HB-14 together form \n\nyour contract. \n\nPOL ICY N UM B E R  A N D PE R IOD \n\nPolicy number TA-HH-7734291 \n\nPeriod of insurance 14 March 2026 to 14 March 2027 \n\nRenewal date 14 March 2027 — cover ends automatically on this date unless renewed \n\nThis schedule replaces any schedule previously issued for this policy number. Please check the details below carefully and tell us at \n\nonce if anything is incorrect. \n\nPOL ICYH OL DE R \n\nPolicyholder Mr Daniel Okafor \n\nCorrespondence address 14 Wren Close, Middlebrook, Cassingford CF7 3RN \n\nRisk address Same as correspondence address \n\nIN TE R M E DIA RY \n\nIntermediary Hedgerow Home Insurance Services Ltd \n\nIntermediary address 8 Silvermead Court, Oakenfold, Drewshire DR1 2LP \n\nIntermediary FCA ref 559812 \n\nUN DE RWR ITIN G \n\nUnderwritten by Cambrian Re Insurance Company Ltd on behalf of Thornfield Assurance plc. Arranged and administered by \n\nHedgerow Home Insurance Services Ltd, which is authorised and regulated by the Financial Conduct Authority, firm reference \n\nnumber 559812. \n\nSUM S IN SUR E D \n\nBuildings — Reinstatement, including accidental damage £485,000 \n\nContents — Full replacement as new, including accidental damage £75,000 \n\nContents — single article limit — Higher value items must be listed separately £2,000 \n\nBuildings — accidental damage extension — See policy booklet section 4 Included \n\nYOUR  A N N UA L  PR E M IUM \n\nNet premium (excluding Insurance Premium Tax) £368.74 \n\nInsurance Premium Tax at 12% £44.25 \n\nAnnual premium £412.99 \n\nAnnual premium payable in full £412.99 \n\nHH/SCH/04.26 SCH-2027-4417 · Page 1 of 3\n\nThornfield Assurance plc — Policy schedule Policy TA-HH-7734291 — Page 2 of 3 \n\nPAYIN G  M ON TH LY \n\nIf you choose to spread the cost, your premium is financed by Thornfield Instalments, a trading name of Hedgerow Home Insurance \n\nServices Ltd. Interest is charged on the amount financed. Paying monthly costs more overall than paying in full. \n\nDeposit, collected on or after 14 March 2026 £37.99 \n\n11 further monthly instalments of £36.85 \n\nTotal payable if paying monthly £442.34 \n\nRepresentative rate 24.9% APR \n\nE XCE SSE S \n\nAn excess is the amount you pay towards any claim. Where more than one excess applies to a claim, the higher amount applies. The \n\nstandard excess below applies in addition to any peril excess shown against it. \n\nStandard excess (all other claims) £250 \n\nSubsidence, heave or landslip £1,000 \n\nEscape of water £350 \n\nAccidental damage £150 \n\nOPTIONA L  E XTR A S IN CLUDE D IN  TH IS POL ICY \n\nHome emergency cover (HomeAssist 24) £54.00 \n\nLegal expenses cover £24.50 \n\nBicycle cover away from home, up to £1,500 per cycle £18.75 \n\nThe cost of the optional extras above is included within the net premium shown on page 1 and is not payable in addition to it. \n\nN O CL A IM S DISCOUN T \n\nYears claim free 4 years \n\nDiscount applied 20% \n\nProtected No — a claim will reduce your discount at your next renewal \n\nE N DOR SE M E N TS A PPLYIN G  TO TH IS POL ICY \n\nEND/HO12 — Unoccupancy clause: cover is restricted if the \n\nproperty is left unoccupied for more than 30 consecutive days. See \n\npolicy booklet section 9. \n\nEND/SUB04 — The subsidence excess shown on this schedule \n\napplies instead of, not in addition to, the standard excess. \n\nEND/NCD05 — The no claims discount shown above has been \n\napplied to this premium and is not protected. \n\nEND/ALM02 — An approved intruder alarm, where fitted, must be \n\nset whenever the property is left unattended. \n\nHH/SCH/04.26 SCH-2027-4417 · Page 2 of 3\n\nThornfield Assurance plc — Policy schedule Policy TA-HH-7734291 — Page 3 of 3 \n\nYOUR  R IG H T TO CA N CE L \n\nCooling-off period. You may cancel this policy within 14 days of \n\nthe start date of the period of insurance shown on page 1, or the \n\nday you receive your policy documents if later, without giving a \n\nreason. Provided no claim has been made, we will refund any \n\npremium you have paid for the period after cancellation. If you pay \n\nmonthly, any outstanding instalments will stop and we will refund \n\nthe difference between what you have paid and the cost of cover \n\nprovided up to the date of cancellation. \n\nCancelling after the cooling-off period. You may cancel at any \n\ntime by writing to Hedgerow Home Insurance Services Ltd at the \n\naddress on page 1. We will refund any premium paid for the \n\nremaining period of insurance, less a proportionate deduction for \n\nthe time you have been covered and an administration charge of \n\n£25.00. No refund is due if you have made a claim during the period \n\nof insurance. \n\nHow we may cancel. We may cancel this policy by giving you at \n\nleast 14 days’ notice in writing, sent to the correspondence address \n\nshown on page 1, where there is a valid reason to do so, such as \n\nnon-payment of premium, non-disclosure or fraud. We will explain \n\nour reason when we write to you. \n\nComplaints. If you are unhappy with any aspect of this policy or \n\nhow a claim has been handled, contact Hedgerow Home Insurance \n\nServices Ltd in the first instance. If your complaint is not resolved \n\nto your satisfaction, you may refer it to the Financial Ombudsman \n\nService, free of charge, normally within six months of our final \n\nresponse. \n\nFinancial Services Compensation Scheme. Thornfield Assurance \n\nplc is covered by the Financial Services Compensation Scheme. You \n\nmay be entitled to compensation if we are unable to meet our \n\nobligations, depending on the type of policy and the circumstances \n\nof the claim. \n\nData protection. Your information is processed by Thornfield \n\nAssurance plc and Hedgerow Home Insurance Services Ltd in \n\naccordance with our privacy notices, available at \n\nthornfieldassurance.example/privacy. Data protection registration \n\nZB5528417. \n\nIM PORTA N T N OTE S A B OUT TH IS SCH E DUL E \n\nPlease read this schedule together with your statement of \n\ninsurance and the policy booklet reference HB-14 (edition March \n\n2026). Together these documents form your contract of insurance. \n\nIf any detail on this schedule is incorrect, or your circumstances \n\nchange during the period of insurance, you must tell Hedgerow \n\nHome Insurance Services Ltd as soon as reasonably practicable, as \n\nthis may affect your cover or premium. A renewal invitation will be \n\nsent to you ahead of the renewal date shown on page 1; cover will \n\nnot continue automatically beyond that date unless you accept the \n\nrenewal terms offered. \n\nThornfield Assurance plc, registered office Thornfield House, 12 Aldergate Row, Bristleham, Mercia BR4 9QP. Registered in England and Wales, company \n\nnumber 03928471. VAT registration number GB 528 4471 09. Authorised by the Prudential Regulation Authority and regulated by the Financial Conduct \n\nAuthority and the Prudential Regulation Authority, firm reference number 187204. Hedgerow Home Insurance Services Ltd, registered office 8 Silvermead \n\nCourt, Oakenfold, Drewshire DR1 2LP, company number 07714402, is authorised and regulated by the Financial Conduct Authority, firm reference number \n\n559812. \n\nHH/SCH/04.26 SCH-2027-4417 · Page 3 of 3\n",
    expected: {
    dates: ["2026-03-14","2027-03-14"],
    provider: "Thornfield Assurance plc",
    reference: "TA-HH-7734291",
    dateRoles: [
      { date: "2026-03-14", role: "start" },
      { date: "2027-03-14", role: "renewal" },
    ],
    subtype: "Policy schedule",
    costMinor: 41299,
    currency: "GBP",
    scheduleKind: "renewal",
    },
  },
  {
    // Ground-truth notes:
    // - The policy start date (18 October 2026) and end date (17 October 2046) appear only on the page-13 schedule, along with the policy number and the monthly premium; nothing before page 13 states them. The ten terms pages (3-12) carry roughly 24,000 characters of clause text ahead of the schedule, so an extractor that truncates its input at 12,000 characters and reads only the head never reaches any of the answer fields. Distractors seeded before page 13: the cover page's large 'Issued: 12 June 2026' and 'Edition 4, revised 14 January 2026' dates (both in the first 500 characters); a claim-notification worked example (3 March 2026 / 2 April 2026); a critical-illness waiting-period worked example (1 March 2025 / 29 May 2025); a cancellation cooling-off worked example (3 April 2026 / 3 May 2026); a complaints-timescale worked example (1 June 2026 / 27 July 2026); the date the terms were last updated (4 February 2026); the regulator authorisation date (15 September 2004); and an eight-row premium review table (1 January 2027 through 2034) -- 20 distractor dates in total before the schedule, against the 2 answers. costMinor is the monthly premium (£32.50) shown on the schedule; the rival amounts printed nearby -- the sum assured (£150,000.00), the critical illness benefit (£75,000.00), the annual premium option (£351.00) and the total premiums payable over the full term (approximately £7,800.00, also previewed on page 12) -- are all deliberately not the answer. provider is the insurer, Ashcombe Life Assurance plc, not the fund manager (Meridian Asset Management Ltd, which manages the assets backing the policy) or the reinsurer (Continental Re (UK) Ltd, which reinsures part of the risk) -- both named in section 8 but neither the entity that issued the policy. reference is the policy number, printed on the schedule and, from page 13 onward, in the running footer; the document code in the footer of every page (Form ALA-PB-LCI-07) is a separate identifier and not the reference. recurrenceMonths is 1 because the schedule states premiums are 'paid every 1 month'; scheduleKind is declared 'renewal' per the brief for this document even though both declared dateRoles are 'start' and 'expiry' rather than 'renewal' -- this is a known mismatch against verify.mjs's role-derivation check (which infers scheduleKind only from a 'renewal' or 'service' role) and should be reconciled centrally rather than in this fixture. scheduleKind and recurrenceMonths are both omitted: a 20-year term policy ends rather than renewing, so the end date is 'expiry' like the MOT certificate, and recurrenceMonths in this corpus means the cycle of the thing (a 24-month contract, a 12-month inspection interval), not how often the premium is paid.
    name: "life and critical illness booklet, answers only on the page-13 schedule past the truncation point",
    filename: "fullpage-life-cover-booklet.pdf",
    text: "Ashcombe Life Assurance plc — Life and Critical Illness Cover: Policy Booklet  \n\nLife and Critical Illness Cover \n\nYour terms and conditions, and how to make a claim \n\nAshcombe Life Assurance plc \n\nIssued: 12 June 2026 \n\nThis edition: Edition 4, revised 14 January 2026 \n\nPolicy type: Life cover policy (with optional critical illness cover) \n\nThis booklet explains what is and is not covered under your Ashcombe Life Assurance plc life and critical illness \n\npolicy, how to make a claim, and what to do if you need to complain. Please read it alongside your policy \n\nschedule, which is printed at the back of this booklet and which sets out the specific details of your own cover, \n\nincluding your sum assured, your premium, and the dates your cover starts and ends. Keep both documents \n\ntogether in a safe place, and tell the people who may need to make a claim where to find them. \n\nPO L I CY  BO O K LET \n\nForm ALA-PB-LCI-07 · Ashcombe Life Assurance plc is authorised by the Prudential Regulation Authority\n\nContents \n\n1 Welcome and how to use this booklet 3 \n\n2 Your cover 3 \n\n3 Making a claim 5 \n\n4 Exclusions and limitations 6 \n\n5 Cancelling your policy 8 \n\n6 Complaints and how we handle them 9 \n\n7 Definitions 10 \n\n8 How your policy is administered 11 \n\n9 Premiums and reviews 12 \n\n10 Your policy schedule 13 \n\n11 Contacts and regulatory information 14 \n\nThis booklet is issued by Ashcombe Life Assurance plc. It should be read together with your policy schedule (section 10), which records the \n\nspecific details of your own cover. If you cannot find what you are looking for, section 11 lists how to contact us.\n\nASHCOMBE LIFE ASSURANCE PLC — POLICY BOOKLET YOUR COVER — PAGE 3 OF 14 \n\n1. WELCOME AND HOW  TO USE THIS BOOKLET \n\n1.1  This booklet sets out the terms and conditions that apply to your life \n\nand critical illness policy with Ashcombe Life Assurance plc (\"we\", \n\n\"us\", \"our\"), referred to in this booklet as the Insurer. It should be read \n\ntogether with your policy schedule, which records the specific details of \n\nyour cover, including your sum assured, your premium, and the dates \n\nyour cover starts and ends. \n\n1.2  Where a word or phrase has a particular meaning under this policy, \n\nit appears in bold the first time it is used in this booklet and is explained \n\nin full in section 7, Definitions. \n\n1.3  If anything in your policy schedule conflicts with anything in this \n\nbooklet, the policy schedule takes precedence, except where this booklet \n\nexpressly states that a term cannot be varied by the schedule. \n\n1.4  Nothing in this booklet is, by itself, a contract of insurance. Your \n\ncontract is made up of this booklet, your policy schedule, the statements \n\nmade in your application, and any special terms we have confirmed to \n\nyou in writing. \n\n1.5  This booklet does not cover every situation. If you are unsure \n\nwhether something is covered, contact us using the details in section 11 \n\nbefore you rely on cover being in place. \n\n1.6  We may record and monitor telephone calls for training, quality and \n\nsecurity purposes, and to help resolve any dispute about what was said. \n\n2. YOUR COVER \n\n2.1  What this policy provides \n\n2.1.1  This policy provides a single lump sum benefit, the sum assured, \n\npayable on the death of the life assured during the period of cover, or on \n\nthe diagnosis of a specified critical illness meeting the definition in \n\nsection 7, whichever happens first, subject always to the exclusions in \n\nsection 4. \n\n2.1.2  The life assured is the person named as the life assured on your \n\npolicy schedule. Where the policy is written on a joint life basis, both \n\nlives are named on the schedule, and cover ends on payment of a claim \n\nfor either life unless the schedule states that the policy continues on a \n\njoint life, second-death basis. \n\n2.1.3  The amount we pay on a death claim is the sum assured shown on \n\nyour policy schedule, less any amount already paid under this policy for \n\nan earlier critical illness claim under clause 2.1.4. \n\n2.1.4  Where a critical illness claim is accepted, we pay a proportion of \n\nthe sum assured, the accelerated benefit, in the amount shown as the \n\ncritical illness benefit on your policy schedule. This amount is then \n\ndeducted from the sum assured otherwise payable on death, so the total \n\nwe will ever pay under this policy does not exceed the sum assured. \n\n2.1.5  Cover under this policy runs for the period shown on your policy \n\nschedule. We call the first day of that period the start date and the last \n\nday the expiry date. No benefit is payable for an event happening before \n\nthe start date or after the expiry date shown on your schedule. \n\n2.1.6  This policy is not a savings, investment or pension product, and it \n\ndoes not participate in any with-profits fund or investment performance. \n\nThe only benefit under this policy is the payment described in clause \n\n2.1.1. \n\nForm ALA-PB-LCI-07 Page 3 of 14\n\nASHCOMBE LIFE ASSURANCE PLC — POLICY BOOKLET YOUR COVER — PAGE 4 OF 14 \n\n2. YOUR COVER (CONTINUED) \n\n2.2  When cover begins and ends \n\n2.2.1  Cover starts on the start date shown on your policy schedule, \n\nprovided your first premium has been paid and accepted by us. It ends \n\nautomatically on the expiry date shown on your schedule, on payment of \n\na valid claim for the full sum assured, on the death of the life assured, or \n\non cancellation under section 5, whichever happens first. \n\n2.2.2  This policy does not build up a cash value and has no surrender \n\nvalue at any time. If you stop paying premiums, cover simply ends; you \n\ndo not receive anything back. \n\n2.3  Waiting period for critical illness cover \n\n2.3.1  A waiting period of 90 days applies to critical illness cover only, \n\nbeginning on the start date shown on your schedule. No critical illness \n\nbenefit is payable for a condition first diagnosed, or for symptoms first \n\ninvestigated, during the waiting period. Life cover is not subject to a \n\nwaiting period. \n\n2.3.2  For example, on a policy with a start date of 1 March 2025, a \n\ncritical illness first diagnosed before 29 May 2025 would not be covered, \n\neven if the underlying condition began after the start date. This example \n\nis illustrative only and does not describe your own policy; your own dates \n\nare shown on your policy schedule. \n\n2.4  Premium reviews \n\n2.4.1  Your premium may be reviewed on each premium review date \n\nshown in the table in section 9. A review may increase, or in limited \n\ncircumstances decrease, your premium; it does not change your sum \n\nassured. \n\n2.5  Indexation \n\n2.5.1  If you have chosen indexation on your policy schedule, your sum \n\nassured and premium increase automatically each year in line with the \n\nincrease shown on your schedule. You may decline an indexation \n\nincrease by telling us in writing within 30 days of our notice; declining an \n\nincrease twice in succession removes the indexation option \n\npermanently. \n\n2.6  Continuing cover after a claim \n\n2.6.1  Where we pay a critical illness benefit that is less than the full \n\nsum assured, life cover continues for the balance until the expiry date, at \n\nthe premium shown in the confirmation we send you following the \n\nclaim. \n\n2.6.2  If the life assured dies during the notice period following a critical \n\nillness claim decision but before payment has been made, we will pay \n\nthe higher of the accepted critical illness benefit and the sum assured, \n\nless anything already paid under this policy. \n\n2.7  Other people who can act on this policy \n\n2.7.1  Only the policyholder, or a person with a valid power of attorney or \n\ngrant of probate, may give us instructions about this policy. We may ask \n\nfor evidence of the authority to act before accepting instructions from \n\nanyone else. \n\nForm ALA-PB-LCI-07 Page 4 of 14\n\nASHCOMBE LIFE ASSURANCE PLC — POLICY BOOKLET MAKING A CLAIM — PAGE 5 OF 14 \n\n3. MAKING A CLAIM \n\n3.1  Telling us about a claim \n\n3.1.1  You, or someone acting on your behalf, must tell us about a claim as \n\nsoon as reasonably possible, and in any event within 30 days of the event \n\ngiving rise to the claim, using the claims line in section 11. \n\n3.1.2  For example, if the event giving rise to a claim happened on 3 \n\nMarch 2026, the claim should be notified to us by 2 April 2026. This \n\nexample is illustrative only and does not describe your own policy. \n\n3.1.3  If you tell us about a claim later than 30 days after the event, we \n\nmay still consider it, but a delay that prevents us from investigating the \n\nclaim properly may affect whether, and how much, we pay. \n\n3.2  What we will ask for \n\n3.2.1  We may ask for a completed claim form, a death certificate or \n\nmedical evidence of the diagnosis, consent to access medical records, \n\nand evidence of the life assured's identity and date of birth. \n\n3.2.2  We may ask the life assured, or in the case of a death claim the \n\nperson claiming, to be examined by a doctor of our choosing, at our \n\nexpense, before we decide the claim. \n\n3.2.3  All costs of providing evidence in support of a claim, other than an \n\nexamination we have asked for under clause 3.2.2, are met by the person \n\nmaking the claim. \n\n3.3  Deciding and paying a claim \n\n3.3.1  We aim to make a decision on a complete claim within 20 working \n\ndays of receiving all the evidence we reasonably need. Where a claim is \n\naccepted, payment is made within 5 working days of our decision, by \n\ndirect transfer to the bank account you have given us. \n\n3.3.2  Interest is not payable on a claim paid within the timescales in \n\nclause 3.3.1. \n\n3.4  If we decline a claim \n\n3.4.1  If we decline a claim, we will write to you explaining why, and tell \n\nyou how to ask us to look at the decision again, and how to refer the \n\nmatter to the Financial Ombudsman Service if you remain unhappy — \n\nsee section 6. \n\n3.5  If you disagree with our decision \n\n3.5.1  If you think we have made a mistake in assessing your claim, ask us \n\nto review it, providing any further information you think is relevant. A \n\nreview is carried out by someone who was not involved in the original \n\ndecision. \n\n3.6  Fraudulent claims \n\n3.6.1  If a claim, or any information given to support it, is fraudulent or \n\nintentionally exaggerated, we may refuse the whole claim, recover any \n\namount already paid, and cancel this policy without refunding your \n\npremiums. \n\nForm ALA-PB-LCI-07 Page 5 of 14\n\nASHCOMBE LIFE ASSURANCE PLC — POLICY BOOKLET EXCLUSIONS AND LIMITATIONS — PAGE 6 OF 14 \n\n4. EXCLUSIONS AND LIMITATIONS \n\n4.1  General exclusions \n\n4.1.1  We do not pay a claim arising directly or indirectly from the life \n\nassured taking part in war, invasion, act of a foreign enemy, hostilities, \n\ncivil war, rebellion, revolution, insurrection or military coup, whether \n\ndeclared or not. \n\n4.1.2  We do not pay a claim where the death or diagnosis results from \n\nthe life assured's own criminal act. \n\n4.1.3  Death by suicide is excluded if it occurs within 12 months of the \n\nstart date. After 12 months from the start date, death by suicide is \n\ncovered in the same way as any other cause of death. \n\n4.1.4  We may reduce or refuse a claim, or treat the policy as if it never \n\nexisted, where the life assured failed to disclose a material fact when \n\napplying for cover, and that fact would have affected our decision to offer \n\ncover or the terms on which we offered it. \n\n4.1.5  Cover applies to events occurring anywhere in the world, but a \n\nclaim arising from travel to, or residence in, a country against which the \n\nForeign, Commonwealth and Development Office has issued advice \n\nagainst all travel at the relevant time may be investigated further before \n\nwe pay. \n\n4.1.6  We do not pay a claim arising from a diagnosis made, or treatment \n\ngiven, outside a recognised hospital or clinic, unless we agree in advance \n\nthat the circumstances made this impossible or inappropriate. \n\n4.2  Critical illness exclusions \n\n4.2.1  We do not pay a critical illness benefit for a condition, or the \n\nunderlying cause of a condition, that a reasonable person would have \n\nexpected to seek medical advice about before the start date, whether or \n\nnot a diagnosis had actually been made. \n\nForm ALA-PB-LCI-07 Page 6 of 14\n\nASHCOMBE LIFE ASSURANCE PLC — POLICY BOOKLET EXCLUSIONS AND LIMITATIONS — PAGE 7 OF 14 \n\n4. EXCLUSIONS AND LIMITATIONS (CONTINUED) \n\n4.2.2  We do not pay a critical illness benefit for a diagnosis made, or \n\nsymptoms first investigated, during the 90-day waiting period described \n\nin clause 2.3. \n\n4.2.3  Each specified critical illness covered by this policy must meet \n\nthe full definition used in the Association of British Insurers' model \n\nwording current at the start date, as summarised in section 7. A diagnosis \n\nthat does not meet that definition, even if described using the same \n\nname by a treating clinician, is not covered. \n\n4.2.4  We do not pay a critical illness benefit for total permanent \n\ndisability unless you have selected total permanent disability cover on \n\nyour policy schedule and paid the additional premium shown for it. \n\n4.3  Territorial and activity limits \n\n4.3.1  We do not pay a claim arising from the life assured's participation \n\nin motor racing, motorcycle racing, aviation other than as a fare-paying \n\npassenger on a licensed airline, or professional sport, unless we have \n\nagreed in writing to cover the activity and any additional premium has \n\nbeen paid. \n\n4.3.2  We do not pay a claim arising from the life assured's use of a \n\ncontrolled drug other than as prescribed by a registered medical \n\npractitioner, or from alcohol misuse where alcohol misuse is recorded as \n\na contributing cause on the death certificate or medical report. \n\n4.4  How exclusions interact with your schedule \n\n4.4.1  Your policy schedule may list further exclusions specific to you, \n\nagreed at the time you applied for cover. Those exclusions apply in \n\naddition to the exclusions in this section and take priority over anything \n\nin this section that conflicts with them. \n\n4.5  How exclusions are applied \n\n4.5.1  An exclusion in this section applies only to the specific event it \n\ndescribes. It does not otherwise reduce the cover provided by this policy, \n\nand a claim that does not fall within an exclusion is assessed in the \n\nnormal way described in section 3. \n\nForm ALA-PB-LCI-07 Page 7 of 14\n\nASHCOMBE LIFE ASSURANCE PLC — POLICY BOOKLET CANCELLING YOUR POLICY — PAGE 8 OF 14 \n\n5. CANCELLING YOUR POLICY \n\n5.1  Your right to cancel \n\n5.1.1  You have a cooling-off period of 30 days from the later of the day \n\nyou receive your policy schedule and this booklet, and the day you \n\nreceive our first written confirmation that cover has started, during \n\nwhich you may cancel this policy and receive a full refund of any \n\npremium paid, provided no claim has been made. \n\n5.1.2  For example, if you received your policy schedule and this booklet \n\non 3 April 2026, your cooling-off period would end on 3 May 2026. This \n\nexample is illustrative only and does not describe your own policy. \n\n5.1.3  To cancel during the cooling-off period, write to us at the address \n\nin section 11, or call the number shown there. We will confirm \n\ncancellation in writing and refund any premium within 10 working days. \n\n5.2  Cancelling after the cooling-off period \n\n5.2.1  After the cooling-off period ends, you may cancel this policy at any \n\ntime by telling us in writing. Cover ends on the date we receive your \n\ninstruction, or a later date you specify. No refund of premiums already \n\npaid is given for cover already provided. \n\n5.2.2  If you cancel, or if a claim ends this policy, you may be able to \n\napply for a new policy, but this will be treated as a new application, \n\nassessed on the medical and other information current at that time, and \n\nany waiting period described in clause 2.3 will begin again from the new \n\nstart date. \n\n5.3  Our right to cancel \n\n5.3.1  We may cancel this policy by giving you 30 days' written notice if \n\nwe reasonably suspect fraud, or if a premium remains unpaid for more \n\nthan 30 days after its due date despite the reminder described in clause \n\n9.3. \n\n5.3.2  We will not cancel this policy simply because you have made a \n\nvalid claim, or because your health has changed since the start date. \n\n5.4  If the life assured dies during the cooling-off period \n\n5.4.1  If the life assured dies during the cooling-off period described in \n\nclause 5.1, we will pay the sum assured as if the policy had not been \n\ncancelled, provided the premium had been paid and the death is not \n\notherwise excluded under section 4. \n\nForm ALA-PB-LCI-07 Page 8 of 14\n\nASHCOMBE LIFE ASSURANCE PLC — POLICY BOOKLET COMPLAINTS — PAGE 9 OF 14 \n\n6. COMPLAINTS AND HOW  WE HANDLE THEM \n\n6.1  How to complain \n\n6.1.1  If you are unhappy with any decision we have made, or with the \n\nservice you have received, please tell us. Contact details for our \n\ncomplaints team are in section 11. \n\n6.1.2  Please give us your policy number, your name, and as much detail \n\nas you can about the reason for your complaint, so that we can look into it \n\nproperly. \n\n6.2  What happens next \n\n6.2.1  We will acknowledge your complaint within 5 working days. We \n\naim to send you a final response within 4 weeks, and in any event within \n\n8 weeks, of receiving your complaint. \n\n6.2.2  For example, a complaint received on 1 June 2026 would normally \n\nreceive a final response by 27 July 2026 at the latest. This example is \n\nillustrative only. \n\n6.2.3  If we cannot resolve your complaint within 8 weeks, we will write \n\nto you explaining why, and tell you about your right to refer the matter to \n\nthe Financial Ombudsman Service. \n\n6.3  The Financial Ombudsman Service \n\n6.3.1  If you remain unhappy with our final response, or if 8 weeks have \n\npassed without one, you may refer your complaint to the Financial \n\nOmbudsman Service free of charge, normally within 6 months of our final \n\nresponse. \n\n6.4  The Financial Services Compensation Scheme \n\n6.4.1  We are covered by the Financial Services Compensation Scheme. \n\nIf we are unable to meet our obligations under this policy, you may be \n\nentitled to compensation, depending on the type of policy and the \n\ncircumstances of the claim. Further details are in section 11. \n\n6.5  Vulnerable customers \n\n6.5.1  If you tell us that you, or the life assured, need extra support \n\nbecause of a disability, bereavement, or another circumstance, we will \n\nmake reasonable adjustments to how we communicate with you and \n\nhandle your complaint or claim. \n\nForm ALA-PB-LCI-07 Page 9 of 14\n\nASHCOMBE LIFE ASSURANCE PLC — POLICY BOOKLET DEFINITIONS — PAGE 10 OF 14 \n\n7. DEFINITIONS \n\nThe following words and phrases have the meaning given below \n\nwherever they appear in bold in this booklet and in your policy schedule. \n\nInsurer — Ashcombe Life Assurance plc, the company providing \n\nthis policy. \n\nPolicyholder — the person named as the policyholder on the \n\npolicy schedule, who owns this policy and is responsible for paying \n\nthe premium. \n\nLife Assured — the person on whose life or health a claim under \n\nthis policy depends, as named on the policy schedule. \n\nSum Assured — the maximum amount payable under this policy, \n\nas shown on the policy schedule. \n\nCritical Illness — a condition meeting one of the specified \n\ndefinitions summarised in this section, based on the Association of \n\nBritish Insurers' model wording. \n\nWaiting Period — the 90-day period described in clause 2.3, \n\nduring which no critical illness benefit is payable. \n\nAccelerated Benefit — a critical illness benefit paid as an advance \n\nagainst the sum assured, reducing the amount payable on a later \n\ndeath claim. \n\nTotal Permanent Disability — permanent inability to carry out at \n\nleast three of the six activities of daily living listed on your policy \n\nschedule, as certified by a consultant we approve, where total \n\npermanent disability cover has been selected. \n\nCooling-Off Period — the 30-day period described in clause 5.1, \n\nduring which you may cancel this policy and receive a full refund. \n\nMaterial Fact — information that would have affected our decision \n\nto offer this policy, or the terms on which we offered it, had we \n\nknown it when you applied. \n\nPremium Review Date — a date shown in the table in section 9 on \n\nwhich your premium may be reviewed. \n\nTerminal Illness — an advanced or rapidly progressing illness \n\nwhere, in the opinion of the attending consultant, life expectancy \n\nis 12 months or less; a valid terminal illness claim is paid in advance \n\nof a death claim. \n\nStart Date — the date shown as the policy start date on your policy \n\nschedule, from which cover begins. \n\nExpiry Date — the date shown as the policy end date on your \n\npolicy schedule, after which no benefit is payable. \n\nForm ALA-PB-LCI-07 Page 10 of 14\n\nASHCOMBE LIFE ASSURANCE PLC — POLICY BOOKLET HOW YOUR POLICY IS ADMINISTERED — PAGE 11 OF 14 \n\n8. HOW  YOUR POLICY IS ADMINISTERED \n\n8.1  Who provides this policy \n\n8.1.1  This policy is provided by Ashcombe Life Assurance plc, registered \n\nin England and Wales under company number 04471902, with its \n\nregistered office at 27 Cathedral Yard, Bristol, BS1 5TX. \n\n8.2  How we manage the assets backing this policy \n\n8.2.1  The assets we hold to meet our obligations under policies like \n\nyours are managed on our behalf by Meridian Asset Management Ltd, an \n\ninvestment manager appointed by our board. This does not create any \n\ninvestment element in your policy; this policy has no cash value, as set \n\nout in clause 2.2.2. \n\n8.3  Reinsurance \n\n8.3.1  We reinsure a proportion of the risk we accept under policies like \n\nyours with Continental Re (UK) Ltd, under standard reinsurance treaty \n\narrangements. Reinsurance does not affect your rights under this policy; \n\nour obligation to you is unaffected by whether, or how much, of the risk \n\nwe have reinsured. \n\n8.4  Our regulatory status \n\n8.4.1  Ashcombe Life Assurance plc is authorised by the Prudential \n\nRegulation Authority and regulated by the Financial Conduct Authority \n\nand the Prudential Regulation Authority. We were first authorised to \n\ncarry out insurance business on 15 September 2004. Our Firm Reference \n\nNumber is 447190. \n\n8.5  Changes to these terms \n\n8.5.1  We may change the terms in this booklet where the change is \n\nrequired by law or regulation, or to reflect a court or Ombudsman \n\ndecision, or to correct an error. We will write to you at least 30 days \n\nbefore a change that reduces your cover takes effect. These terms were \n\nlast updated on 4 February 2026. \n\n8.6  Law and language \n\n8.6.1  This policy is governed by the law of England and Wales, and all \n\ncommunications between us will be in English. \n\n8.7  How we use your information \n\n8.7.1  We use personal and medical information you give us to assess your \n\napplication, administer your policy, and handle any claim, and we may \n\nshare it with the reinsurer named in clause 8.3.1 and with your doctor for \n\nthat purpose. Our full privacy notice is available on request. \n\nForm ALA-PB-LCI-07 Page 11 of 14\n\nASHCOMBE LIFE ASSURANCE PLC — POLICY BOOKLET PREMIUMS AND REVIEWS — PAGE 12 OF 14 \n\n9. PREMIUMS AND REVIEWS \n\n9.1  How your premium is calculated \n\n9.1.1  Your premium is calculated when you apply, based on the sum \n\nassured you choose, the age, sex, health, occupation and smoker status of \n\nthe life assured, and any special terms we apply. It is shown on your \n\npolicy schedule. \n\n9.2  Premium reviews \n\n9.2.1  If your policy schedule shows that your premium is reviewable, we \n\nwill review it on each premium review date shown in the table below, \n\nand confirm any change to you in writing at least 30 days beforehand. \n\nReview Premium review date \n\n1 1 January 2027 \n\n2 1 January 2028 \n\n3 1 January 2029 \n\n4 1 January 2030 \n\n5 1 January 2031 \n\n6 1 January 2032 \n\n7 1 January 2033 \n\n8 1 January 2034 \n\n9.3  What happens if you miss a payment \n\n9.3.1  If a premium is not paid on its due date, we will write to remind \n\nyou. If it remains unpaid 30 days after the due date, cover ends \n\nautomatically, subject to our right to cancel described in clause 5.3. \n\n9.4  Illustrative cost of your policy \n\n9.4.1  If you pay monthly for the whole of your policy term without any \n\npremium review changing the amount, the total you would pay over the \n\nterm is approximately £7,800.00. This figure is illustrative only: your \n\nactual premium may change following a review under clause 9.2, and the \n\nactual total you pay will depend on how long the policy runs. \n\n9.4.2  If you choose to pay annually instead of monthly, the annual \n\npremium is shown on your policy schedule; paying annually is usually \n\ncheaper overall than paying the same monthly premium twelve times \n\nover. \n\n9.5  Amounts shown on your schedule \n\n9.5.1  Your policy schedule shows your sum assured, your critical illness \n\nbenefit, and your premium. These are the amounts that apply to you; \n\nnothing in this section overrides them. \n\n9.6  How you pay \n\n9.6.1  Premiums are collected by direct debit from the bank account \n\nshown on your application, on or near the day of the month shown on \n\nyour policy schedule. We do not accept payment by cash or by post. \n\nForm ALA-PB-LCI-07 Page 12 of 14\n\nASHCOMBE LIFE ASSURANCE PLC — POLICY BOOKLET YOUR POLICY SCHEDULE — PAGE 13 OF 14 \n\n10. YOUR POLICY SCHEDULE \n\nThis schedule forms part of your contract with Ashcombe Life Assurance plc. Please keep it with your policy booklet. \n\nPolicyholder Mrs Naomi R. Whitcombe \n\nLife assured Mrs Naomi R. Whitcombe \n\nAddress 14 Sedgemoor Rise, Trentham, Staffordshire, ST9 4LP \n\nPolicy number ALA-662048-13 \n\nType of policy Life cover policy, with critical illness cover (accelerated) \n\nPolicy start date 18 October 2026 \n\nPolicy end date 17 October 2046 \n\nPolicy term 20 years \n\nSum assured £150,000.00 \n\nCritical illness benefit £75,000.00 (accelerated, deducted from sum assured) \n\nTotal permanent disability cover Not selected \n\nPremium frequency Monthly (paid every 1 month) \n\nMonthly premium £32.50 \n\nAnnual premium (if selected instead) £351.00 \n\nTotal premiums payable over full term approximately £7,800.00 \n\nUnderwriting basis Full medical underwriting \n\nSmoker status Non-smoker \n\nWaiting period 90 days from the policy start date \n\nPremium reviewable Yes — see section 9 \n\nIndexation Not selected \n\nInsurer Ashcombe Life Assurance plc, 27 Cathedral Yard, Bristol, BS1 5TX \n\nPolicy ALA-662048-13 · Form ALA-PB-LCI-07 Page 13 of 14\n\nASHCOMBE LIFE ASSURANCE PLC — POLICY BOOKLET CONTACTS AND REGULATORY INFORMATION — PAGE 14 OF 14 \n\n11. CONTACTS AND REGULATORY INFORMATION \n\nCUSTOMER SERVICES \n\nAshcombe Life Assurance plc \n\n27 Cathedral Yard, Bristol, BS1 5TX \n\nTelephone: 0345 604 7712 (Monday to Friday, 8am to 6pm) \n\nEmail: customerservices@ashcombelife.example \n\nCLAIMS LINE \n\nTelephone: 0345 604 7799 \n\nEmail: claims@ashcombelife.example \n\nPlease have your policy number ready when you call. \n\nCOMPLAINTS \n\nComplaints Team, Ashcombe Life Assurance plc \n\n27 Cathedral Yard, Bristol, BS1 5TX \n\nEmail: complaints@ashcombelife.example \n\nFINANCIAL OMBUDSMAN SERVICE \n\nExchange Tower, London, E14 9SR \n\nTelephone: 0800 023 4567 \n\nwww.financial-ombudsman.org.uk \n\nFINANCIAL SERVICES COMPENSATION SCHEME \n\n10th Floor Beaufort House, 15 St Botolph Street, London, EC3A 7QU \n\nTelephone: 0800 678 1100 \n\nwww.fscs.org.uk \n\nDATA PROTECTION \n\nWe process your personal data in line with our privacy notice, available \n\non request from the address above or from our website. This booklet was \n\ncorrect at the time of printing on 1 September 2026. \n\nAshcombe Life Assurance plc is authorised by the Prudential Regulation Authority and regulated by the Financial Conduct Authority and the Prudential Regulation \n\nAuthority (Firm Reference Number 447190). Registered in England and Wales, company number 04471902. Registered office: 27 Cathedral Yard, Bristol, BS1 5TX. \n\n© 2026 Ashcombe Life Assurance plc. All rights reserved. \n\nPolicy ALA-662048-13 · Form ALA-PB-LCI-07 Page 14 of 14\n",
    expected: {
    dates: ["2026-10-18","2046-10-17"],
    provider: "Ashcombe Life Assurance plc",
    reference: "ALA-662048-13",
    dateRoles: [
      { date: "2026-10-18", role: "start" },
      { date: "2046-10-17", role: "expiry" },
    ],
    subtype: "Life cover policy",
    costMinor: 3250,
    currency: "GBP",
    },
  },
  {
    // Ground-truth notes:
    // - provider is 'Anglia Communications Networks Ltd', the licensed operator named once in the footer small print, not 'Fenwick Mobile', the consumer brand printed in the browser tab title, page header and throughout the page.
    // - dates and dateRoles carry only 20 March 2027, when the 24-month minimum term ends. The page prints many other dates that a careful reader would not track as the document's governing date: the plan start date (20 March 2025), the next bill date shown in the largest type on the page with a day countdown (20 October 2026), the same date repeated as the data allowance reset date, the handset upgrade window opening one month early (20 February 2027, deliberately close to but not the same as the term end), the last two bill dates (20 September 2026, 20 August 2026), a 'prices correct as of' stamp (1 September 2026), the year-month segment in the printed URL (2026-03), the copyright year, and the browser's own printed-on timestamp in the footer (11/09/2026, 14:32), which is the last date on the page and is a full print timestamp, not a plan date.
    // - costMinor is the standard monthly plan charge of £23.00, which applies from month 7 onward. It is not the discounted £14.00/month introductory rate for the first 6 months (shown larger, in the brand colour), not the out-of-bundle rates (45p/min calls, 11p/text, £6.00/GB data, £2.00/day roaming), not the £5.00/month international add-on, and not last month's total bill of £31.50 (which blends the plan charge with add-on and usage charges) or the previous bill of £23.50.
    // - reference is the account number 7734 2210 91, not the mobile number 07700 900123 printed alongside it, since the account number is what the customer would quote when contacting the operator.
    // - recurrenceMonths is 24, the printed minimum term ('Minimum term 24 months — ends 20 March 2027'): the cycle of the thing, not the monthly billing (corrected 2026-09-11; the value was 1, which measured payment frequency and contradicted the broadband contract's 24). scheduleKind is 'renewal' because the tracked date is when the minimum term completes and the contract rolls onto its next arrangement, not a service event.
    name: "mobile plan summary, printed web page with browser furniture",
    filename: "fullpage-mobile-airtime-plan.pdf",
    text: "Fenwick Mobile – Mobile Plan Summary | My Account  \n\nFenwick Mobile – Mobile Plan Summary | My Account myaccount.fenwickmobile.example/billing/2026-03/summary \n\nWe use cookies to personalise My Account and to measure how it’s used. Accept all Manage preferences \n\nHome > My Account > Billing > Mobile Plan Summary \n\nPrint this page · Download PDF \n\nMobile Plan Summary \n\nNEXT  BILL DATE \n\n20 October 2026 in 39 days · collected 1 time each calendar month by Direct Debit \n\nYour 30GB data allowance resets on 20 October 2026. \n\nYOUR PLAN \n\nSIM Only 30GB Flex \n\n£14.00/mo \n\nfor your first 6 months \n\n£23.00/mo \n\nstandard monthly charge, from month 7 onward \n\nPlan started 20 March 2025 \n\nMinimum term 24 months — ends 20 March 2027 \n\nData allowance 30GB / month \n\nCalls & texts Unlimited UK minutes and texts \n\nHANDSET  UPGRADE \n\nYour upgrade window opens on 20 February 2027, one month before your current agreement completes, so you can \n\norder your next handset before your minimum term ends. \n\nOUT-OF-BUNDLE  RATES \n\nCalls (out of bundle) 45p/min \n\nTexts (out of bundle) 11p each \n\nExtra data £6.00/GB \n\nEU roaming £2.00/day \n\nADD-ONS ON  THIS ACCOUNT \n\nInternational Calling Add-on — £5.00/month, added automatically to your monthly bill. \n\nBILLING HISTORY \n\nLast bill — 20 September 2026 £31.50 \n\nPrevious bill — 20 August 2026 £23.50 \n\nPrices on this page are correct as of 1 September 2026 and may change; we’ll always tell you before a price rise takes effect. \n\nAccount number 7734 2210 91 · Mobile number 07700 900123 \n\nFenwick Mobile is a trading name of Anglia Communications Networks Ltd, registered in England and Wales no. 07845213, and is a licensed mobile network operator \n\nregulated by Ofcom. Registered office: 4 Redshank House, Ipswich Business Park, Ipswich, IP3 9QT. © 2026 Anglia Communications Networks Ltd. \n\nPrinted 11/09/2026, 14:32 1/1\n",
    expected: {
    dates: ["2027-03-20"],
    provider: "Anglia Communications Networks Ltd",
    reference: "7734 2210 91",
    dateRoles: [
      { date: "2027-03-20", role: "renewal" },
    ],
    subtype: "Mobile plan summary",
    costMinor: 2300,
    currency: "GBP",
    recurrenceMonths: 24,
    scheduleKind: "renewal",
    },
  },
  {
    // Ground-truth notes:
    // - The only tracked date is 19 June 2026, the last day of the current fixed rate period, printed on page 1 ('Fixed rate period: 20 June 2024 to 19 June 2026') and again on page 3 in the rate-detail table and the early repayment charge schedule. It is the date the household must act on (choose a new deal or fall onto the reversion rate), which is why it is roled 'renewal' rather than 'expiry'.
    // - The 30-row transaction history on page 2 is the densest date block on the page: every one of its rows carries its own dd/mm/yyyy date (interest charges and payments on the 1st of each month, plus an overpayment, a statement fee, an insurance premium, an account fee, a returned-payment fee and a transfer fee scattered through the year). None of these 30 dates is an answer.
    // - Also excluded from `dates`: the statement period start and end (1 April 2025 / 31 March 2026), the statement date (6 April 2026), the date the mortgage term ends (20 June 2049, decades away), the date the rate last changed (20 June 2024, when the current fixed deal began) and the date early repayment charges stop applying (1 July 2026, deliberately printed 12 days after the true fixed-rate-end answer because charges run to the end of the calendar month) -- all texture a careful human would not report as the document's governing date.
    // - costMinor is the current monthly payment, £742.18, shown in the 'Your payments' panel on page 1. The payment the account moves to once the fixed rate ends, £891.47, is printed immediately beside it on page 1 and again on page 3, and is not the answer.
    // - Other money on the page that is not the answer: the outstanding balance (£164,611.07, in the accent-coloured balance panel), the interest charged over the statement year (£6,933.08), the early repayment charge if the mortgage were repaid today (£3,292.22, repeated on page 3) and the original amount borrowed (£198,500.00).
    // - provider is the legal entity from the page 3 regulatory block, Priorswood Bank plc, company number 05391847 -- not the trading name 'Kelbridge Home Loans' used in the masthead, footer and throughout the document.
    // - The product name 'Two Year Fixed 4.19%' is printed prominently on pages 1 and 3 but is not the subtype; subtype is the plain description printed as the document's title, 'Mortgage Annual Statement'.
    // - reference is the mortgage account number, 7738 2204 91, printed in the header of every page and in the account details table -- the only account-shaped number on the document.
    // - recurrenceMonths is 1 because the payment is monthly, printed in digits on page 1 ('collected 1 time each calendar month'). scheduleKind is 'renewal' to match the single dateRole.
    name: "mortgage annual statement, renewal date buried between a 30-row transaction table and a wall of regulatory text",
    filename: "fullpage-mortgage-annual-statement.pdf",
    text: "Kelbridge Home Loans — Mortgage Annual Statement  \n\nKelbridge Home Loans Residential mortgage lending \n\nSTATEMENT DATE 06/04/2026 \n\nACCOUNT 7738 2204 91 \n\nPAGE 1 OF 3 \n\nMORTGAGE ANNUAL STATEMENT For the statement period 1 April 2025 to 31 March 2026 — product held: Two Year Fixed 4.19% \n\nMortgage account number 7738 2204 91 \n\nBorrower(s) Mr D. Okafor and Mrs A. Okafor \n\nProperty charged 14 Sycamore Rise, Bramholt, Nottinghamshire, NG12 7QF \n\nOriginal amount borrowed £198,500.00 \n\nCurrent interest rate 4.19% fixed \n\nMortgage term ends 20 June 2049 (23 years remaining) \n\nOUTSTANDING BALANCE AT 31 MARCH  2026 £164,611.07 \n\nYOUR PAYMENTS \n\nCURRENT MONTHLY PAYMENT \n\n£742.18 Collected by direct debit on the 1st of each month \n\nPAYMENT FROM 20 JUNE 2026 \n\n£891.47 Once your fixed rate ends and you move to our Standard Variable Rate \n\nINTEREST CHARGED THIS STATEMENT YEAR \n\n£6,933.08 1 April 2025 to 31 March 2026 \n\nPayments are collected 1 time each calendar month by direct debit from your nominated bank account. The interest rate applied to your mortgage last \n\nchanged on 20 June 2024, when your current fixed rate began. \n\nYOUR CURRENT PRODUCT \n\nProduct name Two Year Fixed 4.19% \n\nFixed rate period 20 June 2024 to 19 June 2026 \n\nEarly repayment charge if repaid in full today £3,292.22 \n\nFull details of what happens when your fixed rate period ends, and the early repayment charges that may apply before then, are set out on page 3. A \n\nsummary of transactions on your mortgage account during the statement period is set out on page 2. \n\nKelbridge Home Loans · Account 7738 2204 91 Page 1 of 3\n\nKelbridge Home Loans Residential mortgage lending \n\nSTATEMENT DATE 06/04/2026 \n\nACCOUNT 7738 2204 91 \n\nPAGE 2 OF 3 \n\nTRANSACTION HISTORY — 1 APRIL 2025 TO 31 MARCH 2026 \n\nDATE DESCRIPTION AMOUNT (£) BALANCE (£) \n\n01/04/2025 Interest charged +581.44 167,103.59 \n\n01/04/2025 Monthly mortgage payment -742.18 166,361.41 \n\n01/05/2025 Interest charged +580.88 166,942.29 \n\n01/05/2025 Monthly mortgage payment -742.18 166,200.11 \n\n15/05/2025 Overpayment received -500.00 165,700.11 \n\n01/06/2025 Interest charged +578.57 166,278.68 \n\n01/06/2025 Monthly mortgage payment -742.18 165,536.50 \n\n01/07/2025 Interest charged +578.00 166,114.50 \n\n01/07/2025 Monthly mortgage payment -742.18 165,372.32 \n\n10/07/2025 Statement request fee +10.00 165,382.32 \n\n01/08/2025 Interest charged +577.46 165,959.78 \n\n01/08/2025 Monthly mortgage payment -742.18 165,217.60 \n\n01/09/2025 Interest charged +576.88 165,794.48 \n\n01/09/2025 Monthly mortgage payment -742.18 165,052.30 \n\n01/09/2025 Buildings insurance premium +412.00 165,464.30 \n\n01/10/2025 Interest charged +577.75 166,042.05 \n\n01/10/2025 Monthly mortgage payment -742.18 165,299.87 \n\n01/10/2025 Annual mortgage account fee +90.00 165,389.87 \n\n01/11/2025 Interest charged +577.49 165,967.36 \n\n01/11/2025 Monthly mortgage payment -742.18 165,225.18 \n\n01/12/2025 Interest charged +576.91 165,802.09 \n\n01/12/2025 Monthly mortgage payment -742.18 165,059.91 \n\n05/12/2025 Direct debit returned fee +25.00 165,084.91 \n\n01/01/2026 Interest charged +576.42 165,661.33 \n\n01/01/2026 Monthly mortgage payment -742.18 164,919.15 \n\n20/01/2026 CHAPS transfer fee +25.00 164,944.15 \n\n01/02/2026 Interest charged +575.93 165,520.08 \n\n01/02/2026 Monthly mortgage payment -742.18 164,777.90 \n\n01/03/2026 Interest charged +575.35 165,353.25 \n\n01/03/2026 Monthly mortgage payment -742.18 164,611.07 \n\nThis transaction history covers your mortgage account only and does not include payments made towards any linked buildings or life insurance policies \n\nunless collected through this account, as shown above. \n\nKelbridge Home Loans · Account 7738 2204 91 Page 2 of 3\n\nKelbridge Home Loans Residential mortgage lending \n\nSTATEMENT DATE 06/04/2026 \n\nACCOUNT 7738 2204 91 \n\nPAGE 3 OF 3 \n\nYOUR RATE  IN DETAIL \n\nProduct Two Year Fixed 4.19% \n\nFixed rate applies from 20 June 2024 to 19 June 2026 \n\nRate you revert to Kelbridge Home Loans Standard Variable Rate, currently 7.49% \n\nPayment from 20 June 2026 £891.47 per month \n\nAround 8 weeks before your fixed rate period ends we will write to you separately with the new deals available to you. If you do nothing, your mortgage \n\nwill move automatically onto our Standard Variable Rate from 20 June 2026 and your payment will change to the amount shown above. \n\nEARLY REPAYMENT CHARGES \n\nPeriod Charge if you repay during this period \n\n20 June 2024 to 19 June 2025 3% of the amount repaid \n\n20 June 2025 to 19 June 2026 2% of the amount repaid \n\nFrom 20 June 2026 onwards Nil \n\nBased on your balance at 31 March 2026, a full repayment made today would attract a charge of £3,292.22. Early repayment charges apply to the full \n\ncalendar month in which you repay, so no early repayment charge will apply to a repayment made on or after 1 July 2026. \n\nREGULATORY INFORMATION \n\nKelbridge Home Loans is a trading name of Priorswood Bank plc. \n\nPriorswood Bank plc is registered in England and Wales under company \n\nnumber 05391847. Registered office: 2 Foundry Court, Trentham \n\nBusiness Park, Trentham, ST4 8QW. \n\nPriorswood Bank plc is authorised by the Prudential Regulation \n\nAuthority and regulated by the Financial Conduct Authority and the \n\nPrudential Regulation Authority. Financial Services Register number \n\n204879. You can check this on the Financial Services Register at \n\nfca.org.uk/register or by calling 0800 111 6768. \n\nIf you are unhappy with any aspect of the service you have received, \n\nplease write to our Customer Relations team at the registered office \n\naddress above. If we cannot resolve your complaint, you may be entitled \n\nto refer it to the Financial Ombudsman Service, free of charge, within six \n\nmonths of our final response. \n\nEligible deposits with Priorswood Bank plc are protected by the Financial \n\nServices Compensation Scheme (FSCS). This mortgage account itself is \n\nnot a deposit and is not covered by the FSCS depositor protection \n\nscheme. \n\nYour home may be repossessed if you do not keep up repayments on \n\nyour mortgage. If you are having difficulty making your payments, please \n\ncontact us as soon as possible; we may be able to help. \n\nPriorswood Bank plc processes personal data in accordance with its \n\nprivacy notice, available at kelbridgehomeloans.example/privacy or by \n\npost on request to the registered office address above. This statement \n\nis issued for information only and does not constitute a redemption \n\nstatement; if you require a figure to repay your mortgage in full, please \n\nrequest a redemption statement separately. \n\nPriorswood Bank plc · Company no. 05391847 Page 3 of 3\n",
    expected: {
    dates: ["2026-06-19"],
    provider: "Priorswood Bank plc",
    reference: "7738 2204 91",
    dateRoles: [
      { date: "2026-06-19", role: "renewal" },
    ],
    subtype: "Mortgage annual statement",
    costMinor: 74218,
    currency: "GBP",
    recurrenceMonths: 1,
    scheduleKind: "renewal",
    },
  },
  {
    // Ground-truth notes:
    // - No cost is stated anywhere on the page. That is what this document tests: costMinor and currency are deliberately absent, and an extractor inventing an amount is wrong.
    // - Provider is the test station, not the issuing authority. The letterhead reads 'Driver & Vehicle Testing Authority', but the reminder-letter convention already in the corpus names the garage. The ampersand letterhead is left in place on purpose as a live example of #982.
    // - Test date and certificate issue date are the same day, so the day appears once with role 'issued', matching the MOT certificate already in the corpus.
    // - No scheduleKind: 'issued' and 'expiry' derive neither renewal nor service. Consistent with the existing MOT certificate entry.
    // - Distractors left in deliberately: date of first use, date first registered, and the prior odometer-history test date.
    name: "MOT certificate, full page with no cost stated",
    filename: "fullpage-mot-certificate.pdf",
    text: "MOT Test Certificate VT20  \n\nDriver & Vehicle  Testing Authority — MOT test certificate Test number 1847 2205 9631 — Page 1 of 2 \n\nDVTA \n\nDriver & Vehicle Testing Authority Statutory roadworthiness testing scheme · Testing correspondence unit, Marchwood House, 2 Fennimore Gate, Ravenscourt RV3 8PW Enquiries 0300 141 7722 · dvta.example/checkmot · Authority reference AUT/4471/EW \n\nVT20 \n\nTest class \n\n4 \n\nIssue \n\n09/09/2026 14:32 \n\nSerial \n\nCRT-2026-8841772 \n\nMOT Test Certificate Issued under the Road Vehicles (Statutory Testing) Regulations, regulation 18(3) \n\nRESULT: PASS Test number 1847 2205 9631  ·  Registration mark KV24 HRG \n\nThis certificate records the condition of the vehicle at the time of the test only. It is not evidence of the vehicle’s condition at any other time. \n\nE X PI RY  D ATE \n\n08 September 2027 Test date 09 September 2026 \n\nVEHICLE DETAILS \n\n1. REGISTRATION MARK \n\nKV24 HRG \n\n2. MAKE \n\nMARNOCH 3. MODEL \n\nVerado 1.6 TDCi Estate 4. COLOUR \n\nSlate Grey \n\n5. FUEL TYPE \n\nDiesel 6. VEHICLE CLASS \n\n4 (cars up to 8 passenger seats) \n\n7. VIN \n\nSJNTAAA92MB4471803 \n\n8. ENGINE NUMBER \n\nK9K8-2207714 9. DATE OF FIRST USE \n\n26 March 2024 10. DATE FIRST REGISTERED \n\n02 April 2024 \n\n11. ODOMETER READING \n\n68,412 miles 12. COUNTRY OF REGISTRATION \n\nUnited Kingdom \n\nTEST STATION AND TESTER \n\n1. TEST STATION \n\nCalderwell Motor Services Ltd 2. VTS NUMBER \n\nV-441829 3. ADDRESS \n\nUnit 7, Brandmoor Industrial Estate, Calderwell, Northshire CW9 4LT 4. STATION TELEPHONE \n\n01827 449 118 \n\n5. AUTHORISED EXAMINER \n\nAE-20-441829-C \n\n6. TESTER NAME \n\nA. J. Brindlecombe 7. TESTER NUMBER \n\n118 4472 8. TEST DATE \n\n09 September 2026 \n\n9. TEST START TIME \n\n13:58 10. CERTIFICATE ISSUED \n\n09 September 2026 11. EXPIRY DATE \n\n08 September 2027 \n\nODOMETER HISTORY RECORDED AT THIS STATION \n\nDATE RECORDED TEST NUMBER READING UNIT RESULT \n\n09 September 2026 1847 2205 9631 68,412 miles Pass with advisories \n\n11 September 2025 1702 4498 3157 54,907 miles Pass \n\n14 September 2024 1566 8830 2249 39,118 miles Pass \n\n26 March 2024 — 11 miles First use, no test required \n\nThe odometer readings above are recorded as displayed by the vehicle at the time of each test. The Authority does not verify their accuracy. An unexplained reduction between readings should be reported using form VT11 within 28 days. \n\nDriver & Vehicle Testing Authority · VT20 · Test 1847 2205 9631 · KV24 HRG Page 1 of 2\n\nDriver & Vehicle Testing Authority MOT test certificate — continuation sheet \n\nTest 1847 2205 9631 Registration KV24 HRG \n\nSerial CRT-2026-8841772 \n\nADVISORY NOTICES — ITEMS TO MONITOR \n\n# LOCATION ADVISORY TEXT RECORDED BY THE TESTER F IRST RECORDED \n\n1 Nearside front tyre Tyre worn close to the legal limit across the inner shoulder (1.8 mm remaining against a limit of 1.6 mm). Monitor and replace before further significant mileage. \n\n09 September 2026 \n\n2 Offside rear brake pipe Brake pipe corroded, covered in a light surface rust but not seriously weakened. Repeat of the advisory first raised at the previous test. \n\n11 September 2025 \n\n3 Front suspension, nearside Anti-roll bar linkage ball joint has slight play, not sufficient to be a defect. Recheck at next service. \n\n09 September 2026 \n\n4 Exhaust system Rear silencer showing signs of blowing under load; no leak detected at idle. 09 September 2026 \n\n5 Underbody, offside sill Corrosion present within 30 cm of a body-mounted suspension component but not excessive. Previously noted 14 September 2024. \n\n14 September 2024 \n\n6 Windscreen Chip approximately 4 mm in diameter outside zone A of the swept area. Monitor for spreading. \n\n09 September 2026 \n\nAn advisory is not a defect and does not affect the validity of this certificate. Items listed here may become defects before the expiry date shown above. \n\nCERTIFICATION I certify that the vehicle identified above was examined on 09 September 2026 in accordance with the statutory inspection manual in force on that date, and that it met the prescribed requirements. \n\nSignature of tester — A. J. Brindlecombe, tester number 118 4472 For and on behalf of Calderwell Motor Services Ltd, VTS V-441829 \n\nStation stamp area. A certificate without a station stamp is still valid if the record appears on the Authority’s database. \n\nCHECKING THIS CERTIFICATE The authoritative record is held on the Authority’s database. To check it you will need the registration mark KV24 HRG and either the test number 1847 2205 9631 or the document reference number from the vehicle log book. \n\nOnline  dvta.example/checkmot Telephone  0300 141 7722, Monday to Friday 08:00–18:00 Record retained until  08 September 2033 \n\nIMPORTANT INFORMATION — APPEALS, RETESTS AND REPLACEMENTS Appeals against the result. If you believe the test was carried out incorrectly you may appeal. Complete form VT17 and send it to the Authority’s testing correspondence unit so that it arrives within 14 days of the test, that is by 23 September 2026. An appeal received after that date will not normally be considered. The Authority may require the vehicle to be presented for re-examination in the condition it was in at the time of the test, and a fee may be payable which is refunded if the appeal succeeds. \n\nComplaints about the test station. Raise these first with Calderwell Motor Services Ltd. If the matter is not resolved within 14 days, write to the Authority quoting the test number and the VTS number. Complaints about a test should reach the Authority within three months of the test date. \n\nRetests. Where a vehicle fails, a partial retest is available at the same station if the vehicle is left there for repair, or if it is returned before the end of the next working day. A full retest applies in all other cases. The concession does not apply to this certificate, which records a pass. \n\nDuplicate certificates. A replacement may be obtained from any authorised test station on production of the registration mark and the test number shown above. A charge set \n\nby the station applies. The replacement carries the same expiry date of 08 September 2027 as this document. \n\nValidity. This certificate is not proof of roadworthiness other than at the moment of the test, is not evidence of the vehicle’s general condition, and does not relieve the driver of the duty to keep the vehicle roadworthy at all times. Using a vehicle without a valid certificate where one is required is an offence. \n\nRenewal. The vehicle may be presented for its next test up to one calendar month, less a day, before 08 September 2027 and keep the same expiry anniversary. The earliest date on which the test may be taken and the anniversary preserved is 09 August 2027. A test taken before that date will shorten the cycle. \n\nInsurance. A certificate is not a condition of insurance in itself, but most motor policies require the vehicle to be roadworthy. Check the terms of your policy. \n\nData. Test records are held by the Authority under the lawful basis of public task and are retained for seven years from the test date. Data protection registration ZB4471902. \n\nDriver & Vehicle Testing Authority · VT20 · Test 1847 2205 9631 · KV24 HRG Page 2 of 2\n",
    expected: {
    dates: ["2026-09-09","2027-09-08"],
    provider: "Calderwell Motor Services Ltd",
    reference: "1847 2205 9631",
    dateRoles: [
      { date: "2026-09-09", role: "issued" },
      { date: "2027-09-08", role: "expiry" },
    ],
    subtype: "MOT test certificate",
    },
  },
  {
    // Ground-truth notes:
    // - The only tracked date is 5 April 2026, printed as the statement date in the header of every page and as the date the fund value was taken at on page 1. It is roled 'issued' rather than 'due' or 'other' because it is the point-in-time the whole statement reports from, not an action deadline.
    // - The most prominent date on the page, the selected retirement date of 12 March 2053, is decades away and is what the whole statement's projections are built around, but it is not something that falls due or was issued -- it is excluded from dates, along with the earliest-retirement date it implies (12 March 2040), the member's date of birth (12 March 1985) and the date they joined the scheme (1 June 2012), all printed on page 1.
    // - Also excluded: the scheme year boundaries (6 April 2025 / 5 April 2026, the latter coinciding with the answer), the previous statement's valuation date (5 April 2025), the twelve monthly contribution dates on page 2, the SMPI/AS TM1 regulatory dates on page 4 (6 April 2003, 1 October 2018), the Regulations year 2013, the next-statement date (after 5 April 2027) and the copyright year 2026 in the footer.
    // - The contributions table on page 2 has twelve rows, each with its own date and four money columns (the member's contribution net of relief, the employer's contribution, tax relief added, and a running total) purely as a historic payment record; none of the 48 money values in that table is the answer for costMinor, and none of its twelve dates is the answer date.
    // - costMinor is the member's own regular monthly contribution rate stated on page 1, £215.42 (5% of pensionable pay before relief at source), not the employer's £129.25, and not the combined monthly total of £344.67 printed immediately beside it in a larger, bolder box. It is also not the smaller net figure of £172.34 that appears in most rows of the page 2 contributions table (the member's contribution after relief at source is deducted, before HM Revenue & Customs tax relief is added back), nor the higher July (£175.90) or December (£191.60) rows that include overtime and bonus pension.
    // - Other money on the page that is not the answer: the current fund value (£58,412.67), the previous year's fund value (£51,204.19), the cash transfer value (£58,412.67), the immediate cash-today income illustration (£2,430 a year), and the three projected fund values and four projected annual incomes on page 3, each shown in both today's money and future money at 2%, 5% and 8% assumed growth.
    // - provider is the scheme provider/administrator, Marlestone Workplace Pensions Ltd, not the employer Corvedale Logistics Ltd (who sponsors the scheme and pays the employer contribution) and not Ashcombe Asset Management Ltd (who manages the default investment fund the contributions sit in).
    // - reference is the plan number WPP-0077410-6 quoted in the header of every page, the number a member would give when contacting the provider about this plan.
    // - recurrenceMonths is 12 because contributions and the statement both run on a 12-month scheme year, printed in digits ('the 12 months of the scheme year'). scheduleKind is omitted: an annual benefit statement is neither a renewal nor a service event, and no dateRoles entry is 'renewal' or 'service' for scheduleKind to derive from.
    // -  
    // - s
    // - u
    // - b
    // - t
    // - y
    // - p
    // - e
    // -  
    // - i
    // - s
    // -  
    // - '
    // - A
    // - n
    // - n
    // - u
    // - a
    // - l
    // -  
    // - b
    // - e
    // - n
    // - e
    // - f
    // - i
    // - t
    // -  
    // - s
    // - t
    // - a
    // - t
    // - e
    // - m
    // - e
    // - n
    // - t
    // - '
    // - ,
    // -  
    // - w
    // - h
    // - i
    // - c
    // - h
    // -  
    // - i
    // - s
    // -  
    // - w
    // - h
    // - a
    // - t
    // -  
    // - t
    // - h
    // - e
    // -  
    // - d
    // - o
    // - c
    // - u
    // - m
    // - e
    // - n
    // - t
    // -  
    // - c
    // - a
    // - l
    // - l
    // - s
    // -  
    // - i
    // - t
    // - s
    // - e
    // - l
    // - f
    // - ,
    // -  
    // - n
    // - o
    // - t
    // -  
    // - '
    // - P
    // - e
    // - n
    // - s
    // - i
    // - o
    // - n
    // -  
    // - a
    // - n
    // - n
    // - u
    // - a
    // - l
    // -  
    // - b
    // - e
    // - n
    // - e
    // - f
    // - i
    // - t
    // -  
    // - s
    // - t
    // - a
    // - t
    // - e
    // - m
    // - e
    // - n
    // - t
    // - '
    // - .
    // -  
    // - R
    // - e
    // - a
    // - l
    // -  
    // - w
    // - o
    // - r
    // - k
    // - p
    // - l
    // - a
    // - c
    // - e
    // -  
    // - p
    // - e
    // - n
    // - s
    // - i
    // - o
    // - n
    // -  
    // - s
    // - t
    // - a
    // - t
    // - e
    // - m
    // - e
    // - n
    // - t
    // - s
    // -  
    // - a
    // - r
    // - e
    // -  
    // - t
    // - i
    // - t
    // - l
    // - e
    // - d
    // -  
    // - e
    // - x
    // - a
    // - c
    // - t
    // - l
    // - y
    // -  
    // - t
    // - h
    // - i
    // - s
    // -  
    // - w
    // - a
    // - y
    // -  
    // - -
    // - -
    // -  
    // - t
    // - h
    // - e
    // -  
    // - w
    // - o
    // - r
    // - d
    // -  
    // - '
    // - p
    // - e
    // - n
    // - s
    // - i
    // - o
    // - n
    // - '
    // -  
    // - l
    // - i
    // - v
    // - e
    // - s
    // -  
    // - i
    // - n
    // -  
    // - t
    // - h
    // - e
    // -  
    // - s
    // - c
    // - h
    // - e
    // - m
    // - e
    // - '
    // - s
    // -  
    // - n
    // - a
    // - m
    // - e
    // - ,
    // -  
    // - n
    // - o
    // - t
    // -  
    // - t
    // - h
    // - e
    // -  
    // - d
    // - o
    // - c
    // - u
    // - m
    // - e
    // - n
    // - t
    // - '
    // - s
    // -  
    // - t
    // - i
    // - t
    // - l
    // - e
    // -  
    // - -
    // - -
    // -  
    // - a
    // - n
    // - d
    // -  
    // - t
    // - h
    // - e
    // -  
    // - c
    // - o
    // - r
    // - p
    // - u
    // - s
    // -  
    // - r
    // - u
    // - l
    // - e
    // -  
    // - i
    // - s
    // -  
    // - t
    // - h
    // - a
    // - t
    // -  
    // - a
    // -  
    // - s
    // - u
    // - b
    // - t
    // - y
    // - p
    // - e
    // -  
    // - i
    // - s
    // -  
    // - t
    // - h
    // - e
    // -  
    // - t
    // - i
    // - t
    // - l
    // - e
    // -  
    // - t
    // - h
    // - e
    // -  
    // - p
    // - a
    // - p
    // - e
    // - r
    // -  
    // - a
    // - c
    // - t
    // - u
    // - a
    // - l
    // - l
    // - y
    // -  
    // - c
    // - a
    // - r
    // - r
    // - i
    // - e
    // - s
    // - ,
    // -  
    // - a
    // - s
    // -  
    // - w
    // - i
    // - t
    // - h
    // -  
    // - '
    // - P
    // - o
    // - l
    // - i
    // - c
    // - y
    // -  
    // - s
    // - c
    // - h
    // - e
    // - d
    // - u
    // - l
    // - e
    // - '
    // -  
    // - a
    // - n
    // - d
    // -  
    // - '
    // - M
    // - O
    // - T
    // -  
    // - t
    // - e
    // - s
    // - t
    // -  
    // - c
    // - e
    // - r
    // - t
    // - i
    // - f
    // - i
    // - c
    // - a
    // - t
    // - e
    // - '
    // - .
    // -  
    // - R
    // - e
    // - w
    // - r
    // - i
    // - t
    // - i
    // - n
    // - g
    // -  
    // - t
    // - h
    // - e
    // -  
    // - p
    // - a
    // - g
    // - e
    // -  
    // - t
    // - o
    // -  
    // - m
    // - a
    // - t
    // - c
    // - h
    // -  
    // - a
    // -  
    // - t
    // - i
    // - d
    // - i
    // - e
    // - r
    // -  
    // - e
    // - x
    // - p
    // - e
    // - c
    // - t
    // - e
    // - d
    // -  
    // - v
    // - a
    // - l
    // - u
    // - e
    // -  
    // - w
    // - o
    // - u
    // - l
    // - d
    // -  
    // - h
    // - a
    // - v
    // - e
    // -  
    // - m
    // - a
    // - d
    // - e
    // -  
    // - t
    // - h
    // - e
    // -  
    // - f
    // - i
    // - x
    // - t
    // - u
    // - r
    // - e
    // -  
    // - l
    // - e
    // - s
    // - s
    // -  
    // - l
    // - i
    // - k
    // - e
    // -  
    // - t
    // - h
    // - e
    // -  
    // - p
    // - a
    // - p
    // - e
    // - r
    // -  
    // - i
    // - t
    // -  
    // - s
    // - t
    // - a
    // - n
    // - d
    // - s
    // -  
    // - i
    // - n
    // -  
    // - f
    // - o
    // - r
    // - .
    // -  
    // - r
    // - e
    // - c
    // - u
    // - r
    // - r
    // - e
    // - n
    // - c
    // - e
    // - M
    // - o
    // - n
    // - t
    // - h
    // - s
    // -  
    // - i
    // - s
    // -  
    // - o
    // - m
    // - i
    // - t
    // - t
    // - e
    // - d
    // -  
    // - a
    // - s
    // -  
    // - w
    // - e
    // - l
    // - l
    // -  
    // - a
    // - s
    // -  
    // - s
    // - c
    // - h
    // - e
    // - d
    // - u
    // - l
    // - e
    // - K
    // - i
    // - n
    // - d
    // - .
    // -  
    // - T
    // - h
    // - e
    // -  
    // - c
    // - o
    // - r
    // - p
    // - u
    // - s
    // -  
    // - c
    // - o
    // - n
    // - t
    // - r
    // - a
    // - c
    // - t
    // -  
    // - i
    // - s
    // -  
    // - t
    // - h
    // - a
    // - t
    // -  
    // - a
    // -  
    // - r
    // - e
    // - c
    // - u
    // - r
    // - r
    // - e
    // - n
    // - c
    // - e
    // -  
    // - n
    // - e
    // - e
    // - d
    // - s
    // -  
    // - a
    // -  
    // - s
    // - c
    // - h
    // - e
    // - d
    // - u
    // - l
    // - e
    // -  
    // - t
    // - o
    // -  
    // - r
    // - e
    // - p
    // - e
    // - a
    // - t
    // -  
    // - -
    // - -
    // -  
    // - f
    // - o
    // - u
    // - r
    // - -
    // - f
    // - i
    // - e
    // - l
    // - d
    // - -
    // - c
    // - o
    // - n
    // - t
    // - r
    // - a
    // - c
    // - t
    // - .
    // - t
    // - e
    // - s
    // - t
    // - .
    // - t
    // - s
    // -  
    // - a
    // - s
    // - s
    // - e
    // - r
    // - t
    // - s
    // -  
    // - e
    // - x
    // - a
    // - c
    // - t
    // - l
    // - y
    // -  
    // - t
    // - h
    // - a
    // - t
    // -  
    // - -
    // - -
    // -  
    // - a
    // - n
    // - d
    // -  
    // - t
    // - h
    // - e
    // -  
    // - m
    // - o
    // - d
    // - e
    // - l
    // -  
    // - p
    // - a
    // - t
    // - h
    // -  
    // - d
    // - r
    // - o
    // - p
    // - s
    // -  
    // - a
    // -  
    // - r
    // - e
    // - c
    // - u
    // - r
    // - r
    // - e
    // - n
    // - c
    // - e
    // -  
    // - w
    // - i
    // - t
    // - h
    // -  
    // - n
    // - o
    // -  
    // - s
    // - c
    // - h
    // - e
    // - d
    // - u
    // - l
    // - e
    // -  
    // - k
    // - i
    // - n
    // - d
    // -  
    // - f
    // - o
    // - r
    // -  
    // - i
    // - t
    // -  
    // - t
    // - o
    // -  
    // - a
    // - t
    // - t
    // - a
    // - c
    // - h
    // -  
    // - t
    // - o
    // - .
    // -  
    // - T
    // - h
    // - i
    // - s
    // -  
    // - d
    // - o
    // - c
    // - u
    // - m
    // - e
    // - n
    // - t
    // -  
    // - i
    // - s
    // -  
    // - i
    // - s
    // - s
    // - u
    // - e
    // - d
    // -  
    // - o
    // - n
    // - c
    // - e
    // -  
    // - a
    // -  
    // - y
    // - e
    // - a
    // - r
    // -  
    // - b
    // - u
    // - t
    // -  
    // - O
    // - r
    // - b
    // - i
    // - t
    // -  
    // - t
    // - r
    // - a
    // - c
    // - k
    // - s
    // -  
    // - n
    // - o
    // -  
    // - s
    // - c
    // - h
    // - e
    // - d
    // - u
    // - l
    // - e
    // -  
    // - f
    // - r
    // - o
    // - m
    // -  
    // - i
    // - t
    // - ,
    // -  
    // - s
    // - o
    // -  
    // - t
    // - h
    // - e
    // - r
    // - e
    // -  
    // - i
    // - s
    // -  
    // - n
    // - o
    // - t
    // - h
    // - i
    // - n
    // - g
    // -  
    // - f
    // - o
    // - r
    // -  
    // - a
    // -  
    // - t
    // - w
    // - e
    // - l
    // - v
    // - e
    // - -
    // - m
    // - o
    // - n
    // - t
    // - h
    // -  
    // - c
    // - y
    // - c
    // - l
    // - e
    // -  
    // - t
    // - o
    // -  
    // - b
    // - e
    // - l
    // - o
    // - n
    // - g
    // -  
    // - t
    // - o
    // - .
    name: "pension annual benefit statement, projections at three growth rates against a decades-away retirement date",
    filename: "fullpage-pension-benefit-statement.pdf",
    text: "Marlestone Workplace Pensions Ltd — Annual Benefit Statement  \n\nMarlestone Workplace Pensions Ltd Trustee-administered  defined  contribution pension scheme \n\nSTATEMENT DATE 5 April 2026 \n\nPLAN NUMBER WPP-0077410-6 \n\nPAGE 1 OF 4 \n\nAnnual Benefit Statement \n\nFor the scheme year 6 April 2025 to 5 April 2026 — The Corvedale Logistics Ltd Pension Scheme \n\nMember Mr D. Fairweather \n\nDate of birth 12 March 1985 \n\nNational Insurance number NX 44 71 08 B \n\nDate joined the scheme 1 June 2012 \n\nEmployer Corvedale Logistics Ltd \n\nDefault investment fund Ashcombe Balanced Growth Fund, managed by Ashcombe Asset Management Ltd \n\nYOUR SELECTED  RETIREMENT  DATE \n\n12 March 2053 You will be aged 68. You may be able to take your pension from as early as 12 March 2040 (age 55) — see page 3. \n\nYour pension fund value as at 5 April 2026 £58,412.67 \n\nAt 5 April 2025 your fund was valued at £51,204.19. Your cash transfer value on 5 April 2026, the amount that would be paid to another registered \n\npension scheme if  you moved your pension, is £58,412.67. If  you took your whole pension as cash today, before any tax due, you could get an income \n\nof  around £2,430 a year1 — see page 3 for what your pension could be worth at your selected retirement date. \n\nYour contributions \n\nYOUR MONTHLY CONTRIBUTION \n\n£215.42 \n\nEMPLOYER'S MONTHLY \n\nCONTRIBUTION \n\n£129.25 \n\nCOMBINED MONTHLY TOTAL \n\n£344.67 \n\nYour contribution is 5% of pensionable pay and Corvedale Logistics Ltd's is 3%, both before the tax relief HM Revenue & Customs adds to your \n\npot. A month-by-month record of contributions received during the scheme year is set out on page 2, and what your fund could grow to by your \n\nselected retirement date is set out on page 3. \n\nMarlestone Workplace Pensions Ltd · Plan WPP-0077410-6 Page 1 of 4\n\nMarlestone Workplace Pensions Ltd Trustee-administered  defined  contribution pension scheme \n\nSTATEMENT DATE 5 April 2026 \n\nPLAN NUMBER WPP-0077410-6 \n\nPAGE 2 OF 4 \n\nContributions received \n\nContributions received during the 12 months of  the scheme year, 6 April 2025 to 5 April 2026. Your contribution is shown net of  relief  at source; tax \n\nrelief  is added by us after we claim it from HM Revenue & Customs. \n\nDate received Your contribution (£) Employer contribution (£) Tax relief added (£) Running total (£) \n\n06/04/2025 172.34 129.25 43.08 344.67 \n\n06/05/2025 172.34 129.25 43.08 689.34 \n\n06/06/2025 172.34 129.25 43.08 1,034.01 \n\n06/07/2025 175.90 131.93 43.98 1,385.82 \n\n06/08/2025 172.34 129.25 43.08 1,730.49 \n\n06/09/2025 172.34 129.25 43.08 2,075.16 \n\n06/10/2025 172.34 129.25 43.08 2,419.83 \n\n06/11/2025 172.34 129.25 43.08 2,764.50 \n\n06/12/2025 191.60 143.70 47.90 3,147.70 \n\n06/01/2026 172.34 129.25 43.08 3,492.37 \n\n06/02/2026 172.34 129.25 43.08 3,837.04 \n\n06/03/2026 172.34 129.25 43.08 4,181.71 \n\nTotal for the scheme year 2,111.44 1,584.13 528.16 4,223.73 \n\nThe July and December contributions are higher because they include pension on overtime and a Christmas bonus paid through Corvedale Logistics \n\nLtd's payroll that month. This record covers contributions received into this plan only and does not include any pension you built up with a previous \n\nemployer. \n\nMarlestone Workplace Pensions Ltd · Plan WPP-0077410-6 Page 2 of 4\n\nMarlestone Workplace Pensions Ltd Trustee-administered  defined  contribution pension scheme \n\nSTATEMENT DATE 5 April 2026 \n\nPLAN NUMBER WPP-0077410-6 \n\nPAGE 3 OF 4 \n\nWhat your pension could be worth \n\nThese figures are illustrations, not promises. They assume you keep contributing to your selected retirement date of  12 March 2053 and that you buy \n\na level, single-life annuity2 with your fund at that date. \"Today's money\" adjusts the future amount for the effect of  inflation3 so you can compare it \n\nwith prices now; \"future money\" is the amount you might actually see on your statement in 2053. \n\nAssumed growth4 Fund at retirement (future money) \n\nFund at retirement (today's money) \n\nAnnual income5 \n\n(future money) Annual income5 \n\n(today's money) \n\nLower assumed growth — 2% a year £64,900 £38,700 £3,120 £1,860 \n\nMid assumed growth — 5% a year £112,400 £67,000 £5,400 £3,220 \n\nHigher assumed growth — 8% a year £196,800 £117,300 £9,450 £5,630 \n\nThese illustrations use the Statutory Money Purchase Illustration basis6 and assume you continue paying £344.67 a month between you and \n\nCorvedale Logistics Ltd, increasing each year in line with assumed earnings growth. Charges are deducted before the figures above are calculated — \n\nsee page 4. \n\nTaking your pension early or late \n\nThe earliest age you can normally draw a workplace pension is 55, which for you falls on 12 March 2040. Drawing your pension earlier than your \n\nselected retirement date will usually reduce the amounts shown above, because your fund has less time to grow and your pension is expected to be \n\npaid for longer. You do not have to draw your pension on 12 March 2053; you can choose to keep contributing beyond that date, or draw it sooner \n\nfrom age 55. \n\nWhere your money is invested \n\nUnless you have chosen otherwise, your contributions are invested in the Ashcombe Balanced Growth Fund, the scheme's default arrangement, \n\nmanaged on the trustees' behalf  by Ashcombe Asset Management Ltd. You can switch funds at any time free of  charge by writing to us or using the \n\nonline portal at the address on page 4. \n\nMarlestone Workplace Pensions Ltd · Plan WPP-0077410-6 Page 3 of 4\n\nMarlestone Workplace Pensions Ltd Trustee-administered  defined  contribution pension scheme \n\nSTATEMENT DATE 5 April 2026 \n\nPLAN NUMBER WPP-0077410-6 \n\nPAGE 4 OF 4 \n\nAssumptions used in this statement \n\n1. 1 The income if you took your pension today assumes you used your whole fund to buy a level, single-life annuity from an insurer at current \n\nmarket annuity rates, with no guarantee period and no dependant's pension. Actual annuity rates change daily and vary between providers. \n\n2. 2 The annuity used for the projections on page 3 is a level, single-life annuity with no guarantee period, purchased on the date you reach your \n\nselected retirement date. Buying a different type of annuity, or taking your money in another way such as drawdown or as a lump sum, would \n\nproduce different figures. \n\n3. 3 Today's money figures assume price inflation of 2.5% a year between 5 April 2026 and your selected retirement date, in line with guidance \n\npublished by the Financial Reporting Council. \n\n4. 4 The three growth rates are set out in Actuarial Standard Technical Memorandum 1 (AS TM1), version 4.2, which came into effect on 1 October \n\n2018 and prescribes the rates that occupational schemes must use for statutory illustrations. They are not a forecast, minimum or guarantee \n\nof what your investments will actually return. \n\n5. 5 Annual income figures are shown before income tax and assume the annuity is paid monthly in advance and does not increase once in \n\npayment. \n\n6. 6 This statement has been prepared on the Statutory Money Purchase Illustration (SMPI) basis required by the Occupational and Personal \n\nPension Schemes (Disclosure of Information) Regulations 2013, a requirement introduced for money purchase pensions on 6 April 2003. \n\nCharges \n\nAn annual management charge of  0.42% of  the value of  your fund is deducted by Ashcombe Asset Management Ltd, calculated daily and already \n\nreflected in the fund value and the projections shown in this statement. There is no charge for joining, leaving or transferring out of  the scheme. \n\nRisk warnings \n\nThe value of  your pension can go down as well as up, and you may get \n\nback less than has been paid in. Past performance is not a guide to \n\nfuture performance. \n\nThe illustrations in this statement are not guaranteed. They are based on \n\nassumptions about investment growth, inflation and annuity rates that \n\nmay not happen. Your actual pension could be higher or lower. \n\nTax relief  and the tax treatment of  pensions depend on your individual \n\ncircumstances and may change in the future. Legislation governing \n\nworkplace pensions may also change before your selected retirement \n\ndate. \n\nIf  you leave Corvedale Logistics Ltd, your benefits in this scheme \n\nremain invested and continue to be subject to charges and investment \n\nrisk, whether or not you keep contributing. \n\nImportant information \n\nMarlestone Workplace Pensions Ltd is registered in England and \n\nWales, company number 07741029, registered office 8 Cathedral Yard, \n\nExeter, Devon, EX1 1HB. Marlestone Workplace Pensions Ltd is \n\nauthorised and regulated by the Financial Conduct Authority, register \n\nnumber 558112. \n\nIf you are unhappy with any aspect of the service you have received, \n\nplease write to our Customer Relations team at the address above, or \n\ntelephone 0345 608 2210. If we cannot resolve your complaint, you \n\nmay be entitled to refer it to the Financial Ombudsman Service free \n\nof charge. \n\nThis statement was produced on 5 April 2026 and is based on \n\ninformation held by us on that date. Your next annual statement will \n\nbe issued after 5 April 2027. \n\n© 2026 Marlestone Workplace Pensions Ltd. All rights reserved. \n\nMarlestone Workplace Pensions Ltd · Plan WPP-0077410-6 Page 4 of 4\n",
    expected: {
    dates: ["2026-04-05"],
    provider: "Marlestone Workplace Pensions Ltd",
    reference: "WPP-0077410-6",
    dateRoles: [
      { date: "2026-04-05", role: "issued" },
    ],
    subtype: "Annual benefit statement",
    costMinor: 21542,
    currency: "GBP",
    },
  },
  {
    // Ground-truth notes:
    // - Chose role 'service' over 'due' for the next-vaccination date: it denotes the next scheduled veterinary appointment/procedure (like the gas-safety-record precedent, where an inspection date keeps the 'service' role whether past or future), not a payment or response deadline, which is what the corpus otherwise uses 'due' for. scheduleKind follows as 'service' per the derivation rule (omit unless a date is renewal/service). Excluded from dates/dateRoles: all eleven vial batch expiry dates (the deliberate trap — shelf-life of the medicine, not an action date), the six worming/flea dates and their word-only 'monthly'/'every 3 months' intervals, the card issue date, the animal's date of birth and spay date, and the historical vaccination-given dates — none of these is what a careful owner would act on. reference is the microchip number (verbatim, stable) rather than the client account number or any vaccine batch. recurrenceMonths omitted: the annual booster interval is stated only in words ('annual booster'), never in digits, so the digits-in-evidence rule blocks it. costMinor/currency omitted: no fee is stated anywhere on the card, only the insurance cover limit, which is not a cost being charged.
    // - Subtype corrected: 'Pet vaccination card' is not printed anywhere. The page prints 'HEALTH CARD', which is used instead. 'Vaccination & Health Record' was avoided for the #982 ampersand reason.
    // - The card's small print used to explain that the vial expiry column was not actionable. That sentence was removed: a real card does not narrate its own trap, and leaving it in handed the extractor the answer.
    // - Subtype changed again after the card was rebuilt as a folded card: the 'HEALTH CARD' heading no longer exists on the page. The card now prints 'Vaccination & Health Record', so 'Health record' is used — the longest printed phrase that avoids the ampersand #982 breaks.
    name: "pet vaccination card, vial expiry dates as distractors",
    filename: "fullpage-pet-vaccination-card.pdf",
    text: "Vaccination & Health Record  \n\nBramble · Labrador Retriever · Microchip 977200005841236 Vaccination & health record · Page 1 of 2 \n\nVaccination & Health Record Please bring this card to every appointment \n\nHawksmoor Cross Veterinary Centre \n\n22 Thornfield Road, Bramcote St Giles, Wyvern DE7 4PL \n\nTelephone 01159 887 240 · reception@hawksmoorcrossvets.example \n\nRCVS Practice Registration PSS-22841 · VAT registration GB 442 8871 09 \n\nBramble \n\nLabrador Retriever · born 02 June 2022 \n\nMicrochip 977200005841236 \n\nCard issued 18 May 2026 · Client account HCV-008842 \n\nVaccination status: up to date \n\nLast given 18 May 2026 \n\nAnnual booster (DHPPi/L4 + kennel cough) \n\nNEXT VACCINATION DUE \n\n18 May 2027 Book in the two weeks before this date. \n\nKeep this card safe — replacements cost a small fee. \n\n✂   fold  —    —    —    — \n\n✂\n\nBramble · Labrador Retriever · Microchip 977200005841236 Vaccination & health record · Page 2 of 2 \n\nOWNER \n\nName Mr Callum Ashworth \n\nAddress 9 Ferndale Grove, Bramcote St \n\nGiles, Wyvern DE7 4RS \n\nTel 01159 220 671 · Email \n\nc.ashworth@example.co.uk \n\nAccount HCV-008842 \n\nANIMAL \n\nSpecies Canine (dog) · Breed Labrador \n\nRetriever · Colour Black \n\nSex Female · Neutered Yes — spayed 14 \n\nMarch 2024 \n\nDate of birth 02 June 2022 \n\nMicrochip 977200005841236 \n\nINSURER \n\nPet insurer Meadowbrook Pet \n\nAssurance \n\nPolicy number MPA-6620-317 \n\nCover Lifetime, £4,000 per condition \n\nVet Dr Priya Nandra BVetMed MRCVS, \n\nRCVS 4471982 \n\nVaccination history — full record \n\nVial expiry dates are recorded from the label of the vaccine vial used at each visit, for traceability, and reflect the manufacturer’s shelf life of that batch. \n\nWorming and flea treatment history \n\nDate given Product Batch no. Treats Next due (approx.) \n\n14 Jul 2022 Panacur oral wormer PF-77201 Roundworm, whipworm Every 3 months \n\n04 Aug 2022 Advocate spot-on AD-40982 Fleas, mites, lungworm Monthly \n\n21 Oct 2023 Milbemax tablet MB-22107 Tapeworm, roundworm Every 3 months \n\n09 Apr 2024 NexGard Spectra chewable NG-58813 Fleas, ticks, worms Monthly \n\n03 Mar 2025 Advocate spot-on AD-61204 Fleas, mites, lungworm Monthly \n\n16 Feb 2026 Milbemax tablet MB-30976 Tapeworm, roundworm Every 3 months \n\nWorming and flea treatments are recorded here for reference. Frequency shown is the practice’s general recommendation, not a scheduled reminder date. \n\nInsurance \n\nBramble is insured with Meadowbrook Pet Assurance, policy MPA-6620-317, lifetime cover at £4,000 per condition per year. Please tell \n\nreception before treatment if you intend to claim, so an estimate can be sent directly to your insurer where the policy allows it. This \n\npractice is not responsible for any shortfall between the fee charged and the amount your insurer pays. \n\nAbout this record — course and boosters \n\nPrimary course. Puppies normally receive two injections, three to four \n\nweeks apart, from around eight weeks of age, followed by a first \n\nbooster around twelve months later. Bramble’s primary course was \n\ncompleted with the doses of 14 July and 4 August 2022 shown above. \n\nAnnual boosters. After the primary course, \n\ndistemper/hepatitis/parvovirus/ parainfluenza and leptospirosis cover is \n\nmaintained with an annual booster. Kennel cough cover is also given \n\nannually and is recommended before boarding, training classes or \n\nshows. \n\nV ial batch and expiry. Each row above records the batch number and \n\nshelf-life expiry date printed on the vial actually used, as required for \n\nveterinary medicine traceability. \n\nMissed boosters. If a booster is given significantly later than the due \n\ndate, the vet may recommend restarting the primary course rather than \n\ntreating it as a simple top-up. Please book before the due date shown \n\non the card overleaf wherever possible. \n\nBoarding and travel. Kennels, catteries and some travel schemes \n\nrequire proof of an in-date kennel cough vaccination, normally given or \n\nboosted within the twelve months before boarding. Bring this card with \n\nyou when booking. \n\nKeeping this card. This card is Bramble’s record of vaccinations given \n\nby this practice. If Bramble is treated elsewhere, please ask the other \n\npractice to record details here or to send us a copy for our records. \n\nDate given Vaccine / component Batch / serial Vial expiry Route & site Vet \n\n14 Jul 2022 Primary course, dose 1 — distemper, hepatitis, parvovirus, parainfluenza (DHPPi) VN2201A 03/2024 SC, left shoulder PN \n\n04 Aug 2022 Primary course, dose 2 — DHPPi + Leptospirosis (L4) VN2209C 11/2023 SC, left shoulder PN \n\n04 Aug 2022 Kennel cough (Bordetella bronchiseptica) — primary dose KC0871 09/2023 IN, left nostril PN \n\n18 May 2023 Annual booster — DHPPi + Leptospirosis (L4) VN2304G 04/2025 SC, right shoulder PN \n\n18 May 2023 Kennel cough booster KC1102 01/2025 IN, left nostril AR \n\n18 May 2024 Annual booster — DHPPi + Leptospirosis (L4) VN2405D 03/2026 SC, left shoulder PN \n\n18 May 2024 Kennel cough booster KC1349 11/2025 IN, left nostril PN \n\n18 May 2025 Annual booster — DHPPi + Leptospirosis (L4) VN2503H 02/2027 SC, right shoulder PN \n\n18 May 2025 Kennel cough booster KC1588 10/2026 IN, left nostril AR \n\n18 May 2026 Annual booster — DHPPi + Leptospirosis (L4) VN2604K 01/2028 SC, left shoulder PN \n\n18 May 2026 Kennel cough booster KC1822 09/2027 IN, left nostril PN \n\nG IV EN \n\nG IV EN \n\nHawksmoor Cross Veterinary Centre · Bramble · Microchip 977200005841236 Page 2 of 2\n",
    expected: {
    dates: ["2027-05-18"],
    provider: "Hawksmoor Cross Veterinary Centre",
    reference: "977200005841236",
    dateRoles: [
      { date: "2027-05-18", role: "service" },
    ],
    subtype: "Health record",
    scheduleKind: "service",
    },
  },
  {
    // Ground-truth notes:
    // - The word 'renewal'/'renews' is never used. The service charge year is framed only as running 1 April 2026 to 31 March 2027 (a 12-month period), and the document itself says that at the end of that year a further demand follows for the next instalment — that is the signal a correct extraction has to pick up on to assign role 'renewal' to 2027-03-31.
    // - dates deliberately omits the instalment due dates (1 April 2026, 1 October 2026), the demand issue date (10 March 2026), the prior year end (2026-03-31) and the board approval date (24 February 2026): all texture a careful human would not report as the document's governing date.
    // - costMinor is the leaseholder's apportioned annual service charge for the year ending 31 March 2027 (£3,930.00), not the development-wide budget total (£94,320.00, explicitly excluded), not the first instalment alone (£1,965.00), and not the 'total now due' on this demand (£1,990.83, which blends the regular charge with a one-off prior-year balancing figure). This mirrors the corpus convention (see the buildings/contents schedule fixture) of choosing the annual figure over a periodic instalment when both are printed on the page.
    // - recurrenceMonths: 12 is declared because the document prints the service charge year as running 'for a 12-month period' in digits, alongside the scheduled next-demand event implied by the year-end date.
    // - provider is the managing agent (who issues and administers the demand), not the freeholder/landlord (Thornfield Court (Freehold) Ltd) or the individual property manager named in the queries section — matching the convention of naming the entity that issued the document.
    // - reference is the account reference TFC-014-2627 rather than the lease reference TFC/14/LR-1998, since the account reference is what the demand itself is filed and paid against.
    name: "leasehold service charge, period-framed with no renewal word",
    filename: "fullpage-service-charge-demand.pdf",
    text: "Service Charge Demand — Thornfield Court  \n\nP&V \n\nPur beck  &  Vane  Pro p erty  Management  Ltd \n\n14 Cathedral Approach, Wexbridge, WX2 1TP · 01926 774 220 · accounts@purbeckvane.example \n\nRegistered in England & Wales No. 08841772 · VAT registration No. GB 204 7731 55 \n\nMember of the National Property Agents Redress Panel, ref NPARP-44188 \n\nManaging agents for Thornfield Court (Freehold) Ltd \n\n10 March 2026 \n\nDear Ms Vance, \n\nRe: Service charge demand — Flat 14, Thornfield Court \n\nAccount reference TFC-014-2627 · Lease reference TFC/14/LR-1998 · First instalment (1 of 2) \n\nWe write as managing agents for Thornfield Court (Freehold) Ltd, the landlord and freeholder of Thornfield Court, whose \n\nregistered office is c/o this office at the address above, to demand payment of the service charge apportioned to your property \n\nfor the service charge year running from 1 April 2026 to 31 March 2027. This demand is issued under clause 4 of your lease and \n\nsection 21B of the Landlord and Tenant Act 1985. \n\nThornfield Court comprises 24 flats at 22 Petersgate Road, Alderwick, WX7 4LP. Your lease reference is TFC/14/LR-1998, and \n\nthis account is held under reference TFC-014-2627, which should be quoted in all correspondence. Your fixed contribution \n\nunder the lease is a 1/24th share of the development’s service charge, equivalent to 4.1667% of the total. Please continue to send \n\nany correspondence about this account to you at the address shown above. \n\nThis demand covers the service charge year running for a 12-month period from 1 April 2026 to 31 March 2027. Under the \n\nterms of your lease, contributions for that year are collected in two equal instalments, due on 1 April 2026 and 1 October 2026, \n\ntogether with any balancing adjustment carried forward from the year ended 31 March 2026. At the end of the service charge \n\nyear we will send you the certified accounts for the year ending 31 March 2027 and the budget for the following service charge \n\nyear, with a further demand for the instalment then falling due. \n\nYour apportioned share of the service charge budgeted for the development for that year is £3,930.00, as shown in the schedule \n\nat Appendix A, payable in two equal instalments of £1,965.00 each. Together with a balancing charge of £25.83 brought \n\nforward from the year ended 31 March 2026, shown at Appendix B, the total amount now due from you is £1,990.83, payable \n\nby 1 April 2026. Your second instalment of £1,965.00 for this service charge year will fall due on 1 October 2026. \n\nMs Eleanor Vance \n\nFlat 14, Thornfield Court \n\n22 Petersgate Road \n\nAlderwick \n\nWX7 4LP \n\nPurbeck & Vane Property Management Ltd · Account TFC-014-2627 Page 1 of 4\n\nPu r beck  &  Vane  Prop erty  Management  Ltd \n\nPayment may be made by bank transfer to the client account below, quoting your account reference with every payment: \n\nAccount name  Purbeck & Vane Client Account — Thornfield Court \n\nSort code  40-11-22 \n\nAccount number  83291006 \n\nPayment reference  TFC-014-2627 \n\nAlternatively you may pay by cheque, made payable to “Purbeck & Vane Client Account”, or set up a standing order for the \n\nhalf-yearly instalments by contacting us at accounts@purbeckvane.example. \n\nFor your reference, the budget for the whole development is set out at Appendix A, the calculation of the balancing charge and \n\nthe instalment schedule for this service charge year at Appendix B, and a Summary of Tenants’ Rights and Obligations, which \n\nforms part of this demand, at the end of this letter. \n\nYours sincerely, \n\nDeclan Osei \n\nProperty Manager \n\nfor Purbeck & Vane Property Management Ltd \n\nPurbeck & Vane Property Management Ltd · Account TFC-014-2627 Page 2 of 4\n\nAPPENDIX  A \n\nBudget for the service charge year ending 31 March 2027 \n\nThe table below shows the actual cost for the development for the year ended 31 March 2026, the budgeted cost for the year ending 31 \n\nMarch 2027, and your apportioned share of this year’s budget at your fixed contribution of 1/24th (4.1667%) of the total. Individual line \n\nshares are rounded to the nearest penny, which may leave the column up to a penny short of the total shown. \n\nExpenditure head Actual, year ended 31 Mar 2026 Budget, year ending 31 Mar 2027 Flat 14 share (4.1667%) \n\nBuildings insurance premium £18,420.00 £19,650.00 £818.75 \n\nCommunal electricity (landings, \n\nhallways, external lighting) \n\n£6,140.00 £6,800.00 £283.33 \n\nLift maintenance contract and \n\nLOLER thorough examinations \n\n£7,850.00 £8,200.00 £341.67 \n\nGrounds maintenance and \n\ngardening contract \n\n£5,200.00 £5,450.00 £227.08 \n\nCommunal cleaning contract £4,980.00 £5,150.00 £214.58 \n\nDoor entry system maintenance and \n\ncall points \n\n£1,340.00 £1,400.00 £58.33 \n\nFire risk assessment and fire \n\nequipment servicing \n\n£2,150.00 £2,300.00 £95.83 \n\nCommunal water rates £1,860.00 £1,950.00 £81.25 \n\nReactive repairs and communal \n\nmaintenance \n\n£9,400.00 £8,000.00 £333.33 \n\nHealth and safety compliance (incl. \n\nLegionella risk assessment) \n\n£980.00 £1,050.00 £43.75 \n\nManagement fee £16,800.00 £17,520.00 £730.00 \n\nReserve (sinking) fund contribution £12,000.00 £13,200.00 £550.00 \n\nAccountancy and audit fee £2,400.00 £2,500.00 £104.17 \n\nOut-of-hours emergency call-out \n\ncontract \n\n£1,100.00 £1,150.00 £47.92 \n\nTotal, whole development £90,620.00 £94,320.00 £3,930.00 \n\nDevelopment-wide totals are shown for information only and are not the sum charged to any one flat. Your service charge for the year ending 31 March 2027 is your \n\napportioned share shown in the right-hand column, totalling £3,930.00. \n\nNotes on the budget \n\nThe reactive repairs and maintenance budget has been set below last year’s actual spend because the year ended 31 March 2026 included the \n\none-off cost of repairing storm damage to the communal roof, which is not expected to recur. The reserve fund contribution has increased to \n\nbuild up provision for external redecoration works anticipated to be required within the next three years. The board of Thornfield Court \n\n(Freehold) Ltd approved this budget at its meeting on 24 February 2026. \n\nPurbeck & Vane Property Management Ltd · Account TFC-014-2627 Page 3 of 4\n\nAPPENDIX  B \n\nBalancing charge and instalment schedule \n\nBalancing charge — year ended 31 March 2026 \n\nItem Amount \n\nActual expenditure, whole development, year ended 31 March 2026 £90,620.00 \n\nFlat 14 apportioned share (4.1667%) £3,775.83 \n\nLess: instalments already collected on account from Flat 14 during that year (2 × £1,875.00) −£3,750.00 \n\nBalancing charge due from Flat 14, carried forward to this demand £25.83 \n\nHad the on-account instalments exceeded the apportioned actual cost, the difference would have been shown as a credit and set against your first instalment for the year \n\nending 31 March 2027 instead. The certified service charge accounts for the year ended 31 March 2026 are available on request from the managing agent free of charge. \n\nInstalment schedule for the year ending 31 March 2027 \n\nInstalment Due date Amount \n\nFirst instalment plus balancing charge (this demand) 1 April 2026 £1,990.83 \n\nSecond instalment 1 October 2026 £1,965.00 \n\nThe First-tier Tribunal \n\nIf you consider any of the charges set out in this demand to be unreasonable, or you dispute your liability to pay them, you may apply to the \n\nFirst-tier Tribunal (Property Chamber) for a determination under section 27A of the Landlord and Tenant Act 1985. The Tribunal can \n\ndecide whether a charge is payable, and if so, the amount, the date it is payable, and to whom. Making an application does not relieve you of \n\nthe obligation to pay the amount demanded pending the Tribunal’s decision, and does not by itself suspend the due date shown in this letter. \n\nDetails of how to apply are available from HM Courts & Tribunals Service, or from the managing agent on request. \n\nQueries about this demand \n\nPlease direct queries about this account to the property manager for Thornfield Court, Mr Declan Osei, at Purbeck & Vane Property \n\nManagement Ltd, 14 Cathedral Approach, Wexbridge, WX2 1TP, telephone 01926 774 220 extension 214, or \n\naccounts@purbeckvane.example, quoting account reference TFC-014-2627. A complaints procedure is available on request and, if a \n\ncomplaint is not resolved to your satisfaction, you may refer it to the National Property Agents Redress Panel. \n\nSummary of Tenants’ Rights and Obligations \n\nThis summary must accompany a service charge demand and is provided in general terms only; it does not describe your particular rights and obligations, which depend on the \n\nterms of your lease and current legislation. \n\nRight to a written summary of costs. You may ask in writing for a written summary of the costs making up any service charge demanded from you in the preceding twelve \n\nmonths. The landlord must provide this within one month of the request, or within six months of the end of the relevant accounting period, whichever is later. \n\nRight to inspect supporting documents. Within six months of receiving a written summary you may require the landlord to allow you to inspect the accounts, receipts and \n\nother documents supporting it, or to provide copies, on reasonable notice. \n\nRight to challenge reasonableness. You may apply to the appropriate tribunal for a determination whether a service charge is payable, and if so, by whom, to whom, how \n\nmuch, and when. Your right to apply is not affected by having already paid the charge. \n\nWithholding payment. A tenant may have the right to withhold payment of a service charge if this summary is not provided with the demand. If you withhold a service \n\ncharge in these circumstances, you may still be asked to pay interest once this summary is provided. \n\nInsolvency. Where a tenant is an individual, non-payment of a service charge, or of an administration charge, may in certain circumstances entitle the landlord to seek \n\nforfeiture of the lease. A demand for a service charge must be accompanied by this summary and, where it is not, all or part of the charge may not be payable until it is \n\nprovided. \n\nAdvice can be obtained from a solicitor, a citizens advice bureau, or a residential property lawyer. This notice is a general guide and is not a substitute for individual legal advice. \n\nPurbeck & Vane Property Management Ltd · Account TFC-014-2627 Page 4 of 4\n",
    expected: {
    dates: ["2027-03-31"],
    provider: "Purbeck & Vane Property Management Ltd",
    reference: "TFC-014-2627",
    dateRoles: [
      { date: "2027-03-31", role: "renewal" },
    ],
    subtype: "Service charge demand",
    costMinor: 393000,
    currency: "GBP",
    recurrenceMonths: 12,
    scheduleKind: "renewal",
    },
  },
  {
    // Ground-truth notes:
    // - The only tracked date is 31 March 2027, when the household's export tariff agreement ends, stated once mid-paragraph in the page 2 tariff terms ('...ends on 31 March 2027'). It sits one line after the unrelated RPI rate-review date (1 October 2026) and is never tabulated or emphasised. The four quarterly blocks on page 1 each carry a period start, a period end, a reading date and a payment date (sixteen dates in total) plus a rate; none is the answer, and the Quarter 4 period end (31 March 2026) is deliberately one calendar year before the answer to bait a same-day-and-month match. Also excluded: the installation commissioning date (18 June 2019), the export meter's last verification date (12 May 2022) and its stated future validity date (12 May 2032), the statement date (24 April 2026), the RPI rate-review date (1 October 2026), and the tariff agreement's own start date (1 April 2023). costMinor is the annual summary's net 'Total paid to you this year' (£343.64), not the gross four-quarter sum before the metering charge (£361.64), not any individual quarterly payment (£108.45 / £146.57 / £55.95 / £50.67), and not the estimated 2026/27 total (£355.00, explicitly a forecast). Meter readings are printed as seven-digit decimal register values (e.g. 018942.6 kWh) and export rates as p/kWh figures (15.72p, 16.05p); none resembles the money answer. provider is Millbrook Energy Ltd, the retail brand named in the header wordmark and small print, not Cheswick Metering Services Ltd, the wholly owned subsidiary named in the small print that actually calculates and administers the generation payments. reference is the generation account number (SEG-4471-0932) rather than either meter's serial number (GM7734215, EM2205968) or the MCS installation reference (2019/A/48871).
    name: "solar export statement, sixteen quarterly dates around one tariff-end renewal date",
    filename: "fullpage-solar-export-statement.pdf",
    text: "Millbrook Energy — Solar Export Statement  \n\nMillbrook Energy Solar Generation Team · Annual Solar Export Statement \n\nGENERATION ACCOUNT SEG-4471-0932 \n\nSTATEMENT PERIOD 01/04/2025 – 31/03/2026 \n\nSTATEMENT DATE 24/04/2026 \n\nMrs Priya Nandra \n\n7 Larkspur Close \n\nBramfield \n\nSuffolk \n\nIP14 6QS \n\nInstallation address: as above \n\nArray size 4.2 kWp \n\nPanels / inverter 14 × 300W, single inverter \n\nCommissioned 18 June 2019 \n\nMCS installation ref. 2019/A/48871 \n\nInstaller SunHarvest Installations Ltd \n\nGeneration meter GM7734215 \n\nExport meter EM2205968 \n\nExport meter last verified 12 May 2022 \n\nYour quarterly export and payments this year \n\nQuarter 1 1 Apr 2025 – 30 Jun 2025 \n\nGeneration meter, opening → closing 018942.6 → 020184.9 kWh \n\nExport meter, opening → closing 009821.4 → 010511.2 kWh \n\nGeneration this quarter 1242.3 kWh \n\nExported to grid this quarter 689.8 kWh \n\nExport rate applied 15.72p/kWh \n\nReading date 03/07/2025 \n\n£108.45 paid 18/07/2025 \n\nQuarter 2 1 Jul 2025 – 30 Sep 2025 \n\nGeneration meter, opening → closing 020184.9 → 021871.4 kWh \n\nExport meter, opening → closing 010511.2 → 011443.6 kWh \n\nGeneration this quarter 1686.5 kWh \n\nExported to grid this quarter 932.4 kWh \n\nExport rate applied 15.72p/kWh \n\nReading date 04/10/2025 \n\n£146.57 paid 17/10/2025 \n\nQuarter 3 1 Oct 2025 – 31 Dec 2025 \n\nGeneration meter, opening → closing 021871.4 → 022518.7 kWh \n\nExport meter, opening → closing 011443.6 → 011799.5 kWh \n\nGeneration this quarter 647.3 kWh \n\nExported to grid this quarter 355.9 kWh \n\nExport rate applied 15.72p/kWh \n\nReading date 05/01/2026 \n\n£55.95 paid 19/01/2026 \n\nQuarter 4 1 Jan 2026 – 31 Mar 2026 \n\nGeneration meter, opening → closing 022518.7 → 023102.9 kWh \n\nExport meter, opening → closing 011799.5 → 012121.8 kWh \n\nGeneration this quarter 584.2 kWh \n\nExported to grid this quarter 322.3 kWh \n\nExport rate applied 15.72p/kWh \n\nReading date 06/04/2026 \n\n£50.67 paid 20/04/2026 \n\nMeter readings are taken remotely from your smart export meter where possible; a reading marked with an asterisk elsewhere in your account history would indicate an estimate \n\ncarried forward pending a site visit. No readings on this statement are estimated. \n\nMillbrook Energy · Generation account SEG-4471-0932 Page 1 of 2\n\nMillbrook Energy — Solar Generation Team SEG-4471-0932 · Page 2 of 2 \n\nAnnual summary, 1 April 2025 to 31 March 2026 \n\nThis statement summarises the 12-month period from 1 April 2025 to 31 March 2026, drawn from the quarterly meter readings and payments on the \n\nprevious page. \n\nTotal generation recorded this year 4160.3 kWh \n\nTotal exported to the grid this year 2300.4 kWh \n\nGross export payment, four quarters £361.64 \n\nLess: annual metering & data administration charge −£18.00 \n\nTotal paid to you this year £343.64 \n\nEstimated total for 2026/27 if generation is unchanged £355.00 \n\nYour export payments by quarter \n\n£108.45 \n\n£146.57 \n\n£55.95 £50.67 \n\nQ1 25/26 Q2 25/26 Q3 25/26 Q4 25/26 \n\nYour export tariff explained \n\nPayments in this statement are calculated by multiplying the export figure recorded at your export meter each quarter by the export rate applying to your \n\ngeneration account. Your generation account is held on our Standard Export Tariff. \n\nRATE P/KWH APPLIES \n\nStandard Export Tariff (this statement) 15.72 until reviewed \n\nStandard Export Tariff, after RPI review 16.05 from 1 October 2026 \n\nThe export rate shown above is reviewed each year in line with RPI on 1 October; based on this year's review it will next change on 1 October 2026. This is \n\nseparate from your export tariff agreement, which began on 1 April 2023 for a fixed term of 4 years and ends on 31 March 2027. Shortly before your \n\nagreement ends we will write to you with the export tariffs then available, and if you take no action your generation account will move onto our then- \n\ncurrent default export tariff. \n\nMillbrook Energy Ltd is a licensed electricity supplier, registered in England & Wales \n\nNo. 06821345, registered office 14 Foundry Court, Leeds, LS2 7QW. Millbrook Energy Ltd \n\nis licensed to supply electricity by Ofgem, the Office of Gas and Electricity Markets. \n\nGeneration payments under the Smart Export Guarantee are calculated and administered \n\non behalf of Millbrook Energy Ltd by Cheswick Metering Services Ltd, a wholly owned \n\nsubsidiary of Millbrook Energy Ltd and its appointed generation payment \n\nadministrator, registered in England & Wales No. 05512987, registered office 3 Riverside \n\nBusiness Park, Leeds, LS9 8AH. Correspondence about a specific quarterly payment \n\nshould quote your generation account number and be sent to Cheswick Metering \n\nServices Ltd at the address above. \n\nExport figures are taken from your export meter, serial EM2205968, which was last \n\nverified for accuracy on 12 May 2022 in line with the Measuring Instruments Regulations \n\n2016 and is valid for use until 12 May 2032. Generation figures are taken from your \n\ngeneration meter, serial GM7734215, and are provided for information; they do not affect \n\nthe payment calculated for this statement. \n\nIf you are unhappy with how a payment on this statement has been calculated, contact \n\nour Solar Generation Team in the first instance. If we cannot resolve your complaint \n\nwithin eight weeks, you may refer it free of charge to the Energy Ombudsman. Your \n\nexport meter installation was carried out by SunHarvest Installations Ltd under MCS \n\ncertification; MCS certification is unrelated to your export tariff agreement with \n\nMillbrook Energy Ltd. \n\nStatement layout SES-4/2026, generated from meter records held on your generation \n\naccount. This statement supersedes any estimated figures previously issued for the \n\nquarters shown above. \n\nMillbrook Energy · Generation account SEG-4471-0932 Page 2 of 2\n",
    expected: {
    dates: ["2027-03-31"],
    provider: "Millbrook Energy Ltd",
    reference: "SEG-4471-0932",
    dateRoles: [
      { date: "2027-03-31", role: "renewal" },
    ],
    subtype: "Solar export statement",
    costMinor: 34364,
    currency: "GBP",
    recurrenceMonths: 12,
    scheduleKind: "renewal",
    },
  },
  {
    // Ground-truth notes:
    // - dates: the period of insurance runs 1 April 2026 to 1 April 2027, printed together in the certificate panel and roled start/renewal. Twelve other printed dates are deliberately not declared: the certificate issue date (18 March 2026), the date continuous cover began three years earlier (1 April 2023), the medical screening completion date (11 January 2026) and its expiry (10 January 2027), the deadline to declare a change in health (1 December 2026), the worked trip-length example dates (3 June 2026 and 4 July 2026, illustrating the 31-day limit), the worked winter-sports example dates (5 January 2027 and 22 January 2027, illustrating the 17-day limit), the policy booklet's last-updated stamp (3 March 2026), the privacy notice review date (12 May 2026), and an illustrative claim-turnaround example (2 August 2025) — none of these is a date the policyholder would track, and several exist only to work through the 31-day/17-day trip-length rules in digits. provider is Kestrel Travel Insurance Services Ltd, the administrator named on the certificate as agent of the insurer and the business the customer actually bought from, not Palisade Insurance Company plc (the underwriter, named only in the small print) or Worldreach Assistance Ltd (the 24-hour assistance company, named on the emergency band and its own numbers). reference is the certificate number KTL/AMT/449108, distinguishable from the surrounding digits only by its label; the emergency assistance band and grid carry several longer, purely numeric rivals in the same neighbourhood (the assistance line 0345 646 0891, its dialled-from-abroad form +44 345 646 0891, the US/Canada toll-free 1 800 745 1102, the policy service line 0345 604 8817, the claims line 0345 604 2291, and the medical case reference format MCR-774512), none of which is declared. costMinor is £159.60, the annual premium including Insurance Premium Tax, printed as the bold total directly beneath the premium excluding tax (£133.00); the IPT amount itself (£26.60), the optional winter sports upgrade (£34.50) and the standard excess (£95.00) are printed alongside but are not the answer, and the many section limits and excesses in the table of benefits on page 2 are further undeclared rival amounts. recurrenceMonths is 12, printed in digits against the period of insurance ('12 months, from 1 April 2026 to 1 April 2027') and again against the medical screening validity period, so is not grounded on a single throwaway mention.
    name: "travel insurance certificate, trip-length digits and emergency numbers crowd the reference",
    filename: "fullpage-travel-insurance-certificate.pdf",
    text: "Annual Multi-Trip Travel Insurance Certificate  \n\nKESTREL TRAVEL INSURANCE SERVICES LTD Administrator of your annual multi-trip travel insurance policy \n\nCertificate number \n\nKTL/AMT/449108 \n\nANNUAL MULTI-TRIP TRAVEL INSURANCE CERTIFICATE \n\nP OLIC YHOLD E R \n\nMr Callum Whitfield \n\nAD D RE SS \n\n22 Oakfield Rise, Nettlecombe, Somerset TA5 1QF C E RTIFIC ATE  ISSUE D  ON \n\n18 March 2026 C ONTINUOUS C OV E R HE LD  WITH US SINC E \n\n1 April 2023 ARE A OF C OV E R \n\nWorldwide, excluding the United States, Canada, the Caribbean and Mexico \n\nP E RIOD  OF INSURANC E \n\n12 months, from 1 April 2026 to 1 April 2027 \n\nRE NE WAL D ATE  — C OV E R E ND S UNLE SS RE NE WE D \n\n1 April 2027 \n\nM AX IM UM  D URATION OF ANY ONE  TRIP \n\n31 days M AX IM UM  D URATION OF ANY ONE  WINTE R SP ORTS TRIP \n\n17 days C OV E R UND E R E AC H TRIP  BE GINS \n\n24 hours before your scheduled departure time \n\nInsurance Premium Tax (IPT), charged at 20% of the net premium £26.60 \n\nOptional winter sports upgrade (if purchased) £34.50 \n\nStandard excess, per person, per incident £95.00 \n\nPremium excluding Insurance Premium Tax £133.00 \n\nAnnual premium, including Insurance Premium Tax £159.60 \n\nUnderwritten by Palisade Insurance Company plc, authorised by the Prudential Regulation Authority and regulated by the Financial Conduct Authority and the Prudential Regulation Authority, firm reference number 148820. This certificate is issued by Kestrel Travel Insurance Services Ltd, of 14 Harbourage Street, Poole, Dorset BH15 1TA, company number 07741108, as agent of the insurer and administrator of this policy. Kestrel Travel Insurance Services Ltd is authorised and regulated by the Financial Conduct Authority, firm reference number 552817. \n\nIN  A M EDICAL EM ER GEN CY ABR O AD, CALL F O R  AS S IS T AN CE BEF O R E YO U GO  T O  H O S P IT AL IF  YO U CAN \n\n+44 (0)345 646 0891 Worldreach Assistance Ltd operates this line 24 hours a day, every day of the year. Have your certificate number and, if you have one, your medical case reference to hand. \n\nCALLING THE ASSISTANCE LINE WHILE ABROAD \n\nFROM THE UNITED KINGDOM \n\n0345 646 0891 \n\nFROM THE USA OR CANADA (TOLL-FREE) \n\n1 800 745 1102 \n\nFROM SPAIN \n\n900 802 217 \n\nFROM FRANCE \n\n0800 91 2280 \n\nFROM AUSTRALIA \n\n1800 774 512 \n\nFROM THE REPUBLIC OF IRELAND \n\n1800 555 044 \n\nANYWHERE ELSE — REVERSE THE CHARGES TO \n\n+44 345 646 0891 \n\nMEDICAL CASE REFERENCE FORMAT, ONCE ISSUED \n\nMCR-774512 \n\nOTHER NUMBERS YOU MAY NEED \n\nPolicy service and enquiries (Kestrel Travel Insurance Services Ltd, UK office hours) 0345 604 8817 \n\nClaims line (Kestrel Travel Insurance Services Ltd) 0345 604 2291 \n\nWorldreach Assistance Ltd, registered office, Lakeside House, 4 Priory Retail Park, Croydon CR0 4XB 020 8946 1102 \n\nWhen dialling a UK number from abroad, replace the leading 0 with the UK country code, for example 0345 604 8817 becomes +44 345 604 8817. Calls to 03 numbers cost no more than a call to a UK landline number and are included in most UK call packages. \n\nKestrel Travel Insurance Services Ltd · Certificate KTL/AMT/449108 Page 1 of 2\n\nKestrel Travel Insurance Services Ltd · Annual Multi-Trip Travel Insurance Certificate Certificate KTL/AMT/449108 · Page 2 of 2 \n\nTABLE OF BENEFITS \n\nSECTION OF COVER LIMIT EXCESS \n\nCancellation or cutting short your trip £5,000 per person £95 \n\nEmergency medical treatment and repatriation £10,000,000 £95 \n\nHospital benefit, per 24 hours as an in-patient (maximum £600) £20 Nil \n\nBaggage and personal effects (single article limit £300) £1,500 £95 \n\nDelayed baggage, more than 12 hours £150 Nil \n\nTravel delay, per full 12 hours (maximum £150) £25 Nil \n\nMissed departure £500 £95 \n\nPersonal accident £25,000 Nil \n\nPersonal liability £2,000,000 £250 \n\nLegal expenses £25,000 £250 \n\nWinter sports equipment (upgrade only, hired or owned) £750 £150 \n\nWinter sports piste closure (upgrade only), per day (maximum £250) £30 Nil \n\nScheduled airline failure £1,500 £95 \n\nCruise cover, if selected and shown on your certificate £750 £95 \n\nWedding cover, if selected and shown on your certificate £1,000 £95 \n\nThe standard excess of £95 per person, per incident applies to each section above unless a different excess is shown against it. Where a claim involves more than one section, an excess is payable under each section that applies. Limits and excesses shown here summarise policy booklet KTL-TRV-2026, which takes precedence in the event of any inconsistency. \n\nTRIP LENGTH AND WHEN YOUR COVER APPLIES \n\nCover under this certificate applies to trips of up to 31 days, or up to 17 days for a trip that includes winter sports, beginning from your home in the United Kingdom and ending on your return to the United Kingdom. Cover for each trip starts 24 hours before your scheduled departure time and ends on your return, or on expiry of the maximum trip length shown above, whichever happens first. For example, if you leave the United Kingdom on 3 June 2026, your trip must end, and you must be back in the United Kingdom, by 4 July 2026 to remain within the standard 31- day limit. In the same way, a winter sports holiday beginning on 5 January 2027 must end, and you must be back in the United Kingdom, by 22 January 2027 to remain within the 17-day winter sports limit. A trip that runs beyond the applicable limit is not covered for the days beyond it. \n\nThis certificate provides continuous cover for any number of trips within the period of insurance shown overleaf, provided no single trip exceeds the relevant maximum duration. It does not cover a single trip planned, at the time of booking, to last longer than the applicable limit, even if only the days beyond the limit are eventually used. \n\nYOUR HEALTH AND MEDICAL SCREENING \n\nCover for a medical condition you already have when you take out or renew this policy depends on your having completed our medical screening. Your most recent screening was completed on 11 January 2026 and remains valid for a period of 12 months, until 10 January 2027. If your screening has expired before you travel, or if you have not been screened, we may not cover claims relating to an existing medical condition. \n\nYou must tell us about any change in your health, or in that of anyone whose health could lead to a claim, before 1 December 2026, or before you next travel if that is earlier, whichever comes first. We will tell you whether the change affects your cover or premium. If you do not tell us, we may not pay a claim connected with the change. \n\nMAKING A CLAIM \n\nContact the assistance line overleaf as soon as possible if you need emergency medical treatment or repatriation while abroad, so that we can support you and manage the cost of your treatment directly with the hospital wherever we can. For all other claims, write to the claims line overleaf within 31 days of returning home, enclosing your certificate number and any receipts, reports or other evidence supporting your claim. As an example of our usual service standard, a claim notified to us on 2 August 2025 was assessed and settled within ten working days of our receiving all the information we needed; the time a genuine claim takes will depend on its own circumstances. \n\nCANCELLING THIS POLICY \n\nYou may cancel this policy within 14 days of the certificate issue date shown overleaf, or the day you receive your policy documents if later, and receive a full refund provided you have not travelled and have no claim to make. After this cooling-off period, you may cancel at any time by writing to Kestrel Travel Insurance Services Ltd, but no refund is due once the period of insurance has begun. \n\nHOW TO COMPLAIN \n\nIf you are unhappy with this policy or with the handling of a claim, contact Kestrel Travel Insurance Services Ltd in the first instance, using the policy service number overleaf. If your complaint is not resolved to your satisfaction, you may refer it to the Financial Ombudsman Service, free of charge, normally within six months of our final response. Referring a complaint does not affect your right to take legal action. \n\nKestrel Travel Insurance Services Ltd, registered in England and Wales, company number 07741108, registered office 14 Harbourage Street, Poole, Dorset BH15 1TA. Authorised and regulated by the Financial Conduct Authority, firm reference number 552817. Underwritten by Palisade Insurance Company plc, registered office Palisade House, 3 Anchor Quay, Bristleport BR2 9QP, company number 04412207. Worldreach Assistance Ltd, registered office Lakeside House, 4 Priory Retail Park, Croydon CR0 4XB, company number 05528817, provides the 24-hour assistance service under contract to the insurer. This policy booklet was last updated on 3 March 2026 and your personal data is handled in accordance with our privacy notice, reviewed on 12 May 2026 and available at kestreltravelinsurance.example/privacy. Data protection registration ZA552817. \n\nKestrel Travel Insurance Services Ltd · Certificate KTL/AMT/449108 Page 2 of 2\n",
    expected: {
    dates: ["2026-04-01","2027-04-01"],
    provider: "Kestrel Travel Insurance Services Ltd",
    reference: "KTL/AMT/449108",
    dateRoles: [
      { date: "2026-04-01", role: "start" },
      { date: "2027-04-01", role: "renewal" },
    ],
    subtype: "Travel insurance certificate",
    costMinor: 15960,
    currency: "GBP",
    recurrenceMonths: 12,
    scheduleKind: "renewal",
    },
  },
  {
    // Ground-truth notes:
    // - Valid from (1 April 2026) and valid to (31 March 2027) are printed adjacent in the panel in identical sans-serif style with no hierarchy between them; only valid to is the answer, since that is the last day the licence covers, and it alone gets role 'renewal'. The footer's issue date (10 March 2026) is styled as plain prose text in the same day-month-year form as the two panel dates, making three date-like strings in total against one answer. The fee row prints the annual fee (£182.00) beside the quarterly Direct Debit amount (£45.50) with nothing marking either as the yearly total; costMinor is the first figure, £182.00, because that is the licence's own cost, not the payment instalment. Colefield Broadcast Licensing Authority Limited is named twice only: as the shortened wordmark 'COLEFIELD LICENSING' in the logo block, and in full in the single footer line, which is also the form declared as provider so it matches literally. recurrenceMonths=12 comes from 'It runs for 12 months' in the prose, the only place a number of months is stated; scheduleKind is 'renewal' because the tracked date is the licence's own renewal point, not a service visit.
    name: "tv licence confirmation, sparsest document, three identically-styled dates and no context words",
    filename: "fullpage-tv-licence-confirmation.pdf",
    text: "Television Licence Confirmation  \n\nCOLEF I ELD  L ICENSING \n\nTelevision Licence \n\nLicence number CBL-774-2091 \n\nValid from 1 April 2026 \n\nValid to 31 March 2027 \n\nFee £182.00   £45.50 by quarterly Direct Debit \n\nThis confirms that a valid television licence is held for the address on your \n\naccount. \n\nThe licence covers any device used to watch or record programmes as they \n\nare broadcast. \n\nIt runs for 12 months from the start date shown in the panel above. \n\nPlease keep this confirmation with your household records. \n\nIf any of the details above are incorrect, contact us using the address below. \n\nColefield Broadcast Licensing Authority Limited · Confirmation issued 10 March 2026 · Enquiries 0300 \n\n555 0148\n",
    expected: {
    dates: ["2027-03-31"],
    provider: "Colefield Broadcast Licensing Authority Limited",
    reference: "CBL-774-2091",
    dateRoles: [
      { date: "2027-03-31", role: "renewal" },
    ],
    subtype: "Television licence",
    costMinor: 18200,
    currency: "GBP",
    recurrenceMonths: 12,
    scheduleKind: "renewal",
    },
  },
  {
    // Ground-truth notes:
    // - reference is the registration document reference in the boxed strip (4471 8823 0519), not the registration mark LR69 KHM (printed largest, in its own heavy-ruled plate-style box, and repeated in the running header and counterfoil), the VIN (WVWZZZ1KZLW238841), or the Authority's own case reference (HVLA-2026-661452) — none of those are what a keeper would quote to renew. costMinor is the single 12 month rate (£180.00), not the 6 month rate (£99.00), the monthly Direct Debit rate or its 12-month total (£15.75 / £189.00), or the late-licensing penalty (£80, or up to £1,000 on conviction). dates holds only the current tax expiry (31 October 2026), role 'expiry', per the task spec; deliberately excluded as distractors: the MOT expiry (19 November 2026, chosen to fall within three weeks of the tax expiry so the two are easily swapped), date of first registration (14 March 2019), registered-keeper-since date (22 June 2021), the reminder's own issue date (04 September 2026), the insurance database check date (02 September 2026) and the separate policy-valid-to date it reports (14 January 2027), the 'already taxed since' cutoff (28 August 2026), the renewal window opening date (01 October 2026), the indicative first Direct Debit collection date (01 November 2026), the prior reminder date (04 August 2025), and the database-last-updated timestamp. scheduleKind is declared 'renewal' per the task spec even though the sole dateRole is 'expiry' rather than 'renewal' — flagging this as worth a second look, since it does not match the scheduleKind-from-roles convention used elsewhere in this corpus (renewal role -> renewal scheduleKind). The Authority's full name appears exactly once, in the header band; every other mention on the page (running header, footer, counterfoil) uses only the initials HVLA. The end date is roled 'renewal' rather than 'expiry' because the household must act again on it, which is the distinction this corpus draws: 'expiry' is reserved for a document that simply runs out (the MOT certificate), and verify.mjs derives scheduleKind from the role.
    name: "vehicle tax reminder, plate and VIN as reference decoys",
    filename: "fullpage-vehicle-tax-reminder.pdf",
    text: "Vehicle Tax Reminder  \n\nHighways and Vehicle Licensing Authority Executive agency for vehicle registration and taxation · Northgate House, 4 Averill Close, Bournley, Midshire \n\nBN7 2QF \n\nEnquiries 0300 555 0142 · hvla.example/tax · Authority ref HVLA/RF9/2026 \n\nFO RM RF9 \n\nVEHICLE TAX REMINDER Renew your vehicle tax before it expires, or tell us the \n\nvehicle is off the road. \n\nHVLA — Vehicle tax remind er Remind er issued  0 4 Sep temb er 20 26 · Reg. mark LR69 KHM \n\nR EG IS T R A T IO N  D O C U MEN T  R EF ER EN C E \n\n4471 8823 0519 \n\nC A S E R EF ER EN C E \n\nHVLA-2026-661452 \n\nR EG IS T R A T IO N  MA R K \n\nLR69 KHM \n\nVEH IC L E  ID EN T IF IC A T IO N  N U MB ER  ( VIN ) \n\nWVWZZZ1KZLW238841 \n\nMA K E \n\nVoxholt \n\nMO D EL \n\nCallisto 1.5 TSI Hatchback \n\nC O L O U R \n\nStorm Blue \n\nF U EL  T YP E \n\nPetrol \n\nEN G IN E C A P A C IT Y \n\n1498 cc \n\nC O 2 EMIS S IO N S \n\n128 g/km \n\nT A X A T IO N  C L A S S \n\nPrivate/Light Goods (PLG) \n\nD A T E O F  F IR S T  R EG IS T R A T IO N \n\n14 March 2019 \n\nR EG IS T ER ED  K EEP ER  S IN C E \n\n22 June 2021 \n\nC U R R EN T  T A X  EX P IR ES \n\n31 October 2026 \n\nMO T  EX P IR ES \n\n19 November 2026 \n\nR EMIN D ER  IS S U ED \n\n04 September 2026 \n\nR EN EW A L  W IN D O W  O P EN S \n\n01 October 2026 \n\nRATE FOR THIS VEHICLE — TICK ONE AND PAY BY THE METHODS OVERLEAF \n\nPAYMENT OPTION AMOUNT \n\n☐ Single 12 month payment £180.00 \n\n☐ Single 6 month payment £99.00 \n\n☐ Monthly by Direct Debit (£15.75 × 12, total £189.00) £15.75 \n\nIf this vehicle is not taxed, or declared off the road (SORN), by the expiry date shown above, a fixed penalty of £80 may be issued, rising to prosecution and a fine of up to £1,000 \n\non conviction. A first reminder for the previous licence period was issued on 04 August 2025. \n\nIf you have already taxed this vehicle, by any method, since 28 August 2026, please disregard this reminder — no further action is needed. If you begin a Direct Debit today, the first collection will be taken on or after 01 November 2026. \n\nFOR OFFICIAL USE ONLY \n\n✓ MOT status checked — valid, expiry on record 19 November 2026 \n\n✓ Continuous insurance (database) checked 02 September 2026 — record shown valid to 14 January 2027 \n\nDatabase last updated 02 September 2026, 08:41 Checked by (initials) Case reference HVLA-2026-661452 \n\nWhy you have been sent this reminder. Our records show the vehicle described above is due to \n\nrun out of tax. This reminder is sent as a courtesy roughly five weeks before the expiry date; failure to receive it does not remove the legal duty to keep the vehicle taxed or declared SORN, \n\nand no further reminder is sent for this licence period if this one is not acted on. \n\nHow to pay. Renew online at hvla.example/tax using the registration document reference shown in the boxed strip above, by telephone on 0300 555 0142, or in person at a participating \n\nPost Office branch, quoting the registration mark and the registration document reference. You will need a valid MOT test certificate covering the start of the new tax period and evidence of \n\ninsurance; these are checked automatically against the database where a record exists. \n\nStatutory Off Road Notification (SORN). If the vehicle is not being kept or used on a public \n\nroad, you must declare SORN instead of renewing. A SORN declared before the expiry date shown above takes effect from that date; one declared after expiry takes effect immediately and does not refund any unused full months already paid on the previous licence. \n\nChange of keeper or address. If you have sold, transferred or scrapped this vehicle, or your name or address has changed, tell us straight away using the registration certificate, since this \n\nreminder and any refund are otherwise sent to the last keeper we hold on record. \n\nRefunds. If the vehicle is taxed and is then declared SORN, sold, scrapped, exported, or the \n\ntaxation class changes, any full remaining months of the 12 month rate are refunded \n\nautomatically to the registered keeper; the 6 month rate and the Direct Debit surcharge are not \n\nrefunded in full for part-used months. \n\nDirect Debit. Choosing monthly, 6 monthly or annual Direct Debit continues automatically at \n\nrenewal using the rate then in force, unless you cancel it or declare SORN. The first monthly collection date shown above is indicative and may fall up to five working days later. \n\nChecking this reminder. To check the record behind this reminder, contact us using the registration mark and the registration document reference. Do not rely on the registration mark alone: it appears on other correspondence, including the previous reminder dated 04 August \n\n2025 and the registration certificate issued 20 March 2019, which are not renewal documents. \n\nComplaints and appeals. If you believe this reminder was sent in error, write to the Authority's \n\ntax correspondence unit at the address above within 21 days, quoting the case reference. An MOT or insurance record shown as not found above can be corrected by contacting the relevant \n\ndatabase operator directly; the Authority does not hold those records itself. \n\nData protection. Vehicle and keeper details are processed under the Authority's statutory \n\nfunction of maintaining the vehicle register. Data protection registration ZC7729114. Records relating to this licence period are retained for six years after expiry. \n\nCOUN TE RFOIL  —  DE TA CH  A N D K E E P  FOR Y OUR RE CORDS \n\nHVLA RE G I S T RA T I O N  M A RK \n\nLR69 KHM \n\nRE G I S T RA T I O N  D O C U M E N T \n\nRE F E RE N C E \n\n4471 8823 0519 \n\nC U RRE N T  T A X  E X P I RE S \n\n31 October 2026 \n\nA M O U N T  D U E  ( 12  M O N T H S ) \n\n£180.00 \n\nForm RF9 · printed 04/09/2026 · HVLA\n",
    expected: {
    dates: ["2026-10-31"],
    provider: "Highways and Vehicle Licensing Authority",
    reference: "4471 8823 0519",
    dateRoles: [
      { date: "2026-10-31", role: "renewal" },
    ],
    subtype: "Vehicle tax reminder",
    costMinor: 18000,
    currency: "GBP",
    recurrenceMonths: 12,
    scheduleKind: "renewal",
    },
  },
  {
    // Ground-truth notes:
    // - dates/dateRoles carry only the payment due date, 30/06/2026. Everything else datelike is deliberately excluded: the billing period (01/03/2026-31/05/2026, printed prominently in the key-facts box), the bill/run date (09/06/2026), the direct debit collection date (23/06/2026), the tariff-change date (01/04/2027), the payment-received date (20/05/2026), the eight meter-reading dates in the readings table (28/05/24 through 24/02/26, the only dd/mm/yy strings on the page), the twelve month/year labels on the consumption chart's x-axis (Jun 2025-May 2026), and the small-print layout-revision stamp (03/2019).
    // - provider is the legal name from the small print, 'Bourne Valley Water and Sewerage plc' (with company number 04217743), not the trading name 'ClearBourne Water' used everywhere else on the page including the masthead and footer.
    // - reference is the customer account number 8847 2210 55, printed in the header run-box, up the sideways left-margin document code on both pages, and again on the payment-advice stub -- not the meter serial number M-2291487.
    // - costMinor is the amount now due, £163.37 (16337p), shown in the boxed 'amount now due' banner, the balance block and the payment stub. It is not the total charges for the period (£159.31, itemised in the charge table and repeated as the first line of the balance block), not the balance brought forward (£14.06), not the payment received (-£10.00), and not the estimated annual charge quoted under the consumption chart for 2027/28 (£654.90). Amount now due = 159.31 + 14.06 - 10.00 = 163.37.
    // - scheduleKind is omitted: this is a bill, not a renewal or a service record. recurrenceMonths is also omitted; the quarterly billing cycle is a billing frequency, not a stated renewal/service interval.
    name: "water bill, meter readings table as the date trap",
    filename: "fullpage-water-bill.pdf",
    text: "ClearBourne Water — Water and Wastewater Bill  \n\nClearBourne Water Water and wastewater services for the Bourne Valley region \n\nBILL DATE 09/06/2026 \n\nACCOUNT 8847 2210 55 \n\nTARIFF CODE WV-M-04 \n\nPAGE 1 OF 2 \n\nMr J Whitcombe \n\n12 Silverdale Close \n\nMarchford \n\nWexbridge \n\nWX9 2QP \n\nBilling period 01/03/2026 – 31/05/2026 \n\nDays in period 91 \n\nMeter serial M-2291487 \n\nSupply type Metered, combined \n\nDirect debit Collecting 23/06/2026 \n\nAMOUNT NOW DUE \n\nPayment due by 30/06/2026 £163.37 \n\nMETER READINGS ON YOUR ACCOUNT \n\nREADING DATE READING (M³) TYPE \n\n28/05/24 3812 A – actual read \n\n27/08/24 3855 E – estimated \n\n26/11/24 3901 A – actual read \n\n25/02/25 3939 E – estimated \n\n27/05/25 3986 A – actual read \n\n26/08/25 4021 E – estimated \n\n25/11/25 4067 A – actual read \n\n24/02/26 4102 E – estimated \n\nA meter reading dated 24/02/26 was carried forward to open this period; the closing read of 4137 used to calculate the charges below is an estimate, based on your average daily use, pending our next visit. \n\nCHARGES FOR THIS PERIOD (01/03/2026 – 31/05/2026) \n\nCHARGE QUANTITY RATE AMOUNT \n\nWater standing charge 91 days 21.23p/day £19.32 \n\nWater supply, volumetric 35 m³ £1.5842/m³ £55.45 \n\nWastewater standing charge 91 days 25.13p/day £22.87 \n\nWastewater, volumetric 35 m³ £1.7621/m³ £61.67 \n\nTotal charges for this period £159.31 \n\nTotal charges for this period £159.31 \n\nBalance brought forward £14.06 \n\nPayment received 20/05/2026, thank you −£10.00 \n\nAmount now due £163.37 \n\nAccount 8847 2210 55 \n\nName Mr J Whitcombe \n\nAmount due £163.37 \n\nPay by 30/06/2026 \n\n| || ||| | |||| | ||| || | |||| | \n\nF O R M   W B 2 - Q T L Y       A C C T   8 8 4 7   2 2 1 0   5 5       R U N   0 4 2 6 - 1 1 4       P R I N T E D   A T   D E P O T   7       F O R M   W B 2 - Q T L Y       A C C T   8 8 4 7   2 2 1 0   5 5 \n\nClearBourne Water · WB2-QTLY · run 0426-114 Page 1 of 2\n\nClearBourne Water Water and wastewater services for the Bourne Valley region \n\nBILL DATE 09/06/2026 \n\nACCOUNT 8847 2210 55 \n\nTARIFF CODE WV-M-04 \n\nPAGE 2 OF 2 \n\nYOUR CONSUMPTION HISTORY \n\n31 29 \n\n27 \n\n33 \n\n38 \n\n44 47 \n\n45 \n\n36 \n\n32 30 \n\n35 \n\nJun 2025 Jul 2025 Aug 2025 Sep 2025 Oct 2025 Nov 2025 Dec 2025 Jan 2026 Feb 2026 Mar 2026 Apr 2026 May 2026 \n\nMonthly consumption in cubic metres, estimated for months without an actual meter read. Based on this trend, we estimate your annual charge for 2027/28 at £654.90 if your usage and current tariffs remain unchanged. \n\nHOW TO PAY \n\nDirect debit \n\nAlready set up on this account. \n\nWe will collect £163.37 on \n\n23/06/2026. No action needed. \n\nOnline or by phone \n\nPay at \n\npay.clearbournewater.example or \n\ncall 0345 604 8822, quoting \n\naccount 8847 2210 55. \n\nBy post \n\nSend a cheque payable to \n\n“ClearBourne Water” with the \n\npayment advice from page 1 to the \n\naddress in the small print. \n\nYOUR TARIFF EXPLAINED \n\nYour charges are made up of a fixed standing charge, which covers the cost of maintaining pipes and connections regardless \n\nof use, and a volumetric charge for each cubic metre of water you use and return as wastewater. Current unit rates for tariff \n\nWV-M-04 are shown below. New unit rates are published each spring and take effect from 1 April; your next tariff change \n\ntakes effect on 01/04/2027 and we will write to you separately beforehand. \n\nCHARGE STANDING CHARGE UNIT RATE \n\nWater supply 21.23p/day £1.5842/m³ \n\nWastewater removal 25.13p/day £1.7621/m³ \n\nClearBourne Water is a trading name of Bourne Valley Water and \n\nSewerage plc, registered in England and Wales, company number \n\n04217743, registered office Mill Race House, 4 Aldergate Business Park, \n\nWexbridge, WX3 9TL. Bourne Valley Water and Sewerage plc is appointed \n\nas the water and sewerage undertaker for the Bourne Valley area under \n\nthe Water Industry Act 1991. \n\nIf your account falls into arrears we may recover the debt through the \n\ncounty court, and in some circumstances this may affect your credit \n\nrecord. If you are struggling to pay, contact us before the due date; we \n\noffer WaterSure and payment matching schemes to eligible customers, \n\nand can arrange an alternative payment plan. \n\nYour bill is calculated using either an actual meter reading or an estimate \n\nbased on your recent history, as shown against each reading above. If a \n\nreading is estimated, we will correct your account once we obtain an \n\nactual reading, which may result in a higher or lower charge on a future \n\nbill. \n\nThis bill and any dispute arising from it are governed by our Charges \n\nScheme and Codes of Practice, copies of which are available on request \n\nor at clearbournewater.example/charges. If you remain unhappy with \n\nhow we have handled a complaint, you may refer it to the Consumer \n\nCouncil for Water (CCW), free of charge. Ofwat is the economic regulator \n\nfor the water industry in England and Wales. \n\nLeaflet ref. WB2/BILL/2026 · layout revision 03/2019 · printed on recycled \n\nstock. Calls to 0345 numbers cost no more than calls to standard \n\ngeographic numbers. \n\nF O R M   W B 2 - Q T L Y       A C C T   8 8 4 7   2 2 1 0   5 5       R U N   0 4 2 6 - 1 1 4       P R I N T E D   A T   D E P O T   7       F O R M   W B 2 - Q T L Y       A C C T   8 8 4 7   2 2 1 0   5 5 \n\nClearBourne Water · WB2-QTLY · run 0426-114 Page 2 of 2\n",
    expected: {
    dates: ["2026-06-30"],
    provider: "Bourne Valley Water and Sewerage plc",
    reference: "8847 2210 55",
    dateRoles: [
      { date: "2026-06-30", role: "due" },
    ],
    subtype: "Water bill",
    costMinor: 16337,
    currency: "GBP",
    },
  },
  {
    // Ground-truth notes:
    // - The registration strip prints four differently-purposed numbers in identical styling: the installer's scheme membership number (NFGS-INST-04471), the building regulations compliance certificate number (BR-2026-118824), the guarantee certificate number (IBG-2026-337215, printed third), and the scheme's own policy number (GPS-0417-2261). Only the guarantee certificate number is 'reference' — it is what a claim must quote, as the guarantee wording itself states. Provider is the scheme (National Fenestration Guarantee Scheme Ltd), which issues and insures the guarantee, not Hallcroft Windows & Conservatories Ltd, the installer, whose name is larger (10pt vs the scheme's body-text size), appears in the address panel, and recurs through the guarantee wording more often than the scheme's own name — but the guarantee is with the scheme, and the wording is explicit that a claim goes to the scheme, not the installer. dates deliberately excludes: the date the work was completed (17 March 2026, three days after the installation date and easily confused with it), the date the compliance notification was lodged with the local authority (2 April 2026), the date this certificate was issued (9 April 2026), the installer's scheme registration expiry (30 June 2027), the date the installer first joined the scheme (12 May 2011), the guarantee wording's own revision date (1 January 2024), and the scheme's incorporation date (3 February 2009) — none of which a user tracking this guarantee would want. The ten-year term is stated in the guarantee wording only as 'ten years from the date of installation', never restated as a literal date there; the literal expiry date 14 March 2036 is findable only in the registration strip's second row, alongside the installation date, which is why both survive as answers despite the prose being vague. No price, fee or premium appears anywhere on the document, so costMinor and currency are omitted. The guarantee runs for a fixed ten-year term and is not serviced or renewed, so recurrenceMonths and scheduleKind are both omitted.
    name: "window installation guarantee, four registration-strip numbers and the answer is third",
    filename: "fullpage-window-installation-guarantee.pdf",
    text: "Certificate of Compliance and Insurance-Backed Guarantee — IBG-2026-337215  \n\nNFGS National Fenestration Guarantee Scheme Competent person scheme for the self-certification of replacement window and door \n\ninstallations against the Building Regulations \n\nDate of issue 9 April 2026 \n\nScheme House, 4 Brindley Court \n\nWolverstone WV3 7DP · 0345 604 7721 \n\nINSTALLER SCHEME MEMBERSHIP \n\nNO. \n\nNFGS-INST-04471 \n\nBUILDING REGULATIONS \n\nCOMPLIANCE CERTIFICATE NO. \n\nBR-2026-118824 \n\nGUARANTEE CERTIFICATE NO. \n\nIBG-2026-337215 \n\nSCHEME POLICY NO. \n\nGPS-0417-2261 \n\nDate of installation 14 March 2026 Guarantee expires 14 March 2036 \n\nCertificate of Compliance and Insurance-Backed Guarantee Issued by the National Fenestration Guarantee Scheme Ltd following notification of the work described below under the competent person self-certification \n\nprovisions of the Building Regulations 2010 (as amended). \n\nGUARANTEE TYPE: INSURANCE-BACKED  GUARANTEE \n\nPROPERTY OWNER Mr and Mrs D. Okonkwo-Hale \n\nINSTALLATION ADDRESS 14 Aldermoor Close, Pemberton, Bramholt, BR6 3JX \n\nWORK CARRIED OUT Supply and fit of 9 no. uPVC double-glazed casement windows and 1 no. composite front door \n\nDATE OF INSTALLATION 14 March 2026 \n\nDATE WORK COMPLETED 17 March 2026 \n\nINSTALLER HALLCROFT WINDOWS & CONSERVATORIES LTD \n\nINSTALLER ADDRESS Unit 3, Foundry Trading Estate, Bramholt, BR2 9LQ · 01902 445 118 \n\nThis certificate confirms that the installation described above, carried out by Hallcroft Windows & Conservatories Ltd, has been notified to Bramholt Borough Council under the competent person self-certification provisions of the Building Regulations 2010 (as amended), by virtue of the installer’s registration with the National Fenestration Guarantee Scheme. The notification was lodged with the local authority on 2 April 2026 under local authority reference LA-BC-2026-08841. No further \n\nbuilding control inspection or completion certificate is required from the local authority in respect of this work. \n\nIn addition to confirming compliance, National Fenestration Guarantee Scheme Ltd, of Scheme House, 4 Brindley Court, Wolverstone WV3 7DP, guarantees to the property owner named above that the workmanship carried out by Hallcroft Windows & Conservatories Ltd, and the integrity of the sealed glazing units and hardware fitted as part of that work, will re- main free from defect for a period of ten years from the date of installation. This guarantee is insurance-backed: should Hallcroft Windows & Conservatories Ltd cease trading, be dissolved, or otherwise become unable to meet the terms of this \n\nguarantee, the Scheme will itself meet the reasonable cost of remedying any defect notified and accepted as a valid claim dur- ing the remainder of the guarantee term, underwritten on the Scheme’s behalf by Castlemere General Insurance plc, author- ised by the Prudential Regulation Authority and regulated by the Financial Conduct Authority. \n\nA claim under this guarantee must be made in writing to National Fenestration Guarantee Scheme Ltd at the address above, quoting the guarantee certificate number shown in the panel above, before the guarantee expires. The Scheme will not accept a claim made verbally, or made without that number, or made by reference to the building regulations compliance certificate number or the scheme policy number shown alongside it, which are recorded for different purposes. This guarantee does not \n\ncover damage arising from accident, misuse, or structural movement of the building; alteration or repair carried out by any- one other than Hallcroft Windows & Conservatories Ltd or a contractor approved in writing by the Scheme; or condensation occurring on room-facing surfaces, which is a ventilation matter and not a defect in the installation. \n\nThis guarantee is not personal to the property owner named above. It transfers automatically to a subsequent owner of the property on sale, without charge and without the need to notify the Scheme, provided this certificate is passed to the new owner and kept with the property’s papers. A solicitor acting on a sale or remortgage of the property may rely on this certific- ate as evidence both of compliance with the Building Regulations and of the guarantee remaining in place. \n\nHallcroft Windows & Conservatories Ltd is registered with the National Fenestration Guarantee Scheme under membership number NFGS-INST-04471, first registered with the Scheme on 12 May 2011, with that registration currently valid until 30 June 2027. Registration is reviewed periodically by the Scheme and may be withdrawn if an installer’s work does not continue to meet the required standard; withdrawal does not affect the validity of a guarantee already issued for work completed while an installer was registered. \n\nA complaint about the standard of the installation should be raised in the first instance with Hallcroft Windows & \n\nConservatories Ltd. If it is not resolved to your satisfaction you may refer it to the Glazing Industry Ombudsman Service. Information you provide is processed by National Fenestration Guarantee Scheme Ltd in accordance with its privacy notice, available at nfgs.example.org/privacy. This certificate should be kept in a safe place, as it is your only evidence that this com- pliance notification and this guarantee exist; the Scheme cannot issue a duplicate quoting a different guarantee certificate number. \n\nNational Fenestration Guarantee Scheme Ltd, Scheme House, 4 Brindley Court, Wolverstone WV3 7DP. Registered in England and Wales, company number 04471882, \n\nincorporated 3 February 2009. Guarantee wording edition GT-4, revised 1 January 2024. © 2026 National Fenestration Guarantee Scheme Ltd.\n",
    expected: {
    dates: ["2026-03-14","2036-03-14"],
    provider: "National Fenestration Guarantee Scheme Ltd",
    reference: "IBG-2026-337215",
    dateRoles: [
      { date: "2026-03-14", role: "start" },
      { date: "2036-03-14", role: "expiry" },
    ],
    subtype: "Insurance-backed guarantee",
    },
  },
];
