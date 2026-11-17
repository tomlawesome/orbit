// Vitest globalSetup (#1861): build the orbit CLI once per run, with the same
// flags the image ships (scripts/bundle-orbit-cli.mjs), into a fresh temporary
// directory -- never dist/ -- and publish the path as `orbitTestCliBundle` for
// the docker shims in the test support (via vitest provide/inject; the per-file
// setup scripts/vitest-cli-bundle-setup.mjs copies it into each file's temp
// root and sets the variable). Built from the current source on every
// run, so a run never uses a stale bundle; a failed build fails the run with
// esbuild's own output.
import { spawnSync } from "node:child_process";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";

const bundler = fileURLToPath(new URL("./bundle-orbit-cli.mjs", import.meta.url));

export default function setup({ provide }) {
  const dir = mkdtempSync(join(tmpdir(), "orbit-test-cli-"));
  const outfile = join(dir, "orbit.js");
  const result = spawnSync(process.execPath, [bundler, outfile], { encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] });
  if (result.status !== 0) {
    rmSync(dir, { recursive: true, force: true });
    throw new Error(`building the test CLI bundle failed (exit ${result.status}):\n${result.stderr}${result.stdout}`);
  }
  provide("orbitTestCliBundle", outfile);
  return () => {
    rmSync(dir, { recursive: true, force: true });
  };
}
