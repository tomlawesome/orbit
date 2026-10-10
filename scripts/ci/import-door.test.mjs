/**
 * scripts/ci/import-door.sh and scripts/ci/check-door-unchanged.sh (#1371,
 * items 2-6 of the specification), driven end to end with no network: the
 * fake orbit-site is a local git repository, the fake GitLab is a small HTTP
 * server in this process, and the remote Orbit pushes to is a local bare
 * repository. Same shape as scripts/ci/repin-base-image.test.mjs (scratch
 * repository carrying a copy of the scripts, bare repository for the push),
 * run under Vitest.
 *
 * Written from the issue's specification alone, before the scripts existed.
 * The specification fixes WHAT happens, not how a test reaches it, so the
 * seams below are this suite's assumption of the script's interface; the
 * script has to accept them (all are unset in production, where the CI
 * variables and the real project name apply):
 *
 *   DOOR_IMPORT_UPSTREAM_URL  where to clone orbit-site from (a local path here)
 *   DOOR_IMPORT_PUSH_URL      where to push the branch (a local bare repository)
 *   DOOR_IMPORT_TOKEN         the project token (a fake value)
 *   CI_API_V4_URL, CI_SERVER_URL, CI_PROJECT_ID, CI_PROJECT_PATH
 *                             the predefined CI variables, pointed at the fake GitLab
 *
 * The scripts find the repository root from their own location (two levels
 * up from scripts/ci/), as repin-base-image.sh does, so the suite copies
 * scripts/ci into the scratch repository and runs them there.
 */
import { spawn, spawnSync } from "node:child_process";
import {
  cpSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  unlinkSync,
  writeFileSync,
} from "node:fs";
import { createServer } from "node:http";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";

import { PROCESS_DEADLINE_MS, PROCESS_TEST_TIMEOUT_MS } from "../process-budget.mjs";

/* Each test runs the import once or twice, plus git; well inside this on a quiet host, generous on a busy one. */
vi.setConfig({ testTimeout: PROCESS_TEST_TIMEOUT_MS * 2 });

const ciDir = import.meta.dirname;
const FAKE_TOKEN = "fake-door-import-token";

const scratchDirs = [];
const servers = [];

afterEach(async () => {
  while (servers.length > 0) await servers.pop().close();
  while (scratchDirs.length > 0) rmSync(scratchDirs.pop(), { recursive: true, force: true });
});

function scratchDir(prefix) {
  const dir = mkdtempSync(join(tmpdir(), prefix));
  scratchDirs.push(dir);
  return dir;
}

const gitEnv = {
  GIT_CONFIG_NOSYSTEM: "1",
  GIT_TERMINAL_PROMPT: "0",
  GIT_AUTHOR_NAME: "Test",
  GIT_AUTHOR_EMAIL: "test@example.invalid",
  GIT_COMMITTER_NAME: "Test",
  GIT_COMMITTER_EMAIL: "test@example.invalid",
};

function git(cwd, args, { buffer = false } = {}) {
  const result = spawnSync("git", args, {
    cwd,
    encoding: buffer ? "buffer" : "utf8",
    env: { PATH: process.env.PATH, HOME: tmpdir(), ...gitEnv },
  });
  if (result.status !== 0) {
    throw new Error(`git ${args.join(" ")} in ${cwd} failed: ${result.stderr}`);
  }
  return result.stdout;
}

/* ---------------------------------------------------------------- upstream */

/** Bytes that would not survive a text round trip: CRLF, a NUL, high bytes. */
const BINARY = Buffer.from([0x52, 0x49, 0x46, 0x46, 0x00, 0xff, 0xfe, 0x0d, 0x0a, 0x80, 0x00, 0x0a]);

const doorFiles = {
  "README.md": "# The shared door\r\nwith CRLF line ends\r\n",
  "index.js": 'export { createDoor } from "./journey.js";\n',
  "settings.js": "export const settings = { storagePrefix: 'orbit' };\n",
  "journey.js": "export function createDoor() {}\n",
  "stale-soon.js": "// present in the first upstream commit only\n",
  "img/dawn/dawn.webp": BINARY,
  "img/dawn/lights-strip-120.webp": Buffer.from("strip-120"),
  "img/flight/moon.webp": Buffer.concat([BINARY, BINARY]),
  "empty.txt": "",
};

