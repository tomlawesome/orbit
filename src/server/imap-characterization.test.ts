/**
 * Characterization draft for issue #298 (IMAP mail-in module split).
 *
 * Scope: pins CURRENT behaviour of the parts of the module that are testable
 * without a live IMAP server or a live Postgres connection — MIME/attachment
 * parsing, recipient-alias derivation/matching, alias rotation state,
 * config parsing, review-inbox status mapping, and proposal-draft
 * sanitization. These are exactly the functions identified as the "pure
 * parsing core" candidate in /tmp/imap-characterization-notes.md (§11.A).
 *
 * Deliberately NOT covered here (see notes.md §11.C for why): anything that
 * calls getDb() — receipt recording/dedup, staging-object leases, the review
 * inbox CRUD functions, notification materialization/claiming, the ImapFlow
 * network shell itself. Some of that already has DB-independent config
 * coverage in the existing src/server/imap-ingestion.test.ts; this draft
 * adds scenarios that file does not already cover rather than repeating it.
 *
 * Reviewed and adopted into the suite as the characterization baseline for
 * the #298 split: these tests pin behaviour BEFORE the module moves, so the
 * split must keep them green without modification.
 */
import { describe, expect, it } from "vitest";
import {
  IMAP_ATTACHMENT_LIMITS,
  classifyImapBodyStructure,
  normalizeImapAttachmentName,
  validateImapAttachmentBytes,
} from "@/server/mail-in/core/imap-attachment-validation";
import {
  deriveImapRecipientAlias,
  matchImapRecipientAliasGeneration,
  normalizeImapRecipientAlias,
  parseTrustedRecipientHeader,
} from "@/server/mail-in/core/imap-recipient";
import { decideImapRotationState, ImapRotationStaleError } from "@/server/mail-in/core/imap-rotation";
import {
  getImapIngestionConfig,
  imapAttachmentRetryDelayMs,
  imapProviderConfigCommitment,
  imapProviderConnectionOptions,
  imapRecipientAlias,
  matchesImapRecipientAlias,
} from "@/server/imap-ingestion";
import { getNotificationWorkerConfig } from "@/server/notification-worker";
import { findReviewedIntakeCandidateReason, reviewInboxState } from "@/server/imap-inbox";
import { sanitizeReviewDraftMetadata } from "@/server/reviewed-intake";

// --- self-contained fixtures (no repo-relative test-support imports, so
// this file can be exercised from outside the source tree) -----------------

/** Minimal structurally-valid single-page PDF, same technique as the repo's
 * tests/support/synthetic-documents.ts syntheticPdf() helper. */
function syntheticPdf(contents = "Synthetic characterization document") {
  const escaped = contents.replaceAll("\\", "\\\\").replaceAll("(", "\\(").replaceAll(")", "\\)");
  const pageStream = `BT /F1 18 Tf 72 720 Td (${escaped}) Tj ET`;
  const objects = [
    "<< /Type /Catalog /Pages 2 0 R >>",
    "<< /Type /Pages /Kids [3 0 R] /Count 1 >>",
    "<< /Type /Page /Parent 2 0 R /MediaBox [0 0 612 792] /Resources << /Font << /F1 4 0 R >> >> /Contents 5 0 R >>",
    "<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica >>",
    `<< /Length ${Buffer.byteLength(pageStream)} >>\nstream\n${pageStream}\nendstream`,
  ];
  let value = "%PDF-1.7\n";
  const offsets = [0];
  objects.forEach((object, index) => {
    offsets.push(Buffer.byteLength(value));
    value += `${index + 1} 0 obj\n${object}\nendobj\n`;
  });
  const xrefOffset = Buffer.byteLength(value);
  value += `xref\n0 ${objects.length + 1}\n0000000000 65535 f \n`;
  value += offsets.slice(1).map((offset) => `${String(offset).padStart(10, "0")} 00000 n \n`).join("");
  value += `trailer\n<< /Size ${objects.length + 1} /Root 1 0 R >>\nstartxref\n${xrefOffset}\n%%EOF\n`;
  return Buffer.from(value);
}

