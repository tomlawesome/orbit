import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import { describe, it } from "node:test";

// X-Q5 (#1151): called with no mockup/css/markup arguments and nothing but
// `--check`, the script printed its usage message -- a fatal-looking error
// -- and then exited 0, reporting success on the exact path meant to report
// a usage mistake. Nothing calls it that way (`--check` always needs the
// same positional arguments as a scaffold run, to know which screen to
// check), so the special case was dead and actively misleading: a caller
// that only reads the exit code would believe everything is fine.
//
// Outside the vitest suite -- same reason as scripts/lockfile-no-pnpm-exe.test.mjs
// -- run standalone: `node --test web/scripts/scaffold-screen.test.mjs`.
const scriptPath = fileURLToPath(new URL("./scaffold-screen.mjs", import.meta.url));

function run(args) {
  try {
    const stdout = execFileSync("node", [scriptPath, ...args], { encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] });
    return { status: 0, stdout };
  } catch (error) {
    return { status: error.status, stdout: error.stdout, stderr: error.stderr };
  }
}

describe("scaffold-screen.mjs usage errors", () => {
  it("exits non-zero for --check with no mockup/css/markup arguments", () => {
    const result = run(["--check"]);
    assert.match(result.stderr ?? "", /usage: node scripts\/scaffold-screen\.mjs/);
    assert.notEqual(result.status, 0);
  });

  it("exits non-zero for too few arguments", () => {
    const result = run(["design/v19/inbox.html"]);
    assert.notEqual(result.status, 0);
  });

  it("exits non-zero for too many arguments", () => {
    const result = run(["a.html", "b.css", "c.svelte", "d.js", "e.extra"]);
    assert.notEqual(result.status, 0);
  });
});
