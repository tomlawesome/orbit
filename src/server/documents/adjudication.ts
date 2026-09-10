import {
  comparableText,
  modelAdjudicateFields,
  modelProposalFromText,
  recordModelExtractionSample,
  type AdjudicationFieldCandidate,
  type ModelExtractionFailure,
  type ModelTransport,
} from "@/server/documents/model-extraction";
import { safeStoredDocumentProposal, type DocumentProposal } from "@/server/documents/suggestions";

/**
 * ADR-0025 section 4: the adjudication flow. The heuristics run on every
 * upload regardless; this module decides, field by field, whether the
 * model's independent (blind) reading of the same document agrees with
 * them, and spends a second, bounded inference only where they do not.
 *
 * Only the three fields the heuristics actually attempt are adjudicated.
 * `subtype`, `costMinor` and `recurrenceMonths` are model-only (ADR-0025
 * section 7): the heuristics never produce a reading for them, so no
 * disagreement can arise and they never reach the adjudicating pass.
 * Dates are not adjudicated at all (section 4): they are the union of both
 * extractors' validated dates, deduplicated, and adjudication never removes
 * one.
 */
export type AdjudicatedField = "title" | "provider" | "reference";

const ADJUDICATED_FIELDS: readonly AdjudicatedField[] = ["title", "provider", "reference"];

/** Matches the field lengths `suggestions.ts` and `model-extraction.ts` already validate to. */
const FIELD_MAX_LENGTH: Record<AdjudicatedField, number> = {
  title: 100,
  provider: 100,
  reference: 80,
};

export type AdjudicationOutcome =
  | "endorsed_heuristic"
  | "endorsed_blind"
  | "new_value"
  | "empty"
  | "failed";

export interface FieldComparison {
  field: AdjudicatedField;
  comparison: "agreed" | "disagreed" | "neither";
  /** Present only where `comparison === "disagreed"`. */
  outcome?: AdjudicationOutcome;
}

export interface AdjudicationResult {
  /** What the reviewer is offered. */
  proposal: DocumentProposal;
  /** Recorded, unchanged. */
  heuristic: DocumentProposal;
  /** `null` when the blind pass was skipped or failed. */
  blind: DocumentProposal | null;
  /** The rejected validated value, only where the two readings disagreed. */
  alternatives: Partial<Record<AdjudicatedField, string>>;
  comparisons: FieldComparison[];
  passes: 0 | 1 | 2;
  blindFailure?: ModelExtractionFailure;
  adjudicationFailure?: ModelExtractionFailure;
}

/**
 * Below this many milliseconds remaining, issuing the adjudicating pass
 * cannot land inside the document's own deadline, so it is skipped rather
 * than sent (ADR-0025 section 4, rule: "the deadline bounds the whole
 * flow"). Skipping is recorded as a timeout, exactly as a request that
 * missed its own deadline would be.
 */
const MIN_ADJUDICATION_BUDGET_MS = 200;

/**
 * Builds the object every proposal source is re-validated through. Title,
 * provider and reference are whatever the comparison/adjudication step
 * below settled on; every model-only field and the date union come from the
 * blind reading (or are absent when there was none), never adjudicated
 * (ADR-0025 section 4).
 */
function baseCandidate(heuristic: DocumentProposal, blind: DocumentProposal | null): Record<string, unknown> {
  const dates = [...heuristic.dates, ...(blind?.dates ?? [])]
    .filter((date, index, values) => values.indexOf(date) === index);
  return {
    title: heuristic.title,
    provider: heuristic.provider,
    reference: heuristic.reference,
    subtype: blind?.subtype,
    costMinor: blind?.costMinor,
    currency: blind?.currency,
    recurrenceMonths: blind?.recurrenceMonths,
    dates,
    dateRoles: blind?.dateRoles,
  };
}

function fieldValue(proposal: DocumentProposal, field: AdjudicatedField): string | undefined {
  return proposal[field];
}

