import { spawn } from "node:child_process";
import { createHash } from "node:crypto";
import { createServer } from "node:http";
import {
  chmodSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  readdirSync,
  rmSync,
  statSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

import { afterEach, beforeEach, describe, expect, it } from "vitest";

/*
 * scripts/ci/upgrade-seed.sh (#1663) seeds an install on the old version and
 * reads the data back after the update. A small fake HTTP server plays both
 * versions, and a fake `docker` first on PATH supplies the container log.
 *
 * Assumptions (the issue does not spell these out):
 *  - The claim notice in `docker compose logs orbit-app` is the JSON line
 *    printClaimNotice writes under ORBIT_LOG_FORMAT=json (src/lib/auth/
 *    bootstrap.ts): {"event":"bootstrap.claim","url":"...#claim=CODE","code":"CODE"},
 *    preceded by ordinary compose-prefixed noise.
 *  - Request and response bodies are JSON; ids come back as `id` (the fake
 *    also answers `itemId`/`documentId`). The upload is any other POST under
 *    /api/ than the auth routes and /api/workspace/commands. The fake serves
 *    the item and the document from any GET path containing their id.
 *  - Local credentials are the JSON `password` sent to bootstrap/local;
 *    local/login accepts only that same `password`.
 *  - The cookie is read from Set-Cookie and sent back as a Cookie header.
 */
const script = join(dirname(fileURLToPath(import.meta.url)), "upgrade-seed.sh");

const CLAIM_CODE = "FAKE-CLAIM-0000";
const CLAIM_NORMALISED = "FAKECLAIM0000";

function startFake(options = {}) {
  const state = {
    sessions: new Set(),
    password: undefined,
    loginCount: 0,
    secrets: [CLAIM_CODE, CLAIM_NORMALISED],
    document: undefined,
    requests: [],
    ...options,
  };

  function newSession(response) {
    const token = `fake-session-${state.sessions.size + 1}-${Math.random().toString(36).slice(2, 10)}`;
    state.sessions.add(token);
    state.secrets.push(token);
    response.setHeader("Set-Cookie", `orbit_session=${token}; Path=/; HttpOnly`);
  }

  function authed(request) {
    const match = /orbit_session=([^;\s]+)/u.exec(request.headers.cookie ?? "");
    return match !== null && state.sessions.has(match[1]);
  }

  const server = createServer((request, response) => {
    const chunks = [];
    request.on("data", (chunk) => chunks.push(chunk));
    request.on("end", () => {
      const raw = Buffer.concat(chunks);
      const path = new URL(request.url, "http://fake.invalid").pathname;
      state.requests.push(`${request.method} ${path}`);
      const json = (status, body) => {
        response.statusCode = status;
        response.setHeader("Content-Type", "application/json");
        response.end(JSON.stringify(body));
      };
      const text = raw.toString("utf8");
      let body = {};
      try {
        body = JSON.parse(text);
      } catch {
        body = {};
      }

      if (request.method === "GET" && path === "/api/health") {
        return json(200, { status: state.notReady ? "starting" : "ready" });
      }
      if (request.method === "POST" && path === "/api/auth/bootstrap/claim") {
        if (state.rejectClaim || !(text.includes(CLAIM_CODE) || text.includes(CLAIM_NORMALISED))) {
          return json(403, { error: "bootstrap_invalid" });
        }
        newSession(response);
        return json(200, { ok: true });
      }
      if (request.method === "POST" && path === "/api/auth/bootstrap/local") {
        if (state.rejectBootstrapLocal) {
          return json(400, { error: "password_rejected" });
        }
        if (typeof body.password === "string") {
          state.password = body.password;
          state.secrets.push(body.password);
        }
        newSession(response);
        return json(200, { ok: true });
      }
      if (request.method === "POST" && path === "/api/auth/local/login") {
        state.loginCount += 1;
        if (state.rejectLogin || state.password === undefined || body.password !== state.password) {
          return json(401, { error: "credentials_invalid" });
        }
        newSession(response);
        return json(200, { ok: true });
      }
      if (request.method === "POST" && path === "/api/workspace/commands") {
        if (!authed(request)) return json(401, { error: "unauthenticated" });
        if (state.failItem) return json(500, { error: "boom" });
        state.itemId = "item-fake-1";
        return json(200, { id: state.itemId, itemId: state.itemId, item: { id: state.itemId } });
      }
      if (request.method === "POST" && path.startsWith("/api/")) {
        if (!authed(request)) return json(401, { error: "unauthenticated" });
        if (state.failUpload) return json(500, { error: "boom" });
        const contentType = request.headers["content-type"] ?? "";
        let bytes = raw;
        if (contentType.startsWith("multipart/")) {
          const split = raw.indexOf("\r\n\r\n");
          const end = raw.lastIndexOf("\r\n--");
          bytes = raw.subarray(split + 4, end > split ? end : raw.length);
        }
        state.document = bytes;
        state.documentId = "doc-fake-1";
        return json(200, { id: state.documentId, documentId: state.documentId, document: { id: state.documentId } });
      }
      if (request.method === "GET" && state.documentId && path.includes(state.documentId)) {
        if (!authed(request)) return json(401, { error: "unauthenticated" });
        if (state.corruptDocument) {
          response.statusCode = 200;
          return response.end("different bytes");
        }
        response.statusCode = 200;
        return response.end(state.document);
      }
      if (request.method === "GET" && state.itemId && path.includes(state.itemId)) {
        if (!authed(request)) return json(401, { error: "unauthenticated" });
        if (state.itemMissing) return json(404, { error: "not_found" });
        return json(200, { id: state.itemId });
      }
      return json(404, { error: "not_found" });
    });
  });

  return new Promise((resolve) => {
    server.listen(0, "127.0.0.1", () => {
      resolve({ server, state, url: `http://127.0.0.1:${server.address().port}` });
    });
  });
}

function runScript(args, { env = {}, cwd } = {}) {
  return new Promise((resolve) => {
    const child = spawn("bash", [script, ...args], {
      cwd,
      env: { ...process.env, ...env },
      stdio: ["ignore", "pipe", "pipe"],
    });
    let stdout = "";
    let stderr = "";
    child.stdout.on("data", (chunk) => { stdout += chunk; });
    child.stderr.on("data", (chunk) => { stderr += chunk; });
    child.on("close", (status) => resolve({ status, stdout, stderr, output: stdout + stderr }));
  });
}

describe("upgrade-seed.sh", () => {
  let work;
  let target;
  let binDir;
  let fake;

  beforeEach(() => {
    work = mkdtempSync(join(tmpdir(), "orbit-upgrade-seed-"));
    target = join(work, "target");
    binDir = join(work, "bin");
    mkdirSync(target);
    mkdirSync(binDir);
    installDocker("json");
  });

  afterEach(async () => {
    if (fake) {
      await new Promise((resolve) => { fake.server.close(resolve); });
      fake = undefined;
    }
    rmSync(work, { recursive: true, force: true });
  });

  // A fake `docker`: `docker compose ... logs orbit-app` prints a compose-style
  // log with the claim notice (or none); anything else exits 0 silently.
  function installDocker(mode) {
    const claimLine = `{"event":"bootstrap.claim","url":"http://orbit.example.invalid/#claim=${CLAIM_CODE}","code":"${CLAIM_CODE}"}`;
    const lines =
      mode === "json"
        ? [
            "orbit-app-1  | Orbit starting",
            `orbit-app-1  | ${claimLine}`,
            "orbit-app-1  | listening on 3000",
          ]
        : ["orbit-app-1  | Orbit starting", "orbit-app-1  | listening on 3000"];
    const body = [
      "#!/bin/sh",
      'case " $* " in',
      '  *" logs "*) cat <<\'LOG\'',
      ...lines,
      "LOG",
      "  ;;",
      "esac",
      "exit 0",
      "",
    ].join("\n");
    const path = join(binDir, "docker");
    writeFileSync(path, body);
    chmodSync(path, 0o755);
  }

  async function start(options) {
    fake = await startFake(options);
    return fake;
  }

  const pathEnv = () => ({ PATH: `${binDir}:${process.env.PATH}` });
  const seed = () => runScript(["seed", target, fake.url], { env: pathEnv() });
  const readback = () => runScript(["readback", target, fake.url], { env: pathEnv() });

  function expectNoSecrets(result) {
    for (const secret of fake.state.secrets) {
      expect(result.output).not.toContain(secret);
    }
  }

  function failureLine(result) {
    return result.output.split("\n").find((line) => line.startsWith("step=")) ?? "";
  }

  describe("seed then readback", () => {
    it("passes, saves its state under <target>/.upgrade-seed with mode 600, and prints no secret", async () => {
      await start();
      const seeded = await seed();
      expect(seeded.status).toBe(0);
      expectNoSecrets(seeded);

      const dir = join(target, ".upgrade-seed");
      const files = readdirSync(dir);
      expect(files.length).toBeGreaterThanOrEqual(4);
      for (const file of files) {
        expect(statSync(join(dir, file)).mode & 0o777).toBe(0o600);
      }
      const saved = files.map((file) => readFileSync(join(dir, file), "utf8")).join("\n");
      expect(saved).toContain("item-fake-1");
      expect(saved).toContain("doc-fake-1");
      const digest = createHash("sha256").update(fake.state.document).digest("hex");
      expect(saved).toContain(digest);
      expect(saved).not.toContain(CLAIM_CODE);

      const read = await readback();
      expect(read.status).toBe(0);
      expectNoSecrets(read);
      expect(read.output).not.toMatch(/^step=.* assertion=/mu);
    });

    it("uploads a document with the same bytes on every seed", async () => {
      await start();
      await seed();
      const first = Buffer.from(fake.state.document);
      expect(first.length).toBeGreaterThan(0);
      fake.state.sessions.clear();
      await seed();
      expect(Buffer.compare(first, fake.state.document)).toBe(0);
    });

    it("checks health, then the item, then the document, with no re-login while the session holds", async () => {
      await start();
      await seed();
      const loginsAfterSeed = fake.state.loginCount;
      fake.state.requests.length = 0;
      const read = await readback();
      expect(read.status).toBe(0);
      expect(fake.state.loginCount).toBe(loginsAfterSeed);
      const health = fake.state.requests.indexOf("GET /api/health");
      expect(health).toBeGreaterThanOrEqual(0);
      expect(fake.state.requests.some((request) => request.startsWith("GET /api/") && request !== "GET /api/health")).toBe(true);
    });
  });

  describe("seed failures", () => {
    it("reports claim-code-found when the log has no claim notice", async () => {
      installDocker("none");
      await start();
      const result = await seed();
      expect(result.status).toBe(1);
      expect(failureLine(result)).toMatch(/^step=seed assertion=claim-code-found detail="[^"]*"$/u);
      expectNoSecrets(result);
    });

    it("reports claim-accepted when the claim is refused", async () => {
      await start({ rejectClaim: true });
      const result = await seed();
      expect(result.status).toBe(1);
      expect(failureLine(result)).toMatch(/^step=seed assertion=claim-accepted detail="[^"]*"$/u);
      expectNoSecrets(result);
    });

    it("reports claim-accepted when the local account is refused", async () => {
      await start({ rejectBootstrapLocal: true });
      const result = await seed();
      expect(result.status).toBe(1);
      expect(failureLine(result)).toMatch(/^step=seed assertion=claim-accepted detail="[^"]*"$/u);
    });

    it("reports login-accepted when the sign-in is refused", async () => {
      await start({ rejectLogin: true });
      const result = await seed();
      expect(result.status).toBe(1);
      expect(failureLine(result)).toMatch(/^step=seed assertion=login-accepted detail="[^"]*"$/u);
      expectNoSecrets(result);
    });

    it("reports item-created when the item cannot be created", async () => {
      await start({ failItem: true });
      const result = await seed();
      expect(result.status).toBe(1);
      expect(failureLine(result)).toMatch(/^step=seed assertion=item-created detail="[^"]*"$/u);
    });

    it("reports document-uploaded when the upload fails", async () => {
      await start({ failUpload: true });
      const result = await seed();
      expect(result.status).toBe(1);
      expect(failureLine(result)).toMatch(/^step=seed assertion=document-uploaded detail="[^"]*"$/u);
    });
  });

  describe("readback failures", () => {
    it("reports health-ready when /api/health is not ready", async () => {
      await start();
      await seed();
      fake.state.notReady = true;
      const result = await readback();
      expect(result.status).toBe(1);
      expect(failureLine(result)).toMatch(/^step=readback assertion=health-ready detail="[^"]*"$/u);
    });

    it("reports item-readable when the item is gone", async () => {
      await start();
      await seed();
      fake.state.itemMissing = true;
      const result = await readback();
      expect(result.status).toBe(1);
      expect(failureLine(result)).toMatch(/^step=readback assertion=item-readable detail="[^"]*"$/u);
    });

    it("reports document-readable when the bytes differ", async () => {
      await start();
      await seed();
      fake.state.corruptDocument = true;
      const result = await readback();
      expect(result.status).toBe(1);
      expect(failureLine(result)).toMatch(/^step=readback assertion=document-readable detail="[^"]*"$/u);
    });

    it("checks health first when several things are wrong", async () => {
      await start();
      await seed();
      fake.state.notReady = true;
      fake.state.itemMissing = true;
      fake.state.corruptDocument = true;
      const result = await readback();
      expect(failureLine(result)).toContain("assertion=health-ready");
    });

    it("checks the item before the document when both are wrong", async () => {
      await start();
      await seed();
      fake.state.itemMissing = true;
      fake.state.corruptDocument = true;
      const result = await readback();
      expect(failureLine(result)).toContain("assertion=item-readable");
    });
  });

  describe("the 401 re-login path (R4)", () => {
    it("logs in once more with the seeded credentials when the session did not survive", async () => {
      await start();
      await seed();
      const loginsAfterSeed = fake.state.loginCount;
      fake.state.sessions.clear();

      const result = await readback();
      expect(result.status).toBe(0);
      expect(fake.state.loginCount).toBe(loginsAfterSeed + 1);
      expectNoSecrets(result);
    });

    it("fails readback rather than looping when the re-login is refused too", async () => {
      await start();
      await seed();
      fake.state.sessions.clear();
      fake.state.rejectLogin = true;
      const loginsAfterSeed = fake.state.loginCount;

      const result = await readback();
      expect(result.status).toBe(1);
      expect(failureLine(result)).toMatch(/^step=readback assertion=(item|document)-readable /u);
      expect(fake.state.loginCount).toBe(loginsAfterSeed + 1);
    });
  });

  describe("secrets", () => {
    it("never prints the claim code, a password or a cookie, on success or failure", async () => {
      await start();
      const outputs = [];
      outputs.push(await seed());
      fake.state.sessions.clear();
      outputs.push(await readback());
      fake.state.itemMissing = true;
      outputs.push(await readback());
      expect(outputs[0].status).toBe(0);
      expect(outputs[1].status).toBe(0);
      expect(outputs[2].status).toBe(1);
      for (const result of outputs) {
        expectNoSecrets(result);
        expect(result.output).not.toMatch(/orbit_session/u);
      }
    });
  });
});
