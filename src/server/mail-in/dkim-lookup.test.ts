import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  makeEd25519Key,
  makeRsaKey,
  sampleMessage,
  signatureHeaders,
  signMessage,
  type TestKey,
} from "../../../tests/support/dkim-signing";

/* The default resolver talks to DNS through node:dns/promises. Replacing that
   module is the one seam that reaches it without touching the resolver's
   signature; the stub-resolver tests below never go near it. */
const dns = vi.hoisted(() => ({ resolveTxt: vi.fn() }));
vi.mock("node:dns/promises", () => {
  class Resolver {
    resolveTxt = dns.resolveTxt;
    setServers() {}
    cancel() {}
  }
  return { resolveTxt: dns.resolveTxt, Resolver, default: { resolveTxt: dns.resolveTxt, Resolver } };
});

import { dnsDkimKeyResolver, selfVerifiedDkimDomains, type DkimKeyResolver } from "./dkim-lookup";

const RSA = makeRsaKey();
const ED = makeEd25519Key();
const SELECTOR = "s1";

/** A resolver that answers from a table keyed `selector._domainkey.domain`, and records its calls. */
function tableResolver(table: Record<string, string | undefined>) {
  const calls: Array<[string, string]> = [];
  const resolver: DkimKeyResolver = async (selector, domain) => {
    calls.push([selector, domain]);
    return table[`${selector}._domainkey.${domain}`];
  };
  return { resolver, calls };
}

beforeEach(() => {
  dns.resolveTxt.mockReset();
});

