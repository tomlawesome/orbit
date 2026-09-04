import { spawnSync } from "node:child_process";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

import { afterEach, describe, expect, it, vi } from "vitest";

import { PROCESS_TEST_TIMEOUT_MS, failOnProcessDeadline, processGuard } from "./process-budget.mjs";

// Every test here spawns the real sidecar-image-evidence.mjs CLI; a spawn
// that takes tens of milliseconds quiet takes seconds on a starved core
// (#698). Budget and reasoning: scripts/process-budget.mjs.
vi.setConfig({ testTimeout: PROCESS_TEST_TIMEOUT_MS });

const scriptsDir = dirname(fileURLToPath(import.meta.url));
const scriptPath = join(scriptsDir, "sidecar-image-evidence.mjs");

// Every spawnSync call gets explicit piped stdio, so a wedged child fails
// this test loudly rather than hanging. processGuard() supplies the actual
// deadline and kill signal.
const SPAWN_OPTS = {
  stdio: ["ignore", "pipe", "pipe"],
  encoding: "utf8",
  ...processGuard(),
};

// The CLI evaluates against the real clock, so fixture review and expiry
// dates sit far in the future to stay live, and resolution dates in the past.
const LIVE_DATE = "2099-12-31";

const REVISION = "c".repeat(40);
const DIGEST = `sha256:${"a".repeat(64)}`;

const scratchDirs = [];
afterEach(() => {
  while (scratchDirs.length > 0) {
    rmSync(scratchDirs.pop(), { recursive: true, force: true });
  }
});

function scratchDir() {
  const dir = mkdtempSync(join(tmpdir(), "orbit-sidecar-evidence-"));
  scratchDirs.push(dir);
  return dir;
}

function containerImage(overrides = {}) {
  return {
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
    reviewBy: LIVE_DATE,
    ...overrides,
  };
}

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
      reviewBy: LIVE_DATE,
    },
    attestationActions: [
      {
        name: "actions/attest",
        version: "v4.2.1",
        commit: "c".repeat(40),
        license: "MIT",
        source: "https://github.com/actions/attest/releases/tag/v4.2.1",
        updateOwner: "Orbit maintainers",
        reviewBy: LIVE_DATE,
      },
    ],
    dependencyReviewActions: [
      {
        name: "actions/dependency-review-action",
        version: "v5.0.0",
        commit: "d".repeat(40),
        license: "MIT",
        source:
          "https://github.com/actions/dependency-review-action/releases/tag/v5.0.0",
        updateOwner: "Orbit maintainers",
        reviewBy: LIVE_DATE,
      },
    ],
    thresholds: {
      sourceVulnerabilities: ["HIGH", "CRITICAL"],
      sourceSecrets: ["UNKNOWN", "LOW", "MEDIUM", "HIGH", "CRITICAL"],
      imageVulnerabilities: ["HIGH", "CRITICAL"],
    },
    exceptions: [],
    containerImages: [
      containerImage(),
      containerImage({
        name: "PostgreSQL database",
        tag: "postgres:17-alpine",
        reference: `postgres:17-alpine@${DIGEST}`,
        locations: ["docker-compose.yml"],
        source: "https://github.com/docker-library/postgres",
        registry: "https://hub.docker.com/_/postgres",
        licenseSource: "https://github.com/docker-library/postgres/blob/master/LICENSE",
      }),
    ],
    mutableImageReferences: [],
    ...overrides,
  };
}

function report(overrides = {}) {
  return {
    SchemaVersion: 2,
    Results: [
      {
        Target: "usr/lib/node",
        Vulnerabilities: [],
        ...overrides,
      },
    ],
  };
}

function vulnerability(overrides = {}) {
  return {
    VulnerabilityID: "CVE-2026-0001",
    PkgName: "example",
    InstalledVersion: "1.0.0",
    FixedVersion: "1.0.1",
    Severity: "HIGH",
    ...overrides,
  };
}

function writeFixtures(dir, { policyDocument, reports }) {
  const policyPath = join(dir, "policy.json");
  writeFileSync(policyPath, JSON.stringify(policyDocument), "utf8");
  const scansDir = join(dir, "scans");
  mkdirSync(scansDir, { recursive: true });
  for (const [slug, reportDocument] of Object.entries(reports)) {
    writeFileSync(join(scansDir, `${slug}.json`), JSON.stringify(reportDocument), "utf8");
  }
  return { policyPath, scansDir };
}

function runCli(args) {
  return failOnProcessDeadline(spawnSync(process.execPath, [scriptPath, ...args], SPAWN_OPTS), { label: "runCli" });
}

describe("sidecar image evidence: --list-references", () => {
  it("prints one slug and reference per pinned image, deriving the slug from the tag", () => {
    const dir = scratchDir();
    const policyDocument = policy({
      containerImages: [
        containerImage(),
        containerImage({
          tag: "clamav/clamav:1.4.5-debian",
          reference: `clamav/clamav:1.4.5-debian@${DIGEST}`,
          name: "ClamAV malware scanner",
          locations: ["docker-compose.yml"],
          source: "https://github.com/Cisco-Talos/clamav-docker",
          registry: "https://hub.docker.com/r/clamav/clamav",
          licenseSource: "https://github.com/Cisco-Talos/clamav/blob/main/COPYING.txt",
        }),
      ],
    });
    const policyPath = join(dir, "policy.json");
    writeFileSync(policyPath, JSON.stringify(policyDocument), "utf8");

    const result = runCli([
      "--list-references",
      "--policy",
      policyPath,
    ]);

    expect(result.status).toBe(0);
    const lines = result.stdout.trim().split("\n");
    expect(lines).toEqual([
      `node-22-alpine ${policyDocument.containerImages[0].reference}`,
      `clamav-clamav-1-4-5-debian ${policyDocument.containerImages[1].reference}`,
    ]);
  });
});