function leaf(overrides: Record<string, unknown> = {}) {
  return {
    part: "1",
    type: "application",
    subtype: "pdf",
    disposition: "attachment",
    dispositionParameters: { filename: "receipt.pdf" },
    size: 12,
    ...overrides,
  } as never;
}

const baseImapEnv: Record<string, string> = {
  IMAP_HOST: "imap.example.test",
  IMAP_USER: "orbit",
  IMAP_PASSWORD: "test-password",
  IMAP_RECIPIENT_DOMAIN: "ingest.example.test",
  IMAP_ALIAS_CURRENT_GENERATION: "2",
  IMAP_ALIAS_CURRENT_SECRET: "current-alias-secret-that-is-at-least-32-chars",
  IMAP_TRUSTED_RECIPIENT_HEADER: "X-Original-To",
  SMTP_HOST: "smtp.example.test",
  SMTP_USER: "orbit-notifications",
  SMTP_PASSWORD: "test-smtp-password",
};

function env(overrides: Record<string, string | undefined> = {}): NodeJS.ProcessEnv {
  return { ...baseImapEnv, ...overrides } as NodeJS.ProcessEnv;
}

// ---------------------------------------------------------------------------
// 1. Config handling — scenarios not already pinned by imap-ingestion.test.ts
// ---------------------------------------------------------------------------

describe("IMAP config handling — previous alias generation edge cases", () => {
  it("requires the previous alias generation, secret, and expiry all together", () => {
    expect(() => getImapIngestionConfig(env({ IMAP_ALIAS_PREVIOUS_GENERATION: "1" })))
      .toThrow("must be configured together");
  });

  it("rejects a previous generation equal to the current generation", () => {
    expect(() => getImapIngestionConfig(env({
      IMAP_ALIAS_PREVIOUS_GENERATION: "2",
      IMAP_ALIAS_PREVIOUS_SECRET: "previous-alias-secret-that-is-at-least-32-chars",
      IMAP_ALIAS_PREVIOUS_EXPIRES_AT: new Date(Date.now() + 86_400_000).toISOString(),
    }))).toThrow("must be distinct");
  });

  it("enforces a 32-character floor independently for current and previous secrets", () => {
    expect(() => getImapIngestionConfig(env({ IMAP_ALIAS_CURRENT_SECRET: "too-short" })))
      .toThrow("current secret must be at least 32 characters");
    expect(() => getImapIngestionConfig(env({
      IMAP_ALIAS_PREVIOUS_GENERATION: "1",
      IMAP_ALIAS_PREVIOUS_SECRET: "too-short",
      IMAP_ALIAS_PREVIOUS_EXPIRES_AT: new Date(Date.now() + 86_400_000).toISOString(),
    }))).toThrow("previous secret must be at least 32 characters");
  });

  it("requires an explicit UTC timestamp for the previous alias expiry, not a bare date", () => {
    expect(() => getImapIngestionConfig(env({
      IMAP_ALIAS_PREVIOUS_GENERATION: "1",
      IMAP_ALIAS_PREVIOUS_SECRET: "previous-alias-secret-that-is-at-least-32-chars",
      IMAP_ALIAS_PREVIOUS_EXPIRES_AT: "2026-08-01",
    }))).toThrow("explicit UTC timestamp");
  });

  it("bounds the previous alias transition window to 90 days from now", () => {
    expect(() => getImapIngestionConfig(env({
      IMAP_ALIAS_PREVIOUS_GENERATION: "1",
      IMAP_ALIAS_PREVIOUS_SECRET: "previous-alias-secret-that-is-at-least-32-chars",
      IMAP_ALIAS_PREVIOUS_EXPIRES_AT: new Date(Date.now() + 91 * 86_400_000).toISOString(),
    }))).toThrow("bounded rotation window");
  });

  it("accepts a fully-specified previous generation inside the bounded window", () => {
    const expiresAt = new Date(Date.now() + 5 * 86_400_000).toISOString();
    const config = getImapIngestionConfig(env({
      IMAP_ALIAS_PREVIOUS_GENERATION: "1",
      IMAP_ALIAS_PREVIOUS_SECRET: "previous-alias-secret-that-is-at-least-32-chars",
      IMAP_ALIAS_PREVIOUS_EXPIRES_AT: expiresAt,
    }));
    expect(config.aliasPrevious).toMatchObject({ generation: 1 });
    expect(config.aliasPrevious?.expiresAt?.toISOString()).toBe(expiresAt);
  });
});