describe("selfVerifiedDkimDomains", () => {
  it("returns the domain of a signature that verifies against the published key", async () => {
    const raw = await signMessage(sampleMessage(), { domain: "example.test", selector: SELECTOR, key: RSA });
    const { resolver, calls } = tableResolver({ [`${SELECTOR}._domainkey.example.test`]: RSA.record });
    expect(await selfVerifiedDkimDomains(raw, "example.test", resolver)).toEqual(["example.test"]);
    expect(calls).toEqual([[SELECTOR, "example.test"]]);
  });

  it("verifies an ed25519 signature too", async () => {
    const raw = await signMessage(sampleMessage(), { domain: "example.test", selector: SELECTOR, key: ED });
    const { resolver } = tableResolver({ [`${SELECTOR}._domainkey.example.test`]: ED.record });
    expect(await selfVerifiedDkimDomains(raw, "example.test", resolver)).toEqual(["example.test"]);
  });

  it("returns nothing when the resolver finds no key", async () => {
    const raw = await signMessage(sampleMessage(), { domain: "example.test", selector: SELECTOR, key: RSA });
    expect(await selfVerifiedDkimDomains(raw, "example.test", async () => undefined)).toEqual([]);
  });

  it("returns nothing, and does not throw, when the resolver throws or rejects", async () => {
    const raw = await signMessage(sampleMessage(), { domain: "example.test", selector: SELECTOR, key: RSA });
    await expect(selfVerifiedDkimDomains(raw, "example.test", async () => { throw new Error("SERVFAIL"); })).resolves.toEqual([]);
    await expect(selfVerifiedDkimDomains(raw, "example.test", () => Promise.reject(new Error("timeout")))).resolves.toEqual([]);
    await expect(selfVerifiedDkimDomains(raw, "example.test", () => { throw new Error("sync failure"); })).resolves.toEqual([]);
  });

  it("returns nothing for a record that is not a usable key", async () => {
    const raw = await signMessage(sampleMessage(), { domain: "example.test", selector: SELECTOR, key: RSA });
    for (const record of ["v=DKIM1; k=rsa; p=", "v=spf1 -all", "garbage", "v=DKIM1; k=rsa; p=AAAA"]) {
      expect(await selfVerifiedDkimDomains(raw, "example.test", async () => record), record).toEqual([]);
    }
  });

  it("returns nothing when the key is not the signer's", async () => {
    const raw = await signMessage(sampleMessage(), { domain: "example.test", selector: SELECTOR, key: RSA });
    expect(await selfVerifiedDkimDomains(raw, "example.test", async () => makeRsaKey().record)).toEqual([]);
  });

  it("returns nothing for a tampered message, or one whose signature has expired", async () => {
    const signed = await signMessage(sampleMessage(), { domain: "example.test", selector: SELECTOR, key: RSA });
    const tampered = Buffer.from(signed.toString().replace("Last line", "Another line"));
    expect(await selfVerifiedDkimDomains(tampered, "example.test", async () => RSA.record)).toEqual([]);

    const expiring = await signMessage(sampleMessage(), {
      domain: "example.test", selector: SELECTOR, key: RSA,
      signTime: new Date("2026-01-01T00:00:00Z"), expires: new Date("2026-01-02T00:00:00Z"),
    });
    expect(await selfVerifiedDkimDomains(expiring, "example.test", async () => RSA.record, new Date("2026-01-01T12:00:00Z")))
      .toEqual(["example.test"]);
    expect(await selfVerifiedDkimDomains(expiring, "example.test", async () => RSA.record, new Date("2026-01-03T00:00:00Z")))
      .toEqual([]);
  });

  it("returns nothing, with no lookup, for a message with no signature", async () => {
    const { resolver, calls } = tableResolver({});
    expect(await selfVerifiedDkimDomains(Buffer.from(sampleMessage()), "example.test", resolver)).toEqual([]);
    expect(await selfVerifiedDkimDomains(Buffer.alloc(0), "example.test", resolver)).toEqual([]);
    expect(calls).toEqual([]);
  });

  it("keeps the domains that verify and drops the ones that do not, in message order", async () => {
    const raw = sampleMessage();
    const good = await signatureHeaders(raw, { domain: "b.example.test", selector: "g", key: RSA });
    const bad = await signatureHeaders(raw, { domain: "a.b.example.test", selector: "b", key: ED });
    const alsoGood = await signatureHeaders(raw, { domain: "example.test", selector: "a", key: ED });
    const message = Buffer.from(`${good}${bad}${alsoGood}${raw}`);
    const { resolver } = tableResolver({
      "g._domainkey.b.example.test": RSA.record,
      "b._domainkey.a.b.example.test": RSA.record, // the wrong key for that signature
      "a._domainkey.example.test": ED.record,
    });
    expect(await selfVerifiedDkimDomains(message, "a.b.example.test", resolver)).toEqual(["b.example.test", "example.test"]);
  });

  it("makes one lookup per distinct selector and domain, and lists a domain once", async () => {
    const raw = sampleMessage();
    const first = await signatureHeaders(raw, { domain: "example.test", selector: SELECTOR, key: RSA, canonicalization: "simple/simple" });
    const sameKeyAgain = await signatureHeaders(raw, { domain: "example.test", selector: SELECTOR, key: RSA, canonicalization: "relaxed/relaxed" });
    const otherSelector = await signatureHeaders(raw, { domain: "example.test", selector: "s2", key: ED });
    const otherDomain = await signatureHeaders(raw, { domain: "mail.example.test", selector: SELECTOR, key: RSA });
    const message = Buffer.from(`${first}${sameKeyAgain}${otherSelector}${otherDomain}${raw}`);
    const { resolver, calls } = tableResolver({
      [`${SELECTOR}._domainkey.example.test`]: RSA.record,
      "s2._domainkey.example.test": ED.record,
      [`${SELECTOR}._domainkey.mail.example.test`]: RSA.record,
    });

    expect(await selfVerifiedDkimDomains(message, "mail.example.test", resolver)).toEqual(["example.test", "mail.example.test"]);
    expect(calls).toHaveLength(3);
    expect(new Set(calls.map(([selector, domain]) => `${selector}/${domain}`))).toEqual(
      new Set([`${SELECTOR}/example.test`, "s2/example.test", `${SELECTOR}/mail.example.test`]),
    );
  });

  it("makes no lookup for a signature whose domain does not align with the sender's", async () => {
    const raw = sampleMessage();
    const foreign = await signatureHeaders(raw, { domain: "evil.test", selector: "e", key: RSA });
    const above = await signatureHeaders(raw, { domain: "mail.example.test", selector: "m", key: RSA });
    const message = Buffer.from(`${foreign}${above}${raw}`);
    const { resolver, calls } = tableResolver({
      "e._domainkey.evil.test": RSA.record,
      "m._domainkey.mail.example.test": RSA.record,
    });
    expect(await selfVerifiedDkimDomains(message, "example.test", resolver)).toEqual([]);
    expect(calls).toEqual([]);
  });

  it("looks at no more than five signatures", async () => {
    const raw = sampleMessage();
    const headers: string[] = [];
    const table: Record<string, string> = {};
    for (let i = 0; i < 7; i += 1) {
      const key: TestKey = i % 2 === 0 ? RSA : ED;
      headers.push(await signatureHeaders(raw, { domain: "example.test", selector: `k${i}`, key }));
      table[`k${i}._domainkey.example.test`] = key.record;
    }
    const { resolver, calls } = tableResolver(table);
    const verified = await selfVerifiedDkimDomains(Buffer.from(`${headers.join("")}${raw}`), "example.test", resolver);

    expect(calls).toHaveLength(5);
    expect(verified).toEqual(["example.test"]);
    expect(calls.map(([selector]) => selector).sort()).toEqual(["k0", "k1", "k2", "k3", "k4"]);
  });
});

