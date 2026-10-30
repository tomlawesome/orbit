import { describe, expect, it } from "vitest";

import {
  envOrbitSchema,
  evaluateReadiness,
  isValidMemoryLimit,
  memoryLimitBytes,
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

// ORBIT_MEMORY_LIMIT is checked where the readiness report checks
// SESSION_TTL_SECONDS (F2): Compose's byte-value grammar, a value-free
// `missing memory-limit` line when malformed, a warning (ok unchanged) when
// well-formed but below 1 GiB, nothing when empty or absent.
// #1537: the warning keeps its 1 GB floor but no longer calls that figure the
// import peak; it names 1.45 GB as what previewing or importing a
// maximum-size archive needs.
const MEMORY_WARNING_PREFIX = "warning ORBIT_MEMORY_LIMIT is below about 1 GB";

describe("isValidMemoryLimit (F2)", () => {
  it.each(["2g", "2GB", "2GiB", "2gib", "3.5g", "2.g", ".5t", "1t", "1p", "2 g", "2 GiB", "2147483648", "5b", "2048m", "512m", "1G", "100kb", "7k", "3mb"])("accepts %j", (value) => {
    expect(isValidMemoryLimit(value)).toBe(true);
  });

  it.each(["lots", "2gi", "2x", "-2g", "2  g", " 2g", "2g ", "g", "2gibb", ""])("rejects %j", (value) => {
    expect(isValidMemoryLimit(value)).toBe(false);
  });
});

describe("memoryLimitBytes (R2, Compose's go-units grammar, 1024-based, truncated)", () => {
  it.each([["0.5g", 536870912], ["1.5GiB", 1610612736], ["2 g", 2147483648], ["2147483648", 2147483648], ["5b", 5], ["0.3k", 307]] as const)(
    "%j is %d bytes",
    (value, bytes) => {
      expect(memoryLimitBytes(value)).toBe(bytes);
    },
  );

  it.each(["lots", "2gi", ""])("is null for %j", (value) => {
    expect(memoryLimitBytes(value)).toBeNull();
  });
});

describe("ORBIT_MEMORY_LIMIT in the settings schema", () => {
  const parse = (value: string) => envOrbitSchema.safeParse({ ORBIT_MEMORY_LIMIT: value });

  it.each(["2g", "2048m", "2GB", "2147483648", "512m", "1G", "100kb", "2GiB", "2gib", "3.5g", "2.g", ".5t", "2 g", "2 GiB"])("accepts %j", (value) => {
    expect(parse(value).success).toBe(true);
  });

  it("accepts the setting being absent", () => {
    expect(envOrbitSchema.safeParse({}).success).toBe(true);
  });

  it("accepts an empty value, as the other keys do (Compose substitutes 2g)", () => {
    expect(parse("").success).toBe(true);
  });

  it.each(["lots", "2gi", "2x", "-2g", "2  g", " 2g", "2g ", "g", "2gibb"])("still refuses %j with a message naming the key", (value) => {
    const result = parse(value);
    expect(result.success).toBe(false);
    if (result.success) return;
    const messages = result.error.issues.map((issue) => issue.message).join("\n");
    expect(messages).toContain("ORBIT_MEMORY_LIMIT");
    expect(messages).toContain(
      "ORBIT_MEMORY_LIMIT must be a number with an optional unit b, k, m, g, t or p (optionally followed by b or ib), such as 2g, 3.5g, 1.5GiB or 2048m",
    );
  });
});

describe("evaluateReadiness and ORBIT_MEMORY_LIMIT (F2)", () => {
  const readinessFor = (value: string | undefined) => {
    const record: EnvOrbitRecord = value === undefined ? completeCore : { ...completeCore, ORBIT_MEMORY_LIMIT: value };
    const report = evaluateReadiness(record, NO_SECRET_FACTS);
    return { report, memoryLines: report.lines.filter((line) => /memory/i.test(line)) };
  };

  it.each(["lots", "2gi", "2x", "-2g", "2  g", " 2g", "2g ", "g", "2gibb"])("reports NOT ready with exactly 'missing memory-limit' for %j, never printing the value", (value) => {
    const { report, memoryLines } = readinessFor(value);
    expect(report.ok).toBe(false);
    expect(report.lines).toContain("missing memory-limit");
    expect(memoryLines).toEqual(["missing memory-limit"]);
    expect(report.lines.filter((line) => value.length > 1 && line.includes(value))).toEqual([]);
  });

  it.each(["2g", "2GB", "2GiB", "2gib", "3.5g", "2.g", ".5t", "1t", "1p", "2 g", "2 GiB", "2147483648", "2048m"])("adds no memory line for the well-formed %s", (value) => {
    const { report, memoryLines } = readinessFor(value);
    expect(report.ok).toBe(true);
    expect(memoryLines).toEqual([]);
  });

  it.each([["empty", ""], ["absent", undefined]])("adds no memory line and stays ready when the value is %s", (_label, value) => {
    const { report, memoryLines } = readinessFor(value);
    expect(report.ok).toBe(true);
    expect(memoryLines).toEqual([]);
  });

  it.each(["0.5g", "0.99g", "5b", "512m", "1048575k", "1023m", "1073741823"])("warns with the builder's exact line for %s and stays ready", (value) => {
    const { report, memoryLines } = readinessFor(value);
    expect(report.ok).toBe(true);
    expect(memoryLines).toHaveLength(1);
    const [line] = memoryLines;
    expect(line.startsWith(MEMORY_WARNING_PREFIX)).toBe(true);
    expect(line).toContain("1.45 GB");
    expect(line).toMatch(/preview/iu);
    expect(line).toMatch(/import/iu);
    expect(line).toContain("(docs/administrator-operations.md)");
    expect(line).not.toMatch(/about 1 GB, the peak/iu);
    expect(line).not.toContain("1.9 GB");
    expect(report.lines).not.toContain("missing memory-limit");
  });

  it.each(["1g", "1.5g", "1gib", "1024m", "1073741824"])("does not warn at the floor for %s", (value) => {
    const { report, memoryLines } = readinessFor(value);
    expect(report.ok).toBe(true);
    expect(memoryLines).toEqual([]);
  });
});