function writeTree(dir, files) {
  for (const [name, content] of Object.entries(files)) {
    const file = join(dir, name);
    mkdirSync(dirname(file), { recursive: true });
    writeFileSync(file, content);
  }
}

/**
 * A local git repository standing in for ai/orbit-site, branch `main`, with
 * the door under assets/door/ and other things around it that must not be
 * copied.
 */
function deployUpstream(files = doorFiles) {
  const dir = scratchDir("orbit-door-upstream-");
  git(dir, ["init", "--quiet", "--initial-branch=main"]);
  writeTree(join(dir, "assets", "door"), files);
  writeTree(dir, {
    "README.md": "the site\n",
    "assets/js/journeys.js": "// the site's own, not the door\n",
    "docs/adr/0001.md": "an ADR\n",
  });
  git(dir, ["add", "-A"]);
  git(dir, ["commit", "--quiet", "-m", "the door, first"]);
  return dir;
}

function upstreamCommit(dir) {
  return git(dir, ["rev-parse", "main"]).trim();
}

/** A second upstream commit: one door file edited, one gone, one added, one binary replaced. */
function advanceUpstream(dir) {
  const door = join(dir, "assets", "door");
  writeFileSync(join(door, "index.js"), 'export { createDoor } from "./journey.js"; // v2\n');
  unlinkSync(join(door, "stale-soon.js"));
  writeFileSync(join(door, "dusk.js"), "export const dusk = 1;\n");
  writeFileSync(join(door, "img", "dawn", "dawn.webp"), Buffer.concat([BINARY, Buffer.from([0x01])]));
  git(dir, ["add", "-A"]);
  git(dir, ["commit", "--quiet", "-m", "the door, second"]);
}

/** A commit upstream that leaves assets/door/ exactly as it was. */
function touchUpstreamElsewhere(dir) {
  writeFileSync(join(dir, "docs", "adr", "0002.md"), "another ADR\n");
  git(dir, ["add", "-A"]);
  git(dir, ["commit", "--quiet", "-m", "something outside the door"]);
}

/** The door as upstream has it at main: path -> Buffer. */
function upstreamDoor(dir) {
  const out = {};
  const names = git(dir, ["ls-tree", "-r", "--name-only", "main", "assets/door/"]).split("\n").filter(Boolean);
  for (const name of names) {
    out[name.slice("assets/door/".length)] = git(dir, ["show", `main:${name}`], { buffer: true });
  }
  return out;
}

/* ------------------------------------------------------------------ orbit */

const OLD_STALE_FILE = "web/src/lib/door/only-in-old-copy.js";

/**
 * A scratch Orbit checkout on `dev`: the scripts under test (the whole of
 * scripts/ci, copied), an older copy of the door that has a file upstream no
 * longer has, and a host module the import must leave alone.
 */
function deployOrbit() {
  const dir = scratchDir("orbit-door-orbit-");
  mkdirSync(join(dir, "scripts"), { recursive: true });
  cpSync(ciDir, join(dir, "scripts", "ci"), {
    recursive: true,
    filter: (source) => !source.endsWith(".test.mjs"),
  });
  writeTree(dir, {
    "web/src/lib/door/index.js": "// an older copy\n",
    [OLD_STALE_FILE]: "// gone upstream\n",
    "web/src/lib/door-host.js": "// Orbit's own host module\n",
    "README.md": "orbit\n",
  });
  git(dir, ["init", "--quiet", "--initial-branch=dev"]);
  git(dir, ["config", "user.email", "test@example.invalid"]);
  git(dir, ["config", "user.name", "Test"]);
  git(dir, ["add", "-A"]);
  git(dir, ["commit", "--quiet", "-m", "initial"]);
  return dir;
}

function deployBare(fromRepo) {
  const dir = scratchDir("orbit-door-bare-");
  git(dir, ["init", "--quiet", "--bare", "--initial-branch=dev"]);
  if (fromRepo) git(fromRepo, ["push", "--quiet", dir, "dev"]);
  return dir;
}

function remoteBranches(bare) {
  return git(bare, ["for-each-ref", "--format=%(refname:short)", "refs/heads/"]).split("\n").filter(Boolean);
}

/* --------------------------------------------------------------- fake GitLab */

/**
 * A fake GitLab API: merge requests listed, created, closed; branches deleted
 * (from the bare repository, so a script that deletes branches by `git push
 * --delete` instead ends in the same state). `requests` records every call in
 * order. Open merge requests it is seeded with are filtered by the script
 * itself: the list endpoint returns every open one.
 */
