/**
 * scripts/ci/import-door.sh and scripts/ci/check-door-unchanged.sh (#1371,
 * items 2-6 of the specification, item 5 as revised by decision 12a: the
 * token is write_repository only, so there is no API), driven end to end
 * with no network: the fake orbit-site is a local git repository, the remote
 * Orbit pushes to is a local bare repository that records the push options it
 * receives, and a small HTTP server stands in for GitLab only to prove the
 * job never calls it. Same shape as scripts/ci/repin-base-image.test.mjs
 * (scratch repository carrying a copy of the scripts, bare repository for the
 * push), run under Vitest.
 *
 * Written from the issue's specification alone, before the scripts existed.
 * The specification fixes WHAT happens, not how a test reaches it, so the
 * seams below are this suite's assumption of the script's interface; the
 * script has to accept them (all are unset in production, where the CI
 * variables and the real project name apply):
 *
 *   DOOR_IMPORT_UPSTREAM_URL  where to clone orbit-site from (a local path here)
 *   DOOR_IMPORT_PUSH_URL      where to ls-remote and push the branch (a local bare repository)
 *   DOOR_IMPORT_TOKEN         the project token (a fake value)
 *   CI_COMMIT_BRANCH          the branch the job runs on; the job runs only on `dev`
 *   CI_API_V4_URL, CI_SERVER_URL, CI_PROJECT_ID, CI_PROJECT_PATH
 *                             the predefined CI variables; the API they name must never be called
 *
 * The scripts find the repository root from their own location (two levels
 * up from scripts/ci/), as repin-base-image.sh does, so the suite copies
 * scripts/ci into the scratch repository and runs them there.
 */
