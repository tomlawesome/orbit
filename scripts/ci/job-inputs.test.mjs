import { readFileSync } from "node:fs";

import { describe, expect, it } from "vitest";

import {
  artefactOf,
  checkoutEntries,
  compositeKey,
  computeKeys,
  definitionEntries,
  denyGlobs,
  formatVariables,
  hashEntries,
  inputsVariable,
  jobNames,
  jobsOnArtefact,
  matchesGlob,
  onlyGlobs,
  parseTreeListing,
  readConfig,
  selects,
  sourceKey,
  sourceVariable,
} from "./job-inputs.mjs";

/*
 * The declaration half of ADR-0028 (#1060 slice 3), which inverted this file
 * from an allow-list into a deny-list.
 *
 * Under the allow-list a forgotten glob was silent: the hash stood still and a
 * job reused a pass that never saw the change. Under a deny-list the default is
 * the whole checkout, so the only way to be wrong is to write an entry for a
 * path the job really reads. That is what most of these tests are: each denied
 * tree checked against the suites and scripts that actually read from it.
 */

const config = readConfig();
const pipeline = readFileSync(new URL("../../.gitlab-ci.yml", import.meta.url), "utf8").replaceAll("\r\n", "\n");

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

// A script entry, not a mention. `build_image` explains in a comment why it has
// no gate, and a substring search counted that comment as one until slice 3.
const GATE_LINE = /^\s*-\s*\*reuse_gate\s*$/mu;

const entry = (path, sha) => ({ type: "blob", path, sha });

/* A tree standing in for the checkout, one file per tree the deny-lists name. */
const tree = [
  entry(".gitlab-ci.yml", "a1"),
  entry("scripts/ci/job-inputs.json", "a2"),
  entry("scripts/install.sh", "a3"),
  entry("Dockerfile", "a4"),
  entry("pnpm-lock.yaml", "a5"),
  entry("src/server/boot.ts", "a6"),
  entry("web/src/routes/+page.svelte", "a7"),
  entry("web/tests/fidelity/dashboard.png", "a8"),
  entry("tests/e2e/local-sign-in.spec.ts", "a9"),
  entry("tests/e2e/local-only-specs.txt", "b0"),
  entry("docs/architecture.md", "b1"),
  entry("docs/installer-guarantees.md", "b2"),
  entry("docs/engine-events.md", "b6"),
  entry(".github/workflows/publish-container.yml", "b7"),
  entry("README.md", "b3"),
  entry("compose/docker-compose.acceptance.yml", "b4"),
  entry("drizzle/0001_init.sql", "b5"),
];

const covers = (job, path) => checkoutEntries(config, job, tree).some((file) => file.path === path);

describe("glob matching", () => {
  it("stops * at a directory boundary and lets ** cross it", () => {
    expect(matchesGlob("scripts/*.mjs", "scripts/a.mjs")).toBe(true);
    expect(matchesGlob("scripts/*.mjs", "scripts/ci/a.mjs")).toBe(false);
    expect(matchesGlob("scripts/**", "scripts/ci/a.mjs")).toBe(true);
    expect(matchesGlob("scripts/**", "scripts/a.mjs")).toBe(true);
    expect(matchesGlob("scripts/**", "web/a.mjs")).toBe(false);
  });

  // The case a naive `**` -> `.*` gets wrong, and the one `scripts/ci/**` in
  // the definition axis depends on.
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
    const globs = ["docs/**", "!docs/installer-guarantees.md"];
    expect(selects(globs, "docs/architecture.md")).toBe(true);
    expect(selects(globs, "docs/installer-guarantees.md")).toBe(false);
  });
});