describe("IMAP config handling — TLS options and non-secret commitment", () => {
  it("defaults SNI/servername to the host, but an explicit tlsServerName overrides it", () => {
    const defaulted = getImapIngestionConfig(env());
    expect(imapProviderConnectionOptions(defaulted)).toMatchObject({
      secure: true,
      logger: false,
      tls: { rejectUnauthorized: true, servername: "imap.example.test" },
      maxLiteralSize: IMAP_ATTACHMENT_LIMITS.rawMessageBytes,
    });
    const overridden = getImapIngestionConfig(env({ IMAP_TLS_SERVER_NAME: "pinned.example.test" }));
    expect(imapProviderConnectionOptions(overridden).tls).toMatchObject({ servername: "pinned.example.test" });
  });

  it("changes the commitment when identity/topology fields change, but not when only a secret rotates", () => {
    const smtp = getNotificationWorkerConfig(env());
    const baseline = getImapIngestionConfig(env());
    const sameGenerationDifferentSecret = getImapIngestionConfig(env({
      IMAP_ALIAS_CURRENT_SECRET: "a-completely-different-alias-secret-value-here",
    }));
    // Rotating only the secret bytes for the same generation does not change
    // the commitment: the hash is over host/port/user/mailbox/tlsServerName/
    // recipientDomain/header/generation numbers and SMTP security+from only.
    expect(imapProviderConfigCommitment(sameGenerationDifferentSecret, smtp))
      .toBe(imapProviderConfigCommitment(baseline, smtp));

    const differentHost = getImapIngestionConfig(env({ IMAP_HOST: "other-imap.example.test" }));
    expect(imapProviderConfigCommitment(differentHost, smtp))
      .not.toBe(imapProviderConfigCommitment(baseline, smtp));

    const differentSmtpFrom = { ...smtp, smtpFrom: "someone-else@example.test" };
    expect(imapProviderConfigCommitment(baseline, differentSmtpFrom))
      .not.toBe(imapProviderConfigCommitment(baseline, smtp));
  });
});

describe("IMAP attachment-processing backoff schedule", () => {
  it("doubles per attempt and caps at 15 minutes", () => {
    expect(imapAttachmentRetryDelayMs(1)).toBe(1_000);
    expect(imapAttachmentRetryDelayMs(2)).toBe(2_000);
    expect(imapAttachmentRetryDelayMs(3)).toBe(4_000);
    expect(imapAttachmentRetryDelayMs(11)).toBe(15 * 60_000);
    expect(imapAttachmentRetryDelayMs(50)).toBe(15 * 60_000);
  });

  it("rejects a non-positive or non-integer attempt count", () => {
    expect(() => imapAttachmentRetryDelayMs(0)).toThrow();
    expect(() => imapAttachmentRetryDelayMs(-1)).toThrow();
    expect(() => imapAttachmentRetryDelayMs(1.5)).toThrow();
  });
});

