import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const draftMocks = vi.hoisted(() => ({
  extract: vi.fn(),
  encryptJson: vi.fn((_column: string, _rowId: string, value: unknown) => JSON.stringify(value)),
  requireReceiptMetadataWriter: vi.fn(),
}));

// The receipt draft's extraction and encryption are the only pieces of
// `processImapAttachments` this file can exercise without inventing a
// database/ImapFlow harness the rest of this file has never needed
// (`draftProposalTextForTests` / `draftProposalColumnsForTests` are the
// same PostgreSQL-free contract seam `imap-receipt-worker.ts` already uses
// for its own tests). Adjudication and the heuristics stay real, so a
// no-model run below exercises the genuine wiring, not a stand-in for it.
vi.mock("@/server/documents/tika", () => ({ extractTextWithTika: draftMocks.extract }));
vi.mock("@/server/metadata/fields", () => ({ requireReceiptMetadataWriter: draftMocks.requireReceiptMetadataWriter }));

import { IMAP_HEADER_FETCH_PART, draftProposalColumnsForTests, draftProposalTextForTests, imapAttachmentRetryDelayMs, imapProviderConfigCommitment, imapProviderConnectionOptions, imapRecipientAlias, matchesImapRecipientAlias, verifyImapIngestionProviders } from "./imap-ingestion";
import { testImapConfig } from "../../../tests/support/imap-config";
import { getNotificationWorkerConfig } from "../notification-worker";
import { deriveImapRecipientAlias } from "./core/imap-recipient";
import { log } from "@/lib/logger";

describe("receipt retention", () => {
  it("holds a suggestion for 45 days (#434, owner decision 2026-08-15)", async () => {
    const { RECEIPT_RETENTION_MS } = await import("./imap-ingestion");
    expect(RECEIPT_RETENTION_MS).toBe(45 * 86_400_000);
  });
});

