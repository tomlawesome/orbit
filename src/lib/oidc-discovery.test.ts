import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { type IncomingMessage, type Server, type ServerResponse, createServer } from "node:http";
import type { AddressInfo } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";

import {
  OIDC_DISCOVERY_MAX_BYTES,
  buildDiscoveryUrl,
  classifyOidcFetchResult,
  validateDiscoveryDocument,
  verifyOidcDiscovery,
  type OidcFetchResult,
} from "./oidc-discovery";

// Ported from scripts/install.sh's verify_oidc_discovery
// (docs/installer-guarantees.md, Part 1 / install.sh, guarantees #25-27 —
// cited by number in test names below). See docs/adr-notes/
// 295-install-port-plan.md for the slice this belongs to, and
// oidc-discovery.parity.test.ts for byte-for-byte parity against the
// awk-extracted live script.

describe("buildDiscoveryUrl", () => {
  it("appends .well-known/openid-configuration when the issuer has no trailing slash", () => {
    expect(buildDiscoveryUrl("https://idp.example.invalid/app/o/orbit")).toBe(
      "https://idp.example.invalid/app/o/orbit/.well-known/openid-configuration",
    );
  });

  it("avoids a doubled slash when the issuer already ends in one", () => {
    expect(buildDiscoveryUrl("https://idp.example.invalid/app/o/orbit/")).toBe(
      "https://idp.example.invalid/app/o/orbit/.well-known/openid-configuration",
    );
  });
});

const VALID_DOCUMENT = JSON.stringify({
  issuer: "https://idp.example.invalid",
  authorization_endpoint: "https://idp.example.invalid/authorize",
  token_endpoint: "https://idp.example.invalid/token",
  jwks_uri: "https://idp.example.invalid/jwks",
});

describe("validateDiscoveryDocument (#27)", () => {
  it("accepts a well-formed matching document", () => {
    expect(validateDiscoveryDocument("https://idp.example.invalid", VALID_DOCUMENT)).toBe(true);
  });

  it("rejects an issuer mismatch", () => {
    const document = JSON.stringify({ ...JSON.parse(VALID_DOCUMENT), issuer: "https://other.invalid" });
    expect(validateDiscoveryDocument("https://idp.example.invalid", document)).toBe(false);
  });

  it("rejects malformed JSON", () => {
    expect(validateDiscoveryDocument("https://idp.example.invalid", "{not json")).toBe(false);
  });

  it("rejects a document that is an array", () => {
    expect(validateDiscoveryDocument("https://idp.example.invalid", "[]")).toBe(false);
  });

  it("rejects a document that is null", () => {
    expect(validateDiscoveryDocument("https://idp.example.invalid", "null")).toBe(false);
  });

  it("rejects a document that is not an object at all", () => {
    expect(validateDiscoveryDocument("https://idp.example.invalid", '"a string"')).toBe(false);
  });

  it("rejects a missing required endpoint field", () => {
    const parsed = JSON.parse(VALID_DOCUMENT);
    delete parsed.jwks_uri;
    expect(validateDiscoveryDocument("https://idp.example.invalid", JSON.stringify(parsed))).toBe(false);
  });

  it("rejects a non-string endpoint field", () => {
    const document = JSON.stringify({ ...JSON.parse(VALID_DOCUMENT), token_endpoint: 12345 });
    expect(validateDiscoveryDocument("https://idp.example.invalid", document)).toBe(false);
  });

  it("rejects a non-URL endpoint value", () => {
    const document = JSON.stringify({ ...JSON.parse(VALID_DOCUMENT), token_endpoint: "not a url" });
    expect(validateDiscoveryDocument("https://idp.example.invalid", document)).toBe(false);
  });

  it("rejects a plain http:// endpoint", () => {
    const document = JSON.stringify({ ...JSON.parse(VALID_DOCUMENT), authorization_endpoint: "http://idp.example.invalid/authorize" });
    expect(validateDiscoveryDocument("https://idp.example.invalid", document)).toBe(false);
  });

  it("rejects an endpoint carrying embedded credentials", () => {
    const document = JSON.stringify({
      ...JSON.parse(VALID_DOCUMENT),
      authorization_endpoint: "https://user:pass@idp.example.invalid/authorize",
    });
    expect(validateDiscoveryDocument("https://idp.example.invalid", document)).toBe(false);
  });

  it("rejects an endpoint carrying a fragment", () => {
    const document = JSON.stringify({
      ...JSON.parse(VALID_DOCUMENT),
      jwks_uri: "https://idp.example.invalid/jwks#frag",
    });
    expect(validateDiscoveryDocument("https://idp.example.invalid", document)).toBe(false);
  });

  it("rejects input exceeding the parser's own byte cap", () => {
    const oversized = "x".repeat(OIDC_DISCOVERY_MAX_BYTES + 8192 + 1);
    expect(validateDiscoveryDocument("https://idp.example.invalid", oversized)).toBe(false);
  });

  it("rejects an empty issuer (no separator line to find)", () => {
    expect(validateDiscoveryDocument("", VALID_DOCUMENT)).toBe(false);
  });
});

