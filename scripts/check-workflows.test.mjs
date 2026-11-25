import { spawnSync } from "node:child_process";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";

import { afterEach, describe, expect, it, vi } from "vitest";

import { PROCESS_DEADLINE_MS, PROCESS_TEST_TIMEOUT_MS } from "./process-budget.mjs";

vi.setConfig({ testTimeout: PROCESS_TEST_TIMEOUT_MS });

/*
 * scripts/check-workflows.mjs [root]: parses every .github/workflows/*.yml|yaml
 * under root with GitHub's workflow parser; exit 1 and name the file on any
 * parse or template error. Each test builds a fixture tree and runs the script.
 */
const script = fileURLToPath(new URL("./check-workflows.mjs", import.meta.url));
const repoRoot = fileURLToPath(new URL("..", import.meta.url));
const fixtures = [];

afterEach(() => {
  while (fixtures.length) rmSync(fixtures.pop(), { recursive: true, force: true });
});

function tree(files) {
  const root = mkdtempSync(join(tmpdir(), "check-workflows-"));
  fixtures.push(root);
  mkdirSync(join(root, ".github", "workflows"), { recursive: true });
  for (const [name, body] of Object.entries(files)) {
    writeFileSync(join(root, ".github", "workflows", name), body);
  }
  return root;
}

function run(root) {
  return spawnSync(process.execPath, [script, root], { encoding: "utf8", timeout: PROCESS_DEADLINE_MS });
}

const valid = `name: ok
on:
  push:
    branches: [main]
jobs:
  build:
    runs-on: ubuntu-latest
    steps:
      - run: echo "\${{ github.sha }}"
`;

describe("check-workflows", () => {
  it("passes a valid workflow", () => {
    const r = run(tree({ "ok.yml": valid }));
    expect(r.status).toBe(0);
  });

  it("fails an unknown top-level key and names the file", () => {
    const r = run(tree({ "ok.yml": valid, "bad-key.yml": valid + "bogus: 1\n" }));
    expect(r.status).toBe(1);
    expect(r.stdout + r.stderr).toContain("bad-key.yml");
    expect(r.stdout + r.stderr).not.toContain("ok.yml:");
  });

  it("fails a malformed expression and names the file", () => {
    const r = run(tree({ "bad-expr.yaml": valid.replace("github.sha", "foo(") }));
    expect(r.status).toBe(1);
    expect(r.stdout + r.stderr).toContain("bad-expr.yaml");
  });

  it("fails a bad on: value", () => {
    const r = run(tree({ "bad-on.yml": valid.replace(/on:\n {2}push:\n {4}branches: \[main\]/, "on: 5") }));
    expect(r.status).toBe(1);
    expect(r.stdout + r.stderr).toContain("bad-on.yml");
  });

  it("passes the real workflows", () => {
    const r = run(repoRoot);
    expect(r.stdout + r.stderr).not.toMatch(/error/i);
    expect(r.status).toBe(0);
  });
});
