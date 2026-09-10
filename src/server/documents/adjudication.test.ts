import { afterEach, describe, expect, it } from "vitest";
import {
  adjudicateProposal,
  fieldAgreementCounts,
  resetFieldAgreementSamples,
} from "./adjudication";
import {
  modelExtractionWindow,
  resetModelExtractionWindow,
  type ModelGenerateRequest,
  type ModelReply,
  type ModelTransport,
} from "./model-extraction";
import type { DocumentProposal } from "./suggestions";

const MODEL_ENVIRONMENT = { OLLAMA_MODEL: "a-local-model:latest" } as NodeJS.ProcessEnv;

// Every candidate reading below is grounded somewhere in this document, so a
// generated object can propose any of them without failing evidence checks.
const PROVIDER_DOCUMENT = [
  "Northfield Gas & Energy Ltd",
  "trading as Northfield Gas",
  "Registered supplier: Northfield Energy Group",
  "Account reference: NF-4471-22",
  "Also quoted as reference NFEG-99",
  "Service type: Gas supply",
  "Cover renews 2027-04-01",
  "Next service due 2028-01-01",
].join("\n");

const HEURISTIC: DocumentProposal = {
  title: "statement",
  provider: "Northfield Gas & Energy Ltd",
  reference: "NF-4471-22",
  dates: ["2027-04-01"],
};

async function* chunksOf(bytes: Buffer, size = 4_096): AsyncGenerator<Uint8Array> {
  for (let offset = 0; offset < bytes.byteLength; offset += size) {
    yield new Uint8Array(bytes.subarray(offset, Math.min(bytes.byteLength, offset + size)));
  }
}

/** The test fake of the transport seam: no model, no network, no real timers. */
function replyOf(payload: Buffer, overrides: Partial<ModelReply> = {}): ModelReply {
  return {
    status: 200,
    contentType: "application/json",
    contentLength: String(payload.byteLength),
    body: chunksOf(payload),
    ...overrides,
  };
}

function envelopeOf(generated: unknown): Buffer {
  return Buffer.from(JSON.stringify({
    model: "a-local-model:latest",
    created_at: "2026-09-10T00:00:00Z",
    response: JSON.stringify(generated),
    done: true,
  }), "utf8");
}

/**
 * One reply per call, in order: the first for the blind pass, the second
 * (if any) for the adjudicating pass. Throws if asked for a reply beyond
 * what was configured, so a stray third request fails the test loudly.
 */
function sequencedTransport(replies: ModelReply[]): ModelTransport & { requests: ModelGenerateRequest[] } {
  const requests: ModelGenerateRequest[] = [];
  return {
    requests,
    async send(request) {
      requests.push(request);
      if (requests.length > replies.length) throw new Error("no reply configured: an unexpected request was sent");
      return replies[requests.length - 1];
    },
  };
}

function blindGenerated(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    provider: { value: "Northfield Gas", evidence: "trading as Northfield Gas" },
    reference: { value: "NF-4471-22", evidence: "Account reference: NF-4471-22" },
    dates: [{ date: "2028-01-01", role: "service", evidence: "Next service due 2028-01-01" }],
    ...overrides,
  };
}

function adjudicate(overrides: Partial<Parameters<typeof adjudicateProposal>[0]> = {}) {
  return adjudicateProposal({
    text: PROVIDER_DOCUMENT,
    filename: "statement.pdf",
    heuristic: HEURISTIC,
    deadlineMs: 8_000,
    environment: MODEL_ENVIRONMENT,
    ...overrides,
  });
}

afterEach(() => {
  resetModelExtractionWindow();
  resetFieldAgreementSamples();
});

describe("agreement settles a field for exactly one inference", () => {
  it("costs exactly one inference when both readings agree, case and whitespace aside", async () => {
    const transport = sequencedTransport([
      replyOf(envelopeOf(blindGenerated({
        provider: { value: "northfield  gas & energy ltd", evidence: "Northfield Gas & Energy Ltd" },
        dates: [{ date: "2027-04-01", role: "renewal", evidence: "Cover renews 2027-04-01" }],
      }))),
    ]);

    const result = await adjudicate({ transport });

    expect(transport.requests).toHaveLength(1);
    expect(result.passes).toBe(1);
    expect(result.blind).not.toBeNull();
    expect(result.proposal.provider).toBe("Northfield Gas & Energy Ltd");
    expect(result.proposal.reference).toBe("NF-4471-22");
    expect(result.alternatives).toEqual({});
    expect(result.comparisons).toEqual(expect.arrayContaining([
      { field: "title", comparison: "agreed" },
      { field: "provider", comparison: "agreed" },
      { field: "reference", comparison: "agreed" },
    ]));
    expect(result.comparisons.every((entry) => entry.outcome === undefined)).toBe(true);
  });

  it("triggers no adjudicating pass for a document with model-only field values", async () => {
    const transport = sequencedTransport([
      replyOf(envelopeOf(blindGenerated({
        provider: { value: "Northfield Gas & Energy Ltd", evidence: "Northfield Gas & Energy Ltd" },
        subtype: { value: "Gas supply", evidence: "Service type: Gas supply" },
        cost: { amount: "42.50", evidence: "Account reference: NF-4471-22" },
      }))),
    ]);

    const result = await adjudicate({ transport });

    expect(transport.requests).toHaveLength(1);
    expect(result.passes).toBe(1);
    expect(result.proposal.subtype).toBe("Gas supply");
  });
});

