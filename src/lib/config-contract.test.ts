import { describe, expect, it } from "vitest";

import {
  envOrbitSchema,
  evaluateReadiness,
  isValidSessionTtlSeconds,
  SESSION_TTL_SECONDS_MAX,
  SESSION_TTL_SECONDS_MIN,
  type EnvOrbitRecord,
  type OidcSecretFileFacts,
} from "./config-contract";

// SF2-F6: SESSION_TTL_SECONDS had no shape validation anywhere in the
// readiness contract (evaluateReadiness), only in env.ts's runtime auth
// config loader (z.coerce.number().int().min(900).max(2_592_000)) — so
// `orbit check` could report an invalid value "ready" and the app would
// then crash on its very next start. These are direct unit tests (no bash
// spawn, unlike config-contract.parity.test.ts): configuration.sh --check
// never tracked this key at all, so there is no real-script output to
// compare against for the new present-but-invalid case this closes, and
// every existing parity fixture leaves SESSION_TTL_SECONDS unset, so the
// fix's deliberately bash-silent absent/valid cases leave that suite
// untouched.

const NO_SECRET_FACTS: OidcSecretFileFacts = {
  secretsDirectoryExists: false,
  secretsDirectoryIsSymlink: false,
  secretsDirectoryMode: null,
  secretFileExists: false,
  secretFileIsRegular: false,
  secretFileIsSymlink: false,
  secretFileMode: null,
  secretFileSize: 0,
};

const completeCore: EnvOrbitRecord = {
  APP_URL: "https://orbit.contract-test.invalid",
  ORBIT_IMAGE: "registry.contract-test.invalid/orbit@sha256:" + "a".repeat(64),
};

describe("isValidSessionTtlSeconds (SF2-F6)", () => {
  it("accepts the loader's own bounds, inclusive", () => {
    expect(isValidSessionTtlSeconds(String(SESSION_TTL_SECONDS_MIN))).toBe(true);
    expect(isValidSessionTtlSeconds(String(SESSION_TTL_SECONDS_MAX))).toBe(true);
    expect(isValidSessionTtlSeconds("604800")).toBe(true);
  });

  it.each([
    ["below the minimum", "899"],
    ["above the maximum", "2592001"],
    ["not an integer", "900.5"],
    ["not a number at all", "a-week"],
    ["empty", ""],
    ["negative", "-900"],
  ])("rejects a value that is %s (%s)", (_label, value) => {
    expect(isValidSessionTtlSeconds(value)).toBe(false);
  });
});

describe("evaluateReadiness and SESSION_TTL_SECONDS (SF2-F6)", () => {
  it("reports ready overall when SESSION_TTL_SECONDS is absent (the loader's own default applies)", () => {
    const report = evaluateReadiness(completeCore, NO_SECRET_FACTS);
    expect(report.ok).toBe(true);
    expect(report.lines).not.toContain("missing session-ttl");
  });

  it("reports ready overall when SESSION_TTL_SECONDS is a valid in-range integer", () => {
    const report = evaluateReadiness({ ...completeCore, SESSION_TTL_SECONDS: "3600" }, NO_SECRET_FACTS);
    expect(report.ok).toBe(true);
    expect(report.lines).not.toContain("missing session-ttl");
  });

  // The bug this closes: before the fix, this fixture reported ok:true —
  // "ready" — and the exact same value then threw out of env.ts's
  // getAuthConfig the moment the app started.
  it("reports NOT ready when SESSION_TTL_SECONDS is present but out of the loader's range", () => {
    const report = evaluateReadiness({ ...completeCore, SESSION_TTL_SECONDS: "60" }, NO_SECRET_FACTS);
    expect(report.ok).toBe(false);
    expect(report.lines).toContain("missing session-ttl");
  });

  it("reports NOT ready when SESSION_TTL_SECONDS is present but not even numeric", () => {
    const report = evaluateReadiness({ ...completeCore, SESSION_TTL_SECONDS: "not-a-number" }, NO_SECRET_FACTS);
    expect(report.ok).toBe(false);
    expect(report.lines).toContain("missing session-ttl");
  });
});

// ORBIT_MEMORY_LIMIT is checked against Compose's byte-value grammar
// (b, k, kb, m, mb, g, gb; case-insensitive). Anything well-formed is
// accepted; below 1g (1073741824 bytes, 1024-based units) the readiness
// report warns about the documented import peak (about 1 GB) but stays ready.
describe("ORBIT_MEMORY_LIMIT in the settings schema", () => {
  const parse = (value: string) => envOrbitSchema.safeParse({ ORBIT_MEMORY_LIMIT: value });

  it.each(["2g", "2048m", "2GB", "2147483648", "512m", "1G", "100kb"])("accepts %s", (value) => {
    expect(parse(value).success).toBe(true);
  });

  it("accepts the setting being absent", () => {
    expect(envOrbitSchema.safeParse({}).success).toBe(true);
  });

  it.each(["2 g", "lots", "", "2.5g", "-2g", "2gib", "g"])("refuses %j with a message naming the key and the accepted form", (value) => {
    const result = parse(value);
    expect(result.success).toBe(false);
    if (result.success) return;
    const messages = result.error.issues.map((issue) => issue.message).join("\n");
    expect(messages).toContain("ORBIT_MEMORY_LIMIT");
    expect(messages).toMatch(/2g|2048m|number|unit/i);
  });
});

describe("evaluateReadiness and ORBIT_MEMORY_LIMIT floor", () => {
  const warningLines = (value: string | undefined) => {
    const record: EnvOrbitRecord = value === undefined ? completeCore : { ...completeCore, ORBIT_MEMORY_LIMIT: value };
    const report = evaluateReadiness(record, NO_SECRET_FACTS);
    return { report, warnings: report.lines.filter((line) => line.includes("ORBIT_MEMORY_LIMIT")) };
  };

  it.each(["512m", "1023m", "1073741823", "1048575k", "100mb"])("warns about the import peak for %s and stays ready", (value) => {
    const { report, warnings } = warningLines(value);
    expect(report.ok).toBe(true);
    expect(warnings).toHaveLength(1);
    expect(warnings[0]).toMatch(/1 ?GB/i);
  });

  it.each(["1g", "1024m", "1073741824", "2g", "2GB", "2147483648"])("does not warn at or above the floor for %s", (value) => {
    const { report, warnings } = warningLines(value);
    expect(report.ok).toBe(true);
    expect(warnings).toHaveLength(0);
  });

  it("does not warn when the setting is absent", () => {
    expect(warningLines(undefined).warnings).toHaveLength(0);
  });
});