describe("IMAP recipient alias helpers wired through config", () => {
  it("derives and matches an alias against the current generation, and refuses when disabled", () => {
    const config = getImapIngestionConfig(env());
    const userId = "9c3b6f0a-2222-4aaa-8bbb-000000000001";
    const alias = imapRecipientAlias(userId, config);
    expect(alias).toBe(deriveImapRecipientAlias(userId, config.recipientDomain, config.aliasCurrent));
    expect(matchesImapRecipientAlias(alias, userId, config)).toBe(true);
    expect(matchesImapRecipientAlias(alias, "a-different-user-id", config)).toBe(false);

    const disabled = getImapIngestionConfig(env({ IMAP_ENABLED: "false" }));
    expect(() => imapRecipientAlias(userId, disabled)).toThrow("IMAP ingestion is not configured");
    expect(matchesImapRecipientAlias(alias, userId, disabled)).toBe(false);
  });

  it("still matches an unexpired previous-generation alias, but not once it has expired", () => {
    const expiresAt = new Date(Date.now() + 5 * 86_400_000).toISOString();
    const config = getImapIngestionConfig(env({
      IMAP_ALIAS_PREVIOUS_GENERATION: "1",
      IMAP_ALIAS_PREVIOUS_SECRET: "previous-alias-secret-that-is-at-least-32-chars",
      IMAP_ALIAS_PREVIOUS_EXPIRES_AT: expiresAt,
    }));
    const userId = "9c3b6f0a-2222-4aaa-8bbb-000000000002";
    const previousAlias = deriveImapRecipientAlias(userId, config.recipientDomain, config.aliasPrevious!);
    expect(matchesImapRecipientAlias(previousAlias, userId, config)).toBe(true);

    const alreadyExpired = { ...config, aliasPrevious: { ...config.aliasPrevious!, expiresAt: new Date(Date.now() - 1_000) } };
    expect(matchesImapRecipientAlias(previousAlias, userId, alreadyExpired)).toBe(false);
  });
});

// ---------------------------------------------------------------------------
// 2. MIME/attachment parsing (imap-attachment-validation.ts)
// ---------------------------------------------------------------------------

describe("classifyImapBodyStructure — mailbox mode trusts the type/filename claim, not disposition", () => {
  it("selects only the part that claims to be a PDF, ignoring an inline/attachment docx sibling", () => {
    const message = {
      childNodes: [
        leaf({ part: "1", dispositionParameters: { filename: "invoice.pdf" } }),
        leaf({
          part: "2",
          type: "application",
          subtype: "vnd.openxmlformats-officedocument.wordprocessingml.document",
          dispositionParameters: { filename: "cover-letter.docx" },
          size: 40,
        }),
      ],
    };
    const result = classifyImapBodyStructure(message as never, { mailboxPdfOnly: true });
    expect(result.ok).toBe(true);
    expect(result.candidates).toEqual([{ part: "1", filename: "invoice.pdf", declaredMediaType: "application/pdf", sizeBytes: 12 }]);
  });

  it("selects both parts once disposition-based (non-mailbox) selection is used instead", () => {
    const message = {
      childNodes: [
        leaf({ part: "1", dispositionParameters: { filename: "invoice.pdf" } }),
        leaf({
          part: "2",
          type: "application",
          subtype: "vnd.openxmlformats-officedocument.wordprocessingml.document",
          dispositionParameters: { filename: "cover-letter.docx" },
          size: 40,
        }),
      ],
    };
    const result = classifyImapBodyStructure(message as never, { mailboxPdfOnly: false });
    expect(result.ok).toBe(true);
    expect(result.candidates.map((candidate) => candidate.part)).toEqual(["1", "2"]);
  });
});

describe("classifyImapBodyStructure — hostile structural input", () => {
  it("rejects a repeated part label as an invalid structure rather than silently deduping", () => {
    const message = { childNodes: [leaf({ part: "1" }), leaf({ part: "1", dispositionParameters: { filename: "second.pdf" } })] };
    expect(classifyImapBodyStructure(message as never)).toMatchObject({ ok: false, code: "mime_structure_invalid" });
  });

  it("rejects a negative or non-numeric declared size instead of coercing it", () => {
    expect(classifyImapBodyStructure(leaf({ size: -1 })).ok).toBe(false);
    expect(classifyImapBodyStructure(leaf({ size: "12" })).ok).toBe(false);
    expect(classifyImapBodyStructure(leaf({ size: 12.5 })).ok).toBe(false);
  });

  it("caps the sum of per-part sizes independently of any single part's own cap", () => {
    const generousPerPartCap = 30 * 1024 * 1024;
    const partSize = 20 * 1024 * 1024; // under the per-part cap, but two together exceed the fixed 25 MiB aggregate cap
    const message = {
      childNodes: [
        leaf({ part: "1", size: partSize, dispositionParameters: { filename: "a.pdf" } }),
        leaf({ part: "2", size: partSize, dispositionParameters: { filename: "b.pdf" } }),
      ],
    };
    const result = classifyImapBodyStructure(message as never, { maxDocumentBytes: generousPerPartCap, mailboxPdfOnly: true });
    expect(result).toMatchObject({ ok: false, code: "attachment_total_too_large" });
  });
});

