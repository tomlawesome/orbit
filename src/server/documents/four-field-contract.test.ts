import { describe, expect, it } from "vitest";
import { scheduleKinds } from "@/lib/domain";
import { workspaceItemSchema } from "@/lib/workspace";
import { buildDocumentSuggestions, itemDocumentSuggestionFields } from "@/server/item-document-inspection";
import { reviewDraftMetadataFromProposal } from "@/server/reviewed-intake";
import { EXTRACTION_CORPUS } from "./extraction-corpus";
import { isSubtypeSpec } from "./extraction-scoring";
import {
  documentDateRoles,
  proposalFromText,
  type DocumentProposal,
} from "./suggestions";
import {
  modelProposalFromText,
  type ModelReply,
  type ModelTransport,
} from "./model-extraction";

/**
 * ADR-0025 section 7 (#960): the four fields the model path owns have to
 * survive the whole journey, not just the extractor. This file walks one
 * model proposal from the reply the model sends to the item a reviewer
 * saves, through both suggestion surfaces on the way, and then checks the
 * corpus ground truth that measures the same contract is internally
 * consistent with it.
 */

const MODEL_ENVIRONMENT = { OLLAMA_MODEL: "a-local-model:latest" } as NodeJS.ProcessEnv;

const DOCUMENT = [
  "Larkfield Mutual Insurance",
  "SCHEDULE OF INSURANCE — BUILDINGS AND CONTENTS",
  "Policy LKM/44-12-8890",
  "Premium £412.66 a year",
  "Cover renews 2027-02-01",
  "Renewable every 12 months",
].join("\n");

const GENERATED = {
  provider: { value: "Larkfield Mutual Insurance", evidence: "Larkfield Mutual Insurance" },
  reference: { value: "LKM/44-12-8890", evidence: "Policy LKM/44-12-8890" },
  subtype: { value: "Buildings and contents", evidence: "SCHEDULE OF INSURANCE — BUILDINGS AND CONTENTS" },
  cost: { amount: "412.66", evidence: "Premium £412.66 a year" },
  recurrenceMonths: { months: 12, evidence: "Renewable every 12 months" },
  dates: [{ date: "2027-02-01", role: "renewal", evidence: "Cover renews 2027-02-01" }],
};

async function* oneChunk(bytes: Buffer): AsyncGenerator<Uint8Array> {
  yield new Uint8Array(bytes);
}

function transportReturning(generated: unknown): ModelTransport {
  const payload = Buffer.from(JSON.stringify({ response: JSON.stringify(generated), done: true }), "utf8");
  return {
    async send(): Promise<ModelReply> {
      return {
        status: 200,
        contentType: "application/json",
        contentLength: String(payload.byteLength),
        body: oneChunk(payload),
      };
    },
  };
}

async function modelProposal(generated: unknown = GENERATED, document = DOCUMENT): Promise<DocumentProposal> {
  const result = await modelProposalFromText(document, "buildings-schedule.pdf", {
    environment: MODEL_ENVIRONMENT,
    transport: transportReturning(generated),
  });
  if (result.status !== "ready") throw new Error(`expected a proposal, got ${result.status}`);
  return result.proposal;
}

/** What the reviewer would save: the mail-in surface's proposal, plus the
 * things the person or the household supplies rather than the document. */
function reviewedItem(proposal: DocumentProposal) {
  const { proposal: offered } = reviewDraftMetadataFromProposal(proposal);
  return workspaceItemSchema.parse({
    ...offered,
    id: "11111111-1111-4111-8111-111111111111",
    sectionId: "22222222-2222-4222-8222-222222222222",
    currency: offered.currency ?? "GBP",
    status: "active",
  });
}

describe("the four model-owned fields round-trip to a reviewed item", () => {
  it("reaches the Add-item surface as all eight declared suggestion fields", async () => {
    const suggestions = buildDocumentSuggestions("buildings-schedule.pdf", await modelProposal());

    expect(suggestions.map((suggestion) => suggestion.field).sort())
      .toEqual([...itemDocumentSuggestionFields].sort());
    expect(suggestions).toEqual(expect.arrayContaining([
      { field: "subtype", value: "Buildings and contents", source: "document_text", confidence: "medium" },
      // Major units, because that is what the item's cost field takes.
      { field: "cost", value: "412.66", source: "document_text", confidence: "medium" },
      { field: "dueDate", value: "2027-02-01", source: "document_text", confidence: "medium" },
      { field: "scheduleKind", value: "renewal", source: "document_text", confidence: "medium" },
      { field: "recurrenceMonths", value: "12", source: "document_text", confidence: "medium" },
    ]));
  });

  it("reaches the mail-in review surface and parses as an item", async () => {
    const item = reviewedItem(await modelProposal());

    expect(item).toMatchObject({
      title: "buildings-schedule",
      subtype: "Buildings and contents",
      provider: "Larkfield Mutual Insurance",
      reference: "LKM/44-12-8890",
      costMinor: 41_266,
      currency: "GBP",
      dueDate: "2027-02-01",
      scheduleKind: "renewal",
      recurrenceMonths: 12,
    });
  });

  it("leaves the four slots empty where the model is absent", async () => {
    const heuristic = proposalFromText(DOCUMENT, "buildings-schedule.pdf");
    expect(heuristic.subtype).toBeUndefined();
    expect(heuristic.costMinor).toBeUndefined();
    expect(heuristic.recurrenceMonths).toBeUndefined();
    expect(heuristic.scheduleKind).toBeUndefined();
    expect(heuristic.dateRoles).toBeUndefined();

    const suggestions = buildDocumentSuggestions("buildings-schedule.pdf", heuristic);
    expect(suggestions.map((suggestion) => suggestion.field))
      .toEqual(["title", "provider", "reference", "dueDate"]);
    const item = reviewedItem(heuristic);
    expect(item.subtype).toBeUndefined();
    expect(item.costMinor).toBeUndefined();
    expect(item.scheduleKind).toBeUndefined();
    expect(item.recurrenceMonths).toBeUndefined();
  });

  it("carries no cost anywhere when the evidence span carried no currency", async () => {
    const proposal = await modelProposal(
      { ...GENERATED, cost: { amount: "412.66", evidence: "Premium 412.66 a year" } },
      DOCUMENT.replace("£", ""),
    );

    expect(proposal.costMinor).toBeUndefined();
    expect(proposal.currency).toBeUndefined();
    expect(buildDocumentSuggestions("buildings-schedule.pdf", proposal).map((entry) => entry.field))
      .not.toContain("cost");
    expect(reviewedItem(proposal).costMinor).toBeUndefined();
  });
});

