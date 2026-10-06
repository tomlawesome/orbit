// Who the household deals with (owner, 2026-09-12: "a second approach that
// runs after the sieve ... two real company names but the one we want
// appears less times"). The bins say who is printed most; this says who
// acts. It only judges names already on the shortlist, one vote per cue
// kind, so a firm printed twenty times gains nothing here for the twenty.
//
// Read off the seen misses, where the wanted firm lost to another real name:
//   * "Kelbridge Home Loans is a trading name of Priorswood Bank plc" -- the
//     trading name is the provider, the owner behind it is not;
//   * "for and on behalf of Calderwell", "produced by Greenline", "signature
//     for Northgate", "made payable to Purbeck & Vane", "contact Hedgerow",
//     "queries ... sent to accounts@bridgewaterliving" -- the firm that acts,
//     signs, is paid or is written to;
//   * the rival was the insurer behind a broker, the university behind its
//     halls contractor, the freeholder behind its managing agent, or not a
//     firm at all: the customer (Mr & Mrs Whitlock), a county (Cravenshire),
//     a street (Larkspur Avenue), a registration mark (KV24 HRG).

import { NOT_A_NAME } from "./provider-caps-mentions";

const ACTS_FOR = [
  "on behalf of", "for and on behalf of", "signature for", "signed for", "produced by", "issued by",
  "provided by", "administered by", "arranged by", "arranged and administered by", "managed by", "prepared by",
  "made payable to", "payable to", "contact", "write to", "writing to", "tell", "notify", "raise these first with",
  "queries about", "sent to", "from", "your supplier", "your provider", "your insurer", "your lender", "your landlord",
  "managing agent", "managing agents", "trading as", "t/a", "we,", "we are",
];
const BEHIND = [
  "underwritten by", "authorised and regulated by", "authorised by", "regulated by", "registered with", "a member of",
  "on behalf of", "a subsidiary of", "part of", "owned by", "licensed by", "complain to", "refer to", "arranged for",
  "for", "the landlord", "the freeholder", "the university",
];
const PERSON = /\b(?:mr|mrs|ms|miss|dr|mx|customer|keyholder|tenant|policyholder|account holder|the insured|landlord)\b\.?\s*(?:&\s*(?:mr|mrs|ms)\s*)?(?:[A-Z]\.\s*)*$/iu;
const ADDRESS_AFTER = /^\s*,?\s*(?:[A-Z]{1,2}\d{1,2}[A-Z]?\s*\d[A-Z]{2}\b|[A-Z]{1,2}\d{1,2}\b)/u;
const STREET = /\b(?:avenue|road|street|lane|close|drive|way|court|rise|row|park|estate|house)$/iu;
const REG_MARK = /^[A-Z]{2}\d{2}\s+[A-Z]{3}$/u;

function escapeRegExp(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/gu, "\\$&");
}

function hasCue(before: string, cues: readonly string[]): string | undefined {
  const tail = before.toLowerCase().slice(-60);
  return cues.find((cue) => new RegExp(`\\b${escapeRegExp(cue)}\\s*:?\\s*$`, "u").test(tail));
}

export interface DealingVote { cue: string; weight: number }

/** Votes for `name` being the firm the page is from. */
export function dealingVotes(text: string, name: string): DealingVote[] {
  const votes = new Map<string, number>();
  const vote = (cue: string, weight: number): void => { votes.set(cue, weight); };
  if (REG_MARK.test(name)) vote("registration mark", -4);
  if (NOT_A_NAME.has(name.toLowerCase())) vote("not a name", -5);
  if (STREET.test(name)) vote("street", -3);

  const label = name.toLowerCase().replace(/[^a-z0-9]+/gu, "");
  if (label.length >= 4) {
    const domains = text.toLowerCase().match(/(?<=@|www\.|https?:\/\/)[a-z0-9-]+(?=\.)/gu) ?? [];
    if (domains.some((domain) => domain.replace(/-/gu, "") === label
      || (label.length >= 6 && domain.replace(/-/gu, "").startsWith(label.slice(0, 6))))) vote("own web/e-mail domain", 3);
  }

  const pattern = new RegExp(`(^|[^A-Za-z0-9])${escapeRegExp(name)}(?![A-Za-z0-9])`, "giu");
  const lines = text.split("\n");
  const letterhead = lines.findIndex((line) => line.trim() !== "");
  lines.forEach((line, lineAt) => {
    for (const match of line.matchAll(pattern)) {
      if (/(?:©|\(c\)|copyright)\s*(?:\d{4})?\s*$/iu.test(line.slice(0, (match.index ?? 0) + (match[1] as string).length))) vote("copyright line", 3);
      const at = (match.index ?? 0) + (match[1] as string).length;
      const before = line.slice(0, at);
      const after = line.slice(at + name.length);
      if (/^\s+is\s+a\s+trading\s+name\s+of\b/iu.test(after)) vote("is a trading name of", 4);
      if (/\b(?:is\s+)?a\s+trading\s+name\s+of\s*$/iu.test(before)) vote("the name behind a trading name", -4);
      if (PERSON.test(before)) vote("a person, not a firm", -4);
      if (ADDRESS_AFTER.test(after)) vote("in an address", -2);
      // "from Cravenshire District Council" is not a cue for "Cravenshire":
      // a name printed inside a longer run of capitalised words is a
      // fragment of that run, and the run gets the vote, not the fragment.
      if (/^\s+(?:&\s+|of\s+|and\s+)?[A-Z][a-z]/u.test(after)) continue;
      if (lineAt === letterhead && /\s/u.test(name.trim())) vote("first line of the page", 1);
      const acts = hasCue(before, ACTS_FOR);
      const behind = hasCue(before, BEHIND);
      if (acts !== undefined && (behind === undefined || acts.length >= behind.length)) vote(`acts: ${acts}`, 2);
      else if (behind !== undefined) vote(`behind: ${behind}`, -2);
    }
  });
  return [...votes].map(([cue, weight]) => ({ cue, weight }));
}

export function dealingScore(text: string, name: string): number {
  return dealingVotes(text, name).reduce((sum, vote) => sum + vote.weight, 0);
}
