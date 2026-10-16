import { spawn } from "node:child_process";
import { chmodSync, existsSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { afterEach, describe, expect, it, vi } from "vitest";

import { PROCESS_TEST_TIMEOUT_MS } from "../process-budget.mjs";

// Each test runs the real script under bash; budget in scripts/process-budget.mjs.
vi.setConfig({ testTimeout: PROCESS_TEST_TIMEOUT_MS });

// The preview script must be told exactly which build to fetch: a pinned
// ORBIT_PREVIEW_DIGEST of the form sha256:<64 hex characters>, and the place
// to fetch from, ORBIT_PREVIEW_BASE_URL. It must refuse before fetching or
// verifying anything when either is missing or malformed. The base is an
// http URL, so curl is the fetch path, and a stub curl records any call:
// "nothing is fetched" is checked, not assumed.

const script = join(dirname(fileURLToPath(import.meta.url)), "get-orbit-preview.sh");
const SHORT_DEADLINE_MS = 10_000;

const scratchDirs = [];
afterEach(() => {
  while (scratchDirs.length > 0) rmSync(scratchDirs.pop(), { recursive: true, force: true });
});

function run(extraEnv, { baseUrl = true } = {}) {
  const dir = mkdtempSync(join(tmpdir(), "orbit-preview-"));
  scratchDirs.push(dir);
  const bin = join(dir, "bin");
  const calls = join(dir, "calls.log");
  mkdirSync(bin);
  writeFileSync(join(bin, "curl"), `#!/usr/bin/env bash\necho "curl $*" >> "${calls}"\nexit 1\n`);
  chmodSync(join(bin, "curl"), 0o755);

  const env = { PATH: `${bin}:/usr/bin:/bin`, HOME: dir, TMPDIR: dir };
  if (baseUrl) env.ORBIT_PREVIEW_BASE_URL = "http://127.0.0.1:1";
  Object.assign(env, extraEnv);

  return new Promise((resolve, reject) => {
    // stdin stays open (a pipe nobody writes to or closes): the script must
    // decide without waiting for input.
    const child = spawn("bash", [script], { env, stdio: ["pipe", "pipe", "pipe"] });
    let stdout = "";
    let stderr = "";
    let killed = false;
    child.stdout.on("data", (c) => (stdout += c));
    child.stderr.on("data", (c) => (stderr += c));
    const timer = setTimeout(() => {
      killed = true;
      child.kill("SIGKILL");
    }, SHORT_DEADLINE_MS);
    child.on("error", (e) => {
      clearTimeout(timer);
      reject(e);
    });
    child.on("close", (status) => {
      clearTimeout(timer);
      if (killed) {
        reject(new Error(`get-orbit-preview.sh did not exit within ${SHORT_DEADLINE_MS}ms\n${stdout}\n${stderr}`));
        return;
      }
      child.stdin.destroy();
      resolve({ status, stdout, stderr, called: existsSync(calls) });
    });
  });
}

describe("get-orbit-preview.sh pinned digest", () => {
  it("refuses when ORBIT_PREVIEW_DIGEST is unset, and fetches nothing", async () => {
    const r = await run({});
    expect(r.status).toBe(1);
    expect(r.stderr).toContain("ORBIT_PREVIEW_DIGEST");
    expect(r.called).toBe(false);
  });

  it("refuses when ORBIT_PREVIEW_DIGEST is empty", async () => {
    const r = await run({ ORBIT_PREVIEW_DIGEST: "" });
    expect(r.status).toBe(1);
    expect(r.stderr).toContain("ORBIT_PREVIEW_DIGEST");
    expect(r.called).toBe(false);
  });

  it("refuses a malformed digest and says the expected form", async () => {
    const r = await run({ ORBIT_PREVIEW_DIGEST: "sha256:abc" });
    expect(r.status).toBe(1);
    expect(r.stderr).toContain("sha256:<64 hex characters>");
    expect(r.called).toBe(false);
  });

  it("refuses when ORBIT_PREVIEW_BASE_URL is unset", async () => {
    const r = await run({ ORBIT_PREVIEW_DIGEST: `sha256:${"a".repeat(64)}` }, { baseUrl: false });
    expect(r.status).toBe(1);
    expect(r.stderr).toContain("ORBIT_PREVIEW_BASE_URL");
  });
});