describe("classifyOidcFetchResult (#25)", () => {
  const ok = (httpStatus: string): OidcFetchResult => ({ curlExitCode: 0, httpStatus });

  it("passes on any 2xx status", () => {
    expect(classifyOidcFetchResult(ok("200"))).toBeNull();
    expect(classifyOidcFetchResult(ok("204"))).toBeNull();
    expect(classifyOidcFetchResult(ok("299"))).toBeNull();
  });

  it("classifies http status 000 (no response line) as provider-unavailable", () => {
    expect(classifyOidcFetchResult(ok("000"))).toMatchObject({ reason: "provider-unavailable" });
  });

  it("classifies any other non-2xx status as configuration-failure", () => {
    expect(classifyOidcFetchResult(ok("404"))).toMatchObject({ reason: "configuration-failure" });
    expect(classifyOidcFetchResult(ok("500"))).toMatchObject({ reason: "configuration-failure" });
  });

  it("classifies curl exit 3 (malformed URL) as configuration-failure", () => {
    expect(classifyOidcFetchResult({ curlExitCode: 3, httpStatus: "000" })).toMatchObject({
      reason: "configuration-failure",
    });
  });

  it("classifies curl exit 63 (--max-filesize exceeded) as configuration-failure", () => {
    expect(classifyOidcFetchResult({ curlExitCode: 63, httpStatus: "000" })).toMatchObject({
      reason: "configuration-failure",
    });
  });

  it("classifies any other non-zero curl exit as provider-unavailable", () => {
    expect(classifyOidcFetchResult({ curlExitCode: 6, httpStatus: "000" })).toMatchObject({
      reason: "provider-unavailable",
    });
    expect(classifyOidcFetchResult({ curlExitCode: 28, httpStatus: "000" })).toMatchObject({
      reason: "provider-unavailable",
    });
  });
});

const sandboxes: string[] = [];
function makeSandbox(): string {
  const dir = mkdtempSync(join(tmpdir(), "orbit-oidc-discovery-"));
  sandboxes.push(dir);
  return dir;
}

const servers: Server[] = [];
afterEach(async () => {
  for (const dir of sandboxes.splice(0)) rmSync(dir, { recursive: true, force: true });
  for (const server of servers.splice(0)) {
    server.closeAllConnections();
    await new Promise((resolve) => server.close(resolve));
  }
});

function seedIssuer(dir: string, issuer: string): void {
  writeFileSync(join(dir, ".env-orbit"), `OIDC_ISSUER=${issuer}\n`, { mode: 0o600 });
}

const ISSUER = "https://idp.example.invalid";

/**
 * A local HTTP fixture server standing in for the provider. The engine only
 * ever asks for https:// URLs; the injected transport carries each request to
 * this server over plain HTTP, so everything but the socket -- protocol
 * rules, redirects, the byte cap, the time limit, the document checks -- is
 * the code under test.
 */
async function fixtureProvider(handler: (request: IncomingMessage, response: ServerResponse) => void): Promise<{ fetchImpl: typeof fetch; requests: string[] }> {
  const requests: string[] = [];
  const server = createServer((request, response) => {
    requests.push(request.url ?? "");
    handler(request, response);
  });
  servers.push(server);
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const { port } = server.address() as AddressInfo;
  const fetchImpl: typeof fetch = (input, init) => {
    const url = new URL(String(input));
    if (url.protocol !== "https:") throw new Error(`test transport only carries https URLs, got ${url.protocol}`);
    return fetch(`http://127.0.0.1:${port}${url.pathname}${url.search}`, init);
  };
  return { fetchImpl, requests };
}

