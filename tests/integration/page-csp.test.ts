/**
 * #1411: the built web app's page Content-Security-Policy, and the two drain
 * Lows from #1565 that are settled by what the built app does (U34.4, U34.5).
 *
 * The same harness as tests/integration/web-server-shim.test.ts: the real shim
 * (scripts/web-server.mjs) is copied beside the real adapter output,
 * `web/build/index.js`, and `node` runs the copy, the way the image runs
 * `node web/server.mjs`. Needs the built app (`pnpm --filter orbit-web build`)
 * and the integration database: run through
 * `node scripts/test-integration.mjs tests/integration/page-csp.test.ts`.
 *
 * What the specification says, and where it is checked:
 *   - a server-rendered page answers with a `content-security-policy` HEADER
 *     holding kit's nonce, and every script of the page carries that nonce;
 *   - the prerendered pages (/login, /logout, /auth/error) carry the policy in
 *     a <meta http-equiv> tag, with hashes (kit cannot put a nonce in a file
 *     it wrote at build time), and every inline script of the page is hashed;
 *   - /api/health, and every other +server response, carry no page policy;
 *   - a preview or a download keeps `default-src 'none'; sandbox`: those need a
 *     signed-in session and a stored document, so they are covered by
 *     tests/unit/document-responses-null-csp.test.mjs, and here by a signed-out
 *     request to a document route (never a page policy on it);
 *   - U34.4: a cross-origin form POST with a 2 MiB body gets kit's own 403 and
 *     the SAME keep-alive connection then answers a GET (kit 3.1 drains an
 *     unread body after the answer, for kit's CSRF 403 too);
 *   - U34.5: neither the adapter's built index.js nor the shim sets
 *     `requestTimeout`, so Node's own default (300 s on Node 22, never 0) is
 *     what bounds a drain of an upload that never ends.
 */
import { spawn, type ChildProcess } from "node:child_process";
import { createHash, randomUUID } from "node:crypto";
import { copyFileSync, existsSync, mkdtempSync, readFileSync, rmSync } from "node:fs";
import http from "node:http";
import net from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

const repo = fileURLToPath(new URL("../../", import.meta.url));
const shimSource = join(repo, "scripts", "web-server.mjs");
const buildDirectory = join(repo, "web", "build");
const shimCopy = join(buildDirectory, `orbit-csp-test-${randomUUID().slice(0, 8)}.mjs`);
const documentsRoot = mkdtempSync(join(tmpdir(), "orbit-csp-test-documents-"));

const STARTUP_DEADLINE_MS = 60_000;
const MIB = 1_048_576;
const NULL_CSP = "default-src 'none'; sandbox";

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

type Answer = { status: number; headers: http.IncomingHttpHeaders; body: string };

function get(path: string, headers: Record<string, string> = {}): Promise<Answer> {
  return new Promise((resolve, reject) => {
    const request = http.request({ host: "127.0.0.1", port, method: "GET", path, headers, agent: false }, (response) => {
      let body = "";
      response.setEncoding("utf8");
      response.on("data", (chunk) => (body += chunk));
      response.on("end", () => resolve({ status: response.statusCode ?? 0, headers: response.headers, body }));
    });
    request.on("error", reject);
    request.end();
  });
}

const page = (path: string) => get(path, { accept: "text/html" });