describe("IMAP ingestion configuration", () => {
  const smtpEnvironment = { NODE_ENV: "test", SMTP_HOST: "smtp.example.test", SMTP_USER: "orbit", SMTP_PASSWORD: "smtp-password" } as NodeJS.ProcessEnv;

  it("accepts a non-standard implicit TLS port while enforcing verified TLS in provider construction", () => {
    const config = testImapConfig({ port: 143 });
    expect(imapProviderConnectionOptions(config)).toMatchObject({
      port: 143,
      secure: true,
      tls: { rejectUnauthorized: true, servername: "imap.example.test" },
    });
  });

  it("matches an address against the generation it was derived under, never a different one", () => {
    const config = testImapConfig({
      currentAliasGeneration: 2,
      aliasCurrent: { generation: 2, secret: "test-current-alias-secret-that-is-long-enough" },
      aliasPrevious: { generation: 1, secret: "test-previous-alias-secret-that-is-long-enough", expiresAt: new Date(Date.now() + 86_400_000) },
    });
    /* Generations belong to each member's own `mail_in_relays` row since
       ADR-0017 slice 3 (orbit#744), so an address is identified by
       (user, generation) against the one instance key and never by an
       instance-wide previous tuple. */
    const userId = "6f7aa3dc-347d-4ff4-bf50-bc4f4ffc054a";
    const alias = imapRecipientAlias(userId, config, config.aliasCurrent.generation);
    expect(alias).toBe(deriveImapRecipientAlias(userId, config.aliasBase, config.aliasCurrent));
    expect(matchesImapRecipientAlias(alias, userId, config, config.aliasCurrent.generation)).toBe(true);
    expect(matchesImapRecipientAlias(alias, userId, config, config.aliasPrevious!.generation)).toBe(false);
  });

  it("uses bounded exponential attachment backoff and rejects invalid attempts", () => {
    expect(imapAttachmentRetryDelayMs(1)).toBe(1_000);
    expect(imapAttachmentRetryDelayMs(5)).toBe(16_000);
    expect(imapAttachmentRetryDelayMs(50)).toBe(900_000);
    expect(() => imapAttachmentRetryDelayMs(0)).toThrow("attempt is invalid");
  });

  it("requires both current provider preflights and invalidates readiness on safe provider configuration changes", async () => {
    const config = testImapConfig({ password: "provider-password" });
    const smtp = getNotificationWorkerConfig(smtpEnvironment);
    await expect(verifyImapIngestionProviders(config, smtp, {
      verifySmtp: async () => "ready",
      verifyImap: async () => "ready",
    })).resolves.toMatchObject({ status: "available", smtp: "available", imap: "available" });
    const changed = testImapConfig({ password: "provider-password", host: "replacement-imap.example.test" });
    await expect(verifyImapIngestionProviders(changed, smtp, {
      verifySmtp: async () => "smtp_unavailable",
      verifyImap: async () => "imap_unavailable",
    })).resolves.toMatchObject({ status: "provider_unavailable" });
  });

  it("keeps the provider commitment stable, non-secret, and sensitive to safe configuration", () => {
    const config = testImapConfig({ password: "provider-password" });
    const smtp = getNotificationWorkerConfig(smtpEnvironment);
    const commitment = imapProviderConfigCommitment(config, smtp);

    expect(commitment).toMatch(/^[0-9a-f]{64}$/u);
    expect(imapProviderConfigCommitment(config, smtp)).toBe(commitment);
    expect(imapProviderConfigCommitment(testImapConfig({ password: "rotated-password" }), smtp)).toBe(commitment);
    expect(imapProviderConfigCommitment(testImapConfig({ password: "provider-password", host: "replacement-imap.example.test" }), smtp)).not.toBe(commitment);
    expect(commitment).not.toContain("provider-password");
    expect(commitment).not.toContain("smtp-password");
  });

  it("reduces exceptional provider verification to a safe result and recovers on a later attempt", async () => {
    const config = testImapConfig({ password: "exception-password" });
    const smtp = getNotificationWorkerConfig(smtpEnvironment);
    let attempts = 0;
    let failFirstAttempt = true;
    const verifyImap = async () => {
      attempts += 1;
      if (failFirstAttempt) {
        failFirstAttempt = false;
        throw new Error("provider response contained a secret");
      }
      return "ready" as const;
    };
    await expect(verifyImapIngestionProviders(config, smtp, {
      verifySmtp: async () => "ready",
      verifyImap,
    })).resolves.toEqual(expect.objectContaining({ status: "provider_unavailable" }));
    await expect(verifyImapIngestionProviders(config, smtp, {
      verifySmtp: async () => "ready",
      verifyImap,
    })).resolves.toEqual(expect.objectContaining({ status: "available" }));
    expect(attempts).toBe(2);
  });
});

/**
 * #959, ADR-0025 sections 4 and 7: the receipt draft's proposal, from
 * extraction through adjudication to the encrypted columns
 * `imap-inbox.ts` reads. `draftProposalTextForTests` and
 * `draftProposalColumnsForTests` are the only pieces of
 * `processImapAttachments` reachable without a database or an `ImapFlow`
 * client, exactly as `imap-receipt-worker.ts`'s own `...ForTests` seams are
 * the only pieces of its worker reachable the same way. Adjudication and
 * the heuristics are left real (only extraction and the metadata cipher are
 * faked), so the no-model run below is the genuine wiring, not a stand-in.
 */