async function startGitLab({ bare, seed = [] }) {
  const mrs = seed.map((mr, i) => ({ iid: 100 + i, state: "opened", target_branch: "dev", ...mr }));
  const requests = [];
  let nextIid = 500;

  const server = createServer((req, res) => {
    const chunks = [];
    req.on("data", (chunk) => chunks.push(chunk));
    req.on("end", () => {
      const url = new URL(req.url, "http://fake.invalid");
      const raw = Buffer.concat(chunks).toString("utf8");
      let body = {};
      if (raw) {
        try {
          body = JSON.parse(raw);
        } catch {
          body = Object.fromEntries(new URLSearchParams(raw));
        }
      }
      for (const [k, v] of url.searchParams) body[k] ??= v;
      const path = decodeURIComponent(url.pathname).replace(/^\/api\/v4/u, "");
      requests.push({ method: req.method, path, body });

      const send = (status, payload = {}) => {
        res.writeHead(status, { "content-type": "application/json" });
        res.end(JSON.stringify(payload));
      };

      let m;
      if (req.method === "GET" && /\/merge_requests$/u.test(path)) {
        const wanted = body.state ?? "opened";
        return send(200, mrs.filter((mr) => wanted === "all" || mr.state === wanted));
      }
      if (req.method === "POST" && /\/merge_requests$/u.test(path)) {
        const mr = {
          iid: nextIid++,
          state: "opened",
          source_branch: body.source_branch,
          target_branch: body.target_branch,
          title: body.title ?? "",
          description: body.description ?? "",
          web_url: `http://fake.invalid/mr/${nextIid}`,
        };
        mrs.push(mr);
        return send(201, mr);
      }
      if ((m = path.match(/\/merge_requests\/(\d+)$/u)) && req.method === "PUT") {
        const mr = mrs.find((candidate) => candidate.iid === Number(m[1]));
        if (!mr) return send(404, { message: "404 Not Found" });
        if (body.state_event === "close") mr.state = "closed";
        return send(200, mr);
      }
      if ((m = path.match(/\/merge_requests\/(\d+)\/notes$/u))) return send(201, {});
      if ((m = path.match(/\/repository\/branches\/(.+)$/u)) && req.method === "DELETE") {
        try {
          git(bare, ["branch", "-D", m[1]]);
        } catch {
          return send(404, { message: "404 Branch Not Found" });
        }
        res.writeHead(204);
        return res.end();
      }
      return send(404, { message: `fake GitLab: nothing at ${req.method} ${path}` });
    });
  });

  await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
  const url = `http://127.0.0.1:${server.address().port}`;
  const handle = {
    url,
    mrs,
    requests,
    close: () => new Promise((resolve) => server.close(resolve)),
  };
  servers.push(handle);
  return handle;
}

/* ---------------------------------------------------------------- running */

function run(cmd, args, { cwd, env }) {
  return new Promise((resolve, reject) => {
    const child = spawn(cmd, args, { cwd, env, stdio: ["ignore", "pipe", "pipe"] });
    let stdout = "";
    let stderr = "";
    child.stdout.on("data", (d) => (stdout += d));
    child.stderr.on("data", (d) => (stderr += d));
    const timer = setTimeout(() => {
      child.kill("SIGKILL");
      reject(new Error(`${args[0]} killed on a ${PROCESS_DEADLINE_MS} ms deadline\nstdout:\n${stdout}\nstderr:\n${stderr}`));
    }, PROCESS_DEADLINE_MS);
    child.on("close", (status) => {
      clearTimeout(timer);
      resolve({ status, stdout, stderr });
    });
  });
}

/** Runs the real import script from the scratch Orbit checkout. */
function runImport({ orbit, upstream, bare, api }) {
  return run("bash", [join(orbit, "scripts", "ci", "import-door.sh")], {
    cwd: orbit,
    env: {
      PATH: process.env.PATH,
      HOME: scratchDir("orbit-door-home-"),
      ...gitEnv,
      DOOR_IMPORT_UPSTREAM_URL: upstream,
      DOOR_IMPORT_PUSH_URL: bare,
      DOOR_IMPORT_TOKEN: FAKE_TOKEN,
      CI_SERVER_URL: api.url,
      CI_API_V4_URL: `${api.url}/api/v4`,
      CI_PROJECT_ID: "49",
      CI_PROJECT_PATH: "ai/orbit",
      CI_SERVER_HOST: "gitlab.example.invalid",
      NO_PROXY: "127.0.0.1",
    },
  });
}

