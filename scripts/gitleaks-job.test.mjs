import { readFileSync } from "node:fs";

import { describe, expect, it } from "vitest";

// #1783: the `gitleaks` job runs from the pinned tool image, so a GitHub
// release outage cannot block a merge. Read textually, like the other CI
// tests; no YAML library is a dependency.
const gitlabCi = readFileSync(new URL("../.gitlab-ci.yml", import.meta.url), "utf8");
const renovate = readFileSync(new URL("../renovate.json", import.meta.url), "utf8");
const policy = JSON.parse(readFileSync(new URL("../.github/supply-chain-policy.json", import.meta.url), "utf8"));
const secretScan = readFileSync(new URL("./test-secret-scan.sh", import.meta.url), "utf8");

function jobBlock(name) {
  const start = gitlabCi.indexOf(`\n${name}:\n`);
  expect(start, `${name} is not defined`).toBeGreaterThan(-1);
  const body = start + 1 + name.length + 2;
  const next = gitlabCi.slice(body).search(/^\S/mu);
  return gitlabCi.slice(start + 1, body + next);
}

const IMAGE_REF = /^\$CI_IMAGE_CACHE_GHCR\/gitleaks\/gitleaks:v(\d+\.\d+\.\d+)@sha256:[0-9a-f]{64}$/u;
const EXPECTED_IMAGE =
  "$CI_IMAGE_CACHE_GHCR/gitleaks/gitleaks:v8.30.1@sha256:c00b6bd0aeb3071cbcb79009cb16a60dd9e0a7c60e2be9ab65d25e6bc8abbb7f";

function imageName(block) {
  return block.match(/^ {2}image:[ \t]*\n(?: {4}\S.*\n)*?^ {4}name:[ \t]+(\S+)/mu)?.[1];
}

describe("the gitleaks job runs from the pinned image (#1783)", () => {
  const job = jobBlock("gitleaks");

  it("uses the pinned gitleaks image, not $NODE_IMAGE", () => {
    expect(imageName(job)).toBe(EXPECTED_IMAGE);
    expect(job).not.toContain("NODE_IMAGE");
  });

  it("clears the image entrypoint", () => {
    expect(job).toMatch(/^ {4}entrypoint:\s+\[""\]/mu);
  });

  it("downloads nothing at run time", () => {
    expect(job).not.toMatch(/\bcurl\b/u);
    expect(job).not.toMatch(/\bwget\b/u);
    expect(job).not.toContain("github.com");
  });

  it("carries no GITLEAKS_VERSION or GITLEAKS_SHA256", () => {
    expect(job).not.toContain("GITLEAKS_VERSION");
    expect(job).not.toContain("GITLEAKS_SHA256");
  });

  it("keeps stage, tags, timeout, needs and the full clone", () => {
    expect(job).toMatch(/^ {2}stage: policy$/mu);
    expect(job).toMatch(/^ {2}tags: \[light\]$/mu);
    expect(job).toMatch(/^ {2}timeout: 5m$/mu);
    expect(job).toMatch(/^ {2}needs: \[\]$/mu);
    expect(job).toMatch(/^ {4}GIT_STRATEGY: clone$/mu);
    expect(job).toMatch(/^ {4}GIT_DEPTH: 0$/mu);
  });

  it("keeps its rules", () => {
    const rules = job.match(/^ {2}rules:\n((?: {4}.*\n)+)/mu)?.[1];
    expect(rules).toBe(
      [
        "    - !reference [.dev-landing-check, rules]",
        "    - !reference [.backmerge-skip, job_rule]",
        "    - *not_on_main_push",
        "    - *not_scheduled",
        "    - when: on_success",
        "",
      ].join("\n"),
    );
  });

  it("prints the version, then scans with the json report kept always", () => {
    expect(job).toMatch(/^ +gitleaks version$/mu);
    expect(job).toContain("gitleaks detect --source . --redact");
    expect(job).toContain("--report-format json --report-path .orbit-gitleaks/report.json");
    expect(job).toMatch(/^ {6}- \.orbit-gitleaks\/report\.json$/mu);
    expect(job).toMatch(/^ {4}when: always$/mu);
  });
});

