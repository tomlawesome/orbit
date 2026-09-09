import { readFileSync } from "node:fs";

import { describe, expect, it } from "vitest";

import {
  computeJobHashes,
  hashEntries,
  inputsVariable,
  jobInputHash,
  jobNames,
  matchesGlob,
  parseTreeListing,
  readConfig,
  resolveGlobs,
  selects,
} from "./ci/job-inputs.mjs";

/*
 * The declaration half of #898. A job stands on an earlier run when its input
 * hash is unchanged, so a glob that is too narrow reuses a stale result -- the
 * one failure mode of the whole mechanism that is not merely slow. These tests
 * pin the matching rules, the hash, and the two paths that must be in every
 * job's set.
 */

const config = readConfig();
const pipeline = readFileSync(new URL("../.gitlab-ci.yml", import.meta.url), "utf8").replaceAll("\r\n", "\n");

// The same block reader scripts/gitlab-ci-lanes.test.mjs uses: a `name:` at
// column zero up to the next one.
function blocks() {
  const found = new Map();
  const headers = [...pipeline.matchAll(/^([A-Za-z_.][A-Za-z0-9_.-]*):\s*(?:&\S+\s*\|?\s*)?(?:#.*)?$/gmu)];
  headers.forEach((match, index) => {
    const start = match.index;
    const end = index + 1 < headers.length ? headers[index + 1].index : pipeline.length;
    found.set(match[1], pipeline.slice(start, end));
  });
  return found;
}

const entry = (path, sha) => ({ type: "blob", path, sha });

describe("glob matching", () => {
  it("stops * at a directory boundary and lets ** cross it", () => {
    expect(matchesGlob("scripts/*.mjs", "scripts/a.mjs")).toBe(true);
    expect(matchesGlob("scripts/*.mjs", "scripts/ci/a.mjs")).toBe(false);
    expect(matchesGlob("scripts/**", "scripts/ci/a.mjs")).toBe(true);
    expect(matchesGlob("scripts/**", "scripts/a.mjs")).toBe(true);
    expect(matchesGlob("scripts/**", "web/a.mjs")).toBe(false);
  });

  // The case a naive `**` -> `.*` gets wrong, and the one the image group
  // depends on: `scripts/**/*.test.mjs` has to take scripts/a.test.mjs out as
  // well as scripts/ci/a.test.mjs.
  it("lets ** stand for no directory at all", () => {
    expect(matchesGlob("scripts/**/*.test.mjs", "scripts/a.test.mjs")).toBe(true);
    expect(matchesGlob("scripts/**/*.test.mjs", "scripts/ci/a.test.mjs")).toBe(true);
    expect(matchesGlob("**", "README.md")).toBe(true);
    expect(matchesGlob("**", "web/src/app.html")).toBe(true);
  });

  it("treats a dot as a literal rather than as any character", () => {
    expect(matchesGlob(".gitlab-ci.yml", ".gitlab-ci.yml")).toBe(true);
    expect(matchesGlob(".gitlab-ci.yml", "xgitlab-ci.yml")).toBe(false);
  });

  it("takes matches back out for an entry starting with !", () => {
    const globs = ["scripts/**", "!scripts/**/*.test.mjs"];
    expect(selects(globs, "scripts/install.sh")).toBe(true);
    expect(selects(globs, "scripts/ci/reuse-gate.sh")).toBe(true);
    expect(selects(globs, "scripts/repair.test.mjs")).toBe(false);
  });
});

describe("the declarations", () => {
  it("puts the pipeline file and the declaration itself in every job's set", () => {
    for (const job of jobNames(config)) {
      const globs = resolveGlobs(config, job);
      expect(selects(globs, ".gitlab-ci.yml"), `${job} must rerun when the pipeline changes`).toBe(true);
      expect(selects(globs, "scripts/ci/job-inputs.json"), `${job} must rerun when its own inputs change`).toBe(true);
    }
  });

  it("names only jobs the pipeline defines, and every job that gates itself on reuse", () => {
    const defined = blocks();
    const gated = [...defined]
      .filter(([name, body]) => !name.startsWith(".") && body.includes("*reuse_gate"))
      .map(([name]) => name)
      .sort();
    expect(jobNames(config)).toEqual(gated);
  });

  it("has every candidate record evidence as the last thing it does", () => {
    const defined = blocks();
    for (const job of jobNames(config)) {
      expect(defined.get(job), `${job} is missing from .gitlab-ci.yml`).toBeDefined();
      expect(defined.get(job), `${job} records no reuse evidence`).toMatch(/reuse-evidence\.sh|\*reuse_evidence/u);
    }
  });

  // The exclusion the whole economy rests on: the usual fix after a red `fast`
  // is a test or a fidelity baseline, and neither reaches the image.
  it("keeps test files and fidelity baselines out of the image's inputs", () => {
    const globs = resolveGlobs(config, "build_image");
    expect(selects(globs, "src/lib/install-orchestrator.test.ts")).toBe(false);
    expect(selects(globs, "scripts/repair.test.mjs")).toBe(false);
    expect(selects(globs, "web/tests/fidelity/dashboard.png")).toBe(false);
    expect(selects(globs, "web/src/routes/+page.svelte")).toBe(true);
    expect(selects(globs, "Dockerfile")).toBe(true);
    expect(selects(globs, "pnpm-lock.yaml")).toBe(true);
  });

  it("has the jobs that test the image rerun whenever the image's own inputs do", () => {
    const image = resolveGlobs(config, "build_image");
    for (const job of ["smoke", "smoke_local_only", "acceptance", "repair_journeys", "launcher_install_compat", "supply_chain_image"]) {
      const globs = resolveGlobs(config, job);
      for (const path of ["Dockerfile", "src/server/boot.ts", "web/src/routes/+page.svelte", "pnpm-lock.yaml"]) {
        expect(selects(image, path) && !selects(globs, path), `${job} would miss a change to ${path}`).toBe(false);
      }
    }
  });
});

const nul = String.fromCharCode(0);

describe("hashing", () => {
  const tree = [
    entry("Dockerfile", "aaa"),
    entry(".gitlab-ci.yml", "bbb"),
    entry("scripts/repair.test.mjs", "ccc"),
    entry("web/src/app.html", "ddd"),
  ];

  it("does not depend on the order the tree is listed in", () => {
    expect(hashEntries(tree)).toBe(hashEntries([...tree].reverse()));
  });

  it("moves when a file a job reads moves, and stands still when one it does not does", () => {
    const before = jobInputHash(config, "build_image", tree);
    const testChanged = tree.map((file) => (file.path === "scripts/repair.test.mjs" ? entry(file.path, "zzz") : file));
    const sourceChanged = tree.map((file) => (file.path === "web/src/app.html" ? entry(file.path, "zzz") : file));
    expect(jobInputHash(config, "build_image", testChanged)).toBe(before);
    expect(jobInputHash(config, "build_image", sourceChanged)).not.toBe(before);
  });

  it("moves for every job when the pipeline file moves", () => {
    const before = computeJobHashes(config, tree);
    const after = computeJobHashes(config, tree.map(
      (file) => (file.path === ".gitlab-ci.yml" ? entry(file.path, "zzz") : file),
    ));
    for (const job of jobNames(config)) expect(after.get(job)).not.toBe(before.get(job));
  });

  it("reads a NUL-separated tree listing, which is how git is asked for it", () => {
    const listing = `100644 blob aaa\tDockerfile${nul}100644 blob bbb\tweb/src/app.html${nul}`;
    expect(parseTreeListing(listing)).toEqual([
      { type: "blob", sha: "aaa", path: "Dockerfile" },
      { type: "blob", sha: "bbb", path: "web/src/app.html" },
    ]);
  });

  it("names each hash after its job, in a form a dotenv line can carry", () => {
    expect(inputsVariable("build_image")).toBe("ORBIT_INPUTS_BUILD_IMAGE");
    expect(inputsVariable("launcher_install_compat")).toBe("ORBIT_INPUTS_LAUNCHER_INSTALL_COMPAT");
  });
});
