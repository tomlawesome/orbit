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
    containerImages: [
      {
        name: "Node.js build and runtime",
        tag: "node:22-alpine",
        reference: `node:22-alpine@${DIGEST}`,
        indexDigest: `sha256:${"f".repeat(64)}`,
        platform: "linux/amd64",
        locations: ["Dockerfile"],
        source: "https://github.com/nodejs/docker-node",
        registry: "https://hub.docker.com/_/node",
        license: "MIT",
        licenseSource: "https://github.com/nodejs/docker-node/blob/main/LICENSE",
        updateOwner: "Orbit maintainers",
        resolvedOn: "2026-07-30",
        reviewBy: "2026-10-30",
      },
    ],
    mutableImageReferences: [],
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
  it("pins every upstream base and runtime image and requires an explicit Orbit image", () => {
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
      "scripts/test-integration.mjs",
      ".gitlab-ci.yml",
    ];
    const discovered = new Map();
    for (const file of files) {
      const content = readFileSync(new URL(`../${file}`, import.meta.url), "utf8");
      for (const line of content.split(/\r?\n/u)) {
        const from = line.match(/^FROM\s+(\S+)/u)?.[1];
        const compose =
          file === "docker-compose.yml"
            ? line.match(/^\s+image:\s+"?([^"]+)"?\s*$/u)?.[1]
            : undefined;
        const integration = line.match(/^\s+"(postgres:[^"]+)",?$/u)?.[1];
        // The pipeline pins the same PostgreSQL sidecar for its integration
        // job; other `*_IMAGE:` pins here (node, playwright) are unrelated
        // images with no policy entry, so this only picks out postgres.
        const pipelinePostgres =
          file === ".gitlab-ci.yml"
            ? line.match(/^\s*POSTGRES_IMAGE:\s+(postgres:\S+)\s*$/u)?.[1]
            : undefined;
        const reference = from ?? compose ?? integration ?? pipelinePostgres;
        if (!reference || reference === "base") continue;
        if (reference.startsWith("${ORBIT_IMAGE:")) {
          expect(reference).toBe(
            "${ORBIT_IMAGE:?Set ORBIT_IMAGE to an immutable registry digest or a local build tag}",
          );
          continue;
        }
        expect(reference).toMatch(/@sha256:[0-9a-f]{64}$/u);
        const locations = discovered.get(reference) ?? new Set();
        locations.add(file);
        discovered.set(reference, locations);
      }
    }
    const tracked = new Map(
      (policyDocument.containerImages ?? []).map((entry) => [
        entry.reference,
        new Set(entry.locations),
      ]),
    );

    expect([...tracked.keys()].sort()).toEqual([...discovered.keys()].sort());
    for (const [reference, locations] of discovered) {
      expect(tracked.get(reference)).toEqual(locations);
    }
    expect(policyDocument.mutableImageReferences ?? []).toEqual([]);
    const install = readFileSync(new URL("../scripts/install.sh", import.meta.url), "utf8");
    const configure = readFileSync(
      new URL("../scripts/configure.sh", import.meta.url),
      "utf8",
    );
    const deploy = readFileSync(
      new URL("../scripts/deploy-container.sh", import.meta.url),
      "utf8",
    );
    // The property is that a deployment runs an immutable digest. Resolving a
    // mutable tag to a digest is permitted; deploying one is not. Enforcing the
    // property rather than a literal string lets the installer automate the
    // lookup without weakening what the rule guarantees. See ADR-0008.
    const rule = policyDocument.deploymentImageReferences;
    expect(rule).toBeDefined();
    expect(rule.localBuildTagPrefix).toBe("orbit-local:");

    // A script may assign through a variable, but only if it first proves the
    // value is a digest. The guard is the bash pattern the script tests
    // against, so an indirect assignment cannot smuggle in a mutable tag.
    const digestGuard = "@sha256:[0-9a-f]{64}";
    const deploymentScripts = { install, configure, deploy };

    for (const [name, script] of Object.entries(deploymentScripts)) {
      const guardsDigestFormat = script.includes(digestGuard);
      for (const line of script.split(/\r?\n/u)) {
        // A shell pattern comparison is not an assignment.
        if (/\[\[|==/u.test(line)) continue;
        const assignment = /(?:^|\s)(?:export\s+)?ORBIT_IMAGE=(.+)$/u.exec(line);
        if (!assignment) continue;
        const value = assignment[1].trim();
        if (value === '""' || value === "''") continue;

        const literalDigest = value.includes("@sha256:");
        const localBuildTag = value.includes(rule.localBuildTagPrefix);
        // `ORBIT_IMAGE=$var` or `ORBIT_IMAGE=$orbit_image` — acceptable only
        // when the script validates the digest format somewhere.
        const indirect = /^"?\$\{?[A-Za-z_]/u.test(value);

        expect(
          literalDigest || localBuildTag || (indirect && guardsDigestFormat),
          `${name} assigns a deployment reference that is neither a digest, a local build tag, nor a digest-guarded value: ${value}`,
        ).toBe(true);
      }
    }

    // Guards against the rule above passing vacuously: at least one deployment
    // script must actually enforce the digest format.
    expect(deploy.includes(digestGuard)).toBe(true);

    expect(configure).toContain('[[ -n "$orbit_image" ]] || return 0');
  });

  it("accepts a pinned reviewed scanner and live bounded exceptions", () => {
    expect(validateSupplyChainPolicy(policy(), "2026-07-30")).toMatchObject({
      scannerVersion: "0.72.0",
      exceptionCount: 0,
      pinnedImageCount: 1,
      mutableReferenceCount: 0,
    });
  });

  it.each([
    [{ scanner: { ...policy().scanner, image: "aquasec/trivy:latest" } }, /digest/u],
    [{ scanner: { ...policy().scanner, reviewBy: "2026-07-29" } }, /review/u],
    [{ scanner: { ...policy().scanner, reviewBy: "2026-02-30" } }, /ISO date/u],
    [
      {
        containerImages: [
          { ...policy().containerImages[0], reference: "node:22-alpine" },
        ],
      },
      /pinned/u,
    ],
    [
      {
        containerImages: [
          { ...policy().containerImages[0], reviewBy: "2026-07-29" },
        ],
      },
      /Container image 1 review/u,
    ],
    [
      {
        mutableImageReferences: [
          {
            reference: "node:22-alpine",
            locations: ["Dockerfile"],
            owner: "Orbit maintainers",
            rationale: "Temporary mutable fallback.",
            expiresOn: "2026-08-31",
            trackingIssue: 80,
          },
        ],
      },
      /not permitted/u,
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

  it("fails closed the day after an exception expires, rather than matching it", () => {
    // The sidecar exceptions recorded for #740 rely on this: an expiry that
    // silently stopped matching would leave the finding blocked (acceptable),
    // but one that kept matching would hide it forever.
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

    expect(
      evaluateSourceEvidence(report, policy({ exceptions: [exception] }), "2026-08-15")
        .summary,
    ).toMatchObject({ blocked: 0, excepted: 1 });
    expect(() =>
      evaluateSourceEvidence(report, policy({ exceptions: [exception] }), "2026-08-16"),
    ).toThrow(/expired on 2026-08-15/u);
  });

  it("does not let an exception for one installed version cover another", () => {
    // Each #740 entry names the installed version it was seen in, so an
    // upstream rebuild that ships a different, still-vulnerable version is
    // blocked afresh instead of inheriting the exception.
    const report = sourceReport({
      Vulnerabilities: [
        {
          VulnerabilityID: "CVE-2026-0001",
          PkgName: "example",
          InstalledVersion: "1.0.0",
          FixedVersion: "1.0.2",
          Severity: "HIGH",
        },
      ],
    });
    const exception = {
      kind: "vulnerability",
      scope: "source",
      id: "CVE-2026-0001",
      package: "example",
      installedVersion: "0.9.0",
      owner: "Orbit maintainers",
      rationale: "Seen only in 0.9.0.",
      expiresOn: "2026-08-15",
      trackingIssue: 81,
    };

    expect(
      evaluateSourceEvidence(report, policy({ exceptions: [exception] }), "2026-07-30")
        .summary,
    ).toMatchObject({ blocked: 1, excepted: 0 });
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

/**
 * The deployment-reference rule, extracted so it can be proven against
 * synthetic scripts rather than only against the repository's own.
 *
 * The rule was widened to permit resolving a mutable tag to a digest, so it
 * must be shown to still reject deploying one. A relaxed security assertion
 * that nobody tests is indistinguishable from a deleted one.
 */
function deploysOnlyImmutableReferences(script, localBuildTagPrefix = "orbit-local:") {
  const digestGuard = "@sha256:[0-9a-f]{64}";
  const guardsDigestFormat = script.includes(digestGuard);

  for (const line of script.split(/\r?\n/u)) {
    // A shell pattern comparison is not an assignment.
    if (/\[\[|==/u.test(line)) continue;
    const assignment = /(?:^|\s)(?:export\s+)?ORBIT_IMAGE=(.+)$/u.exec(line);
    if (!assignment) continue;
    const value = assignment[1].trim();
    if (value === '""' || value === "''") continue;

    const literalDigest = value.includes("@sha256:");
    const localBuildTag = value.includes(localBuildTagPrefix);
    const indirect = /^"?\$\{?[A-Za-z_]/u.test(value);
    if (!(literalDigest || localBuildTag || (indirect && guardsDigestFormat))) return false;
  }
  return true;
}

describe("deployment reference rule", () => {
  it("accepts a literal digest", () => {
    expect(deploysOnlyImmutableReferences(
      'export ORBIT_IMAGE="ghcr.io/tomlawesome/orbit@sha256:' + "0".repeat(64) + '"',
    )).toBe(true);
  });

  it("accepts an explicitly local build tag", () => {
    expect(deploysOnlyImmutableReferences(
      'export ORBIT_IMAGE="orbit-local:abc123def456"',
    )).toBe(true);
  });

  it("rejects deploying a mutable tag", () => {
    // The behaviour the amendment must not permit.
    expect(deploysOnlyImmutableReferences(
      'export ORBIT_IMAGE="ghcr.io/tomlawesome/orbit:latest"',
    )).toBe(false);
    expect(deploysOnlyImmutableReferences(
      'export ORBIT_IMAGE="ghcr.io/tomlawesome/orbit:v1.0.0"',
    )).toBe(false);
  });

  it("rejects an indirect assignment from a script that never checks the format", () => {
    // Resolving a tag is permitted, but only when the resolved value is proven
    // to be a digest before it becomes the deployment reference.
    expect(deploysOnlyImmutableReferences([
      'resolved="$(lookup_tag ghcr.io/tomlawesome/orbit:latest)"',
      'export ORBIT_IMAGE="$resolved"',
    ].join("\n"))).toBe(false);
  });

  it("accepts an indirect assignment guarded by the digest format", () => {
    // This is what the installer rewrite is permitted to do: name a tag in
    // order to resolve it, then prove the result before deploying it.
    expect(deploysOnlyImmutableReferences([
      'resolved="$(lookup_tag ghcr.io/tomlawesome/orbit:latest)"',
      '[[ "$resolved" =~ ^[A-Za-z0-9._:/-]+@sha256:[0-9a-f]{64}$ ]] || fail "not a digest"',
      'export ORBIT_IMAGE="$resolved"',
    ].join("\n"))).toBe(true);
  });

  it("ignores an empty assignment, which deploys nothing", () => {
    expect(deploysOnlyImmutableReferences('ORBIT_IMAGE=""')).toBe(true);
  });
});
