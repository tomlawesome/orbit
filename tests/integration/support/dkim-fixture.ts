/**
 * #1681: mail that must be attributed carries a real DKIM signature.
 *
 * Since the provider's Authentication-Results header stopped being evidence
 * (owner decision 86a), the only thing that attributes a forward is a
 * signature Orbit verifies itself against the sender's published key. A suite
 * whose fixtures must be attributed therefore signs its message source with
 * the one fixture key here, and stubs `node:dns/promises` (the only place the
 * key lookup reaches the network) with `fixtureDnsModule`, which publishes that
 * key under `FIXTURE_SELECTOR` for every domain:
 *
 *   vi.mock("node:dns/promises", async () => (await import("./support/dkim-fixture")).fixtureDnsModule());
 *
 * Messages are signed by the test-only signer in tests/support/dkim-signing.ts,
 * which shares no code with the verifier under test.
 */
import { makeRsaKey, sampleMessage, signMessage, type TestKey } from "../../support/dkim-signing";

export const FIXTURE_SELECTOR = "orbit-fixture";

let key: TestKey | undefined;
function fixtureKey(): TestKey {
  key ??= makeRsaKey();
  return key;
}

/** Every name the stub was asked for, in order; a suite clears it as it likes. */
export const fixtureDnsLookups: string[] = [];

/** A stand-in for `node:dns/promises` that publishes the fixture key for every domain. */
export function fixtureDnsModule() {
  const resolveTxt = async (name: string) => {
    fixtureDnsLookups.push(name);
    if (name.startsWith(`${FIXTURE_SELECTOR}._domainkey.`)) return [[fixtureKey().record]];
    throw Object.assign(new Error("not found"), { code: "ENOTFOUND" });
  };
  class Resolver { resolveTxt = resolveTxt; setServers() {} cancel() {} }
  return { resolveTxt, Resolver, default: { resolveTxt, Resolver } };
}

/** The bare address in a `From` value ("Name <a@b>" or "a@b"). */
function bareAddress(from: string): string {
  const open = from.lastIndexOf("<");
  const close = from.lastIndexOf(">");
  return (open !== -1 && close > open ? from.slice(open + 1, close) : from).trim();
}

/**
 * A message source from `from`, signed by `from`'s own domain with the
 * fixture key. `body` keeps sources distinct where a suite needs that.
 */
export async function signedSource(from: string, body?: string): Promise<Buffer> {
  const address = bareAddress(from);
  const domain = address.slice(address.lastIndexOf("@") + 1).toLowerCase();
  return signMessage(sampleMessage({ from: address, body }), { domain, selector: FIXTURE_SELECTOR, key: fixtureKey() });
}

/** The `From` a fixture header block names, if any. */
export function fromOfHeaders(headers: Buffer): string | undefined {
  const line = headers.toString("utf8").split(/\r?\n/u).find((candidate) => /^from:/iu.test(candidate));
  return line?.slice(line.indexOf(":") + 1).trim();
}
