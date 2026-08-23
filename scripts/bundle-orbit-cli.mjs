#!/usr/bin/env node

// Bundles src/cli/orbit.ts into a single, dependency-free CommonJS file at
// dist/cli/orbit.js — the artifact the Dockerfile's `cli-builder` stage
// copies into the published image at /opt/orbit/cli/orbit.js (issue #295,
// engine-delivery slice, owner decision 2026-08-13: the engine ships INSIDE
// the app image, invoked as a disposable `docker compose run --rm --no-deps`
// one-off; see docs/engine-events.md, "In-container engine invocation").
//
// esbuild (devDependency, MIT licensed — see package.json) is invoked as a
// subprocess against its own CLI binary rather than imported as a library:
// esbuild is only ever a *transitive* dependency of tsx/vite/drizzle-kit in
// this workspace's pnpm layout (scripts/esbuild-override-policy.test.mjs
// pins two coexisting resolutions), so `require("esbuild")`/`import
// "esbuild"` cannot be relied on to resolve from an arbitrary script under
// pnpm's strict node_modules; the CLI binary pnpm always links into
// node_modules/.bin has no such ambiguity.
//
// Determinism: a fixed, explicit flag set (no environment-derived defines,
// no source map, no minification), invoked with `cwd` pinned to the repo
// root (spawnSync's `cwd` option — the CLI has no `--abs-working-dir` flag
// of its own, only the JS API does), so the bundle's content depends only
// on the source tree, not on the invoking shell's own cwd or environment.
// Minification is deliberately skipped
// (esbuild's minifier is itself deterministic, but skipping it keeps the
// shipped artifact readable for incident response inside a support session,
// and the CLI is small enough that the size difference is immaterial next
// to the app image's own layers).

import { spawnSync } from "node:child_process";
import { existsSync, mkdirSync } from "node:fs";
import { dirname, resolve } from "node:path";

const projectRoot = resolve(import.meta.dirname, "..");
const entryPoint = resolve(projectRoot, "src/cli/orbit.ts");
const outfile = resolve(projectRoot, "dist/cli/orbit.js");
const esbuildBinary = resolve(projectRoot, "node_modules/.bin/esbuild");

if (!existsSync(esbuildBinary)) {
  process.stderr.write("bundle-orbit-cli: node_modules/.bin/esbuild is missing — run `pnpm install` first.\n");
  process.exit(1);
}

mkdirSync(dirname(outfile), { recursive: true });

// `--external:next` marks the boundary of ADR-0015 decision 3: the CLI
// bundles application domain code (the `end-maintenance` command reaches
// src/server/maintenance.ts) and that code must stay free of any runtime
// framework import. Marking next external does not make a stray import safe
// — it makes it *visible*, surviving as a literal `require("next/...")` in
// the output, which scripts/bundle-orbit-cli.test.mjs fails on. The test,
// not vigilance, is the enforcement.
const args = [
  entryPoint,
  "--bundle",
  "--platform=node",
  "--target=node22",
  "--format=cjs",
  "--legal-comments=none",
  "--external:next",
  "--external:next/*",
  `--outfile=${outfile}`,
];

// stdio is explicitly closed/piped, never "inherit": this script is spawned
// itself from inside test suites (scripts/bundle-orbit-cli.test.mjs) that
// run under vitest's forked worker pool, where "inherit" ties the esbuild
// child's fds directly to that fork's own stdout/stderr pipes back to the
// vitest main process — if anything about that chain doesn't tear down
// cleanly, the fork's own output stream never reaches EOF and the whole
// test file hangs instead of failing (this is what stalled CI). stdin is
// "ignore" outright (esbuild's CLI never reads it for a one-shot --bundle
// invocation, and there is nothing for this script to write); stdout/stderr
// are captured and only re-emitted through this process's own streams
// after the child has fully exited. `timeout`/`killSignal` bound the call
// so a wedged esbuild process fails this script loudly instead of hanging
// the caller (and, transitively, any CI job) indefinitely.
const result = spawnSync(esbuildBinary, args, {
  cwd: projectRoot,
  stdio: ["ignore", "pipe", "pipe"],
  encoding: "utf8",
  timeout: 60_000,
  killSignal: "SIGKILL",
});

if (result.error) {
  process.stderr.write(`bundle-orbit-cli: failed to run esbuild: ${result.error.message}\n`);
  process.exit(1);
}
if (result.signal) {
  process.stderr.write(`bundle-orbit-cli: esbuild was killed by signal ${result.signal} (likely the ${60_000}ms timeout)\n`);
  process.exit(1);
}
if (result.stdout) process.stdout.write(result.stdout);
if (result.stderr) process.stderr.write(result.stderr);
if (result.status !== 0) {
  process.exit(result.status ?? 1);
}

process.stdout.write(`bundle-orbit-cli: wrote ${outfile}\n`);
