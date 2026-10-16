#!/usr/bin/env node
// Every @quarantine tag must be on tests/quarantine.txt with its issue.
//
// Tagging a browser test @quarantine takes it out of every merge gate: the
// quarantine run after the gate only reports (agent-infra#30). Without a list,
// one word in a merge request could switch a real check off unnoticed (!1071
// audit, security pass). The list makes each tag a reviewed line. It counts
// tag text, not tests: a tag inside a loop or behind a condition covers
// whatever that admits, and a tag assembled at run time is invisible to a text
// scan, so review the code around each listed tag too. It counts every
// "@quarantine" substring, comments included, because Playwright's filter
// (/@quarantine/ over title and tags) is that wide. scripts/test-frontend.sh
// and web's fidelity scripts run this before the gate.
//
// Usage: node scripts/check-quarantine.mjs [root]   (default: the current directory)
import { existsSync, readdirSync, readFileSync } from "node:fs";
import { join, relative } from "node:path";

const root = process.argv[2] ?? process.cwd();
const LIST = "tests/quarantine.txt";
const SCAN = ["tests/e2e", "web/tests"];
// Playwright's default testMatch: these files run if they sit under testDir.
const SPEC = /\.(spec|test)\.(m|c)?[jt]sx?$/;
const TAG = /@quarantine/g;
const ENTRY = /^(\S+)\s+(\S+)\s+(\S+)/;
const ISSUES = /^#\d+(,#\d+)*$/;

function specFiles(dir) {
  if (!existsSync(dir)) return [];
  return readdirSync(dir, { withFileTypes: true }).flatMap((e) => {
    const path = join(dir, e.name);
    if (e.isDirectory()) return specFiles(path);
    return e.isFile() && SPEC.test(e.name) ? [path] : [];
  });
}

function tagCount(path) {
  return readFileSync(path, "utf8").match(TAG)?.length ?? 0;
}

const problems = [];
const listPath = join(root, LIST);
if (!existsSync(listPath)) {
  console.error(`quarantine list: ${LIST} is missing`);
  process.exit(1);
}

const listed = new Map();
readFileSync(listPath, "utf8").split("\n").forEach((raw, i) => {
  const line = raw.trim();
  if (!line || line.startsWith("#")) return;
  const where = `${LIST}:${i + 1}`;
  const m = ENTRY.exec(line);
  if (!m) return problems.push(`${where}: malformed entry "${line}" (expected <path> <count> <#issue>)`);
  const [, path, count, issues] = m;
  if (!/^[1-9]\d*$/.test(count)) return problems.push(`${where}: ${path}: count "${count}" must be a positive whole number`);
  if (!ISSUES.test(issues)) return problems.push(`${where}: ${path}: needs an issue ref like #123, found "${issues}"`);
  if (listed.has(path)) return problems.push(`${where}: ${path} is listed twice`);
  listed.set(path, Number(count));
});

const actual = new Map();
for (const dir of SCAN) {
  for (const file of specFiles(join(root, dir))) {
    const n = tagCount(file);
    if (n > 0) actual.set(relative(root, file), n);
  }
}

for (const [path, n] of actual) {
  if (!listed.has(path)) problems.push(`${path}: ${n} @quarantine tag(s) not on ${LIST}`);
  else if (listed.get(path) !== n) problems.push(`${path}: ${LIST} lists ${listed.get(path)} @quarantine tag(s), the file has ${n}`);
}
for (const path of listed.keys()) {
  if (actual.has(path)) continue;
  problems.push(existsSync(join(root, path))
    ? `${path}: listed on ${LIST} but has no @quarantine tag (stale entry)`
    : `${path}: listed on ${LIST} but does not exist (stale entry)`);
}

if (problems.length) {
  for (const p of problems) console.error(`quarantine list: ${p}`);
  process.exit(1);
}
const tags = [...actual.values()].reduce((a, b) => a + b, 0);
console.log(`quarantine list: ${tags} tags in ${actual.size} files, all listed`);