describe("the deny-lists", () => {
  // The inversion itself. Under #898 a path nobody declared was outside every
  // key; now it is inside every key until somebody writes it down.
  it("covers a path nobody thought about, for every job that is not sidecar_images", () => {
    const stranger = entry("config/a-new-file.json", "zz");
    for (const job of jobNames(config)) {
      if (onlyGlobs(config, job)) continue;
      expect(
        checkoutEntries(config, job, [...tree, stranger]).some((file) => file.path === stranger.path),
        `${job} would ignore a file nobody declared`,
      ).toBe(true);
    }
  });

  it("keeps sidecar_images on its fixed list of pins, as ADR-0028 leaves it", () => {
    expect(onlyGlobs(config, "sidecar_images")).not.toBeNull();
    expect(covers("sidecar_images", "compose/docker-compose.acceptance.yml")).toBe(true);
    expect(covers("sidecar_images", "src/server/boot.ts")).toBe(false);
  });

  // ADR-0028 section 1: for the image-running jobs the deny-list is src/**,
  // web/** less web/tests/**, drizzle/**, docs/** and *.md -- everything the
  // job reaches only through the image, whose content ID is the other axis.
  it("denies the image jobs only what they reach through the image", () => {
    for (const job of jobsOnArtefact(config, "image")) {
      expect(covers(job, "src/server/boot.ts"), `${job} should reach src/ through the image`).toBe(false);
      expect(covers(job, "web/src/routes/+page.svelte")).toBe(false);
      expect(covers(job, "drizzle/0001_init.sql")).toBe(false);
      expect(covers(job, "README.md")).toBe(false);
      // Run from the checkout, every one of them, so none may be denied.
      expect(covers(job, "scripts/install.sh"), `${job} runs scripts from the checkout`).toBe(true);
      expect(covers(job, "tests/e2e/local-sign-in.spec.ts")).toBe(true);
      expect(covers(job, "web/tests/fidelity/dashboard.png")).toBe(true);
      expect(covers(job, "compose/docker-compose.acceptance.yml")).toBe(true);
      expect(covers(job, "Dockerfile")).toBe(true);
      expect(covers(job, "pnpm-lock.yaml")).toBe(true);
    }
  });

  // scripts/test-install-acceptance.sh asserts this file from the checkout, so
  // the docs/** denial the other five image jobs take would be a stale pass.
  it("keeps docs/installer-guarantees.md in acceptance's key and out of smoke's", () => {
    expect(covers("acceptance", "docs/installer-guarantees.md")).toBe(true);
    expect(covers("smoke", "docs/installer-guarantees.md")).toBe(false);
    expect(covers("acceptance", "docs/architecture.md")).toBe(false);
  });

  /*
   * ADR-0028's list for `fast` also names `.github/**`, which this checkout
   * disproves: eight suites `fast` runs read a file there --
   * exact-image-workflow, launcher-compat-job, preview-lane-preflight,
   * processor-compose-contract, publish-from-gitlab-workflow, sidecar-pins,
   * supply-chain-policy and trivy-db-retry. The ADR's admissibility rule
   * ("only when the job reaches it solely through its artefact or not at
   * all") outranks its example list, and the same rule keeps three named
   * files in: docs/engine-events.md (configure-check-contract,
   * engine-events, repair-stream-contract), docs/installer-guarantees.md
   * (installer-guarantees) and tests/e2e/local-only-specs.txt
   * (test-e2e-local, which spawns the real script).
   */
  it("keeps the files fast's own suites read out of fast's deny-list", () => {
    expect(covers("fast", ".github/workflows/publish-container.yml")).toBe(true);
    expect(covers("fast", "docs/engine-events.md")).toBe(true);
    expect(covers("fast", "docs/installer-guarantees.md")).toBe(true);
    expect(covers("fast", "tests/e2e/local-only-specs.txt")).toBe(true);
    // And what it really does not read.
    expect(covers("fast", "docs/architecture.md")).toBe(false);
    expect(covers("fast", "README.md")).toBe(false);
    expect(covers("fast", "web/tests/fidelity/dashboard.png")).toBe(false);
    expect(covers("fast", "tests/e2e/local-sign-in.spec.ts")).toBe(false);
  });

  // fast_docker runs three files and builds one Dockerfile target,
  // vapid-generator, which copies scripts/generate-vapid.mjs and nothing else.
  it("drops web/** for fast_docker and keeps it for fast", () => {
    expect(covers("fast_docker", "web/src/routes/+page.svelte")).toBe(false);
    expect(covers("fast", "web/src/routes/+page.svelte")).toBe(true);
    expect(covers("fast_docker", "src/server/boot.ts")).toBe(true);
  });

  it("denies nothing at all for the two jobs ADR-0028 gives no deny-list", () => {
    for (const job of ["fidelity", "integration"]) {
      expect(denyGlobs(config, job)).toEqual([]);
      expect(covers(job, "docs/architecture.md"), `${job} takes the whole checkout`).toBe(true);
    }
  });

  // The definition axis is added to every key separately, so no deny-list can
  // reach it -- but a deny-list that tried would be a lie worth catching here.
  it("lets no job deny the pipeline definition or the reuse scripts", () => {
    for (const job of jobNames(config)) {
      for (const path of [".gitlab-ci.yml", "scripts/ci/job-inputs.json", "scripts/ci/reuse-lookup.mjs"]) {
        expect(
          definitionEntries(config, [entry(path, "x")]).length,
          `${path} must be in the definition axis`,
        ).toBe(1);
        if (onlyGlobs(config, job)) continue;
        expect(selects(denyGlobs(config, job), path), `${job} denies ${path}`).toBe(false);
      }
    }
  });
});

