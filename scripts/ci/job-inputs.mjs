#!/usr/bin/env node
/*
 * The reuse key each candidate job is compared on (ADR-0028, #1060 slice 3).
 *
 * A pipeline that reruns a job which passed on the same thing is spending a
 * runner slot to learn nothing. What "the same thing" means is the whole of
 * ADR-0028: a job stands on an earlier pass when the artefact it tests is the
 * same artefact, proven by content, and everything else it reads is unchanged,
 * proven by hashing the whole checkout minus only the paths proven to reach the
 * job through that artefact.
 *
 * Three axes, per ADR-0028 section 1, combined into one key per job:
 *
 *   - Artefact axis. For the six image-running jobs, the image content ID
 *     `build_image` computes (scripts/ci/image-content-id.sh) and hands on in
 *     build.env. A job with no artefact axis leaves it empty.
 *   - Checkout axis. The hash of the whole checkout minus that job's
 *     deny-list in job-inputs.json. The default is everything: only an entry
 *     there can narrow it, and an entry is admissible only for a path the job
 *     reaches through its artefact or not at all.
 *   - Definition axis. `.gitlab-ci.yml` and `scripts/ci/**`, hashed separately
 *     and carried in every key, so a pipeline change or a change to the reuse
 *     scripts invalidates all evidence at once.
 *
 * This replaces #898's allow-list of globs. That version could only be wrong
 * by omission and silently: a file a job read but nobody had declared left the
 * hash still and reused a stale pass. Here omission costs a rerun instead.
 *
 * Two levels of hash rather than one, because the axes are not known at the
 * same moment. `classify` knows the checkout and the definition before
 * anything has been built, so it publishes a *source key* per job; the image
 * content ID exists only after `build_image`, which combines the two into the
 * job's final key. A job with no artefact axis has its final key from
 * `classify` directly. Concatenating hashes rather than their inputs is the
 * only difference from the ADR's "a SHA-256 over their concatenation", and it
 * is what lets the artefact arrive late.
 *
 * The exact serialisation is pinned here and in job-inputs.test.mjs, so two
 * callers cannot disagree about it: newline-terminated fields, in order, with
 * a version marker first. Change the marker whenever the shape changes and
 * every key moves at once, which is the safe direction.
 *
 * The checkout hash is over `path<TAB>blob-sha` lines from `git ls-tree -r
 * HEAD`, sorted by path -- the tree, never the working directory, so an
 * artefact an earlier job left behind cannot change the answer. Blob shas
 * rather than file contents because Git has already hashed every file, and a
 * rename or a mode-only change still moves the line it sits on.
 *
 * CLI:
 *   node scripts/ci/job-inputs.mjs keys [--tree FILE] [--config FILE]
 *       ORBIT_SOURCE_<JOB>=<source key> for every job, and
 *       ORBIT_INPUTS_<JOB>=<key> for the jobs whose key is already final.
 *   node scripts/ci/job-inputs.mjs paths <job> [--tree FILE] [--config FILE]
 *       the paths that job's key covers, one per line -- for checking a
 *       deny-list by eye.
 */
import { execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";

export const JOB_INPUTS_PATH = new URL("./job-inputs.json", import.meta.url);

/*
 * The serialisation marker. Every key carries it, so bumping it retires every
 * piece of evidence in the project at once -- which is what a change to the
 * shape of a key has to do, since an old key and a new one would otherwise be
 * compared as equals.
 */
export const KEY_VERSION = "orbit-reuse-key/2";

/* The prefixes `classify` and `build_image` write and every job's gate reads. */
export const INPUTS_PREFIX = "ORBIT_INPUTS_";
export const SOURCE_PREFIX = "ORBIT_SOURCE_";
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

export function sourceVariable(job) {
  return `${SOURCE_PREFIX}${variableSuffix(job)}`;
}

export function readConfig(source = JOB_INPUTS_PATH) {
  return JSON.parse(readFileSync(source, "utf8"));
}

export function jobNames(config) {
  return Object.keys(config.jobs ?? {}).sort();
}

/* The artefact a job is keyed on, or "" when the source is the thing tested. */
export function artefactOf(config, job) {
  const declared = config.jobs?.[job];
  if (!declared) throw new Error(`job-inputs.json declares no job named ${job}`);
  return declared.artefact ?? "";
}

/* The jobs keyed on a given artefact -- `image` is what build_image looks up. */
export function jobsOnArtefact(config, artefact) {
  return jobNames(config).filter((job) => artefactOf(config, job) === artefact);
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
 * Whether a list selects a path. Every entry is considered in order, so
 * `docs/**` followed by `!docs/installer-guarantees.md` matches the tree and
 * then takes that one file back out.
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

/* A declared list with any `@group` expanded in place; order is preserved. */
export function resolveList(config, entries) {
  const resolved = [];
  for (const entry of entries ?? []) {
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

export function denyGlobs(config, job) {
  const declared = config.jobs?.[job];
  if (!declared) throw new Error(`job-inputs.json declares no job named ${job}`);
  return resolveList(config, declared.deny);
}

/*
 * The one job the ADR keeps on a fixed input list rather than a deny-list:
 * "`sidecar_images` keeps its fixed input list: its inputs are the pins."
 * Everything else takes the whole checkout minus its denials.
 */
export function onlyGlobs(config, job) {
  const declared = config.jobs?.[job];
  if (!declared) throw new Error(`job-inputs.json declares no job named ${job}`);
  return declared.only ? resolveList(config, declared.only) : null;
}

export function definitionGlobs(config) {
  return resolveList(config, config.definition ?? []);
}

/* The checkout axis: everything, minus this job's deny-list. */
export function checkoutEntries(config, job, entries) {
  const only = onlyGlobs(config, job);
  if (only) return entries.filter((entry) => selects(only, entry.path));
  const deny = denyGlobs(config, job);
  return entries.filter((entry) => !selects(deny, entry.path));
}

export function definitionEntries(config, entries) {
  const globs = definitionGlobs(config);
  return entries.filter((entry) => selects(globs, entry.path));
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

function digestOf(fields) {
  return createHash("sha256").update(fields.map((field) => `${field}\n`).join(""), "utf8").digest("hex");
}

/*
 * The checkout and definition axes as one value, which is everything a job's
 * key can be known from before anything is built. The job name is in it so two
 * jobs with identical axes still key differently -- belt and braces beside the
 * lookup, which already matches evidence by job name.
 */
export function sourceKey(job, checkoutHash, definitionHash) {
  return digestOf([KEY_VERSION, "source", job, checkoutHash, definitionHash]);
}

/*
 * The whole key: the artefact axis over the source key. `artefact` is "" for a
 * job that tests the source itself, which still goes through this function so
 * that every key in the project has the same shape.
 */
export function compositeKey(job, source, artefact = "") {
  return digestOf([KEY_VERSION, "key", job, artefact, source]);
}

/*
 * Every job's source key, and the final key for those whose artefact axis is
 * empty. The rest get theirs from `build_image`, which is the first place the
 * content ID exists.
 */
export function computeKeys(config, entries) {
  const definitionHash = hashEntries(definitionEntries(config, entries));
  return new Map(jobNames(config).map((job) => {
    const checkoutHash = hashEntries(checkoutEntries(config, job, entries));
    const source = sourceKey(job, checkoutHash, definitionHash);
    const artefact = artefactOf(config, job);
    return [job, {
      artefact,
      checkout: checkoutHash,
      definition: definitionHash,
      source,
      key: artefact ? null : compositeKey(job, source, ""),
    }];
  }));
}

/*
 * The lines `classify` publishes. A job whose key is not final yet publishes
 * only its source key: an `ORBIT_INPUTS_` line must always mean "this is the
 * key this job is compared on", or a gate would compare against half a key.
 */
export function formatVariables(keys) {
  const lines = [];
  for (const [job, computed] of keys) {
    lines.push(`${sourceVariable(job)}=${computed.source}`);
    if (computed.key) lines.push(`${inputsVariable(job)}=${computed.key}`);
  }
  return lines.join("\n");
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

  if (command === "keys") {
    process.stdout.write(`${formatVariables(computeKeys(config, entries))}\n`);
    return 0;
  }
  if (command === "paths") {
    const job = argv[1];
    const covered = [
      ...checkoutEntries(config, job, entries),
      ...definitionEntries(config, entries),
    ].map((entry) => entry.path);
    process.stdout.write(`${[...new Set(covered)].sort().join("\n")}\n`);
    return 0;
  }
  process.stderr.write("usage: job-inputs.mjs keys|paths <job> [--tree FILE] [--config FILE]\n");
  return 2;
}

if (process.argv[1] && import.meta.url === new URL(`file://${process.argv[1]}`).href) {
  process.exitCode = main(process.argv.slice(2));
}
