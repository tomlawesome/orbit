import { mkdtempSync, rmSync, statSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";

import {
  OIDC_DISCOVERY_MAX_BYTES,
  buildDiscoveryUrl,
  classifyOidcFetchResult,
  validateDiscoveryDocument,
  verifyOidcDiscovery,
  type OidcDiscoveryAdapters,
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

afterEach(() => {
  for (const dir of sandboxes.splice(0)) rmSync(dir, { recursive: true, force: true });
});

function seedIssuer(dir: string, issuer: string): void {
  writeFileSync(join(dir, ".env-orbit"), `OIDC_ISSUER=${issuer}\n`, { mode: 0o600 });
}

function fakeAdapters(overrides: Partial<OidcDiscoveryAdapters> = {}): OidcDiscoveryAdapters {
  return {
    fetch: { fetch: () => ({ curlExitCode: 0, httpStatus: "200" }) },
    sandbox: { validate: () => true },
    ...overrides,
  };
}

describe("verifyOidcDiscovery orchestration", () => {
  it("fails closed with install.sh's exact message when OIDC_ISSUER is missing", () => {
    const dir = makeSandbox();
    writeFileSync(join(dir, ".env-orbit"), "APP_URL=https://orbit.example.invalid\n", { mode: 0o600 });
    const result = verifyOidcDiscovery(dir, join(dir, "oidc-discovery.json"), fakeAdapters());
    expect(result).toEqual({
      status: "failed",
      reason: "configuration-failure",
      action: "retry",
      message: "OIDC_ISSUER requires attention; run the guided configuration and rerun the installer.",
    });
  });

  it("propagates a provider-unavailable fetch classification (#25)", () => {
    const dir = makeSandbox();
    seedIssuer(dir, "https://idp.example.invalid");
    const result = verifyOidcDiscovery(
      dir,
      join(dir, "oidc-discovery.json"),
      fakeAdapters({ fetch: { fetch: () => ({ curlExitCode: 7, httpStatus: "000" }) } }),
    );
    expect(result).toMatchObject({ status: "failed", reason: "provider-unavailable" });
  });

  it("refuses a symlinked discovery file even after a successful fetch (#26)", () => {
    const dir = makeSandbox();
    seedIssuer(dir, "https://idp.example.invalid");
    const discoveryPath = join(dir, "oidc-discovery.json");
    const elsewhere = join(dir, "elsewhere.json");
    writeFileSync(elsewhere, VALID_DOCUMENT);
    symlinkSync(elsewhere, discoveryPath);

    const result = verifyOidcDiscovery(
      dir,
      discoveryPath,
      fakeAdapters({
        fetch: {
          fetch: () => ({ curlExitCode: 0, httpStatus: "200" }),
        },
      }),
    );
    expect(result).toMatchObject({ status: "failed", reason: "configuration-failure" });
  });

  it("refuses an on-disk file exceeding the byte cap even after curl's own limit (#26)", () => {
    const dir = makeSandbox();
    seedIssuer(dir, "https://idp.example.invalid");
    const discoveryPath = join(dir, "oidc-discovery.json");
    const result = verifyOidcDiscovery(dir, discoveryPath, {
      fetch: {
        fetch: (_url, destination) => {
          writeFileSync(destination, "x".repeat(OIDC_DISCOVERY_MAX_BYTES + 1));
          return { curlExitCode: 0, httpStatus: "200" };
        },
      },
      sandbox: { validate: () => true },
    });
    expect(result).toMatchObject({ status: "failed", reason: "configuration-failure" });
  });

  it("forces the discovery file to mode 600 on success (#26)", () => {
    const dir = makeSandbox();
    seedIssuer(dir, "https://idp.example.invalid");
    const discoveryPath = join(dir, "oidc-discovery.json");
    const result = verifyOidcDiscovery(dir, discoveryPath, {
      fetch: {
        fetch: (_url, destination) => {
          writeFileSync(destination, VALID_DOCUMENT, { mode: 0o644 });
          return { curlExitCode: 0, httpStatus: "200" };
        },
      },
      sandbox: { validate: () => true },
    });
    expect(result).toEqual({ status: "ok" });
    expect(statSync(discoveryPath).mode & 0o777).toBe(0o600);
  });

  it("refuses when the sandbox adapter rejects the document (#27)", () => {
    const dir = makeSandbox();
    seedIssuer(dir, "https://idp.example.invalid");
    const discoveryPath = join(dir, "oidc-discovery.json");
    const result = verifyOidcDiscovery(dir, discoveryPath, {
      fetch: {
        fetch: (_url, destination) => {
          writeFileSync(destination, VALID_DOCUMENT);
          return { curlExitCode: 0, httpStatus: "200" };
        },
      },
      sandbox: { validate: () => false },
    });
    expect(result).toMatchObject({ status: "failed", reason: "configuration-failure" });
  });

  it("succeeds end to end when every stage agrees", () => {
    const dir = makeSandbox();
    seedIssuer(dir, "https://idp.example.invalid");
    const discoveryPath = join(dir, "oidc-discovery.json");
    let calledUrl = "";
    let sandboxIssuer = "";
    const result = verifyOidcDiscovery(dir, discoveryPath, {
      fetch: {
        fetch: (url, destination) => {
          calledUrl = url;
          writeFileSync(destination, VALID_DOCUMENT);
          return { curlExitCode: 0, httpStatus: "200" };
        },
      },
      sandbox: {
        validate: (issuer) => {
          sandboxIssuer = issuer;
          return true;
        },
      },
    });
    expect(result).toEqual({ status: "ok" });
    expect(calledUrl).toBe("https://idp.example.invalid/.well-known/openid-configuration");
    expect(sandboxIssuer).toBe("https://idp.example.invalid");
  });
});
