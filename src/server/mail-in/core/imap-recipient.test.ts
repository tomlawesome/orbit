import { createHmac } from "node:crypto";
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
    expect(alias).toMatch(/^intake\+[a-z2-7]{12}@ingest\.example\.test$/);
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

/* #1646: the relay token is the first 12 characters of the lowercase base32
   (RFC 4648, no padding) HMAC-SHA256 output, under version prefix v3. The
   reference below is computed independently of the module. */
const BASE32_ALPHABET = "abcdefghijklmnopqrstuvwxyz234567";

function base32Lower(bytes: Buffer): string {
  let bits = 0;
  let value = 0;
  let out = "";
  for (const byte of bytes) {
    value = (value << 8) | byte;
    bits += 8;
    while (bits >= 5) {
      out += BASE32_ALPHABET[(value >>> (bits - 5)) & 31];
      bits -= 5;
    }
  }
  if (bits > 0) out += BASE32_ALPHABET[(value << (5 - bits)) & 31];
  return out;
}

function hmacFor(version: "v2" | "v3", uid: string, b: { localPart: string; domain: string }, key: { generation: number; secret: string }): Buffer {
  const localPart = (b.localPart || "orbit").trim().toLowerCase();
  const domain = b.domain.trim().toLowerCase();
  const input = `orbit:imap-recipient-alias:${version}\0${localPart}\0${domain}\0${key.generation}\0${uid}`;
  return createHmac("sha256", key.secret).update(input, "utf8").digest();
}

function tokenOf(alias: string): string {
  return alias.slice(alias.indexOf("+") + 1, alias.lastIndexOf("@"));
}

describe("12-character relay token (#1646)", () => {
  const users = [userId, "00000000-0000-4000-8000-000000000001", "ffffffff-ffff-4fff-bfff-ffffffffffff", "user-with-odd-id"];
  const keys = [current, previous, { generation: 1, secret: "another-alias-secret-that-is-long-enough" }];

  it("is exactly 12 characters from the lowercase base32 alphabet for several users and keys", () => {
    for (const u of users) {
      for (const k of keys) {
        const alias = deriveImapRecipientAlias(u, base, k);
        expect(alias).toMatch(/^intake\+[a-z2-7]{12}@ingest\.example\.test$/);
        expect(tokenOf(alias)).toHaveLength(12);
        expect(tokenOf(alias)).toMatch(/^[a-z2-7]{12}$/);
      }
    }
  });

  it("is deterministic for the same inputs", () => {
    expect(deriveImapRecipientAlias(userId, base, current)).toBe(deriveImapRecipientAlias(userId, base, current));
  });

  it("differs per user", () => {
    expect(deriveImapRecipientAlias("another-user-id", base, current)).not.toBe(deriveImapRecipientAlias(userId, base, current));
  });

  it("differs per key generation", () => {
    expect(deriveImapRecipientAlias(userId, base, { ...current, generation: current.generation + 1 }))
      .not.toBe(deriveImapRecipientAlias(userId, base, current));
  });

  it("differs per mailbox local part", () => {
    expect(tokenOf(deriveImapRecipientAlias(userId, { ...base, localPart: "other" }, current)))
      .not.toBe(tokenOf(deriveImapRecipientAlias(userId, base, current)));
  });

  it("differs per domain", () => {
    expect(tokenOf(deriveImapRecipientAlias(userId, otherDomain, current)))
      .not.toBe(tokenOf(deriveImapRecipientAlias(userId, base, current)));
  });

  it("equals the first 12 characters of the base32 of HMAC-SHA256 over the v3 input", () => {
    for (const u of users) {
      for (const k of keys) {
        const expected = base32Lower(hmacFor("v3", u, base, k)).slice(0, 12);
        expect(tokenOf(deriveImapRecipientAlias(u, base, k))).toBe(expected);
      }
    }
    /* The module normalises the base (trim, lower case, `orbit` fallback). */
    const messy = { localPart: " INTAKE ", domain: " Ingest.Example.Test " };
    expect(deriveImapRecipientAlias(userId, messy, current))
      .toBe(`intake+${base32Lower(hmacFor("v3", userId, messy, current)).slice(0, 12)}@ingest.example.test`);
    const empty = { localPart: "", domain: base.domain };
    expect(deriveImapRecipientAlias(userId, empty, current))
      .toBe(`orbit+${base32Lower(hmacFor("v3", userId, empty, current)).slice(0, 12)}@ingest.example.test`);
  });

  it("matches the derived address, case-folded and bracket-wrapped (#336)", () => {
    const alias = deriveImapRecipientAlias(userId, base, current);
    expect(matchImapRecipientAliasGeneration(alias, userId, base, current)).toBe(true);
    expect(matchImapRecipientAliasGeneration(alias.toUpperCase(), userId, base, current)).toBe(true);
    expect(matchImapRecipientAliasGeneration(`<${alias}>`, userId, base, current)).toBe(true);
    expect(matchImapRecipientAliasGeneration(`<${alias.toUpperCase()}>`, userId, base, current)).toBe(true);
    expect(matchImapRecipientAliasGeneration(` <${alias}> `, userId, base, current)).toBe(true);
    const token = tokenOf(alias);
    expect(matchImapRecipientAliasGeneration(`INTAKE+${token.toUpperCase()}@INGEST.EXAMPLE.TEST`, userId, base, current)).toBe(true);
  });

  it("does not match the same address for another user, generation or key", () => {
    const alias = deriveImapRecipientAlias(userId, base, current);
    expect(matchImapRecipientAliasGeneration(alias, "another-user-id", base, current)).toBe(false);
    expect(matchImapRecipientAliasGeneration(alias, userId, base, { ...current, generation: 8 })).toBe(false);
    expect(matchImapRecipientAliasGeneration(alias, userId, base, previous, new Date("2026-07-29T00:00:00.000Z"))).toBe(false);
  });

  it("does not match the old v2 address (43-character base64url token) for the same user, base and key", () => {
    const v2Token = hmacFor("v2", userId, base, current).toString("base64url");
    expect(v2Token).toHaveLength(43);
    const v2Alias = `${base.localPart}+${v2Token}@${base.domain}`;
    expect(matchImapRecipientAliasGeneration(v2Alias, userId, base, current)).toBe(false);
    expect(matchImapRecipientAliasGeneration(`<${v2Alias}>`, userId, base, current)).toBe(false);
    expect(matchImapRecipientAliasGeneration(v2Alias.toLowerCase(), userId, base, current)).toBe(false);
  });

  it("rejects a token of the wrong length without throwing", () => {
    const alias = deriveImapRecipientAlias(userId, base, current);
    const token = tokenOf(alias);
    const v2Token = hmacFor("v2", userId, base, current).toString("base64url");
    const withToken = (t: string) => `${base.localPart}+${t}@${base.domain}`;
    for (const wrong of [token.slice(0, 11), `${token}a`, token.slice(0, 1), "", v2Token, token.repeat(4)]) {
      expect(() => matchImapRecipientAliasGeneration(withToken(wrong), userId, base, current)).not.toThrow();
      expect(matchImapRecipientAliasGeneration(withToken(wrong), userId, base, current)).toBe(false);
    }
  });
});
