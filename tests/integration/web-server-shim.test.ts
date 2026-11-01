/**
 * #1565: the built web app, started through the start-up shim.
 *
 * SvelteKit 3 / adapter-node 6 fix the origin at build time and dropped
 * ORIGIN. Orbit's shim (scripts/web-server.mjs; web/server.mjs in the image)
 * reads ORIGIN, which the container entrypoint derives from APP_URL, points the
 * adapter's PROTOCOL_HEADER and HOST_HEADER at two private header names, and
 * overwrites those headers from ORIGIN on every request. Kit's own CSRF check
 * then compares a request's Origin with the origin the app was configured with
 * instead of one guessed from the Host header and an assumed https.
 *
 * THE SEAM these tests assume (the unit tests in scripts/web-server.test.mjs
 * pin the same one): the shim imports the adapter as `./index.js` relative to
 * its own file. Here the real shim is copied beside the real adapter output,
 * `web/build/index.js`, under a name of its own, and `node` runs the copy, the
 * way the image runs `node web/server.mjs`. The copy is removed afterwards;
 * web/build is a gitignored build output.
 *
 * Needs the built app (`pnpm --filter orbit-web build`) and the integration
 * database: run through `node scripts/test-integration.mjs
 * tests/integration/web-server-shim.test.ts`.
 */
import { spawn, type ChildProcess } from "node:child_process";
import { randomUUID } from "node:crypto";
import { copyFileSync, existsSync, mkdtempSync, rmSync } from "node:fs";
import http from "node:http";
import net from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

const repo = fileURLToPath(new URL("../../", import.meta.url));
const shimSource = join(repo, "scripts", "web-server.mjs");
const buildDirectory = join(repo, "web", "build");
const shimCopy = join(buildDirectory, `orbit-shim-test-${randomUUID().slice(0, 8)}.mjs`);
const documentsRoot = mkdtempSync(join(tmpdir(), "orbit-shim-test-documents-"));

const STARTUP_DEADLINE_MS = 60_000;

let child: ChildProcess | undefined;
let output = "";
let port = 0;
let origin = "";

async function freePort(): Promise<number> {
  return new Promise((resolve, reject) => {
    const probe = net.createServer();
    probe.once("error", reject);
    probe.listen(0, "127.0.0.1", () => {
      const { port: chosen } = probe.address() as net.AddressInfo;
      probe.close(() => resolve(chosen));
    });
  });
}

type Answer = { status: number; contentType: string; body: string };

/** A bodyless POST with exactly the headers given: no content type, as a script or `fetch` with no body sends it. */
function post(path: string, headers: Record<string, string>): Promise<Answer> {
  return new Promise((resolve, reject) => {
    const request = http.request({ host: "127.0.0.1", port, method: "POST", path, headers }, (response) => {
      let body = "";
      response.setEncoding("utf8");
      response.on("data", (chunk) => (body += chunk));
      response.on("end", () =>
        resolve({ status: response.statusCode ?? 0, contentType: String(response.headers["content-type"] ?? ""), body }),
      );
    });
    request.on("error", reject);
    request.end();
  });
}

async function waitUntilAnswering(): Promise<void> {
  const deadline = Date.now() + STARTUP_DEADLINE_MS;
  while (Date.now() < deadline) {
    if (child?.exitCode !== null && child?.exitCode !== undefined) {
      throw new Error(`the app exited with ${child.exitCode} before it answered; output:\n${output}`);
    }
    const answered = await new Promise<boolean>((resolve) => {
      const request = http.get({ host: "127.0.0.1", port, path: "/api/health" }, (response) => {
        response.resume();
        resolve(true);
      });
      request.on("error", () => resolve(false));
    });
    if (answered) return;
    await new Promise((resolve) => setTimeout(resolve, 250));
  }
  throw new Error(`the app did not answer within ${STARTUP_DEADLINE_MS} ms; output:\n${output}`);
}

