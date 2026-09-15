// Stage 2's provider sieves (ADR-0026's amendment, owner 2026-09-11).
// Several independent ways of looking at one organisation, each a small
// named function, none of them allowed to discard anything.
//
// Until now exactly one sieve looked at an organisation: the words printed
// beside it ("administered by", "underwritten by"). A page that names its
// sender only in a footer on every sheet, or only in the address block a
// letter is signed off from, or only next to the web address the household
// is told to use, says who it is in a way no trigger table can hear -- and
// on paper nobody has seen, that is most pages.
//
// So every organisation is read several ways at once, each asking the same
// question a different way: is this the organisation the household would
// contact, under the name they would use?
//
//   language-fact       what the page says the organisation is: a trading
//                       name, sold/arranged/administered by, acting for --
//                       and, against, the parent, the underwriter, the
//                       regulator, the installer
//   contact-details     the name shares a distinctive word, or its
//                       initials, with an e-mail domain or web address
//                       printed on the page: whoever the household is told
//                       to write to
//   contact-block       the name is printed inside a block that tells the
//                       household how to get in touch -- "contact us",
//                       "customer services", "enquiries" -- with the
//                       number or address to do it
//   printed-throughout  the name is printed in several places, or in a
//                       running header or footer, rather than once: a page
//                       repeats whose paper it is and mentions everyone
//                       else once
//   address-of          the name a letter frame belongs to: what a sign-off
//                       is given for, or what a "From" line names. Against,
//                       a registered-office or company-number block, which
//                       names the legal entity -- a reason against where
//                       the page also prints a trading name
//   name-as-heading     the name is printed as a heading rather than inside
//                       a sentence: the masthead a document carries is its
//                       sender's
//   overseer-name       against: the name's own words say the body oversees
//                       a trade rather than sells to a household -- an
//                       ombudsman, a compensation scheme, a conduct
//                       authority
//
// Each sieve returns a vote, never a decision: a tag, the words that
// justified it, and how good a reason that is. Votes merge into tags by tag
// value, so an organisation several sieves agree about carries one tag
// naming all of them (`Tag.sieves`), and stage 3 can tell a name four
// sieves kept from one a single weak sieve kept. Nothing here drops a
// candidate, and a sieve that says nothing about one costs it nothing.
//
// None of these sieves may key on where a name sits on the page, or on how
// the 24 tuning documents behave (owner, 2026-09-11). "Printed in a running
// footer" is a property of the whole document, not a position on it; "the
// first line of the page" would be a position, and is not here.

import { hasOrganisationForm } from "./extraction-sieve";
import {
  STRENGTH_STATED,
  STRENGTH_WEAK,
  type OrganisationTag,
  type Tag,
} from "./extraction-stages";

/** An organisation the sieve found, with everything a stage 2 sieve may
 * read: the name as printed, where it is, and the Tika block it sits in. */
export interface OrganisationCandidate {
  value: string;
  index: number;
  line: string;
}

/** One sieve's reading of one organisation. `weight` is the shared scale:
 * 2 the page says so in words, 1 a weaker reading that could still be
 * right. */
export interface ProviderVote {
  sieve: string;
  tag: OrganisationTag;
  /** The words on the page that justified it, verbatim where the page
   * printed words, or a short statement of the fact where it did not. */
  trigger: string;
  weight: number;
}

export interface ProviderSieve {
  name: string;
  read: (
    candidate: OrganisationCandidate,
    all: readonly OrganisationCandidate[],
    page: PageFacts,
  ) => ProviderVote[];
}

/** The name the language-fact pass records: the trigger table stage 2 has
 * always run, as a vote on the same scale as the rest. */
export const LANGUAGE_FACT = "language-fact";

// --------------------------------------------------------------- names

function comparable(value: string): string {
  return value.replace(/\s+/gu, " ").trim().toLowerCase();
}