describe("validateImapAttachmentBytes — declared/detected agreement", () => {
  it("accepts a structurally valid PDF whose declaration matches its sniffed bytes", async () => {
    await expect(validateImapAttachmentBytes(syntheticPdf(), "application/pdf"))
      .resolves.toMatchObject({ ok: true, mediaType: "application/pdf" });
  });

  it("rejects a PDF whose bytes disagree with a non-PDF declared type, before any structural parse", async () => {
    await expect(validateImapAttachmentBytes(syntheticPdf(), "image/png"))
      .resolves.toMatchObject({ ok: false, code: "mime_type_mismatch" });
  });

  it("rejects bytes with no recognizable magic signature at all", async () => {
    await expect(validateImapAttachmentBytes(Buffer.from("not a document"), "application/pdf"))
      .resolves.toMatchObject({ ok: false, code: "document_type_unsupported" });
  });

  it("rejects an empty buffer as too small rather than as an unsupported type", async () => {
    await expect(validateImapAttachmentBytes(Buffer.alloc(0), "application/pdf"))
      .resolves.toMatchObject({ ok: false, code: "document_too_large" });
  });
});

describe("normalizeImapAttachmentName — untrusted provider filename to display-only text", () => {
  it("keeps only the leaf segment across both / and \\ path separators", () => {
    expect(normalizeImapAttachmentName("C:\\Users\\alice\\Documents\\invoice.pdf", "application/pdf")).toBe("invoice.pdf");
    expect(normalizeImapAttachmentName("../../etc/passwd.pdf", "application/pdf")).toBe("passwd.pdf");
  });

  it("strips bidi/control override characters without introducing whitespace in their place", () => {
    expect(normalizeImapAttachmentName("invoice\u202Ecod.pdf", "application/pdf")).toBe("invoicecod.pdf");
  });

  it("falls back to a fixed name per media type when nothing displayable survives", () => {
    expect(normalizeImapAttachmentName("\u202E\u202E", "application/pdf")).toBe("document.pdf");
    expect(normalizeImapAttachmentName(undefined, "image/jpeg")).toBe("document.jpg");
    expect(normalizeImapAttachmentName("", "image/png")).toBe("document.png");
  });

  it("truncates by UTF-8 byte length, not character count, at the 180-byte boundary", () => {
    const longMultibyteName = "é".repeat(200); // 2 bytes each in UTF-8, 400 bytes total
    const result = normalizeImapAttachmentName(longMultibyteName, "application/pdf");
    expect(Buffer.byteLength(result, "utf8")).toBe(IMAP_ATTACHMENT_LIMITS.displayNameBytes);
    expect(result.length).toBe(90);
  });
});

// ---------------------------------------------------------------------------
// 3. Recipient header trust boundary (imap-recipient.ts)
// ---------------------------------------------------------------------------

describe("parseTrustedRecipientHeader — fails closed on ANY malformed header line, not just the trusted one", () => {
  it("rejects the whole header block when an unrelated line has no colon, even before the trusted header", () => {
    const headers = Buffer.from("X-Weird-Line-No-Colon\r\nX-Original-To: orbit+alias@ingest.example.test\r\n");
    expect(parseTrustedRecipientHeader(headers, "X-Original-To")).toEqual({ kind: "malformed" });
  });

  it("also rejects it when the malformed line comes after an otherwise well-formed trusted header", () => {
    const headers = Buffer.from("X-Original-To: orbit+alias@ingest.example.test\r\nX-Weird-Line-No-Colon\r\n");
    expect(parseTrustedRecipientHeader(headers, "X-Original-To")).toEqual({ kind: "malformed" });
  });
});