/**
 * The corpus is the measurement of this same contract, so its ground truth
 * has to obey the contract's own rules. A corpus that asked for something
 * the design forbids producing would report a permanent miss and teach
 * nobody anything.
 */
describe("corpus ground truth for the four fields is consistent with the contract", () => {
  const documents = EXTRACTION_CORPUS.map((document) => [document.name, document] as const);

  // A fixed-term contract costs everything paid over its term (owner,
  // 2026-09-13), and some pages print only the monthly price and the term.
  // For those the truth declares `costArithmetic` instead: each factor is a
  // printed amount in minor units and a printed count of months, and the
  // products add up to the declared cost (`scripts/corpus/verify.mjs` checks
  // the same). An unprinted cost without it is still a corpus bug.
  const printedForms = (minor: number): string[] => {
    const printed = (minor / 100).toFixed(2);
    return [printed, printed.replace(/\.00$/u, ""), printed.replace(/\B(?=(\d{3})+\.)/gu, ",")];
  };

  it.each(documents)("%s", (_name, document) => {
    const { expected, text } = document;
    const roles = expected.dateRoles ?? [];

    for (const label of roles) {
      expect(expected.dates).toContain(label.date);
      expect(documentDateRoles as readonly string[]).toContain(label.role);
    }
    expect(new Set(roles.map((label) => label.date)).size).toBe(roles.length);

    // Every date carries a role, or none does: a half-labelled document
    // would score a miss for a rule the corpus never stated.
    expect(roles.length).toBe(expected.dates.length);

    // `scheduleKind` is derived, so the corpus may not declare one the roles
    // do not produce, nor omit one they do.
    const scheduled = roles.find((label) => (scheduleKinds as readonly string[]).includes(label.role));
    expect(expected.scheduleKind).toBe(scheduled?.role);

    // A cost is an amount and its currency together, never one alone, and
    // the page must print both.
    expect(expected.currency === undefined).toBe(expected.costMinor === undefined);
    if (expected.costMinor !== undefined) {
      expect(expected.currency).toBe("GBP");
      expect(text).toContain("£");
      const arithmetic = expected.costArithmetic;
      if (arithmetic === undefined) {
        expect(printedForms(expected.costMinor).some((form) => text.includes(form))).toBe(true);
      } else {
        // Each price is printed; the term is, or the split of it is (the
        // mobile plan prints "first 6 months" of a 24-month term).
        const termPrinted = (months: number) => new RegExp(`\\b${months}\\s*-?\\s*months?\\b`, "iu").test(text);
        const whole = arithmetic.reduce((sum, [, months]) => sum + months, 0);
        for (const [minor, months] of arithmetic) {
          expect(printedForms(minor).some((form) => text.includes(form))).toBe(true);
          expect(termPrinted(months) || termPrinted(whole)).toBe(true);
        }
        expect(arithmetic.reduce((sum, [minor, months]) => sum + minor * months, 0)).toBe(expected.costMinor);
      }
    }

    // A recurrence needs a schedule to repeat, and needs its digits on the
    // page for the grounding rule to accept it.
    if (expected.recurrenceMonths !== undefined) {
      expect(expected.scheduleKind).toBeDefined();
      expect(text).toContain(String(expected.recurrenceMonths));
    }

    // A subtype the page does not print is not something any grounded
    // extractor could return. Ground truth may declare a set of acceptable
    // phrases (#989/#992); every member of the set must still be printed.
    // That check does not apply to the taxonomy object form (#989): a kind
    // such as "Insurance" need not be printed anywhere -- naming what type
    // of thing the page is does not require the page to use that word.
    if (expected.subtype !== undefined && !isSubtypeSpec(expected.subtype)) {
      const subtypes = Array.isArray(expected.subtype) ? expected.subtype : [expected.subtype];
      for (const subtype of subtypes) {
        expect(subtype.length).toBeLessThanOrEqual(80);
        expect(text.replace(/\s+/gu, " ").toLowerCase())
          .toContain(subtype.replace(/\s+/gu, " ").toLowerCase());
      }
    }
  });
});
