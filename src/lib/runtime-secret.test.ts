import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { readRuntimeSecret } from "./runtime-secret";

const temporaryDirectories: string[] = [];

afterEach(() => {
  temporaryDirectories.splice(0).forEach((directory) => {
    rmSync(directory, { recursive: true, force: true });
  });
});

function secretFile(value: string): string {
  const directory = mkdtempSync(join(tmpdir(), "orbit-secret-"));
  const path = join(directory, "value");
  temporaryDirectories.push(directory);
  writeFileSync(path, value, { mode: 0o600 });
  return path;
}

describe("runtime secret resolution", () => {
  it("reads a direct value when no file is configured", () => {
    expect(readRuntimeSecret({
      NODE_ENV: "test",
      SESSION_SECRET: "direct-secret",
    }, "SESSION_SECRET"))
      .toBe("direct-secret");
  });

  it("reads a file-backed value and removes its final line ending", () => {
    expect(readRuntimeSecret(
      {
        NODE_ENV: "test",
        SESSION_SECRET_FILE: secretFile("file-secret\n"),
      },
      "SESSION_SECRET",
    )).toBe("file-secret");
  });

  it("rejects ambiguous direct and file-backed values", () => {
    expect(() => readRuntimeSecret({
      NODE_ENV: "test",
      SESSION_SECRET: "direct-secret",
      SESSION_SECRET_FILE: secretFile("file-secret"),
    }, "SESSION_SECRET")).toThrow("cannot both be configured");
  });

  it("rejects an explicitly configured empty secret file", () => {
    expect(() => readRuntimeSecret(
      {
        NODE_ENV: "test",
        SESSION_SECRET_FILE: secretFile(""),
      },
      "SESSION_SECRET",
    )).toThrow("empty secret");
  });
});