/** Runs the real check script with nothing but a PATH: no token, no URL, no network setting. */
function runCheck(orbit) {
  return run("bash", [join(orbit, "scripts", "ci", "check-door-unchanged.sh")], {
    cwd: orbit,
    env: { PATH: process.env.PATH, HOME: tmpdir() },
  });
}

/** A world: upstream, Orbit, bare remote and fake GitLab, ready to import. */
async function deployWorld({ upstream = deployUpstream(), seedMrs = [], seedBranches = [] } = {}) {
  const orbit = deployOrbit();
  const bare = deployBare(orbit);
  for (const name of seedBranches) git(orbit, ["push", "--quiet", bare, `dev:refs/heads/${name}`]);
  const api = await startGitLab({ bare, seed: seedMrs });
  return { upstream, orbit, bare, api };
}

const importedBranch = (bare) => remoteBranches(bare).filter((b) => b.startsWith("chore/door-import-"));

function pushedFile(bare, branch, path) {
  return git(bare, ["show", `${branch}:${path}`], { buffer: true });
}

function pushedDoor(bare, branch) {
  const out = {};
  const prefix = "web/src/lib/door/";
  for (const name of git(bare, ["ls-tree", "-r", "--name-only", branch, prefix]).split("\n").filter(Boolean)) {
    out[name.slice(prefix.length)] = pushedFile(bare, branch, name);
  }
  return out;
}

const ok = (result) => `stdout:\n${result.stdout}\nstderr:\n${result.stderr}`;

/** The one branch the import pushed, after a changed run. */
function onlyImportBranch(world) {
  const branches = importedBranch(world.bare);
  expect(branches, "branches pushed").toHaveLength(1);
  return branches[0];
}

/** The state after the merge request is merged: Orbit's dev is the pushed branch. */
function mergedOrbit(world) {
  const branch = onlyImportBranch(world);
  const dir = scratchDir("orbit-door-merged-");
  rmSync(dir, { recursive: true, force: true });
  git(tmpdir(), ["clone", "--quiet", "--branch", branch, world.bare, dir]);
  git(dir, ["checkout", "--quiet", "-B", "dev"]);
  git(dir, ["config", "user.email", "test@example.invalid"]);
  git(dir, ["config", "user.name", "Test"]);
  return dir;
}

/* ------------------------------------------------------------------ tests */