describe("one gitleaks version everywhere (#1783)", () => {
  const names = ["gitleaks", "private-details", "backmerge-check"].map((n) => [n, imageName(jobBlock(n))]);

  it.each(names)("%s pins the image by a 64-hex digest through the cache", (_name, image) => {
    expect(image).toMatch(IMAGE_REF);
  });

  it("the three jobs name the identical image reference", () => {
    const [first, ...rest] = names.map(([, image]) => image);
    expect(first).toBeDefined();
    for (const image of rest) expect(image).toBe(first);
  });

  it("test-secret-scan.sh's gitleaks_version equals the image's tag version", () => {
    const script = secretScan.match(/gitleaks_version="([\d.]+)"/u)?.[1];
    const tag = imageName(jobBlock("gitleaks"))?.match(IMAGE_REF)?.[1];
    expect(tag, "gitleaks job has no pinned image tag").toBeDefined();
    expect(script).toBe(tag);
  });
});

describe("Renovate moves the gitleaks image (#1783)", () => {
  // renovate.json carries comments and trailing commas (JSON5), so find the
  // manager by its text, not by JSON.parse.
  const managers = renovate.split(/^ {4}\{\n/mu).filter((m) => m.includes('"customType": "regex"'));
  const imageManager = managers.find((m) => m.includes("ghcr.io/gitleaks/gitleaks"));

  it("has a regex manager for the image in .gitlab-ci.yml", () => {
    expect(imageManager, "no regex manager for ghcr.io/gitleaks/gitleaks").toBeDefined();
    expect(imageManager).toMatch(/managerFilePatterns[^\n]*\.gitlab-ci/u);
  });

  it("captures currentValue and currentDigest from gitleaks/gitleaks:v<ver>@sha256:<digest>", () => {
    expect(imageManager).toContain("currentValue");
    expect(imageManager).toContain("currentDigest");
    expect(imageManager).toContain("gitleaks/gitleaks:v");
    expect(imageManager).toContain("@sha256:");
  });

  it("uses the docker datasource, package ghcr.io/gitleaks/gitleaks, registry ghcr.io", () => {
    expect(imageManager).toMatch(/"datasourceTemplate": "docker"/u);
    expect(imageManager).toMatch(/"(?:packageNameTemplate|depNameTemplate)": "ghcr\.io\/gitleaks\/gitleaks"/u);
    expect(imageManager).toMatch(/"packageNameTemplate": "ghcr\.io\/gitleaks\/gitleaks"/u);
    expect(imageManager).toContain("ghcr.io");
  });

  it("still reads scripts/test-secret-scan.sh with the github-releases manager", () => {
    const releases = managers.find(
      (m) => m.includes("test-secret-scan") && m.includes('"datasourceTemplate": "github-releases"'),
    );
    expect(releases, "no github-releases manager for test-secret-scan.sh").toBeDefined();
    expect(releases).toContain("gitleaks_version=");
  });
});

describe("the supply-chain policy names the gitleaks job (#1783)", () => {
  it("the gitleaks image entry's reason names the `gitleaks` job", () => {
    const entries = findEntries(policy).filter((e) => e.reference.includes("gitleaks/gitleaks"));
    expect(entries.length).toBeGreaterThan(0);
    for (const entry of entries) expect(entry.reason).toMatch(/`gitleaks` job|\bgitleaks job\b/u);
  });
});

function findEntries(node, out = []) {
  if (Array.isArray(node)) for (const n of node) findEntries(n, out);
  else if (node && typeof node === "object") {
    if (typeof node.reference === "string") out.push(node);
    for (const v of Object.values(node)) findEntries(v, out);
  }
  return out;
}
