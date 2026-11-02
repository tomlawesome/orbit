import { spawnSync } from "node:child_process";
import { mkdtempSync, readFileSync, rmSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

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
  definitionCoversPipeline,
  definitionScripts,
  jobDefinition,
  pipelineOwnedGlobs,
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
  entry(".github/workflows/publish-from-gitlab.yml", "b7"),
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
  it("covers a path nobody thought about, for every job", () => {
    const stranger = entry("config/a-new-file.json", "zz");
    for (const job of jobNames(config)) {
      expect(
        onlyGlobs(config, job),
        `${job} keeps a fixed list, so a path nobody declared would be outside its key`,
      ).toBeNull();
      expect(
        checkoutEntries(config, job, [...tree, stranger]).some((file) => file.path === stranger.path),
        `${job} would ignore a file nobody declared`,
      ).toBe(true);
    }
  });

  // #1370: a scan's answer moves with the day's vulnerability database, which
  // no checkout axis can see, so the job is never reused and has no entry.
  it("declares no entry for sidecar_images: it is never reused (#1370)", () => {
    expect(jobNames(config)).not.toContain("sidecar_images");
    const raw = JSON.parse(readFileSync(new URL("./job-inputs.json", import.meta.url), "utf8"));
    expect(Object.keys(raw.jobs)).not.toContain("sidecar_images");
    expect(() => onlyGlobs(config, "sidecar_images")).toThrow(/declares no job named sidecar_images/u);
    expect(() => checkoutEntries(config, "sidecar_images", tree)).toThrow();
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
   * disproves: four suites `fast` runs read a file there --
   * launcher-compat-job, publish-from-gitlab-workflow, sidecar-pins and
   * supply-chain-policy. The ADR's admissibility rule
   * ("only when the job reaches it solely through its artefact or not at
   * all") outranks its example list, and the same rule keeps three named
   * files in: docs/engine-events.md (configure-check-contract,
   * engine-events, repair-stream-contract), docs/installer-guarantees.md
   * (installer-guarantees) and tests/e2e/local-only-specs.txt
   * (test-e2e-local, which spawns the real script).
   */
  it("keeps the files fast's own suites read out of fast's deny-list", () => {
    expect(covers("fast", ".github/workflows/publish-from-gitlab.yml")).toBe(true);
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

  it("denies nothing at all for the jobs ADR-0028 gives no deny-list", () => {
    for (const job of ["fidelity", "fidelity_webkit", "integration"]) {
      expect(denyGlobs(config, job)).toEqual([]);
      expect(covers(job, "docs/architecture.md"), `${job} takes the whole checkout`).toBe(true);
    }
  });

  // The definition axis is added to every key separately, so no deny-list can
  // reach it -- but a deny-list that tried would be a lie worth catching here.
  it("lets no job deny the pipeline definition or the reuse scripts", () => {
    // The pipeline file and scripts/ci/** belong to the definition axis
    // (#1546): the reuse machinery is on its always list, and the file itself
    // reaches a key through the job's own definition text, not its sha.
    expect(selects(pipelineOwnedGlobs(config), ".gitlab-ci.yml")).toBe(true);
    expect(selects(pipelineOwnedGlobs(config), "scripts/ci/start-acceptance-stack.sh")).toBe(true);
    for (const job of jobNames(config)) {
      for (const path of ["scripts/ci/job-inputs.json", "scripts/ci/reuse-lookup.mjs"]) {
        expect(
          definitionEntries(config, [entry(path, "x")]).length,
          `${path} must be in the definition axis`,
        ).toBe(1);
        if (onlyGlobs(config, job)) continue;
        expect(selects(denyGlobs(config, job), path), `${job} denies ${path}`).toBe(false);
      }
      // A job whose suites read the pipeline file keeps it in its checkout
      // axis; the stack jobs, marked definitionCoversPipeline, do not.
      expect(covers(job, ".gitlab-ci.yml"), `${job} and the pipeline file`).toBe(!definitionCoversPipeline(config, job));
    }
    for (const job of ["fast", "fast_docker"]) {
      expect(definitionCoversPipeline(config, job), `${job} must keep the pipeline file in its checkout axis`).toBe(false);
    }
    for (const job of ["smoke", "acceptance", "repair_journeys", "supply_chain_image"]) {
      expect(definitionCoversPipeline(config, job), `${job} reaches the pipeline only through its definition`).toBe(true);
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

  it("puts the image-running jobs on the image artefact: ADR-0028's six, smoke_firefox (#1183) and the two webkit jobs (#1192)", () => {
    expect(jobsOnArtefact(config, "image")).toEqual([
      "acceptance",
      "launcher_install_compat",
      "repair_journeys",
      "smoke",
      "smoke_firefox",
      "smoke_local_only",
      "smoke_webkit",
      "smoke_webkit_mobile",
      "supply_chain_image",
    ]);
    for (const job of ["fast", "fast_docker", "fidelity", "fidelity_webkit", "integration"]) {
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

  it("moves for every job when the default block of the pipeline file changes, and on its sha alone only for the jobs whose suites read it", () => {
    // #1546: the definition axis is per job. A `default:` edit reaches every
    // job; a new sha for an unchanged text reaches only the jobs that keep
    // the file in their checkout axis (fast, fast_docker).
    const readFile = (path) => readFileSync(new URL(`../../${path}`, import.meta.url), "utf8");
    const before = computeKeys(config, tree, { ciText: pipeline, readFile });
    expect(pipeline.split("\n  interruptible: true\n").length, "the default block's interruptible line").toBe(2);
    const edited = pipeline.replace("\n  interruptible: true\n", "\n  interruptible: false\n");
    const after = computeKeys(config, tree, { ciText: edited, readFile });
    const resha = computeKeys(config, tree.map(
      (file) => (file.path === ".gitlab-ci.yml" ? entry(file.path, "zz") : file),
    ), { ciText: pipeline, readFile });
    for (const job of jobNames(config)) {
      expect(after.get(job).source, `${job} ignored a default: change`).not.toBe(before.get(job).source);
      if (definitionCoversPipeline(config, job)) {
        expect(resha.get(job).source, `${job} moved on the file's sha alone`).toBe(before.get(job).source);
      } else {
        expect(resha.get(job).source, `${job} ignored the file's sha, which its suites read`).not.toBe(before.get(job).source);
      }
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
    // orbit-reuse-key/3 (#1546: the definition axis became per job).
    expect(sourceKey("smoke", "cc", "dd"))
      .toBe("7fb5c79e9b7f2702bcbca6ffb76e3108b6006ddef5c6fcde61f8bedd9909914f");
    expect(compositeKey("smoke", "ss", "aa"))
      .toBe("4bc76345e4633ee9e4b45583fbdfaef5fc881df1f82cd70bf9ba41b3b1423554");
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

/*
 * D-F12 (#1584): on the real tree a job's walk follows its scripts through
 * their code, not their prose. Before the fix a comment that named a path
 * carried 44 scripts/ci paths, release scripts and phantoms among them, into
 * smoke's key, so an edit to a release script reran every image-keyed job.
 */
describe("a job's followed scripts on the real tree", () => {
  const repoFile = (path) => new URL(`../../${path}`, import.meta.url);
  const readFile = (path) => readFileSync(repoFile(path), "utf8");
  const followed = (job) => definitionScripts(jobDefinition(pipeline, job).references, readFile);
  const names = (paths) => paths.map((path) => path.replace(/^scripts\/ci\//u, ""));

  it("follows smoke's scripts through code and not prose", () => {
    const paths = followed("smoke");
    for (const wanted of ["start-acceptance-stack.sh", "create-test-configuration.sh", "reuse-gate.sh", "job-inputs.mjs"]) {
      expect(names(paths), `smoke lost ${wanted}`).toContain(wanted);
    }
    for (const prose of [
      "promote-stable.sh",
      "publish-channel.sh",
      "write-release-manifest.sh",
      "coverage-floor-check.mjs",
      "a.test.mjs",
      "licence-",
      "",
    ]) {
      expect(names(paths), `smoke followed the prose mention ${prose || "scripts/ci/"}`).not.toContain(prose);
    }
  });

  it("carries a ci script in through a non-ci script's code (repair_journeys)", () => {
    const paths = followed("repair_journeys");
    expect(names(paths)).toContain("write-test-manifest.sh");
  });

  it("carries only regular files, for every job (not a directory, a glob stem or a phantom)", () => {
    // statSync().isFile(), not existsSync: existsSync is true for a directory.
    for (const job of jobNames(config)) {
      for (const path of followed(job)) {
        const isFile = (() => {
          try {
            return statSync(repoFile(path)).isFile();
          } catch {
            return false;
          }
        })();
        expect(isFile, `${job} carries ${path}, which is not a regular file`).toBe(true);
      }
    }
  });

  it("keeps the scripts classify's block names in every job's walk", () => {
    // #1546 puts the classify block in every job's definition, so the scripts it
    // names come with it. This pins that decision.
    expect(names(followed("smoke"))).toContain("nightly-browsers.mjs");
  });
});

/*
 * #1370: `sidecar_images` is never reused. Its answer depends on the day's
 * vulnerability database as much as on its inputs, and the only date known
 * before the reuse gate is the cache directory's, not the database's own. So
 * the job runs on every merge-request pipeline, against the database in that
 * day's cache directory, and has no key, no gate and no evidence step
 * (`tidy_freshness` is the precedent for a job whose answer depends on the
 * clock).
 */
describe("sidecar_images is never reused (#1370)", () => {
  // Script entries only: the job's comments explain at length why it has no gate.
  const scriptLines = (body) => body.split("\n").filter((line) => !/^\s*#/u.test(line));
  const sidecarBlock = () => {
    const block = blocks().get("sidecar_images");
    expect(block, "sidecar_images is missing from .gitlab-ci.yml").toBeDefined();
    return block;
  };

  it("has no reuse gate in its script", () => {
    const code = scriptLines(sidecarBlock()).join("\n");
    expect(GATE_LINE.test(sidecarBlock())).toBe(false);
    expect(code).not.toMatch(/\*reuse_gate/u);
    expect(code).not.toMatch(/reuse-gate\.sh/u);
  });

  it("records no reuse evidence, on the clean path or any other", () => {
    const code = scriptLines(sidecarBlock()).join("\n");
    expect(code).not.toMatch(/reuse-evidence\.sh/u);
    expect(code).not.toMatch(/\*reuse_evidence/u);
  });

  it("still warms the dated cache, so a merge-request run uses that day's database", () => {
    const entries = sidecarBlock().split("\n").map((line) => line.trim());
    const dir = entries.indexOf("- *trivy_db_dir");
    const warm = entries.indexOf("- *trivy_db_warm");
    expect(dir, "no `- *trivy_db_dir` script entry").toBeGreaterThan(-1);
    expect(warm, "no `- *trivy_db_warm` script entry").toBeGreaterThan(dir);
    expect(sidecarBlock()).toMatch(/^ {2}cache: \*trivy_db_cache$/mu);
  });

  it("publishes no key for it from classify", () => {
    const variables = formatVariables(computeKeys(config, tree));
    // Positive control: an empty string would satisfy the absence check below.
    expect(variables).toMatch(/^ORBIT_SOURCE_SMOKE=/mu);
    expect(variables).toMatch(/^ORBIT_INPUTS_FAST=/mu);
    expect(variables).not.toMatch(/SIDECAR_IMAGES/u);
    expect(computeKeys(config, tree).has("sidecar_images")).toBe(false);
  });

  it("emits no key for it from `job-inputs.mjs keys` either", () => {
    const dir = mkdtempSync(join(tmpdir(), "orbit-job-inputs-"));
    try {
      const listing = join(dir, "tree.txt");
      writeFileSync(listing, tree.map((file) => `100644 blob ${file.sha}\t${file.path}${nul}`).join(""));
      const run = spawnSync(
        process.execPath,
        [new URL("./job-inputs.mjs", import.meta.url).pathname, "keys", "--tree", listing],
        { encoding: "utf8" },
      );
      expect(run.status, run.stderr).toBe(0);
      expect(run.stdout).toMatch(/^ORBIT_SOURCE_SMOKE=/mu);
      expect(run.stdout).not.toMatch(/sidecar_images/iu);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});

/*
 * D-F10 (#1586): the old private-names job is gone, so neither ADR-0028 nor
 * this file may name it. The pattern is built from parts so that this file
 * does not match itself.
 */
describe("the retired private-names job is named nowhere it would mislead (D-F10, #1586)", () => {
  const retired = ["names", "guard"].join("_");
  for (const path of ["../../docs/adr/0028-ci-reuse-keyed-on-tested-artefact.md", "./job-inputs.test.mjs"]) {
    it(`is not mentioned in ${path.replace(/^(\.\.\/)+/u, "")}`, () => {
      expect(readFileSync(new URL(path, import.meta.url), "utf8")).not.toContain(retired);
    });
  }
});
