import { existsSync, readFileSync } from "node:fs";

import { describe, expect, it } from "vitest";

// #1562: the shared personal-details check runs in this pipeline, blocking,
// pinned to a commit. The rules live on the runner host, so nothing here can
// run the scan; what can go wrong in the repository is the wiring, and that
// is what these tests pin.
const gitlabCi = readFileSync(new URL("../.gitlab-ci.yml", import.meta.url), "utf8");
const allowlist = readFileSync(new URL("../.private-details-allow.toml", import.meta.url), "utf8");

function jobBlock(name) {
  const start = gitlabCi.indexOf(`\n${name}:\n`);
  expect(start, `${name} is not defined`).toBeGreaterThan(-1);
  const body = start + 1 + name.length + 2;
  // A comment line ends the job: the next top-level text, comment or key.
  const next = gitlabCi.slice(body).search(/^\S/mu);
  return gitlabCi.slice(start + 1, body + next);
}

describe("the shared private-details check (#1562)", () => {
  it("includes the template at the commit its tag names, with the tag in a comment", () => {
    const include = gitlabCi.match(/^include:\n( {2}-.*\n(?: {4}.*\n)+)/mu)?.[1];
    expect(include, "no include: block").toBeDefined();
    expect(include).toContain("project: ai/agent-infra");
    expect(include).toContain("file: scripts/private-details/ci-template.yml");
    // A tag can be moved by a Maintainer of the other project; a commit cannot.
    const ref = include.match(/ref: ([^\s#]+)\s+# (private-details\/v\d+)$/mu);
    expect(ref, "ref must be a commit with the tag it came from in a comment").not.toBeNull();
    expect(ref[1]).toMatch(/^[0-9a-f]{40}$/u);
  });

  it("is blocking, starts at once, and sits in a stage this pipeline has", () => {
    const job = jobBlock("private-details");
    const stage = job.match(/^ {2}stage: (\S+)$/mu)?.[1];
    const stages = gitlabCi.match(/^stages:\n((?: {2}- \S+\n)+)/mu)[1];
    expect(stages).toContain(`- ${stage}\n`);
    expect(job).toMatch(/^ {2}needs: \[\]$/mu);
    expect(job).not.toMatch(/allow_failure/u);
    // Like gitleaks: none in a scheduled pipeline or the push-to-main one.
    expect(job).toContain("*not_on_main_push");
    expect(job).toContain("*not_scheduled");
    expect(job).toMatch(/^ {4}- when: on_success$/mu);
  });

  it("runs in every lane: it needs no classify, so it never reads ORBIT_LANE", () => {
    const job = jobBlock("private-details");
    expect(job).not.toContain("orbit_lane_admits");
    expect(job).not.toContain("classify");
  });

  it("pins its image by digest through the cache, at the gitleaks release the gitleaks job uses", () => {
    const job = jobBlock("private-details");
    const image = job.match(/name: (\$CI_IMAGE_CACHE_GHCR\/gitleaks\/gitleaks:v([\d.]+)@sha256:[0-9a-f]{64})$/mu);
    expect(image, "the image is not pinned by digest").not.toBeNull();
    const version = gitlabCi.match(/GITLEAKS_VERSION: "([\d.]+)"/u)[1];
    expect(image[2]).toBe(version);
  });

  it("scans from a start point that is a full commit id", () => {
    const job = jobBlock("private-details");
    expect(job).toMatch(/PRIVATE_DETAILS_SINCE: [0-9a-f]{40}$/mu);
  });

  it("keeps no copy of the rules: the old guard and its job are gone", () => {
    expect(existsSync(new URL("../tests/unit/no-real-names.test.mjs", import.meta.url))).toBe(false);
    expect(gitlabCi).not.toMatch(/^names_guard:/mu);
    expect(gitlabCi).not.toContain("no-real-names");
  });

  it("allows things by rule and path only, never by commit", () => {
    const tables = allowlist.split("[[allowlists]]").slice(1);
    expect(tables.length).toBeGreaterThan(0);
    for (const table of tables) {
      expect(table, "an allowlist table needs targetRules").toMatch(/^targetRules = \[.+\]$/mu);
      expect(table, "an allowlist table needs paths").toMatch(/^paths = \[/mu);
      expect(table).not.toMatch(/^commits\s*=/mu);
      // Every path is anchored, so it names a file or a folder, not a word.
      for (const path of table.matchAll(/^ {2}'''(.*)''',?$/gmu)) {
        expect(path[1], "unanchored allowlist path").toMatch(/^\^/u);
      }
    }
  });
});
