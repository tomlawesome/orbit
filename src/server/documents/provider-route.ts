// Provider, read straight off the page (owner, 2026-09-12; #994, #996):
//
//   1. `capsMentions` -- every name the page prints as a name: capitalised
//      runs, a capital mid-sentence, a name before Ltd/plc, after "trading
//      as", a brand-shaped word (Pass2Drive), the label of the page's own
//      web or e-mail address.
//   2. word-run bins over those mentions (`providerWordRuns`), a domain
//      label counted DOMAIN_WEIGHT times: a firm whose letterhead was a logo
//      the OCR never read is still on the page as claims@homeguard365.co.uk.
//      The top SHORTLIST runs are the shortlist.
//   3. `dealingVotes` on each -- who acts, signs, is paid or written to --
//      one vote per cue kind, so a rival printed more often gains nothing
//      for the printings. Votes rank; the bins break ties.
//
// Measured against the shipped bins (`chooseProviderByRules`): 38/48 on the
// tuning pages and 12/12 on hold-out 3, from 31/48 and 7/12 (ADR-0026,
// amendment of 2026-09-12).
import { providerWordRuns, type WordRun } from "./extraction-provider-runs";
import { capsMentions, type CapsMention } from "./provider-caps-mentions";
import { dealingScore } from "./provider-dealing-cues";

/** How many times a web/e-mail domain label is binned: the smallest weight
 * at which a page naming its firm only in its addresses still puts it top
 * (2, 3, 4, 6 and 10 tried; 3 and above are level). */
export const DOMAIN_WEIGHT = 3;
const SHORTLIST = 8;

export interface ProviderPick {
  run: WordRun<CapsMention>;
  votes: number;
}

/** The shortlist, best first. */
export function providerPicks(text: string): ProviderPick[] {
  const mentions = capsMentions(text).flatMap((mention) =>
    (mention.rule === "domain" ? Array.from({ length: DOMAIN_WEIGHT }, () => mention) : [mention]));
  return providerWordRuns(mentions)
    .slice(0, SHORTLIST)
    .map((run, rank) => ({ run, rank, votes: dealingScore(text, run.display) }))
    .sort((a, b) => b.votes - a.votes || a.rank - b.rank)
    .map(({ run, votes }) => ({ run, votes }));
}

/** The name at the top, or nothing where the page names two things as
 * loudly as each other -- level on votes and on printings. */
export function chooseProviderFromPage(text: string): string | undefined {
  const [top, next] = providerPicks(text);
  if (top === undefined) return undefined;
  if (next !== undefined && next.votes === top.votes && next.run.count >= top.run.count) return undefined;
  return top.run.display;
}
