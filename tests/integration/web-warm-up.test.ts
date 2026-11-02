/**
 * #1575, #1565 review: the start-up warm-up runs under SvelteKit 3.
 *
 * hooks.server.js's init() reads the server's listen address (PORT, HOST,
 * SOCKET_PATH) and starts the warm-up only when it finds a numeric PORT.
 * SvelteKit 3 hands `$env/dynamic/private` only the names declared in
 * web/src/env.js, so a name not declared there reads as undefined in the built
 * app. The unit tests cannot see that: under vitest `$env/dynamic/private` is
 * aliased to the live process environment (tests/support/env-dynamic-private.ts),
 * which exposes every variable, so a test that sets PORT passes whether or not
 * the real module would have shown it.
 *
 * So this runs the BUILT app, the way the image does, with the listen address
 * in the process environment and nothing else, and looks for what the warm-up
 * does when it finishes: it logs `application.startup state=completed` with a
 * duration (web/src/lib/server/warm-up.js). That line only appears after the
 * task has found the port answering and sent its three requests to it, so
 * its absence means the task never started, or never reached the address the
 * server listens on.
 *
 * Needs the built app (`pnpm --filter orbit-web build`) and the integration
 * database: run through `node scripts/test-integration.mjs
 * tests/integration/web-warm-up.test.ts`.
 */
import { spawn, type ChildProcess } from "node:child_process";
import { existsSync, mkdtempSync, rmSync } from "node:fs";
import net from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { afterAll, describe, expect, it } from "vitest";

const repo = fileURLToPath(new URL("../../", import.meta.url));
const buildDirectory = join(repo, "web", "build");
const documentsRoot = mkdtempSync(join(tmpdir(), "orbit-warm-up-test-documents-"));

/* Start-up plus the warm-up itself (about 0.3 s on a quiet host). Generous
   for a shared runner; a run that never warms up waits all of it. */
const WARM_UP_DEADLINE_MS = 30_000;
const COMPLETED = /application\.startup state=completed .*duration_ms=\d+/u;

let child: ChildProcess | undefined;

async function freePort(): Promise<number> {
  return new Promise((resolve, reject) => {
    const probe = net.createServer();
    probe.once("error", reject);
    probe.listen(0, "127.0.0.1", () => {
      const { port } = probe.address() as net.AddressInfo;
      probe.close(() => resolve(port));
    });
  });
}

async function stop(): Promise<void> {
  if (child && child.exitCode === null) {
    const exited = new Promise((resolve) => child?.once("exit", resolve));
    child.kill("SIGTERM");
    const timer = setTimeout(() => child?.kill("SIGKILL"), 10_000);
    await exited;
    clearTimeout(timer);
  }
}

afterAll(async () => {
  await stop();
  rmSync(documentsRoot, { recursive: true, force: true });
});

describe("the built app's start-up warm-up (#1575)", () => {
  it("runs against the address the server listens on, given PORT and HOST in the environment", async () => {
    if (!existsSync(join(buildDirectory, "index.js"))) {
      throw new Error("web/build/index.js is missing: build the app first (pnpm --filter orbit-web build)");
    }
    const port = await freePort();
    const environment: NodeJS.ProcessEnv = {
      ...process.env,
      HOST: "127.0.0.1",
      PORT: String(port),
      ORIGIN: `http://127.0.0.1:${port}`,
      DOCUMENTS_ROOT: documentsRoot,
      DOCUMENTS_QUARANTINE_ROOT: join(documentsRoot, "quarantine"),
      DOCUMENT_KEK: "00".repeat(32),
      DOCUMENT_SCAN_MODE: "disabled",
      ORBIT_CONFIG_SCHEMA_VERSION: "1",
    };
    for (const name of ["SOCKET_PATH", "LISTEN_PID", "LISTEN_FDS", "ORBIT_FIXTURES", "ORBIT_LOG_FORMAT", "ORBIT_LOG_LEVEL", "NO_COLOR"]) {
      delete environment[name];
    }

    let output = "";
    child = spawn(process.execPath, [join(buildDirectory, "index.js")], {
      cwd: join(repo, "web"),
      env: environment,
      stdio: ["ignore", "pipe", "pipe"],
    });
    child.stdout?.on("data", (chunk) => (output += chunk));
    child.stderr?.on("data", (chunk) => (output += chunk));

    const deadline = Date.now() + WARM_UP_DEADLINE_MS;
    while (Date.now() < deadline && !COMPLETED.test(output)) {
      if (child.exitCode !== null) {
        throw new Error(`the app exited with ${child.exitCode} before it warmed up; output:\n${output}`);
      }
      await new Promise((resolve) => setTimeout(resolve, 100));
    }

    expect(output, `no warm-up completion line within ${WARM_UP_DEADLINE_MS} ms; output:\n${output}`).toMatch(COMPLETED);
  }, WARM_UP_DEADLINE_MS + 10_000);
});