describe("sidecar image evidence: evaluate", () => {
  it("blocks and names the failing image when a finding is at or above threshold", () => {
    const dir = scratchDir();
    const policyDocument = policy();
    const { policyPath, scansDir } = writeFixtures(dir, {
      policyDocument,
      reports: {
        "node-22-alpine": report({ Vulnerabilities: [vulnerability({ Severity: "HIGH" })] }),
        "postgres-17-alpine": report(),
      },
    });
    const outputPath = join(dir, "evidence.json");

    const result = runCli([
      "evaluate",
      "--policy",
      policyPath,
      "--scans",
      scansDir,
      "--output",
      outputPath,
      "--revision",
      REVISION,
    ]);

    expect(result.status).toBe(1);
    expect(result.stderr).toContain("node:22-alpine");
    expect(result.stderr).toMatch(/1 blocked finding\(s\) \(1 HIGH\)/u);

    const evidence = JSON.parse(readFileSync(outputPath, "utf8"));
    const nodeImage = evidence.images.find((image) => image.tag === "node:22-alpine");
    expect(nodeImage.blocked).toBe(1);
  });

  it("does not block findings below the vulnerability threshold", () => {
    const dir = scratchDir();
    const policyDocument = policy();
    const { policyPath, scansDir } = writeFixtures(dir, {
      policyDocument,
      reports: {
        "node-22-alpine": report({
          Vulnerabilities: [vulnerability({ Severity: "MEDIUM" })],
        }),
        "postgres-17-alpine": report(),
      },
    });
    const outputPath = join(dir, "evidence.json");

    const result = runCli([
      "evaluate",
      "--policy",
      policyPath,
      "--scans",
      scansDir,
      "--output",
      outputPath,
      "--revision",
      REVISION,
    ]);

    expect(result.status).toBe(0);
    const evidence = JSON.parse(readFileSync(outputPath, "utf8"));
    const nodeImage = evidence.images.find((image) => image.tag === "node:22-alpine");
    expect(nodeImage.blocked).toBe(0);
    expect(nodeImage.findings[0].policy).toBe("reported");
  });

  it("treats a matching unexpired exception as excepted, not blocked", () => {
    const dir = scratchDir();
    const exception = {
      kind: "vulnerability",
      scope: "image",
      id: "CVE-2026-0001",
      package: "example",
      owner: "Orbit maintainers",
      rationale: "A bounded compatibility check is underway.",
      expiresOn: LIVE_DATE,
      trackingIssue: 81,
    };
    const policyDocument = policy({ exceptions: [exception] });
    const { policyPath, scansDir } = writeFixtures(dir, {
      policyDocument,
      reports: {
        "node-22-alpine": report({ Vulnerabilities: [vulnerability({ Severity: "HIGH" })] }),
        "postgres-17-alpine": report(),
      },
    });
    const outputPath = join(dir, "evidence.json");

    const result = runCli([
      "evaluate",
      "--policy",
      policyPath,
      "--scans",
      scansDir,
      "--output",
      outputPath,
      "--revision",
      REVISION,
    ]);

    expect(result.status).toBe(0);
    const evidence = JSON.parse(readFileSync(outputPath, "utf8"));
    const nodeImage = evidence.images.find((image) => image.tag === "node:22-alpine");
    expect(nodeImage.blocked).toBe(0);
    expect(nodeImage.excepted).toBe(1);
    expect(nodeImage.findings[0].policy).toBe("excepted");
  });

  it("fails loudly, naming the tag, when a pinned image has no scan report", () => {
    const dir = scratchDir();
    const policyDocument = policy();
    const { policyPath, scansDir } = writeFixtures(dir, {
      policyDocument,
      reports: {
        "node-22-alpine": report(),
        // postgres-17-alpine report intentionally missing.
      },
    });
    const outputPath = join(dir, "evidence.json");

    const result = runCli([
      "evaluate",
      "--policy",
      policyPath,
      "--scans",
      scansDir,
      "--output",
      outputPath,
      "--revision",
      REVISION,
    ]);

    expect(result.status).toBe(1);
    expect(result.stderr).toContain("postgres:17-alpine");
  });

  it("writes every pinned image, its reference, and its summary counts to the evidence file", () => {
    const dir = scratchDir();
    const policyDocument = policy();
    const { policyPath, scansDir } = writeFixtures(dir, {
      policyDocument,
      reports: {
        "node-22-alpine": report({ Vulnerabilities: [vulnerability({ Severity: "HIGH" })] }),
        "postgres-17-alpine": report({
          Vulnerabilities: [vulnerability({ Severity: "MEDIUM" })],
        }),
      },
    });
    const outputPath = join(dir, "evidence.json");

    runCli([
      "evaluate",
      "--policy",
      policyPath,
      "--scans",
      scansDir,
      "--output",
      outputPath,
      "--revision",
      REVISION,
    ]);

    const evidence = JSON.parse(readFileSync(outputPath, "utf8"));
    expect(evidence.revision).toBe(REVISION);
    expect(typeof evidence.generatedAt).toBe("string");
    expect(evidence.images).toHaveLength(2);
    expect(evidence.images).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          tag: "node:22-alpine",
          reference: policyDocument.containerImages[0].reference,
          blocked: 1,
          excepted: 0,
        }),
        expect.objectContaining({
          tag: "postgres:17-alpine",
          reference: policyDocument.containerImages[1].reference,
          blocked: 0,
          excepted: 0,
        }),
      ]),
    );
  });
});
