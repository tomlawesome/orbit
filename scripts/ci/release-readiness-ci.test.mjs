import { readFileSync } from "node:fs";

import { describe, expect, it } from "vitest";

import { BATCH_EVENTS, OTHER_EVENTS, pipelineOf } from "../test-support/ci-simulate.mjs";
import { jobBlocks, readCi, stagesOf } from "../test-support/gitlab-ci.mjs";

/*
 * #1860: `release_readiness` runs first on every promotion merge request
 * (dev -> preview, preview -> main), and every other job in that pipeline
 * waits for it: through `needs:` (directly or through a job that does), or by
 * having no `needs:` and sitting in a later stage. A job that would start
 * alongside it fails this test. The cheap policy jobs below may keep
 * `needs: []` (decided on #1860: under a minute each, not what the check saves).
 */
const ci = readCi();
const templates = [
  readFileSync(new URL("../test-support/fixtures/backmerge-skip-v1-ci-template.yml", import.meta.url), "utf8"),
  readFileSync(new URL("../test-support/fixtures/dev-landing-v1-ci-template.yml", import.meta.url), "utf8"),
];
const ALLOWED_ALONGSIDE = ["gitleaks", "private-details", "flake_check"];
const PROMOTIONS = { mrIntoPreview: OTHER_EVENTS.mrIntoPreview, mrIntoMain: OTHER_EVENTS.mrIntoMain };

/** A top-level key's own `  key: value` line, or undefined. */
function ownLine(block, key) {
  return new RegExp(`^ {2}${key}:[ \\t]*(.*?)[ \\t]*(?:#.*)?$`, "mu").exec(block)?.[1];
}

/** The `extends:` names of a block, inline or as a list. */
function extendsOf(block) {
  const inline = ownLine(block, "extends");
  if (inline === undefined) return [];
  if (inline !== "") return [inline.replace(/^\[|\]$/gu, "")].flatMap((v) => v.split(",")).map((v) => v.trim()).filter(Boolean);
  const after = block.split("\n");
  const start = after.findIndex((line) => /^ {2}extends:/u.test(line));
  const names = [];
  for (const line of after.slice(start + 1)) {
    const item = /^ {4}- (\S+)/u.exec(line);
    if (item) names.push(item[1]);
    else if (/^ {2}\S/u.test(line)) break;
  }
  return names;
}

/** `needs` entries as job names, from a list body (indent = the `- ` indent). */
function needList(lines, indent) {
  const names = [];
  for (const line of lines) {
    if (/^\s*(#.*)?$/u.test(line)) continue;
    const item = new RegExp(`^ {${indent}}- (?:job: )?([A-Za-z0-9_.-]+)\\s*$`, "u").exec(line);
    if (item) names.push(item[1]);
    else if (!new RegExp(`^ {${indent + 2}}\\S`, "u").test(line)) break;
  }
  return names;
}

function model(text, extra = []) {
  const blocks = new Map([...extra.flatMap((t) => [...jobBlocks(t)]), ...jobBlocks(text)]);
  const anchors = new Map();
  for (const [, block] of blocks) {
    const anchor = /^[A-Za-z_.][\w.-]*:[ \t]*&(\S+)/u.exec(block);
    if (anchor) anchors.set(anchor[1], needList(block.split("\n").slice(1), 2));
  }
  const field = (name, key, seen = new Set()) => {
    const block = blocks.get(name);
    if (!block || seen.has(name)) return undefined;
    seen.add(name);
    const own = ownLine(block, key);
    if (own !== undefined) return { block, value: own };
    for (const parent of extendsOf(block).reverse()) {
      const found = field(parent, key, seen);
      if (found) return found;
    }
    return undefined;
  };
  return {
    stage: (name) => field(name, "stage")?.value ?? "test",
    // undefined: no `needs:` key (stage order applies).
    needs: (name) => {
      const found = field(name, "needs");
      if (!found) return undefined;
      if (found.value === "[]") return [];
      const alias = /^\*(\S+)$/u.exec(found.value);
      if (alias) return anchors.get(alias[1]) ?? [];
      const lines = found.block.split("\n");
      const start = lines.findIndex((line) => /^ {2}needs:/u.test(line));
      return needList(lines.slice(start + 1), 4);
    },
  };
}

/** Jobs in `jobs` that neither need release_readiness (transitively) nor wait for it by stage. */
function notWaiting(text, jobs, extra = templates) {
  const { stage, needs } = model(text, extra);
  const stages = stagesOf(text);
  const gate = stages.indexOf(stage("release_readiness"));
  const memo = new Map();
  const waits = (name) => {
    if (name === "release_readiness") return true;
    if (memo.has(name)) return memo.get(name);
    memo.set(name, false);
    const own = needs(name);
    const result =
      own === undefined
        ? stages.indexOf(stage(name)) > gate
        : own.some((need) => jobs.includes(need) && waits(need));
    memo.set(name, result);
    return result;
  };
  return jobs.filter((name) => name !== "release_readiness" && !ALLOWED_ALONGSIDE.includes(name) && !waits(name));
}

describe("release_readiness waits for nothing and everything waits for it (#1860)", () => {
  it("sits in a stage before classify, so the stage-order wait is real", () => {
    const { stage } = model(ci, templates);
    const stages = stagesOf(ci);
    expect(stages.indexOf(stage("release_readiness"))).toBeGreaterThanOrEqual(0);
    expect(stages.indexOf(stage("release_readiness"))).toBeLessThan(stages.indexOf(stage("classify")));
  });

  for (const [event, env] of Object.entries(PROMOTIONS)) {
    it(`${event}: runs release_readiness, and every other job but the allowlist waits for it`, () => {
      const run = pipelineOf(env, ci, templates);
      expect(run.pipeline).toBe(true);
      const jobs = Object.keys(run.jobs);
      expect(jobs).toContain("release_readiness");
      expect(jobs.length).toBeGreaterThan(10);
      expect(notWaiting(ci, jobs)).toEqual([]);
    });
  }

  it("catches a job that would start alongside it", () => {
    const added = `${ci}\nsneaky_job:\n  stage: fast\n  needs: []\n  script:\n    - "true"\n`;
    const jobs = Object.keys(pipelineOf(PROMOTIONS.mrIntoPreview, added, templates).jobs);
    expect(jobs).toContain("sneaky_job");
    expect(notWaiting(added, jobs)).toEqual(["sneaky_job"]);
  });

  it("runs on no other pipeline", () => {
    const others = { ...OTHER_EVENTS, ...BATCH_EVENTS };
    for (const [event, env] of Object.entries(others)) {
      if (event in PROMOTIONS) continue;
      const run = pipelineOf(env, ci, templates);
      expect(run.pipeline ? Object.keys(run.jobs) : [], event).not.toContain("release_readiness");
    }
  }, 120_000);
});