beforeAll(async () => {
  if (!existsSync(join(buildDirectory, "index.js"))) {
    throw new Error("web/build/index.js is missing: build the app first (pnpm --filter orbit-web build)");
  }
  /* Throws ENOENT naming scripts/web-server.mjs until the shim exists. */
  copyFileSync(shimSource, shimCopy);

  port = await freePort();
  origin = `http://127.0.0.1:${port}`;
  const environment: NodeJS.ProcessEnv = {
    ...process.env,
    /* The integration harness's database and secrets come through process.env. */
    APP_URL: origin,
    ORIGIN: origin,
    HOST: "127.0.0.1",
    PORT: String(port),
    DOCUMENTS_ROOT: documentsRoot,
    DOCUMENTS_QUARANTINE_ROOT: join(documentsRoot, "quarantine"),
    DOCUMENT_KEK: "00".repeat(32),
    DOCUMENT_SCAN_MODE: "disabled",
    ORBIT_CONFIG_SCHEMA_VERSION: "1",
  };
  for (const name of ["PROTOCOL_HEADER", "HOST_HEADER", "ADDRESS_HEADER", "ORBIT_FIXTURES", "SOCKET_PATH", "LISTEN_PID", "LISTEN_FDS"]) {
    delete environment[name];
  }
  child = spawn(process.execPath, [shimCopy], { cwd: join(repo, "web"), env: environment, stdio: ["ignore", "pipe", "pipe"] });
  child.stdout?.on("data", (chunk) => (output += chunk));
  child.stderr?.on("data", (chunk) => (output += chunk));
  await waitUntilAnswering();
}, STARTUP_DEADLINE_MS + 5_000);

afterAll(async () => {
  if (child && child.exitCode === null) {
    const exited = new Promise((resolve) => child?.once("exit", resolve));
    child.kill("SIGTERM");
    const timer = setTimeout(() => child?.kill("SIGKILL"), 10_000);
    await exited;
    clearTimeout(timer);
  }
  rmSync(shimCopy, { force: true });
  rmSync(documentsRoot, { recursive: true, force: true });
});

/* Two routes, because the spec's "401 JSON without a session" is the answer of a
   write() route; sign-out is built differently (api(), same-origin check alone)
   and, with no session, answers 303 (a plain post) -- it never answers 401.
   Both are Orbit's own voice; what neither may be is kit's 403. */
const SIGN_OUT = "/api/auth/logout";
const A_WRITE_ROUTE = "/api/workspace/commands";

function expectOrbitsOwnAnswer(path: string, answer: Answer): void {
  expect(answer.body).not.toContain("Cross-site");
  expect(answer.status).not.toBe(403);
  if (path === SIGN_OUT) {
    expect(answer.status).toBe(303);
  } else {
    expect(answer.status).toBe(401);
    expect(answer.contentType).toContain("application/json");
    expect(() => JSON.parse(answer.body)).not.toThrow();
  }
}

describe("the built app behind the start-up shim (#1565)", () => {
  it.each([SIGN_OUT, A_WRITE_ROUTE])("%s: a bodyless POST with a matching Origin gets Orbit's own answer, not kit's 403", async (path) => {
    expectOrbitsOwnAnswer(path, await post(path, { origin }));
  });

  it.each([SIGN_OUT, A_WRITE_ROUTE])("%s: a POST from another origin is refused with 403", async (path) => {
    expect((await post(path, { origin: "http://evil.invalid" })).status).toBe(403);
  });

  it.each([SIGN_OUT, A_WRITE_ROUTE])("%s: private forwarding headers the client sends are overwritten", async (path) => {
    /* Had the client's headers reached kit, its own origin would have been
       https://evil.invalid and the matching Origin would have been refused. */
    const answer = await post(path, {
      origin,
      "x-orbit-forwarded-proto": "https",
      "x-orbit-forwarded-host": "evil.invalid",
    });
    expectOrbitsOwnAnswer(path, answer);
  });

  it.each([SIGN_OUT, A_WRITE_ROUTE])("%s: an https Origin on this http origin is refused with 403", async (path) => {
    expect((await post(path, { origin: origin.replace("http://", "https://") })).status).toBe(403);
  });
});

/* ------------------------------------- X-Frame-Options: DENY, whatever ORIGIN is */

/* The shim sets one constant response header, `X-Frame-Options: DENY`, on every
   response. It is not derived from ORIGIN, so it must be there when ORIGIN is
   unset or unusable too (the shim then injects no origin headers at all). */
type Started = { process: ChildProcess; port: number; output: () => string };
const extraRuns: Started[] = [];
const extraDirectories: string[] = [];