describe("normalizeImapRecipientAlias — address-shape normalization", () => {
  const domain = "ingest.example.test";
  const key = { generation: 3, secret: "normalize-test-alias-secret-at-least-32-chars" };
  const userId = "9c3b6f0a-2222-4aaa-8bbb-000000000003";

  it("unwraps angle brackets, and folds domain/token/prefix case alike (#336: case-fold the 'orbit+' prefix)", () => {
    const alias = deriveImapRecipientAlias(userId, domain, key);
    const atIndex = alias.indexOf("@");
    const token = alias.slice("orbit+".length, atIndex);
    const wrapped = `<orbit+${token.toUpperCase()}@${domain.toUpperCase()}>`;
    expect(normalizeImapRecipientAlias(wrapped, domain)).toBe(alias.toLowerCase());

    // BEHAVIOUR CHANGE (#336 decision, 2026-08-13, fixing characterization
    // oddity #9 from #298): the "orbit+" literal is now folded the same way
    // as the token and domain (ALIAS_LOCAL_PART gained the /i flag). Gmail,
    // Outlook, and Mailcow all deliver sub-addressed mail with the local part
    // treated case-insensitively, so a relay/sender that upcases the address
    // must still attribute correctly instead of silently losing attribution.
    // This test previously pinned the OLD (case-sensitive-prefix) behaviour;
    // it now pins the new, intentional, case-insensitive-prefix behaviour.
    for (const prefix of ["Orbit+", "ORBIT+", "oRbIt+"]) {
      expect(normalizeImapRecipientAlias(`${prefix}${token}@${domain}`, domain)).toBe(alias.toLowerCase());
    }

    // A wrong prefix (not just wrong case) must still be refused.
    for (const wrongPrefix of ["orbitx+", "orbi+"]) {
      expect(normalizeImapRecipientAlias(`${wrongPrefix}${token}@${domain}`, domain)).toBeUndefined();
    }
  });

  it("accepts a comma-bearing header value as one literal string, but normalization then rejects it as malformed", () => {
    const headers = Buffer.from(`X-Original-To: one@${domain}, two@${domain}\r\n`);
    const parsed = parseTrustedRecipientHeader(headers, "X-Original-To");
    expect(parsed).toEqual({ kind: "value", value: `one@${domain}, two@${domain}` });
    // The header parser does not treat the comma as a list delimiter; that
    // rejection only happens one layer up, in address normalization.
    expect(normalizeImapRecipientAlias(parsed.kind === "value" ? parsed.value : "", domain)).toBeUndefined();
  });

  it("matches regardless of token/domain case, once wrapped through the same normalization", () => {
    const alias = deriveImapRecipientAlias(userId, domain, key);
    const atIndex = alias.indexOf("@");
    const token = alias.slice("orbit+".length, atIndex);
    expect(matchImapRecipientAliasGeneration(alias, userId, domain, key)).toBe(true);
    expect(matchImapRecipientAliasGeneration(`orbit+${token.toUpperCase()}@${domain.toUpperCase()}`, userId, domain, key)).toBe(true);
  });
});

// ---------------------------------------------------------------------------
// 4. Alias rotation state machine (imap-rotation.ts)
// ---------------------------------------------------------------------------

