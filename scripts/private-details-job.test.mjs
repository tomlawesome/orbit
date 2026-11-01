import { spawnSync } from "node:child_process";
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterEach, describe, expect, it } from "vitest";

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

// D-SEC1 (#1584): the include is pinned to a commit because a tag can be moved
// onto other code, but the template's own script clones agent-infra by the tag
// in PRIVATE_DETAILS_REF and runs whatever it finds. The job therefore carries
// its own script, which refuses to run the scanner unless the clone is at the
// pinned commit, written once here as PRIVATE_DETAILS_COMMIT and checked below
// to equal the include's ref.
const includeRef = gitlabCi.match(/^include:\n( {2}-.*\n(?: {4}.*\n)+)/mu)?.[1].match(/ref: ([0-9a-f]{40})\s+#/u)?.[1];

function stripQuotes(value) {
  return value.trim().replace(/^(["'])(.*)\1$/u, "$2");
}

/** The `variables:` mapping of a job block (plain `KEY: value` lines). */
function jobVariables(job) {
  const block = job.match(/^ {2}variables:\n((?: {4}\S.*\n?)+)/mu)?.[1] ?? "";
  const vars = {};
  for (const line of block.split("\n")) {
    const pair = line.match(/^ {4}([A-Za-z_][A-Za-z0-9_]*): (.*?)(?:\s+#.*)?$/u);
    if (pair) vars[pair[1]] = stripQuotes(pair[2]);
  }
  return vars;
}

// YAML validity of the script items is covered by the "plain scalar" test below;
// this extractor only recovers the shell text for the stub-git runs.
/**
 * The job's own `script:` as one shell text. Reads plain or quoted one-line
 * items and `- |` literal blocks; anything else is refused, not guessed at.
 */
function jobScript(job) {
  const start = job.search(/^ {2}script:\n/mu);
  expect(start, "the private-details job has no script: of its own").toBeGreaterThan(-1);
  const lines = job.slice(start).split("\n").slice(1);
  const out = [];
  for (let i = 0; i < lines.length; i += 1) {
    const line = lines[i];
    if (line.trim() === "") continue;
    if (!/^ {4}- /u.test(line)) {
      if (/^ {0,3}\S/u.test(line)) break;
      throw new Error(`script item not understood: ${line}`);
    }
    const item = line.slice(6);
    if (item === "|") {
      const body = [];
      while (i + 1 < lines.length && (lines[i + 1].trim() === "" || /^ {6}/u.test(lines[i + 1]))) {
        i += 1;
        body.push(lines[i].slice(6));
      }
      out.push(body.join("\n").trim());
    } else {
      out.push(stripQuotes(item));
    }
  }
  return out.join("\n");
}

/** The raw text after `- ` of each item of the job's `script:` list. */
function scriptItemLines(job) {
  const start = job.search(/^ {2}script:\n/mu);
  expect(start, "the private-details job has no script: of its own").toBeGreaterThan(-1);
  const items = [];
  for (const line of job.slice(start).split("\n").slice(1)) {
    if (/^ {4}- /u.test(line)) items.push(line.slice(6));
    else if (/^ {0,3}\S/u.test(line)) break;
  }
  return items;
}

describe("the private-details job runs only the scanner commit it pins (#1584, D-SEC1)", () => {
  it("names the commit in PRIVATE_DETAILS_COMMIT, equal to the include's ref", () => {
    expect(includeRef, "no commit ref in the include").toBeDefined();
    const vars = jobVariables(jobBlock("private-details"));
    expect(vars.PRIVATE_DETAILS_COMMIT).toBe(includeRef);
  });

  // The repo carries no YAML parser, so this stands in for one: a plain
  // (unquoted, non-block) scalar holding ": " is read as a mapping, and one
  // holding " #" is cut at a comment, and GitLab would reject or mangle the job.
  it("has script items that are strings: no plain scalar holds ': ' or ' #'", () => {
    const items = scriptItemLines(jobBlock("private-details"));
    expect(items.length).toBeGreaterThan(0);
    for (const item of items) {
      if (/^["'|>]/u.test(item)) continue;
      expect(item, `plain scalar read as a mapping: ${item}`).not.toContain(": ");
      expect(item, `plain scalar cut at a comment: ${item}`).not.toContain(" #");
    }
  });

  it("clones, then compares the clone's HEAD with PRIVATE_DETAILS_COMMIT, then runs scan.sh history", () => {
    const script = jobScript(jobBlock("private-details"));
    const clone = script.search(/git clone\b/u);
    const compare = script.search(/rev-parse HEAD[^\n]*|[^\n]*rev-parse HEAD/u);
    const check = script.indexOf("$PRIVATE_DETAILS_COMMIT");
    const scan = script.search(/scan\.sh" history/u);
    expect(clone, "no git clone").toBeGreaterThan(-1);
    expect(compare, "no rev-parse HEAD").toBeGreaterThan(clone);
    expect(check, "no comparison against $PRIVATE_DETAILS_COMMIT").toBeGreaterThan(-1);
    expect(script).toMatch(/\$\{?PRIVATE_DETAILS_COMMIT\}?/u);
    expect(scan, 'no scan.sh" history').toBeGreaterThan(compare);
    expect(scan).toBeGreaterThan(check);
    // The scanner is called once, and only after the check.
    expect(script.match(/scan\.sh/gu)).toHaveLength(1);
  });

  it("keeps the scan itself: the rules path and a full-depth clone", () => {
    const job = jobBlock("private-details");
    const vars = jobVariables(job);
    // The template sets these; restating them is fine, overriding them is not.
    const inherited = { GIT_DEPTH: "0", PRIVATE_DETAILS_RULES: "/etc/private-details/rules.toml" };
    for (const [name, value] of Object.entries(inherited)) {
      if (name in vars) expect(vars[name], `${name} overridden`).toBe(value);
    }
    // The template's tag is inherited, never set here; the commit check above
    // is what pins it.
    expect(vars).not.toHaveProperty("PRIVATE_DETAILS_REF");
  });

  describe("run with a stub git", () => {
    const dirs = [];
    afterEach(() => {
      for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true });
    });

    const OTHER = "0123456789abcdef0123456789abcdef01234567";

    function run(headId) {
      const job = jobBlock("private-details");
      const vars = jobVariables(job);
      const script = jobScript(job);
      const dir = mkdtempSync(join(tmpdir(), "private-details-job-"));
      dirs.push(dir);
      const bin = join(dir, "bin");
      const marker = join(dir, "scan-ran");
      mkdirSync(bin);
      // `git clone ... <dir>` makes <dir>/scripts/private-details/scan.sh,
      // which leaves a marker; `git rev-parse HEAD` prints the chosen id.
      const stub = [
        "#!/bin/sh",
        'for a in "$@"; do last="$a"; done',
        'for a in "$@"; do',
        '  case "$a" in',
        "    clone)",
        '      mkdir -p "$last/scripts/private-details"',
        `      echo 'touch ${marker}' > "$last/scripts/private-details/scan.sh"`,
        "      exit 0 ;;",
        '    rev-parse) echo "$STUB_HEAD"; exit 0 ;;',
        "  esac",
        "done",
        "exit 0",
        "",
      ].join("\n");
      writeFileSync(join(bin, "git"), stub);
      chmodSync(join(bin, "git"), 0o755);
      const result = spawnSync("sh", ["-e", "-c", script], {
        encoding: "utf8",
        env: {
          PATH: `${bin}:/usr/bin:/bin`,
          TMPDIR: dir,
          HOME: dir,
          CI_JOB_TOKEN: "fake-job-token-placeholder",
          PRIVATE_DETAILS_REF: "private-details/v3",
          PRIVATE_DETAILS_RULES: "/etc/private-details/rules.toml",
          ...vars,
          STUB_HEAD: headId,
        },
      });
      return { result, output: `${result.stdout}${result.stderr}`, ran: existsSync(marker), pinned: vars.PRIVATE_DETAILS_COMMIT };
    }

    it("stops before the scanner, naming both ids, when the clone is at another commit", () => {
      const { result, output, ran, pinned } = run(OTHER);
      expect(pinned).toMatch(/^[0-9a-f]{40}$/u);
      expect(result.status).not.toBe(0);
      expect(output).toContain(OTHER);
      expect(output).toContain(pinned);
      expect(ran, "scan.sh ran from an unpinned commit").toBe(false);
    });

    it("runs the scanner when the clone is at the pinned commit", () => {
      const { result, output, ran, pinned } = run(includeRef);
      expect(pinned).toBe(includeRef);
      expect(result.status, output).toBe(0);
      expect(ran, "scan.sh did not run").toBe(true);
    });
  });
});
