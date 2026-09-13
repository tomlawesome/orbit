// The contract between ADR-0026's three stages. Stage 1 (`extraction-sieve.ts`)
// produces `Candidate`s; stage 2 (`extraction-tags.ts`) turns each into a
// `TaggedCandidate`; stage 3 (`extraction-choose.ts`) turns the tagged
// shortlist into `ExtractedFields`. This file holds only the shapes and the
// closed tag vocabularies, so the stages can be built and measured apart.

import type { Candidate, CandidateKind } from "./extraction-sieve";
import type { ExtractedFields } from "./extraction-scoring";
import type { DocumentDateRole } from "./suggestions";

/** What the page says an amount is. `rival` is a figure printed beside the
 * real one to tempt a reader -- last year's premium, an upgrade tier, an
 * exit fee. */
export const AMOUNT_TAGS = [
  "total",
  "due",
  "instalment",
  "previous",
  "rival",
  "other",
] as const;
export type AmountTag = (typeof AMOUNT_TAGS)[number];

/**
 * What the page says an identifier is.
 *
 * The first seven can each be the household's own reference on a page of the
 * right kind, and which of them wins is decided by that kind
 * (`extraction-reference-kind.ts`). The six after them never can, whatever
 * else is printed beside them (`extraction-reference-never.ts`): `company`
 * is the organisation's own number (VAT, UTR, company registration, FCA firm
 * reference, and a checksum pass is one way to know it), `phone` a telephone
 * or fax number, `bank` the details a payment is sent to, `product` a model
 * or promotion code, `page` a sheet number, `web` a number printed inside an
 * address, `date` a printed date this sieve also matches.
 */
export const IDENTIFIER_TAGS = [
  "reference",
  "account",
  "policy",
  "agreement",
  "customer",
  "invoice",
  "certificate",
  "company",
  "phone",
  "bank",
  "product",
  "page",
  "web",
  "date",
  "other",
] as const;
export type IdentifierTag = (typeof IDENTIFIER_TAGS)[number];

/** What the page says an organisation's relationship to the household is.
 * `provider` is the one the household deals with -- who they pay, who
 * writes to them. The others are the traps a page prints beside it. */
export const ORGANISATION_TAGS = [
  "provider",
  "administrator",
  "underwriter",
  "on-behalf-of",
  "regulator",
  "installer",
  "subsidiary",
  /** The company as the small print names it: the registered office, the
   * company number, the VAT line. A legal entity is a fact about the
   * organisation, and where the page also prints a trading name it is a
   * reason against this being the name the household would use. */
  "legal-entity",
  "other",
] as const;
export type OrganisationTag = (typeof ORGANISATION_TAGS)[number];

/** Whether a short block is the document's own title or a section head. */
export const HEADING_TAGS = ["title", "section", "other"] as const;
export type HeadingTag = (typeof HEADING_TAGS)[number];

export type TagForKind = {
  date: DocumentDateRole;
  amount: AmountTag;
  identifier: IdentifierTag;
  organisation: OrganisationTag;
  heading: HeadingTag;
};

/** How good a reason a sieve has: the scale every stage 2 sieve votes on
 * and stage 3 scores a claim on. 2 the page says so in words, 1 a weaker
 * reading that could still be right, 0 a default with nothing behind it. */
export const STRENGTH_STATED = 2;
export const STRENGTH_WEAK = 1;
export const STRENGTH_GUESS = 0;

export interface Tag<K extends CandidateKind = CandidateKind> {
  value: TagForKind[K];
  /** The words on the page that justified the tag, verbatim, or "" for a
   * default. A tag with no trigger is a guess and must say so. */
  trigger: string;
  /** `label`: the trigger sits beside the candidate on the page (ConText).
   * `shape`: the candidate's own form says what it is (a checksum pass, a
   * capitalised letterhead line). */
  source: "label" | "shape";
  /**
   * The stage 2 sieves that agreed on this tag, strongest first
   * (`extraction-date-sieves.ts`). Several sieves naming one role is a
   * better reason than one, which is how stage 3 floats a date the page
   * described three ways above one it barely described at all.
   *
   * Absent means the words beside the candidate were the only sieve that
   * looked, which is what every tag was before dates grew more of them.
   */
  sieves?: readonly string[];
  /** How good the reason is: 2 the page says so in words, 1 a weaker
   * reading, 0 a default with nothing behind it. Absent means stage 3
   * reads it off the trigger, as it always has. */
  strength?: number;
}

export interface TaggedCandidate<K extends CandidateKind = CandidateKind> extends Candidate {
  kind: K;
  tags: Tag<K>[];
}

/** Stage 2: every candidate comes back with at least one tag; the default
 * for every kind is its `other` with an empty trigger. Order is preserved. */
export type TagStage = (text: string, candidates: readonly Candidate[]) => TaggedCandidate[];

/** Stage 3: a value per field or nothing. Blank is a first-class answer.
 * The page text is for provider alone (`provider-route.ts`, owner
 * 2026-09-12): its cues are read around each name on the page, not off the
 * candidates. Without it, provider falls back to the word-run bins. */
export type ChooseStage = (candidates: readonly TaggedCandidate[], text?: string) => ExtractedFields;