describe("decideImapRotationState — boundary and fail-closed characterization", () => {
  const now = new Date("2026-08-12T12:00:00.000Z");

  it("treats the expiry instant itself as already-elapsed (strict greater-than, not greater-or-equal)", () => {
    const expiresAt = new Date("2026-08-12T12:00:00.000Z");
    const persisted = {
      currentGeneration: 2,
      currentCommitment: "c2",
      previousGeneration: 1,
      previousExpiresAt: expiresAt,
      previousCommitment: "c1",
    };
    const config = { currentGeneration: 2, currentCommitment: "c2", previousGeneration: 1, previousExpiresAt: expiresAt, previousCommitment: "c1" };
    expect(decideImapRotationState(persisted, config, expiresAt)).toEqual({
      currentGeneration: 2, currentCommitment: "c2", previousGeneration: null, previousExpiresAt: null, previousCommitment: null,
    });
    const justBefore = new Date(expiresAt.getTime() - 1);
    expect(decideImapRotationState(persisted, config, justBefore)).toEqual(persisted);
  });

  it("fails closed rather than silently accepting a lower generation than what is persisted", () => {
    const persisted = { currentGeneration: 3, currentCommitment: "c3", previousGeneration: null, previousExpiresAt: null, previousCommitment: null };
    const regressedConfig = { currentGeneration: 2, currentCommitment: "c2" };
    expect(() => decideImapRotationState(persisted, regressedConfig, now)).toThrow(ImapRotationStaleError);
  });

  it("initializes a fresh singleton directly from configuration when nothing is persisted yet", () => {
    const config = { currentGeneration: 1, currentCommitment: "c1" };
    expect(decideImapRotationState(null, config, now)).toEqual({
      currentGeneration: 1, currentCommitment: "c1", previousGeneration: null, previousExpiresAt: null, previousCommitment: null,
    });
  });
});

// ---------------------------------------------------------------------------
// 5. Message-to-item mapping (imap-inbox.ts, reviewed-intake.ts)
// ---------------------------------------------------------------------------

describe("reviewInboxState — status/failure to UI classification mapping", () => {
  it("classifies the in-flight approval state as waiting, distinct from ready or terminal", () => {
    expect(reviewInboxState("approving", null)).toMatchObject({ classification: "waiting", canApprove: false, canDiscard: false });
  });

  it("only the specific legacy_review_item failure code unlocks cleanup-only discard on a failed row", () => {
    expect(reviewInboxState("failed", "legacy_review_item")).toMatchObject({ classification: "cleanup", canApprove: false, canDiscard: true });
    expect(reviewInboxState("failed", "attachment_processing_exhausted")).toMatchObject({ classification: "unavailable", canApprove: false, canDiscard: false });
  });

  it("gates attachment-transfer retry on every one of: recoverable status, prior approval, prior item, and an unexpired receipt", () => {
    const now = new Date("2030-01-02T00:00:00.000Z");
    const expiresAt = new Date("2030-01-03T00:00:00.000Z");
    const fullContext = { hasApprovalOperation: true, hasApprovedItem: true, expiresAt, now };
    expect(reviewInboxState("recoverable", "attachment_transfer_failed", fullContext)).toMatchObject({ classification: "retry", canApprove: true });
    expect(reviewInboxState("recoverable", "attachment_transfer_failed", { ...fullContext, hasApprovalOperation: false })).toMatchObject({ canApprove: false, classification: "retry" });
    // An unrecognized failure code on an otherwise-eligible row does not
    // qualify for the richer "retry with re-approve" classification either.
    expect(reviewInboxState("recoverable", "some_other_code", fullContext)).toMatchObject({ canApprove: false, classification: "retry" });
  });
});

describe("findReviewedIntakeCandidateReason — comparableText normalization and field priority", () => {
  it("is case- and Unicode-normalization-insensitive (NFKC folds fullwidth forms to ASCII)", () => {
    const reason = findReviewedIntakeCandidateReason(
      { title: "ｈello Insurance" }, // fullwidth 'h'
      { title: "hello Insurance", provider: null, reference: null, subtype: null },
    );
    expect(reason).toBe("matching title");
  });

  it("folds embedded control/line-separator characters and repeated whitespace before comparing", () => {
    const reason = findReviewedIntakeCandidateReason(
      { title: "Annual\u2028Cover  Plan" },
      { title: "Annual Cover Plan", provider: null, reference: null, subtype: null },
    );
    expect(reason).toBe("matching title");
  });

  it("checks title, then provider, then reference, then subtype, in that fixed order, first match wins", () => {
    const proposal = { title: "Match A", provider: "Match B", reference: "Match C", subtype: "Match D" };
    // Everything matches: title should still win.
    expect(findReviewedIntakeCandidateReason(proposal, { title: "Match A", provider: "Match B", reference: "Match C", subtype: "Match D" }))
      .toBe("matching title");
    // Only provider/reference/subtype match: provider should win over the later fields.
    expect(findReviewedIntakeCandidateReason(proposal, { title: "No match", provider: "Match B", reference: "Match C", subtype: "Match D" }))
      .toBe("matching provider");
  });
});

