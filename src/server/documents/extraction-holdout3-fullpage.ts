// GENERATED FILE — do not edit by hand.
//
// A HOLD-OUT set: full-page documents written after the extractor was
// tuned, by someone who had not read `scripts/corpus/sources/` (or, for a
// later hold-out, any earlier hold-out either -- `holdout3` is not the first).
// They are the generalisation measurement, so they are deliberately NOT part
// of `EXTRACTION_CORPUS`: nothing tuning against the tuning set pulls them
// in, and tuning against a hold-out would destroy the only unseen number the
// project has for it.
//
// Score with `npm run eval:holdout -- --holdout3`. Regenerate with:
//
//   node scripts/corpus/generate.mjs --dir holdout3
//
// Each document was written as HTML, rendered to PDF with Playwright at A4,
// and parsed with the real Tika using the request in `tika.ts`. The `text`
// below is Tika's output byte for byte — escapes, flattened table columns,
// repeated page headers and all. That is the point: the fixture is what
// production actually sees, not a tidied version of it.
//
// The originals live in `scripts/corpus/holdout3/`. Never edit
// `text` here; edit the HTML and regenerate, so the fixture and the document
// it came from cannot drift apart.

import type { CorpusDocument } from "./extraction-corpus";

export const EXTRACTION_HOLDOUT3_FULLPAGE: CorpusDocument[] = [
  {
    // Ground-truth notes:
    // - dates: tenancy start 1 October 2026, rent due 30 September 2026 (the day before, being the association's standard prepayment date for the year commencing). The AGM date (7 February 2026), the key deposit date (14 September 2024) and the previous tenant's end date (30 September 2025) are printed but not declared.
    // - provider is the letting association's full name, printed in the letterhead.
    // - reference is Plot 23, the tenant's own plot; the neighbouring Plot 24 rent is a rival number shown only for comparison.
    // - costMinor is the annual plot rent, 38.00, printed with a pound sign; the water rate (9.50) and key deposit (5.00) are separate charges and traps.
    // - subtype: Tenancy/Garden. No recurrence is declared: neither dateRole is 'renewal' or 'service', so the contract keeps no recurrenceMonths even though the rent is in fact annual.
    // - scheduleKind is not declared: neither dateRole is 'renewal' or 'service'.
    name: "allotment plot tenancy agreement, rent due the day before the tenancy it pays for begins",
    filename: "fullpage-allotment-tenancy-agreement.pdf",
    text: "Barrowfield Allotment Association — tenancy agreement  \n\nBarrowfield Allotment & Garden Association The Old Pavilion, Barrowfield Road, Fenmouth, Cravenshire CV2 9RJ · barrowfieldallotments.example \n\nAllotment plot tenancy agreement \n\nTenant Mr Owen Pickering, 4 Larch Grove, Fenmouth, Cravenshire CV2 6TL \n\nPlot reference Plot 23, Barrowfield Field, full plot (approx. 250 sq yd) \n\nTenancy year Runs 1 October to 30 September, in line with the association’s rules \n\nTenancy start 1 October 2026 \n\nRent due 30 September 2026, for the year commencing 1 October 2026 \n\nAnnual rent £38.00, payable in advance \n\nTERMS OF TENANCY \n\nThis agreement lets Plot 23 to the tenant named above from 1 October 2026 on a yearly tenancy, terminable by either party giving one month’s written notice to expire on 30 September in any year. The plot is let for cultivation as a garden or allotment only, in accordance with the Allotments Acts 1908 to 1950 and the association’s current rules, a copy of which is enclosed. \n\nRent of £38.00 for the tenancy year is due on or before 30 September each year; an unpaid rent account more than eight weeks in arrears may result in the tenancy being terminated. A separate water rate of £9.50 is charged each May for standpipe access and is not part of the plot rent. A refundable key deposit of £5.00 was paid on 14 September 2024 for the site gate and is held on the tenant’s account until the tenancy ends. \n\nThe tenant must keep the plot substantially cultivated and free of noxious weeds, must not erect any structure without the committee’s written consent, and must not keep livestock other than bees without separate permission. The half-plot rent for Plot 24, let to a neighbouring tenant, is £20.00 and is shown here only for comparison in the association’s published rent scale. \n\nSigned for the Association:    S. Whitcombe, Secretary · 12 September 2026 \n\nSigned by the Tenant:    O. Pickering · 12 September 2026 \n\nThe association’s annual general meeting is held each February; the most recent AGM was held on 7 February 2026 and approved the rent scale in force above. This agreement supersedes any earlier tenancy of Plot 23, including the previous tenant’s agreement which ended 30 September 2025. \n\nBarrowfield Allotment & Garden Association · Plot 23 Page 1 of 1\n",
    expected: {
    dates: ["2026-10-01","2026-09-30"],
    provider: "Barrowfield Allotment & Garden Association",
    reference: "Plot 23",
    dateRoles: [
      { date: "2026-10-01", role: "start" },
      { date: "2026-09-30", role: "due" },
    ],
    subtype: {"kinds":["Tenancy"],"qualifiers":["Garden"]},
    costMinor: 3800,
    currency: "GBP",
    },
  },
  {
    // Ground-truth notes:
    // - dates: agreement dated 5 September 2026, delivery and start 12 September 2026, minimum term ends 11 March 2028. The first Direct Debit collection date (18 September 2026) and the customer's unrelated previous tumble-dryer agreement's return date (30 August 2026) are undeclared.
    // - provider is Homestead Rental Solutions.
    // - reference is agreement HRS-AGR-661204.
    // - costMinor is the weekly rental, 6.50, the recurring cost of the appliance itself; delivery (20.00, one-off, already paid), optional damage cover (1.20, not selected) and the early-termination charge (15.00) are traps.
    // - recurrenceMonths is 18, printed in digits as the minimum term; scheduleKind is 'renewal', taken from the minimum-term-ending dateRole exactly as an earlier alarm monitoring agreement's minimum term does.
    // - subtype: Rental/Appliance.
    name: "rent-to-own appliance rental agreement, a returned tumble dryer as a decoy previous agreement",
    filename: "fullpage-appliance-rental-agreement.pdf",
    text: "Homestead Rental Solutions — appliance rental agreement  \n\nHomestead Rental Solutions Household appliance rental, no deposit · homesteadrental.example \n\nAgreement HRS-AGR-661204 Agreement date 5 September 2026 \n\nAppliance rental agreement \n\nCustomer Miss Bethan Iqbal, 27 Fenwick Terrace, Penbury, Cravenshire CV9 7QL \n\nAppliance Kelford 9kg washing machine, model KF-WM-914, serial 20260441 \n\nDelivery & start date 12 September 2026 \n\nMinimum term 18 months, ending 11 March 2028 \n\nPAYMENT SCHEDULE \n\nCharge Amount \n\nWeekly rental, collected every Friday £6.50 \n\nDelivery & installation (one-off, already paid) £20.00 \n\nOptional accidental damage cover, per week £1.20 \n\nEarly termination charge (per month remaining) £15.00 \n\nWeekly rental (this agreement) £6.50 \n\nThis agreement runs for a minimum term of 18 months from the start date shown above, ending 11 March 2028, after which it continues on a rolling weekly basis until either party gives 28 days’ notice. Rental is collected by Direct Debit every Friday, starting 18 September 2026. Optional accidental damage cover was not selected for this agreement. \n\nThe customer’s previous rental agreement, for a tumble dryer returned on 30 August 2026, has ended and is not affected by this new agreement. Ownership of the washing machine remains with Homestead Rental Solutions Ltd at all times; the customer may not sell, sublet or remove it from the delivery address without written consent. \n\nHomestead Rental Solutions · Agreement HRS-AGR-661204 Page 1 of 1\n",
    expected: {
    dates: ["2026-09-05","2026-09-12","2028-03-11"],
    provider: "Homestead Rental Solutions",
    reference: "HRS-AGR-661204",
    dateRoles: [
      { date: "2026-09-05", role: "issued" },
      { date: "2026-09-12", role: "start" },
      { date: "2028-03-11", role: "renewal" },
    ],
    subtype: {"kinds":["Rental"],"qualifiers":["Appliance"]},
    costMinor: 650,
    currency: "GBP",
    recurrenceMonths: 18,
    scheduleKind: "renewal",
    },
  },
  {
    // Ground-truth notes:
    // - dates: job and invoice date 8 September 2026 (printed under two labels, declared once), parts-warranty expiry 7 December 2026. The unrelated earlier repair to the same appliance (14 January 2025) is undeclared.
    // - provider is Whitlock Domestic Appliance Repairs; C. Whitlock is the sole trader behind the trading name, named only in the small print.
    // - reference is invoice WDAR-INV-2249.
    // - costMinor is the total charged, 135.00 (call-out 45.00 + part 58.00 + labour 32.00).
    // - subtype: Repair/Appliance. No recurrence or scheduleKind is declared: this is a one-off repair with no ongoing service contract, and neither dateRole is 'renewal' or 'service'.
    name: "household appliance repair invoice, an unrelated earlier repair to the same machine as a decoy",
    filename: "fullpage-appliance-repair-invoice.pdf",
    text: "Whitlock Domestic Appliance Repairs — invoice  \n\nWhitlock Domestic Appliance Repairs Cookers, washing machines & dishwashers · 07700 900556 \n\nInvoice WDAR-INV-2249 Job date 8 September 2026 \n\nInvoice date 8 September 2026 \n\nRepair invoice \n\nCustomer Mr Callum Reeve, 19 Silverdale Close, Reading, RG6 3PL \n\nAppliance Kelford 9kg washing machine, model KF-WM-812 \n\nFault reported Not draining, drum not spinning on cycle end \n\nItem Amount \n\nCall-out and diagnosis £45.00 \n\nReplacement drain pump, part & fitting £58.00 \n\nLabour, 45 minutes £32.00 \n\nTotal charged, paid by card on the day £135.00 \n\nRepair carried out on 8 September 2026. The replacement drain pump carries a 90-day parts warranty from the repair date, covering the part only and not labour, ending 7 December 2026. This is a one-off repair invoice; no ongoing service contract is attached to this appliance. \n\nThe same appliance was previously repaired on 14 January 2025 for an unrelated door-seal fault, invoiced separately at the time and not part of this invoice. Whitlock Domestic Appliance Repairs is a trading name of C. Whitlock, registered for VAT number 227 4471 09. \n\nWhitlock Domestic Appliance Repairs · WDAR-INV-2249 Page 1 of 1\n",
    expected: {
    dates: ["2026-09-08","2026-12-07"],
    provider: "Whitlock Domestic Appliance Repairs",
    reference: "WDAR-INV-2249",
    dateRoles: [
      { date: "2026-09-08", role: "issued" },
      { date: "2026-12-07", role: "expiry" },
    ],
    subtype: {"kinds":["Repair"],"qualifiers":["Appliance"]},
    costMinor: 13500,
    currency: "GBP",
    },
  },
  {
    // Ground-truth notes:
    // - dates: ticket valid from 14 September 2026, renewal date 14 September 2027. The printed period-end date one day earlier (13 September 2027), the second vehicle's removal date (2 July 2026) and the renewal-reminder start date (14 August 2027) are traps, undeclared.
    // - provider is Questmoor Parking, the operator; Bramgate Multi-Storey is the car park's own name, not the operator.
    // - reference is the ticket number QMP-ST-771049.
    // - costMinor is the annual season ticket price, 780.00; the day-ticket (9.50), casual weekly ticket (38.00) and lost-ticket charge (25.00) are traps.
    // - recurrenceMonths is 12, printed in digits as 'This 12-month season ticket'.
    // - subtype: Season ticket/Parking. scheduleKind is 'renewal'.
    name: "multi-storey car park season ticket, a removed second vehicle and a renewal-reminder date as decoys",
    filename: "fullpage-car-park-season-ticket.pdf",
    text: "Questmoor Parking — season ticket  \n\nQUESTMOOR PARKING Bramgate Multi-Storey · Season ticket confirmation \n\nSeason ticket confirmation \n\nTicket holder Mr Declan Farrow, 12 Orchard Way, Marlpool, Cravenshire CV4 6RS \n\nTicket number QMP-ST-771049 \n\nCar park Bramgate Multi-Storey, Level 1–5, Marlpool CV4 2QT \n\nAccess 24 hours, any level, ANPR camera entry — no physical ticket needed \n\nLV73 KFM registered vehicle \n\nValid from 14/09/2026 \n\nValid until 13/09/2027 \n\nRenewal date 14/09/2027 \n\nAnnual season ticket price £780.00 \n\nThis 12-month season ticket gives unrestricted entry and exit to Bramgate Multi-Storey for the vehicle registered above, recognised automatically by number-plate camera at the barrier. A day ticket \n\nbought at the barrier costs £9.50, and a casual weekly ticket £38.00; neither applies while this season ticket is active. Lost-ticket or barrier-fault charges of up to £25.00 may apply if the camera fails to \n\nrecognise the vehicle and a manual ticket is taken by mistake. \n\nA second vehicle, registration KY19 PLM, was removed from this account on 2 July 2026 and is no longer covered. Renewal reminders are sent from 14 August 2027; if not renewed by 13 September 2027, \n\nstandard casual rates apply from 14 September 2027. \n\nQuestmoor Parking · Ticket QMP-ST-771049 Page 1 of 1\n",
    expected: {
    dates: ["2026-09-14","2027-09-14"],
    provider: "Questmoor Parking",
    reference: "QMP-ST-771049",
    dateRoles: [
      { date: "2026-09-14", role: "start" },
      { date: "2027-09-14", role: "renewal" },
    ],
    subtype: {"kinds":["Season ticket"],"qualifiers":["Parking"]},
    costMinor: 78000,
    currency: "GBP",
    recurrenceMonths: 12,
    scheduleKind: "renewal",
    },
  },
  {
    // Ground-truth notes:
    // - dates: letter dated 9 September 2026, first Direct Debit collection 1 October 2026. The earlier one-off online gift (18 August 2026) and the patron's annual address date (14 March 2026) are printed but not declared.
    // - provider is Fernbridge Wildlife Trust, the charity itself.
    // - reference is the supporter number FWT-227410.
    // - costMinor is the new regular gift, 12.00 a month; the earlier one-off gift (25.00) is a trap, printed as a rival amount already receipted separately.
    // - subtype: Subscription. No qualifier in the taxonomy names charitable giving closely enough to declare one.
    // - No recurrence or scheduleKind is declared: neither dateRole is 'renewal' or 'service', even though the gift itself recurs monthly.
    name: "charity regular-giving confirmation, a prior one-off gift sits beside the new Direct Debit",
    filename: "fullpage-charity-giving-confirmation.pdf",
    text: "Fernbridge Wildlife Trust — regular giving confirmation  \n\nFernbridge Wildlife Trust Registered charity, protecting wetlands and woodland across Cravenshire \n\nSupporter number FWT-227410 \n\nLetter dated 9 September 2026 \n\nThank you for your regular support \n\nDear Mr Adeyemi, \n\nThank you for setting up a regular gift to Fernbridge Wildlife Trust. This letter confirms the Direct Debit \n\ninstruction we have received from your bank, and the details we hold for your support. \n\nSupporter Mr Tunde Adeyemi, 5 Riverside Walk, Fenmouth, Cravenshire CV3 2QT \n\nRegular gift £12.00 a month, by Direct Debit \n\nFirst collection 1 October 2026 \n\nCollection day 1st of each month thereafter \n\nGift Aid: you told us on 9 September 2026 that you are a UK taxpayer and would like Fernbridge Wildlife Trust to treat all donations \n\nyou make from that date as Gift Aid donations, adding 25p for every £1 you give at no extra cost to you. \n\nYour first collection of £12.00 will be taken from your account on or shortly after 1 October 2026, and monthly \n\nthereafter on the same date. You are covered by the Direct Debit Guarantee, and can change or cancel your gift \n\nat any time by contacting our supporter care team. \n\nA one-off gift of £25.00 you kindly made online on 18 August 2026, before this regular gift began, has already \n\nbeen receipted separately and is not part of this Direct Debit instruction. \n\nFernbridge Wildlife Trust is a registered charity in England and Wales, No. 1147712, and a company limited by guarantee, registered office Fern \n\nHouse, Water Lane, Fenmouth, Cravenshire CV3 1QT. Our patron’s annual address to supporters is published each spring; the most recent was on \n\n14 March 2026. \n\nFernbridge Wildlife Trust · Supporter FWT-227410 Page 1 of 1\n",
    expected: {
    dates: ["2026-09-09","2026-10-01"],
    provider: "Fernbridge Wildlife Trust",
    reference: "FWT-227410",
    dateRoles: [
      { date: "2026-09-09", role: "issued" },
      { date: "2026-10-01", role: "due" },
    ],
    subtype: {"kinds":["Subscription"]},
    costMinor: 1200,
    currency: "GBP",
    },
  },
  {
    // Ground-truth notes:
    // - dates: certificate issued 4 September 2026, period start 14 September 2026, renewal date 14 September 2027. The period-of-insurance END date, 13 September 2027, is printed one day before the renewal date and is a deliberate trap, not declared. The bicycle's purchase date (2 June 2025) and its unrelated manufacturer's warranty expiry (2 June 2027) are also undeclared.
    // - provider is Spoke & Wheel Cycle Cover, the trading name under which the certificate is issued, not Ridgeway Insurance Brokers Ltd (the legal entity, named only once) or Palisade Insurance Company plc (the underwriter).
    // - reference is the certificate number SWC-2026-88213.
    // - costMinor is the annual premium, 64.20; the insured purchase price (2,150.00), the optional roadside-assistance add-on price (18.50) and the cover limits/excesses in the table are traps.
    // - recurrenceMonths is 12, printed in digits as 'a 12-month policy'.
    // - subtype: Insurance/Bike. scheduleKind is 'renewal', derived from the renewal dateRole.
    name: "cycle insurance certificate, the true renewal date sits one day after the printed period end",
    filename: "fullpage-cycle-insurance-certificate.pdf",
    text: "Spoke & Wheel Cycle Cover — certificate of insurance  \n\nSpoke & Wheel Cycle Cover · a trading name of Ridgeway Insurance Brokers Ltd \n\nCertificate SWC-2026-88213 Issued 4 September 2026 \n\nCertificate of cycle insurance \n\nPolicyholder Miss Anwen Delacroix, 9 Foundry Row, Marlpool, Cravenshire CV4 2QP \n\nBicycle Rourke Endurance 725 road bike, frame no. RK-2025-441829 \n\nPurchase price insured £2,150.00 (new-for-old replacement) \n\nPeriod of insurance 14 September 2026 to 13 September 2027 \n\nRenewal date 14 September 2027 \n\nCOVER SUMMA RY \n\nSection Limit Excess \n\nTheft and accidental damage Up to £2,150.00 £75.00 \n\nPersonal accident (cycling only) Up to £15,000.00 Nil \n\nPublic liability Up to £1,000,000.00 £100.00 \n\nRoadside assistance (optional add-on) Not selected n/a \n\nAnnual premium (paid in full) £64.20 \n\nThis certificate is evidence of cover under policy SWC-2026-88213, underwritten by Palisade Insurance Company plc and administered by Ridgeway Insurance Brokers Ltd trading as Spoke & Wheel Cycle Cover. The bicycle must be secured with an approved lock, listed at spokeandwheelcover.example/locks, whenever left unattended in a public place; cover for theft is void without one. The optional roadside assistance add-on, priced at £18.50 a year, was not selected for this policy. \n\nThe bicycle was purchased on 2 June 2025 and its original manufacturer’s warranty, unconnected with this insurance, expires on 2 June 2027. Cover is renewable annually as a 12-month policy; you will be contacted before 14 September 2027 with your renewal terms. \n\nSpoke & Wheel Cycle Cover · Certificate SWC-2026-88213 Page 1 of 1\n",
    expected: {
    dates: ["2026-09-04","2026-09-14","2027-09-14"],
    provider: "Spoke & Wheel Cycle Cover",
    reference: "SWC-2026-88213",
    dateRoles: [
      { date: "2026-09-04", role: "issued" },
      { date: "2026-09-14", role: "start" },
      { date: "2027-09-14", role: "renewal" },
    ],
    subtype: {"kinds":["Insurance"],"qualifiers":["Bike"]},
    costMinor: 6420,
    currency: "GBP",
    recurrenceMonths: 12,
    scheduleKind: "renewal",
    },
  },
  {
    // Ground-truth notes:
    // - dates: contract start 7 September 2026, next price review 7 March 2027 (labelled 'other': a price review is not a renewal or a service visit). The pre-contract one-off deep clean (31 August 2026) is undeclared.
    // - provider is Brightwell Home Cleaning Services, the trading name in the brand bar, not BHC Domestic Services Ltd (the registered company, named only in the small print).
    // - reference is the client reference BHC-CL-004417.
    // - costMinor is the regular weekly visit price, 28.00, the recurring cost of the service itself; the deep clean (85.00), additional hour (13.00), late-cancellation charge (14.00), holiday surcharge (9.00) and key charge (15.00) are all traps.
    // - subtype: Contract/Cleaning. No recurrence is declared: the price review date is not a scheduled renewal or service event, so no recurrenceMonths is kept even though six months is mentioned in words.
    // - scheduleKind is not declared: neither dateRole is 'renewal' or 'service'.
    name: "domestic cleaning contract, a six-month price fix with five rival prices around it",
    filename: "fullpage-domestic-cleaning-contract.pdf",
    text: "Brightwell Home Cleaning Services — client contract  \n\nBrightwell Home Cleaning Services Regular domestic cleaning across Cravenshire \n\nClient cleaning contract \n\nClient Mrs Sian Okafor, 16 Meadowcroft Drive, Penbury, Cravenshire CV9 4LR \n\nClient reference BHC-CL-004417 \n\nRegular visit Every Tuesday, 2 hours, one cleaner \n\nContract start 7 September 2026 \n\nNext price review 7 March 2027 \n\nPRICING \n\nService Price \n\nRegular weekly visit (2 hours) £28.00 per visit \n\nOne-off deep clean (up to 4 hours) £85.00 \n\nAdditional hour, regular visit £13.00 \n\nLate cancellation (under 24 hours’ notice) £14.00 \n\nChristmas & New Year cover surcharge £9.00 per visit \n\nThis contract begins on 7 September 2026 and continues on a rolling basis until ended by either party giving two weeks’ written notice. The regular visit price of £28.00 is fixed for six months from the contract start and is next reviewed on 7 March 2027, when Brightwell may propose a revised rate with one month’s notice. \n\nA key was issued to the assigned cleaner on 7 September 2026 under key log entry KL-2261, and remains the client’s property; a £15.00 charge applies if it is not returned within one month of the contract ending. The one-off deep clean carried out before the regular contract began, on 31 August 2026, was invoiced separately and is not part of this ongoing contract. \n\nFor Brightwell Home Cleaning Services:    R. Sutcliffe · 5 September 2026 \n\nClient signature:    S. Okafor · 5 September 2026 \n\nBrightwell Home Cleaning Services is a trading name of BHC Domestic Services Ltd, registered in England and Wales No. 09214477, registered office 3 Foundry Court, Marlpool, Cravenshire CV4 1QW. Public liability insurance of £2,000,000 is held with a policy renewing each January; the current policy runs to 31 January 2027. \n\nBrightwell Home Cleaning Services · BHC-CL-004417 Page 1 of 1\n",
    expected: {
    dates: ["2026-09-07","2027-03-07"],
    provider: "Brightwell Home Cleaning Services",
    reference: "BHC-CL-004417",
    dateRoles: [
      { date: "2026-09-07", role: "start" },
      { date: "2027-03-07", role: "other" },
    ],
    subtype: {"kinds":["Contract"],"qualifiers":["Cleaning"]},
    costMinor: 2800,
    currency: "GBP",
    },
  },
  {
    // Ground-truth notes:
    // - dates: appointment and invoice date 3 September 2026 (one date, two labels), payment due 17 September 2026, recommended next screening 3 September 2027. The spouse's separately invoiced screening, paid 28 August 2026, is undeclared.
    // - provider is Kestrel Health Screening Clinic; Kestrel Health Ltd is the operating company, named only in the small print.
    // - reference is invoice KHSC-INV-771049.
    // - costMinor is the package price, 249.00; the optional bone density scan (0.00, not taken) is a trap.
    // - recurrenceMonths is 12, printed in digits as 'every 12 months'; scheduleKind is 'service', from the recommended-next-screening dateRole, which is a recommendation only and not yet a booked appointment.
    // - subtype: Appointment/Health.
    name: "private health screening clinic invoice, a spouse's separate invoice as a decoy",
    filename: "fullpage-health-screening-clinic-invoice.pdf",
    text: "Kestrel Health Screening Clinic — invoice  \n\nKestrel Health Screening Clinic Private health assessments · 14 Riverside Court, Hallowfield, HF4 7QP \n\nInvoice KHSC-INV-771049 \n\nAppointment 3 September 2026 \n\nInvoice date 3 September 2026 \n\nPayment due 17 September 2026 \n\nHealth screening invoice \n\nPatient Mrs Grace Fenwick, 22 Larchwood Drive, Hallowfield, HF3 2QP \n\nPackage Comprehensive health screen (blood panel, ECG, blood pressure) \n\nRecommended next screening 3 September 2027 \n\nCHARGES \n\nItem Amount \n\nComprehensive health screen package £249.00 \n\nOptional add-on: bone density scan (not taken) £0.00 \n\nTotal due £249.00 \n\nResults were discussed with the patient at the appointment on 3 September 2026 and a written summary posted the same week. This clinic recommends a follow-up screen every 12 months for patients in \n\nthis package, next due around 3 September 2027; this is a recommendation only and no appointment has yet been booked for that date. \n\nA separate screening for the patient’s spouse, invoiced under reference KHSC-INV-771002 and paid on 28 August 2026, is not included in this invoice. Kestrel Health Screening Clinic is operated by Kestrel \n\nHealth Ltd, registered with the Care Quality Commission, provider ID CQC-44712. \n\nKestrel Health Screening Clinic · KHSC-INV-771049 Page 1 of 1\n",
    expected: {
    dates: ["2026-09-03","2026-09-17","2027-09-03"],
    provider: "Kestrel Health Screening Clinic",
    reference: "KHSC-INV-771049",
    dateRoles: [
      { date: "2026-09-03", role: "issued" },
      { date: "2026-09-17", role: "due" },
      { date: "2027-09-03", role: "service" },
    ],
    subtype: {"kinds":["Appointment"],"qualifiers":["Health"]},
    costMinor: 24900,
    currency: "GBP",
    recurrenceMonths: 12,
    scheduleKind: "service",
    },
  },
  {
    // Ground-truth notes:
    // - dates: invoice date 2 September 2026, payment due 16 September 2026. The term dates (7 September to 11 December 2026), the missed-lesson date (24 August 2026) and the half-term return date (2 November 2026) are printed but not declared.
    // - provider is C. Marchetti Piano & Guitar Tuition, the sole trader's own brand, printed across the heading and subheading together.
    // - reference is invoice CM-INV-0341.
    // - costMinor is the total due, 225.00 (the 210.00 term fee plus a 15.00 missed-lesson charge); the Grade 3 exam fee (46.00, passed to the exam board and invoiced separately) and keyboard hire (12.00, not taken) are traps that are explicitly not part of the total.
    // - subtype: Course. No qualifier in the taxonomy names music tuition closely enough to declare one, the same reasoning as a self-storage agreement declaring only 'Rental'.
    // - No recurrence or scheduleKind is declared: neither dateRole is 'renewal' or 'service'.
    name: "private music tuition invoice, an exam fee and a missed-lesson charge that are not both in the total",
    filename: "fullpage-music-tuition-invoice.pdf",
    text: "C. Marchetti Piano & Guitar Tuition — invoice  \n\nC. Marchetti \n\nPiano & Guitar Tuition · DBS checked · 07700 900338 \n\nInvoice CM-INV-0341 Invoice date 2 September 2026 \n\nPayment due 16 September 2026 \n\nInvoice for lessons \n\nBilled to Mr & Mrs Hallworth, 21 Sycamore Close, Penbury, Cravenshire CV9 5DG \n\nPupil Louis Hallworth, piano, grade 3 \n\nTerm covered Autumn term, 7 September 2026 to 11 December 2026 \n\nItem Amount \n\nTerm of piano lessons, 14 x 30-minute lessons £210.00 \n\nMissed lesson, 24 August 2026, less than 24 hours’ notice £15.00 \n\nTotal due for this invoice £225.00 \n\nThe term fee of £210.00 covers fourteen half-hour lessons at the family home, held weekly except during school holidays. The Grade 3 exam entry fee, £46.00, is collected on the pupil’s behalf and passed on to the exam board without mark-up, so it is invoiced separately and does not appear in the total above; nor does keyboard hire, offered at £12.00 a term, which was not taken up this term. Please pay by bank transfer to the account details previously provided, quoting invoice CM-INV-0341. \n\nA missed lesson with less than 24 hours’ notice is charged in full; the lesson on 24 August 2026 falls in the previous, already-settled summer term invoice and is repeated here only as a reminder that the policy applies again this term. Lessons resume after the half-term break on 2 November 2026. \n\nThank you — Carla \n\nC. Marchetti Piano & Guitar Tuition · CM-INV-0341 Page 1 of 1\n",
    expected: {
    dates: ["2026-09-02","2026-09-16"],
    provider: "C. Marchetti Piano & Guitar Tuition",
    reference: "CM-INV-0341",
    dateRoles: [
      { date: "2026-09-02", role: "issued" },
      { date: "2026-09-16", role: "due" },
    ],
    subtype: {"kinds":["Course"]},
    costMinor: 22500,
    currency: "GBP",
    },
  },
  {
    // Ground-truth notes:
    // - dates: only the statement date 12 September 2026 is declared. The statement period start (1 September 2026), the half-term dates (26-30 October 2026), the autumn term dates (2 September to 18 December 2026), and every per-meal ledger date are printed but not the document's own governing date, so none is declared.
    // - provider is SchoolPurse, the cashless catering platform that issues the statement, not the school (Bramwell Primary School) whose kitchen the meals are bought from.
    // - reference is the account number SP-774102-6, not the pupil's class or the residential-trip deposit amount.
    // - costMinor is the current balance, 7.40, the only amount printed with a pound sign as a running total rather than a single ledger line; the recommended top-up (22.50) and the trip deposit (18.00) are traps.
    // - subtype: Fees/School. No recurrence is declared: meals are charged daily, not on a fixed month count in digits.
    // - scheduleKind is not declared: no dateRole is 'renewal' or 'service'.
    name: "school meals account statement, autumn-term ledger with a refund and a residential-trip decoy",
    filename: "fullpage-school-meals-account-statement.pdf",
    text: "SchoolPurse account statement  \n\nSchoolPurse Cashless catering & top-up account · www.schoolpurse.example \n\nStatement date 12 September 2026 \n\nAccount SP-774102-6 \n\nSchool Bramwell Primary School \n\nMeal account statement \n\nPupil \n\nFreya Marchetti \n\nClass 4B · Bramwell Primary School, Fenmouth, Cravenshire CV3 8QL \n\nStatement period \n\n1 September 2026 to 12 September 2026 \n\nCurrent balance £7.40 \n\nYour balance is below the £10.00 low-funds threshold. A top-up of at least £22.50 is recommended to cover meals through to the \n\nOctober half term, which begins 26 October 2026. \n\nDate Description Amount Balance \n\n01/09/2026 Balance brought forward from summer term – £3.10 \n\n02/09/2026 Top-up by parent, card ending 4471 +£20.00 £23.10 \n\n03/09/2026 School meal — Freya Marchetti –£2.45 £20.65 \n\n04/09/2026 School meal — Freya Marchetti –£2.45 £18.20 \n\n07/09/2026 School meal — Freya Marchetti –£2.45 £15.75 \n\n08/09/2026 Breakfast club — Freya Marchetti –£1.50 £14.25 \n\n09/09/2026 School meal — Freya Marchetti –£2.45 £11.80 \n\n10/09/2026 School meal — Freya Marchetti –£2.45 £9.35 \n\n11/09/2026 Refund — INSET day, kitchen closed +£2.45 £11.80 \n\n12/09/2026 School meal — Freya Marchetti –£2.45 £9.35 \n\n12/09/2026 Breakfast club — Freya Marchetti –£1.95 £7.40 \n\nMeals are charged automatically each morning at £2.45 for Key Stage 2 pupils. Breakfast club is a separate optional charge, billed on the day. The \n\nkitchen is closed for an INSET day on 11 September 2026, and no meal charge is made on that date; a credit already taken in error is refunded the same \n\nday. Autumn term runs from 2 September 2026 to 18 December 2026, with a half-term break from 26 October 2026 to 30 October 2026 inclusive. \n\nTop up online at schoolpurse.example/topup using account SP-774102-6, or ask at the school office. A separate one-off charge of £18.00 for the Year \n\n4 residential trip deposit was invoiced directly by the school and does not appear on this catering account. \n\nSchoolPurse · account SP-774102-6 Page 1 of 1\n",
    expected: {
    dates: ["2026-09-12"],
    provider: "SchoolPurse",
    reference: "SP-774102-6",
    dateRoles: [
      { date: "2026-09-12", role: "issued" },
    ],
    subtype: {"kinds":["Fees"],"qualifiers":["School"]},
    costMinor: 740,
    currency: "GBP",
    },
  },
  {
    // Ground-truth notes:
    // - dates: renewal due 31 October 2026, membership year starts 1 November 2026. The lapse date (30 November 2026), the AGM date (14 November 2026) and the club's public-liability renewal (30 April 2027) are undeclared.
    // - provider is Thornbury Bowls & Social Club.
    // - reference is membership number TBSC-0447.
    // - costMinor is the annual subscription, 65.00; the green fee (3.00 per session), the social-only tier (25.00, a different membership category) and the joining fee (10.00, waived for on-time renewal) are traps.
    // - recurrenceMonths is 12, printed in digits as 'a 12-month membership'.
    // - subtype: Membership. scheduleKind is 'renewal', taken from the renewal dateRole (which is declared first, ahead of 'start', in print order).
    name: "social club subscription renewal, a lower social-only tier and a joining fee as decoy prices",
    filename: "fullpage-social-club-subscription-renewal.pdf",
    text: "Thornbury Bowls & Social Club — subscription renewal  \n\nThornbury Bowls & Social Club The Green, Thornbury Lane, Barchester, BR4 2QW · est. 1924 \n\nAnnual subscription renewal notice \n\nDear Mr Okonkwo, \n\nYour membership of Thornbury Bowls & Social Club is due for renewal. Please find your renewal details below, and pay at the bar or by bank transfer before the due date to keep your membership active. \n\nMember Mr Patrick Okonkwo, member since 2018 \n\nMembership number TBSC-0447 \n\nMembership year 1 November 2026 to 31 October 2027 \n\nRenewal due 31 October 2026 \n\nAnnual subscription due £65.00 \n\nThis is a 12-month membership, renewing each 1 November. Bowls green fees remain £3.00 per session for members and are not part of this subscription. Social membership only, without use of the green, is available separately at £25.00 a year, but is not the category held on this account. \n\nSubscriptions unpaid by 30 November 2026 will lapse without further notice, and re-joining after that date requires a new application and the £10.00 joining fee, waived for existing members who renew on time. The club’s AGM this year is on 14 November 2026, after the renewal deadline, and only paid-up members may vote. \n\nThornbury Bowls & Social Club is an unincorporated members’ club. Public liability insurance for the green and clubhouse renews each April; the current cover runs to 30 April 2027. \n\nThornbury Bowls & Social Club · Membership TBSC-0447 Page 1 of 1\n",
    expected: {
    dates: ["2026-10-31","2026-11-01"],
    provider: "Thornbury Bowls & Social Club",
    reference: "TBSC-0447",
    dateRoles: [
      { date: "2026-10-31", role: "renewal" },
      { date: "2026-11-01", role: "start" },
    ],
    subtype: {"kinds":["Membership"]},
    costMinor: 6500,
    currency: "GBP",
    recurrenceMonths: 12,
    scheduleKind: "renewal",
    },
  },
  {
    // Ground-truth notes:
    // - dates: receipt issued 9 September 2026 (the same day the will was deposited, printed twice under different labels but declared once), next storage fee due 9 September 2027. The will's own drafting date (2 September 2026), the unrelated closed deed box date (3 June 2025) and the firm's indemnity-insurance renewal (31 December 2026) are undeclared.
    // - provider is Hawksmoor & Reed Solicitors.
    // - reference is the storage reference HRS-DB-2261.
    // - costMinor is the annual storage fee, 15.00; no fee was charged for the initial deposit, which is why it is the recurring fee, not zero, that is declared.
    // - recurrenceMonths is 12, printed in digits as 'every 12 months thereafter'.
    // - subtype: Will. scheduleKind is 'renewal', derived from the renewal dateRole.
    name: "will storage receipt, an unrelated deed box closure sits beside the annual storage fee",
    filename: "fullpage-will-storage-receipt.pdf",
    text: "Hawksmoor & Reed Solicitors — will storage receipt  \n\nHawksmoor & Reed Solicitors \n\n14 Chancery Row, Barchester, BR2 1QJ · Regulated by the Solicitors Regulation Authority, No. 552817 \n\nReceipt for safe custody of your will \n\nClient Mrs Eleanor Whitcombe, 8 Larch Grove, Barchester, BR3 4LP \n\nDocument held Last Will and Testament, dated 2 September 2026 \n\nStorage reference Deed box HRS-DB-2261 \n\nDate deposited 9 September 2026 \n\nReceipt issued 9 September 2026 \n\nNext storage fee due 9 September 2027 \n\nWe confirm safe receipt of the document described above, which has been placed in our fireproof strongroom under \n\nstorage reference HRS-DB-2261. This receipt should be kept somewhere separate from the will itself, and produced or \n\nreferred to whenever the will needs to be retrieved. \n\nAn annual storage fee of £15.00 applies from the first anniversary of deposit and every 12 months thereafter, and will be \n\ninvoiced separately each year; the first such fee falls due on 9 September 2027. No fee was charged for the initial deposit. A \n\nseparate, unrelated deed box held for Mrs Whitcombe’s late father, opened in 2014, was closed and its contents returned to \n\nthe family on 3 June 2025. \n\nThe will may be released only to the client in person, to a person she authorises in writing, or, after her death, to her named \n\nexecutor on production of the death certificate. There is no charge for retrieval by the client during her lifetime. \n\nFor Hawksmoor & Reed Solicitors: J. Hawksmoor, Partner · 9 September 2026 \n\nHawksmoor & Reed Solicitors is the trading name of Hawksmoor & Reed LLP, registered in England and Wales, No. OC402217, registered office as above. This firm’s professional indemnity insurance renews each December; the current period runs to 31 December 2026. \n\nDEPOSITED \n\nHawksmoor & Reed Solicitors · Deed box HRS-DB-2261 Page 1 of 1\n",
    expected: {
    dates: ["2026-09-09","2027-09-09"],
    provider: "Hawksmoor & Reed Solicitors",
    reference: "HRS-DB-2261",
    dateRoles: [
      { date: "2026-09-09", role: "issued" },
      { date: "2027-09-09", role: "renewal" },
    ],
    subtype: {"kinds":["Will"]},
    costMinor: 1500,
    currency: "GBP",
    recurrenceMonths: 12,
    scheduleKind: "renewal",
    },
  },
];