describe("the pipeline and the declarations agree", () => {
  it("names only jobs the pipeline defines, and every job that gates itself on reuse", () => {
    const defined = blocks();
    const gated = [...defined]
      .filter(([name, body]) => !name.startsWith(".") && GATE_LINE.test(body))
      .map(([name]) => name)
      .sort();
    expect(jobNames(config)).toEqual(gated);
  });

  // ADR-0028: "build_image always builds; it no longer skips." A skipped build
  // computes no content ID, so the six image jobs would have no artefact axis.
  it("leaves build_image out, because it no longer gates itself", () => {
    expect(jobNames(config)).not.toContain("build_image");
    expect(GATE_LINE.test(blocks().get("build_image"))).toBe(false);
  });

  it("has every candidate record evidence as the last thing it does", () => {
    const defined = blocks();
    for (const job of jobNames(config)) {
      expect(defined.get(job), `${job} is missing from .gitlab-ci.yml`).toBeDefined();
      expect(defined.get(job), `${job} records no reuse evidence`).toMatch(/reuse-evidence\.sh|\*reuse_evidence/u);
    }
  });

  it("puts the six image-running jobs ADR-0028 names on the image artefact", () => {
    expect(jobsOnArtefact(config, "image")).toEqual([
      "acceptance",
      "launcher_install_compat",
      "repair_journeys",
      "smoke",
      "smoke_local_only",
      "supply_chain_image",
    ]);
    for (const job of ["fast", "fast_docker", "fidelity", "integration", "sidecar_images"]) {
      expect(artefactOf(config, job)).toBe("");
    }
  });
});

const nul = String.fromCharCode(0);

