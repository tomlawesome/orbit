import { readFileSync } from "node:fs";

import { describe, expect, it } from "vitest";

import {
  evaluateImageEvidence,
  evaluateSourceEvidence,
  validateSupplyChainPolicy,
} from "./supply-chain-policy.mjs";

const DIGEST = `sha256:${"a".repeat(64)}`;
const IMAGE_ID = `sha256:${"b".repeat(64)}`;

function policy(overrides = {}) {
  return {
    schemaVersion: 1,
    scanner: {
      name: "Trivy",
      version: "0.72.0",
      image: `aquasec/trivy@${DIGEST}`,
      license: "Apache-2.0",
      source: "https://github.com/aquasecurity/trivy/releases/tag/v0.72.0",
      updateOwner: "Orbit maintainers",
      reviewBy: "2026-10-30",
    },
    attestationActions: [
      {
        name: "actions/attest",
        version: "v4.2.1",
        commit: "c".repeat(40),
        license: "MIT",
        source: "https://github.com/actions/attest/releases/tag/v4.2.1",
        updateOwner: "Orbit maintainers",
        reviewBy: "2026-10-30",
      },
    ],
    thresholds: {
      sourceVulnerabilities: ["HIGH", "CRITICAL"],
      sourceSecrets: ["UNKNOWN", "LOW", "MEDIUM", "HIGH", "CRITICAL"],
      imageVulnerabilities: ["HIGH", "CRITICAL"],
    },
    exceptions: [],
    mutableImageReferences: [
      {
        reference: "node:22-alpine",
        locations: ["Dockerfile"],
        owner: "Orbit maintainers",
        rationale: "Digest update automation is tracked separately.",
        expiresOn: "2026-08-31",
        trackingIssue: 80,
      },
    ],
    ...overrides,
  };
}

function sourceReport(overrides = {}) {
  return {
    SchemaVersion: 2,
    Results: [
      {
        Target: "pnpm-lock.yaml",
        Vulnerabilities: [],
        Secrets: [],
        ...overrides,
      },
    ],
  };
}

