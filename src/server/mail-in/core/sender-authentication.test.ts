import { describe, expect, it } from "vitest";
import {
  decideAttribution,
  dkimDomainAligns,
  isAutomatedMail,
  normalizeSenderAddress,
  parseMailHeaders,
  senderAddressFromHeaders,
  senderDomainOf,
  senderIsAuthenticated,
} from "./sender-authentication";

/** Builds a header block the way a provider would put it on the wire. */
function block(...lines: string[]): Buffer {
  return Buffer.from(`${lines.join("\r\n")}\r\n\r\n`);
}

const headersOf = (...lines: string[]) => parseMailHeaders(block(...lines))!;

describe("normalizeSenderAddress", () => {
  it("trims, unwraps a display name, and case-folds both halves", () => {
    expect(normalizeSenderAddress("  Ned Harlow <Ned@Example.COM> ")).toBe("ned@example.com");
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

/*
 * #1681 (owner decision 86a): the only evidence that a `From` may be believed
 * is a DKIM signature Orbit verified itself against the sender's published key,
 * aligned with the `From` domain. An `Authentication-Results` header is never
 * evidence, whoever it claims to be written by: on a self-hosted server an
 * authenticated sibling mailbox can submit one and nothing strips it
 * (RFC 8601 §7.1). `senderIsAuthenticated` takes no authserv-id any more:
 * (headers, sendingDomain, selfVerifiedDomains).
 */
const FORMER_TRUSTED = "mx.provider.test";

describe("the provider's Authentication-Results header is not evidence (#1681)", () => {
  it("does not export a reader for the header any more", async () => {
    const module = await import("./sender-authentication");
    expect(module).not.toHaveProperty("parseTopmostAuthenticationResults");
  });

  it("refuses a topmost dmarc=pass naming the formerly trusted authserv-id, with no verified signature", () => {
    const forged = headersOf(
      `Authentication-Results: ${FORMER_TRUSTED}; dmarc=pass header.from=example.com`,
      "From: Member <member@example.com>",
    );
    expect(senderIsAuthenticated(forged, "example.com")).toBe(false);
    expect(senderIsAuthenticated(forged, "example.com", [])).toBe(false);
  });

  it("refuses a topmost dkim=pass whose header.d aligns with the sender, with no verified signature", () => {
    const forged = headersOf(
      `Authentication-Results: ${FORMER_TRUSTED}; dkim=pass header.d=example.com; dmarc=pass header.from=example.com`,
      "From: Member <member@example.com>",
    );
    expect(senderIsAuthenticated(forged, "example.com")).toBe(false);
    expect(senderIsAuthenticated(forged, "mail.example.com", [])).toBe(false);
  });

  it("refuses the forged header beside a valid signature for a different domain", () => {
    const forged = headersOf(
      `Authentication-Results: ${FORMER_TRUSTED}; dmarc=pass header.from=example.com; dkim=pass header.d=example.com`,
      "From: Member <member@example.com>",
    );
    expect(senderIsAuthenticated(forged, "example.com", ["attacker.test"])).toBe(false);
  });

  it("refuses an auth=pass smtp.auth claim naming the exact From address (A-SEC1 stays)", () => {
    const forged = headersOf(
      `Authentication-Results: ${FORMER_TRUSTED}; auth=pass smtp.auth=member@example.com`,
      "From: Member <member@example.com>",
    );
    expect(senderIsAuthenticated(forged, "example.com")).toBe(false);
  });

  it("does not attribute a message whose only proof is the forged header", () => {
    const forged = headersOf(`Authentication-Results: ${FORMER_TRUSTED}; dmarc=pass`, "From: member@example.com");
    const authenticated = senderIsAuthenticated(forged, "example.com");
    expect(decideAttribution({ senderUserId: "member-1", senderAuthenticated: authenticated, aliasUserId: "member-1" }))
      .toEqual({ failureCode: "sender_unauthenticated" });
  });
});

describe("senderIsAuthenticated: only a self-verified aligned signature (#1655, #1681)", () => {
  const noVerdict = headersOf("From: member@example.test");

  it("authenticates a sending domain a verified signature covers", () => {
    expect(senderIsAuthenticated(noVerdict, "example.test", ["example.test"])).toBe(true);
  });

  it("authenticates it beside a forged or failing header too: the header is ignored either way", () => {
    const failing = headersOf(`Authentication-Results: ${FORMER_TRUSTED}; dmarc=fail; dkim=fail header.d=example.test`, "From: member@example.test");
    expect(senderIsAuthenticated(failing, "example.test", ["example.test"])).toBe(true);
    const forged = headersOf(`Authentication-Results: ${FORMER_TRUSTED}; auth=pass smtp.auth=member@example.test`, "From: member@example.test");
    expect(senderIsAuthenticated(forged, "example.test", ["example.test"])).toBe(true);
  });

  it("aligns a signature for a parent domain of the sender", () => {
    expect(senderIsAuthenticated(noVerdict, "mail.example.test", ["example.test"])).toBe(true);
    expect(senderIsAuthenticated(noVerdict, "a.b.example.test", ["example.test"])).toBe(true);
  });

  it("does not align a signature for a sibling, child or unrelated domain", () => {
    expect(senderIsAuthenticated(noVerdict, "mail.example.test", ["post.example.test"])).toBe(false);
    expect(senderIsAuthenticated(noVerdict, "example.test", ["mail.example.test"])).toBe(false);
    expect(senderIsAuthenticated(noVerdict, "example.test", ["attacker.test"])).toBe(false);
    expect(senderIsAuthenticated(noVerdict, "example.test", ["badexample.test"])).toBe(false);
  });

  it("matches any of several verified domains", () => {
    expect(senderIsAuthenticated(noVerdict, "example.test", ["attacker.test", "example.test"])).toBe(true);
  });

  it("authenticates nothing for an empty sending domain, or when no domain was verified", () => {
    expect(senderIsAuthenticated(noVerdict, "", ["example.test"])).toBe(false);
    expect(senderIsAuthenticated(noVerdict, "example.test", [])).toBe(false);
    expect(senderIsAuthenticated(noVerdict, "example.test")).toBe(false);
  });
});

describe("dkimDomainAligns", () => {
  it("is exact match or the sender under the signer, never the other way round", () => {
    expect(dkimDomainAligns("example.com", "example.com")).toBe(true);
    expect(dkimDomainAligns("example.com", "mail.example.com")).toBe(true);
    expect(dkimDomainAligns("mail.example.com", "example.com")).toBe(false);
    expect(dkimDomainAligns("post.example.com", "mail.example.com")).toBe(false);
    expect(dkimDomainAligns("example.com", "badexample.com")).toBe(false);
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