async function waitUntilAnswering(): Promise<void> {
  const deadline = Date.now() + STARTUP_DEADLINE_MS;
  while (Date.now() < deadline) {
    if (child?.exitCode !== null && child?.exitCode !== undefined) {
      throw new Error(`the app exited with ${child.exitCode} before it answered; output:\n${output}`);
    }
    const answered = await new Promise<boolean>((resolve) => {
      const request = http.get({ host: "127.0.0.1", port, path: "/api/health", agent: false }, (response) => {
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

/* ------------------------------------------------------------------ policy */

/** Everything but script-src, as the specification gives it; kit writes a keyword with its quotes. */
const OTHER_DIRECTIVES: Record<string, string[]> = {
  "default-src": ["'self'"],
  "style-src": ["'self'", "'unsafe-inline'"],
  "img-src": ["'self'", "data:", "blob:"],
  "font-src": ["'self'", "data:"],
  "connect-src": ["'self'"],
  "worker-src": ["'self'"],
  "manifest-src": ["'self'"],
  "frame-src": ["'none'"],
  "object-src": ["'none'"],
  "base-uri": ["'self'"],
  "form-action": ["'self'"],
  "frame-ancestors": ["'none'"],
};

function parsePolicy(policy: string): Record<string, string[]> {
  const directives: Record<string, string[]> = {};
  for (const part of policy.split(";")) {
    const [name, ...sources] = part.trim().split(/\s+/u);
    if (name) directives[name.toLowerCase()] = sources;
  }
  return directives;
}

const sorted = (values: string[] | undefined) => [...(values ?? [])].sort();

/** The directives other than script-src, against the specification (a meta tag cannot carry frame-ancestors). */
function expectOtherDirectives(directives: Record<string, string[]>, inMeta: boolean): void {
  const { "script-src": scriptSrc, ...rest } = directives;
  const expected = { ...OTHER_DIRECTIVES };
  if (inMeta) delete expected["frame-ancestors"];
  const normal = (all: Record<string, string[]>) =>
    Object.fromEntries(Object.entries(all).map(([name, sources]) => [name, sorted(sources)]));
  expect(normal(rest)).toEqual(normal(expected));
  expect(scriptSrc, "script-src is present").toBeDefined();
}

type Script = { attributes: string; text: string; external: boolean };

function scriptsOf(html: string): Script[] {
  return [...html.matchAll(/<script\b([^>]*)>([\s\S]*?)<\/script>/gu)].map((match) => ({
    attributes: match[1],
    text: match[2],
    external: /\bsrc\s*=/u.test(match[1]),
  }));
}

const nonceOf = (script: Script) => /\bnonce\s*=\s*"([^"]*)"/u.exec(script.attributes)?.[1];
const hashSource = (text: string) => `'sha256-${createHash("sha256").update(text, "utf8").digest("base64")}'`;

function metaPolicy(html: string): string | undefined {
  const tag = /<meta\b[^>]*\bhttp-equiv\s*=\s*"content-security-policy"[^>]*>/iu.exec(html)?.[0];
  const content = tag ? /\bcontent\s*=\s*"([^"]*)"/u.exec(tag)?.[1] : undefined;
  return content
    ?.replaceAll("&quot;", '"')
    .replaceAll("&#39;", "'")
    .replaceAll("&lt;", "<")
    .replaceAll("&gt;", ">")
    .replaceAll("&amp;", "&");
}

/* ---------------------------------------------------- a server-rendered page */

describe("a server-rendered page carries the policy in a header, with a nonce (#1411)", () => {
  /* `/` is rendered per request (its +page.js says prerender = false) and is
     open to a signed-out reader: it answers the sign-in door. */
  it("answers a content-security-policy header with exactly the specified directives", async () => {
    const answer = await page("/");
    expect(answer.status).toBe(200);
    const header = answer.headers["content-security-policy"];
    expect(header, "no content-security-policy header on /").toBeTypeOf("string");
    const directives = parsePolicy(String(header));
    expect(Object.keys(directives).sort()).toEqual([...Object.keys(OTHER_DIRECTIVES), "script-src"].sort());
    expectOtherDirectives(directives, false);
  });

  it("script-src is 'self' and kit's nonce (and the pre-paint hash): never 'unsafe-inline' or 'unsafe-eval'", async () => {
    const header = String((await page("/")).headers["content-security-policy"]);
    const scriptSrc = parsePolicy(header)["script-src"] ?? [];
    expect(scriptSrc).toContain("'self'");
    expect(scriptSrc.filter((source) => /^'nonce-[A-Za-z0-9+/_=-]{16,}'$/u.test(source))).toHaveLength(1);
    expect(scriptSrc).not.toContain("'unsafe-inline'");
    expect(scriptSrc).not.toContain("'unsafe-eval'");
    expect(scriptSrc.filter((source) => !/^'(self|nonce-[^']*|sha256-[A-Za-z0-9+/=]+)'$/u.test(source))).toEqual([]);
  });

  it("every script of the page, app.html's pre-paint script included, carries that nonce", async () => {
    const answer = await page("/");
    const header = String(answer.headers["content-security-policy"]);
    const nonce = /'nonce-([^']+)'/u.exec(header)?.[1];
    expect(nonce, "no nonce in the header").toBeTypeOf("string");

    const scripts = scriptsOf(answer.body);
    const prePaint = scripts.filter((script) => script.text.includes('localStorage.getItem("orbit-theme")'));
    expect(prePaint, "the pre-paint script is in the page").toHaveLength(1);
    expect(scripts.length).toBeGreaterThanOrEqual(2);
    for (const script of scripts) {
      expect(nonceOf(script), `a script has no nonce, or another one: <script${script.attributes}>`).toBe(nonce);
    }
    expect(answer.body).not.toContain("%sveltekit.nonce%");
  });

  it("a new nonce for every response", async () => {
    const nonceFor = async () => /'nonce-([^']+)'/u.exec(String((await page("/")).headers["content-security-policy"]))?.[1];
    const [one, two] = [await nonceFor(), await nonceFor()];
    expect(one).toBeTypeOf("string");
    expect(two).toBeTypeOf("string");
    expect(one).not.toBe(two);
  });
});

