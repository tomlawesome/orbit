import { spawnSync } from "node:child_process";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";

import { afterAll, beforeAll, describe, expect, it } from "vitest";

// #1362: scripts/ci/read-launcher-pin.sh <field> [pin-file] prints a top-level
// string field of the launcher pin file.
const script = fileURLToPath(new URL("./read-launcher-pin.sh", import.meta.url));
const repoRoot = fileURLToPath(new URL("../..", import.meta.url));

let dir;
beforeAll(() => {
  dir = mkdtempSync(join(tmpdir(), "read-launcher-pin-"));
});
afterAll(() => {
  rmSync(dir, { recursive: true, force: true });
});

function run(args, options = {}) {
  return spawnSync("bash", ["-euo", "pipefail", script, ...args], { encoding: "utf8", ...options });
}

const pin = '{\n  "tag": "v9.9.9",\n  "commit": "0123456789abcdef0123456789abcdef01234567"\n}\n';

describe("read-launcher-pin.sh", () => {
  it("prints the named field and a newline", () => {
    const file = join(dir, "pin.json");
    writeFileSync(file, pin);
    const tag = run(["tag", file]);
    expect(tag.status).toBe(0);
    expect(tag.stdout).toBe("v9.9.9\n");
    const commit = run(["commit", file]);
    expect(commit.status).toBe(0);
    expect(commit.stdout).toBe("0123456789abcdef0123456789abcdef01234567\n");
  });

  it("defaults to launcher/pin.json relative to the working directory", () => {
    const cwd = join(dir, "work");
    mkdirSync(join(cwd, "launcher"), { recursive: true });
    writeFileSync(join(cwd, "launcher", "pin.json"), pin);
    const result = run(["tag"], { cwd });
    expect(result.status).toBe(0);
    expect(result.stdout).toBe("v9.9.9\n");
  });

  it("reads the real launcher/pin.json", () => {
    const result = run(["tag"], { cwd: repoRoot });
    expect(result.status).toBe(0);
    expect(result.stdout).toMatch(/^v\d+\.\d+\.\d+\S*\n$/);
  });

  it("reads the first match only", () => {
    const file = join(dir, "dup.json");
    writeFileSync(file, '{\n  "tag": "first",\n  "other": {\n    "tag": "second"\n  }\n}\n');
    const result = run(["tag", file]);
    expect(result.status).toBe(0);
    expect(result.stdout).toBe("first\n");
  });

  it("does not die of SIGPIPE on a long tail under pipefail", () => {
    const file = join(dir, "long.json");
    const padding = Array.from({ length: 100_000 }, (_, i) => `  "pad${i}": "x",`).join("\n");
    writeFileSync(file, `{\n  "tag": "v1.2.3",\n${padding}\n  "commit": "abc"\n}\n`);
    const result = run(["tag", file]);
    expect(result.status).toBe(0);
    expect(result.stdout).toBe("v1.2.3\n");
  });

  it("fails naming the field when it is absent", () => {
    const file = join(dir, "pin2.json");
    writeFileSync(file, pin);
    const result = run(["nonesuch", file]);
    expect(result.status).not.toBe(0);
    expect(result.stdout).toBe("");
    expect(result.stderr).toContain("nonesuch");
  });

  it("fails with a message when the file is missing", () => {
    const result = run(["tag", join(dir, "missing.json")]);
    expect(result.status).not.toBe(0);
    expect(result.stdout).toBe("");
    expect(result.stderr).toContain("missing.json");
  });
});
