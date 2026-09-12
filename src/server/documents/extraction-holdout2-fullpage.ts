// GENERATED FILE — do not edit by hand.
//
// A HOLD-OUT set: full-page documents written after the extractor was
// tuned, by someone who had not read `scripts/corpus/sources/` (or, for a
// later hold-out, any earlier hold-out either -- `holdout2` is not the first).
// They are the generalisation measurement, so they are deliberately NOT part
// of `EXTRACTION_CORPUS`: nothing tuning against the tuning set pulls them
// in, and tuning against a hold-out would destroy the only unseen number the
// project has for it.
//
// Score with `npm run eval:holdout -- --holdout2`. Regenerate with:
//
//   node scripts/corpus/generate.mjs --dir holdout2
//
// Each document was written as HTML, rendered to PDF with Playwright at A4,
// and parsed with the real Tika using the request in `tika.ts`. The `text`
// below is Tika's output byte for byte — escapes, flattened table columns,
// repeated page headers and all. That is the point: the fixture is what
// production actually sees, not a tidied version of it.
//
// The originals live in `scripts/corpus/holdout2/`. Never edit
// `text` here; edit the HTML and regenerate, so the fixture and the document
// it came from cannot drift apart.

import type { CorpusDocument } from "./extraction-corpus";

export const EXTRACTION_HOLDOUT2_FULLPAGE: CorpusDocument[] = [
  {
    // Ground-truth notes:
    // - dates: agreement runs 1 June 2025 to 31 May 2028. Seven other printed dates are deliberately not declared: the statement date, the last service date, four monthly payment-history dates, a previous unrelated vehicle's return date, and a terms revision stamp.
    // - provider is Wraxall Vehicle Finance plc, stated plainly in the page's own text to be who provides the lease and the vehicle. DriveEasy Leasing Brokers Ltd, named in the letterhead, is described in the small print as an FCA-regulated credit broker acting on commission, not the lessor -- the same broker-versus-underwriter distinction the owner drew for a motor policy (#989).
    // - reference is the agreement number, not the vehicle registration or a previous unrelated vehicle's registration.
    // - costMinor is the monthly rental, the only amount that is plainly the cost of the thing; the per-mile excess charge is a penalty rate, and the payment-history amounts repeat the same rental.
    // - subtype: 'Lease' qualified by 'Motor'.
    // - recurrenceMonths is not declared: the rental is described as monthly in words, not in a printed digit count.
    // - scheduleKind is not declared: neither dateRole is 'renewal' or 'service'.
    name: "car lease statement, the broker's name is bigger than the finance company's",
    filename: "fullpage-car-lease-statement.pdf",
    text: "Lease statement WVF-PCH-220154  \n\nDriveEasy Leasing Personal contract hire brokers · 0800 552 7734 · www.driveeasyleasing.example \n\nAnnual lease statement \n\nLessee \n\nMrs Angharad Vaughan \n\n9 Cedar Grove, Aldreth Bay, Cravenshire CV3 2NF \n\nAgreement WVF-PCH-220154 \n\nVehicle registration LV73 KFM \n\nStatement date 1 September 2026 Statement period covers year 2 \n\nYOUR VEHICLE \n\nVehicle Corvallen Estrix 1.6 hybrid estate, registration LV73 KFM \n\nAgreement start 1 June 2025 \n\nAgreement end 31 May 2028 \n\nContract mileage 10,000 miles a year, 30,000 over the full term \n\nMileage recorded at last service 18,442 miles, service dated 4 June 2026 \n\nMONTHLY  RENTAL \n\n£329.00 \n\nPAYMENT HISTORY,  YEAR 2 \n\nDue date Status Amount \n\n01/06/2026 Paid 01/06/2026 329.00 \n\n01/07/2026 Paid 02/07/2026 329.00 \n\n01/08/2026 Paid 01/08/2026 329.00 \n\n01/09/2026 Due 329.00 \n\nThis agreement runs for 36 months from 1 June 2025 to 31 May 2028, after which the vehicle must be returned to Wraxall Vehicle Finance plc; this \n\nis a hire agreement and you do not own the vehicle at any point. Excess mileage over the 30,000-mile term allowance is charged at £0.08 per mile \n\nat return. Your previous vehicle under a separate agreement (reg LV19 MPR) was returned on 28 May 2025 with no excess mileage or damage \n\ncharges. \n\nDriveEasy Leasing  Brokers Ltd , registered  in England  and  Wales No. 08814401, is an FCA-regulated  credit broker, firm reference number 662017, and  arranges this \n\nagreement on commission. The lease itself, and  the vehicle, are provided  by Wraxall Vehicle Finance plc, registered  in England  and  Wales No. 02841170, registered \n\noffice Wraxall House, 6 Meridian Way, Larchgate, Wexbridge WX9 3QF, authorised  and  regulated  by the Financial Conduct Authority, firm reference number 204471. \n\nTerms last revised  1 April 2025. \n\nWraxall Vehicle Finance plc · Agreement WVF-PCH-220154 Page 1 of 1\n",
    expected: {
    dates: ["2025-06-01","2028-05-31"],
    provider: "Wraxall Vehicle Finance plc",
    reference: "WVF-PCH-220154",
    dateRoles: [
      { date: "2025-06-01", role: "start" },
      { date: "2028-05-31", role: "expiry" },
    ],
    subtype: {"kinds":["Lease"],"qualifiers":["Motor"]},
    costMinor: 32900,
    currency: "GBP",
    },
  },
  {
    // Ground-truth notes:
    // - dates: installed 12 May 2026, the 25-year guarantee runs to 12 May 2051. Two other printed dates are deliberately not declared: the certificate issue date (19 May 2026, a week after installation and after the guarantee period already started) and the cavity survey date (28 Apr 2026). The superseded wording edition (6 Mar 2022) and the current edition date (1 Jan 2026) are print-run stamps, not dates about this job, and are also not declared.
    // - provider is Bassington Energy Solutions Ltd, named only in the small print as the entity that 'is issued by' this guarantee -- 'WarmCore Insulation', printed large in the letterhead and everywhere else on the page, is stated in that same small print to be only its trading name, the same distinction the owner drew for a broker versus an underwriter (#989).
    // - reference is the guarantee number WC-GTE-08823, not the job reference (WCI-2026-4471) or the insurance-backed scheme reference (GBW-771049).
    // - costMinor is the £2,340.00 contract price for the installation itself, the only amount on the page with a currency symbol that is plainly the cost of the thing.
    // - subtype: 'Guarantee' (the taxonomy group whose synonyms include 'Insurance-backed guarantee', matching the printed scheme) qualified by 'Building work', covering installation and workmanship.
    // - scheduleKind is not declared: neither dateRole is 'renewal' or 'service'.
    name: "cavity wall insulation guarantee, the trading name on the letterhead is not who guarantees it",
    filename: "fullpage-cavity-wall-insulation-guarantee.pdf",
    text: "Guarantee certificate WC-GTE-08823  \n\nWarmCore Insulation Cavity wall & loft insulation specialists · est. 2009 · www.warmcoreinsulation.example \n\nGUARANTEE CERTIFICATE Cavity wall insulation, installed to CIGA / BBA technical requirements \n\nProperty owner \n\nMr David Okafor 19 Fernhill Close, Aldreth Bay, Cravenshire CV6 4RP \n\nGuarantee number WC- GTE- 08823 \n\nJob reference WCI-2026-4471 Date of installation 12 May 2026 \n\nCertificate issued 19 May 2026 \n\nWHAT  THIS GUARANTEE COVERS \n\nThis guarantee covers defects in the cavity wall insulation materials and workmanship described below, installed at the address shown, for a period of 25 years from the date of installation. It does not cover pre-existing structural defects, penetrating damp not caused by the insulation, or damage arising from alterations carried out after installation without the installer's written agreement. \n\nInsulation material Blown mineral wool, EWI-certified batch 2026/0512 \n\nCavity width surveyed 75mm, confirmed by borescope survey 28 April 2026 \n\nGuarantee period 25 years, from 12 May 2026 to 12 May 2051 \n\nContract price £2,340.00, paid in full 12 May 2026 \n\nInsurance-backed guarantee scheme Registered with GuardBuild Warranty Ltd, scheme ref GBW-771049 \n\nMAKING  A CLAIM \n\nTo make a claim under this guarantee, contact the installer in the first instance using the details in the small print below. If the installer has ceased trading, the insurance-backed guarantee scheme referenced above will handle a valid claim instead; a separate policy document was issued for that scheme on 19 May 2026 and should be kept with this certificate. \n\n\"WarmCore Insulation\" is a trading name of Bassington Energy Solutions Ltd, registered in England and Wales No. 06612940, registered office 4 Colliery Road, \n\nBassington, Cravenshire CV11 3EF. This guarantee is issued by Bassington Energy Solutions Ltd and is not transferable to a subsequent owner of the property \n\nwithout written notice to the installer within 3 months of the change of ownership. Previous guarantee wording, edition dated 6 March 2022, is superseded by this \n\nedition, dated 1 January 2026. VAT registration number GB 442 1187 30. \n\nCIGA APPROVED\n",
    expected: {
    dates: ["2026-05-12","2051-05-12"],
    provider: "Bassington Energy Solutions Ltd",
    reference: "WC-GTE-08823",
    dateRoles: [
      { date: "2026-05-12", role: "issued" },
      { date: "2051-05-12", role: "expiry" },
    ],
    subtype: {"kinds":["Guarantee"],"qualifiers":["Building work"]},
    costMinor: 234000,
    currency: "GBP",
    },
  },
  {
    // Ground-truth notes:
    // - dates: swept 1 September 2026, next sweep due 1 March 2027 (a six-monthly cycle). Five other printed dates are deliberately not declared: the previous sweep (3 Mar 2026), the appliance's installation date (14 Oct 2019), the installer's last service visit (18 Nov 2025, explicitly not a sweep), the trade membership's current year (1 Jan 2026 to 31 Dec 2026), and the insurance renewal (1 Jun 2026).
    // - provider is 'CSS', the only name the trader ever gives, used as the brand mark and again in 'CSS is a member of the Guild of Master Sweeps' -- the Guild itself is a real-sounding trade body, not the provider.
    // - reference is the certificate number CSS-0417.
    // - costMinor is the £65.00 fee for this visit; the £2 million figure is a public liability insurance limit, not a cost.
    // - subtype: 'Certificate' (matching the printed 'Certificate of chimney sweeping') qualified by 'Chimney'.
    // - scheduleKind is 'service': the earlier dateRole is 'service', for the sweep actually carried out.
    name: "chimney sweep certificate, the trader is only ever three letters",
    filename: "fullpage-chimney-sweep-certificate.pdf",
    text: "Chimney sweep certificate CSS-0417  \n\nCSS Chimney and flue sweeping, servicing wood and multi-fuel appliances \n\nCertificate of chimney sweeping \n\nProperty \n\nMr Huw Bowen \n\nRose Cottage, Marsh Lane, Fenmouth, Cravenshire CV2 4RD \n\nCertificate CSS-0417 \n\nDate swept 1 September 2026 \n\nPrevious sweep 3 March 2026 \n\nNext sweep due 1 March 2027 \n\nAPPLIANCE DETAILS \n\nItem Detail \n\nAppliance Freestanding multi-fuel stove, installed 14 October 2019 \n\nFlue type Twin-wall insulated, 150mm diameter \n\nFuel used Seasoned hardwood, occasional smokeless coal \n\nMethod used Rotary power sweep, full length, brushed from hearth \n\nSmoke test result Pass, no leaks detected at joints \n\nCarbon monoxide alarm checked Present and tested, battery replaced this visit \n\nSweeping frequency for a wood-burning appliance in regular use should be at least twice a year; this property is on a six-monthly cycle. The appliance was last serviced by its installer on 18 November 2025, which is a separate visit from a sweep and does not replace one. Fee charged for this visit: £65.00, paid by card on the day. \n\nCSS is a member of the Guild of Master Sweeps, membership number GMS-44712, renewed annually each January; the current membership runs from 1 January 2026 to 31 December 2026. Public liability insurance is held to £2 million, policy renewed 1 June 2026. This certificate confirms the condition found on the date swept only and is not a guarantee against chimney fires arising from later use of the appliance. \n\nSWEPT \n\nCSS · Certificate CSS-0417 Page 1 of 1\n",
    expected: {
    dates: ["2026-09-01","2027-03-01"],
    provider: "CSS",
    reference: "CSS-0417",
    dateRoles: [
      { date: "2026-09-01", role: "service" },
      { date: "2027-03-01", role: "due" },
    ],
    subtype: {"kinds":["Certificate"],"qualifiers":["Chimney"]},
    costMinor: 6500,
    currency: "GBP",
    scheduleKind: "service",
    },
  },
  {
    // Ground-truth notes:
    // - dates: invoice issued (and paid) 2 September 2026; the lesson-block credit expires 2 March 2027, six months later. Five other printed dates are deliberately not declared: the previous block's payment date (14 Mar 2026) and its use-by-date's actual use (3 Jun 2026), the practical test booking (20 Nov 2026), the recommended mock test date (6 Nov 2026), the price-increase date (1 Jan 2026), and the ADI certificate renewal dates (4 May 2024, running to 4 May 2028).
    // - provider is 'Pass2Drive', which never appears as ordinary text on the page -- the header signature and instructor line name only the individual instructor, C. Lewis -- and is findable solely inside the booking e-mail address and the website address.
    // - reference is the invoice number PL-INV-2249, not the ADI badge number (449213) or the driving-association membership number (DIA-77420).
    // - costMinor is the £360.00 total paid for the block of ten lessons, not the £34 or £36 hourly rate mentioned in the small print.
    // - subtype: 'Course' (matching a paid block of lessons) qualified by 'Driving'.
    // - scheduleKind is not declared: neither dateRole is 'renewal' or 'service'.
    name: "driving lessons invoice, the instructor signs by hand and the business only lives in an e-mail address",
    filename: "fullpage-driving-lessons-invoice.pdf",
    text: "Driving lessons invoice PL-INV-2249  \n\nC. Lewis Approved Driving Instructor, ADI badge no. 449213 · bookings@pass2drive.co.uk · www.pass2drive.co.uk · 07700 900412 \n\nInvoice for driving lessons \n\nTo \n\nMiss Ffion Rhys \n\n3 Larchfield Crescent, Penbury, Cravenshire CV9 3TL \n\nInvoice PL-INV-2249 \n\nInvoice date 2 September 2026 \n\nPick-up point: Penbury High Street \n\nItem Amount \n\nBlock of 10 x 1-hour lessons, paid up front 360.00 \n\nTotal paid, received 2 September 2026 £360.00 \n\nThanks for booking a block of ten lessons. Lesson credits from this block must be used within 6 months, by 2 March 2027, \n\nafter which any unused credit is forfeited. Your last block, paid for on 14 March 2026, was used in full by 3 June 2026. Your \n\npractical test is currently booked for 20 November 2026 at Fenmouth test centre; a mock test is recommended around 6 \n\nNovember 2026. Please give at least 48 hours' notice to rearrange a lesson, or the lesson is charged in full. \n\nPrices last increased on 1 January 2026, from £34 to £36 an hour. I am a member of the Driving Instructors Association, membership number \n\nDIA-77420, and my Approved Driving Instructor certificate was last renewed on 4 May 2024 and runs until 4 May 2028. This invoice is a \n\nreceipt; no VAT is charged as I am not VAT registered.\n",
    expected: {
    dates: ["2026-09-02","2027-03-02"],
    provider: "Pass2Drive",
    reference: "PL-INV-2249",
    dateRoles: [
      { date: "2026-09-02", role: "issued" },
      { date: "2027-03-02", role: "expiry" },
    ],
    subtype: {"kinds":["Course"],"qualifiers":["Driving"]},
    costMinor: 36000,
    currency: "GBP",
    },
  },
  {
    // Ground-truth notes:
    // - dates: plan commenced 3 November 2024, certificate issued 10 November 2024, final instalment due 3 October 2026. Three other printed dates are deliberately not declared: the FCA's take-over of funeral plan regulation (29 Jul 2022, a regulatory milestone, not a date about this plan), and the two plan-document edition stamps (6 Jan 2026 and the superseded 2 Mar 2022).
    // - provider is Millstone Prepaid Services Ltd, named in the small print as who 'Evergreen Funeral Plans' -- printed large on the certificate and used throughout -- is a trading name of, and as who is FCA-authorised to provide the plan; the nominated funeral director (Fenmouth & District Funeral Service) and the independent trust holding the funds (Cravenshire Funeral Planning Trust) are both named on the page and are neither of them the provider.
    // - reference is the plan number EFP-0091234.
    // - costMinor is the £3,995.00 total plan price, fixed at today's prices, not the £166.46 monthly instalment amount.
    // - subtype: 'Plan' (matching the printed 'pre-paid funeral plan') qualified by 'Funeral'.
    // - scheduleKind is not declared: none of the three dateRoles is 'renewal' or 'service' -- a prepaid funeral plan does not renew.
    name: "funeral plan certificate, the trading name on the parchment is not who is FCA-authorised",
    filename: "fullpage-funeral-plan-certificate.pdf",
    text: "Evergreen Funeral Plans — certificate EFP-0091234  \n\nEvergreen Funeral Plans A pre-paid funeral plan, fixing today's cost against tomorrow's \n\nCERTIFICATE  OF  PLAN  OWNERSHIP \n\nPlan holder \n\nMrs Olwen Meredith \n\n16 Chapel Row, Bassington, Cravenshire CV11 5FT \n\nPlan number EFP-0091234 \n\nPlan commenced 3 November 2024 \n\nCertificate issued 10 November 2024 \n\nNominated director: Fenmouth & District Funeral Service \n\nPLAN DETAILS \n\nPlan type Simple Choice, unattended committal with optional service \n\nTotal plan price £3,995.00, fixed at today's prices \n\nPayment method 24 monthly instalments of £166.46 \n\nFinal instalment due 3 October 2026 \n\nFunds held by Cravenshire Funeral Planning Trust, an independent trust registered with the Funeral Planning Authority \n\nWHAT IS GUARANTEED \n\nOnce your plan is paid in full, the funeral director's services described in your plan documents are guaranteed at no further cost to your estate, however much prices rise before the plan is needed. Third-party costs such as a doctor's certification fee, a minister's fee or a burial plot are not fixed and are payable by your estate at the rate current when the funeral takes place. Your plan documents were last updated on 6 January 2026, replacing the edition dated 2 March 2022. \n\n\"Evergreen Funeral Plans\" is a trading name of Millstone Prepaid Services Ltd, registered in England and Wales No. 05712834, registered office 9 Millstone Yard, Bassington, Cravenshire CV11 2QE. Millstone Prepaid Services Ltd is authorised and regulated by the Financial Conduct Authority for the provision of funeral plan contracts, firm reference number 913204, following the transfer of funeral plan regulation to the FCA on 29 July 2022. This certificate is not a contract in itself; the plan terms and conditions, most recently issued 6 January 2026, form the whole agreement between you and Millstone Prepaid Services Ltd.\n",
    expected: {
    dates: ["2024-11-03","2024-11-10","2026-10-03"],
    provider: "Millstone Prepaid Services Ltd",
    reference: "EFP-0091234",
    dateRoles: [
      { date: "2024-11-03", role: "start" },
      { date: "2024-11-10", role: "issued" },
      { date: "2026-10-03", role: "due" },
    ],
    subtype: {"kinds":["Plan"],"qualifiers":["Funeral"]},
    costMinor: 399500,
    currency: "GBP",
    },
  },
  {
    // Ground-truth notes:
    // - dates: plan starts 6 April 2026 and renews 6 April 2027. Three other printed dates are deliberately not declared: a claim's treatment date (14 Jul 2026), the same claim's payment date (2 Aug 2026), and the benefit-limits review date (1 Jan 2026, unchanged from the previous year so not itself a plan date); the rules-booklet edition stamp (4 Sep 2024) is a print-run date.
    // - provider is Bramwell Friendly Society Ltd, named only in the small print as who 'FeelGood Cash Plan' -- printed large as the brand everywhere else on the page -- is a trading name of.
    // - reference is the membership number FGP-MEM-338420.
    // - costMinor is the £14.50 monthly premium, not any of the five annual benefit limits in the table.
    // - subtype: 'Plan' (matching the printed 'Cash Plan') qualified by 'Health'.
    // - scheduleKind is 'renewal': the later dateRole is 'renewal', and the page confirms the plan renews automatically each year.
    // - recurrenceMonths is 1: the plan is billed '1 month at a time', printed in digits.
    name: "health cash plan certificate, the friendly society only appears in the small print",
    filename: "fullpage-health-cash-plan-certificate.pdf",
    text: "FeelGood Cash Plan — membership certificate FGP-MEM-338420  \n\nFeelGood Cash Plan Everyday healthcare cover for you and your family \n\nMembership certificate \n\nMember \n\nMrs Sioned Pritchard \n\nMembership number FGP-MEM-338420 \n\nCover level: Family Plus \n\nPlan start 6 April 2026 \n\nRenewal date 6 April 2027 \n\nWhat you can claim back each year \n\nBenefit Annual limit \n\nDental treatment and check-ups £250 \n\nOptical, including eye tests £180 \n\nPhysiotherapy and osteopathy £400 \n\nConsultations and diagnostic tests £300 \n\nHealth screening (once every 2 years) £120 \n\nMONTHLY  PREMIUM \n\n£14.50 \n\nYour plan is billed 1 month at a time by direct debit and renews automatically each year on 6 April unless you cancel it. A claim for treatment \n\nreceived before 6 April 2026, when your plan began, cannot be paid. You made one claim in the plan's first year, for dental treatment received \n\non 14 July 2026, paid on 2 August 2026. \n\nFeelGood Cash Plan is a trading name of Bramwell Friendly Society Ltd, incorporated under the Friendly Societies Act 1992, registered number 6612FS, registered office 11 \n\nPriory Court, Larchgate, Wexbridge WX4 1RN, authorised by the Prudential Regulation Authority and regulated by the Financial Conduct Authority and the Prudential \n\nRegulation Authority, firm reference number 110493. Benefit limits were last reviewed on 1 January 2026 and are unchanged from the previous scheme year. Rules booklet \n\nedition dated 4 September 2024. \n\nBramwell Friendly Society Ltd · Membership FGP-MEM-338420 · Page 1 of 1\n",
    expected: {
    dates: ["2026-04-06","2027-04-06"],
    provider: "Bramwell Friendly Society Ltd",
    reference: "FGP-MEM-338420",
    dateRoles: [
      { date: "2026-04-06", role: "start" },
      { date: "2027-04-06", role: "renewal" },
    ],
    subtype: {"kinds":["Plan"],"qualifiers":["Health"]},
    costMinor: 1450,
    currency: "GBP",
    recurrenceMonths: 1,
    scheduleKind: "renewal",
    },
  },
  {
    // Ground-truth notes:
    // - dates: the licence is issued 14 January 2026 and its period runs to 10 January 2027 (the 'Period of this licence' field). Six other printed dates are deliberately not declared: the superseded licence's issue date (12 Jan 2025), the previous licence's end date (13 Jan 2026, one day before this one starts), the park rules revision dates (6 Nov 2025 and 14 Feb 2023), the fire risk assessment (3 Sep 2025), the electrical bollard inspection (18 Oct 2025), the park insurance renewal (1 Oct 2025), the gas safety check (29 Aug 2025), the council site licence renewal (1 Apr 2024), the pitch fee due date (1 Mar 2026, a payment deadline not a licence date), the unit's original siting date (22 Apr 2019), and the wording edition date (3 Jul 2024). provider is the park operator that issued the licence, not the council that issued the underlying site licence referenced in the subtitle. reference is the licence number FSH-0412, not the pitch number (412), the council licence ref (CDC/SL/00417), or any of the compliance-table reference codes. costMinor is the annual pitch fee of £4,150.00, printed with a currency symbol as the cost of the thing itself.
    // - subtype is a set of kinds/qualifiers naming groups in src/server/documents/subtype-taxonomy.json, per the owner's ruling (#989): 'Licence' matches the printed 'Pitch site licence' title directly; no qualifier group in the taxonomy fits a holiday-park pitch closely enough to declare one, so qualifiers is omitted.
    // - scheduleKind is not declared: neither dateRole is 'renewal' or 'service', so nothing is derived for it to match.
    name: "holiday lodge pitch licence, the reply-by stamp and season dates are not the licence period",
    filename: "fullpage-holiday-lodge-site-licence.pdf",
    text: "Site licence renewal — pitch FSH-0412  \n\n✆ \n\nFENWATER SHORES HOLIDAY PARK LTD Fenwater Lane, Marsh Cove, Aldreth Bay, Cravenshire CV31 8QT · 01924 552 301 \n\nPITCH SITE LICENCE \n\nIssued under the park's site licence from Cravenshire District Council, licence ref CDC/SL/00417 \n\nLicence holder \n\nMr Aled Fenner & Mrs Bronwen Fenner \n\n14 Sycamore Rise, Penbury, Cravenshire CV9 2LR \n\nLicence reference FSH-0412 \n\nPitch number 412, Willow Row \n\nIssued 14 January 2026 \n\nSuperseding licence dated 12 January 2025 \n\nPERIOD OF  THIS LICENCE \n\nLicence period 14 January 2026 to 10 January 2027, subject to the park's operating season \n\nPark operating season 1 March to 10 January each year; the park is closed to occupation between 11 January and \n\nthe last day of February \n\nStatic unit ABI Fenwater 38x12 holiday lodge, plate number AL-2019-3307, sited since 22 April 2019 \n\nAnnual pitch fee £4,150.00, due in full by 1 March 2026 or by the instalment plan overleaf \n\nThis licence permits the holder to keep the static unit described above on pitch 412 for holiday purposes only during the period shown, in \n\naccordance with the park rules dated 6 November 2025 and the written statement supplied on first occupation. It is not a tenancy and \n\nconfers no right of permanent residence. \n\nCOMPLIANCE RECORD REFERRED TO IN  THIS LICENCE \n\nItem Date Reference \n\nPark fire risk assessment 3 September 2025 FRA-2025-09 \n\nElectrical hook-up bollard inspection, Willow Row 18 October 2025 ELEC-WR-25 \n\nPark public liability insurance renewed 1 October 2025 PLI-771204 \n\nGas safety check, communal shower block 29 August 2025 CP12-SB-114 \n\nPrevious licence period ended 13 January 2026 FSH-0398 \n\nCouncil site licence last renewed 1 April 2024 CDC/SL/00417 \n\nCONDITIONS \n\nThe unit must not be occupied as the holder's main residence. Sub-letting requires written consent. The holder must maintain current insurance on the unit \n\nthroughout the licence period and provide evidence on request. Park rules, as revised from time to time (last revised 6 November 2025, previously revised 14 \n\nFebruary 2023), form part of this licence. A pitch fee unpaid 28 days after the due date above may result in the licence not being offered for renewal the \n\nfollowing season. This licence was prepared using the park's standard wording, edition dated 3 July 2024, and supersedes all earlier editions. \n\nRENE WED \n\nFenwater Shores Holiday Park Ltd, registered in England and Wales No. 05512834 Licence FSH-0412 · Page 1 of 1\n",
    expected: {
    dates: ["2026-01-14","2027-01-10"],
    provider: "Fenwater Shores Holiday Park Ltd",
    reference: "FSH-0412",
    dateRoles: [
      { date: "2026-01-14", role: "issued" },
      { date: "2027-01-10", role: "expiry" },
    ],
    subtype: {"kinds":["Licence"]},
    costMinor: 415000,
    currency: "GBP",
    },
  },
  {
    // Ground-truth notes:
    // - dates: cover starts 4 October 2026 and renews 4 October 2027. Two other printed dates are deliberately not declared: the schedule issue date (21 Sep 2026) and the no-claims history review date (1 Sep 2026). The scheme terms edition stamp (3 Jul 2024) is a print-run date, not a policy date, and is also not declared.
    // - provider is HomeGuard365, which never appears as ordinary text anywhere on the page -- the letterhead only carries the generic scheme title 'Home Emergency Response Scheme' -- and is findable solely inside the claims e-mail address and the claims-portal web address in the 'Making a claim' section. Two other named organisations are deliberately not the provider: Casterbridge Insurance plc, the underwriter, and Millrace Home Assist Brokers Ltd, the broker that arranged the policy; the customer's day-to-day dealings (the claims line and portal) are with HomeGuard365, the same test the owner applied to a motor policy's broker versus its underwriter (#989).
    // - reference is the policy number HG365-POL-552017.
    // - costMinor is the £186.00 annual premium, not last year's premium of £171.00 or any of the five per-claim callout limits in the cover table.
    // - subtype: 'Insurance' qualified by 'Home'.
    // - scheduleKind is 'renewal': the later dateRole is 'renewal', which the policy itself confirms ('Your policy renews automatically each year').
    name: "home emergency schedule, the scheme's generic title carries no provider name at all",
    filename: "fullpage-home-emergency-cover-schedule.pdf",
    text: "Home emergency cover schedule HG365-POL-552017  \n\nHOME EMERGENCY RESPONSE SCHEME \n\n24-hour cover for boilers, plumbing, electrics and drainage \n\nPolicy schedule \n\nPolicyholder \n\nMr Gethin Prosser \n\n22 Millbrook Terrace, Fenmouth, Cravenshire CV2 5JD \n\nPolicy number HG365-POL-552017 \n\nCover start 4 October 2026 \n\nRenewal date 4 October 2027 \n\nSchedule issued 21 September 2026 \n\nWHAT  IS COVERED \n\nSection Callout limit \n\nBoiler and central heating breakdown £500 per claim, unlimited claims \n\nPlumbing and drainage emergencies £300 per claim, up to 3 claims a year \n\nHome electrics £300 per claim, up to 2 claims a year \n\nHome security (locks and glazing) £250 per claim, up to 2 claims a year \n\nPest control call-out £120 per claim, 1 claim a year \n\nANNUAL  PREMIUM \n\n£186.00 \n\nThis schedule confirms your cover from 4 October 2026 to 4 October 2027. Your policy renews automatically each year on 4 October unless you cancel it; a renewal notice \n\nwill be sent to you around 21 days beforehand. Last year's premium, for the period 4 October 2025 to 4 October 2026, was £171.00. \n\nMAKING  A CLAIM \n\nCall our 24-hour claims line on 0330 660 1187 and quote your policy number. You can also raise a claim by emailing claims@homeguard365.co.uk with photographs of the \n\nfault, or through our online portal at www.homeguard365.co.uk/claim. Please do not arrange your own engineer without authorisation first, or the cost may not be \n\nreimbursed. \n\nCover under this scheme is underwritten by Casterbridge Insurance plc, registered in England and Wales No. 03217740, authorised by the Prudential Regulation Authority and \n\nregulated by the Financial Conduct Authority and the Prudential Regulation Authority, firm reference number 204471. This policy is arranged through Millrace Home Assist \n\nBrokers Ltd, FCA firm reference number 559812. Your no-claims history was last reviewed on 1 September 2026. Scheme terms edition dated 3 July 2024. If we are unable to \n\nmeet our obligations you may be entitled to compensation from the Financial Services Compensation Scheme. \n\nHome Emergency Response Scheme · HG365-POL-552017 Page 1 of 1\n",
    expected: {
    dates: ["2026-10-04","2027-10-04"],
    provider: "HomeGuard365",
    reference: "HG365-POL-552017",
    dateRoles: [
      { date: "2026-10-04", role: "start" },
      { date: "2027-10-04", role: "renewal" },
    ],
    subtype: {"kinds":["Insurance"],"qualifiers":["Home"]},
    costMinor: 18600,
    currency: "GBP",
    scheduleKind: "renewal",
    },
  },
  {
    // Ground-truth notes:
    // - dates: contract started 12 March 2026 and its minimum term, and the printed renewal, both fall on 12 March 2027. Seven other printed dates are deliberately not declared: the invoice date (5 Sep 2026), the direct debit collection date (15 Sep 2026), the previous month's bill date (5 Aug 2026), the four billing-history dates (05/08/2026, 05/07/2026, 05/06/2026, 05/05/2026), the last price review (1 Jun 2026) and next price review (1 Jun 2027), and the terms edition stamp (3 Feb 2025).
    // - provider is 'Starview Satellite TV', printed large in the letterhead and confirmed by name in the small print ('Starview Satellite TV is a registered trademark of Starview Broadcasting Ltd'); the registered company name is a rival correct-ish answer but the brand is what the customer deals with and what the invoice is issued under.
    // - reference is the account number STV-AC-774213.
    // - costMinor is the £42.99 total due, not any of the four individual charge or discount lines that sum to it, and not any of the four historic billing amounts.
    // - subtype: 'Subscription' qualified by 'TV'.
    // - scheduleKind is 'renewal': the later dateRole is 'renewal', and the page confirms the contract renews automatically.
    // - recurrenceMonths is 1: the package is billed '1 month in advance', printed in digits.
    name: "satellite TV invoice, a plain letterhead among a page of billing-history dates",
    filename: "fullpage-satellite-tv-subscription-invoice.pdf",
    text: "Starview Satellite TV — invoice STV-AC-774213  \n\nStarview Satellite TV Freedom Package · 0800 220 1187 · www.starviewtv.example \n\nYour monthly invoice \n\nAccount holder \n\nMr Idris Coleman \n\n5 Beacon Rise, Marsh Cove, Aldreth Bay, Cravenshire CV31 4TP \n\nAccount STV-AC-774213 \n\nInvoice date 5 September 2026 \n\nContract start 12 March 2026 \n\nMinimum term ends 12 March 2027 \n\nTHIS  MONTH'S  CHARGES \n\nItem Amount \n\nFreedom Package, billed 1 month in advance 39.99 \n\nSports add-on 15.00 \n\nMultiscreen box rental 6.00 \n\nLoyalty discount -18.00 \n\nTotal due £42.99 \n\nDIRECT DEBIT COLLECTION \n\n15 September 2026 \n\nYour contract renews for a further 12 months on 12 March 2027 unless you tell us otherwise, at which point your minimum term discount may \n\nchange. Last month's bill, dated 5 August 2026, was £42.99, the same as this month. \n\nBILLING HISTORY \n\nDate Amount \n\n05/08/2026 £42.99 \n\n05/07/2026 £42.99 \n\n05/06/2026 £38.99 \n\n05/05/2026 £38.99 \n\nStarview Satellite TV is a registered trademark of Starview Broadcasting Ltd, registered in England and Wales No. 04217740, registered office Starview House, 2 Meridian Way, \n\nLarchgate, Wexbridge WX9 4QF. VAT registration number GB 771 2049 88. Prices last reviewed 1 June 2026; your next annual price review will take effect from 1 June 2027. \n\nTerms and conditions edition dated 3 February 2025. \n\nStarview Broadcasting Ltd · Account STV-AC-774213 Page 1 of 1\n",
    expected: {
    dates: ["2026-03-12","2027-03-12"],
    provider: "Starview Satellite TV",
    reference: "STV-AC-774213",
    dateRoles: [
      { date: "2026-03-12", role: "start" },
      { date: "2027-03-12", role: "renewal" },
    ],
    subtype: {"kinds":["Subscription"],"qualifiers":["TV"]},
    costMinor: 4299,
    currency: "GBP",
    recurrenceMonths: 1,
    scheduleKind: "renewal",
    },
  },
  {
    // Ground-truth notes:
    // - dates: move-in 15 August 2026, next payment due 15 September 2026. Four other printed dates are deliberately not declared: the agreement preparation date, the site's last rent increase, a previous, unrelated unit's end date at this address, and the terms edition stamps.
    // - provider is 'SSL': the operator's full legal or trading name is never printed anywhere on the page, only these three letters, used throughout as the brand mark and in the registered-company sentence in the small print.
    // - reference is the unit reference SSL-BX-3390, not the unrelated previous unit reference or the access code.
    // - costMinor is the monthly rent, printed with a currency symbol as the cost of the thing itself; the included-insurance figure is a cover limit, not a cost.
    // - recurrenceMonths is 1: a '1 month' term is printed in digits.
    // - subtype: 'Rental'; no qualifier group in the taxonomy names storage closely enough to declare one.
    // - scheduleKind is not declared: neither dateRole is 'renewal' or 'service'.
    name: "self storage agreement, the provider is never spelled out beyond three letters",
    filename: "fullpage-self-storage-agreement.pdf",
    text: "Storage licence agreement SSL-BX-3390  \n\nSSL Fenmouth Self Storage Centre · Unit 14, Quayside Industrial Estate, Fenmouth, Cravenshire CV2 7RL \n\nStorage licence agreement Customer Ms Carys Bevan 31 Hollytree Avenue, Fenmouth, Cravenshire CV2 6PN \n\nUnit reference SSL-BX-3390 \n\nMove-in date 15 August 2026 \n\nNext payment due 15 September 2026 \n\nAgreement prepared 12 August 2026 \n\nYO U R U NI T \n\nItem Detail \n\nUnit size 35 sq ft, ground floor, corridor C \n\nAccess code 7741# \n\nAccess hours 06:00 to 22:00 daily, including bank holidays \n\nInsurance Included up to £2,000 contents value \n\nM ON TH LY  R E N T \n\n£68.00 This storage licence is a rolling agreement, billed 1 month at a time from the move-in date shown above, and renews automatically each month until either party gives notice. Your first payment of £68.00 was taken on 15 August 2026 and your next payment of £68.00 is due on 15 September 2026. A minimum term of 1 month applies; after that, 14 days' written notice is needed to end the agreement. \n\nT E RMS \n\nSSL is a trading style used at this location; goods are stored entirely at the customer's own risk beyond the insured value stated above. SSL may increase the monthly rent on 30 days' written notice, and last increased rents at this site on 1 Apri l  2026. Access is suspended i f payment is more than 7 days overdue, and goods may be disposed of i f rent remains unpaid for 56 days, in l ine with the Torts (Interference with Goods) Act 1977. A previous l icence for unit SSL- BX-1187 at this address ended on 3 August 2026 when that customer's belongings were col lected in ful l . \n\nSSL, registered in England and Wales No. 07741932, registered office U nit 14, Quayside Industrial  Estate, Fenmouth, Cravenshire CV2 7RL. VAT registration number GB 118 7204 55. Terms and conditions edition dated 2 January 2026, superseding the edition dated 6 June 2023. \n\nSSL · Uni t SSL-BX-3 3 90 Page 1 of 1\n",
    expected: {
    dates: ["2026-08-15","2026-09-15"],
    provider: "SSL",
    reference: "SSL-BX-3390",
    dateRoles: [
      { date: "2026-08-15", role: "start" },
      { date: "2026-09-15", role: "due" },
    ],
    subtype: {"kinds":["Rental"]},
    costMinor: 6800,
    currency: "GBP",
    recurrenceMonths: 1,
    },
  },
  {
    // Ground-truth notes:
    // - dates: booked 2 September 2026, delivered (hire starts) 9 September 2026, collection due 23 September 2026. Three other printed dates are deliberately not declared: a previous, unrelated booking at the same address (14 Mar 2025), the waste carrier registration renewal (11 Jan 2026) and its next renewal (11 Jan 2029), and the terms-of-booking revision stamp (4 Jun 2024).
    // - provider is Corvedale Skips & Aggregates Ltd, stated plainly in the page's own text to be who the hire contract is actually with ('the contract for delivery, collection and disposal of the waste is between you and Corvedale Skips & Aggregates Ltd'). SkipFinder, named in the letterhead and throughout, is described in the small print as a booking intermediary regulated for consumer credit, not a waste carrier -- the FCA firm reference on the page belongs to SkipFinder, the broker, not to the provider.
    // - reference is the booking order number SKF-ORD-661204, not the earlier unrelated order (SKF-ORD-559812) or the waste carrier registration number (CBDU887214).
    // - costMinor is the £285.00 total charged, not any of the three line items that sum to it, and not the £8.00-a-day unauthorised extension charge.
    // - subtype: 'Contract' (a hire/order confirmation that is itself the contract) qualified by 'Waste'.
    // - scheduleKind is not declared: none of the three dateRoles is 'renewal' or 'service'.
    name: "skip hire order, the booking brand is not who the waste contract is with",
    filename: "fullpage-skip-hire-contract.pdf",
    text: "Skip hire order confirmation SKF-ORD-661204  \n\nSkipFinder Compare and book local skip hire · 0800 552 0198 · www.skipfinder.example \n\nOrder confirmation and hire contract \n\nDelivery address \n\nMrs Elin Thomas \n\n7 Orchard Way, Penbury, Cravenshire CV9 1HL \n\nOrder SKF-ORD-661204 \n\nBooked 2 September 2026 \n\nBooking made via www.skipfinder.example \n\nYOUR  BOOKING \n\nSkip size 8 yard builder's skip \n\nDelivery date 9 September 2026, between 7am and 1pm \n\nHire period 14 days from delivery \n\nCollection due 23 September 2026, unless you request an extension \n\nWaste type General builder's waste, no plasterboard, no hazardous materials \n\nPermit required No, skip stands on private driveway \n\nYour skip will be delivered and collected by our local partner, Corvedale Skips & Aggregates Ltd, registered waste carrier CBDU887214. \n\nSkipFinder Ltd arranges this booking on your behalf and takes payment, but the contract for delivery, collection and disposal of the waste \n\nis between you and Corvedale Skips & Aggregates Ltd. Any query about the skip itself, including a late delivery or an overfilled skip, should \n\ngo to Corvedale directly on 01568 774 220. \n\nCHARGES \n\nItem Amount \n\n8 yard skip, 14-day hire 210.00 \n\nWaste transfer and disposal charge 55.00 \n\nBooking service fee (SkipFinder) 20.00 \n\nTotal charged to your card £285.00 \n\nIf the skip is not collected by 23 September 2026 because it needs more time on site, contact Corvedale before that date to arrange an \n\nextension; an unauthorised extension is charged at £8.00 per day. A previous booking at this address (order SKF-ORD-559812, delivered 14 \n\nMarch 2025) was collected on time and closed with no additional charge. \n\nSkipFinder Ltd, registered in England and Wales No. 08814401, registered office 3 Harbour View, Fenmouth, Cravenshire CV2 8QN, is a booking intermediary regulated \n\nfor consumer credit activities by the Financial Conduct Authority, firm reference number 771204, and is not itself a licensed waste carrier. Corvedale Skips & \n\nAggregates Ltd is registered with the Environment Agency as an upper tier waste carrier, registration CBDU887214, renewed 11 January 2026 and due for its next \n\nrenewal on 11 January 2029. Terms of booking last revised 4 June 2024. \n\nCONFIR MED \n\nOrder SKF-ORD-661204 · delivered by Corvedale Skips & Aggregates Ltd · Page 1 of 1\n",
    expected: {
    dates: ["2026-09-02","2026-09-09","2026-09-23"],
    provider: "Corvedale Skips & Aggregates Ltd",
    reference: "SKF-ORD-661204",
    dateRoles: [
      { date: "2026-09-02", role: "issued" },
      { date: "2026-09-09", role: "start" },
      { date: "2026-09-23", role: "due" },
    ],
    subtype: {"kinds":["Contract"],"qualifiers":["Waste"]},
    costMinor: 28500,
    currency: "GBP",
    },
  },
  {
    // Ground-truth notes:
    // - dates: invoice issued 3 September 2026, this instalment due 1 October 2026. Nine other printed dates are deliberately not declared: the previous invoice date (2 Jun 2026), the two future instalment due dates (14 Jan 2027, 22 Apr 2027), halls arrivals day (27 Sep 2026), term start (29 Sep 2026), term end (12 Dec 2026), spring term reopening (10 Jan 2027), the tenancy agreement signing date (18 Aug 2026), the room condition report date (27 Sep 2026, same calendar date as arrivals but a different event), and the fire alarm test date (15 Sep 2026).
    // - provider is Bridgewater Living Services Ltd, the managing agent that actually issues and administers this invoice (named only in the small print and the page footer), not Aldreth Bay University, whose name appears in the letterhead and every heading but which does not itself invoice the resident for accommodation -- the same distinction the owner drew for a broker versus an underwriter (#989).
    // - reference is the invoice number BLS-INV-24-1187, not the tenancy reference (AB-KC-214-26) or the student number.
    // - costMinor is the £2,450.00 total due this instalment (the sum of room, insurance and levy charges), not the room charge alone (£2,180.00), the previous year's termly charge (£2,290.00), or the £35.00 late payment charge.
    // - subtype: 'Fees' (matching the printed 'invoice') qualified by 'School', the taxonomy group covering education and tuition-adjacent charges, since this is a student's accommodation billing rather than a general rental.
    // - scheduleKind is not declared: neither dateRole is 'renewal' or 'service'.
    name: "university halls invoice, the university's own name outshines its managing agent",
    filename: "fullpage-university-halls-invoice.pdf",
    text: "Accommodation invoice — Aldreth Bay Halls  \n\nALDRETH BAY UNIVERSITY Aldreth Bay Halls of Residence · Student Accommodation Office · halls@aldrethbay.example \n\nAccommodation invoice, autumn term 2026 Miss Priya Osei \n\nRoom 214, Kestrel Court, Aldreth Bay Halls \n\nStudent number 20261847 \n\nInvoice BLS-INV-24-1187 Tenancy ref AB-KC-214-26 Issued 3 September 2026 \n\nPrevious invoice 2 June 2026 \n\nPAYMENT  DUE \n\n1 October 2026 \n\nCharges this term \n\nItem Period Amount \n\nStandard single room, Kestrel Court 29 Sep 2026 to 12 Dec 2026 2,180.00 \n\nContents insurance (compulsory) autumn term 45.00 \n\nCommon room and laundry levy autumn term 225.00 \n\nTotal due this instalment £2,450.00 \n\nThis is the first of three equal termly instalments for the 2026/27 academic year. The spring term instalment falls due on 14 \n\nJanuary 2027 and the summer term instalment on 22 April 2027, each invoiced separately roughly four weeks beforehand. A late \n\npayment charge of £35.00 is applied to any instalment still unpaid ten days after its due date. \n\nKey dates this year \n\nEvent Date \n\nHalls open for arrivals 27 September 2026 \n\nAutumn term teaching begins 29 September 2026 \n\nAutumn term ends, halls close for winter break 12 December 2026 \n\nHalls reopen for spring term 10 January 2027 \n\nTenancy agreement signed by resident 18 August 2026 \n\nRoom condition report completed 27 September 2026 \n\nFire alarm test, Kestrel Court 15 September 2026 \n\nCharges are set annually by the university's accommodation office and reviewed each June; the 2025/26 termly charge was £2,290.00. Aldreth Bay Halls is managed \n\nunder contract by Bridgewater Living Services Ltd, company number 07734512, registered office 14 Quayside Chambers, Fenmouth, Cravenshire CV2 9LT, on behalf \n\nof Aldreth Bay University. Queries about this invoice should be sent to accounts@bridgewaterliving.example, not to the university's central finance office. This \n\ninvoice does not cover meals, which are charged separately through the campus card system. \n\nBridgewater Living Services Ltd, acting as managing agent for Aldreth Bay University · Invoice BLS-INV-24-1187 · Page 1 of 1\n",
    expected: {
    dates: ["2026-09-03","2026-10-01"],
    provider: "Bridgewater Living Services Ltd",
    reference: "BLS-INV-24-1187",
    dateRoles: [
      { date: "2026-09-03", role: "issued" },
      { date: "2026-10-01", role: "due" },
    ],
    subtype: {"kinds":["Fees"],"qualifiers":["School"]},
    costMinor: 245000,
    currency: "GBP",
    },
  },
];