describe("dnsDkimKeyResolver", () => {
  it("asks for the selector's _domainkey name and joins the TXT chunks", async () => {
    dns.resolveTxt.mockResolvedValue([["v=DKIM1; k=rsa; ", "p=AAAA", "BBBB"]]);
    expect(await dnsDkimKeyResolver("s1", "example.test")).toBe("v=DKIM1; k=rsa; p=AAAABBBB");
    expect(dns.resolveTxt).toHaveBeenCalledWith("s1._domainkey.example.test");
  });

  it("picks the first record that looks like a key when several are published", async () => {
    dns.resolveTxt.mockResolvedValue([["v=spf1 -all"], ["unrelated text"], ["v=DKIM1; p=KEY1"], ["v=DKIM1; p=KEY2"]]);
    expect(await dnsDkimKeyResolver("s1", "example.test")).toBe("v=DKIM1; p=KEY1");

    dns.resolveTxt.mockResolvedValue([["v=spf1 -all"], ["k=rsa; p=KEY3"]]);
    expect(await dnsDkimKeyResolver("s1", "example.test")).toBe("k=rsa; p=KEY3");
  });

  it("returns undefined when there is no record or none that is a key", async () => {
    dns.resolveTxt.mockResolvedValue([]);
    expect(await dnsDkimKeyResolver("s1", "example.test")).toBeUndefined();
    dns.resolveTxt.mockResolvedValue([["v=spf1 -all"]]);
    expect(await dnsDkimKeyResolver("s1", "example.test")).toBeUndefined();
  });

  it("returns undefined, and never throws, on any DNS failure", async () => {
    for (const code of ["ENOTFOUND", "ENODATA", "ETIMEOUT", "ESERVFAIL"]) {
      dns.resolveTxt.mockRejectedValue(Object.assign(new Error(code), { code }));
      await expect(dnsDkimKeyResolver("s1", "example.test"), code).resolves.toBeUndefined();
    }
    dns.resolveTxt.mockImplementation(() => { throw new Error("synchronous failure"); });
    await expect(dnsDkimKeyResolver("s1", "example.test")).resolves.toBeUndefined();
  });

  it("is what selfVerifiedDkimDomains uses when no resolver is passed", async () => {
    const raw = await signMessage(sampleMessage(), { domain: "example.test", selector: SELECTOR, key: RSA });
    dns.resolveTxt.mockResolvedValue([[RSA.record]]);
    expect(await selfVerifiedDkimDomains(raw, "example.test")).toEqual(["example.test"]);
    expect(dns.resolveTxt).toHaveBeenCalledWith(`${SELECTOR}._domainkey.example.test`);

    dns.resolveTxt.mockRejectedValue(Object.assign(new Error("nx"), { code: "ENOTFOUND" }));
    expect(await selfVerifiedDkimDomains(raw, "example.test")).toEqual([]);
  });
});

/*
 * #1670 A-R1 (RFC 6376 §6.1.2): a temporary DNS failure is TEMPFAIL, not "no
 * key" (PERMFAIL). The resolver rejects with the DNS error code for SERVFAIL,
 * a timeout or a refused query so the caller can retry the message later;
 * NXDOMAIN and no-data stay "no key". A plain error with no DNS code keeps the
 * existing answer (nothing verified).
 */
describe("a temporary DNS failure is told apart from no key", () => {
  afterEach(() => vi.useRealTimers());
  const dnsError = (code: string) => Object.assign(new Error(`queryTxt ${code}`), { code });

  it.each(["ENOTFOUND", "ENODATA"])("the default resolver answers no key for %s", async (code) => {
    dns.resolveTxt.mockRejectedValue(dnsError(code));
    await expect(dnsDkimKeyResolver(SELECTOR, "example.test")).resolves.toBeUndefined();
  });

  it.each(["ESERVFAIL", "ETIMEOUT", "ECONNREFUSED"])("the default resolver rejects for %s", async (code) => {
    dns.resolveTxt.mockRejectedValue(dnsError(code));
    await expect(dnsDkimKeyResolver(SELECTOR, "example.test")).rejects.toMatchObject({ code });
  });

  it("the default resolver rejects when the lookup times out", async () => {
    vi.useFakeTimers();
    dns.resolveTxt.mockReturnValue(new Promise(() => undefined));
    const outcome = dnsDkimKeyResolver(SELECTOR, "example.test").then(() => "resolved", () => "rejected");
    await vi.advanceTimersByTimeAsync(6_000);
    expect(await outcome).toBe("rejected");
  });

  it.each(["ESERVFAIL", "ETIMEOUT", "ECONNREFUSED"])("selfVerifiedDkimDomains rejects, not [], when the resolver fails with %s", async (code) => {
    const raw = await signMessage(sampleMessage(), { domain: "example.test", selector: SELECTOR, key: RSA });
    await expect(selfVerifiedDkimDomains(raw, "example.test", async () => { throw dnsError(code); })).rejects.toMatchObject({ code });
  });

  it.each(["ENOTFOUND", "ENODATA"])("selfVerifiedDkimDomains still answers [] for %s", async (code) => {
    const raw = await signMessage(sampleMessage(), { domain: "example.test", selector: SELECTOR, key: RSA });
    await expect(selfVerifiedDkimDomains(raw, "example.test", async () => { throw dnsError(code); })).resolves.toEqual([]);
  });
});