describe("import-door.sh copies the folder byte for byte (item 2)", () => {
  it("exits 0 and pushes the copy of assets/door/ into web/src/lib/door/, every file identical", async () => {
    const world = await deployWorld();
    const result = await runImport(world);
    expect(result.status, ok(result)).toBe(0);

    const branch = onlyImportBranch(world);
    const copy = pushedDoor(world.bare, branch);
    const expected = upstreamDoor(world.upstream);

    expect(Object.keys(copy).sort()).toEqual(Object.keys(expected).sort());
    for (const [name, bytes] of Object.entries(expected)) {
      expect(Buffer.compare(copy[name], bytes), `${name} differs from upstream`).toBe(0);
    }
  });

  it("copies binary files and empty files exactly", async () => {
    const world = await deployWorld();
    const result = await runImport(world);
    expect(result.status, ok(result)).toBe(0);
    const branch = onlyImportBranch(world);

    expect(Buffer.compare(pushedFile(world.bare, branch, "web/src/lib/door/img/dawn/dawn.webp"), BINARY)).toBe(0);
    expect(pushedFile(world.bare, branch, "web/src/lib/door/empty.txt")).toHaveLength(0);
    expect(pushedFile(world.bare, branch, "web/src/lib/door/README.md").toString("utf8")).toBe(doorFiles["README.md"]);
  });

  it("copies nothing from outside assets/door/", async () => {
    const world = await deployWorld();
    const result = await runImport(world);
    expect(result.status, ok(result)).toBe(0);
    const branch = onlyImportBranch(world);

    const everything = git(world.bare, ["ls-tree", "-r", "--name-only", branch]).split("\n").filter(Boolean);
    expect(everything.filter((n) => /journeys\.js|0001\.md|^docs\//u.test(n))).toEqual([]);
    expect(pushedFile(world.bare, branch, "web/src/lib/door-host.js").toString("utf8")).toBe("// Orbit's own host module\n");
  });

  it("deletes files that are gone upstream, including ones only the older copy had", async () => {
    const world = await deployWorld();
    advanceUpstream(world.upstream); // stale-soon.js is gone, dusk.js is new
    const result = await runImport(world);
    expect(result.status, ok(result)).toBe(0);

    const branch = onlyImportBranch(world);
    const copy = pushedDoor(world.bare, branch);
    expect(Object.keys(copy)).not.toContain("only-in-old-copy.js");
    expect(Object.keys(copy)).not.toContain("stale-soon.js");
    expect(Object.keys(copy)).toContain("dusk.js");
    expect(Object.keys(copy).sort()).toEqual(Object.keys(upstreamDoor(world.upstream)).sort());
  });

  it("takes the folder from main, not from another upstream branch", async () => {
    const upstream = deployUpstream();
    git(upstream, ["checkout", "--quiet", "-b", "dev"]);
    writeFileSync(join(upstream, "assets", "door", "index.js"), "// only on dev\n");
    git(upstream, ["commit", "--quiet", "-am", "not on main"]);
    git(upstream, ["checkout", "--quiet", "main"]);

    const world = await deployWorld({ upstream });
    const result = await runImport(world);
    expect(result.status, ok(result)).toBe(0);
    const text = pushedFile(world.bare, onlyImportBranch(world), "web/src/lib/door/index.js").toString("utf8");
    expect(text).toBe(doorFiles["index.js"]);
  });
});

describe("import-door.sh writes door.upstream.json (item 3)", () => {
  async function importedRecord(upstream) {
    const world = await deployWorld({ upstream });
    const result = await runImport(world);
    expect(result.status, ok(result)).toBe(0);
    const branch = onlyImportBranch(world);
    return JSON.parse(pushedFile(world.bare, branch, "web/src/lib/door.upstream.json").toString("utf8"));
  }

  it("holds project, ref, the full upstream commit, path and a sha256 tree, and nothing else", async () => {
    const upstream = deployUpstream();
    const record = await importedRecord(upstream);

    expect(Object.keys(record).sort()).toEqual(["commit", "path", "project", "ref", "tree"]);
    expect(record.project).toBe("ai/orbit-site");
    expect(record.ref).toBe("main");
    expect(record.commit).toBe(upstreamCommit(upstream));
    expect(record.commit).toMatch(/^[0-9a-f]{40}$/u);
    expect(record.path).toBe("assets/door");
    expect(record.tree).toMatch(/^[0-9a-f]{64}$/u);
  });

  it("the tree is the same for the same folder, wherever and whenever it is imported", async () => {
    const a = await importedRecord(deployUpstream());
    const b = await importedRecord(deployUpstream()); // another repo, another commit time
    expect(a.tree).toBe(b.tree);
  });

  it("the tree changes when one byte of one file changes", async () => {
    const before = await importedRecord(deployUpstream());
    const changed = deployUpstream({ ...doorFiles, "settings.js": "export const settings = { storagePrefix: 'orbiT' };\n" });
    const after = await importedRecord(changed);
    expect(after.tree).not.toBe(before.tree);
  });

  it("the tree changes when a file is renamed and its contents are not", async () => {
    const before = await importedRecord(deployUpstream());
    const { "journey.js": journey, ...rest } = doorFiles;
    const after = await importedRecord(deployUpstream({ ...rest, "journey2.js": journey }));
    expect(after.tree).not.toBe(before.tree);
  });

  it("the tree changes when a file is added, and when one is deleted", async () => {
    const before = await importedRecord(deployUpstream());
    const added = await importedRecord(deployUpstream({ ...doorFiles, "extra.js": "x\n" }));
    const { "stale-soon.js": _gone, ...without } = doorFiles;
    const deleted = await importedRecord(deployUpstream(without));
    expect(added.tree).not.toBe(before.tree);
    expect(deleted.tree).not.toBe(before.tree);
    expect(deleted.tree).not.toBe(added.tree);
  });
});

describe("import-door.sh when nothing changed (item 4)", () => {
  it("exits 0 and opens no branch and no merge request when the copy already matches upstream", async () => {
    const first = await deployWorld();
    expect((await runImport(first)).status).toBe(0);

    // The merge request was merged: dev now holds the copy. Run again against a fresh remote and fake GitLab.
    const orbit = mergedOrbit(first);
    const bare = deployBare(orbit);
    const api = await startGitLab({ bare });
    const result = await runImport({ orbit, upstream: first.upstream, bare, api });

    expect(result.status, ok(result)).toBe(0);
    expect(importedBranch(bare)).toEqual([]);
    expect(remoteBranches(bare)).toEqual(["dev"]);
    expect(api.requests.filter((r) => r.method !== "GET")).toEqual([]);
    expect(api.mrs).toEqual([]);
  });

  it("an upstream commit that leaves assets/door/ as it was changes nothing: same tree, no branch, no merge request", async () => {
    const first = await deployWorld();
    expect((await runImport(first)).status).toBe(0);

    touchUpstreamElsewhere(first.upstream);
    expect(upstreamCommit(first.upstream)).not.toBe(
      JSON.parse(pushedFile(first.bare, onlyImportBranch(first), "web/src/lib/door.upstream.json").toString("utf8")).commit,
    );

    const orbit = mergedOrbit(first);
    const bare = deployBare(orbit);
    const api = await startGitLab({ bare });
    const result = await runImport({ orbit, upstream: first.upstream, bare, api });

    expect(result.status, ok(result)).toBe(0);
    expect(importedBranch(bare)).toEqual([]);
    expect(api.requests.filter((r) => r.method !== "GET")).toEqual([]);
  });
});

describe("import-door.sh when the door changed (item 5)", () => {
  it("pushes chore/door-import-<short sha> of the upstream commit", async () => {
    const world = await deployWorld();
    const result = await runImport(world);
    expect(result.status, ok(result)).toBe(0);

    const branch = onlyImportBranch(world);
    const short = branch.match(/^chore\/door-import-([0-9a-f]{7,12})$/u)?.[1];
    expect(short, `branch ${branch}`).toBeTruthy();
    expect(upstreamCommit(world.upstream).startsWith(short)).toBe(true);
  });

  it("opens a merge request into dev from that branch, naming the upstream commit", async () => {
    const world = await deployWorld();
    const result = await runImport(world);
    expect(result.status, ok(result)).toBe(0);

    const branch = onlyImportBranch(world);
    const created = world.api.requests.filter((r) => r.method === "POST" && /\/merge_requests$/u.test(r.path));
    expect(created).toHaveLength(1);
    expect(created[0].path).toMatch(/\/projects\/49\/merge_requests$/u);
    expect(created[0].body.source_branch).toBe(branch);
    expect(created[0].body.target_branch).toBe("dev");

    const sha = upstreamCommit(world.upstream);
    const text = `${created[0].body.title ?? ""}\n${created[0].body.description ?? ""}`;
    expect(text).toContain(sha.slice(0, 7));
  });

  it("closes older open door-import merge requests and deletes their branches, leaving other merge requests alone", async () => {
    const world = await deployWorld({
      seedBranches: ["chore/door-import-aaaaaaa", "chore/door-import-bbbbbbb", "feature/other-work"],
      seedMrs: [
        { source_branch: "chore/door-import-aaaaaaa", title: "Import the door aaaaaaa" },
        { source_branch: "chore/door-import-bbbbbbb", title: "Import the door bbbbbbb" },
        { source_branch: "feature/other-work", title: "Something else" },
      ],
    });
    const result = await runImport(world);
    expect(result.status, ok(result)).toBe(0);

    const byBranch = Object.fromEntries(world.api.mrs.map((mr) => [mr.source_branch, mr]));
    expect(byBranch["chore/door-import-aaaaaaa"].state).toBe("closed");
    expect(byBranch["chore/door-import-bbbbbbb"].state).toBe("closed");
    expect(byBranch["feature/other-work"].state).toBe("opened");

    const branches = remoteBranches(world.bare);
    expect(branches).not.toContain("chore/door-import-aaaaaaa");
    expect(branches).not.toContain("chore/door-import-bbbbbbb");
    expect(branches).toContain("feature/other-work");

    // The new one is the only door-import branch left, and its merge request is open.
    const fresh = onlyImportBranch(world);
    expect(byBranch[fresh].state).toBe("opened");
    expect(byBranch[fresh].target_branch).toBe("dev");
  });

  it("opens the new merge request before it closes the older ones", async () => {
    const world = await deployWorld({
      seedBranches: ["chore/door-import-aaaaaaa"],
      seedMrs: [{ source_branch: "chore/door-import-aaaaaaa" }],
    });
    const result = await runImport(world);
    expect(result.status, ok(result)).toBe(0);

    const order = world.api.requests
      .filter((r) => (r.method === "POST" && /\/merge_requests$/u.test(r.path)) || (r.method === "PUT" && /\/merge_requests\/\d+$/u.test(r.path)))
      .map((r) => r.method);
    expect(order[0]).toBe("POST");
    expect(order).toContain("PUT");
  });

  it("the pushed branch carries the new copy, the new record and the deletions together", async () => {
    const world = await deployWorld();
    advanceUpstream(world.upstream);
    const result = await runImport(world);
    expect(result.status, ok(result)).toBe(0);

    const branch = onlyImportBranch(world);
    const record = JSON.parse(pushedFile(world.bare, branch, "web/src/lib/door.upstream.json").toString("utf8"));
    expect(record.commit).toBe(upstreamCommit(world.upstream));
    expect(pushedFile(world.bare, branch, "web/src/lib/door/index.js").toString("utf8")).toContain("// v2");
    expect(Object.keys(pushedDoor(world.bare, branch))).not.toContain("stale-soon.js");
  });
});

describe("check-door-unchanged.sh (item 6)", () => {
  /** An Orbit checkout holding an imported copy, and nothing else needed to check it. */
  async function importedOrbit() {
    const world = await deployWorld();
    expect((await runImport(world)).status).toBe(0);
    const orbit = mergedOrbit(world);
    // Offline: the fake upstream, the fake remote and the fake GitLab are gone before the check runs.
    rmSync(world.upstream, { recursive: true, force: true });
    await world.api.close();
    servers.splice(servers.indexOf(world.api), 1);
    return orbit;
  }

  const doorPath = (orbit, name) => join(orbit, "web", "src", "lib", "door", name);

  it("passes on an untouched copy, with no network and no upstream", async () => {
    const orbit = await importedOrbit();
    const result = await runCheck(orbit);
    expect(result.status, ok(result)).toBe(0);
  });

  it("fails when a file in the copy is edited by one byte", async () => {
    const orbit = await importedOrbit();
    const file = doorPath(orbit, "settings.js");
    writeFileSync(file, readFileSync(file, "utf8").replace("orbit", "orbiT"));
    const result = await runCheck(orbit);
    expect(result.status, ok(result)).not.toBe(0);
    expect(result.stdout + result.stderr).toMatch(/door/iu);
  });

  it("fails when a binary picture in the copy is edited", async () => {
    const orbit = await importedOrbit();
    const file = doorPath(orbit, "img/dawn/dawn.webp");
    const bytes = readFileSync(file);
    bytes[bytes.length - 1] ^= 0x01;
    writeFileSync(file, bytes);
    const result = await runCheck(orbit);
    expect(result.status, ok(result)).not.toBe(0);
  });

  it("fails when a file is added to the copy", async () => {
    const orbit = await importedOrbit();
    writeFileSync(doorPath(orbit, "orbits-own-addition.js"), "export {};\n");
    const result = await runCheck(orbit);
    expect(result.status, ok(result)).not.toBe(0);
  });

  it("fails when a file is added to a subfolder of the copy", async () => {
    const orbit = await importedOrbit();
    writeFileSync(doorPath(orbit, "img/dawn/extra.webp"), "x");
    const result = await runCheck(orbit);
    expect(result.status, ok(result)).not.toBe(0);
  });

  it("fails when a file is deleted from the copy", async () => {
    const orbit = await importedOrbit();
    unlinkSync(doorPath(orbit, "journey.js"));
    const result = await runCheck(orbit);
    expect(result.status, ok(result)).not.toBe(0);
  });

  it("fails when a file in a subfolder is deleted from the copy", async () => {
    const orbit = await importedOrbit();
    unlinkSync(doorPath(orbit, "img/flight/moon.webp"));
    const result = await runCheck(orbit);
    expect(result.status, ok(result)).not.toBe(0);
  });

  it("passes again once the edit is put back", async () => {
    const orbit = await importedOrbit();
    const file = doorPath(orbit, "settings.js");
    const original = readFileSync(file);
    writeFileSync(file, "// edited\n");
    expect((await runCheck(orbit)).status).not.toBe(0);
    writeFileSync(file, original);
    const result = await runCheck(orbit);
    expect(result.status, ok(result)).toBe(0);
  });
});