async function startWithOrigin(originValue: string | undefined): Promise<Started> {
  const extraPort = await freePort();
  const extraDocuments = mkdtempSync(join(tmpdir(), "orbit-shim-test-documents-"));
  extraDirectories.push(extraDocuments);
  const extraCopy = join(buildDirectory, `orbit-shim-test-${randomUUID().slice(0, 8)}.mjs`);
  copyFileSync(shimSource, extraCopy);
  extraDirectories.push(extraCopy);
  const environment: NodeJS.ProcessEnv = {
    ...process.env,
    APP_URL: `http://127.0.0.1:${extraPort}`,
    HOST: "127.0.0.1",
    PORT: String(extraPort),
    DOCUMENTS_ROOT: extraDocuments,
    DOCUMENTS_QUARANTINE_ROOT: join(extraDocuments, "quarantine"),
    DOCUMENT_KEK: "00".repeat(32),
    DOCUMENT_SCAN_MODE: "disabled",
    ORBIT_CONFIG_SCHEMA_VERSION: "1",
  };
  delete environment.ORIGIN;
  if (originValue !== undefined) environment.ORIGIN = originValue;
  for (const name of ["PROTOCOL_HEADER", "HOST_HEADER", "ADDRESS_HEADER", "ORBIT_FIXTURES", "SOCKET_PATH", "LISTEN_PID", "LISTEN_FDS"]) {
    delete environment[name];
  }
  const spawned = spawn(process.execPath, [extraCopy], { cwd: join(repo, "web"), env: environment, stdio: ["ignore", "pipe", "pipe"] });
  let collected = "";
  spawned.stdout?.on("data", (chunk) => (collected += chunk));
  spawned.stderr?.on("data", (chunk) => (collected += chunk));
  const run: Started = { process: spawned, port: extraPort, output: () => collected };
  extraRuns.push(run);

  const deadline = Date.now() + STARTUP_DEADLINE_MS;
  while (Date.now() < deadline) {
    if (spawned.exitCode !== null) throw new Error(`the app exited with ${spawned.exitCode} before it answered; output:\n${collected}`);
    const answered = await new Promise<boolean>((resolve) => {
      const request = http.get({ host: "127.0.0.1", port: extraPort, path: "/api/health" }, (response) => {
        response.resume();
        resolve(true);
      });
      request.on("error", () => resolve(false));
    });
    if (answered) return run;
    await new Promise((resolve) => setTimeout(resolve, 250));
  }
  throw new Error(`the app did not answer within ${STARTUP_DEADLINE_MS} ms; output:\n${collected}`);
}

function headersOf(targetPort: number, path: string): Promise<http.IncomingHttpHeaders> {
  return new Promise((resolve, reject) => {
    const request = http.get({ host: "127.0.0.1", port: targetPort, path, headers: { accept: "text/html" }, agent: false }, (response) => {
      response.resume();
      response.on("end", () => resolve(response.headers));
    });
    request.on("error", reject);
  });
}

afterAll(async () => {
  for (const run of extraRuns) {
    if (run.process.exitCode === null) {
      const exited = new Promise((resolve) => run.process.once("exit", resolve));
      run.process.kill("SIGKILL");
      await exited;
    }
  }
  for (const entry of extraDirectories) rmSync(entry, { recursive: true, force: true });
});

describe("the shim sets X-Frame-Options: DENY whatever ORIGIN is (#1411)", () => {
  it("with ORIGIN set (the default run): a page and an API route", async () => {
    expect((await headersOf(port, "/login"))["x-frame-options"]).toBe("DENY");
    expect((await headersOf(port, "/api/health"))["x-frame-options"]).toBe("DENY");
  });

  it.each([
    ["unset", undefined],
    ["malformed", "not an origin"],
  ])("with ORIGIN %s: a prerendered page, a server-rendered page and an API route", async (_name, originValue) => {
    const run = await startWithOrigin(originValue);
    for (const path of ["/login", "/", "/api/health"]) {
      expect((await headersOf(run.port, path))["x-frame-options"], `${path} with ORIGIN ${_name}`).toBe("DENY");
    }
  }, STARTUP_DEADLINE_MS + 5_000);
});
