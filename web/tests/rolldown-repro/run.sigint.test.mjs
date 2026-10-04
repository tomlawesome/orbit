import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { existsSync, mkdtempSync, writeFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { fileURLToPath } from "node:url";
import path from "node:path";
import { describe, it } from "node:test";

/*
 * W3-S2 (#1151): run.mjs's own header promises it "always removes the
 * scratch route again -- including on failure/Ctrl-C". That was false: a
 * try/finally only unwinds on a thrown JS exception, never on the whole
 * process being killed by an unhandled SIGINT, which is Ctrl-C's default
 * effect -- the scratch route (src/routes/__rolldown_repro_782__) was left
 * behind in the real project tree.
 *
 * This cannot drive the real `vite build` (three minutes, three times, and
 * this repo's rules bar running it here at all) just to prove a signal
 * handler fires in time, so it substitutes ROLLDOWN_REPRO_BUILD_CMD/
 * ROLLDOWN_REPRO_BUILD_ARGS -- a fake, slow "build" step that run.mjs reads
 * for exactly this test -- and sends the real run.mjs process a real
 * SIGINT while that fake build is in flight.
 *
 * Outside the vitest suite (web/** is excluded there, same as the rest of
 * this directory): run standalone with
 *   node --test web/tests/rolldown-repro/run.sigint.test.mjs
 */

const here = path.dirname(fileURLToPath(import.meta.url));
const runScript = path.join(here, "run.mjs");
const webRoot = path.resolve(here, "..", "..");
const scratchRoute = path.join(webRoot, "src", "routes", "__rolldown_repro_782__");

async function waitUntil(predicate, { timeoutMs = 10_000, intervalMs = 50 } = {}) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (predicate()) return true;
    await new Promise((resolve) => setTimeout(resolve, intervalMs));
  }
  return predicate();
}

describe("run.mjs's Ctrl-C cleanup", () => {
  it("removes the scratch route when interrupted mid-build", async () => {
    // Guard against a stale directory from an earlier, differently-failed
    // run confusing this test's own "it appeared" check below.
    rmSync(scratchRoute, { recursive: true, force: true });

    const fakeBuildDir = mkdtempSync(path.join(tmpdir(), "rolldown-repro-fake-build-"));
    const fakeBuild = path.join(fakeBuildDir, "fake-build.mjs");
    // A "build" slow enough that the real run.mjs is still inside it when
    // this test sends SIGINT below.
    writeFileSync(fakeBuild, "await new Promise((resolve) => setTimeout(resolve, 60_000));\n");

    const child = spawn(process.execPath, [runScript], {
      cwd: here,
      env: {
        ...process.env,
        ROLLDOWN_REPRO_BUILD_CMD: process.execPath,
        ROLLDOWN_REPRO_BUILD_ARGS: fakeBuild,
      },
      stdio: "ignore",
    });

    try {
      const appeared = await waitUntil(() => existsSync(scratchRoute));
      assert.ok(appeared, "the scratch route never appeared -- this is a test-setup problem, not the fix under test");

      child.kill("SIGINT");
      const [exitCode] = await new Promise((resolve) => child.once("exit", (code, signal) => resolve([code, signal])));

      assert.equal(
        existsSync(scratchRoute),
        false,
        "Ctrl-C must not leave the scratch route behind in the real project tree",
      );
      // 130 is the conventional exit code for a process that handled its
      // own SIGINT; confirms the trap ran rather than the process dying by
      // default disposition before cleanUpAndExit got to run.
      assert.equal(exitCode, 130);
    } finally {
      if (!child.killed) child.kill("SIGKILL");
      rmSync(scratchRoute, { recursive: true, force: true });
      rmSync(fakeBuildDir, { recursive: true, force: true });
    }
  });

  it("waits for the build child to actually close before exiting (#1151 RANGE-S8)", async () => {
    rmSync(scratchRoute, { recursive: true, force: true });

    const fakeBuildDir = mkdtempSync(path.join(tmpdir(), "rolldown-repro-fake-build-"));
    const fakeBuild = path.join(fakeBuildDir, "fake-build.mjs");
    const readyMarker = path.join(fakeBuildDir, "ready");
    // Ignores the default SIGTERM disposition and takes 300ms to actually
    // exit after receiving it -- standing in for a build tool slow to shut
    // down, so a run.mjs that exits the instant it SENDS SIGTERM (rather
    // than once the child's own "close" event fires) finishes in well
    // under that 300ms. Writes `readyMarker` as its very first act, so the
    // test below can wait for THIS process to exist rather than for the
    // scratch route, which run.mjs creates a few milliseconds before it
    // actually spawns this child (spawn()'s own fork+exec overhead) --
    // racing on the route alone sent SIGINT before currentChild was set.
    writeFileSync(
      fakeBuild,
      [
        'import { writeFileSync } from "node:fs";',
        `writeFileSync(${JSON.stringify(readyMarker)}, "");`,
        "let closing = false;",
        'process.on("SIGTERM", () => {',
        "  closing = true;",
        "  setTimeout(() => process.exit(0), 300);",
        "});",
        "await new Promise((resolve) => setTimeout(resolve, 60_000));",
      ].join("\n"),
    );

    const child = spawn(process.execPath, [runScript], {
      cwd: here,
      env: {
        ...process.env,
        ROLLDOWN_REPRO_BUILD_CMD: process.execPath,
        ROLLDOWN_REPRO_BUILD_ARGS: fakeBuild,
      },
      stdio: "ignore",
    });

    try {
      const appeared = await waitUntil(() => existsSync(readyMarker));
      assert.ok(appeared, "the fake build child never started -- this is a test-setup problem, not the fix under test");

      const sentAt = Date.now();
      child.kill("SIGINT");
      await new Promise((resolve) => child.once("exit", resolve));
      const elapsedMs = Date.now() - sentAt;

      assert.ok(
        elapsedMs >= 250,
        `run.mjs exited ${elapsedMs}ms after SIGINT -- it must wait for the build child's own close, which here takes 300ms`,
      );
    } finally {
      if (!child.killed) child.kill("SIGKILL");
      rmSync(scratchRoute, { recursive: true, force: true });
      rmSync(fakeBuildDir, { recursive: true, force: true });
    }
  });
});