/**
 * "Disagree" is a defined term, not a judgement call (ADR-0025 section 4):
 * comparison happens on already-validated, already-normalised values, and a
 * field only one extractor filled is a disagreement worth adjudicating. A
 * field neither filled is not, and buys nothing.
 */
function compareField(heuristicValue: string | undefined, blindValue: string | undefined): FieldComparison["comparison"] {
  if (heuristicValue === undefined && blindValue === undefined) return "neither";
  if (heuristicValue !== undefined && blindValue !== undefined && comparableText(heuristicValue) === comparableText(blindValue)) {
    return "agreed";
  }
  return "disagreed";
}

function setComparisonOutcome(comparisons: FieldComparison[], field: AdjudicatedField, outcome: AdjudicationOutcome): void {
  const index = comparisons.findIndex((entry) => entry.field === field);
  if (index >= 0) comparisons[index] = { ...comparisons[index], outcome };
}

/**
 * Per-field agreement, recorded as a non-sensitive count carrying no
 * values -- the same telemetry style as `recordModelExtractionSample`
 * (ADR-0025 section 4: "per-field agreement is recorded as a non-sensitive
 * counter, feeding section 5"). A bounded window per field, counts only.
 */
const FIELD_AGREEMENT_SAMPLE_WINDOW = 200;
const fieldAgreementSamples: Record<AdjudicatedField, FieldComparison["comparison"][]> = {
  title: [],
  provider: [],
  reference: [],
};

function recordFieldAgreementSample(field: AdjudicatedField, comparison: FieldComparison["comparison"]): void {
  const samples = fieldAgreementSamples[field];
  samples.push(comparison);
  if (samples.length > FIELD_AGREEMENT_SAMPLE_WINDOW) {
    samples.splice(0, samples.length - FIELD_AGREEMENT_SAMPLE_WINDOW);
  }
}

/** Clears every field's window. For tests and for a deliberate restart of the count. */
export function resetFieldAgreementSamples(): void {
  for (const field of ADJUDICATED_FIELDS) fieldAgreementSamples[field].length = 0;
}

/** The recent sample window for one field, as counts. */
export function fieldAgreementCounts(field: AdjudicatedField): { agreed: number; disagreed: number; neither: number } {
  const counts = { agreed: 0, disagreed: 0, neither: 0 };
  for (const sample of fieldAgreementSamples[field]) counts[sample] += 1;
  return counts;
}