const LEGAL_SUFFIXES = ["ltd", "ltd.", "limited", "plc", "plc.", "llp", "cic", "llc", "inc", "inc."];

/** Words that join a name rather than name anything, and the company forms
 * every second organisation ends on. Neither tells one organisation from
 * another, so neither is a distinctive word. */
const GENERIC_WORDS = new Set([
  ...LEGAL_SUFFIXES,
  "the", "and", "for", "of", "with", "to", "by", "a", "an",
  "group", "holdings", "company", "services", "service", "solutions",
  "partners", "partnership", "limited", "international", "national", "uk",
]);

function nameWords(value: string): string[] {
  return value
    .replace(/[^A-Za-z0-9&'’ -]/gu, " ")
    .split(/\s+/u)
    .filter((word) => word.length > 0);
}

/** The name with its leading connective and trailing company form removed,
 * which is the form two printings of one organisation agree on:
 * "of Millbrook Energy Ltd" and "MILLBROOK ENERGY" are one name. */
export function bareName(value: string): string {
  const words = nameWords(value).filter((word) => word !== "&" && word !== "-");
  while (words.length > 0 && /^(?:of|by|for|with|to|and|the)$/iu.test(words[0])) words.shift();
  while (words.length > 0 && LEGAL_SUFFIXES.includes(words[words.length - 1].toLowerCase())) words.pop();
  return comparable(words.join(" "));
}

/** Two printings of one organisation, the company form optional on both
 * sides -- the comparison the scorer makes, made here without reaching for
 * the scorer. */
export function sameOrganisation(left: string, right: string): boolean {
  const first = bareName(left);
  const second = bareName(right);
  return first.length > 0 && first === second;
}

/** The words of a name that could tell it from another organisation's:
 * long enough to mean something, and not a company form or a connective. */
function distinctiveWords(value: string): string[] {
  return nameWords(value)
    .map((word) => word.toLowerCase())
    .filter((word) => word.length >= 4 && !GENERIC_WORDS.has(word));
}

/** The connectives and company forms nobody puts in an abbreviation. */
const NOT_ABBREVIATED = new Set([...LEGAL_SUFFIXES, "the", "and", "for", "of", "with", "to", "by", "a", "an", "&"]);

/** The letters a name is abbreviated to -- "Highways and Vehicle Licensing
 * Authority" is "hvla" -- ignoring the words nobody abbreviates. */
function initialsOf(value: string): string {
  return nameWords(value)
    .filter((word) => !NOT_ABBREVIATED.has(word.toLowerCase()))
    .map((word) => word[0].toLowerCase())
    .join("");
}

// ----------------------------------------------------------- page facts

/**
 * What the sieves read that is a fact about the whole page rather than
 * about one candidate: worked out once per document, because a page has
 * thirty organisations on it and every one of them would otherwise re-read
 * it.
 */
export interface PageFacts {
  text: string;
  /** Every host printed on the page, as printed, with its labels. */
  hosts: Array<{ printed: string; labels: string[] }>;
  /** Where a letter is signed off, and how the page signed it: the run of
   * page after each is where the sender's own name is printed. */
  signOffs: Array<{ from: number; trigger: string }>;
  /** The names the language-fact sieve read as the organisation the
   * household deals with: what a registered-office block is a reason
   * against (see `addressOf`). */
  statedProviders: string[];
}

/** An e-mail address: the host is the half that names the organisation. */
const EMAIL = /[A-Za-z0-9._%+-]+@([A-Za-z0-9-]+(?:\.[A-Za-z0-9-]+)+)/gu;

/**
 * A web address, matched in lower case on purpose. A host is printed in
 * lower case and a sentence is not, so "millbrookenergy.example/help" is
 * read and "safety.The next section" is not -- which is the whole of the
 * difference between a domain and a full stop with no space after it.
 */
const HOST = /\b(?:https?:\/\/)?([a-z0-9][a-z0-9-]{1,}(?:\.[a-z0-9-]{2,}){1,3})\b/gu;

/** Host labels that say where a name is registered rather than what it is.
 * Matching one of these would make every page's every organisation a
 * contact match. */
const HOST_NOISE = new Set([
  "www", "com", "co", "uk", "net", "org", "gov", "ac", "io", "info", "biz",
  "example", "email", "mail", "online", "site", "web", "app", "eu", "ie",
]);

function hostsOn(text: string): Array<{ printed: string; labels: string[] }> {
  const found: Array<{ printed: string; labels: string[] }> = [];
  const seen = new Set<string>();
  const add = (printed: string) => {
    const host = printed.toLowerCase().replace(/^https?:\/\//u, "");
    if (seen.has(host)) return;
    seen.add(host);
    const labels = host.split(".").filter((label) => !HOST_NOISE.has(label) && label.length >= 3);
    if (labels.length > 0) found.push({ printed: host, labels });
  };
  for (const match of text.matchAll(EMAIL)) add(match[1]);
  for (const match of text.matchAll(HOST)) add(match[1]);
  return found;
}

// ---------------------------------------------------------- language fact

/**
 * The tags that say the page stated who the household deals with.
 *
 * - `provider`: the page said so outright, which includes the brand in
 *   front of "is a trading name of".
 * - `administrator`: the body that runs or sold the plan is the one the
 *   household writes to and pays, which is what this field means.
 * - `on-behalf-of`: the principal a signature was given for.
 */
export const PRINCIPAL_TAGS = ["provider", "administrator", "on-behalf-of"];

/**
 * Which `administrator` trigger is evidence of a provider: the words for
 * running or selling the household's own plan. "Managed by" is not among
 * them -- it says who runs an investment fund inside the plan, which the
 * household has no dealings with.
 */
const SELLS_OR_ADMINISTERS = /administer|arrang|sold by|intermediary|broker/iu;

/** Whether this tag, with these trigger words, is the page stating who the
 * household deals with. */
export function statesTheProvider(tagValue: string, trigger: string): boolean {
  if (!PRINCIPAL_TAGS.includes(tagValue)) return false;
  return tagValue === "administrator" ? SELLS_OR_ADMINISTERS.test(trigger) : true;
}

/**
 * The trigger table's reading as a vote, voting exactly what the words
 * said: "administered by" is an administrator and "on behalf of" a
 * principal, and which of those the page used still matters to stage 3 --
 * an insurer is named on behalf of somebody on every policy, and the firm
 * that sold the plan is a better answer than the firm behind it. Stage 3
 * reads the ones that are not a reason FOR as reasons against, exactly as
 * it always has.
 */
export function languageFactVote(tag: Tag<"organisation">): ProviderVote {
  return {
    sieve: LANGUAGE_FACT,
    tag: tag.value,
    trigger: tag.trigger,
    weight: tag.trigger.trim() === "" ? STRENGTH_WEAK : STRENGTH_STATED,
  };
}

// ------------------------------------------------------- contact-details

const contactDetails: ProviderSieve = {
  name: "contact-details",
  read: (candidate, _all, page) => {
    const words = distinctiveWords(candidate.value);
    const initials = initialsOf(candidate.value);
    for (const host of page.hosts) {
      for (const label of host.labels) {
        const matched = words.some((word) => label.includes(word)) ||
          (initials.length >= 3 && label === initials);
        if (!matched) continue;
        return [{
          sieve: "contact-details",
          tag: "provider",
          trigger: host.printed,
          weight: STRENGTH_STATED,
        }];
      }
    }
    return [];
  },
};

// --------------------------------------------------------- contact-block

/** A block telling the household how to reach somebody. The words are the
 * ones UK paper heads such a block with; nothing here is about where the
 * block sits. */
const CONTACT_INVITATION =
  /\bcontact us\b|\bcall us\b|\bcustomer (?:services?|support|care)\b|\benquir|\bhelpline\b|\bhelp ?desk\b|\bwrite to us\b|\bget in touch\b|\bemail us\b|\bspeak to us\b|\bto contact\b|\bcontact\b[^.]{0,20}\busing\b/iu;

/** Something to reach them by, in the same block: a telephone number, an
 * e-mail address, a web address. */
const CONTACT_DETAIL = /\b0\d[\d\s]{7,}\b|@[A-Za-z0-9-]+\.[A-Za-z]{2,}|\b[a-z0-9-]{3,}\.[a-z]{2,}\b/u;

const contactBlock: ProviderSieve = {
  name: "contact-block",
  read: (candidate) => {
    const { line } = candidate;
    if (!CONTACT_INVITATION.test(line)) return [];
    return [{
      sieve: "contact-block",
      tag: "provider",
      trigger: line.slice(0, 60).trim(),
      weight: CONTACT_DETAIL.test(line) ? STRENGTH_STATED : STRENGTH_WEAK,
    }];
  },
};

// ---------------------------------------------------- printed-throughout

/** Two printings of one name inside this much page are one printing that
 * the sieve's several patterns found twice, not the page saying it twice. */
const ONE_PRINTING = 80;
/** How many separate printings make a name the page carries rather than
 * mentions. */
const RUNNING_PRINTINGS = 3;
/** And how much of the document those printings have to span before they
 * are a running header or footer rather than one dense block. */
const RUNNING_SPREAD = 0.5;

/** Where this organisation is printed, one entry per printing: sightings
 * closer together than `ONE_PRINTING` are the same printing. */
function printingsOf(
  candidate: OrganisationCandidate,
  all: readonly OrganisationCandidate[],
): number[] {
  const at = all
    .filter((entry) => sameOrganisation(entry.value, candidate.value))
    .map((entry) => entry.index)
    .sort((left, right) => left - right);
  const printings: number[] = [];
  for (const index of at) {
    if (printings.length === 0 || index - printings[printings.length - 1] > ONE_PRINTING) printings.push(index);
  }
  return printings;
}

const printedThroughout: ProviderSieve = {
  name: "printed-throughout",
  read: (candidate, all) => {
    const printings = printingsOf(candidate, all);
    if (printings.length < 2) return [];
    const reach = all.length === 0
      ? 0
      : Math.max(...all.map((entry) => entry.index)) - Math.min(...all.map((entry) => entry.index));
    const spread = reach === 0 ? 0 : (printings[printings.length - 1] - printings[0]) / reach;
    const running = printings.length >= RUNNING_PRINTINGS && spread >= RUNNING_SPREAD;
    return [{
      sieve: "printed-throughout",
      tag: "provider",
      trigger: running
        ? `printed ${printings.length} times across the document`
        : `printed ${printings.length} times`,
      weight: running ? STRENGTH_STATED : STRENGTH_WEAK,
    }];
  },
};

// ------------------------------------------------------------ address-of

/** How a letter is signed off, and how far after it the sender's own name
 * is printed: the sign-off, a person's name, their job title, then the
 * organisation. */
const SIGN_OFF = /\byours (?:sincerely|faithfully|truly)\b|\bkind regards\b|\bbest regards\b|\bsigned for and on behalf of\b/giu;
const SIGN_OFF_REACH = 240;

/** A block that says who a letter or message is from. */
const FROM_LINE = /^(?:from|sender|issued by)\b[:\s]/iu;

/** The small print that names the legal entity: the registered office, the
 * company number, the VAT line. */
const REGISTERED_ENTITY =
  /\bregistered office\b|\bregistered in (?:england|scotland|wales|northern ireland)\b|\bregistered (?:number|no\.?)\b|\bcompany (?:registration )?(?:number|no\.?)\b|\bvat (?:registration )?(?:number|no\.?)\b|\bincorporated in\b/iu;

const addressOf: ProviderSieve = {
  name: "address-of",
  read: (candidate, _all, page) => {
    for (const signOff of page.signOffs) {
      if (candidate.index >= signOff.from && candidate.index < signOff.from + SIGN_OFF_REACH) {
        return [{
          sieve: "address-of",
          tag: "provider",
          trigger: signOff.trigger,
          weight: STRENGTH_STATED,
        }];
      }
    }
    if (FROM_LINE.test(candidate.line)) {
      return [{ sieve: "address-of", tag: "provider", trigger: candidate.line.slice(0, 40), weight: STRENGTH_WEAK }];
    }
    // The legal entity, where the page also prints a trading name: the
    // household's account is with the name on the paper, not with the
    // company the small print registers (owner, 2026-09-11). Where no
    // trading name is stated, a registered-office block is the only place
    // some pages name their sender, so it says nothing against.
    if (REGISTERED_ENTITY.test(candidate.line)) {
      const tradingNameElsewhere = page.statedProviders.some(
        (name) => !sameOrganisation(name, candidate.value),
      );
      if (tradingNameElsewhere) {
        const match = REGISTERED_ENTITY.exec(candidate.line);
        return [{
          sieve: "address-of",
          tag: "legal-entity",
          trigger: match ? match[0] : "registered office",
          weight: STRENGTH_WEAK,
        }];
      }
    }
    return [];
  },
};

// ------------------------------------------------------- name-as-heading

/** A block printed as a heading rather than as a sentence: short, few
 * words, and not punctuated as prose. The same reading `extraction-sieve.ts`
 * makes of a heading, applied to the block a name sits in. */
function headingShaped(line: string): boolean {
  if (line.length < 3 || line.length > 80) return false;
  if (line.split(" ").length > 10) return false;
  return !/[.;!?]$/u.test(line);
}

/** How much of the heading the name has to be. A masthead is mostly the
 * sender's name; a heading that merely mentions one in passing is not. */
const HEADING_SHARE = 0.3;

const nameAsHeading: ProviderSieve = {
  name: "name-as-heading",
  read: (candidate) => {
    const { line } = candidate;
    if (!headingShaped(line)) return [];
    if (candidate.value.length / line.length < HEADING_SHARE) return [];
    // A heading is only a masthead when what it prints is a name. Tika
    // hands the sieve every capitalised line on the page -- "DIRECT DEBIT
    // GUARANTEE", "CUSTOMER SERVICES" -- and none of those is an
    // organisation whatever else agrees with them.
    if (!hasOrganisationForm(candidate.value)) return [];
    return [{ sieve: "name-as-heading", tag: "provider", trigger: line, weight: STRENGTH_WEAK }];
  },
};

// ----------------------------------------------------------- overseer-name

/**
 * A name whose own words say the body's job is oversight, redress or
 * carrying somebody else's risk: an ombudsman, a compensation scheme, a
 * conduct authority, an underwriting or reinsurance company. Every page in
 * a regulated trade prints one, and it is never who the household holds the
 * account with -- so this is a reason against, whatever else agrees.
 *
 * The words are the job, not the organisation: "Licensing Authority" and
 * "Water Services" are trades a household does deal with and are not here.
 */
const OVERSEER_NAME =
  /\bombudsman\b|\bcompensation scheme\b|\b(?:conduct|regulation|regulatory) authority\b|\btrading standards\b|\bcomplaints? (?:service|scheme|body)\b|\badjudicator\b|\bunderwrit(?:ing|ers?)\b|\breinsurance\b/iu;

const namedAsOverseer: ProviderSieve = {
  name: "overseer-name",
  read: (candidate) => {
    const match = OVERSEER_NAME.exec(candidate.value);
    if (!match) return [];
    return [{ sieve: "overseer-name", tag: "regulator", trigger: match[0], weight: STRENGTH_STATED }];
  },
};

// ------------------------------------------------------------- the set

/** Every sieve that reads one organisation at a time, in the order their
 * votes are recorded. `language-fact` is not here: it reads the tag the
 * trigger table already produced, so it is run by `runProviderSieves`. */
export const PROVIDER_SIEVES: readonly ProviderSieve[] = [
  contactDetails,
  contactBlock,
  printedThroughout,
  addressOf,
  nameAsHeading,
  namedAsOverseer,
];

/** Every sieve's name, the language fact first, for reports and for
 * ordering the names on a tag. */
export const PROVIDER_SIEVE_NAMES: readonly string[] = [
  LANGUAGE_FACT,
  ...PROVIDER_SIEVES.map((sieve) => sieve.name),
];

/** Everything the sieves read about the page as a whole, worked out once.
 * `labels` is the trigger table's tag per candidate, which is what says
 * whether the page states a trading name at all. */
export function providerPageFacts(
  text: string,
  candidates: readonly OrganisationCandidate[],
  labels: ReadonlyArray<Tag<"organisation"> | undefined>,
): PageFacts {
  const statedProviders: string[] = [];
  candidates.forEach((candidate, at) => {
    const label = labels[at];
    if (label && statesTheProvider(label.value, label.trigger)) statedProviders.push(candidate.value);
  });
  const signOffs = [...text.matchAll(SIGN_OFF)].map((match) => ({
    from: (match.index ?? 0) + match[0].length,
    trigger: match[0].trim(),
  }));
  return { text, hosts: hostsOn(text), signOffs, statedProviders };
}

/** Every sieve's votes for every organisation, in `PROVIDER_SIEVES` order,
 * the language fact first. */
export function runProviderSieves(
  text: string,
  candidates: readonly OrganisationCandidate[],
  labels: ReadonlyArray<Tag<"organisation"> | undefined>,
): ProviderVote[][] {
  const page = providerPageFacts(text, candidates, labels);
  return candidates.map((candidate, at) => {
    const votes: ProviderVote[] = [];
    const label = labels[at];
    if (label) votes.push(languageFactVote(label));
    for (const sieve of PROVIDER_SIEVES) votes.push(...sieve.read(candidate, candidates, page));
    return votes;
  });
}

/**
 * The votes for one organisation merged into tags, one per tag value.
 *
 * A tag names every sieve that agreed on it and how strong the best of them
 * was, which is what lets stage 3 float a name four sieves kept above one a
 * single weak sieve kept. The language fact comes first, so every caller
 * that reads `tags[0]` still finds the label the page printed.
 */
export function providerTagsFromVotes(votes: readonly ProviderVote[]): Tag<"organisation">[] {
  const byTag = new Map<OrganisationTag, ProviderVote[]>();
  for (const vote of votes) {
    const held = byTag.get(vote.tag);
    if (held) held.push(vote);
    else byTag.set(vote.tag, [vote]);
  }

  const tags: Array<{ tag: Tag<"organisation">; strength: number }> = [];
  for (const [value, cast] of byTag) {
    const strength = Math.max(...cast.map((vote) => vote.weight));
    const strongest = cast.find((vote) => vote.weight === strength) as ProviderVote;
    const names = PROVIDER_SIEVE_NAMES.filter((name) => cast.some((vote) => vote.sieve === name));
    // Where the words beside the name were the only sieve that spoke, the
    // tag is left exactly as stage 2 has always produced it: `sieves` and
    // `strength` absent means "the label, as before".
    const alone = names.length === 1 && names[0] === LANGUAGE_FACT;
    tags.push({
      strength,
      tag: {
        value,
        trigger: strongest.trigger,
        source: "label",
        ...(alone ? {} : { sieves: names, strength }),
      },
    });
  }

  const languageFactTag = votes.find((vote) => vote.sieve === LANGUAGE_FACT)?.tag;
  return tags
    .sort((left, right) => {
      if (left.tag.value !== right.tag.value) {
        if (left.tag.value === languageFactTag) return -1;
        if (right.tag.value === languageFactTag) return 1;
      }
      return right.strength - left.strength;
    })
    .map((entry) => entry.tag);
}
