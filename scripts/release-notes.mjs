#!/usr/bin/env node
// Prints a version's CHANGELOG.md section as the release body (#1704).
// Usage: release-notes.mjs <version> [--changelog <path>] [--previous <tag> --repo <owner/name>]
import { existsSync, readFileSync } from "node:fs";

const usage = "usage: release-notes.mjs <vX.Y.Z> [--changelog <path>] [--previous <tag> --repo <owner/name>]";
const usageFail = () => {
  process.stderr.write(`${usage}\n`);
  process.exit(2);
};
const refuse = (message) => {
  process.stderr.write(`release-notes: ${message}\n`);
  process.exit(1);
};

const args = process.argv.slice(2);
const opts = { changelog: "CHANGELOG.md" };
let versionArg;
for (let i = 0; i < args.length; i++) {
  const flag = args[i];
  if (flag === "--changelog" || flag === "--previous" || flag === "--repo") {
    if (i + 1 >= args.length) usageFail();
    opts[flag.slice(2)] = args[++i];
  } else if (versionArg === undefined && !flag.startsWith("--")) {
    versionArg = flag;
  } else {
    usageFail();
  }
}
if (versionArg === undefined || !/^v?\d+\.\d+\.\d+$/u.test(versionArg)) usageFail();
if ((opts.previous === undefined) !== (opts.repo === undefined)) usageFail();

const version = versionArg.replace(/^v/u, "");
const path = opts.changelog;
if (!existsSync(path)) refuse(`${path} not found`);

const lines = readFileSync(path, "utf8").split(/\r?\n/u);
const start = lines.findIndex((line) => line.startsWith(`## [${version}] - `));
if (start === -1) refuse(`${path} has no "## [${version}]" section`);
let end = lines.findIndex((line, i) => i > start && line.startsWith("## "));
if (end === -1) end = lines.length;
const section = lines.slice(start + 1, end).join("\n").trim();
if (section === "") refuse(`the "## [${version}]" section in ${path} is empty`);

let out = `${section}\n`;
if (opts.previous !== undefined) {
  out += `\n**Full Changelog**: https://github.com/${opts.repo}/compare/${opts.previous}...v${version}\n`;
}
process.stdout.write(out);