describe("disagreement spends the second inference", () => {
  it("adjudicates a single disputed field, endorsing the heuristic, with the rejected reading in alternatives", async () => {
    const transport = sequencedTransport([
      replyOf(envelopeOf(blindGenerated())),
      replyOf(envelopeOf({
        provider: { value: "Northfield Gas & Energy Ltd", evidence: "Northfield Gas & Energy Ltd" },
      })),
    ]);

    const result = await adjudicate({ transport });

    expect(transport.requests).toHaveLength(2);
    expect(result.passes).toBe(2);
    expect(result.proposal.provider).toBe("Northfield Gas & Energy Ltd");
    expect(result.alternatives).toEqual({ provider: "Northfield Gas" });
    expect(result.comparisons).toEqual(expect.arrayContaining([
      { field: "provider", comparison: "disagreed", outcome: "endorsed_heuristic" },
      { field: "reference", comparison: "agreed" },
    ]));
  });

  it("covers every disputed field in one adjudicating pass, never one per field", async () => {
    const transport = sequencedTransport([
      replyOf(envelopeOf(blindGenerated({
        reference: { value: "NFEG-99", evidence: "Also quoted as reference NFEG-99" },
      }))),
      replyOf(envelopeOf({
        provider: { value: "Northfield Energy Group", evidence: "Registered supplier: Northfield Energy Group" },
        reference: { value: "NFEG-99", evidence: "Also quoted as reference NFEG-99" },
      })),
    ]);

    const result = await adjudicate({ transport });

    expect(transport.requests).toHaveLength(2);
    expect(result.passes).toBe(2);
    // provider: neither reading found "Northfield Energy Group" -- a genuinely new value.
    expect(result.proposal.provider).toBe("Northfield Energy Group");
    expect(result.alternatives.provider).toBe("Northfield Gas & Energy Ltd");
    // reference: endorses the blind reading over the heuristic's.
    expect(result.proposal.reference).toBe("NFEG-99");
    expect(result.alternatives.reference).toBe("NF-4471-22");
    expect(result.comparisons.find((entry) => entry.field === "provider")?.outcome).toBe("new_value");
    expect(result.comparisons.find((entry) => entry.field === "reference")?.outcome).toBe("endorsed_blind");
  });

  it("drops a value grounded only in the supplied readings, not the document, and records it as empty", async () => {
    const transport = sequencedTransport([
      replyOf(envelopeOf(blindGenerated())),
      replyOf(envelopeOf({
        // A self-grounding attempt: this exact text appears in the prompt's
        // prior-readings section (built from the blind value below) but
        // never in the document itself.
        provider: { value: "Northfield Gas", evidence: 'blind="Northfield Gas"' },
      })),
    ]);

    const result = await adjudicate({ transport });

    expect(transport.requests[1].prompt).toContain('blind="Northfield Gas"');
    expect(transport.requests[1].prompt).toContain("BEGIN PRIOR READINGS");
    expect(result.proposal.provider).toBeUndefined();
    // An "empty" outcome still offers the reviewer the more informative of
    // the two prior readings as the secondary affordance -- the field is not
    // left with nothing to show, only with no *primary* suggestion.
    expect(result.alternatives.provider).toBe("Northfield Gas & Energy Ltd");
    expect(result.adjudicationFailure).toBeUndefined();
    expect(result.comparisons.find((entry) => entry.field === "provider")).toEqual({
      field: "provider",
      comparison: "disagreed",
      outcome: "empty",
    });
  });

  it("ends an omitted field empty and records it as a result, not a failure", async () => {
    const transport = sequencedTransport([
      replyOf(envelopeOf(blindGenerated())),
      replyOf(envelopeOf({})),
    ]);

    const result = await adjudicate({ transport });

    expect(result.passes).toBe(2);
    expect(result.proposal.provider).toBeUndefined();
    expect(result.adjudicationFailure).toBeUndefined();
    expect(result.comparisons.find((entry) => entry.field === "provider")?.outcome).toBe("empty");
  });
});

