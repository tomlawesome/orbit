import { describe, expect, it } from "vitest";
import {
  deriveImapRecipientAlias,
  digestImapAliasConfiguration,
  digestImapRecipientAlias,
  matchImapRecipientAliasGeneration,
  parseTrustedRecipientHeader,
} from "./imap-recipient";

const domain = "ingest.example.test";
const userId = "6f7aa3dc-347d-4ff4-bf50-bc4f4ffc054a";
const current = { generation: 7, secret: "current-alias-secret-that-is-long-enough" };
const previous = {
  generation: 6,
  secret: "previous-alias-secret-that-is-long-enough",
  expiresAt: new Date("2026-08-15T00:00:00.000Z"),
};

describe("IMAP recipient alias derivation", () => {
  it("is deterministic, domain-separated, and does not disclose identity material", () => {
    const alias = deriveImapRecipientAlias(userId, domain, current);
    expect(alias).toBe(deriveImapRecipientAlias(userId, domain, current));
    expect(alias).toMatch(/^orbit\+[A-Za-z0-9_-]+@ingest\.example\.test$/);
    expect(alias).not.toContain(userId);
    expect(alias).not.toContain(String(current.generation));
    expect(alias).not.toContain(current.secret);
    expect(deriveImapRecipientAlias(userId, "other.example.test", current)).not.toBe(alias);
    expect(deriveImapRecipientAlias(userId, domain, previous)).not.toBe(alias);
  });

  it("matches only the configured current or unexpired previous generation", () => {
    const currentAlias = deriveImapRecipientAlias(userId, domain, current);
    const previousAlias = deriveImapRecipientAlias(userId, domain, previous);
    expect(matchImapRecipientAliasGeneration(currentAlias, userId, domain, current, new Date("2026-07-29T00:00:00.000Z"))).toBe(true);
    expect(matchImapRecipientAliasGeneration(previousAlias, userId, domain, previous, new Date("2026-07-29T00:00:00.000Z"))).toBe(true);
    expect(matchImapRecipientAliasGeneration(previousAlias, userId, domain, previous, new Date("2026-08-16T00:00:00.000Z"))).toBe(false);
    expect(digestImapRecipientAlias(currentAlias)).toHaveLength(64);
  });

  it("commits the normalized domain, generation, and key without persisting either secret or address", () => {
    const commitment = digestImapAliasConfiguration(domain, "X-Original-To", current);
    expect(commitment).toHaveLength(64);
    expect(commitment).toBe(digestImapAliasConfiguration(domain.toUpperCase(), "x-original-to", current));
    expect(digestImapAliasConfiguration("other.example.test", "X-Original-To", current)).not.toBe(commitment);
    expect(digestImapAliasConfiguration(domain, "X-Other-To", current)).not.toBe(commitment);
    expect(digestImapAliasConfiguration(domain, "X-Original-To", { ...current, generation: 8 })).not.toBe(commitment);
    expect(digestImapAliasConfiguration(domain, "X-Original-To", { ...current, secret: "different-alias-secret-that-is-long-enough" })).not.toBe(commitment);
    expect(commitment).not.toContain(current.secret);
    expect(commitment).not.toContain(deriveImapRecipientAlias(userId, domain, current));
  });
});

describe("trusted recipient header parsing", () => {
  it("requires exactly one unfolded trusted header value", () => {
    expect(parseTrustedRecipientHeader(Buffer.from("X-Original-To: orbit+alias@ingest.example.test\r\nTo: attacker@example.test\r\n"), "X-Original-To"))
      .toEqual({ kind: "value", value: "orbit+alias@ingest.example.test" });
    expect(parseTrustedRecipientHeader(Buffer.from("To: attacker@example.test\r\n"), "X-Original-To"))
      .toEqual({ kind: "missing" });
    expect(parseTrustedRecipientHeader(Buffer.from("X-Original-To: one@example.test\r\nX-Original-To: two@example.test\r\n"), "X-Original-To"))
      .toEqual({ kind: "duplicate" });
    expect(parseTrustedRecipientHeader(Buffer.from("X-Original-To: one@example.test\r\n\tcontinued\r\n"), "X-Original-To"))
      .toEqual({ kind: "folded" });
  });

  it("bounds and rejects malformed trusted values without retaining them", () => {
    expect(parseTrustedRecipientHeader(Buffer.from("X-Original-To: one@example.test, two@example.test\r\n"), "X-Original-To"))
      .toEqual({ kind: "value", value: "one@example.test, two@example.test" });
    expect(parseTrustedRecipientHeader(Buffer.from(`X-Original-To: ${"x".repeat(513)}\r\n`), "X-Original-To"))
      .toEqual({ kind: "malformed" });
  });
});