describe("sanitizeReviewDraftMetadata — bounded field mapping from a proposal blob", () => {
  it("keeps a syntactically valid currency/date/scheduleKind and drops the invalid variants of each", () => {
    expect(sanitizeReviewDraftMetadata({ proposal: { currency: "gbp" } }).proposal.currency).toBeUndefined();
    expect(sanitizeReviewDraftMetadata({ proposal: { currency: "GB" } }).proposal.currency).toBeUndefined();
    expect(sanitizeReviewDraftMetadata({ proposal: { currency: "GBP" } }).proposal.currency).toBe("GBP");
    expect(sanitizeReviewDraftMetadata({ proposal: { scheduleKind: "monthly" } }).proposal.scheduleKind).toBeUndefined();
    expect(sanitizeReviewDraftMetadata({ proposal: { scheduleKind: "renewal" } }).proposal.scheduleKind).toBe("renewal");
    // NOTE (flagged, not fixed): dueDate is only checked against the
    // \d{4}-\d{2}-\d{2} shape — it is never parsed as a real calendar date,
    // so a syntactically-shaped but impossible date currently survives
    // sanitization unchanged.
    expect(sanitizeReviewDraftMetadata({ proposal: { dueDate: "2026-13-40" } }).proposal.dueDate).toBe("2026-13-40");
    expect(sanitizeReviewDraftMetadata({ proposal: { dueDate: "13 Aug 2026" } }).proposal.dueDate).toBeUndefined();
  });

  it("bounds costMinor and recurrenceMonths to their documented ranges and rejects non-integers", () => {
    expect(sanitizeReviewDraftMetadata({ proposal: { costMinor: 100_000_000 } }).proposal.costMinor).toBe(100_000_000);
    expect(sanitizeReviewDraftMetadata({ proposal: { costMinor: 100_000_001 } }).proposal.costMinor).toBeUndefined();
    expect(sanitizeReviewDraftMetadata({ proposal: { costMinor: -1 } }).proposal.costMinor).toBeUndefined();
    expect(sanitizeReviewDraftMetadata({ proposal: { costMinor: 12.5 } }).proposal.costMinor).toBeUndefined();
    expect(sanitizeReviewDraftMetadata({ proposal: { recurrenceMonths: 120 } }).proposal.recurrenceMonths).toBe(120);
    expect(sanitizeReviewDraftMetadata({ proposal: { recurrenceMonths: 121 } }).proposal.recurrenceMonths).toBeUndefined();
    expect(sanitizeReviewDraftMetadata({ proposal: { recurrenceMonths: 0 } }).proposal.recurrenceMonths).toBeUndefined();
  });

  it("collapses embedded control characters and whitespace in free-text fields, and drops angle-bracket content entirely", () => {
    expect(sanitizeReviewDraftMetadata({ proposal: { title: "Annual\tCover\n\nPlan" } }).proposal.title).toBe("Annual Cover Plan");
    expect(sanitizeReviewDraftMetadata({ proposal: { title: "<script>alert(1)</script>" } }).proposal.title).toBeUndefined();
  });

  it("drops a field-evidence entry whose source/confidence do not match the known enums, independent of the proposal field itself", () => {
    const result = sanitizeReviewDraftMetadata({
      proposal: { title: "Annual Cover" },
      fieldEvidence: {
        title: { source: "ocr_guess", confidence: "high" },
        provider: { source: "parser", confidence: "certain" },
      },
    });
    expect(result.proposal.title).toBe("Annual Cover");
    expect(result.fieldEvidence).toEqual({});
  });
});