describe("receipt draft proposal", () => {
  beforeEach(() => {
    draftMocks.extract.mockReset();
    draftMocks.encryptJson.mockClear();
    draftMocks.encryptJson.mockImplementation((_column: string, _rowId: string, value: unknown) => JSON.stringify(value));
    draftMocks.requireReceiptMetadataWriter.mockReset();
    draftMocks.requireReceiptMetadataWriter.mockResolvedValue({ encryptJson: draftMocks.encryptJson });
  });

  afterEach(() => {
    vi.unstubAllEnvs();
    vi.unstubAllGlobals();
  });

  it("extracts text only when parsing succeeds and stays inside the character budget", async () => {
    draftMocks.extract.mockResolvedValueOnce("Provider: Acme Cover\nPolicy number: AB-12345\nRenews 2027-08-01");
    await expect(draftProposalTextForTests(Buffer.from("pdf-bytes"), "application/pdf", "receipt-1"))
      .resolves.toBe("Provider: Acme Cover\nPolicy number: AB-12345\nRenews 2027-08-01");

    draftMocks.extract.mockRejectedValueOnce(new Error("parser unavailable"));
    await expect(draftProposalTextForTests(Buffer.from("pdf-bytes"), "application/pdf", "receipt-1")).resolves.toBeUndefined();

    draftMocks.extract.mockResolvedValueOnce("x".repeat(250_001));
    await expect(draftProposalTextForTests(Buffer.from("pdf-bytes"), "application/pdf", "receipt-1")).resolves.toBeUndefined();

    draftMocks.extract.mockResolvedValueOnce("");
    await expect(draftProposalTextForTests(Buffer.from("pdf-bytes"), "application/pdf", "receipt-1")).resolves.toBeUndefined();
  });

  it("encrypts the heuristic-only proposal under the instance scope and issues zero model requests with no model configured", async () => {
    vi.stubEnv("OLLAMA_MODEL", "");
    vi.stubGlobal("fetch", vi.fn(() => { throw new Error("no model request should be issued with no model configured"); }));

    const columns = await draftProposalColumnsForTests(
      { text: "Provider: Acme Cover\nPolicy number: AB-12345\nRenews 2027-08-01", filename: "receipt.pdf" },
      "receipt-1",
    );

    expect(columns?.proposal).toEqual({});
    expect(columns?.fieldEvidence).toEqual({});
    expect(draftMocks.requireReceiptMetadataWriter).toHaveBeenCalledWith(null);
    expect(JSON.parse(columns!.proposalEnc)).toEqual({ title: "receipt", provider: "Acme Cover", reference: "AB-12345", dueDate: "2027-08-01" });
    expect(JSON.parse(columns!.fieldEvidenceEnc)).toEqual({
      title: { source: "filename", confidence: "high" },
      provider: { source: "document_text", confidence: "medium" },
      reference: { source: "document_text", confidence: "medium" },
      dueDate: { source: "document_text", confidence: "medium" },
    });
  });

  it("leaves every column untouched when nothing extracted any text", async () => {
    draftMocks.extract.mockRejectedValue(new Error("parser unavailable"));
    expect(await draftProposalTextForTests(Buffer.from("pdf-bytes"), "application/pdf", "receipt-1")).toBeUndefined();
    expect(draftMocks.requireReceiptMetadataWriter).not.toHaveBeenCalled();
  });

  it("is best-effort: a locked encryption key leaves the receipt without a draft rather than blocking it", async () => {
    vi.stubEnv("OLLAMA_MODEL", "");
    draftMocks.requireReceiptMetadataWriter.mockRejectedValue(new Error("metadata_locked"));

    await expect(draftProposalColumnsForTests(
      { text: "Provider: Acme Cover\nPolicy number: AB-12345\nRenews 2027-08-01", filename: "receipt.pdf" },
      "receipt-1",
    )).resolves.toBeUndefined();
  });

  it("never lets a rejected reading reach a log line, even when adjudication itself fails unexpectedly", async () => {
    const infoSpy = vi.spyOn(log, "info");
    const warnSpy = vi.spyOn(log, "warn");
    vi.stubEnv("OLLAMA_MODEL", "");
    draftMocks.requireReceiptMetadataWriter.mockRejectedValue(new Error("unlogged-metadata-failure-detail"));

    await draftProposalColumnsForTests(
      { text: "Provider: Acme Cover\nPolicy number: AB-12345\nRenews 2027-08-01", filename: "receipt.pdf" },
      "receipt-1",
    );

    const logged = JSON.stringify([...infoSpy.mock.calls, ...warnSpy.mock.calls]);
    expect(logged).not.toContain("unlogged-metadata-failure-detail");
    expect(logged).not.toContain("Acme Cover");
  });
});

describe("IMAP header fetch part", () => {
  it("is a bare IMAP atom with a byte ceiling: a key with spaces or parentheses is quoted by imapflow and the server rejects the FETCH", () => {
    expect(IMAP_HEADER_FETCH_PART.key).toMatch(/^[A-Z0-9.]+$/u);
    expect(IMAP_HEADER_FETCH_PART.maxLength).toBe(64 * 1024);
  });
});
