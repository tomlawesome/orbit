#!/usr/bin/env node
/*
 * What each candidate job reads, and one hash per job over exactly that (#898).
 *
 * A pipeline that reruns a job which passed on the same inputs is spending a
 * runner slot to learn nothing. `classify` hashes the HEAD tree once, filtered
 * by each job's declared globs in job-inputs.json, and a later job whose hash
 * matches an earlier successful run of the same job stands on that run.
 *
 * The hash is over `path<TAB>blob-sha` lines from `git ls-tree -r HEAD`, sorted
 * by path -- the tree, never the working directory, so an artefact an earlier
 * job left behind cannot change the answer. Blob shas rather than file contents
 * because Git has already hashed every file, and a rename or a mode-only change
 * still moves the line it sits on.
 *
 * Exported rather than inlined into the job so the matching and the hashing can
 * be tested against a fixture tree listing, with no repository and no network.
 *
 * CLI:
 *   node scripts/ci/job-inputs.mjs hashes [--tree FILE] [--config FILE]
 *       ORBIT_INPUTS_<JOB>=<hash>, one line per job, for the reuse env file.
 *   node scripts/ci/job-inputs.mjs paths <job> [--tree FILE] [--config FILE]
 *       the paths that job's globs select, one per line -- for checking a
 *       declaration by eye.
 */
import { execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";

export const JOB_INPUTS_PATH = new URL("./job-inputs.json", import.meta.url);

/* The prefix `classify` writes and every job's gate reads back. */
export const INPUTS_PREFIX = "ORBIT_INPUTS_";
export const REUSE_PREFIX = "ORBIT_REUSE_";

/*
 * A job name as an environment-variable suffix: `build_image` ->
 * `BUILD_IMAGE`. Anything that is not a letter or a digit becomes `_`, so a
 * job name a dotenv key could not carry cannot silently produce an invalid
 * line.
 */
export function variableSuffix(job) {
  return String(job).toUpperCase().replaceAll(/[^A-Z0-9]/gu, "_");
}

export function inputsVariable(job) {
  return `${INPUTS_PREFIX}${variableSuffix(job)}`;
}

export function readConfig(source = JOB_INPUTS_PATH) {
  return JSON.parse(readFileSync(source, "utf8"));
}

export function jobNames(config) {
  return Object.keys(config.jobs ?? {}).sort();
}

function escapeSegment(segment) {
  return segment.replaceAll(/[.+^${}()|[\]\\]/gu, "\\$&")
    .replaceAll("*", "[^/]*")
    .replaceAll("?", "[^/]");
}

/*
 * One glob, as an anchored regular expression over a repository-relative path.
 *
 * Segment by segment rather than character by character, because `**` is about
 * path segments and nothing else: `scripts/**\/*.test.mjs` has to match
 * `scripts/a.test.mjs` as well as `scripts/ci/a.test.mjs`, which a naive
 * `**` -> `.*` gets wrong in the first case.
 */
export function globToRegExp(glob) {
  const segments = String(glob).split("/");
  let pattern = "^";
  segments.forEach((segment, index) => {
    const last = index === segments.length - 1;
    if (segment === "**") {
      pattern += last ? "(?:[^/]+/)*[^/]+" : "(?:[^/]+/)*";
      return;
    }
    pattern += escapeSegment(segment);
    if (!last) pattern += "/";
  });
  return new RegExp(`${pattern}$`, "u");
}

export function matchesGlob(glob, path) {
  return globToRegExp(glob).test(path);
}

/*
 * A job's declaration, flattened: `common` first, then the job's own entries
 * with any `@group` expanded in place. Order is kept, because a later `!entry`
 * removes what an earlier entry matched.
 */
export function resolveGlobs(config, job) {
  const declared = config.jobs?.[job];
  if (!declared) throw new Error(`job-inputs.json declares no job named ${job}`);
  const resolved = [];
  for (const entry of [...(config.common ?? []), ...declared]) {
    if (!entry.startsWith("@")) {
      resolved.push(entry);
      continue;
    }
    const group = config.groups?.[entry.slice(1)];
    if (!group) throw new Error(`job-inputs.json names no group ${entry}`);
    resolved.push(...group);
  }
  return resolved;
}

/*
 * Whether a path is one of the job's inputs. Every entry is considered in
 * order, so `scripts/**` followed by `!scripts/**\/*.test.mjs` includes the
 * scripts and then takes the test files back out.
 */
export function selects(globs, path) {
  let selected = false;
  for (const glob of globs) {
    if (glob.startsWith("!")) {
      if (matchesGlob(glob.slice(1), path)) selected = false;
    } else if (matchesGlob(glob, path)) {
      selected = true;
    }
  }
  return selected;
}

/*
 * `git ls-tree -r [-z] HEAD` output as `{ path, sha }` entries.
 *
 * Records are `<mode> <type> <object>\t<path>`, separated by NUL under `-z` and
 * by newline otherwise. `-z` is what the CLI below asks for, because without it
 * Git quotes any path with an unusual byte in it and the quoted form is not the
 * path. Both are accepted so a fixture can be written either way.
 */
export function parseTreeListing(text) {
  return String(text)
    .split(/[\0\n]/u)
    .filter((record) => record.length > 0)
    .map((record) => {
      const tab = record.indexOf("\t");
      if (tab < 0) throw new Error(`unparsable tree record: ${record}`);
      const fields = record.slice(0, tab).split(" ");
      return { type: fields[1], sha: fields[2], path: record.slice(tab + 1) };
    })
    .filter((entry) => entry.type === "blob" || entry.type === "commit");
}

export function readTreeListing({ cwd, ref = "HEAD" } = {}) {
  return parseTreeListing(
    execFileSync("git", ["ls-tree", "-r", "-z", ref], { cwd, encoding: "utf8", maxBuffer: 64 * 1024 * 1024 }),
  );
}

/*
 * The hash of a set of entries: sha256 over sorted `path<TAB>sha` lines. Sorted
 * by raw code unit rather than by locale, so two runs on two machines agree.
 */
export function hashEntries(entries) {
  const lines = [...entries]
    .sort((left, right) => (left.path < right.path ? -1 : left.path > right.path ? 1 : 0))
    .map((entry) => `${entry.path}\t${entry.sha}\n`);
  return createHash("sha256").update(lines.join(""), "utf8").digest("hex");
}

export function jobInputHash(config, job, entries) {
  const globs = resolveGlobs(config, job);
  return hashEntries(entries.filter((entry) => selects(globs, entry.path)));
}

export function computeJobHashes(config, entries) {
  return new Map(jobNames(config).map((job) => [job, jobInputHash(config, job, entries)]));
}

export function formatVariables(hashes) {
  return [...hashes].map(([job, hash]) => `${inputsVariable(job)}=${hash}`).join("\n");
}

function option(argv, name) {
  const index = argv.indexOf(name);
  return index < 0 ? undefined : argv[index + 1];
}

function main(argv) {
  const command = argv[0];
  const configPath = option(argv, "--config");
  const treePath = option(argv, "--tree");
  const config = readConfig(configPath ?? JOB_INPUTS_PATH);
  const entries = treePath ? parseTreeListing(readFileSync(treePath, "utf8")) : readTreeListing();

  if (command === "hashes") {
    process.stdout.write(`${formatVariables(computeJobHashes(config, entries))}\n`);
    return 0;
  }
  if (command === "paths") {
    const job = argv[1];
    const globs = resolveGlobs(config, job);
    const selected = entries.filter((entry) => selects(globs, entry.path)).map((entry) => entry.path);
    process.stdout.write(`${selected.sort().join("\n")}\n`);
    return 0;
  }
  process.stderr.write("usage: job-inputs.mjs hashes|paths <job> [--tree FILE] [--config FILE]\n");
  return 2;
}

if (process.argv[1] && import.meta.url === new URL(`file://${process.argv[1]}`).href) {
  process.exitCode = main(process.argv.slice(2));
}
