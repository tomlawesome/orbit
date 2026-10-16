import { spawnSync } from "node:child_process";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

import { afterEach, describe, expect, it, vi } from "vitest";

import { PROCESS_DEADLINE_MS, PROCESS_TEST_TIMEOUT_MS } from "./process-budget.mjs";

vi.setConfig({ testTimeout: PROCESS_TEST_TIMEOUT_MS });

/*
 * scripts/check-quarantine.mjs [root]: every `@quarantine` tag in a spec file
 * under tests/e2e/ or web/tests/ must be on the reviewed list
 * tests/quarantine.txt, with the right count and an issue ref, because a
 * quarantined test is dropped from every merge gate.
 *
 * Each test builds its own fixture tree and runs the script as a black box.
 */
const script = fileURLToPath(new URL("./check-quarantine.mjs", import.meta.url));
const fixtures = [];

afterEach(() => {
  for (const dir of fixtures.splice(0)) rmSync(dir, { recursive: true, force: true });
});

// files: { "relative/path": "contents" }. `list` is the contents of
// tests/quarantine.txt, or null for no list file at all.
function fixture(files, list) {
  const root = mkdtempSync(join(tmpdir(), "check-quarantine-"));
  fixtures.push(root);
  const put = (rel, body) => {
    const full = join(root, rel);
    mkdirSync(dirname(full), { recursive: true });
    writeFileSync(full, body);
  };
  for (const [rel, body] of Object.entries(files)) put(rel, body);
  if (list !== null) put("tests/quarantine.txt", list);
  return root;
}

function run(root) {
  const r = spawnSync("node", [script, root], {
    encoding: "utf8",
    timeout: PROCESS_DEADLINE_MS,
    killSignal: "SIGKILL",
    env: { PATH: process.env.PATH, HOME: process.env.HOME },
  });
  return { status: r.status, stdout: r.stdout ?? "", stderr: r.stderr ?? "", error: r.error };
}

const A = "tests/e2e/a.spec.ts";
const B = "web/tests/b.spec.ts";

const specA = `import { test } from "@playwright/test";
test("one", { tag: ["@quarantine"] }, async () => {});
test.describe("group", { tag: "@quarantine" }, () => {});
`;
const specB = `test("x @quarantine", async () => {});
`;

function expectFails(result, ...needles) {
  expect(result.error).toBeUndefined();
  expect(result.status).toBe(1);
  for (const n of needles) expect(result.stderr).toContain(n);
}

