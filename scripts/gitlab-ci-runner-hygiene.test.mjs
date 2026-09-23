import { readFileSync } from "node:fs";

import { describe, expect, it } from "vitest";

// #823: the runner host ran out of disk. Part of it was ours -- a job that
// starts its own Docker daemon leaves the daemon's image store in the slot's
// /builds volume, which outlives the job. This pins the rule that every such
// job tears the store down on its way out, whatever else its after_script does.
const gitlabCi = readFileSync(new URL("../.gitlab-ci.yml", import.meta.url), "utf8");

// Top-level job blocks by name: a line that is `name:` at column zero, with
// or without an `&anchor |` after it, up to the next such line. Anchors
// (`.name:`) are included and filtered below.
function jobBlocks() {
  const blocks = new Map();
  const headers = [...gitlabCi.matchAll(/^([A-Za-z_.][A-Za-z0-9_.-]*):\s*(?:&\S+\s*\|?\s*)?(?:#.*)?$/gmu)];
  headers.forEach((match, index) => {
    const start = match.index;
    const end = index + 1 < headers.length ? headers[index + 1].index : gitlabCi.length;
    blocks.set(match[1], gitlabCi.slice(start, end));
  });
  return blocks;
}

function afterScriptEntries(block) {
  const start = block.indexOf("\n  after_script:\n");
  if (start < 0) {
    return null;
  }
  const rest = block.slice(start + "\n  after_script:\n".length);
  // The section ends at the next key indented two spaces (artifacts:, rules:,
  // ...) or at the end of the block.
  const end = rest.search(/^ {2}[a-z_]+:/mu);
  const section = end < 0 ? rest : rest.slice(0, end);
  return [...section.matchAll(/^ {4}- (.*)$/gmu)].map((match) => match[1].trim());
}

describe("in-job Docker daemons clean up after themselves (#823)", () => {
  const jobs = [...jobBlocks()].filter(
    ([name, block]) => !name.startsWith(".") && block.includes("- *docker_in_job\n"),
  );

  it("covers the jobs known to start a daemon", () => {
    expect(jobs.map(([name]) => name).sort()).toEqual(
      [
        "acceptance", "install_bootstrap", "install_bootstrap_latest", "launcher_install_compat", "repair_journeys",
        "smoke", "smoke_local_only", "supply_chain_image",
      ].sort(),
    );
  });

  it.each(jobs.map(([name, block]) => [name, block]))(
    "%s ends its after_script with the teardown",
    (_name, block) => {
      const entries = afterScriptEntries(block);
      expect(entries, "after_script is missing").not.toBeNull();
      expect(entries.at(-1)).toBe("*docker_in_job_teardown");
    },
  );

  it("stops the daemon before removing its store, and removes the scanner temp too", () => {
    const anchor = jobBlocks().get(".docker_in_job_teardown");
    expect(anchor).toBeDefined();
    const killAt = anchor.indexOf("kill ");
    const removeAt = anchor.indexOf("rm -rf");
    expect(killAt).toBeGreaterThan(0);
    expect(removeAt).toBeGreaterThan(killAt);
    expect(anchor).toContain('.orbit-docker-data" || :');
    expect(anchor).toContain('rm -rf "$RUNNER_TEMP" || :');
  });
});

// #829: a working branch's first push and its merge request, opened seconds
// later, each ran a full pipeline for the same commit, doubling Orbit's share
// of the shared runner. Pushes start a pipeline on the long-lived branches
// only; everything else is tested by its merge request.
describe("a push starts a pipeline on the long-lived branches only (#829)", () => {
  const workflow = jobBlocks().get("workflow");
  const rules = [...workflow.matchAll(/^ {4}- if: (.*)$(?:\n {6}when: (\S+))?/gmu)].map((match) => ({
    condition: match[1],
    when: match[2] ?? "always",
  }));
  const pushGuard = rules.find(({ condition }) => condition.startsWith('$CI_PIPELINE_SOURCE == "push" &&'));

  it("refuses a push pipeline on any other branch", () => {
    expect(pushGuard, "the push guard is missing").toBeDefined();
    expect(pushGuard.when).toBe("never");
    for (const branch of ["dev", "preview", "main"]) {
      expect(pushGuard.condition).toContain(`$CI_COMMIT_BRANCH != "${branch}"`);
    }
    expect(pushGuard.condition).toContain("$CI_COMMIT_BRANCH !~ /^hotfix\\//");
  });

  it("keeps the catch-all for pipelines started by hand, after the guard", () => {
    const catchAll = rules.findIndex(({ condition, when }) => condition === "$CI_COMMIT_BRANCH" && when === "always");
    expect(catchAll).toBeGreaterThan(rules.indexOf(pushGuard));
  });
});

// #834 (part 1): an artifacts block with no expire_in keeps its files forever,
// which is exactly the kind of unbounded growth #823 was about. This only
// pins the expiry; the pull_policy and registry-retention parts of #834 are
// separate and need the owner first.
function artifactsSection(block) {
  const start = block.indexOf("\n  artifacts:\n");
  if (start < 0) {
    return null;
  }
  const rest = block.slice(start + "\n  artifacts:\n".length);
  // Same rule as afterScriptEntries: the section ends at the next key
  // indented two spaces, or at the end of the block.
  const end = rest.search(/^ {2}[a-z_]+:/mu);
  return end < 0 ? rest : rest.slice(0, end);
}

describe("every artifacts block has an expire_in (#834)", () => {
  const jobsWithArtifacts = [...jobBlocks()].filter(
    ([, block]) => artifactsSection(block) !== null,
  );

  it("found at least one job with an artifacts block", () => {
    // Guards the guard: if nobody pins artifacts any more this test would
    // otherwise pass vacuously.
    expect(jobsWithArtifacts.length).toBeGreaterThan(0);
  });

  it.each(jobsWithArtifacts.map(([name, block]) => [name, block]))(
    "%s sets expire_in on its artifacts",
    (_name, block) => {
      const section = artifactsSection(block);
      expect(section).toMatch(/^ {4}expire_in: /mu);
    },
  );
});

// #1041: `build_image` may stand on an earlier pipeline's run, and when it does
// it hands on that run's image.tar and build.env wholesale. The tarball then
// carries the *earlier* commit's tag. A job that names the image by this
// commit -- ORBIT_CI_IMAGE, `orbit-ci:$CI_COMMIT_SHA` -- asks the daemon for a
// tag it never loaded; `orbit-ci` has no registry prefix, so Docker resolves it
// to Docker Hub and reports "pull access denied", which names the wrong fault
// entirely. The tag must come from build.env, which travels with the tarball.
const REUSED_SHA = "4516511".padEnd(40, "0");
const CURRENT_SHA = "56c7884".padEnd(40, "0");

// The pipeline-wide `variables:` block, as name/value pairs.
function globalVariables() {
  const block = jobBlocks().get("variables");
  const pairs = [...block.matchAll(/^ {2}([A-Z][A-Z0-9_]*): (.+)$/gmu)];
  return Object.fromEntries(pairs.map((match) => [match[1], match[2].trim()]));
}

// GitLab's own precedence: a dotenv variable from a `needs:` job beats the
// job's and the pipeline's YAML definitions, and every value is expanded
// against the whole set.
function expand(expression, variables) {
  let value = expression;
  for (let pass = 0; pass < 10 && /\$/u.test(value); pass += 1) {
    value = value.replace(/\$\{?([A-Za-z_][A-Za-z0-9_]*)\}?/gu, (whole, name) =>
      name in variables ? variables[name] : whole,
    );
  }
  return value;
}

// Every way a job names the image it has just loaded: the ORBIT_IMAGE job
// variable the acceptance stack reads, the TESTED_IMAGE_TAG the ci scripts
// take, and the source side of a `docker tag`.
function imageReferences(block) {
  return [
    ...[...block.matchAll(/^ {4}ORBIT_IMAGE: (\S+)$/gmu)].map((match) => match[1]),
    ...[...block.matchAll(/TESTED_IMAGE_TAG="([^"]+)"/gu)].map((match) => match[1]),
    ...[...block.matchAll(/docker tag "([^"]+)"/gu)].map((match) => match[1]),
  ];
}

describe("a job names the image it loaded, not the commit it is running on (#1041)", () => {
  const loaders = [...jobBlocks()].filter(
    ([name, block]) => !name.startsWith(".") && block.includes("docker load --input image.tar"),
  );

  it("covers every job that loads the build_image tarball", () => {
    expect(loaders.map(([name]) => name).sort()).toEqual(
      [
        "acceptance", "launcher_install_compat", "record_image", "repair_journeys",
        "smoke", "smoke_local_only", "supply_chain_image",
      ].sort(),
    );
  });

  // The identity build_image publishes is what makes this possible: without
  // ORBIT_IMAGE_TAG in build.env there is nothing for a reused job to read.
  it("build_image publishes the loaded tag in its dotenv artefact", () => {
    const block = jobBlocks().get("build_image");
    expect(block).toMatch(/ORBIT_IMAGE_TAG:tag/u);
    expect(block).toMatch(/dotenv: build\.env/u);
  });

  it.each(loaders.map(([name, block]) => [name, block]))(
    "%s asks for the tag the reused tarball carries",
    (_name, block) => {
      const references = imageReferences(block);
      expect(references.length, "names the loaded image nowhere").toBeGreaterThan(0);
      // build_image stood on a run at REUSED_SHA; this pipeline is at
      // CURRENT_SHA. build.env came with the tarball, so its tag is the
      // earlier one, and dotenv outranks the pipeline's ORBIT_CI_IMAGE.
      const variables = {
        ...globalVariables(),
        CI_COMMIT_SHA: CURRENT_SHA,
        ORBIT_IMAGE_TAG: `orbit-ci:${REUSED_SHA}`,
      };
      for (const reference of references) {
        expect(expand(reference, variables)).toBe(`orbit-ci:${REUSED_SHA}`);
      }
    },
  );
});
