import { describe, expect, it } from "vitest";

import { jobBlocks, jobNamesOf, readCi } from "../test-support/gitlab-ci.mjs";

/*
 * S-ci-1, #1722: every job image in .gitlab-ci.yml is pinned by digest,
 * included jobs too. The back-merge pipelines hold protected publishing
 * tokens, so a tag-only image (movable) must not run there.
 *
 * Reads the file textually, like the other CI tests (scripts/test-support/
 * gitlab-ci.mjs); no YAML library is a dependency.
 */
const DIGEST = /@sha256:[0-9a-f]{64}$/u;

// Jobs an `include: project:` template adds, which this file must override
// with a digest-pinned image. The template file is not in this repo, so the
// test cannot read it to discover them: keep this list by hand, one entry
// per job a template defines with an image (backmerge-skip/v1: backmerge-check;
// private-details/v3's job is `private-details`, already defined here).
const INCLUDED_JOBS = ["backmerge-check", "private-details"];

// Images this pipeline builds itself (a tag is all they have). None is used as
// a job image today; the registry-digest pins in supply-chain-policy.test.mjs
// do not exempt any either.
const BUILT_HERE = new Set(["$ORBIT_CI_IMAGE"]);

function jobBlock(name, text) {
  const block = jobBlocks(text).get(name);
  expect(block, `${name}: not defined in .gitlab-ci.yml (the template's tag-only image would run)`).toBeDefined();
  return block;
}

function variables(text) {
  const out = new Map();
  const block = jobBlocks(text).get("variables") ?? "";
  for (const m of block.matchAll(/^ {2}([A-Z][A-Z0-9_]*):\s+(\S+)\s*(?:#.*)?$/gmu)) out.set(m[1], m[2]);
  return out;
}

function resolve(value, vars, depth = 0) {
  const unquoted = value.replace(/^["']|["']$/gu, "");
  if (depth > 5) return unquoted;
  return unquoted.replace(/\$\{?([A-Z][A-Z0-9_]*)\}?/gu, (whole, name) =>
    vars.has(name) ? resolve(vars.get(name), vars, depth + 1) : whole,
  );
}

/** The image name a job block declares, as written, or undefined. */
function imageName(block) {
  const short = block.match(/^ {2}image:[ \t]+(\S+)[ \t]*$/mu)?.[1];
  if (short) return short;
  return block.match(/^ {2}image:[ \t]*\n(?: {4}\S.*\n)*?^ {4}name:[ \t]+(\S+)/mu)?.[1];
}

describe("job images are pinned by digest (S-ci-1, #1722)", () => {
  const text = readCi();
  const vars = variables(text);

  it("every job image that names a registry image carries @sha256:", () => {
    const unpinned = [];
    for (const job of jobNamesOf(text)) {
      const name = imageName(jobBlock(job, text));
      if (name === undefined || BUILT_HERE.has(name)) continue;
      const resolved = resolve(name, vars);
      if (!DIGEST.test(resolved)) unpinned.push(`${job}: ${name}`);
    }
    expect(unpinned, "job images without a digest").toEqual([]);
  });

  it.each(INCLUDED_JOBS)("included job %s is overridden here with a digest-pinned image", (job) => {
    const name = imageName(jobBlock(job, text));
    expect(name, `${job}: no image name set in .gitlab-ci.yml`).toBeDefined();
    expect(resolve(name, vars)).toMatch(DIGEST);
    expect(jobBlock(job, text)).toMatch(/^ {4}entrypoint:\s+\[""\]/mu);
  });

  it("backmerge-check uses the same gitleaks image as private-details", () => {
    const a = imageName(jobBlock("backmerge-check", text));
    const b = imageName(jobBlock("private-details", text));
    expect(a).toBeDefined();
    expect(a).toBe(b);
    expect(a).toMatch(/gitleaks:v8\.30\.1@sha256:[0-9a-f]{64}$/u);
  });
});