describe("the key", () => {
  it("does not depend on the order the tree is listed in", () => {
    expect(hashEntries(tree)).toBe(hashEntries([...tree].reverse()));
  });

  it("moves when a file the job reads moves, and stands still when one it does not does", () => {
    const before = computeKeys(config, tree);
    const withNewDoc = tree.map((file) => (file.path === "docs/architecture.md" ? entry(file.path, "zz") : file));
    const withNewSource = tree.map((file) => (file.path === "src/server/boot.ts" ? entry(file.path, "zz") : file));
    expect(computeKeys(config, withNewDoc).get("smoke").source).toBe(before.get("smoke").source);
    expect(computeKeys(config, withNewSource).get("smoke").source).toBe(before.get("smoke").source);
    expect(computeKeys(config, withNewSource).get("integration").source).not.toBe(before.get("integration").source);
  });

  it("moves for every job when the pipeline file moves", () => {
    const before = computeKeys(config, tree);
    const after = computeKeys(config, tree.map(
      (file) => (file.path === ".gitlab-ci.yml" ? entry(file.path, "zz") : file),
    ));
    for (const job of jobNames(config)) {
      expect(after.get(job).source, `${job} ignored a pipeline change`).not.toBe(before.get(job).source);
    }
  });

  it("moves for every job when a reuse script moves", () => {
    const withScript = [...tree, entry("scripts/ci/reuse-lookup.mjs", "c1")];
    const before = computeKeys(config, withScript);
    const after = computeKeys(config, withScript.map(
      (file) => (file.path === "scripts/ci/reuse-lookup.mjs" ? entry(file.path, "zz") : file),
    ));
    for (const job of jobNames(config)) expect(after.get(job).source).not.toBe(before.get(job).source);
  });

  // The artefact axis is the whole point: two images with different content are
  // two different things under test, whatever the checkout says.
  it("moves with the image content ID and with nothing else", () => {
    const source = computeKeys(config, tree).get("smoke").source;
    const first = compositeKey("smoke", source, "content-one");
    expect(compositeKey("smoke", source, "content-one")).toBe(first);
    expect(compositeKey("smoke", source, "content-two")).not.toBe(first);
    expect(compositeKey("smoke", source, "")).not.toBe(first);
  });

  it("gives two jobs with the same axes two different keys", () => {
    const source = sourceKey("smoke", "checkout", "definition");
    expect(compositeKey("smoke", source, "id")).not.toBe(compositeKey("acceptance", source, "id"));
    expect(sourceKey("smoke", "checkout", "definition")).not.toBe(sourceKey("acceptance", "checkout", "definition"));
  });

  /*
   * The serialisation, pinned to two literal digests. `classify` computes a
   * source key and `build_image` finishes it in a later job, on a different
   * runner, from a different checkout of these scripts -- so the encoding is a
   * contract between two processes and not an implementation detail. Changing
   * it has to move KEY_VERSION with it, which retires every piece of evidence
   * in the project at once; these two lines are what makes that deliberate.
   */
  it("serialises the key exactly as both sides of the pipeline assume", () => {
    expect(sourceKey("smoke", "cc", "dd"))
      .toBe("c4829c456f7cde4f7dc0c3bbd6dd095f9f5f8889997fbf47f103d58385c61ac1");
    expect(compositeKey("smoke", "ss", "aa"))
      .toBe("f9b95a72b24becde135fae334c8cfc1ac57c62175fe9b22e39a5c0de42a0122c");
  });
});

describe("what classify publishes", () => {
  it("publishes a source key for every job and a final key only for the ones that have one", () => {
    const lines = formatVariables(computeKeys(config, tree)).split("\n");
    for (const job of jobNames(config)) {
      expect(lines.some((line) => line.startsWith(`${sourceVariable(job)}=`)), `${job} has no source key`).toBe(true);
    }
    for (const job of jobsOnArtefact(config, "image")) {
      expect(
        lines.some((line) => line.startsWith(`${inputsVariable(job)}=`)),
        `${job}'s key is not final until build_image has the content ID`,
      ).toBe(false);
    }
    expect(lines.some((line) => line.startsWith(`${inputsVariable("fast")}=`))).toBe(true);
  });

  it("names each value after its job, in a form a dotenv line can carry", () => {
    expect(inputsVariable("smoke")).toBe("ORBIT_INPUTS_SMOKE");
    expect(sourceVariable("launcher_install_compat")).toBe("ORBIT_SOURCE_LAUNCHER_INSTALL_COMPAT");
  });

  it("reads a NUL-separated tree listing, which is how git is asked for it", () => {
    const listing = `100644 blob aaa\tDockerfile${nul}100644 blob bbb\tweb/src/app.html${nul}`;
    expect(parseTreeListing(listing)).toEqual([
      { type: "blob", sha: "aaa", path: "Dockerfile" },
      { type: "blob", sha: "bbb", path: "web/src/app.html" },
    ]);
  });
});
