import { describe, expect, it } from "vitest";
import {
  decideAttribution,
  dkimDomainAligns,
  isAutomatedMail,
  normalizeSenderAddress,
  parseMailHeaders,
  parseTopmostAuthenticationResults,
  senderAddressFromHeaders,
  senderDomainOf,
  senderIsAuthenticated,
} from "./sender-authentication";

const TRUSTED = "mx.provider.test";

/** Builds a header block the way a provider would put it on the wire. */
function block(...lines: string[]): Buffer {
  return Buffer.from(`${lines.join("\r\n")}\r\n\r\n`);
}

const headersOf = (...lines: string[]) => parseMailHeaders(block(...lines))!;

describe("normalizeSenderAddress", () => {
  it("trims, unwraps a display name, and case-folds both halves", () => {
    expect(normalizeSenderAddress("  Tom Lawson <Tom@Example.COM> ")).toBe("tom@example.com");
    expect(normalizeSenderAddress("TOM@EXAMPLE.COM")).toBe("tom@example.com");
    expect(normalizeSenderAddress("<tom@example.com>")).toBe("tom@example.com");
  });

  it("refuses anything that is not one plain address", () => {
    for (const value of [
      undefined, "", "   ", "tom", "@example.com", "tom@", "tom@example",
      "tom@exam ple.com", "tom@example.com, sarah@example.com",
      "tom@-example.com", "tom@example..com", `${"a".repeat(400)}@example.com`,
    ]) {
      expect(normalizeSenderAddress(value)).toBeUndefined();
    }
  });

  it("hands back the domain half of a normalised address", () => {
    expect(senderDomainOf("tom@mail.example.com")).toBe("mail.example.com");
  });
});

describe("parseMailHeaders", () => {
  it("unfolds a continued header, because providers fold Authentication-Results", () => {
    const headers = headersOf(
      "Authentication-Results: mx.provider.test;",
      "\tdmarc=pass header.from=example.com;",
      "\tdkim=pass header.d=example.com",
    );
    expect(headers).toHaveLength(1);
    expect(headers[0].value).toContain("dkim=pass header.d=example.com");
  });

  it("fails closed on a block it cannot read rather than reading half of it", () => {
    expect(parseMailHeaders(undefined)).toBeUndefined();
    expect(parseMailHeaders(Buffer.alloc(0))).toBeUndefined();
    expect(parseMailHeaders(Buffer.from("\tcontinuation with nothing above it\r\n"))).toBeUndefined();
    expect(parseMailHeaders(Buffer.from("no-colon-here\r\n"))).toBeUndefined();
    expect(parseMailHeaders(Buffer.from("Bad Name: value\r\n"))).toBeUndefined();
    expect(parseMailHeaders(Buffer.from("From: a@b.test\rmissing the newline\r\n"))).toBeUndefined();
    expect(parseMailHeaders(Buffer.alloc(64 * 1024 + 1, 0x41))).toBeUndefined();
  });
});

describe("senderAddressFromHeaders", () => {
  it("reads the address a message claims to be from", () => {
    expect(senderAddressFromHeaders(headersOf("From: Tom <Tom@Example.com>"))).toBe("tom@example.com");
  });

  it("attributes nothing when From names more than one address", () => {
    expect(senderAddressFromHeaders(headersOf("From: a@example.com, b@example.com"))).toBeUndefined();
  });

  it("attributes nothing when there is no From at all", () => {
    expect(senderAddressFromHeaders(headersOf("Subject: no sender"))).toBeUndefined();
  });
});

describe("parseTopmostAuthenticationResults", () => {
  it("reads the verdict, its authserv-id and every passing signing domain", () => {
    const verdict = parseTopmostAuthenticationResults(headersOf(
      "Authentication-Results: MX.Provider.Test; spf=pass; dkim=pass header.d=Example.com; dmarc=pass",
    ))!;
    expect(verdict.authservId).toBe("mx.provider.test");
    expect(verdict.dmarcPass).toBe(true);
    expect(verdict.dkimPassDomains).toEqual(["example.com"]);
  });

  it("ignores comments, which a sender may put anywhere in the header", () => {
    const verdict = parseTopmostAuthenticationResults(headersOf(
      "Authentication-Results: mx.provider.test; dmarc=pass (a comment; with a semicolon) header.from=example.com",
    ))!;
    expect(verdict.authservId).toBe("mx.provider.test");
    expect(verdict.dmarcPass).toBe(true);
  });

  it("reads the topmost header only — the ones below it arrived with the message", () => {
    const verdict = parseTopmostAuthenticationResults(headersOf(
      "Authentication-Results: mx.provider.test; dmarc=fail",
      "Authentication-Results: mx.provider.test; dmarc=pass",
    ))!;
    expect(verdict.dmarcPass).toBe(false);
  });
});