describe("supply-chain policy", () => {
  it("inventories every mutable base and runtime image reference", () => {
    const policyDocument = JSON.parse(
      readFileSync(
        new URL("../.github/supply-chain-policy.json", import.meta.url),
        "utf8",
      ),
    );
    const files = [
      "Dockerfile",
      "tests/oidc/Dockerfile",
      "docker-compose.yml",
      "docker-compose.full.yml",
    ];
    const discovered = new Map();
    for (const file of files) {
      const content = readFileSync(new URL(`../${file}`, import.meta.url), "utf8");
      for (const line of content.split(/\r?\n/u)) {
        const from = line.match(/^FROM\s+(\S+)/u)?.[1];
        const compose = line.match(/^\s+image:\s+(\S+)/u)?.[1];
        let reference = from ?? compose;
        if (reference?.startsWith("${ORBIT_IMAGE:-") && reference.endsWith("}")) {
          reference = reference.slice("${ORBIT_IMAGE:-".length, -1);
        }
        if (
          !reference ||
          reference === "base" ||
          reference.includes("@sha256:")
        ) {
          continue;
        }
        const locations = discovered.get(reference) ?? new Set();
        locations.add(file);
        discovered.set(reference, locations);
      }
    }
    const tracked = new Map(
      policyDocument.mutableImageReferences.map((entry) => [
        entry.reference,
        new Set(entry.locations),
      ]),
    );

    expect([...tracked.keys()].sort()).toEqual([...discovered.keys()].sort());
    for (const [reference, locations] of discovered) {
      expect(tracked.get(reference)).toEqual(locations);
    }
  });

  it("accepts a pinned reviewed scanner and live bounded exceptions", () => {
    expect(validateSupplyChainPolicy(policy(), "2026-07-30")).toMatchObject({
      scannerVersion: "0.72.0",
      exceptionCount: 0,
      mutableReferenceCount: 1,
    });
  });

  it.each([
    [{ scanner: { ...policy().scanner, image: "aquasec/trivy:latest" } }, /digest/u],
    [{ scanner: { ...policy().scanner, reviewBy: "2026-07-29" } }, /review/u],
    [{ scanner: { ...policy().scanner, reviewBy: "2026-02-30" } }, /ISO date/u],
    [
      {
        mutableImageReferences: [
          { ...policy().mutableImageReferences[0], expiresOn: "2026-07-29" },
        ],
      },
      /expired/u,
    ],
    [
      {
        exceptions: [
          {
            kind: "vulnerability",
            scope: "image",
            id: "CVE-2026-0001",
            package: "example",
            owner: "",
            rationale: "temporary",
            expiresOn: "2026-08-01",
          },
        ],
      },
      /owner/u,
    ],
    [
      {
        exceptions: [
          {
            kind: "secret",
            scope: "source",
            id: "github-pat",
            owner: "Orbit maintainers",
            rationale: "Secrets must never be excepted.",
            expiresOn: "2026-08-01",
            trackingIssue: 81,
          },
        ],
      },
      /secret findings cannot be excepted/u,
    ],
  ])("rejects unsafe or stale policy", (overrides, expected) => {
    expect(() =>
      validateSupplyChainPolicy(policy(overrides), "2026-07-30"),
    ).toThrow(expected);
  });

  it("sanitizes secret matches while retaining reviewable finding identity", () => {
    const report = sourceReport({
      Secrets: [
        {
          RuleID: "github-pat",
          Category: "GitHub",
          Severity: "HIGH",
          Title: "GitHub personal access token",
          StartLine: 14,
          EndLine: 14,
          Match: "test-sensitive-value-that-must-be-redacted",
          Code: { Lines: [{ Number: 14, Content: "secret material" }] },
        },
      ],
    });

    const evidence = evaluateSourceEvidence(report, policy(), "2026-07-30");
    const serialized = JSON.stringify(evidence);

    expect(evidence.summary).toMatchObject({ blocked: 1, secrets: 1 });
    expect(evidence.findings[0]).toMatchObject({
      kind: "secret",
      id: "github-pat",
      severity: "HIGH",
      target: "pnpm-lock.yaml",
      startLine: 14,
    });
    expect(serialized).not.toContain("test-sensitive-value-that-must-be-redacted");
    expect(serialized).not.toContain("secret material");
  });

  it("requires explicit unexpired exceptions for blocking vulnerabilities", () => {
    const report = sourceReport({
      Vulnerabilities: [
        {
          VulnerabilityID: "CVE-2026-0001",
          PkgName: "example",
          InstalledVersion: "1.0.0",
          FixedVersion: "1.0.1",
          Severity: "HIGH",
        },
      ],
    });
    const exception = {
      kind: "vulnerability",
      scope: "source",
      id: "CVE-2026-0001",
      package: "example",
      owner: "Orbit maintainers",
      rationale: "A bounded compatibility check is underway.",
      expiresOn: "2026-08-15",
      trackingIssue: 81,
    };

    expect(evaluateSourceEvidence(report, policy(), "2026-07-30").summary.blocked).toBe(1);
    expect(
      evaluateSourceEvidence(
        report,
        policy({ exceptions: [exception] }),
        "2026-07-30",
      ).summary,
    ).toMatchObject({ blocked: 0, excepted: 1 });
  });

  it("binds vulnerability and SPDX evidence to the expected tested image", () => {
    const report = {
      SchemaVersion: 2,
      ArtifactName: "ghcr.io/tomlawesome/orbit:ci-test",
      Metadata: { ImageID: IMAGE_ID },
      Results: [],
    };
    const sbom = {
      spdxVersion: "SPDX-2.3",
      name: "ghcr.io/tomlawesome/orbit:ci-test",
    };

    expect(
      evaluateImageEvidence({
        report,
        sbom,
        reportSha256: `sha256:${"d".repeat(64)}`,
        sbomSha256: `sha256:${"e".repeat(64)}`,
        policy: policy(),
        expectedImageId: IMAGE_ID,
        expectedTag: "ghcr.io/tomlawesome/orbit:ci-test",
        revision: "c".repeat(40),
        now: "2026-07-30",
      }),
    ).toMatchObject({
      image: {
        id: IMAGE_ID,
        tag: "ghcr.io/tomlawesome/orbit:ci-test",
        revision: "c".repeat(40),
      },
      summary: { blocked: 0 },
      artifacts: {
        vulnerabilityReportSha256: `sha256:${"d".repeat(64)}`,
        sbomSha256: `sha256:${"e".repeat(64)}`,
      },
    });
  });

  it("fails closed when the scan or SBOM belongs to another image", () => {
    const args = {
      report: {
        SchemaVersion: 2,
        ArtifactName: "ghcr.io/tomlawesome/orbit:other",
        Metadata: { ImageID: DIGEST },
        Results: [],
      },
      sbom: { spdxVersion: "SPDX-2.3", name: "other" },
      policy: policy(),
      expectedImageId: IMAGE_ID,
      expectedTag: "ghcr.io/tomlawesome/orbit:ci-test",
      revision: "c".repeat(40),
      now: "2026-07-30",
    };

    expect(() => evaluateImageEvidence(args)).toThrow(/image identity/u);
  });
});
