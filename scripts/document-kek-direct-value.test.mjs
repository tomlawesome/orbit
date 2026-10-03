import { spawnSync } from "node:child_process";
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";

import { failOnProcessDeadline, processGuard } from "./process-budget.mjs";

// #1151 SF2-F11: the contract (src/lib/config-contract.ts) accepts
// DOCUMENT_KEK either as a direct 64-hex-character value in .env-orbit, or
// as a DOCUMENT_KEK_FILE path -- configuration.sh classifies the direct
// form "deprecated_supported" (still accepted, for upgrades), not removed.
// backup.sh's and restore.sh's own read_document_kek assumed the
// file-backed form unconditionally and refused outright for a direct-value
// deployment, before anything else ran. Both now materialize the expected
// file from the direct value when the file itself is absent, which is also
// what every `compose run`/`exec` call below needs: docker-compose.yml's
// `orbit-document-kek` secret is always `file: .../.orbit-secrets/document-kek`.
//
// This suite runs the real materialize_document_kek_from_direct_value and
// read_document_kek functions extracted from each live script (never a
// hand-typed duplicate), under bash, against real fixture files.

const backupScriptSource = readFileSync(join(import.meta.dirname, "backup.sh"), "utf8");
const restoreScriptSource = readFileSync(join(import.meta.dirname, "restore.sh"), "utf8");

function extractFunction(source, name) {
  const pattern = new RegExp(`^${name}\\(\\) \\{[\\s\\S]*?\\n\\}`, "mu");
  const match = source.match(pattern);
  if (!match) throw new Error(`Could not find function ${name}() in the given source`);
  return match[0];
}

function functionsFrom(source) {
  return [
    extractFunction(source, "read_env_value"),
    extractFunction(source, "materialize_document_kek_from_direct_value"),
    extractFunction(source, "read_document_kek"),
  ].join("\n\n");
}

const scratchDirs = [];

afterEach(() => {
  while (scratchDirs.length > 0) rmSync(scratchDirs.pop(), { recursive: true, force: true });
});

function makeFixture() {
  const dir = mkdtempSync(join(tmpdir(), "orbit-document-kek-direct-"));
  scratchDirs.push(dir);
  return dir;
}

function runReadDocumentKek(source, { environmentContent, secretsDirectory, documentKekFile }) {
  const dir = makeFixture();
  const environmentFile = join(dir, ".env-orbit");
  writeFileSync(environmentFile, environmentContent);
  const harness = [
    "#!/usr/bin/env bash",
    "set -Eeuo pipefail",
    `environment_file=${JSON.stringify(environmentFile)}`,
    `secrets_directory=${JSON.stringify(secretsDirectory)}`,
    `document_kek_file=${JSON.stringify(documentKekFile)}`,
    'fail() { printf "FAIL: %s\\n" "$*" >&2; exit 1; }',
    functionsFrom(source),
    "read_document_kek",
  ].join("\n");
  return failOnProcessDeadline(spawnSync("bash", ["-c", harness], { encoding: "utf8", ...processGuard() }), { label: "runReadDocumentKek" });
}

const validHex = "a".repeat(64);

describe.each([
  ["backup.sh", backupScriptSource],
  ["restore.sh", restoreScriptSource],
])("%s's read_document_kek handles a direct DOCUMENT_KEK value (#1151 SF2-F11)", (_label, source) => {
  it("materializes the expected secrets file from a direct DOCUMENT_KEK value when no file exists yet", () => {
    const dir = makeFixture();
    const secretsDirectory = join(dir, ".orbit-secrets");
    const documentKekFile = join(secretsDirectory, "document-kek");
    expect(existsSync(documentKekFile)).toBe(false);

    const result = runReadDocumentKek(source, {
      environmentContent: `APP_URL=https://orbit.example.invalid\nDOCUMENT_KEK=${validHex}\n`,
      secretsDirectory,
      documentKekFile,
    });

    expect(result.status).toBe(0);
    expect(readFileSync(documentKekFile, "utf8")).toBe(validHex);
    expect(statSync(documentKekFile).mode & 0o777).toBe(0o600);
  });

  it("still refuses when neither a file nor a valid direct value is present", () => {
    const dir = makeFixture();
    const secretsDirectory = join(dir, ".orbit-secrets");
    const documentKekFile = join(secretsDirectory, "document-kek");

    const result = runReadDocumentKek(source, {
      environmentContent: "APP_URL=https://orbit.example.invalid\n",
      secretsDirectory,
      documentKekFile,
    });

    expect(result.status).not.toBe(0);
    expect(existsSync(documentKekFile)).toBe(false);
  });

  it("leaves an existing file-backed key untouched, never overwriting it from .env-orbit", () => {
    const dir = makeFixture();
    const secretsDirectory = join(dir, ".orbit-secrets");
    mkdirSync(secretsDirectory, { mode: 0o700 });
    const documentKekFile = join(secretsDirectory, "document-kek");
    const existingHex = "b".repeat(64);
    writeFileSync(documentKekFile, existingHex);
    chmodSync(documentKekFile, 0o600);

    // A direct value present too (e.g. a stale leftover) must never override
    // the file that is already the deployment's real, in-use key.
    const result = runReadDocumentKek(source, {
      environmentContent: `APP_URL=https://orbit.example.invalid\nDOCUMENT_KEK=${validHex}\n`,
      secretsDirectory,
      documentKekFile,
    });

    expect(result.status).toBe(0);
    expect(readFileSync(documentKekFile, "utf8")).toBe(existingHex);
  });
});
