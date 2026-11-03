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
 * The fake follows the issue's "Spike findings" (the real v0.3.3 API):
 *  - the claim code is in the default text log format, on the line ending
 *    `sign-in screen: <code>` and in the `#claim=<code>` URL;
 *  - every POST carries Origin; every write carries X-CSRF-Token from
 *    GET /api/auth/session (`csrfToken`); the fake refuses a write without them;
 *  - bootstrap/claim takes {claim}; bootstrap/local takes {email,
 *    displayName,password}, answers 201 and sets a session; local/login is a
 *    second, checked login with the same credentials;
 *  - household.create then item.upsert go to POST /api/workspace/commands,
 *    with client-chosen ids;
 *  - the upload is raw bytes to /api/households/{hid}/items/{iid}/documents
 *    with x-orbit-filename and x-orbit-document-id, PDF/JPEG/PNG only, 201;
 *  - readback: GET /api/workspace, GET /api/documents/{id}/download and
 *    GET /api/health -> {"status":"ready"}.
 * Still assumed: the login body is {email,password}; workspace answers
 * {workspace:{households:[{id,items:[{id}]}]}} (the real shape, #1647 spike); the cookie travels as Set-Cookie / Cookie.
 */
const script = join(dirname(fileURLToPath(import.meta.url)), "upgrade-seed.sh");

const CLAIM_CODE = "FAKE-CLAIM-0000";
const CLAIM_NORMALISED = "FAKECLAIM0000";
const PNG_MAGIC = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/u;

function isAcceptedDocument(bytes) {
  const startsWith = (magic) => bytes.subarray(0, magic.length).equals(Buffer.from(magic));
  return startsWith(PNG_MAGIC) || startsWith([0xff, 0xd8, 0xff]) || startsWith("%PDF-".split("").map((c) => c.charCodeAt(0)));
}

function startFake(options = {}) {
  const state = {
    sessions: new Map(),
    claimCookies: new Set(),
    credentials: undefined,
    loginCount: 0,
    secrets: [CLAIM_CODE, CLAIM_NORMALISED],
    households: new Map(),
    document: undefined,
    refused: [],
    requests: [],
    ...options,
  };

  function newSession() {
    const token = `fake-session-${state.sessions.size + 1}-${Math.random().toString(36).slice(2, 10)}`;
    const csrf = `fake-csrf-${Math.random().toString(36).slice(2, 12)}`;
    state.sessions.set(token, csrf);
    state.secrets.push(token, csrf);
    return `orbit_session=${token}; Path=/; HttpOnly`;
  }

  function sessionOf(request) {
    const match = /orbit_session=([^;\s]+)/u.exec(request.headers.cookie ?? "");
    return match !== null && state.sessions.has(match[1]) ? match[1] : undefined;
  }

  const server = createServer((request, response) => {
    const chunks = [];
    request.on("data", (chunk) => chunks.push(chunk));
    request.on("end", () => {
      const raw = Buffer.concat(chunks);
      const path = new URL(request.url, "http://fake.invalid").pathname;
      const label = `${request.method} ${path}`;
      state.requests.push(label);
      const json = (status, body, headers = {}) => {
        response.statusCode = status;
        response.setHeader("Content-Type", "application/json");
        for (const [name, value] of Object.entries(headers)) response.setHeader(name, value);
        response.end(JSON.stringify(body));
      };
      const refuse = (status, error) => {
        state.refused.push(`${label}: ${error}`);
        return json(status, { error });
      };
      const text = raw.toString("utf8");
      let body = {};
      try {
        body = JSON.parse(text);
      } catch {
        body = {};
      }
      const session = sessionOf(request);
      const isWrite = request.method !== "GET";

      if (isWrite && request.headers.origin !== state.url) {
        return refuse(403, "origin_missing");
      }
      // Writes made as a signed-in user also need the CSRF token.
      const needsSession = isWrite && !path.startsWith("/api/auth/");
      if (needsSession) {
        if (session === undefined) return refuse(401, "unauthenticated");
        if (request.headers["x-csrf-token"] !== state.sessions.get(session)) {
          return refuse(403, "csrf_invalid");
        }
      }

      if (request.method === "GET" && path === "/api/health") {
        return json(200, { status: state.notReady ? "starting" : "ready" });
      }
      if (request.method === "GET" && path === "/api/auth/session") {
        if (session === undefined) return json(401, { error: "unauthenticated" });
        return json(200, { authenticated: true, csrfToken: state.sessions.get(session) });
      }
      if (request.method === "POST" && path === "/api/auth/bootstrap/claim") {
        const claim = String(body.claim ?? "");
        if (state.rejectClaim || claim.replaceAll("-", "").toUpperCase() !== CLAIM_NORMALISED) {
          return json(403, { error: "bootstrap_invalid" });
        }
        const token = `fake-claim-${Math.random().toString(36).slice(2, 10)}`;
        state.claimCookies.add(token);
        state.secrets.push(token);
        return json(200, { ok: true }, { "Set-Cookie": `orbit_claim=${token}; Path=/; HttpOnly` });
      }
      if (request.method === "POST" && path === "/api/auth/bootstrap/local") {
        const claimed = /orbit_claim=([^;\s]+)/u.exec(request.headers.cookie ?? "");
        if (claimed === null || !state.claimCookies.has(claimed[1])) {
          return json(403, { error: "bootstrap_required" });
        }
        if (state.rejectBootstrapLocal || typeof body.password !== "string" || typeof body.email !== "string" || typeof body.displayName !== "string") {
          return json(400, { error: "password_rejected" });
        }
        state.credentials = { email: body.email, password: body.password };
        state.secrets.push(body.password);
        return json(201, { ok: true }, { "Set-Cookie": newSession() });
      }
      if (request.method === "POST" && path === "/api/auth/local/login") {
        state.loginCount += 1;
        const known = state.credentials;
        if (state.rejectLogin || known === undefined || body.password !== known.password || body.email !== known.email) {
          return json(401, { error: "credentials_invalid" });
        }
        return json(200, { ok: true }, { "Set-Cookie": newSession() });
      }
      if (request.method === "POST" && path === "/api/workspace/commands") {
        if (body.type === "household.create") {
          if (state.failHousehold) return json(500, { error: "boom" });
          const id = body.household?.id;
          if (typeof id !== "string") return json(400, { error: "invalid_command" });
          state.households.set(id, new Set());
          state.householdId = id;
          return json(200, { ok: true });
        }
        if (body.type === "item.upsert") {
          const items = state.households.get(body.householdId);
          if (items === undefined) return json(404, { error: "household_not_found" });
          if (state.failItem) return json(500, { error: "boom" });
          items.add(body.item?.id);
          state.itemId = body.item?.id;
          return json(200, { ok: true });
        }
        return json(400, { error: "invalid_command" });
      }
      const upload = /^\/api\/households\/([^/]+)\/items\/([^/]+)\/documents$/u.exec(path);
      if (request.method === "POST" && upload !== null) {
        const filename = request.headers["x-orbit-filename"];
        const documentId = request.headers["x-orbit-document-id"];
        if (typeof filename !== "string" || typeof documentId !== "string") {
          return json(400, { error: "headers_missing" });
        }
        if (!state.households.get(upload[1])?.has(upload[2])) return json(404, { error: "not_found" });
        if (!isAcceptedDocument(raw)) return json(415, { error: "unsupported_type" });
        if (state.failUpload) return json(500, { error: "boom" });
        state.document = raw;
        state.documentId = documentId;
        state.uploadedFilename = filename;
        return json(201, { id: documentId });
      }
      if (request.method === "GET" && path === "/api/workspace") {
        if (session === undefined) return json(401, { error: "unauthenticated" });
        const households = [...state.households].map(([id, items]) => ({
          id,
          items: state.itemMissing ? [] : [...items].map((itemId) => ({ id: itemId })),
        }));
        return json(200, { workspace: { households } });
      }
      const download = /^\/api\/documents\/([^/]+)\/download$/u.exec(path);
      if (request.method === "GET" && download !== null) {
        if (session === undefined) return json(401, { error: "unauthenticated" });
        if (download[1] !== state.documentId) return json(404, { error: "not_found" });
        response.statusCode = 200;
        return response.end(state.corruptDocument ? Buffer.from("different bytes") : state.document);
      }
      return json(404, { error: "not_found" });
    });
  });

  return new Promise((resolve) => {
    server.listen(0, "127.0.0.1", () => {
      state.url = `http://127.0.0.1:${server.address().port}`;
      resolve({ server, state, url: state.url });
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
    installDocker("text");
  });

  afterEach(async () => {
    if (fake) {
      await new Promise((resolve) => { fake.server.close(resolve); });
      fake = undefined;
    }
    rmSync(work, { recursive: true, force: true });
  });

  // A fake `docker`: `docker compose ... logs orbit-app` prints a compose-style
  // text log with the claim notice (or none); anything else exits 0 silently.
  function installDocker(mode) {
    const lines =
      mode === "text"
        ? [
            "orbit-app-1  | Orbit starting",
            "orbit-app-1  | Orbit is not yet claimed. Open this link to create the first administrator:",
            `orbit-app-1  |   http://orbit.example.invalid/#claim=${CLAIM_CODE}`,
            `orbit-app-1  | or enter the code by hand on the sign-in screen: ${CLAIM_CODE}`,
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
      for (const id of [fake.state.householdId, fake.state.itemId, fake.state.documentId]) {
        expect(id).toMatch(UUID);
      }
      expect(saved).toContain(fake.state.itemId);
      expect(saved).toContain(fake.state.documentId);
      const digest = createHash("sha256").update(fake.state.document).digest("hex");
      expect(saved).toContain(digest);
      expect(saved).not.toContain(CLAIM_CODE);
      // Every write carried Origin and X-CSRF-Token, as the real server demands.
      expect(fake.state.refused).toEqual([]);
      // The fixture is a real image the server accepts, sent with its filename.
      expect(fake.state.document.subarray(0, 8).equals(PNG_MAGIC)).toBe(true);
      expect(fake.state.uploadedFilename).toBeTruthy();

      const read = await readback();
      expect(read.status).toBe(0);
      expectNoSecrets(read);
      expect(read.output).not.toMatch(/^step=.* assertion=/mu);
      expect(fake.state.refused).toEqual([]);
    });

    it("uploads a document with the same bytes on every seed", async () => {
      await start();
      await seed();
      const first = Buffer.from(fake.state.document);
      expect(first.length).toBeGreaterThan(0);
      await seed();
      expect(Buffer.compare(first, fake.state.document)).toBe(0);
    });

    it("creates the household before the item, then uploads under that household and item", async () => {
      await start();
      await seed();
      const order = fake.state.requests;
      expect(order).toContain("GET /api/auth/session");
      const commands = order.indexOf("POST /api/workspace/commands");
      const upload = order.findIndex((request) => /\/documents$/u.test(request));
      expect(commands).toBeGreaterThan(order.indexOf("POST /api/auth/local/login"));
      expect(upload).toBeGreaterThan(commands);
      expect(order.filter((request) => request === "POST /api/workspace/commands")).toHaveLength(2);
      expect(fake.state.households.get(fake.state.householdId).has(fake.state.itemId)).toBe(true);
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
      const workspace = fake.state.requests.indexOf("GET /api/workspace");
      const download = fake.state.requests.findIndex((request) => /^GET \/api\/documents\/[^/]+\/download$/u.test(request));
      expect(workspace).toBeGreaterThan(health);
      expect(download).toBeGreaterThan(workspace);
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

    it("reports household-created when the household cannot be created", async () => {
      await start({ failHousehold: true });
      const result = await seed();
      expect(result.status).toBe(1);
      expect(failureLine(result)).toMatch(/^step=seed assertion=household-created detail="[^"]*"$/u);
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
