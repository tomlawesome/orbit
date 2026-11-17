import { spawnSync } from "node:child_process";
import { chmodSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { createServer } from "node:http";
import { tmpdir } from "node:os";
import { delimiter, dirname, join } from "node:path";

import { afterAll, afterEach, beforeEach, describe, expect, it, vi } from "vitest";

// A namespace import, so a missing `runWithLimit` fails one test, not the whole file.
import * as readiness from "./release-readiness.mjs";

const { fetchJson, handoffRepository, realLookups } = readiness;

/*
 * Limits and least privilege in scripts/release-readiness.mjs (#1866):
 * the fetch stream cap (R1), the body time limit (R2), the test seam (R3),
 * errors that never leak (R4) and the narrow child environment (R5).
 */
const root = mkdtempSync(join(tmpdir(), "release-readiness-limits-1866-"));
afterAll(() => rmSync(root, { recursive: true, force: true }));

const TEST_TIMEOUT = 8000;
const FAKE_TOKEN = "fake-placeholder-value";
const SECRET_QUERY = "private_token=fake-placeholder-query";
const SHA = "0123456789abcdef0123456789abcdef01234567";
const DIGEST = `sha256:${"a".repeat(64)}`;

// --- a local HTTP server -------------------------------------------------------

let servers = [];
let sockets = new Set();

async function serve(handler) {
  const server = createServer(handler);
  server.on("connection", (socket) => {
    sockets.add(socket);
    socket.on("close", () => sockets.delete(socket));
  });
  await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
  servers.push(server);
  return `http://127.0.0.1:${server.address().port}/data?${SECRET_QUERY}`;
}

afterEach(async () => {
  for (const socket of sockets) socket.destroy();
  sockets = new Set();
  await Promise.all(servers.map((server) => new Promise((resolve) => server.close(resolve))));
  servers = [];
  vi.unstubAllGlobals();
});

const AUTH = { Authorization: `Bearer ${FAKE_TOKEN}` };
const messageOf = async (promise) => {
  try {
    await promise;
  } catch (error) {
    return error.message;
  }
  throw new Error("expected a rejection");
};

describe("fetchJson against a real server", () => {
  it("parses a body under the cap", async () => {
    const url = await serve((req, res) => {
      res.writeHead(200, { "content-type": "application/json" });
      res.end(JSON.stringify({ ok: true }));
    });
    expect(await fetchJson(url, AUTH, "the thing", { timeoutMs: 1000, maxBytes: 1024 })).toEqual({ ok: true });
  }, TEST_TIMEOUT);

  it("cancels a body that passes the cap with no content-length, and closes the connection", async () => {
    let closed = false;
    let written = 0;
    const url = await serve((req, res) => {
      res.writeHead(200, { "content-type": "application/json" }); // chunked: no content-length
      res.write('{"a":"');
      const timer = setInterval(() => {
        written += 200;
        res.write("x".repeat(200));
      }, 10);
      res.on("close", () => {
        closed = true;
        clearInterval(timer);
      });
    });
    const message = await messageOf(fetchJson(url, AUTH, "the thing", { timeoutMs: 5000, maxBytes: 1024 }));
    expect(message).toBe("the thing sent more than the 1024-byte cap");
    await vi.waitFor(() => expect(closed).toBe(true), { timeout: 2000 });
    expect(written).toBeLessThan(100 * 1024);
  }, TEST_TIMEOUT);

  it("refuses a declared content-length over the cap before reading the body", async () => {
    const url = await serve((req, res) => {
      res.writeHead(200, { "content-length": "5000", "content-type": "application/json" });
      res.write("{"); // the rest never comes
    });
    const message = await messageOf(fetchJson(url, AUTH, "the thing", { timeoutMs: 5000, maxBytes: 1024 }));
    expect(message).toBe("the thing sent 5000 bytes, over the 1024-byte cap");
  }, TEST_TIMEOUT);

  it("times out when the headers never arrive, naming the limit used", async () => {
    const url = await serve(() => {});
    const message = await messageOf(fetchJson(url, AUTH, "the thing", { timeoutMs: 1000, maxBytes: 1024 }));
    expect(message).toBe("the thing did not answer within 1s");
  }, TEST_TIMEOUT);

  it("times out when the headers arrive and the body stalls", async () => {
    const url = await serve((req, res) => {
      res.writeHead(200, { "content-type": "application/json" });
      res.write('{"a":');
    });
    const message = await messageOf(fetchJson(url, AUTH, "the thing", { timeoutMs: 1000, maxBytes: 1024 }));
    expect(message).toBe("the thing did not answer within 1s");
  }, TEST_TIMEOUT);

  it("reports a non-2xx answer by status", async () => {
    const url = await serve((req, res) => {
      res.writeHead(503);
      res.end("down");
    });
    const message = await messageOf(fetchJson(url, AUTH, "the thing", { timeoutMs: 1000, maxBytes: 1024 }));
    expect(message).toBe("the thing answered 503");
  }, TEST_TIMEOUT);
});

describe("fetchJson against a stubbed fetch", () => {
  it("cancels the body stream once the count passes the cap, holding about one chunk past it", async () => {
    let pulled = 0;
    const cancel = vi.fn();
    const body = new ReadableStream({
      pull(controller) {
        pulled += 1;
        controller.enqueue(new TextEncoder().encode("x".repeat(400)));
      },
      cancel,
    });
    vi.stubGlobal("fetch", async () => ({ ok: true, status: 200, headers: new Headers(), body }));
    const message = await messageOf(fetchJson("https://example.test/x", {}, "the thing", { timeoutMs: 1000, maxBytes: 1024 }));
    expect(message).toBe("the thing sent more than the 1024-byte cap");
    expect(cancel).toHaveBeenCalled();
    expect(pulled).toBeLessThanOrEqual(6); // cap 1024 / chunk 400 = 3 chunks to pass it, plus read-ahead slack
  });

  it("still checks the size after parsing when the response has only json()", async () => {
    vi.stubGlobal("fetch", async () => ({ ok: true, status: 200, headers: new Headers(), json: async () => ({ big: "y".repeat(3000) }) }));
    const message = await messageOf(fetchJson("https://example.test/x", {}, "the thing", { timeoutMs: 1000, maxBytes: 1024 }));
    expect(message).toBe("the thing sent more than the 1024-byte cap");
  });

  it("parses a json()-only response under the cap", async () => {
    vi.stubGlobal("fetch", async () => ({ ok: true, status: 200, headers: new Headers(), json: async () => ({ fine: 1 }) }));
    expect(await fetchJson("https://example.test/x", {}, "the thing", { timeoutMs: 1000, maxBytes: 1024 })).toEqual({ fine: 1 });
  });
});

describe("fetchJson errors never leak (R4)", () => {
  const leaks = (text) => text.includes("fake-placeholder-query") || text.includes("private_token") || text.includes(FAKE_TOKEN) || text.includes("Bearer");

  it("leaks nothing on a non-2xx answer or an unreachable host", async () => {
    const url = await serve((req, res) => {
      res.writeHead(500);
      res.end();
    });
    const answered = await messageOf(fetchJson(url, AUTH, "the thing", { timeoutMs: 1000, maxBytes: 1024 }));
    expect(leaks(answered)).toBe(false);
    for (const server of servers) await new Promise((resolve) => server.close(resolve));
    servers = [];
    const unreachable = await messageOf(fetchJson(url, AUTH, "the thing", { timeoutMs: 1000, maxBytes: 1024 }));
    expect(unreachable).toMatch(/^the thing could not be reached/u);
    expect(leaks(unreachable)).toBe(false);
  }, TEST_TIMEOUT);

  it("leaks nothing on a cap, a declared size or a timeout", async () => {
    const big = await serve((req, res) => {
      res.writeHead(200);
      res.end("x".repeat(5000));
    });
    const declared = await serve((req, res) => {
      res.writeHead(200, { "content-length": "5000" });
      res.write("{");
    });
    const stalled = await serve(() => {});
    for (const url of [big, declared, stalled]) {
      const message = await messageOf(fetchJson(url, AUTH, "the thing", { timeoutMs: 1000, maxBytes: 1024 }));
      expect(message).toMatch(/^the thing (sent|did not answer)/u);
      expect(leaks(message)).toBe(false);
    }
  }, TEST_TIMEOUT);
});

// --- temp repos, a fake docker, an environment that is put back ----------------

let counter = 0;
function newRepo() {
  const dir = join(root, `repo-${counter++}`);
  mkdirSync(join(dir, "scripts", "ci"), { recursive: true });
  mkdirSync(join(dir, ".github", "workflows"), { recursive: true });
  const git = (...args) => {
    const r = spawnSync("git", args, { cwd: dir, encoding: "utf8", env: { ...process.env, GIT_CONFIG_GLOBAL: "/dev/null", GIT_CONFIG_SYSTEM: "/dev/null" } });
    if (r.status !== 0) throw new Error(`git ${args.join(" ")}: ${r.stderr}`);
  };
  git("init", "-q", "-b", "dev");
  git("remote", "add", "origin", join(root, "no-such-remote.git"));
  writeFileSync(
    join(dir, ".github", "workflows", "publish-from-gitlab.yml"),
    "env:\n  GITHUB_HANDOFF_REPO: ${{ github.repository_owner }}/orbit-handoff\n",
  );
  return dir;
}

function writeExec(path, content) {
  mkdirSync(dirname(path), { recursive: true });
  writeFileSync(path, content);
  chmodSync(path, 0o755);
}

const savedEnv = { ...process.env };
let binDir;
let dockerDump;

/** A fake `docker` that prints a digest and records its own environment. */
function installFakeDocker() {
  binDir = join(root, `bin-${counter++}`);
  dockerDump = join(binDir, "docker-env.txt");
  writeExec(join(binDir, "docker"), `#!/bin/bash\nenv > "${dockerDump}"\necho "Digest: ${DIGEST}"\n`);
  process.env.PATH = `${binDir}${delimiter}${savedEnv.PATH}`;
}

beforeEach(() => {
  process.env.CI_COMMIT_SHA = SHA;
  delete process.env.CI_MERGE_REQUEST_SOURCE_BRANCH_SHA;
});

afterEach(() => {
  for (const key of Object.keys(process.env)) if (!(key in savedEnv)) delete process.env[key];
  Object.assign(process.env, savedEnv);
});

const envNames = (path) =>
  new Set(
    readFileSync(path, "utf8")
      .split("\n")
      .map((line) => /^([A-Za-z_][A-Za-z0-9_]*)=/u.exec(line)?.[1])
      .filter(Boolean),
  );

describe("handoffRepository", () => {
  it("reads the repository name from the publish workflow", () => {
    expect(handoffRepository(newRepo())).toBe("tomlawesome/orbit-handoff");
  });

  it("throws when the line is missing", () => {
    const dir = newRepo();
    writeFileSync(join(dir, ".github", "workflows", "publish-from-gitlab.yml"), "env:\n  OTHER: value\n");
    expect(() => handoffRepository(dir)).toThrow(/no longer names the handoff repository/u);
  });
});

describe("ghcrImage handoff lookup", () => {
  const lookup = async (fetchStub) => {
    installFakeDocker();
    vi.stubGlobal("fetch", fetchStub);
    return realLookups({ repoDir: newRepo(), target: "preview" }).ghcrImage();
  };

  it("answers handoff: false on a 404", async () => {
    const result = await lookup(async () => ({ ok: false, status: 404, headers: new Headers() }));
    expect(result).toEqual({ shaTag: true, previewTag: true, handoff: false });
  });

  it("answers handoff: true for a published release", async () => {
    const result = await lookup(async () => ({ ok: true, status: 200, headers: new Headers(), json: async () => ({ draft: false }) }));
    expect(result.handoff).toBe(true);
  });

  it("throws on a 500", async () => {
    await expect(lookup(async () => ({ ok: false, status: 500, headers: new Headers() }))).rejects.toThrow(/answered 500$/u);
  });

  it("throws on a timeout", async () => {
    await expect(
      lookup(async () => {
        throw new DOMException("timed out", "TimeoutError");
      }),
    ).rejects.toThrow(/did not answer within 30s$/u);
  });
});

describe("evidenceAgeDays", () => {
  const withEvidence = (script) => {
    installFakeDocker();
    const dir = newRepo();
    writeExec(join(dir, "scripts", "ci", "verify-validation-evidence.sh"), `#!/bin/bash\n${script}\n`);
    return realLookups({ repoDir: dir, target: "preview" }).evidenceAgeDays();
  };
  const recordedTwoDaysAgo = () => new Date(Date.now() - 2 * 86_400_000).toISOString().replace(/\.\d+Z$/u, "Z");

  for (const code of [0, 13]) {
    it(`returns the age in days when the script exits ${code} with a recorded time`, async () => {
      const age = await withEvidence(`echo "recorded at ${recordedTwoDaysAgo()}"\nexit ${code}`);
      expect(age).toBeGreaterThan(1.9);
      expect(age).toBeLessThan(2.1);
    });
  }

  it("throws naming the exit for any other exit code", async () => {
    await expect(withEvidence(`echo "recorded at ${recordedTwoDaysAgo()}"\nexit 1`)).rejects.toThrow(/verify-validation-evidence\.sh exited 1/u);
  });

  it("throws naming the exit when there is no recorded time", async () => {
    await expect(withEvidence("echo nothing here\nexit 0")).rejects.toThrow(/verify-validation-evidence\.sh exited 0/u);
  });
});

describe("runWithLimit", () => {
  it("is exported", () => {
    expect(typeof readiness.runWithLimit).toBe("function");
  });

  it("throws when a child outlives its timeout", () => {
    expect(() => readiness.runWithLimit(process.execPath, ["-e", "setTimeout(() => {}, 30000)"], { timeout: 300 })).toThrow(/did not finish within/u);
  });

  it("returns the result of a child that finishes in time", () => {
    const result = readiness.runWithLimit(process.execPath, ["-e", "process.stdout.write('hi')"], { timeout: 5000 });
    expect(result.status).toBe(0);
    expect(result.stdout).toBe("hi");
  });
});

describe("child script environment (R5)", () => {
  const ALLOWED = new Set(
    "PATH HOME USER LANG LC_ALL LC_CTYPE TZ TMPDIR XDG_RUNTIME_DIR DOCKER_CONFIG DOCKER_HOST SSL_CERT_FILE SSL_CERT_DIR NODE_EXTRA_CA_CERTS HTTP_PROXY HTTPS_PROXY NO_PROXY http_proxy https_proxy no_proxy".split(" "),
  );
  const SHELL_EXTRAS = new Set(["PWD", "SHLVL", "OLDPWD", "_"]);
  const FORBIDDEN = ["ORBIT_REUSE_TOKEN", "GITLAB_TOKEN", "CI_JOB_TOKEN", "CI_COMMIT_SHA", "ORBIT_UNRELATED_SETTING"];

  beforeEach(() => {
    process.env.ORBIT_REUSE_TOKEN = FAKE_TOKEN;
    process.env.GITLAB_TOKEN = FAKE_TOKEN;
    process.env.CI_JOB_TOKEN = FAKE_TOKEN;
    process.env.ORBIT_UNRELATED_SETTING = "fake-placeholder-value";
    process.env.TZ = "UTC";
    process.env.HTTPS_PROXY = "http://proxy.invalid:3128";
  });

  const nodeStub = (dump, body = "") =>
    `import { appendFileSync } from "node:fs";\nappendFileSync(${JSON.stringify(dump)}, Object.entries(process.env).map(([k, v]) => k + "=" + v).join("\\n") + "\\n");\n${body}\n`;
  const bashStub = (dump, body = "") => `#!/bin/bash\nenv >> "${dump}"\n${body}\n`;

  function expectNarrow(dump, extraAllowed = []) {
    const names = envNames(dump);
    expect(names.has("PATH")).toBe(true);
    for (const name of FORBIDDEN) expect(names.has(name), `${name} reached the child`).toBe(false);
    for (const name of names) {
      expect(ALLOWED.has(name) || SHELL_EXTRAS.has(name) || extraAllowed.includes(name), `${name} is not on the allowlist`).toBe(true);
    }
    const text = readFileSync(dump, "utf8");
    expect(text).not.toContain(FAKE_TOKEN);
    expect(text).toContain("TZ=UTC");
    expect(text).toContain("HTTPS_PROXY=http://proxy.invalid:3128");
  }

  function setup() {
    installFakeDocker();
    const dir = newRepo();
    const dump = join(root, `child-env-${counter++}.txt`);
    writeFileSync(dump, "");
    writeFileSync(join(dir, "scripts", "release-line.json"), "{}");
    return { dir, dump, lookups: realLookups({ repoDir: dir, target: "preview" }) };
  }

  it("passes calculate-version.mjs only the allowlist", async () => {
    const { dir, dump, lookups } = setup();
    writeFileSync(join(dir, "scripts", "calculate-version.mjs"), nodeStub(dump, 'console.log("v0.0.1");'));
    await lookups.version();
    expectNarrow(dump);
  });

  it("passes check-base-image-current.sh only the allowlist", async () => {
    const { dir, dump, lookups } = setup();
    writeExec(join(dir, "scripts", "check-base-image-current.sh"), bashStub(dump));
    await lookups.baseImageCurrent();
    expectNarrow(dump);
  });

  it("passes sidecar-pins.mjs only the allowlist", async () => {
    const { dir, dump, lookups } = setup();
    writeFileSync(join(dir, "scripts", "sidecar-pins.mjs"), nodeStub(dump));
    await lookups.sidecarPinsCurrent();
    expectNarrow(dump);
  });

  it("passes ci/upgrade-versions.mjs only the allowlist", async () => {
    const { dir, dump, lookups } = setup();
    writeFileSync(
      join(dir, "scripts", "ci", "upgrade-versions.mjs"),
      nodeStub(dump, 'console.log(process.argv.includes("--manifest-lists") ? \'  "updateFrom": [],\' : "ORBIT_UPGRADE_MATRIX=true");'),
    );
    await lookups.upgradeMatrix().catch(() => {}); // the later git ls-remote has no remote to ask; the scripts have run by then
    expectNarrow(dump);
  });

  it("passes verify-validation-evidence.sh the allowlist plus the evidence ORBIT_* values", async () => {
    const { dir, dump, lookups } = setup();
    writeExec(join(dir, "scripts", "ci", "verify-validation-evidence.sh"), bashStub(dump, 'echo "recorded at 2026-11-10T00:00:00Z"'));
    await lookups.evidenceAgeDays();
    expectNarrow(dump, ["ORBIT_IMAGE", "ORBIT_DIGEST", "ORBIT_COMMIT", "ORBIT_REF"]);
    const text = readFileSync(dump, "utf8");
    expect(text).toContain("ORBIT_IMAGE=ghcr.io/tomlawesome/orbit");
    expect(text).toContain(`ORBIT_DIGEST=${DIGEST}`);
    expect(text).toContain(`ORBIT_COMMIT=${SHA}`);
    expect(text).toContain("ORBIT_REF=preview");
  });

  it("leaves docker the full environment", async () => {
    const { dir, lookups } = setup();
    writeExec(join(dir, "scripts", "ci", "verify-validation-evidence.sh"), '#!/bin/bash\necho "recorded at 2026-11-10T00:00:00Z"\n');
    await lookups.evidenceAgeDays();
    const names = envNames(dockerDump);
    expect(names.has("ORBIT_UNRELATED_SETTING")).toBe(true);
    expect(names.has("PATH")).toBe(true);
  });
});