describe("senderIsAuthenticated", () => {
  it("believes a dmarc=pass written by the trusted provider", () => {
    const headers = headersOf("Authentication-Results: mx.provider.test; dmarc=pass header.from=example.com");
    expect(senderIsAuthenticated(headers, "example.com", TRUSTED)).toBe(true);
  });

  it("believes a dkim=pass whose signing domain covers the sender", () => {
    const aligned = headersOf("Authentication-Results: mx.provider.test; dkim=pass header.d=example.com");
    expect(senderIsAuthenticated(aligned, "example.com", TRUSTED)).toBe(true);
    expect(senderIsAuthenticated(aligned, "mail.example.com", TRUSTED)).toBe(true);
  });

  it("refuses a dkim=pass signed for somebody else's domain (the forged-From case)", () => {
    const headers = headersOf("Authentication-Results: mx.provider.test; dkim=pass header.d=attacker.test");
    expect(senderIsAuthenticated(headers, "example.com", TRUSTED)).toBe(false);
    /* And not the other way round either: a signature for the sub-domain does
       not vouch for the parent. */
    expect(dkimDomainAligns("mail.example.com", "example.com")).toBe(false);
  });

  it("refuses a verdict written by anyone but the provider we trust", () => {
    const headers = headersOf("Authentication-Results: attacker.test; dmarc=pass");
    expect(senderIsAuthenticated(headers, "example.com", TRUSTED)).toBe(false);
  });

  it("refuses a passing verdict that a hostile sender put below the provider's own", () => {
    /* The provider prepends its header, so the sender's copy is always
       underneath. Reading anything but the topmost is reading the attacker. */
    const headers = headersOf(
      "Authentication-Results: mx.provider.test; dmarc=fail header.from=example.com",
      "Authentication-Results: mx.provider.test; dmarc=pass header.from=example.com",
    );
    expect(senderIsAuthenticated(headers, "example.com", TRUSTED)).toBe(false);
  });

  it("refuses when there is no verdict, no trusted identity, or no sending domain", () => {
    expect(senderIsAuthenticated(headersOf("From: tom@example.com"), "example.com", TRUSTED)).toBe(false);
    const passing = headersOf("Authentication-Results: mx.provider.test; dmarc=pass");
    expect(senderIsAuthenticated(passing, "example.com", "")).toBe(false);
    expect(senderIsAuthenticated(passing, "example.com", "   ")).toBe(false);
    expect(senderIsAuthenticated(passing, "", TRUSTED)).toBe(false);
  });

  it("refuses every result that is not a pass", () => {
    for (const result of ["fail", "softfail", "none", "neutral", "temperror", "permerror", "policy"]) {
      const headers = headersOf(`Authentication-Results: mx.provider.test; dmarc=${result}; dkim=${result} header.d=example.com`);
      expect(senderIsAuthenticated(headers, "example.com", TRUSTED)).toBe(false);
    }
  });
});

describe("isAutomatedMail", () => {
  it("recognises every automated marker the reply must not answer", () => {
    expect(isAutomatedMail(headersOf("Auto-Submitted: auto-replied"))).toBe(true);
    expect(isAutomatedMail(headersOf("Auto-Submitted: auto-generated; owner=x"))).toBe(true);
    expect(isAutomatedMail(headersOf("Precedence: bulk"))).toBe(true);
    expect(isAutomatedMail(headersOf("Precedence: LIST"))).toBe(true);
    expect(isAutomatedMail(headersOf("Precedence: junk"))).toBe(true);
    expect(isAutomatedMail(headersOf("List-Id: <announce.example.com>"))).toBe(true);
    expect(isAutomatedMail(headersOf("Return-Path: <>"))).toBe(true);
  });

  it("lets ordinary mail through, including an explicit Auto-Submitted: no", () => {
    expect(isAutomatedMail(headersOf("From: tom@example.com"))).toBe(false);
    expect(isAutomatedMail(headersOf("Auto-Submitted: no"))).toBe(false);
    expect(isAutomatedMail(headersOf("Return-Path: <tom@example.com>"))).toBe(false);
    expect(isAutomatedMail(headersOf("Precedence: first-class"))).toBe(false);
  });
});

describe("decideAttribution", () => {
  const A = "member-a";
  const B = "member-b";

  it("attributes to the authenticated verified sender, alias or no alias", () => {
    expect(decideAttribution({ senderUserId: A, senderAuthenticated: true }))
      .toEqual({ userId: A, attributedBy: "sender" });
    expect(decideAttribution({ senderUserId: A, senderAuthenticated: true, aliasUserId: A }))
      .toEqual({ userId: A, attributedBy: "sender_and_alias" });
  });

  it("attributes nothing when the address is not a verified one", () => {
    expect(decideAttribution({ senderAuthenticated: true, aliasUserId: A }))
      .toEqual({ failureCode: "sender_unverified" });
  });

  it("attributes nothing when the provider did not vouch for the sender", () => {
    /* The forged-From case: writing a member's address in From is free, so
       without the provider's verdict it buys nothing — not even their own
       alias alongside it. */
    expect(decideAttribution({ senderUserId: A, senderAuthenticated: false, aliasUserId: A }))
      .toEqual({ failureCode: "sender_unauthenticated" });
  });

  it("attributes nothing when the alias names a different member than the sender", () => {
    expect(decideAttribution({ senderUserId: A, senderAuthenticated: true, aliasUserId: B }))
      .toEqual({ failureCode: "sender_alias_mismatch" });
  });
});
