import { spawn } from "node:child_process";
import { copyFileSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import http from "node:http";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";

import { afterEach, describe, expect, it, vi } from "vitest";

import { PROCESS_DEADLINE_MS, PROCESS_TEST_TIMEOUT_MS } from "./process-budget.mjs";

/*
 * #1565: the start-up shim in front of adapter-node 6, scripts/web-server.mjs
 * (in the image it sits beside the adapter's output as web/server.mjs and the
 * Dockerfile's CMD becomes `node web/server.mjs`).
 *
 * SvelteKit 3 and adapter-node 6 fixed the origin at build time and dropped
 * ORIGIN, so one image serving many installs cannot tell kit's CSRF check which
 * origin is its own. The shim reads ORIGIN (the entrypoint derives it from
 * APP_URL), points the adapter's PROTOCOL_HEADER and HOST_HEADER at two private
 * header names before the adapter loads, imports the adapter's own `index.js`,
 * and prepends one request listener on the exported `server` that overwrites
 * those two headers from ORIGIN on every request.
 *
 * THE SEAM these tests assume, which the shim has to match:
 *  - the shim imports the adapter as `./index.js`, relative to its own file
 *    (the image layout: web/server.mjs beside web/index.js). Each test copies
 *    scripts/web-server.mjs to `server.mjs` in a scratch directory beside a
 *    fixture `index.js`, and runs `node server.mjs`. The shim must not resolve
 *    the adapter any other way (no env var, no path under web/build);
 *  - the shim reads the adapter's exported `server` only after setting
 *    PROTOCOL_HEADER and HOST_HEADER, so the import must be dynamic: a static
 *    import is hoisted above the assignment and the fixture, which records both
 *    variables as it loads, would see them unset;
 *  - it is configured by process.env.ORIGIN alone, and a warning goes to
 *    stdout or stderr, one line, naming ORIGIN.
 * The fixture adapter registers its own request listener before the shim gets
 * to prepend, so a shim that appended instead would lose to it and fail the
 * overwrite tests. The built app is exercised through the same shim, copied
 * beside web/build/index.js, in tests/integration/web-server-shim.test.ts.
 */

vi.setConfig({ testTimeout: PROCESS_TEST_TIMEOUT_MS });

const SHIM = fileURLToPath(new URL("./web-server.mjs", import.meta.url));
const PROTO_HEADER = "x-orbit-forwarded-proto";
const HOST_HEADER = "x-orbit-forwarded-host";

/* Stands in for adapter-node's index.js: an http server exported as `server`,
   one request listener of its own that answers with the two private headers it
   was handed, and one line on stdout, once listening, that records the port and
   the two variables as they stood when the module loaded. */
const FIXTURE_ADAPTER = `
import http from "node:http";
const seen = {
  PROTOCOL_HEADER: process.env.PROTOCOL_HEADER ?? null,
  HOST_HEADER: process.env.HOST_HEADER ?? null,
};
export const server = http.createServer();
server.on("request", (request, response) => {
  response.setHeader("content-type", "application/json");
  response.end(JSON.stringify({
    proto: request.headers["${PROTO_HEADER}"] ?? null,
    host: request.headers["${HOST_HEADER}"] ?? null,
    ordinaryHost: request.headers.host ?? null,
  }));
});
server.listen(0, "127.0.0.1", () => {
  console.log("FIXTURE_LISTENING " + JSON.stringify({ port: server.address().port, seen }));
});
`;

const scratch = [];
const children = [];

afterEach(() => {
  for (const child of children.splice(0)) child.kill("SIGKILL");
  for (const dir of scratch.splice(0)) rmSync(dir, { recursive: true, force: true });
});

/** A scratch directory laid out like the image: server.mjs (the shim) beside index.js (the adapter). */
function install(adapterSource) {
  const dir = mkdtempSync(join(tmpdir(), "orbit-web-server-shim-"));
  scratch.push(dir);
  mkdirSync(dir, { recursive: true });
  writeFileSync(join(dir, "package.json"), '{"type":"module"}\n');
  writeFileSync(join(dir, "index.js"), adapterSource);
  /* Throws ENOENT, naming scripts/web-server.mjs, until the shim exists. */
  copyFileSync(SHIM, join(dir, "server.mjs"));
  return dir;
}

/** The environment a shim run gets: nothing of the host's ORIGIN or header settings leaks in. */
function childEnv(origin, extra = {}) {
  const env = { PATH: process.env.PATH ?? "", ...extra };
  if (origin !== undefined) env.ORIGIN = origin;
  return env;
}

/** Runs the shim over the fixture adapter and resolves once the fixture is listening. */
function start({ origin, env = {} }) {
  const dir = install(FIXTURE_ADAPTER);
  const child = spawn(process.execPath, [join(dir, "server.mjs")], {
    cwd: dir,
    env: childEnv(origin, env),
    stdio: ["ignore", "pipe", "pipe"],
  });
  children.push(child);
  let output = "";
  let listening;
  const ready = new Promise((resolve, reject) => {
    const deadline = setTimeout(
      () => reject(new Error(`the shim never reached the adapter's listen within ${PROCESS_DEADLINE_MS} ms; output:\n${output}`)),
      PROCESS_DEADLINE_MS,
    );
    const onData = (chunk) => {
      output += chunk.toString("utf8");
      const match = /^FIXTURE_LISTENING (.+)$/mu.exec(output);
      if (match && !listening) {
        listening = JSON.parse(match[1]);
        clearTimeout(deadline);
        resolve(listening);
      }
    };
    child.stdout.on("data", onData);
    child.stderr.on("data", onData);
    child.once("exit", (code) => {
      clearTimeout(deadline);
      if (!listening) reject(new Error(`the shim exited (${code}) before the adapter listened; output:\n${output}`));
    });
  });
  return {
    ready,
    output: () => output,
    /** One request to the fixture, with exactly the headers given, answered with the headers the adapter saw. */
    async request(port, headers = {}) {
      return new Promise((resolve, reject) => {
        const request = http.request({ host: "127.0.0.1", port, method: "GET", path: "/", headers }, (response) => {
          let body = "";
          response.setEncoding("utf8");
          response.on("data", (chunk) => (body += chunk));
          response.on("end", () => resolve({ ...JSON.parse(body), xFrameOptions: response.headers["x-frame-options"] ?? null }));
        });
        request.on("error", reject);
        request.end();
      });
    },
  };
}

/** The lines of the child's output that name ORIGIN: the warning, when there is one. */
function originWarnings(output) {
  return output.split("\n").filter((line) => line.includes("ORIGIN"));
}

describe("the shim derives the two private headers from ORIGIN (#1565)", () => {
  it.each([
    ["http", "http://127.0.0.1:3000", "http", "127.0.0.1:3000"],
    ["https", "https://orbit.example", "https", "orbit.example"],
    ["a port", "https://orbit.example:8443", "https", "orbit.example:8443"],
    ["a host and no port", "http://orbit.example", "http", "orbit.example"],
    ["IPv6 in brackets", "http://[::1]:3000", "http", "[::1]:3000"],
    ["the lowest port", "http://orbit.example:1", "http", "orbit.example:1"],
    ["the highest port", "http://orbit.example:65535", "http", "orbit.example:65535"],
  ])("%s: %s", async (_name, origin, scheme, authority) => {
    const run = start({ origin });
    const { port, seen } = await run.ready;

    /* Spec item 1: set before the adapter loads, to the two private names. */
    expect(seen).toEqual({ PROTOCOL_HEADER: PROTO_HEADER, HOST_HEADER: HOST_HEADER });

    /* Spec item 2: every request carries ORIGIN's scheme and authority. */
    expect(await run.request(port)).toMatchObject({ proto: scheme, host: authority });

    /* A good ORIGIN is not a warning. */
    expect(originWarnings(run.output())).toEqual([]);
  });

  it("replaces whatever the client sent under those names, on every request", async () => {
    const run = start({ origin: "https://orbit.example:8443" });
    const { port } = await run.ready;
    const spoofed = { [PROTO_HEADER]: "http", [HOST_HEADER]: "evil.invalid" };

    expect(await run.request(port, spoofed)).toMatchObject({ proto: "https", host: "orbit.example:8443" });
    expect(await run.request(port, spoofed)).toMatchObject({ proto: "https", host: "orbit.example:8443" });
    /* A client that sent only one of the two still gets both from ORIGIN. */
    expect(await run.request(port, { [HOST_HEADER]: "evil.invalid" })).toMatchObject({ proto: "https", host: "orbit.example:8443" });
    expect(await run.request(port, { [PROTO_HEADER]: "http" })).toMatchObject({ proto: "https", host: "orbit.example:8443" });
  });

  it("does not touch the ordinary Host header", async () => {
    /* The shim only supplies the two private names; nothing else is rewritten. */
    const run = start({ origin: "https://orbit.example" });
    const { port } = await run.ready;
    const answer = await run.request(port, { host: "127.0.0.1:4000" });
    expect(answer.ordinaryHost).toBe("127.0.0.1:4000");
  });
});

describe("a missing or unusable ORIGIN injects nothing and warns once (#1565)", () => {
  it.each([
    ["unset", undefined],
    ["empty", ""],
    ["a host with no scheme", "orbit.example"],
    ["a scheme that is not http or https", "ftp://orbit.example"],
    ["an origin with a path", "http://orbit.example/app"],
    ["a scheme with no host", "http://"],
    ["a port above 65535", "http://orbit.example:65536"],
    ["a five-digit port far above 65535", "http://orbit.example:99999"],
    ["port 0", "http://orbit.example:0"],
    /* A port is its canonical decimal form or it is malformed. A browser's
       Origin header never carries a leading zero (the URL parser reads
       "08080" as 8080 and sends ":8080"), so an authority injected as
       "orbit.example:08080" could never equal it: every cross-origin-safe POST
       would be refused by kit with a 403, and nothing would say why. Refusing
       the value at start, with the warning, is the louder failure. */
    ["a port with a leading zero", "http://orbit.example:08080"],
    ["a port of only zeros", "http://orbit.example:00000"],
  ])("%s", async (_name, origin) => {
    const run = start({ origin });
    const { port, seen } = await run.ready;

    /* The adapter still starts and runs as it does on its own... */
    expect(seen).toEqual({ PROTOCOL_HEADER: null, HOST_HEADER: null });
    /* ...and nothing is derived: a request that sent neither header reaches it
       with neither. */
    expect(await run.request(port)).toMatchObject({ proto: null, host: null });

    /* One warning, which names ORIGIN. */
    expect(originWarnings(run.output())).toHaveLength(1);
  });

  it("leaves a PROTOCOL_HEADER or HOST_HEADER the operator already set alone", async () => {
    /* "sets neither": the shim writes no value of its own. */
    const run = start({
      origin: "not an origin",
      env: { PROTOCOL_HEADER: "x-operator-proto", HOST_HEADER: "x-operator-host" },
    });
    const { seen } = await run.ready;
    expect(seen).toEqual({ PROTOCOL_HEADER: "x-operator-proto", HOST_HEADER: "x-operator-host" });
  });
});

describe("the shim sets X-Frame-Options: DENY on every response, whatever ORIGIN is (#1411)", () => {
  it.each([
    ["a good ORIGIN", "https://orbit.example"],
    ["ORIGIN unset", undefined],
    ["ORIGIN empty", ""],
    ["a malformed ORIGIN", "http://orbit.example/app"],
  ])("%s", async (_name, origin) => {
    const run = start({ origin });
    const { port } = await run.ready;

    /* The fixture adapter's own listener never sets the header, so it can only
       come from a listener the shim prepended. It is the same on each request. */
    expect((await run.request(port)).xFrameOptions).toBe("DENY");
    expect((await run.request(port, { [PROTO_HEADER]: "http" })).xFrameOptions).toBe("DENY");
  });

  it("the header does not change the ORIGIN warning: still one line naming ORIGIN", async () => {
    const run = start({ origin: "ftp://orbit.example" });
    await run.ready;
    expect(originWarnings(run.output())).toHaveLength(1);
  });
});

describe("an adapter with no server export fails at start, loudly (#1565)", () => {
  it.each([
    ["no export of that name", "export const handler = () => {};\n"],
    ["a server export that is not a server", "export const server = undefined;\n"],
  ])("%s", async (_name, adapterSource) => {
    const dir = install(adapterSource);
    const run = await new Promise((resolve) => {
      const child = spawn(process.execPath, [join(dir, "server.mjs")], {
        cwd: dir,
        env: childEnv("http://127.0.0.1:3000"),
        stdio: ["ignore", "pipe", "pipe"],
      });
      children.push(child);
      let output = "";
      child.stdout.on("data", (chunk) => (output += chunk));
      child.stderr.on("data", (chunk) => (output += chunk));
      const deadline = setTimeout(() => child.kill("SIGKILL"), PROCESS_DEADLINE_MS);
      child.once("exit", (code, signal) => {
        clearTimeout(deadline);
        resolve({ code, signal, output });
      });
    });

    /* Exits by itself, non-zero: never starts without the headers. */
    expect(run.signal).toBeNull();
    expect(run.code).not.toBeNull();
    expect(run.code).not.toBe(0);
    /* And says why: the message names the missing `server` export. */
    expect(run.output).toMatch(/\bserver\b/u);
    expect(run.output).toMatch(/export/iu);
  });
});
