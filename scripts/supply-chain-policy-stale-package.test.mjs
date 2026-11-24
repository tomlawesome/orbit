import { describe, expect, it } from "vitest";

import {
  evaluateImageEvidence,
  evaluateSourceEvidence,
  validateSupplyChainPolicy,
} from "./supply-chain-policy.mjs";

// Specification: ai/orbit#1950, rule 1. `exceptions[]` accepts kind
// "stale-package" for the sidecar-pins packages axis.

const DIGEST = `sha256:${"a".repeat(64)}`;
const NOW = "2026-11-23";

function policy(exceptions = []) {
  return {
    schemaVersion: 1,
    scanner: {
      name: "Trivy",
      version: "0.72.0",
      image: `aquasec/trivy@${DIGEST}`,
      license: "Apache-2.0",
      source: "https://github.com/aquasecurity/trivy/releases/tag/v0.72.0",
      updateOwner: "Orbit maintainers",
      reviewBy: "2027-01-30",
    },
    attestationActions: [
      {
        name: "actions/attest",
        version: "v4.2.1",
        commit: "c".repeat(40),
        license: "MIT",
        source: "https://github.com/actions/attest/releases/tag/v4.2.1",
        updateOwner: "Orbit maintainers",
        reviewBy: "2027-01-30",
      },
    ],
    thresholds: {
      sourceVulnerabilities: ["HIGH", "CRITICAL"],
      sourceSecrets: ["UNKNOWN", "LOW", "MEDIUM", "HIGH", "CRITICAL"],
      imageVulnerabilities: ["HIGH", "CRITICAL"],
    },
    exceptions,
    containerImages: [
      {
        name: "PostgreSQL database",
        tag: "postgres:18-alpine",
        reference: `postgres:18-alpine@${DIGEST}`,
        indexDigest: `sha256:${"f".repeat(64)}`,
        platform: "linux/amd64",
        locations: ["docker-compose.yml"],
        source: "https://github.com/docker-library/postgres",
        registry: "https://hub.docker.com/_/postgres",
        license: "MIT",
        licenseSource: "https://github.com/docker-library/postgres/blob/master/LICENSE",
        updateOwner: "Orbit maintainers",
        resolvedOn: "2026-11-01",
        reviewBy: "2027-01-30",
      },
    ],
    mutableImageReferences: [],
  };
}

function stale(overrides = {}) {
  return {
    kind: "stale-package",
    image: "postgres:18-alpine",
    package: "libxml2",
    installedVersion: "2.13.9-r2",
    availableVersion: "2.13.9-r3",
    owner: "Orbit maintainers",
    rationale: "Upstream has not rebuilt the image yet.",
    expiresOn: "2026-11-30",
    trackingIssue: 1950,
    ...overrides,
  };
}

function vulnerability(overrides = {}) {
  return {
    kind: "vulnerability",
    scope: "image",
    id: "CVE-2026-0001",
    package: "libxml2",
    owner: "Orbit maintainers",
    rationale: "A bounded compatibility check is underway.",
    expiresOn: "2026-12-15",
    trackingIssue: 81,
    ...overrides,
  };
}

// Rejections must be for the stale-package reason, so each message has to name
// the entry (Exception N) and must not be the old "only a vulnerability" refusal.
function expectRejected(exceptions, ...reasons) {
  let message = "";
  try {
    validateSupplyChainPolicy(policy(exceptions), NOW);
  } catch (error) {
    message = error.message;
  }
  expect(message, "the policy should have been rejected").not.toBe("");
  expect(message).toMatch(/Exception 2/u);
  expect(message).not.toMatch(/only a vulnerability/iu);
  for (const reason of reasons) expect(message).toMatch(reason);
}

describe("supply-chain policy: stale-package exceptions (#1950)", () => {
  it("accepts a complete, live stale-package exception", () => {
    expect(validateSupplyChainPolicy(policy([stale()]), NOW)).toMatchObject({
      exceptionCount: 1,
    });
  });

  it("accepts a stale-package exception that expires today", () => {
    expect(() =>
      validateSupplyChainPolicy(policy([stale({ expiresOn: NOW })]), NOW),
    ).not.toThrow();
  });

  it.each([
    ["image", /image/iu],
    ["package", /package/iu],
    ["installedVersion", /installed/iu],
    ["availableVersion", /available/iu],
    ["owner", /owner/iu],
    ["rationale", /rationale/iu],
    ["expiresOn", /expir/iu],
    ["trackingIssue", /tracking/iu],
  ])("rejects a stale-package exception missing %s, naming the entry", (field, reason) => {
    const entry = stale();
    delete entry[field];
    expectRejected([vulnerability(), entry], reason);
  });

  it("rejects a stale-package exception with an empty required string, naming the entry", () => {
    expectRejected([vulnerability(), stale({ package: "" })], /package/iu);
  });

  it("rejects an image that is not in containerImages, naming the entry", () => {
    expectRejected([vulnerability(), stale({ image: "redis:8-alpine" })], /image/iu);
  });

  it("rejects an expired stale-package exception, naming the entry", () => {
    expectRejected([vulnerability(), stale({ expiresOn: "2026-11-22" })], /expired/iu);
  });

  it("still refuses secret exceptions", () => {
    expect(() =>
      validateSupplyChainPolicy(
        policy([
          stale(),
          {
            kind: "secret",
            scope: "source",
            id: "github-pat",
            owner: "Orbit maintainers",
            rationale: "no",
            expiresOn: "2026-12-15",
            trackingIssue: 81,
          },
        ]),
        NOW,
      ),
    ).toThrow(/secret findings cannot be excepted/u);
  });

  it("still validates vulnerability entries exactly as before (unchanged behaviour)", () => {
    expect(validateSupplyChainPolicy(policy([vulnerability()]), NOW)).toMatchObject({
      exceptionCount: 1,
    });
    expect(() =>
      validateSupplyChainPolicy(policy([vulnerability({ owner: "" })]), NOW),
    ).toThrow(/owner/u);
  });

  it("a stale-package entry never excepts a vulnerability finding, even on the same package and version", () => {
    const report = {
      SchemaVersion: 2,
      Results: [
        {
          Target: "pnpm-lock.yaml",
          Secrets: [],
          Vulnerabilities: [
            {
              VulnerabilityID: "CVE-2026-0001",
              PkgName: "libxml2",
              InstalledVersion: "2.13.9-r2",
              FixedVersion: "2.13.9-r3",
              Severity: "HIGH",
            },
          ],
        },
      ],
    };
    const evaluated = evaluateSourceEvidence(report, policy([stale()]), NOW);
    expect(evaluated.summary).toMatchObject({ blocked: 1, excepted: 0 });
    expect(evaluated.findings?.[0]?.policy ?? "blocked").toBe("blocked");
    expect(typeof evaluateImageEvidence).toBe("function");
  });

  it("a stale-package entry sitting beside a vulnerability entry leaves the vulnerability exception working", () => {
    const report = {
      SchemaVersion: 2,
      Results: [
        {
          Target: "pnpm-lock.yaml",
          Secrets: [],
          Vulnerabilities: [
            {
              VulnerabilityID: "CVE-2026-0001",
              PkgName: "libxml2",
              InstalledVersion: "2.13.9-r2",
              FixedVersion: "2.13.9-r3",
              Severity: "HIGH",
            },
          ],
        },
      ],
    };
    const evaluated = evaluateSourceEvidence(
      report,
      policy([stale(), vulnerability({ scope: "source" })]),
      NOW,
    );
    expect(evaluated.summary).toMatchObject({ blocked: 0, excepted: 1 });
  });
});