describe("verifyOidcDiscovery, fetched in the engine (#1212 F5)", () => {
  it("fails closed with install.sh's exact message when OIDC_ISSUER is missing", async () => {
    const dir = makeSandbox();
    writeFileSync(join(dir, ".env-orbit"), "APP_URL=https://orbit.example.invalid\n", { mode: 0o600 });
    const result = await verifyOidcDiscovery(dir);
    expect(result).toEqual({
      status: "failed",
      reason: "configuration-failure",
      action: "retry",
      message: "OIDC_ISSUER requires attention; run the guided configuration and rerun the installer.",
    });
  });

  it("succeeds on a valid document, asking for JSON at the issuer's discovery URL", async () => {
    const dir = makeSandbox();
    seedIssuer(dir, ISSUER);
    let accept = "";
    const provider = await fixtureProvider((request, response) => {
      accept = String(request.headers.accept);
      response.writeHead(200, { "content-type": "application/json" }).end(VALID_DOCUMENT);
    });
    expect(await verifyOidcDiscovery(dir, { fetchImpl: provider.fetchImpl })).toEqual({ status: "ok" });
    expect(provider.requests).toEqual(["/.well-known/openid-configuration"]);
    expect(accept).toBe("application/json");
  });

  it("refuses a document that fails the shape rules (#27)", async () => {
    const dir = makeSandbox();
    seedIssuer(dir, ISSUER);
    const provider = await fixtureProvider((_request, response) => {
      response.writeHead(200).end(JSON.stringify({ issuer: "https://someone-else.invalid" }));
    });
    expect(await verifyOidcDiscovery(dir, { fetchImpl: provider.fetchImpl })).toMatchObject({ status: "failed", reason: "configuration-failure" });
  });

  it("treats a non-2xx response as a configuration problem (#25)", async () => {
    const dir = makeSandbox();
    seedIssuer(dir, ISSUER);
    const provider = await fixtureProvider((_request, response) => {
      response.writeHead(404).end("not here");
    });
    expect(await verifyOidcDiscovery(dir, { fetchImpl: provider.fetchImpl })).toMatchObject({ status: "failed", reason: "configuration-failure" });
  });

  it("refuses a response larger than the byte cap without reading it all (#25, #26)", async () => {
    const dir = makeSandbox();
    seedIssuer(dir, ISSUER);
    const provider = await fixtureProvider((_request, response) => {
      response.writeHead(200);
      const chunk = "x".repeat(64 * 1024);
      for (let written = 0; written <= OIDC_DISCOVERY_MAX_BYTES; written += chunk.length) response.write(chunk);
      response.end();
    });
    expect(await verifyOidcDiscovery(dir, { fetchImpl: provider.fetchImpl })).toMatchObject({ status: "failed", reason: "configuration-failure" });
  });

  it("refuses a declared length over the cap before the body arrives (#25)", async () => {
    const dir = makeSandbox();
    seedIssuer(dir, ISSUER);
    const provider = await fixtureProvider((_request, response) => {
      response.writeHead(200, { "content-length": String(OIDC_DISCOVERY_MAX_BYTES + 1) });
      response.write("{");
    });
    expect(await verifyOidcDiscovery(dir, { fetchImpl: provider.fetchImpl })).toMatchObject({ status: "failed", reason: "configuration-failure" });
  });

  it("follows an https redirect", async () => {
    const dir = makeSandbox();
    seedIssuer(dir, ISSUER);
    const provider = await fixtureProvider((request, response) => {
      if (request.url === "/.well-known/openid-configuration") {
        response.writeHead(302, { location: "https://idp.example.invalid/moved" }).end();
      } else {
        response.writeHead(200).end(VALID_DOCUMENT);
      }
    });
    expect(await verifyOidcDiscovery(dir, { fetchImpl: provider.fetchImpl })).toEqual({ status: "ok" });
    expect(provider.requests).toEqual(["/.well-known/openid-configuration", "/moved"]);
  });

  it("never follows a redirect to plain http (curl's --proto-redir =https, #25)", async () => {
    const dir = makeSandbox();
    seedIssuer(dir, ISSUER);
    const provider = await fixtureProvider((_request, response) => {
      response.writeHead(302, { location: "http://idp.example.invalid/plain" }).end();
    });
    expect(await verifyOidcDiscovery(dir, { fetchImpl: provider.fetchImpl })).toMatchObject({ status: "failed", reason: "provider-unavailable" });
    expect(provider.requests).toEqual(["/.well-known/openid-configuration"]);
  });

  it("gives up on a redirect loop", async () => {
    const dir = makeSandbox();
    seedIssuer(dir, ISSUER);
    const provider = await fixtureProvider((_request, response) => {
      response.writeHead(302, { location: "https://idp.example.invalid/.well-known/openid-configuration" }).end();
    });
    expect(await verifyOidcDiscovery(dir, { fetchImpl: provider.fetchImpl })).toMatchObject({ status: "failed", reason: "provider-unavailable" });
  });

  it("never fetches an issuer that is not https at all", async () => {
    const dir = makeSandbox();
    seedIssuer(dir, "http://idp.example.invalid");
    let called = false;
    const result = await verifyOidcDiscovery(dir, {
      fetchImpl: () => {
        called = true;
        throw new Error("must not fetch");
      },
    });
    expect(result).toMatchObject({ status: "failed", reason: "provider-unavailable" });
    expect(called).toBe(false);
  });

  it("reports a provider that does not answer within the time limit as unavailable (#25)", async () => {
    const dir = makeSandbox();
    seedIssuer(dir, ISSUER);
    const provider = await fixtureProvider(() => {
      /* never answers */
    });
    const result = await verifyOidcDiscovery(dir, { fetchImpl: provider.fetchImpl, timeoutMs: 200 });
    expect(result).toMatchObject({ status: "failed", reason: "provider-unavailable" });
  });

  it("reports a refused connection as unavailable", async () => {
    const dir = makeSandbox();
    seedIssuer(dir, ISSUER);
    const result = await verifyOidcDiscovery(dir, {
      fetchImpl: () => fetch("http://127.0.0.1:1/.well-known/openid-configuration"),
    });
    expect(result).toMatchObject({ status: "failed", reason: "provider-unavailable" });
  });
});
