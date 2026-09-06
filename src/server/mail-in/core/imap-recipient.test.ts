import { describe, expect, it } from "vitest";
import {
  deriveImapRecipientAlias,
  digestImapAliasConfiguration,
  digestImapRecipientAlias,
  imapAliasBaseFromAccount,
  matchImapRecipientAliasGeneration,
  parseTrustedRecipientHeader,
} from "./imap-recipient";

/* The base is derived from the mailbox account address, not configured
   separately (ADR-0017 decision 1, owner ruling 2026-09-02 on #336), so
   these read as plus-addresses of a real account rather than the literal
   `orbit+` local part the scheme used before. */
const base = { localPart: "intake", domain: "ingest.example.test" };
const otherDomain = { localPart: "intake", domain: "other.example.test" };
const userId = "6f7aa3dc-347d-4ff4-bf50-bc4f4ffc054a";
const current = { generation: 7, secret: "current-alias-secret-that-is-long-enough" };
const previous = {
  generation: 6,
  secret: "previous-alias-secret-that-is-long-enough",
  expiresAt: new Date("2026-08-15T00:00:00.000Z"),
};

describe("IMAP recipient alias derivation", () => {
  it("is deterministic, domain-separated, and does not disclose identity material", () => {
    const alias = deriveImapRecipientAlias(userId, base, current);
    expect(alias).toBe(deriveImapRecipientAlias(userId, base, current));
    expect(alias).toMatch(/^intake\+[A-Za-z0-9_-]{43}@ingest\.example\.test$/);
    expect(alias).not.toContain(userId);
    expect(alias).not.toContain(String(current.generation));
    expect(alias).not.toContain(current.secret);
    expect(deriveImapRecipientAlias(userId, otherDomain, current)).not.toBe(alias);
    expect(deriveImapRecipientAlias(userId, base, previous)).not.toBe(alias);
  });

  it("matches only the configured current or unexpired previous generation", () => {
    const currentAlias = deriveImapRecipientAlias(userId, base, current);
    const previousAlias = deriveImapRecipientAlias(userId, base, previous);
    expect(matchImapRecipientAliasGeneration(currentAlias, userId, base, current, new Date("2026-07-29T00:00:00.000Z"))).toBe(true);
    expect(matchImapRecipientAliasGeneration(previousAlias, userId, base, previous, new Date("2026-07-29T00:00:00.000Z"))).toBe(true);
    expect(matchImapRecipientAliasGeneration(previousAlias, userId, base, previous, new Date("2026-08-16T00:00:00.000Z"))).toBe(false);
    expect(digestImapRecipientAlias(currentAlias)).toHaveLength(64);
  });

  it("commits the normalized domain, generation, and key without persisting either secret or address", () => {
    const commitment = digestImapAliasConfiguration(base, "X-Original-To", current);
    expect(commitment).toHaveLength(64);
    expect(commitment).toBe(digestImapAliasConfiguration({ localPart: "INTAKE", domain: base.domain.toUpperCase() }, "x-original-to", current));
    expect(digestImapAliasConfiguration(otherDomain, "X-Original-To", current)).not.toBe(commitment);
    expect(digestImapAliasConfiguration(base, "X-Other-To", current)).not.toBe(commitment);
    expect(digestImapAliasConfiguration(base, "X-Original-To", { ...current, generation: 8 })).not.toBe(commitment);
    expect(digestImapAliasConfiguration(base, "X-Original-To", { ...current, secret: "different-alias-secret-that-is-long-enough" })).not.toBe(commitment);
    expect(commitment).not.toContain(current.secret);
    expect(commitment).not.toContain(deriveImapRecipientAlias(userId, base, current));
    expect(digestImapAliasConfiguration({ ...base, localPart: "other" }, "X-Original-To", current)).not.toBe(commitment);
  });

  it("derives the base from the account address, dropping any sub-address already on it", () => {
    expect(imapAliasBaseFromAccount("Intake+Existing@Ingest.Example.Test"))
      .toEqual({ localPart: "intake", domain: "ingest.example.test" });
    /* Different accounts on the same domain must not derive the same
       address, which is why the base is part of the HMAC input and not only
       the printed local part. */
    expect(deriveImapRecipientAlias(userId, { ...base, localPart: "other" }, current))
      .not.toBe(deriveImapRecipientAlias(userId, base, current));
  });

  it("rejects an address whose base local part is not the configured one", () => {
    const alias = deriveImapRecipientAlias(userId, base, current);
    expect(matchImapRecipientAliasGeneration(alias, userId, base, current)).toBe(true);
    expect(matchImapRecipientAliasGeneration(alias.replace("intake+", "orbit+"), userId, base, current)).toBe(false);
    /* Case-folded on both sides: providers treat the local part
       case-insensitively (characterization oddity #9 from #298). */
    expect(matchImapRecipientAliasGeneration(alias.replace("intake+", "INTAKE+"), userId, base, current)).toBe(true);
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