describe("a failed adjudicating pass leaves the heuristic value standing", () => {
  it("on a malformed adjudicating reply", async () => {
    const transport = sequencedTransport([
      replyOf(envelopeOf(blindGenerated())),
      replyOf(Buffer.from(JSON.stringify({ response: "not json at all", done: true }), "utf8")),
    ]);

    const result = await adjudicate({ transport });

    expect(transport.requests).toHaveLength(2);
    expect(result.passes).toBe(2);
    expect(result.adjudicationFailure).toBe("malformed_response");
    expect(result.proposal.provider).toBe(HEURISTIC.provider);
    expect(result.comparisons.find((entry) => entry.field === "provider")?.outcome).toBe("failed");
  });

  it("on too little deadline remaining, skipping the request and recording a timeout", async () => {
    // Only one reply is configured: issuing a second request at all fails the test.
    const transport = sequencedTransport([replyOf(envelopeOf(blindGenerated()))]);
    let calls = 0;
    const now = () => {
      calls += 1;
      return calls === 1 ? 0 : 7_900; // ~100ms left of an 8s budget after the blind pass
    };

    const result = await adjudicate({ transport, deadlineMs: 8_000, now });

    expect(transport.requests).toHaveLength(1);
    expect(result.passes).toBe(1);
    expect(result.adjudicationFailure).toBe("timed_out");
    expect(result.proposal.provider).toBe(HEURISTIC.provider);
    expect(result.comparisons.find((entry) => entry.field === "provider")?.outcome).toBe("failed");
  });
});

describe("dates are the union of both extractors and are never removed", () => {
  it("merges and deduplicates dates, keeping the model's role labels", async () => {
    const transport = sequencedTransport([
      replyOf(envelopeOf(blindGenerated({
        provider: { value: "Northfield Gas & Energy Ltd", evidence: "Northfield Gas & Energy Ltd" },
        dates: [
          { date: "2027-04-01", role: "renewal", evidence: "Cover renews 2027-04-01" },
          { date: "2028-01-01", role: "service", evidence: "Next service due 2028-01-01" },
        ],
      }))),
    ]);

    const result = await adjudicate({
      transport,
      heuristic: { ...HEURISTIC, dates: ["2027-04-01", "2026-01-01"] },
    });

    expect(result.passes).toBe(1);
    expect(result.proposal.dates).toEqual(
      expect.arrayContaining(["2027-04-01", "2026-01-01", "2028-01-01"]),
    );
    expect(result.proposal.dates).toHaveLength(3);
    expect(result.proposal.scheduleKind).toBe("renewal");
    expect(result.proposal.scheduleDate).toBe("2027-04-01");
  });
});

describe("no path ever issues a third request", () => {
  it("stops at two requests across a run that disagrees, fails, and is re-read", async () => {
    const transport = sequencedTransport([
      replyOf(envelopeOf(blindGenerated())),
      replyOf(envelopeOf({
        provider: { value: "Northfield Gas & Energy Ltd", evidence: "Northfield Gas & Energy Ltd" },
      })),
    ]);

    await adjudicate({ transport });
    expect(transport.requests.length).toBeLessThanOrEqual(2);
  });
});

describe("the model unavailable", () => {
  it("costs zero passes and returns the heuristic proposal unchanged", async () => {
    const result = await adjudicate({ environment: {} as NodeJS.ProcessEnv });
    expect(result).toEqual({
      proposal: HEURISTIC,
      heuristic: HEURISTIC,
      blind: null,
      alternatives: {},
      comparisons: [],
      passes: 0,
    });
  });

  it("leaves the heuristic standing when the blind pass itself fails, spending one pass", async () => {
    const broken: ModelTransport = { send: () => Promise.reject(new Error("connect ECONNREFUSED")) };
    const result = await adjudicate({ transport: broken });
    expect(result).toEqual({
      proposal: HEURISTIC,
      heuristic: HEURISTIC,
      blind: null,
      alternatives: {},
      comparisons: [],
      passes: 1,
      blindFailure: "unreachable",
    });
  });
});

describe("field agreement telemetry (ADR-0025 section 4)", () => {
  it("records a count per field, never a value", async () => {
    resetFieldAgreementSamples();
    const transport = sequencedTransport([
      replyOf(envelopeOf(blindGenerated())),
      replyOf(envelopeOf({
        provider: { value: "Northfield Gas & Energy Ltd", evidence: "Northfield Gas & Energy Ltd" },
      })),
    ]);

    await adjudicate({ transport });

    expect(fieldAgreementCounts("provider")).toEqual({ agreed: 0, disagreed: 1, neither: 0 });
    expect(fieldAgreementCounts("reference")).toEqual({ agreed: 1, disagreed: 0, neither: 0 });
    expect(fieldAgreementCounts("title")).toEqual({ agreed: 1, disagreed: 0, neither: 0 });
  });

  it("also records a sample in the shared health window, ready or degraded", async () => {
    resetModelExtractionWindow();
    const transport = sequencedTransport([
      replyOf(envelopeOf(blindGenerated())),
      replyOf(envelopeOf({
        provider: { value: "Northfield Gas & Energy Ltd", evidence: "Northfield Gas & Energy Ltd" },
      })),
    ]);

    await adjudicate({ transport });

    expect(modelExtractionWindow()).toEqual({ samples: 2, failures: 0, timeouts: 0 });
  });
});