import { spawn, spawnSync } from "node:child_process";
import {
  chmodSync,
  cpSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readdirSync,
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

function git(cwd, args, { buffer = false, input } = {}) {
  const result = spawnSync("git", args, {
    cwd,
    input,
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
function deployOrbit({ extraFiles = {} } = {}) {
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
    ...extraFiles,
  });
  git(dir, ["init", "--quiet", "--initial-branch=dev"]);
  git(dir, ["config", "user.email", "test@example.invalid"]);
  git(dir, ["config", "user.name", "Test"]);
  git(dir, ["add", "-A"]);
  git(dir, ["commit", "--quiet", "-m", "initial"]);
  return dir;
}

/**
 * A bare repository standing in for Orbit's GitLab. It advertises push
 * options and records the ones every push carries (one block per push, in
 * `push-options.log`), the way GitLab's `merge_request.*` options arrive.
 */
function deployBare(fromRepo) {
  const dir = scratchDir("orbit-door-bare-");
  git(dir, ["init", "--quiet", "--bare", "--initial-branch=dev"]);
  git(dir, ["config", "receive.advertisePushOptions", "true"]);
  /* the seed goes in before the hook, so the log holds only what the job pushes */
  if (fromRepo) git(fromRepo, ["push", "--quiet", dir, "dev"]);
  const log = join(dir, "push-options.log");
  const hook = join(dir, "hooks", "pre-receive");
  writeFileSync(
    hook,
    `#!/bin/sh
{
  echo "--push"
  i=0
  while [ "$i" -lt "\${GIT_PUSH_OPTION_COUNT:-0}" ]; do
    eval "echo \\"\\$GIT_PUSH_OPTION_$i\\""
    i=$((i + 1))
  done
} >> '${log}'
`,
  );
  chmodSync(hook, 0o755);
  return dir;
}

/** Every push the bare repository has received since the seed, each as its list of push options. */
function pushesTo(bare) {
  const log = join(bare, "push-options.log");
  if (!existsSync(log)) return [];
  return readFileSync(log, "utf8")
    .split("--push\n")
    .slice(1)
    .map((block) => block.split("\n").filter(Boolean));
}

function remoteBranches(bare) {
  return git(bare, ["for-each-ref", "--format=%(refname:short)", "refs/heads/"]).split("\n").filter(Boolean);
}

/* ---------------------------------------------------------------- GitLab tripwire */

/**
 * The token has write_repository only, so the job makes no API call at all.
 * This server stands where the API would be, records every request it gets
 * (headers included, to see whether one carried the token) and answers 404 to
 * each. A passing run leaves `requests` empty.
 */
async function startGitLab() {
  const requests = [];
  const server = createServer((req, res) => {
    requests.push({ method: req.method, url: req.url, headers: req.headers });
    res.writeHead(404, { "content-type": "application/json" });
    res.end("{}");
  });
  await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
  const url = `http://127.0.0.1:${server.address().port}`;
  const handle = { url, requests, close: () => new Promise((resolve) => server.close(resolve)) };
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
function runImport({ orbit, upstream, bare, api, branch = "dev" }) {
  return run("bash", [join(orbit, "scripts", "ci", "import-door.sh")], {
    cwd: orbit,
    env: {
      PATH: process.env.PATH,
      HOME: scratchDir("orbit-door-home-"),
      ...gitEnv,
      DOOR_IMPORT_UPSTREAM_URL: upstream,
      DOOR_IMPORT_PUSH_URL: bare,
      DOOR_IMPORT_TOKEN: FAKE_TOKEN,
      CI_COMMIT_BRANCH: branch,
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

/** A world: upstream, Orbit, bare remote and GitLab tripwire, ready to import. */
async function deployWorld({ upstream = deployUpstream(), orbitFiles = {} } = {}) {
  const orbit = deployOrbit({ extraFiles: orbitFiles });
  const bare = deployBare(orbit);
  const api = await startGitLab();
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

/**
 * The state after the merge request is merged: Orbit's dev is the pushed branch.
 * Names the branch when the world holds more than one import branch.
 */
function mergedOrbit(world, branch = onlyImportBranch(world)) {
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
  it("exits 0 and pushes no branch and opens no merge request when the copy already matches upstream", async () => {
    const first = await deployWorld();
    expect((await runImport(first)).status).toBe(0);

    // The merge request was merged: dev now holds the copy. Run again against a fresh remote.
    const orbit = mergedOrbit(first);
    const bare = deployBare(orbit);
    const api = await startGitLab();
    const result = await runImport({ orbit, upstream: first.upstream, bare, api });

    expect(result.status, ok(result)).toBe(0);
    expect(importedBranch(bare)).toEqual([]);
    expect(remoteBranches(bare)).toEqual(["dev"]);
    expect(pushesTo(bare)).toEqual([]);
    expect(api.requests).toEqual([]);
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
    const api = await startGitLab();
    const result = await runImport({ orbit, upstream: first.upstream, bare, api });

    expect(result.status, ok(result)).toBe(0);
    expect(importedBranch(bare)).toEqual([]);
    expect(pushesTo(bare)).toEqual([]);
  });
});

describe("import-door.sh when the door changed (item 5, as revised by decision 12a)", () => {
  it("pushes chore/door-import-<new tree>-on-<recorded tree>, `none` when dev has no record", async () => {
    const world = await deployWorld();
    const result = await runImport(world);
    expect(result.status, ok(result)).toBe(0);

    const branch = onlyImportBranch(world);
    const [, tree, base] = branch.match(/^chore\/door-import-([0-9a-f]{12})-on-([0-9a-f]{12}|none)$/u) ?? [];
    expect(tree, `branch ${branch}`).toBeTruthy();
    const record = JSON.parse(pushedFile(world.bare, branch, "web/src/lib/door.upstream.json").toString("utf8"));
    expect(record.tree.startsWith(tree)).toBe(true);
    expect(base).toBe("none");
  });

  it("the push carries merge_request.create, merge_request.target=dev and a merge_request.title naming the upstream commit", async () => {
    const world = await deployWorld();
    const result = await runImport(world);
    expect(result.status, ok(result)).toBe(0);
    onlyImportBranch(world);

    const pushes = pushesTo(world.bare);
    expect(pushes).toHaveLength(1);
    const options = pushes[0];
    expect(options).toContain("merge_request.create");
    expect(options).toContain("merge_request.target=dev");
    const title = options.find((o) => o.startsWith("merge_request.title="));
    expect(title, `push options: ${options.join(" | ")}`).toBeTruthy();
    expect(title).toContain(upstreamCommit(world.upstream).slice(0, 7));
  });

  it("makes no API request at all, and none carries the token", async () => {
    const world = await deployWorld();
    const result = await runImport(world);
    expect(result.status, ok(result)).toBe(0);
    onlyImportBranch(world);

    expect(world.api.requests).toEqual([]);
    expect(JSON.stringify(world.api.requests)).not.toContain(FAKE_TOKEN);
  });

  it("exits 0 and pushes nothing when that branch is already on Orbit, opening nothing", async () => {
    const world = await deployWorld();
    expect((await runImport(world)).status).toBe(0);
    const branch = onlyImportBranch(world);
    const tip = git(world.bare, ["rev-parse", branch]).trim();
    expect(pushesTo(world.bare)).toHaveLength(1);

    // The same upstream commit imported again from a fresh checkout of dev, against the same remote.
    const orbit = deployOrbit();
    const result = await runImport({ ...world, orbit });

    expect(result.status, ok(result)).toBe(0);
    expect(pushesTo(world.bare)).toHaveLength(1);
    expect(importedBranch(world.bare)).toEqual([branch]);
    expect(git(world.bare, ["rev-parse", branch]).trim()).toBe(tip);
    expect(world.api.requests).toEqual([]);
  });

  it("does not touch older door-import branches that are already on Orbit", async () => {
    const world = await deployWorld();
    git(world.orbit, ["push", "--quiet", world.bare, "dev:refs/heads/chore/door-import-aaaaaaa"]);
    const result = await runImport(world);
    expect(result.status, ok(result)).toBe(0);

    expect(remoteBranches(world.bare)).toContain("chore/door-import-aaaaaaa");
    expect(importedBranch(world.bare)).toHaveLength(2);
    expect(world.api.requests).toEqual([]);
  });

  it("a later upstream commit that leaves the door alone does not propose it again while the first merge request is unmerged (P-S23, #1316)", async () => {
    const world = await deployWorld();
    expect((await runImport(world)).status).toBe(0);
    const [first] = importedBranch(world.bare);
    expect(importedBranch(world.bare)).toEqual([first]);
    expect(pushesTo(world.bare)).toHaveLength(1);

    // Nothing merged: dev is still the old tree. Upstream moves on, door untouched.
    touchUpstreamElsewhere(world.upstream);
    const orbit = deployOrbit();
    const result = await runImport({ ...world, orbit });

    expect(result.status, ok(result)).toBe(0);
    expect(pushesTo(world.bare)).toHaveLength(1);
    expect(importedBranch(world.bare)).toEqual([first]);
    expect(world.api.requests).toEqual([]);
  });

  it("re-proposes a newer door change once an older import is merged, on a branch that merges cleanly (P-S24, #1316)", async () => {
    const world = await deployWorld();
    advanceUpstream(world.upstream); // X
    expect((await runImport(world)).status).toBe(0);
    const [branchX] = importedBranch(world.bare);

    // The door changes again (Z) before X is merged; dev is still the old tree.
    writeFileSync(join(world.upstream, "assets", "door", "dusk.js"), "export const dusk = 2;\n");
    git(world.upstream, ["add", "-A"]);
    git(world.upstream, ["commit", "--quiet", "-m", "the door, third"]);
    const commitZ = upstreamCommit(world.upstream);
    const second = await runImport({ ...world, orbit: deployOrbit() });
    expect(second.status, ok(second)).toBe(0);
    const branchZ1 = importedBranch(world.bare).filter((b) => b !== branchX);
    expect(branchZ1, "branch for Z cut from the old dev").toHaveLength(1);

    // The owner merges X. The next nightly run sees Z against a dev that holds X.
    const merged = mergedOrbit(world, branchX);
    const third = await runImport({ ...world, orbit: merged });
    expect(third.status, ok(third)).toBe(0);

    const all = importedBranch(world.bare);
    expect(all, "a third branch, named differently from Z's first").toHaveLength(3);
    const branchZ2 = all.filter((b) => b !== branchX && b !== branchZ1[0]);
    expect(branchZ2).toHaveLength(1);
    const record = JSON.parse(pushedFile(world.bare, branchZ2[0], "web/src/lib/door.upstream.json").toString("utf8"));
    expect(record.commit).toBe(commitZ);

    // It merges cleanly into the merged dev.
    const clone = scratchDir("orbit-door-mergecheck-");
    rmSync(clone, { recursive: true, force: true });
    git(tmpdir(), ["clone", "--quiet", merged, clone]);
    git(clone, ["config", "user.email", "test@example.invalid"]);
    git(clone, ["config", "user.name", "Test"]);
    git(clone, ["fetch", "--quiet", world.bare, `refs/heads/${branchZ2[0]}`]);
    const merge = spawnSync("git", ["merge", "--no-commit", "--no-ff", "FETCH_HEAD"], {
      cwd: clone,
      encoding: "utf8",
      env: { PATH: process.env.PATH, HOME: tmpdir(), ...gitEnv },
    });
    expect(merge.status, `${merge.stdout}\n${merge.stderr}`).toBe(0);
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

describe("import-door.sh refuses what the credential review ruled out (kept in the build)", () => {
  /** An upstream whose assets/door/ holds a directory entry literally named "..", written without git's path checks. */
  function deployUpstreamWithDotDot() {
    const dir = scratchDir("orbit-door-upstream-dotdot-");
    git(dir, ["init", "--quiet", "--initial-branch=main"]);
    const blob = (text) => git(dir, ["hash-object", "-w", "--stdin"], { input: text }).trim();
    const tree = (entries) => {
      const raw = Buffer.concat(
        entries.map(({ mode, name, sha }) => Buffer.concat([Buffer.from(`${mode} ${name}\0`), Buffer.from(sha, "hex")])),
      );
      return git(dir, ["hash-object", "-t", "tree", "-w", "--literally", "--stdin"], { input: raw }).trim();
    };
    const inner = tree([{ mode: "100644", name: "pwned.txt", sha: blob("written outside the copy\n") }]);
    const door = tree([
      { mode: "40000", name: "..", sha: inner },
      { mode: "100644", name: "index.js", sha: blob("export {};\n") },
    ]);
    const assets = tree([{ mode: "40000", name: "door", sha: door }]);
    const root = tree([{ mode: "40000", name: "assets", sha: assets }]);
    const commit = git(dir, ["commit-tree", root, "-m", "a door with a .. part"]).trim();
    git(dir, ["update-ref", "refs/heads/main", commit]);
    return dir;
  }

  const findFiles = (dir, name, found = []) => {
    for (const entry of readdirSync(dir, { withFileTypes: true })) {
      if (entry.name === ".git") continue;
      const full = join(dir, entry.name);
      if (entry.isDirectory()) findFiles(full, name, found);
      else if (entry.name === name) found.push(full);
    }
    return found;
  };

  it("refuses an upstream path with a .. part: exits non-zero, writes nothing outside the copy, pushes nothing", async () => {
    const world = await deployWorld({ upstream: deployUpstreamWithDotDot() });
    const result = await runImport(world);

    expect(result.status, ok(result)).not.toBe(0);
    expect(findFiles(world.orbit, "pwned.txt")).toEqual([]);
    expect(existsSync(join(world.orbit, "web", "src", "lib", "pwned.txt"))).toBe(false);
    expect(importedBranch(world.bare)).toEqual([]);
    expect(pushesTo(world.bare)).toEqual([]);
  });

  it("fails the job, naming the path, when a copied path is matched by .gitignore", async () => {
    const upstream = deployUpstream({ ...doorFiles, "img/dawn/held-back.cache": "ignored by Orbit\n" });
    const world = await deployWorld({ upstream, orbitFiles: { ".gitignore": "*.cache\n" } });
    const result = await runImport(world);

    expect(result.status, ok(result)).not.toBe(0);
    expect(result.stdout + result.stderr).toContain("held-back.cache");
    expect(importedBranch(world.bare)).toEqual([]);
    expect(pushesTo(world.bare)).toEqual([]);
  });

  for (const branch of ["feature/other-work", "main", ""]) {
    it(`refuses to run when CI_COMMIT_BRANCH is ${JSON.stringify(branch)}, not dev`, async () => {
      const world = await deployWorld();
      const result = await runImport({ ...world, branch });

      expect(result.status, ok(result)).not.toBe(0);
      expect(importedBranch(world.bare)).toEqual([]);
      expect(pushesTo(world.bare)).toEqual([]);
      expect(world.api.requests).toEqual([]);
    });
  }
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

/* ------------------------------------------- hardening from the credential review (#1371) */

/**
 * The import with the environment a CI job on `dev` has, plus overrides
 * (a value of undefined removes the variable). Its own runner rather than
 * runImport, so these tests say exactly which variables they depend on.
 */
function runImportWith({ orbit, upstream, bare, api }, overrides = {}) {
  const env = {
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
    CI_COMMIT_BRANCH: "dev",
    NO_PROXY: "127.0.0.1",
    ...overrides,
  };
  for (const [key, value] of Object.entries(env)) if (value === undefined) delete env[key];
  return run("bash", [join(orbit, "scripts", "ci", "import-door.sh")], { cwd: orbit, env });
}

/** git with stdin, for building trees git itself would never let `git add` build. */
function gitWithInput(cwd, args, input) {
  const result = spawnSync("git", args, {
    cwd,
    input,
    encoding: "utf8",
    env: { PATH: process.env.PATH, HOME: tmpdir(), ...gitEnv },
  });
  if (result.status !== 0) throw new Error(`git ${args.join(" ")} failed: ${result.stderr}`);
  return result.stdout.trim();
}

/** An upstream whose assets/door/ holds a path through a `..` component: assets/door/../pwned. */
function deployUpstreamWithDotDotPath() {
  const dir = deployUpstream();
  const pwned = gitWithInput(dir, ["hash-object", "-w", "--stdin"], "pwned\n");
  const index = git(dir, ["rev-parse", "main:assets/door/index.js"]).trim();
  const escape = gitWithInput(dir, ["mktree"], `100644 blob ${pwned}\tpwned\n`);
  const door = gitWithInput(dir, ["mktree"], `100644 blob ${index}\tindex.js\n040000 tree ${escape}\t..\n`);
  const assets = gitWithInput(dir, ["mktree"], `040000 tree ${door}\tdoor\n`);
  const root = gitWithInput(dir, ["mktree"], `040000 tree ${assets}\tassets\n`);
  const commit = gitWithInput(dir, ["commit-tree", root, "-p", "main", "-m", "a path that climbs out"], "");
  git(dir, ["update-ref", "refs/heads/main", commit]);
  return dir;
}

describe("import-door.sh refuses to run anywhere but dev (hardening)", () => {
  it("exits non-zero, says why and pushes nothing on another branch", async () => {
    const world = await deployWorld();
    const result = await runImportWith(world, { CI_COMMIT_BRANCH: "feature/other-work" });
    expect(result.status, ok(result)).not.toBe(0);
    expect(result.stdout + result.stderr).toMatch(/dev/u);
    expect(remoteBranches(world.bare)).toEqual(["dev"]);
    expect(world.api.requests.filter((r) => r.method !== "GET")).toEqual([]);
  });

  it("exits non-zero when CI_COMMIT_BRANCH is not set at all", async () => {
    const world = await deployWorld();
    const result = await runImportWith(world, { CI_COMMIT_BRANCH: undefined });
    expect(result.status, ok(result)).not.toBe(0);
    expect(remoteBranches(world.bare)).toEqual(["dev"]);
  });
});

describe("import-door.sh does not trust upstream's paths (hardening)", () => {
  it("refuses a tree with a `..` component and pushes nothing", async () => {
    const world = await deployWorld({ upstream: deployUpstreamWithDotDotPath() });
    const result = await runImportWith(world);
    expect(result.status, ok(result)).not.toBe(0);
    expect(importedBranch(world.bare)).toEqual([]);
    expect(remoteBranches(world.bare)).toEqual(["dev"]);
  });
});

describe("import-door.sh does not leave git-ignored files out silently (hardening)", () => {
  it("fails, naming the ignored file, and pushes nothing", async () => {
    const world = await deployWorld();
    writeFileSync(join(world.orbit, ".gitignore"), "*.webp\n");
    git(world.orbit, ["add", ".gitignore"]);
    git(world.orbit, ["commit", "--quiet", "-m", "ignore pictures"]);

    const result = await runImportWith(world);
    expect(result.status, ok(result)).not.toBe(0);
    expect(result.stdout + result.stderr).toContain("web/src/lib/door/img/dawn/dawn.webp");
    expect(importedBranch(world.bare)).toEqual([]);
  });
});

describe("import-door.sh leaves nothing in TMPDIR once it exits (D1-F1, #1316)", () => {
  /** What dir holds at its top level: a leaked scratch directory or file shows as one name. */
  const entriesUnder = (dir) => readdirSync(dir).sort();

  /** Files under dir whose contents hold the token, so a leak is named before emptiness is asserted. */
  const filesHoldingToken = (dir) =>
    readdirSync(dir, { recursive: true, withFileTypes: true })
      .filter((entry) => entry.isFile())
      .map((entry) => join(entry.parentPath, entry.name))
      .filter((file) => readFileSync(file).includes(FAKE_TOKEN));

  it("a changed-door run that exits 0 leaves TMPDIR empty", async () => {
    const world = await deployWorld();
    const tmp = scratchDir("orbit-door-tmp-");
    const result = await runImportWith(world, { TMPDIR: tmp });

    expect(result.status, ok(result)).toBe(0);
    expect(importedBranch(world.bare).length, ok(result)).toBeGreaterThan(0);
    expect(entriesUnder(tmp)).toEqual([]);
  });

  it("a run that fails after the push credential file is written leaves TMPDIR empty and no token on disk", async () => {
    const world = await deployWorld();
    writeFileSync(join(world.orbit, ".gitignore"), "*.webp\n");
    git(world.orbit, ["add", ".gitignore"]);
    git(world.orbit, ["commit", "--quiet", "-m", "ignore pictures"]);
    const tmp = scratchDir("orbit-door-tmp-");
    const result = await runImportWith(world, { TMPDIR: tmp });

    expect(result.status, ok(result)).not.toBe(0);
    expect(result.stdout + result.stderr).toContain("dawn.webp");
    expect(filesHoldingToken(tmp)).toEqual([]);
    expect(entriesUnder(tmp)).toEqual([]);
  });
});