describe("check-quarantine", () => {
  it("passes a clean tree and prints the summary", () => {
    const root = fixture(
      { [A]: specA, [B]: specB },
      `${A} 2 #1085\n${B} 1 #1415\n`,
    );
    const r = run(root);
    expect(r.error).toBeUndefined();
    expect(r.status).toBe(0);
    expect(r.stdout.trim()).toBe("quarantine list: 3 tags in 2 files, all listed");
    expect(r.stderr).toBe("");
  });

  it("does not count tags on // comment lines", () => {
    const root = fixture(
      {
        [A]: `// test("x", { tag: "@quarantine" })\n    // @quarantine again\ntest("y", { tag: "@quarantine" }, () => {});\n`,
      },
      `${A} 1 #1\n`,
    );
    const r = run(root);
    expect(r.status).toBe(0);
    expect(r.stdout.trim()).toBe("quarantine list: 1 tags in 1 files, all listed");
  });

  it("does not count tags on block-comment lines", () => {
    const root = fixture(
      {
        [A]: `/* @quarantine opens a block\n * @quarantine inside it\n   * @quarantine indented\n */\ntest("y", { tag: "@quarantine" }, () => {});\n`,
      },
      `${A} 1 #1\n`,
    );
    const r = run(root);
    expect(r.status).toBe(0);
    expect(r.stdout.trim()).toBe("quarantine list: 1 tags in 1 files, all listed");
  });

  it("matches @quarantine only as a whole word", () => {
    const root = fixture(
      {
        [A]: [
          `test("a", { tag: "@quarantined" }, () => {});`,
          `test("b", { tag: "@quarantine-x" }, () => {});`,
          `test("c", { tag: "@quarantine_y" }, () => {});`,
          `test("d", { tag: "@quarantine9" }, () => {});`,
          `test("e", { tag: "@quarantine" }, () => {});`,
          ``,
        ].join("\n"),
      },
      `${A} 1 #1\n`,
    );
    const r = run(root);
    expect(r.status).toBe(0);
    expect(r.stdout.trim()).toBe("quarantine list: 1 tags in 1 files, all listed");
  });

  it("treats a file with only near-miss tags as having none", () => {
    const root = fixture(
      { [A]: `test("a", { tag: "@quarantined" }, () => {});\ntest("b", { tag: "@quarantine-x" }, () => {});\n` },
      `# nothing listed\n`,
    );
    const r = run(root);
    expect(r.status).toBe(0);
    expect(r.stdout.trim()).toBe("quarantine list: 0 tags in 0 files, all listed");
  });

  it("fails a tagged file that is not on the list", () => {
    const root = fixture({ [A]: specA, [B]: specB }, `${A} 2 #1085\n`);
    const r = run(root);
    expectFails(r, B);
    expect(r.stderr).not.toContain(`${A}`);
  });

  it("fails when the listed count is too low, naming both numbers", () => {
    const root = fixture({ [A]: specA }, `${A} 1 #1085\n`);
    const r = run(root);
    expectFails(r, A);
    expect(r.stderr).toMatch(/\b1\b/);
    expect(r.stderr).toMatch(/\b2\b/);
  });

  it("fails when the listed count is too high, naming both numbers", () => {
    const root = fixture({ [A]: specA }, `${A} 5 #1085\n`);
    const r = run(root);
    expectFails(r, A);
    expect(r.stderr).toMatch(/\b5\b/);
    expect(r.stderr).toMatch(/\b2\b/);
  });

  it("fails a stale entry for a path that does not exist", () => {
    const root = fixture({ [A]: specA }, `${A} 2 #1085\ntests/e2e/gone.spec.ts 1 #2\n`);
    const r = run(root);
    expectFails(r, "tests/e2e/gone.spec.ts");
  });

  it("fails a stale entry for a listed file with zero tags", () => {
    const root = fixture(
      { [A]: specA, [B]: `test("clean", async () => {});\n` },
      `${A} 2 #1085\n${B} 1 #2\n`,
    );
    const r = run(root);
    expectFails(r, B);
  });

  it("fails an entry with no issue ref", () => {
    const root = fixture({ [A]: specA }, `${A} 2\n`);
    expectFails(run(root), A);
  });

  it("fails an entry whose issue ref is not of the form #123", () => {
    const root = fixture({ [A]: specA }, `${A} 2 issue-1085\n`);
    expectFails(run(root), A);
  });

  it("fails a non-numeric count", () => {
    const root = fixture({ [A]: specA }, `${A} two #1085\n`);
    expectFails(run(root), A);
  });

  it("fails a missing count", () => {
    const root = fixture({ [A]: specA }, `${A} #1085\n`);
    expectFails(run(root), A);
  });

  it("fails a zero count", () => {
    const root = fixture({ [A]: specA }, `${A} 0 #1085\n`);
    expectFails(run(root), A);
  });

  it("fails the same path listed twice", () => {
    const root = fixture({ [A]: specA }, `${A} 2 #1085\n${A} 2 #1415\n`);
    expectFails(run(root), A);
  });

  it("fails when the list file is missing, naming tests/quarantine.txt", () => {
    const root = fixture({ [A]: specA }, null);
    expectFails(run(root), "tests/quarantine.txt");
  });

  it("ignores comment and blank lines in the list", () => {
    const root = fixture(
      { [A]: specA },
      `# reviewed list\n\n   \n# ${A} 99 #9\n${A} 2 #1085\n\n# end\n`,
    );
    const r = run(root);
    expect(r.error).toBeUndefined();
    expect(r.status).toBe(0);
    expect(r.stdout.trim()).toBe("quarantine list: 2 tags in 1 files, all listed");
  });

  it("ignores spec files outside tests/e2e and web/tests", () => {
    const root = fixture(
      {
        [A]: specA,
        "src/other.spec.ts": specA,
        "tests/unit/x.spec.ts": specA,
        "web/src/y.spec.ts": specA,
      },
      `${A} 2 #1085\n`,
    );
    const r = run(root);
    expect(r.status).toBe(0);
    expect(r.stdout.trim()).toBe("quarantine list: 2 tags in 1 files, all listed");
  });

  it("ignores files that are not .spec.ts, .spec.js or .spec.mjs", () => {
    const root = fixture(
      {
        [A]: specA,
        "tests/e2e/helper.ts": specA,
        "tests/e2e/notes.md": specA,
        "tests/e2e/a.test.ts": specA,
        "web/tests/support.js": specA,
      },
      `${A} 2 #1085\n`,
    );
    const r = run(root);
    expect(r.status).toBe(0);
    expect(r.stdout.trim()).toBe("quarantine list: 2 tags in 1 files, all listed");
  });

  it("scans .spec.js and .spec.mjs files", () => {
    const js = "tests/e2e/c.spec.js";
    const mjs = "web/tests/d.spec.mjs";
    const root = fixture({ [js]: specB, [mjs]: specB }, `${js} 1 #1\n${mjs} 1 #2\n`);
    const r = run(root);
    expect(r.status).toBe(0);
    expect(r.stdout.trim()).toBe("quarantine list: 2 tags in 2 files, all listed");
  });

  it("scans nested directories", () => {
    const deep = "tests/e2e/one/two/three/deep.spec.ts";
    const deepWeb = "web/tests/a/b/deep.spec.ts";
    const root = fixture({ [deep]: specB, [deepWeb]: specB }, `${deep} 1 #1\n${deepWeb} 1 #2\n`);
    const r = run(root);
    expect(r.status).toBe(0);
    expect(r.stdout.trim()).toBe("quarantine list: 2 tags in 2 files, all listed");
  });

  it("fails a nested tagged file that is not listed", () => {
    const deep = "tests/e2e/one/two/deep.spec.ts";
    const root = fixture({ [deep]: specB }, `# empty\n`);
    expectFails(run(root), deep);
  });

  it("accepts several comma-separated issue refs and trailing free text", () => {
    const root = fixture(
      { [A]: specA },
      `${A} 2 #1085,#1415 flaky on the shared runner, see thread\n`,
    );
    const r = run(root);
    expect(r.error).toBeUndefined();
    expect(r.status).toBe(0);
    expect(r.stdout.trim()).toBe("quarantine list: 2 tags in 1 files, all listed");
  });

  it("reports one stderr line per problem", () => {
    const root = fixture(
      { [A]: specA, [B]: specB },
      `tests/e2e/gone.spec.ts 1 #2\n`,
    );
    const r = run(root);
    expectFails(r, A, B, "tests/e2e/gone.spec.ts");
    const lines = r.stderr.split("\n").filter((l) => l.trim() !== "");
    for (const p of [A, B, "tests/e2e/gone.spec.ts"]) {
      expect(lines.filter((l) => l.includes(p)).length).toBeGreaterThanOrEqual(1);
    }
    expect(lines.length).toBeGreaterThanOrEqual(3);
  });
});