export async function adjudicateProposal(args: {
  text: string;
  filename: string;
  heuristic: DocumentProposal;
  /** Budget for the WHOLE flow, not per pass. */
  deadlineMs: number;
  /** Injectable clock, for tests. */
  now?: () => number;
  /** Test/integration seam; defaults to the production transport when absent. */
  transport?: ModelTransport;
  environment?: NodeJS.ProcessEnv;
}): Promise<AdjudicationResult> {
  const { text, filename, heuristic, deadlineMs, transport, environment } = args;
  const now = args.now ?? Date.now;
  const startedAt = now();

  // Blind pass: no knowledge of the heuristic proposal (ADR-0025 section 4,
  // rule: "the order is the point, not an implementation detail"). It gets
  // the whole budget, since nothing has spent any of it yet.
  const blind = await modelProposalFromText(text, filename, { deadlineMs, transport, environment });

  if (blind.status === "skipped") {
    return { proposal: heuristic, heuristic, blind: null, alternatives: {}, comparisons: [], passes: 0 };
  }
  if (blind.status === "failed") {
    return {
      proposal: heuristic,
      heuristic,
      blind: null,
      alternatives: {},
      comparisons: [],
      passes: 1,
      blindFailure: blind.reason,
    };
  }

  const blindProposal = blind.proposal;
  const comparisons: FieldComparison[] = [];
  const disputed: AdjudicatedField[] = [];

  for (const field of ADJUDICATED_FIELDS) {
    const comparison = compareField(fieldValue(heuristic, field), fieldValue(blindProposal, field));
    comparisons.push({ field, comparison });
    recordFieldAgreementSample(field, comparison);
    if (comparison === "disagreed") disputed.push(field);
  }

  const candidate = baseCandidate(heuristic, blindProposal);

  // Agreement settles a field and is never revisited (ADR-0025 section 4,
  // owner ruling 2026-09-10): no disagreement anywhere means no adjudicating
  // pass, whatever the model-only fields say.
  if (disputed.length === 0) {
    return {
      proposal: safeStoredDocumentProposal(candidate, filename),
      heuristic,
      blind: blindProposal,
      alternatives: {},
      comparisons,
      passes: 1,
    };
  }

  const alternatives: Partial<Record<AdjudicatedField, string>> = {};
  const elapsed = now() - startedAt;
  const remaining = deadlineMs - elapsed;

  if (remaining < MIN_ADJUDICATION_BUDGET_MS) {
    // Too little budget left to land a second request: skipped, and
    // recorded as a timeout rather than issued to fail later (ADR-0025
    // section 4, rule: "the deadline bounds the whole flow").
    recordModelExtractionSample("timed_out");
    for (const field of disputed) setComparisonOutcome(comparisons, field, "failed");
    return {
      proposal: safeStoredDocumentProposal(candidate, filename),
      heuristic,
      blind: blindProposal,
      alternatives,
      comparisons,
      passes: 1,
      adjudicationFailure: "timed_out",
    };
  }

  const fieldCandidates: AdjudicationFieldCandidate[] = disputed.map((field) => ({
    field,
    maxLength: FIELD_MAX_LENGTH[field],
    heuristicValue: fieldValue(heuristic, field),
    blindValue: fieldValue(blindProposal, field),
  }));

  const adjudication = await modelAdjudicateFields(text, filename, fieldCandidates, {
    deadlineMs: remaining,
    transport,
    environment,
  });

  if (adjudication.status !== "ready") {
    // Not configured / empty document cannot actually happen here: the
    // blind pass just used the same text and environment successfully.
    // Handled defensively rather than assumed away.
    const reason: ModelExtractionFailure = adjudication.status === "failed" ? adjudication.reason : "malformed_response";
    for (const field of disputed) setComparisonOutcome(comparisons, field, "failed");
    return {
      proposal: safeStoredDocumentProposal(candidate, filename),
      heuristic,
      blind: blindProposal,
      alternatives,
      comparisons,
      passes: 2,
      adjudicationFailure: reason,
    };
  }

  for (const field of disputed) {
    const heuristicValue = fieldValue(heuristic, field);
    const blindValue = fieldValue(blindProposal, field);
    const adjudicatedValue = adjudication.fields.find((entry) => entry.field === field)?.value;

    let outcome: AdjudicationOutcome;
    let finalValue: string | undefined;
    if (adjudicatedValue === undefined) {
      // Both readings are wrong and the model has nothing better: a result,
      // not a failure (ADR-0025 section 4).
      outcome = "empty";
      finalValue = undefined;
    } else if (heuristicValue !== undefined && comparableText(adjudicatedValue) === comparableText(heuristicValue)) {
      outcome = "endorsed_heuristic";
      finalValue = heuristicValue;
    } else if (blindValue !== undefined && comparableText(adjudicatedValue) === comparableText(blindValue)) {
      outcome = "endorsed_blind";
      finalValue = blindValue;
    } else {
      outcome = "new_value";
      finalValue = adjudicatedValue;
    }

    setComparisonOutcome(comparisons, field, outcome);
    candidate[field] = finalValue;

    // The rejected validated value, only where one exists to reject. When a
    // third value wins over both prior readings (or nothing does), only one
    // slot is available to offer back to the reviewer; the heuristic
    // reading is preferred as the more informative single alternative,
    // falling back to the blind reading when the heuristic had nothing.
    const rejected = outcome === "endorsed_heuristic" ? blindValue
      : outcome === "endorsed_blind" ? heuristicValue
      : heuristicValue ?? blindValue;
    if (rejected !== undefined) alternatives[field] = rejected;
  }

  return {
    proposal: safeStoredDocumentProposal(candidate, filename),
    heuristic,
    blind: blindProposal,
    alternatives,
    comparisons,
    passes: 2,
  };
}
