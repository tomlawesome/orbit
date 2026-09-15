# Provider stage 2: the rules and why each should generalise

Owner decision, 2026-09-12 (#996): the provider field gets its own stage 2,
in its own file, sharing nothing with the other fields' stages. The rules
below were written **before** the code, from a signal table over the tuning
24 (see "Evidence"). Each rule must be a fair generalisation about how
documents name their sender, not a fit to those 24. The test of that is a
single run on the second hold-out (#997), made once, after the code is
finished; the tuning number only proves the code does what this file says.

The rules are deliberately loose: the owner's constraint is that anything
keyed tightly on *where* a name sits will break over a large corpus. Every
rule here reads the whole document; none reads a position on the page.

Every rule is a vote with a weight, for or against. None removes a
candidate. Stage 3 sums the votes and answers `undefined` on a tie.

## The question the field asks

Who does the household deal with, under the name they would use? Not the
underwriter, not the regulator, not the legal owner of a brand.

## Rules

### R1 Looks like an organisation (against, strong)

The candidate is not the shape of an organisation's name if it is: a
document label ("STATEMENT DATE", "Direct Debit", "PO Box", "MINIMUM
TERM"); a reference stub ending in a code prefix ("Account KB-", "Policy
MTR-"); a street ("Foundry Lane", "Cathedral Yard"); a person with a title
("Mr Aidan Voss"); or letter-spaced OCR debris ("F O R M W B").

*Why it generalises:* these are properties of the words themselves, true on
any page. A candidate sieve has to be greedy to reach recall, so most of
what it returns is not an organisation at all; this is the counterweight.

### R2 Printed throughout (for, proportional)

Weight rises with how many separate blocks of the page print the name,
relative to the most-printed organisation on that page.

*Why it generalises:* a document repeats whose paper it is (letterhead,
footer, "your X account") and names everyone else once or twice. On the
24 the true provider is the most-printed candidate outright on 13; of the
11 it is not, the winner is label noise or a street (R1) on 7, a role
alias (R4) on 2, a backer (R3b) on 2.

### R3a Stated as the principal (for)

Immediately before the name the page says one of: *from, issued by,
provided by, administered by, arranged by, managed by, welcome to, thank
you for choosing, your supplier/provider/insurer/lender/landlord*.

### R3b Stated as a backer (against)

Immediately before the name the page says one of: *underwritten by, a
trading name of, regulated by, authorised (and regulated) by, registered
with, a member of, complain to, refer to*; or the name itself is an
overseer (ombudsman, compensation scheme, conduct/regulation authority,
information commissioner, registrar).

*Why both generalise:* these phrases are how English documents assign
roles, and the role assigned is the whole distinction the field draws. An
underwriter, the legal entity behind a trading name, and a regulator are
each named on nearly every regulated document and are never the answer.
Note the first version of the analysis counted "underwritten by" and "a
trading name of" as *for* and they were wrong on every document they
fired on.

### R4 Known by its role (for, transfers R2 weight)

A page that keeps saying *the Club*, *the Council*, *the Authority*, *the
Practice*, *the Scheme*, *the Company*, *the Society*, *the Bank*, *the
Trust* is naming one party by its role. Those mentions count as printings
of the one full name that ends in that word; if several full names end in
it, the one already printed most.

*Why it generalises:* legal and membership documents define a short form
once ("Cresswell Fitness Club (the Club)") and use it thereafter, so the
full name is printed once and the role dozens of times. This is a vote,
not a decision: on an MOT certificate "the Authority" is the testing body
and the garage is still the answer, and R2/R5 must be allowed to outweigh
it.

### R5 Owns an address, gives contact details, or matches a web host (for, weak)

The name is followed within a few lines by a postcode; or sits in a block
with a phone number, e-mail address or "contact us"; or shares a
distinctive word or its initials with an e-mail or web host on the page.

*Why it generalises:* the sender tells the household how to reach it; a
regulator's address is printed too, so this stays weak and R3b outweighs
it.

## Evidence

Signal table over the tuning 24 (scratch script, not committed): for each
document the true provider and its four most-printed rivals, with counts of
printings, blocks, principal cues, backer cues, contact-block hits, host
match, address ownership. Findings that shaped the rules:

- True provider is the most-printed candidate on 13/24 before R1. The 11
  exceptions: 7 lose to label noise, a street, a breed, a document title
  or a product name ("Roadside Assist" -- a product name is a known gap
  R1 does not close); 2 to a role alias ("the Club", "the Authority");
  2 to a backer (an underwriter, the bank behind a lender's brand).
- Backer cues (`regulated by`, FCA/PRA names) fire on the truth at most
  once, and on regulators every time they are printed.
- "underwritten by" / "a trading name of" fired only on non-answers
  (Corvane, Thornfield Assurance, Cresswell Leisure, Anglia Communications,
  Priorswood Bank).
- Address ownership and contact-block presence are true of the provider on
  ~half the documents and of a rival nearly as often: weak, kept weak.
- The true provider's first printing is in the top 3% of the page on 15/24.
  Not used: positional, and the owner has ruled positions out.

## What "trained to the set" would look like

If the hold-out score falls well below the tuning score, the rules above
are fitted, and the fix is to remove rules, not add them. The tuning
number is recorded on the experiment log only as a sanity check.
