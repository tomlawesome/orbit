import { execFileSync, spawnSync } from "node:child_process";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";

import { afterEach, beforeEach, describe, expect, it } from "vitest";

/*
 * The stamp is what makes building the web application once per pipeline safe
 * (#1061). Everything else in that change is plumbing; this is the part that
 * can be wrong in the dangerous direction, by saying a build is current when
 * it was made from different sources. So the cases below are mostly "does it
 * notice", and the one "does it stay quiet" is the exclusion the whole saving
 * depends on.
 *
 * Driven as a command against a throwaway git repository, because the answer
 * comes from `git ls-files` and an in-process unit test would have to
 * reimplement the thing under test to set it up.
 */

const script = fileURLToPath(new URL("./web-build-stamp.mjs", import.meta.url));

let root;

function run(command, env = {}) {
  return spawnSync(process.execPath, [script, command], {
    encoding: "utf8",
    env: { ...process.env, ORBIT_WEB_STAMP_ROOT: root, ORBIT_FORCE_WEB_BUILD: "", ...env },
  });
}

function write(relativePath, contents) {
  const full = join(root, relativePath);
  mkdirSync(join(full, ".."), { recursive: true });
  writeFileSync(full, contents);
}

function git(...args) {
  execFileSync("git", args, { cwd: root, encoding: "utf8" });
}

beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), "orbit-web-build-stamp-"));
  git("init", "--quiet");
  write(".gitignore", "web/build\nweb/.svelte-kit\nweb/static/licenses\n");
  write("package.json", '{ "name": "orbit" }\n');
  write("src/server/boot.ts", "export const boot = 1;\n");
  write("web/src/routes/+page.svelte", "<h1>one</h1>\n");
  write("web/tests/fidelity/dashboard.png", "baseline-one");
  git("add", "-A");
  git("-c", "user.email=tests@invalid", "-c", "user.name=tests", "commit", "--quiet", "-m", "start");
  // What a build leaves behind, minus the build itself.
  write("web/build/index.js", "// server entry\n");
  write("web/build/server/index.js", "// server\n");
  write("web/static/licenses/fonts.json", "[]\n");
});

afterEach(() => {
  rmSync(root, { recursive: true, force: true });
});

describe("web build stamp", () => {
  it("refuses an unstamped build, however complete it looks", () => {
    expect(run("check").status).toBe(1);
    expect(run("check").stdout).toContain("unstamped");
  });

  it("vouches for a build it has just stamped", () => {
    expect(run("write").status).toBe(0);
    const checked = run("check");
    expect(checked.status).toBe(0);
    expect(checked.stdout).toContain("current for inputs");
  });

  it("does not vouch for a build when there is no build", () => {
    run("write");
    rmSync(join(root, "web", "build", "index.js"));
    expect(run("check").status).toBe(1);
  });

  it("notices an edited front-end file", () => {
    run("write");
    write("web/src/routes/+page.svelte", "<h1>two</h1>\n");
    expect(run("check").status).toBe(1);
  });

  it("notices an edited server file, which web/src imports through orbit/server", () => {
    run("write");
    write("src/server/boot.ts", "export const boot = 2;\n");
    expect(run("check").status).toBe(1);
  });

  it("notices a brand new file that has never been committed", () => {
    run("write");
    write("web/src/routes/new/+page.svelte", "<h1>new</h1>\n");
    expect(run("check").status).toBe(1);
  });

  it("notices a manifest change, since the bundle is built from those versions", () => {
    run("write");
    write("package.json", '{ "name": "orbit", "version": "2" }\n');
    expect(run("check").status).toBe(1);
  });

  // The exclusion that makes this worth having: a fidelity baseline is the
  // commonest change in the repository and reaches no part of the bundle.
  it("stays quiet about a changed fidelity baseline", () => {
    run("write");
    write("web/tests/fidelity/dashboard.png", "baseline-two");
    expect(run("check").status).toBe(0);
  });

  // The build writes these itself, so counting them would mean no build was
  // ever current -- the hash would move the moment it was recorded, and a
  // fresh checkout would not have them at all.
  it("stays quiet about the build's own generated and ignored output", () => {
    run("write");
    write("web/static/licenses/fonts.json", '["something else"]\n');
    write("web/.svelte-kit/tsconfig.json", "{}\n");
    expect(run("check").status).toBe(0);
  });

  it("can be told to rebuild anyway", () => {
    run("write");
    expect(run("check", { ORBIT_FORCE_WEB_BUILD: "1" }).status).toBe(1);
  });

  it("records nothing, and does not fail, where there is no build to vouch for", () => {
    rmSync(join(root, "web", "build"), { recursive: true, force: true });
    const written = run("write");
    expect(written.status).toBe(0);
    expect(run("check").status).toBe(1);
  });
});
