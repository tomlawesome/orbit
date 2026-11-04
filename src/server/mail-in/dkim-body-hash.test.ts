import { beforeEach, describe, expect, it, vi } from "vitest";
import { makeEd25519Key, makeRsaKey, sampleMessage, signatureHeaders } from "../../../tests/support/dkim-signing";

/*
 * #1670 G-A2: the body hash is computed once per canonicalization (and length
 * limit) and reused across a message's signatures, instead of re-hashing the
 * whole body for each. Counted at node:crypto: every hash finished after
 * being fed a body's worth of bytes, in one piece or in chunks, is one body hash.
 */
const hashing = vi.hoisted(() => ({ bodySizedUpdates: 0 }));
vi.mock("node:crypto", async (importOriginal) => {
  const actual = await importOriginal<typeof import("node:crypto")>();
  const createHash = ((...args: Parameters<typeof actual.createHash>) => {
    const hash = actual.createHash(...args);
    const update = hash.update.bind(hash) as (data: unknown, ...rest: unknown[]) => typeof hash;
    const digest = hash.digest.bind(hash) as (...rest: unknown[]) => unknown;
    let fed = 0;
    (hash as unknown as { update: unknown }).update = (data: unknown, ...rest: unknown[]) => {
      fed += typeof data === "string" || data instanceof Uint8Array ? data.length : 0;
      return update(data, ...rest);
    };
    (hash as unknown as { digest: unknown }).digest = (...rest: unknown[]) => {
      if (fed >= 100_000) hashing.bodySizedUpdates += 1;
      return digest(...rest);
    };
    return hash;
  }) as typeof actual.createHash;
  return { ...actual, createHash, default: { ...actual, createHash } };
});

import { selfVerifiedDkimDomains } from "./dkim-lookup";

const RSA = makeRsaKey();
const ED = makeEd25519Key();
const BODY = `${"A line of body text that is long enough to matter. ".repeat(2).trim()}\r\n`.repeat(2_500);

beforeEach(() => { hashing.bodySizedUpdates = 0; });

describe("a message with several signatures", () => {
  it("hashes the body once per canonicalization, not once per signature", async () => {
    const raw = sampleMessage({ body: BODY });
    const headers = [
      await signatureHeaders(raw, { domain: "example.test", selector: "r1", key: RSA, canonicalization: "relaxed/relaxed" }),
      await signatureHeaders(raw, { domain: "example.test", selector: "r2", key: ED, canonicalization: "relaxed/relaxed" }),
      await signatureHeaders(raw, { domain: "example.test", selector: "r3", key: RSA, canonicalization: "relaxed/relaxed" }),
      await signatureHeaders(raw, { domain: "example.test", selector: "s1", key: ED, canonicalization: "relaxed/simple" }),
    ].join("");
    const records: Record<string, string> = {
      "r1._domainkey.example.test": RSA.record,
      "r2._domainkey.example.test": ED.record,
      "r3._domainkey.example.test": RSA.record,
      "s1._domainkey.example.test": ED.record,
    };
    hashing.bodySizedUpdates = 0;
    const domains = await selfVerifiedDkimDomains(
      Buffer.from(`${headers}${raw}`),
      "example.test",
      async (selector, domain) => records[`${selector}._domainkey.${domain}`],
    );
    expect(domains).toEqual(["example.test"]);
    // two canonical forms of the body (relaxed, simple), four signatures
    expect(hashing.bodySizedUpdates).toBe(2);
  });
});
