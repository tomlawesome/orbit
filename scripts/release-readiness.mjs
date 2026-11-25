#!/usr/bin/env node
// Release readiness (#1860): every check a promotion into `preview` or `main`
// can be judged by before it starts, run in one go, never stopping at the first
// failure, ending with the full list of what to fix.
//
// Usage: node scripts/release-readiness.mjs --target preview|main [--remote <name>]
//
// The `release_readiness` job runs this first on every promotion merge request
// (.gitlab-ci.yml), and every other job there waits for it. Run it locally
// before opening a promotion (docs/releasing.md, "What you do, in short").
//
// runReadiness() takes everything outside the repository folder -- git, the
// registry, the GitLab and GitHub APIs, the environment, the other scripts --
// as `lookups`, so the checks are tested with stubs
// (scripts/release-readiness.test.mjs). `realLookups()` below wires the real
// ones, reusing the scripts that already decide each question rather than
// copying their logic. A lookup may throw: its check then fails with the
// error's message, and every other check still runs.
//
// The release record (owner design ruling on #1860, 2026-11-16): a DCO-style
// sign-off bound to the guide's content. docs/releases/vX.Y.Z.md carries
// `version:`, `guide-blob:` (git blob id of docs/releasing.md), `guide-commit:`
// (for people; not verified), one `step N:` line per numbered step of the
// guide's "What you do, in short", and a `Signed-off-by: <name>` line, a name
// only (the private-details hook refuses an email), that must equal the author
// name and a Signed-off-by trailer of the last commit touching the record. Template: docs/releases/TEMPLATE.md.
//
// No credential's value is ever printed. Every network call and child process
// has a time limit; running out of time fails that check.
import { spawnSync } from "node:child_process";
import { ORBIT_DIGEST_TOKEN_PATTERN } from "./release-metadata-patterns.mjs";
import { existsSync, readFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

import { parseVersion } from "./calculate-version.mjs";

const SCRIPTS_DIR = dirname(fileURLToPath(import.meta.url));

export const PREVIEW_CHECKS = Object.freeze([
  "version",
  "tag-free",
  "changelog",
  "in-app-notes",
  "contains-target",
  "base-image",
  "sidecar-pins",
  "upgrade-matrix",
  "slow-gates-green",
  "release-record",
]);
export const MAIN_CHECKS = Object.freeze([
  "tag-free",
  "changelog",
  "in-app-notes",
  "release-record",
  "main-tree-equals-preview",
  "ghcr-image",
  "evidence-window",
]);

/** The jobs that must be green on a dev pipeline with the source branch's tree. */
export const SLOW_GATES = Object.freeze(["screens_chromium", "smoke", "fast"]);
// Time limits (#1860 review): a hung registry, API or script fails its check.
export const SCRIPT_TIMEOUT_MS = 10 * 60 * 1000;
export const GIT_TIMEOUT_MS = 2 * 60 * 1000;
export const FETCH_TIMEOUT_MS = 30 * 1000;
export const MAX_JSON_BYTES = 8 * 1024 * 1024;
// The GitHub mirror whose owner holds GHCR's image and the handoff repository.
export const GITHUB_REPOSITORY = "tomlawesome/orbit";
export const EVIDENCE_WINDOW_DAYS = 7;
export const GUIDE_PATH = "docs/releasing.md";
export const RECORD_DIR = "docs/releases";
export const GUIDE_CHANGED = "guide changed; re-read docs/releasing.md and regenerate the record";

const STEP_STATUSES = new Set(["done", "not-needed", "after-merge"]);

const errorText = (error) => (error instanceof Error ? error.message : String(error));

// --- checks -----------------------------------------------------------------

function readRepoFile(repoDir, path) {
  const full = join(repoDir, path);
  return existsSync(full) ? readFileSync(full, "utf8") : null;
}

/** The release-notes.mjs verdict on the version's section, plus the heading's date and Unreleased. */
function checkChangelog(repoDir, version) {
  const bare = version.replace(/^v/u, "");
  const path = join(repoDir, "CHANGELOG.md");
  const problems = [];
  const notes = spawnSync(process.execPath, [join(SCRIPTS_DIR, "release-notes.mjs"), version, "--changelog", path], {
    encoding: "utf8",
    timeout: GIT_TIMEOUT_MS,
  });
  if (notes.error) throw new Error(`scripts/release-notes.mjs did not finish: ${notes.error.message}`);
  if (notes.status !== 0) {
    const said = (notes.stderr || "").trim().replace(/^release-notes: /u, "");
    problems.push(`${said || "scripts/release-notes.mjs refused"}: rename "## Unreleased" to "## [${bare}] - YYYY-MM-DD" on dev and fill it`);
  }
  const text = readRepoFile(repoDir, "CHANGELOG.md") ?? "";
  const lines = text.split(/\r?\n/u);
  const heading = lines.find((line) => line.startsWith(`## [${bare}]`));
  if (heading && !new RegExp(`^## \\[${bare.replaceAll(".", "\\.")}\\] - \\d{4}-\\d{2}-\\d{2}\\s*$`, "u").test(heading)) {
    problems.push(`the heading "${heading.trim()}" is not "## [${bare}] - YYYY-MM-DD"`);
  }
  lines.forEach((line, index) => {
    if (!/^## \[?unreleased\]?\s*$/iu.test(line)) return;
    let end = lines.findIndex((other, at) => at > index && other.startsWith("## "));
    if (end === -1) end = lines.length;
    if (lines.slice(index + 1, end).some((other) => other.trim() !== "")) {
      problems.push(`"${line.trim()}" still holds entries: move them into the ${bare} section (or out of this release) on dev`);
    }
  });
  return problems.length === 0
    ? { ok: true, message: `CHANGELOG.md has a filled ## [${bare}] section and no unreleased entries` }
    : { ok: false, message: `CHANGELOG.md: ${problems.join("; ")}` };
}

function checkInAppNotes(repoDir, version) {
  const file = `src/release-notes/${version}.ts`;
  const fix = `write ${file} and register it in src/release-notes/index.ts (import its notes and add them to releaseNotes) on dev`;
  if (readRepoFile(repoDir, file) === null) return { ok: false, message: `${file} is missing: ${fix}` };
  const index = readRepoFile(repoDir, "src/release-notes/index.ts");
  if (index === null) return { ok: false, message: `src/release-notes/index.ts is missing: ${fix}` };
  const escaped = version.replaceAll(".", "\\.");
  const imported = new RegExp(
    `import\\s*\\{\\s*notes\\s+as\\s+([A-Za-z_$][\\w$]*)\\s*\\}\\s*from\\s*["']\\./${escaped}(?:\\.(?:ts|js))?["']`,
    "u",
  ).exec(index);
  if (!imported) return { ok: false, message: `src/release-notes/index.ts does not import ./${version}: ${fix}` };
  const list = /export\s+const\s+releaseNotes\b[^=]*=\s*\[([^\]]*)\]/u.exec(index);
  const names = list ? list[1].split(",").map((name) => name.trim()).filter(Boolean) : [];
  if (!names.includes(imported[1])) {
    return { ok: false, message: `src/release-notes/index.ts imports ${imported[1]} but does not list it in releaseNotes: ${fix}` };
  }
  return { ok: true, message: `${file} exists and is listed in releaseNotes` };
}

function checkUpgradeMatrix(state) {
  const problems = [];
  if (String(state.matrix).trim().toLowerCase() === "false") {
    problems.push("ORBIT_UPGRADE_MATRIX is false, so the upgrade cells would SKIP: set it back to true, or make sure an update-relevant change is in the release");
  }
  if (String(state.launcher).trim().toLowerCase() === "false") {
    problems.push("ORBIT_UPGRADE_LAUNCHER is false, so upgrade_cell_launcher would SKIP: set it back to true");
  }
  const updateFrom = Array.isArray(state.updateFrom) ? state.updateFrom : [];
  const newest = Array.isArray(state.newestStable) ? state.newestStable : [];
  if (newest.length === 0 || updateFrom.join() !== newest.join()) {
    problems.push(
      `updateFrom ${JSON.stringify(updateFrom)} is not the newest stable tags ${JSON.stringify(newest)}: fetch every tag (git fetch --tags) and check scripts/retracted-tags.json`,
    );
  }
  return problems.length === 0
    ? { ok: true, message: `upgrade matrix will run, updating from ${updateFrom.join(", ")}` }
    : { ok: false, message: problems.join("; ") };
}

function checkSlowGates(jobs) {
  if (!Array.isArray(jobs)) {
    return {
      ok: false,
      message:
        "no dev pipeline (nightly or merge request) has the same tree as the source branch, so screens_chromium, smoke and fast are unproven for it: run a pipeline on dev with ORBIT_NIGHTLY_BROWSERS=true (or wait for the nightly) on this exact commit, then re-run this check",
    };
  }
  // A parallel job is named "name i/n"; every shard counts.
  const base = (name) => String(name).replace(/ \d+\/\d+$/u, "");
  const problems = [];
  for (const gate of SLOW_GATES) {
    const runs = jobs.filter((job) => base(job.job) === gate);
    if (runs.length === 0) problems.push(`${gate} did not run`);
    else {
      const bad = runs.filter((job) => job.status !== "success");
      if (bad.length > 0) problems.push(`${gate} is ${[...new Set(bad.map((job) => job.status))].join("/")}`);
    }
  }
  for (const job of jobs) {
    if (/^rig_/u.test(base(job.job)) && job.status === "failed") problems.push(`${job.job} failed`);
  }
  return problems.length === 0
    ? { ok: true, message: "screens_chromium, smoke and fast are green on a dev pipeline with this tree" }
    : {
        ok: false,
        message: `the newest dev pipeline with this tree is not green: ${problems.join(", ")}. Fix it on dev and re-run the nightly browser pipeline on the new commit`,
      };
}

function checkReleaseRecord(version, record, guideBlob, guideSteps) {
  const path = `${RECORD_DIR}/${version}.md`;
  if (!record || record.exists !== true) {
    return {
      ok: false,
      message: `${path} is missing: read docs/releasing.md, copy docs/releases/TEMPLATE.md, fill one line per step and commit it with git commit --trailer "Signed-off-by: <your name>"`,
    };
  }
  const problems = [...(Array.isArray(record.problems) ? record.problems : [])];
  if (record.signed !== true) {
    problems.push(
      'it is not signed: its Signed-off-by line (a name, no email) must equal the author name and the Signed-off-by trailer of the last commit touching it (git commit --trailer "Signed-off-by: <your name>")',
    );
  }
  if (record.guideCommit !== guideBlob) problems.push(GUIDE_CHANGED);
  const steps = Array.isArray(record.steps) ? record.steps.map(String) : [];
  const missing = guideSteps.filter((step) => !steps.includes(step));
  const extra = [...new Set(steps.filter((step) => !guideSteps.includes(step)))];
  if (extra.length > 0) problems.push(`it lists step(s) ${extra.join(", ")}, which the guide does not have: one line per guide step, no more`);
  if (missing.length > 0) problems.push(`it leaves out guide step(s) ${missing.join(", ")}`);
  const doubled = guideSteps.filter((step) => steps.filter((other) => other === step).length > 1);
  if (doubled.length > 0) problems.push(`it lists guide step(s) ${doubled.join(", ")} more than once`);
  const order = steps.filter((step) => guideSteps.includes(step));
  if (missing.length === 0 && doubled.length === 0 && order.join() !== guideSteps.join()) {
    problems.push(`its steps are not in the guide's order (${guideSteps.join(", ")})`);
  }
  return problems.length === 0
    ? { ok: true, message: `${path} is signed, names the current docs/releasing.md and covers every step` }
    : { ok: false, message: `${path}: ${problems.join("; ")}` };
}

function checkGhcr(state, version) {
  const problems = [];
  if (state?.shaTag !== true) problems.push("GHCR has no :sha-<preview tip> image: the preview push's publish_channel/handoff did not reach GHCR (#1821); fix the GitHub publish-from-gitlab run first");
  if (state?.previewTag !== true) problems.push("GHCR :preview does not point at :sha-<preview tip>: preview has moved on or the publish did not finish");
  if (state?.handoff !== true) problems.push("the handoff-<preview tip> release is missing from the handoff repository: retry handoff_to_github on the preview push pipeline (#1824)");
  return problems.length === 0
    ? { ok: true, message: `GHCR holds the preview image for ${version} and the handoff release exists` }
    : { ok: false, message: problems.join("; ") };
}

/**
 * Runs every check for `target` ("preview" or "main") and returns
 * `{ ok, target, version, results: [{ id, ok, message }] }`. Never throws for
 * a failing lookup: that check fails, naming the error, and the rest run.
 */
export async function runReadiness({ target, repoDir, lookups }) {
  if (target !== "preview" && target !== "main") throw new Error("target must be preview or main");
  const ids = target === "preview" ? PREVIEW_CHECKS : MAIN_CHECKS;

  let version = null;
  let versionError = null;
  try {
    version = String(await lookups.version()).trim();
    if (!parseVersion(version)) {
      versionError = `the computed version "${version}" is not vX.Y.Z`;
      version = null;
    }
  } catch (error) {
    versionError = errorText(error);
  }
  const needVersion = () => {
    if (!version) throw new Error(`cannot check without a version (${versionError}); fix the "version" check first`);
    return version;
  };

  const checks = {
    version: async () => {
      if (!version) {
        return {
          ok: false,
          message: `scripts/calculate-version.mjs --channel preview gave no valid version: ${versionError}. Fix scripts/release-line.json or fetch the tags`,
        };
      }
      return { ok: true, message: `the release is ${version}` };
    },
    "tag-free": async () => {
      const tag = needVersion();
      return (await lookups.tagExists(tag))
        ? { ok: false, message: `the GitLab tag ${tag} already exists: this version has shipped. Fetch the tags (git fetch --tags) and recompute` }
        : { ok: true, message: `the tag ${tag} is free` };
    },
    changelog: async () => checkChangelog(repoDir, needVersion()),
    "in-app-notes": async () => checkInAppNotes(repoDir, needVersion()),
    "contains-target": async () =>
      (await lookups.containsTarget())
        ? { ok: true, message: "the source branch contains the target branch" }
        : {
            ok: false,
            message: "the source branch does not contain the target branch, so the semi-linear merge would be refused: merge preview into dev first (the preview -> dev back-merge), then promote from the new dev tip",
          },
    "base-image": async () =>
      (await lookups.baseImageCurrent())
        ? { ok: true, message: "the base image pin is current" }
        : {
            ok: false,
            message: "the base image pin is not current (scripts/check-base-image-current.sh): re-pin the Dockerfile's FROM on dev, or rebuild orbit-base-image, then re-run",
          },
    "sidecar-pins": async () =>
      (await lookups.sidecarPinsCurrent())
        ? { ok: true, message: "the sidecar pins are current" }
        : {
            ok: false,
            message: "the sidecar pins are not current (node scripts/sidecar-pins.mjs check --packages): run node scripts/sidecar-pins.mjs sync on dev and merge the re-pin",
          },
    "upgrade-matrix": async () => checkUpgradeMatrix((await lookups.upgradeMatrix()) ?? {}),
    "slow-gates-green": async () => checkSlowGates(await lookups.slowGates()),
    "release-record": async () => {
      const tag = needVersion();
      const [record, guideBlob, guideSteps] = await Promise.all([
        lookups.releaseRecord(tag),
        lookups.guideCommit(),
        lookups.guideSteps(),
      ]);
      return checkReleaseRecord(tag, record, guideBlob, (guideSteps ?? []).map(String));
    },
    "main-tree-equals-preview": async () =>
      (await lookups.mainTreeEqualsPreview())
        ? { ok: true, message: "main is contained in preview and the merge result's files equal the preview tip's" }
        : {
            ok: false,
            message: "the merge into main would not have the tested preview tip's files: merge main into preview first (the main -> preview back-merge) and let preview's pipeline publish again",
          },
    "ghcr-image": async () => checkGhcr(await lookups.ghcrImage(), needVersion()),
    "evidence-window": async () => {
      const age = Number(await lookups.evidenceAgeDays());
      if (!Number.isFinite(age)) throw new Error("the evidence age could not be read");
      return age <= EVIDENCE_WINDOW_DAYS
        ? { ok: true, message: `the preview tip's validation evidence is ${age.toFixed(1)} days old` }
        : {
            ok: false,
            message: `the preview tip's validation evidence is ${age.toFixed(1)} days old, past the ${EVIDENCE_WINDOW_DAYS}-day window: re-run the preview push pipeline to re-validate before promoting`,
          };
    },
  };

  const results = [];
  for (const id of ids) {
    try {
      const { ok, message } = await checks[id]();
      results.push({ id, ok: ok === true, message: String(message) });
    } catch (error) {
      results.push({ id, ok: false, message: `could not check: ${errorText(error) || "unknown error"}` });
    }
  }
  return { ok: results.every((result) => result.ok), target, version, results };
}

// --- the release record and the guide ----------------------------------------

/** The guide's numbered steps under "## What you do, in short", as "1", "2", ... */
export function parseGuideSteps(guide) {
  const lines = guide.split(/\r?\n/u);
  const start = lines.findIndex((line) => /^## What you do, in short\s*$/u.test(line));
  if (start === -1) throw new Error(`${GUIDE_PATH} has no "## What you do, in short" section`);
  const steps = [];
  for (const line of lines.slice(start + 1)) {
    if (line.startsWith("## ")) break;
    const match = /^(\d+)\. \S/u.exec(line);
    if (match) steps.push(match[1]);
  }
  if (steps.length === 0) throw new Error(`${GUIDE_PATH} lists no numbered steps under "What you do, in short"`);
  return steps;
}

const PLACEHOLDER = /^(?:|<[^>]*>|todo|tbd|tbc|\.\.\.|…|-|n\/a|none|x+)$/iu;

/**
 * Parses a record's text. `steps` holds only well-formed step lines; a step
 * with an unknown status or empty or placeholder evidence is in `problems`
 * instead, so it also counts as left out.
 */
export function parseReleaseRecord(text) {
  const problems = [];
  const field = (name) => {
    const match = new RegExp(`^${name}:[ \\t]*(.*?)[ \\t]*$`, "mu").exec(text);
    return match ? match[1] : null;
  };
  const steps = [];
  for (const line of text.split(/\r?\n/u)) {
    const match = /^\s*(?:[-*]\s+)?step\s+(\d+)\s*:\s*(.*?)\s*$/iu.exec(line);
    if (!match) continue;
    const [, id, rest] = match;
    const status = /^([a-z-]+)\s*(?::\s*(.*))?$/u.exec(rest);
    if (!status || !STEP_STATUSES.has(status[1])) {
      problems.push(`step ${id} says "${rest}": it must be "done: <evidence>", "not-needed: <owner decision>" or "after-merge"`);
      continue;
    }
    const evidence = (status[2] ?? "").trim();
    if (status[1] !== "after-merge" && PLACEHOLDER.test(evidence)) {
      problems.push(`step ${id} is ${status[1]} with no real ${status[1] === "done" ? "evidence (a link or job id)" : "owner decision"}`);
      continue;
    }
    steps.push(id);
  }
  const signoffs = [...text.matchAll(/^Signed-off-by:[ \t]*(.+?)[ \t]*$/gmu)].map((match) => match[1]);
  return {
    version: field("version"),
    guideBlob: field("guide-blob"),
    guideCommitId: field("guide-commit"),
    steps,
    signoffs,
    problems,
  };
}

// --- real lookups --------------------------------------------------------------

/** spawnSync with a time limit; a process that runs out of time throws, naming the limit. */
export function runWithLimit(command, args, options = {}) {
  const timeout = options.timeout ?? SCRIPT_TIMEOUT_MS;
  const result = spawnSync(command, args, { encoding: "utf8", maxBuffer: 64 * 1024 * 1024, ...options, timeout });
  if (result.error?.code === "ETIMEDOUT" || (result.signal === "SIGTERM" && result.status === null)) {
    throw new Error(`${command === process.execPath ? "node" : command} ${args.map(String).find((a) => !a.startsWith("-")) ?? ""} did not finish within ${Math.round(timeout / 1000)}s`);
  }
  return result;
}

/** Environment names a child script may see; everything else (tokens included) stays out. */
const CHILD_ENV_NAMES = ["PATH", "HOME", "USER", "LANG", "LC_ALL", "LC_CTYPE", "TZ", "TMPDIR", "XDG_RUNTIME_DIR", "DOCKER_CONFIG", "DOCKER_HOST", "SSL_CERT_FILE", "SSL_CERT_DIR", "NODE_EXTRA_CA_CERTS", "HTTP_PROXY", "HTTPS_PROXY", "NO_PROXY", "http_proxy", "https_proxy", "no_proxy", "BASE_REPIN_TARGET_BRANCH", "ORBIT_BASE_IMAGE_DEV_REMOTE", "ORBIT_MAX_EVIDENCE_AGE_DAYS", "COSIGN_PUBLIC_KEY", "ORBIT_COSIGN", "ORBIT_POLICY_VERSION", "SSH_AUTH_SOCK", "GIT_SSH_COMMAND"];

/** The most git config pairs passed through; the pipeline sets one (safe.directory). */
const MAX_GIT_CONFIG_PAIRS = 16;

/**
 * The git config the pipeline sets through the environment (`GIT_CONFIG_COUNT`
 * with `GIT_CONFIG_KEY_<n>`/`GIT_CONFIG_VALUE_<n>`; .gitlab-ci.yml trusts the
 * checkout with it). A child that runs git needs it, or git refuses a
 * checkout an earlier job left owned by another user (#1951). A COUNT that is
 * not a small non-negative integer passes nothing.
 */
function gitConfigEnv() {
  const count = process.env.GIT_CONFIG_COUNT;
  if (count === undefined || !/^(?:0|[1-9]\d?)$/u.test(count) || Number(count) > MAX_GIT_CONFIG_PAIRS) return {};
  const env = { GIT_CONFIG_COUNT: count };
  for (let n = 0; n < Number(count); n += 1) {
    for (const name of [`GIT_CONFIG_KEY_${n}`, `GIT_CONFIG_VALUE_${n}`]) {
      if (process.env[name] !== undefined) env[name] = process.env[name];
    }
  }
  return env;
}

/** The allowlisted environment for a child script, plus any values the lookup sets itself. */
export function scriptEnv(extra = {}) {
  const env = gitConfigEnv();
  for (const name of CHILD_ENV_NAMES) if (process.env[name] !== undefined) env[name] = process.env[name];
  return { ...env, ...extra };
}

function git(repoDir, args) {
  const result = runWithLimit("git", args, { cwd: repoDir, timeout: GIT_TIMEOUT_MS });
  if (result.status !== 0) {
    const said = (result.stderr || "").split("\n").map((line) => line.trim()).filter(Boolean);
    throw new Error(`git ${args[0]} failed: ${said.find((line) => /^(?:fatal|error):/u.test(line)) ?? said.at(-1) ?? `exit ${result.status}`}`);
  }
  return result.stdout.trim();
}

const gitSucceeds = (repoDir, args) => runWithLimit("git", args, { cwd: repoDir, timeout: GIT_TIMEOUT_MS }).status === 0;

function pickRemote(repoDir, requested) {
  if (requested) return requested;
  const remotes = git(repoDir, ["remote"]).split("\n").filter(Boolean);
  if (remotes.includes("origin")) return "origin";
  if (remotes.length === 1) return remotes[0];
  if (remotes.includes("gitlab")) return "gitlab";
  throw new Error("cannot tell which git remote is GitLab: pass --remote <name>");
}

function scriptTail(result) {
  return `${result.stdout ?? ""}\n${result.stderr ?? ""}`.trim().split("\n").filter(Boolean).slice(-3).join(" | ");
}

/**
 * GET a JSON body with a time limit that runs until the body is read and a size
 * cap counted as bytes arrive. `what` names the call in errors; the URL's query
 * and the headers are never in them.
 */
export async function fetchJson(url, headers, what, { timeoutMs = FETCH_TIMEOUT_MS, maxBytes = MAX_JSON_BYTES } = {}) {
  const signal = AbortSignal.timeout(timeoutMs);
  const timedOut = () => new Error(`${what} did not answer within ${timeoutMs / 1000}s`);
  const tooBig = () => new Error(`${what} sent more than the ${maxBytes}-byte cap`);
  // A stub or a stalled socket may ignore the signal, so every wait also races it.
  const limited = (promise) =>
    new Promise((resolve, reject) => {
      if (signal.aborted) return reject(timedOut());
      const onAbort = () => reject(timedOut());
      signal.addEventListener("abort", onAbort, { once: true });
      promise.then(resolve, reject).finally(() => signal.removeEventListener("abort", onAbort));
    });
  const notJson = () => new Error(`${what} sent a body that is not JSON`);
  const isTimeout = (error) => error?.name === "TimeoutError" || error?.name === "AbortError";
  let response;
  try {
    response = await limited(fetch(url, { headers, signal }));
  } catch (error) {
    if (isTimeout(error) || signal.aborted) throw timedOut();
    throw new Error(`${what} could not be reached: ${errorText(error)}`);
  }
  if (!response.ok) throw new Error(`${what} answered ${response.status}`);
  const declared = Number(response.headers?.get?.("content-length"));
  if (declared > maxBytes) throw new Error(`${what} sent ${declared} bytes, over the ${maxBytes}-byte cap`);
  if (!response.body || typeof response.body.getReader !== "function") {
    // No body stream (a stub that only parses): check the size after parsing.
    let body;
    try {
      body = await limited(response.json());
    } catch (error) {
      if (error instanceof SyntaxError) throw notJson();
      if (isTimeout(error) || signal.aborted || error?.message === timedOut().message) throw timedOut();
      throw new Error(`${what} could not be read: ${errorText(error)}`);
    }
    if (Buffer.byteLength(JSON.stringify(body) ?? "") > maxBytes) throw tooBig();
    return body;
  }
  const reader = response.body.getReader();
  const chunks = [];
  let total = 0;
  try {
    for (;;) {
      const { done, value } = await limited(reader.read());
      if (done) break;
      total += value.byteLength;
      if (total > maxBytes) {
        reader.cancel().catch(() => {});
        throw tooBig();
      }
      chunks.push(value);
    }
  } catch (error) {
    if (error?.message === tooBig().message) throw error;
    reader.cancel().catch(() => {});
    if (isTimeout(error) || signal.aborted || error?.message === timedOut().message) throw timedOut();
    throw new Error(`${what} could not be read: ${errorText(error)}`);
  }
  try {
    return JSON.parse(Buffer.concat(chunks).toString("utf8"));
  } catch {
    throw notJson();
  }
}

/** The handoff repository's name, from the publish workflow (a non-secret source; #1824). */
export function handoffRepository(repoDir) {
  const workflow = readFileSync(join(repoDir, ".github", "workflows", "publish-from-gitlab.yml"), "utf8");
  const match = /GITHUB_HANDOFF_REPO:\s*\$\{\{\s*github\.repository_owner\s*\}\}\/([A-Za-z0-9._-]+)/u.exec(workflow);
  if (!match) throw new Error(".github/workflows/publish-from-gitlab.yml no longer names the handoff repository");
  return `${GITHUB_REPOSITORY.split("/")[0]}/${match[1]}`;
}

/** The GitLab API base, project and credential header, from CI or the environment. Never printed. */
function gitlabApi(repoDir, remote) {
  let base = process.env.CI_API_V4_URL;
  let project = process.env.CI_PROJECT_ID;
  if (!base || !project) {
    const url = git(repoDir, ["remote", "get-url", remote]);
    const match = /^(?:https?:\/\/(?:[^@/]+@)?([^/]+)\/|git@([^:]+):)(.+?)(?:\.git)?$/u.exec(url);
    if (!match) throw new Error(`cannot read the GitLab host from remote ${remote}`);
    base ||= `https://${match[1] ?? match[2]}/api/v4`;
    project ||= encodeURIComponent(match[3]);
  }
  // ORBIT_REUSE_TOKEN alone in CI, as the reuse lookup reads it (#898; owner
  // 50a on #1860: the job declares `ci-read-tokens`); a read_api GITLAB_TOKEN
  // for a local run. Never the job token, never printed.
  const token = process.env.ORBIT_REUSE_TOKEN || process.env.GITLAB_TOKEN;
  if (!token) throw new Error("no GitLab credential to read pipelines with (ORBIT_REUSE_TOKEN in CI; GITLAB_TOKEN with read_api locally)");
  const get = async (path) =>
    fetchJson(`${base.replace(/\/+$/u, "")}/projects/${project}${path}`, { "PRIVATE-TOKEN": token }, `GitLab API ${path.split("?")[0]}`);
  return { get };
}

async function newestSameTreeDevPipelineJobs({ repoDir, remote, sourceSha }) {
  const api = gitlabApi(repoDir, remote);
  const [onDev, onMergeRequests] = await Promise.all([
    api.get("/pipelines?ref=dev&order_by=id&sort=desc&per_page=40"),
    api.get("/pipelines?source=merge_request_event&order_by=id&sort=desc&per_page=40"),
  ]);
  const candidates = [...onDev, ...onMergeRequests].sort((a, b) => b.id - a.id);
  const targets = new Map();
  for (const pipeline of candidates) {
    const mr = /^refs\/merge-requests\/(\d+)\//u.exec(pipeline.ref ?? "");
    if (mr) {
      if (!targets.has(mr[1])) targets.set(mr[1], (await api.get(`/merge_requests/${mr[1]}`)).target_branch);
      if (targets.get(mr[1]) !== "dev") continue;
    } else if (pipeline.ref !== "dev") continue;
    const compare = await api.get(
      `/repository/compare?from=${pipeline.sha}&to=${sourceSha}&straight=true`,
    );
    if ((compare.diffs ?? []).length > 0) continue;
    const jobs = [];
    for (let page = 1; page <= 10; page += 1) {
      const batch = await api.get(`/pipelines/${pipeline.id}/jobs?per_page=100&page=${page}`);
      jobs.push(...batch);
      if (batch.length < 100) break;
    }
    const named = jobs.map((job) => ({ job: job.name, status: job.status }));
    // A same-tree pipeline that never ran the slow gates (an ordinary merge
    // request into dev) is no evidence either way: look further back.
    if (!SLOW_GATES.every((gate) => named.some((job) => job.job.replace(/ \d+\/\d+$/u, "") === gate))) continue;
    process.stderr.write(`slow gates: read pipeline ${pipeline.id} (${pipeline.web_url ?? pipeline.sha})\n`);
    return named;
  }
  return null;
}

function resolveDigest(reference) {
  const result = runWithLimit("docker", ["buildx", "imagetools", "inspect", reference], { timeout: 2 * 60 * 1000 });
  if (result.error) throw new Error("docker buildx is not available to read GHCR");
  const match = new RegExp(`^Digest:\\s+(${ORBIT_DIGEST_TOKEN_PATTERN.source})\\s*$`, "mu").exec(result.stdout ?? "");
  return match ? match[1] : null;
}

const daysSince = (iso) => (Date.now() - Date.parse(iso)) / 86_400_000;

/** The lookups the CLI and the job use. */
export function realLookups({ repoDir, target, remote: requestedRemote }) {
  const remote = pickRemote(repoDir, requestedRemote);
  const targetRef = `${remote}/${target}`;
  const sourceSha =
    process.env.CI_MERGE_REQUEST_SOURCE_BRANCH_SHA || process.env.CI_COMMIT_SHA || git(repoDir, ["rev-parse", "HEAD"]);
  const requireTarget = () => {
    if (!gitSucceeds(repoDir, ["rev-parse", "--verify", "--quiet", `${targetRef}^{commit}`])) {
      throw new Error(`${targetRef} is not fetched: run git fetch ${remote} ${target} first`);
    }
  };
  const show = (path) => {
    const result = runWithLimit("git", ["show", `HEAD:${path}`], { cwd: repoDir, timeout: GIT_TIMEOUT_MS });
    return result.status === 0 ? result.stdout : null;
  };
  const stableTags = (tags) => {
    const retracted = new Set(JSON.parse(readFileSync(join(repoDir, "scripts", "retracted-tags.json"), "utf8")).tags);
    return tags
      .filter((tag) => !retracted.has(tag) && parseVersion(tag))
      .sort((a, b) => {
        const [x, y] = [parseVersion(a), parseVersion(b)];
        return y[0] - x[0] || y[1] - x[1] || y[2] - x[2];
      });
  };

  return {
    version: async () => {
      const result = runWithLimit(process.execPath, [join(repoDir, "scripts", "calculate-version.mjs"), "--channel", "preview"], {
        cwd: repoDir,
        env: scriptEnv(),
      });
      if (result.status !== 0) throw new Error(scriptTail(result) || "calculate-version.mjs failed");
      JSON.parse(readFileSync(join(repoDir, "scripts", "release-line.json"), "utf8"));
      return result.stdout.trim();
    },
    tagExists: async (tag) => git(repoDir, ["ls-remote", "--tags", remote, `refs/tags/${tag}`]) !== "",
    containsTarget: async () => {
      requireTarget();
      return gitSucceeds(repoDir, ["merge-base", "--is-ancestor", targetRef, sourceSha]);
    },
    baseImageCurrent: async () => {
      const result = runWithLimit("bash", [join(repoDir, "scripts", "check-base-image-current.sh")], { cwd: repoDir, env: scriptEnv(), stdio: ["ignore", "pipe", "pipe"] });
      if (result.status !== 0) process.stderr.write(`base image: ${scriptTail(result)}\n`);
      return result.status === 0;
    },
    sidecarPinsCurrent: async () => {
      const result = runWithLimit(process.execPath, [join(repoDir, "scripts", "sidecar-pins.mjs"), "check", "--packages"], { cwd: repoDir, env: scriptEnv() });
      if (result.status === 2) throw new Error(`sidecar-pins.mjs could not check every image: ${scriptTail(result)}`);
      if (result.status !== 0) process.stderr.write(`sidecar pins: ${scriptTail(result)}\n`);
      return result.status === 0;
    },
    upgradeMatrix: async () => {
      const computed = runWithLimit(process.execPath, [join(repoDir, "scripts", "ci", "upgrade-versions.mjs")], { cwd: repoDir, env: scriptEnv() });
      if (computed.status !== 0) throw new Error(scriptTail(computed) || "upgrade-versions.mjs failed");
      const value = (name) => new RegExp(`^${name}=(.*)$`, "mu").exec(computed.stdout)?.[1] ?? "";
      // A CI/CD variable set to false switches the cells off whatever the diff says.
      const flag = (name) => (process.env[name] === "false" ? "false" : value(name));
      const lists = runWithLimit(process.execPath, [join(repoDir, "scripts", "ci", "upgrade-versions.mjs"), "--manifest-lists"], { cwd: repoDir, env: scriptEnv() });
      if (lists.status !== 0) throw new Error(scriptTail(lists) || "upgrade-versions.mjs --manifest-lists failed");
      const updateFrom = JSON.parse(/"updateFrom": (\[.*\]),/u.exec(lists.stdout)?.[1] ?? "[]");
      const remoteTags = git(repoDir, ["ls-remote", "--tags", "--refs", remote, "refs/tags/v*"])
        .split("\n")
        .map((line) => line.split("\t")[1]?.replace(/^refs\/tags\//u, ""))
        .filter(Boolean);
      return {
        matrix: flag("ORBIT_UPGRADE_MATRIX"),
        launcher: flag("ORBIT_UPGRADE_LAUNCHER"),
        updateFrom,
        newestStable: stableTags(remoteTags).slice(0, 3),
      };
    },
    slowGates: async () => newestSameTreeDevPipelineJobs({ repoDir, remote, sourceSha }),
    releaseRecord: async (version) => {
      const path = `${RECORD_DIR}/${version}.md`;
      const text = show(path);
      if (text === null) return { exists: false, signed: false, guideCommit: null, steps: [] };
      const record = parseReleaseRecord(text);
      if (record.version !== version) record.problems.push(`its version: line says ${record.version ?? "nothing"}, not ${version}`);
      let signed = false;
      if (record.signoffs.length !== 1) {
        record.problems.push(`it has ${record.signoffs.length} Signed-off-by lines, not one`);
      } else if (/[@<>]/u.test(record.signoffs[0])) {
        record.problems.push("its Signed-off-by line must be a name only, with no email");
      } else {
        const [author, trailers] = git(repoDir, [
          "log", "-1", "--format=%an%x00%(trailers:key=Signed-off-by,valueonly,separator=%x01)", "HEAD", "--", path,
        ]).split("\0");
        const signoff = record.signoffs[0];
        signed = author === signoff && (trailers ?? "").split("\x01").map((t) => t.trim()).includes(signoff);
      }
      return { exists: true, signed, guideCommit: record.guideBlob, steps: record.steps, problems: record.problems };
    },
    // The ruling pins the guide by blob id; the interface calls it guideCommit.
    guideCommit: async () => git(repoDir, ["rev-parse", `HEAD:${GUIDE_PATH}`]),
    guideSteps: async () => {
      const guide = show(GUIDE_PATH);
      if (guide === null) throw new Error(`${GUIDE_PATH} is not in HEAD`);
      return parseGuideSteps(guide);
    },
    // The pre-merge form of stable-promotion-policy.mjs's evidence (which
    // needs the merge to exist already): main is an ancestor of the preview
    // tip, and the merge result's tree is the preview tip's.
    mainTreeEqualsPreview: async () => {
      requireTarget();
      if (!gitSucceeds(repoDir, ["merge-base", "--is-ancestor", targetRef, sourceSha])) return false;
      const merged = git(repoDir, ["merge-tree", "--write-tree", targetRef, sourceSha]).split("\n")[0];
      return merged === git(repoDir, ["rev-parse", `${sourceSha}^{tree}`]);
    },
    ghcrImage: async () => {
      const image = `ghcr.io/${GITHUB_REPOSITORY}`;
      const sha = resolveDigest(`${image}:sha-${sourceSha}`);
      const preview = resolveDigest(`${image}:preview`);
      const repo = handoffRepository(repoDir);
      let handoff = false;
      try {
        const release = await fetchJson(
          `https://api.github.com/repos/${repo}/releases/tags/handoff-${sourceSha}`,
          { Accept: "application/vnd.github+json" },
          `the handoff-${sourceSha} release in ${repo}`,
        );
        handoff = release?.draft === false;
      } catch (error) {
        // A missing release is a 404, which is the answer "no"; anything else is not an answer.
        if (!/answered 404$/u.test(errorText(error))) throw error;
      }
      return { shaTag: Boolean(sha), previewTag: Boolean(sha) && preview === sha, handoff };
    },
    evidenceAgeDays: async () => {
      const digest = resolveDigest(`ghcr.io/${GITHUB_REPOSITORY}:sha-${sourceSha}`);
      if (!digest) throw new Error(`GHCR has no :sha-${sourceSha} image to read evidence for`);
      const result = runWithLimit("bash", [join(repoDir, "scripts", "ci", "verify-validation-evidence.sh")], {
        cwd: repoDir,
        env: scriptEnv({ ORBIT_IMAGE: `ghcr.io/${GITHUB_REPOSITORY}`, ORBIT_DIGEST: digest, ORBIT_COMMIT: sourceSha, ORBIT_REF: "preview" }),
      });
      const recorded = /recorded(?: at)? (\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}Z)/u.exec(`${result.stdout}\n${result.stderr}`);
      if ((result.status === 0 || result.status === 13) && recorded) return daysSince(recorded[1]);
      throw new Error(`verify-validation-evidence.sh exited ${result.status}: ${scriptTail(result)}`);
    },
  };
}

// --- CLI ----------------------------------------------------------------------

export function parseCliArguments(argv) {
  const options = {};
  for (let index = 0; index < argv.length; index += 1) {
    const flag = argv[index];
    if (flag !== "--target" && flag !== "--remote") throw new Error(`unknown option ${flag}`);
    const value = argv[index + 1];
    if (!value || value.startsWith("--")) throw new Error(`${flag} needs a value`);
    options[flag.slice(2)] = value;
    index += 1;
  }
  if (options.target !== "preview" && options.target !== "main") {
    throw new Error("usage: node scripts/release-readiness.mjs --target preview|main [--remote <name>]");
  }
  return options;
}

export function renderReport(report) {
  const lines = [`Release readiness for a promotion into ${report.target}${report.version ? ` (${report.version})` : ""}:`];
  for (const result of report.results) lines.push(`  ${result.ok ? "ok  " : "FAIL"} ${result.id}: ${result.message}`);
  const failed = report.results.filter((result) => !result.ok);
  lines.push(
    failed.length === 0
      ? "Ready: every check passed."
      : `Not ready: ${failed.length} of ${report.results.length} checks failed (${failed.map((result) => result.id).join(", ")}). Fix each and run again; do not open the promotion until this passes.`,
  );
  return `${lines.join("\n")}\n`;
}

async function runCli() {
  const options = parseCliArguments(process.argv.slice(2));
  const repoDir = resolve(SCRIPTS_DIR, "..");
  const lookups = realLookups({ repoDir, target: options.target, remote: options.remote });
  const report = await runReadiness({ target: options.target, repoDir, lookups });
  process.stdout.write(renderReport(report));
  process.exitCode = report.ok ? 0 : 1;
}

if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) {
  runCli().catch((error) => {
    process.stderr.write(`release-readiness: ${errorText(error)}\n`);
    process.exitCode = 2;
  });
}