/* -------------------------------------------------------- the prerendered pages */

describe("a prerendered page carries the policy in a <meta> tag, with hashes (#1411)", () => {
  it.each(["/login", "/logout", "/auth/error"])("%s", async (path) => {
    const answer = await page(path);
    expect(answer.status).toBe(200);
    const policy = metaPolicy(answer.body);
    expect(policy, `no <meta http-equiv="content-security-policy"> in ${path}`).toBeTypeOf("string");

    const directives = parsePolicy(String(policy));
    expectOtherDirectives(directives, true);
    const scriptSrc = directives["script-src"] ?? [];
    expect(scriptSrc).toContain("'self'");
    expect(scriptSrc).not.toContain("'unsafe-inline'");
    expect(scriptSrc).not.toContain("'unsafe-eval'");
    expect(scriptSrc.filter((source) => /^'nonce-/u.test(source)), "a nonce cannot be in a file written at build time").toEqual([]);

    const inline = scriptsOf(answer.body).filter((script) => !script.external);
    expect(inline.length).toBeGreaterThanOrEqual(2);
    for (const script of inline) {
      expect(scriptSrc, `an inline script of ${path} is not hashed: ${script.text.slice(0, 60)}`).toContain(hashSource(script.text));
    }
    const prePaint = inline.filter((script) => script.text.includes('localStorage.getItem("orbit-theme")'));
    expect(prePaint, "the pre-paint script is in the page").toHaveLength(1);
  });
});

/* ------------------------------------------------- everything that is not a page */

describe("a +server response carries no page policy (#1411)", () => {
  it("/api/health", async () => {
    const answer = await get("/api/health");
    expect(answer.status).toBe(200);
    expect(answer.headers["content-security-policy"]).toBeUndefined();
    expect(answer.headers["content-security-policy-report-only"]).toBeUndefined();
  });

  it("/api/workspace, signed out", async () => {
    const answer = await get("/api/workspace");
    expect(answer.status).toBe(401);
    expect(answer.headers["content-security-policy"]).toBeUndefined();
  });

  it("a document's download and preview, signed out: never a page policy (a signed-in one keeps `default-src 'none'; sandbox`)", async () => {
    const id = "00000000-0000-4000-8000-000000000001";
    for (const path of [`/api/documents/${id}/download`, `/api/documents/${id}/preview`]) {
      const answer = await get(path);
      expect(answer.status, path).toBe(401);
      const policy = answer.headers["content-security-policy"];
      expect([undefined, NULL_CSP], path).toContain(policy);
    }
  });
});

/* ------------------------------------------------------ U34.4: drain and keep-alive */

describe("kit's own CSRF 403 leaves the connection usable (#1411, U34.4 of #1565)", () => {
  it("a cross-origin form POST with a 2 MiB body gets the 403, and the same connection then answers a GET", async () => {
    const agent = new http.Agent({ keepAlive: true, maxSockets: 1 });
    const size = 2 * MIB;
    try {
      const refused = await new Promise<{ status: number; body: string }>((resolve, reject) => {
        const request = http.request(
          {
            host: "127.0.0.1",
            port,
            method: "POST",
            path: "/api/workspace/commands",
            agent,
            headers: {
              origin: "http://evil.invalid",
              "content-type": "application/x-www-form-urlencoded",
              "content-length": String(size),
            },
          },
          (response) => {
            let body = "";
            response.setEncoding("utf8");
            response.on("data", (chunk) => (body += chunk));
            response.on("end", () => resolve({ status: response.statusCode ?? 0, body }));
          },
        );
        request.setTimeout(20_000, () => request.destroy(new Error("no answer to the cross-origin POST within 20 s")));
        request.on("error", reject);
        request.end(Buffer.alloc(size, 0x61));
      });
      expect(refused.status).toBe(403);
      expect(refused.body).toContain("Cross-site");

      const next = await new Promise<{ status: number; reused: boolean }>((resolve, reject) => {
        const request = http.request({ host: "127.0.0.1", port, method: "GET", path: "/api/health", agent }, (response) => {
          response.resume();
          response.on("end", () => resolve({ status: response.statusCode ?? 0, reused: request.reusedSocket }));
        });
        request.setTimeout(10_000, () => request.destroy(new Error("the keep-alive connection did not answer the GET within 10 s")));
        request.on("error", reject);
        request.end();
      });
      expect(next.status).toBe(200);
      expect(next.reused, "the GET went out on a new connection: the first one was closed after the 403").toBe(true);
    } finally {
      agent.destroy();
    }
  }, 40_000);
});

/* ------------------------------------------------------- U34.5: no byte cap, a time bound */

/** The code, not the comments about it: whole-line `//` comments and block comments removed. */
function withoutComments(source: string): string {
  return source.replace(/\/\*[\s\S]*?\*\//gu, "").replace(/^\s*\/\/.*$/gmu, "");
}

describe("a drain is bounded in time by Node's own requestTimeout, which nothing here changes (#1411, U34.5 of #1565)", () => {
  it("the adapter's built index.js sets no requestTimeout (it sets only the keep-alive and headers timeouts)", () => {
    /* adapter-node 6 builds index.js as a one-line re-export of the module that
       holds its server (server/adapter-index.js); the code is read, not the stub. */
    const entry = readFileSync(join(buildDirectory, "index.js"), "utf8");
    const reached = [...entry.matchAll(/from\s+['"](\.\/[^'"]+)['"]/gu)].map((match) => join(buildDirectory, match[1]));
    const built = withoutComments([entry, ...reached.map((file) => readFileSync(file, "utf8"))].join("\n"));
    expect(built, "this reads the adapter's server code").toMatch(/keepAliveTimeout/u);
    expect(built).not.toMatch(/requestTimeout/u);
  });

  it("scripts/web-server.mjs, the shim, sets no requestTimeout", () => {
    expect(withoutComments(readFileSync(shimSource, "utf8"))).not.toMatch(/requestTimeout/u);
  });

  it("Node's default requestTimeout is above 0, so there is a bound to rely on", () => {
    const server = http.createServer();
    try {
      expect(server.requestTimeout).toBeGreaterThan(0);
    } finally {
      server.close();
    }
  });
});
