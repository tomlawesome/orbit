import { spawn } from "node:child_process";
import { createHash } from "node:crypto";
import { chmodSync, existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { createServer } from "node:http";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterEach, describe, expect, it } from "vitest";

// #1738 D-S2/D-S4 review: launcher_install_compat does not depend on how long
// the launcher archive lasts. scripts/ci/provide-launcher-archive.mjs <dir>
// downloads this pipeline's archive; when it has expired it rebuilds it, and a
// rebuild must match the archive hash in the signed release manifest when one
// exists, or the job fails.

const script = new URL("./provide-launcher-archive.mjs", import.meta.url).pathname;
const ARCHIVE = "orbit-launcher_linux_amd64.tar.gz";
const sha = (text) => `sha256:${createHash("sha256").update(text).digest("hex")}`;
const dirs = [];
const servers = [];
afterEach(() => {
  for (const s of servers.splice(0)) s.close();
  for (const d of dirs.splice(0)) rmSync(d, { recursive: true, force: true });
});

async function world({ archive, manifest, jobs }) {
  const requests = [];
  const server = createServer((req, res) => {
    requests.push(req.url);
    const url = new URL(req.url, "http://x");
    if (url.pathname.endsWith("/pipelines/7/jobs")) {
      res.setHeader("content-type", "application/json");
      return res.end(JSON.stringify(jobs));
    }
    if (url.pathname.endsWith(`/jobs/11/artifacts/.orbit-launcher-artifacts/${ARCHIVE}`) && archive !== undefined) return res.end(archive);
    if (url.pathname.endsWith("/jobs/22/artifacts/.orbit-supply-chain/orbit-release-manifest.json") && manifest !== undefined) {
      return res.end(JSON.stringify(manifest));
    }
    res.statusCode = 404;
    res.end("gone");
  });
  await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
  servers.push(server);
  return { base: `http://127.0.0.1:${server.address().port}/api/v4`, requests };
}

async function run(api, { built = "rebuilt-bytes" } = {}) {
  const dir = mkdtempSync(join(tmpdir(), "provide-launcher-"));
  dirs.push(dir);
  const build = join(dir, "build.sh");
  writeFileSync(build, `#!/usr/bin/env bash\nmkdir -p "$1"\nprintf '%s' '${built}' > "$1/${ARCHIVE}"\necho built > "${dir}/built-marker"\n`);
  chmodSync(build, 0o755);
  const out = join(dir, "artifacts");
  const child = spawn(process.execPath, [script, out], {
    env: {
      ...process.env,
      CI_API_V4_URL: api.base,
      CI_PROJECT_ID: "5",
      CI_PIPELINE_ID: "7",
      CI_JOB_TOKEN: "t",
      ORBIT_LAUNCHER_BUILD_SCRIPT: build,
    },
  });
  let stdout = "";
  let stderr = "";
  child.stdout.on("data", (c) => { stdout += c; });
  child.stderr.on("data", (c) => { stderr += c; });
  const status = await new Promise((resolve) => child.on("close", resolve));
  const r = { status, stdout, stderr };
  return { r, out, rebuilt: existsSync(join(dir, "built-marker")) };
}

const jobs = [
  { id: 11, name: "build_launcher_branch", status: "success" },
  { id: 22, name: "record_image", status: "success" },
];

describe("scripts/ci/provide-launcher-archive.mjs", () => {
  it("uses the pipeline's own archive when it is still there, building nothing", async () => {
    const { r, out, rebuilt } = await run(await world({ archive: "original", jobs }));
    expect(r.status, r.stderr).toBe(0);
    expect(readFileSync(join(out, ARCHIVE), "utf8")).toBe("original");
    expect(rebuilt).toBe(false);
  });

  it("rebuilds an expired archive and accepts it when it matches the signed manifest", async () => {
    const { r, out, rebuilt } = await run(await world({ jobs, manifest: { files: { [ARCHIVE]: sha("rebuilt-bytes") } } }));
    expect(r.status, r.stderr).toBe(0);
    expect(rebuilt).toBe(true);
    expect(readFileSync(join(out, ARCHIVE), "utf8")).toBe("rebuilt-bytes");
  });

  it("fails when the rebuilt archive differs from the signed manifest's", async () => {
    const { r } = await run(await world({ jobs, manifest: { files: { [ARCHIVE]: sha("other-bytes") } } }));
    expect(r.status).not.toBe(0);
    expect(r.stderr).toMatch(/differs from the release manifest/iu);
  });

  it("rebuilds when no manifest exists yet, saying so", async () => {
    const { r, rebuilt } = await run(await world({ jobs: [jobs[0]] }));
    expect(r.status, r.stderr).toBe(0);
    expect(rebuilt).toBe(true);
    expect(r.stdout).toMatch(/no release manifest/iu);
  });
});

describe(".gitlab-ci.yml launcher_install_compat with an expired archive", () => {
  const pipeline = readFileSync(new URL("../../.gitlab-ci.yml", import.meta.url), "utf8");
  const start = pipeline.indexOf("\nlauncher_install_compat:\n");
  const job = pipeline.slice(start, pipeline.indexOf("\n  variables:", start));

  it("does not let GitLab fail the job on expired launcher artifacts: they are not downloaded by needs", () => {
    for (const name of ["build_launcher", "build_launcher_branch"]) {
      const at = job.indexOf(`- job: ${name}\n`);
      expect(at, name).toBeGreaterThan(-1);
      expect(job.slice(at, at + 80)).toMatch(/artifacts: false/u);
    }
  });

  it("fetches or rebuilds the archive in the script through the helper", () => {
    expect(pipeline.slice(start)).toContain("node scripts/ci/provide-launcher-archive.mjs");
  });
});
