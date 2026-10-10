import { readdirSync, readFileSync, statSync } from "node:fs";
import { join, relative } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

import { MAX_ARCHIVE_BYTES, MAX_ARCHIVE_CIPHERTEXT_CHARACTERS } from "orbit/server/portable-archive-limits";
import { SESSION_FIXTURE } from "../../web/src/lib/data/fixtures/workspace.js";

/*
 * #1336 (the archive card's numbers come from the engine): the browser must
 * hold none of the engine's limits. The session payload carries
 * `limits: { archiveFileBytes, passphraseMin, passphraseMax }` and
 * `retention: { documentDays, recoveryDays, receiptDays }`; the browser
 * formats its words from those numbers and derives its client-side file
 * ceiling from archiveFileBytes.
 *
 * Static scans of web/src, the same reproduce-by-reading shape as
 * tests/unit/archive-passphrase-min-gate.test.mjs. Comments are stripped
 * first: they may still say "30 days" while explaining history, but nothing
 * the browser runs or draws may.
 */

const WEB_SRC = fileURLToPath(new URL("../../web/src/", import.meta.url));

/** @param {string} dir @returns {string[]} */
function sourceFiles(dir) {
  const found = [];
  for (const name of readdirSync(dir)) {
    const path = join(dir, name);
    if (statSync(path).isDirectory()) found.push(...sourceFiles(path));
    else if (/\.(js|mjs|ts|svelte)$/.test(name) && !/\.test\.[a-z]+$/.test(name)) found.push(path);
  }
  return found;
}

/** @param {string} text */
function withoutComments(text) {
  return text
    .replace(/\/\*[\s\S]*?\*\//g, "")
    .replace(/<!--[\s\S]*?-->/g, "")
    .replace(/(^|[^:\w"'`])\/\/.*$/gm, "$1");
}

const SOURCES = sourceFiles(WEB_SRC).map((path) => ({
  path: relative(WEB_SRC, path),
  live: withoutComments(readFileSync(path, "utf8")),
}));

/** @param {RegExp} pattern */
function filesMatching(pattern) {
  return SOURCES.filter(({ live }) => pattern.test(live)).map(({ path }) => path);
}

// The calendar's "inside 30 days" bands are about due dates, not retention.
const CALENDAR_BANDS = new Set(["lib/editing/calendar.js", "routes/home/pocket.svelte", "lib/data/chart.js"]);

describe("the browser holds none of the engine's numbers (#1336)", () => {
  it("has no 128 MiB file ceiling written as a number", () => {
    expect(filesMatching(/128\s*\*\s*1024\s*\*\s*1024|1024\s*\*\s*1024\s*\*\s*128|134_?217_?728|0x8000000\b/)).toEqual([]);
  });

  it("has no 12 as a passphrase floor, and no 256 as a ceiling", () => {
    expect(filesMatching(/PASSPHRASE_MIN\s*=\s*12\b/)).toEqual([]);
    expect(filesMatching(/PASSPHRASE_MAX\s*=\s*256\b/)).toEqual([]);
    expect(filesMatching(/[pP]ass(?:phrase|In|Again)?\w*\.length\s*(?:<|<=|>|>=)\s*(?:12|256)\b/)).toEqual([]);
    expect(filesMatching(/\bminlength\s*=\s*["{]?\s*12\b/i)).toEqual([]);
  });

  it('has no literal "30 days" or "45 days" (nor "30-day"/"45-day") in what it draws', () => {
    const offenders = filesMatching(/\b(?:30|45)[ -]days?\b/i).filter((path) => !CALENDAR_BANDS.has(path));
    expect(offenders).toEqual([]);
  });
});

describe("the browser reads the engine's numbers from the session payload (#1336)", () => {
  const everything = SOURCES.map(({ live }) => live).join("\n");

  it.each(["archiveFileBytes", "passphraseMin", "passphraseMax"])("reads limits.%s", (name) => {
    expect(new RegExp(`\\b${name}\\b`).test(everything), `no browser file reads ${name}`).toBe(true);
  });

  it.each(["documentDays", "recoveryDays", "receiptDays"])("reads retention.%s", (name) => {
    expect(new RegExp(`\\b${name}\\b`).test(everything), `no browser file reads ${name}`).toBe(true);
  });
});

describe("the fixture session mirrors the payload shape (#1336)", () => {
  it("carries limits and retention as whole, positive numbers", () => {
    for (const key of ["archiveFileBytes", "passphraseMin", "passphraseMax"]) {
      expect(Number.isInteger(SESSION_FIXTURE.limits?.[key]), `limits.${key}`).toBe(true);
      expect(SESSION_FIXTURE.limits[key]).toBeGreaterThan(0);
    }
    for (const key of ["documentDays", "recoveryDays", "receiptDays"]) {
      expect(Number.isInteger(SESSION_FIXTURE.retention?.[key]), `retention.${key}`).toBe(true);
      expect(SESSION_FIXTURE.retention[key]).toBeGreaterThan(0);
    }
  });

  it("keeps its passphrase floor below its ceiling and its file ceiling above 130 MB", () => {
    expect(SESSION_FIXTURE.limits?.passphraseMin).toBeLessThan(SESSION_FIXTURE.limits?.passphraseMax);
    expect(SESSION_FIXTURE.limits?.archiveFileBytes).toBeGreaterThan(130_000_000);
  });
});

describe("an archive Orbit wrote from about 130 MB is within the engine's cap (#1336)", () => {
  // The cheapest level that proves it: the length arithmetic, not a 130 MB file.
  // AES-256-GCM ciphertext is as long as its plaintext; base64url is unpadded.
  const PLAINTEXT = 130_000_000;
  const ciphertextCharacters = Math.ceil((PLAINTEXT * 4) / 3);

  it("fits the plaintext bound and the ciphertext-length gate the import path applies", () => {
    expect(PLAINTEXT).toBeLessThanOrEqual(MAX_ARCHIVE_BYTES);
    expect(ciphertextCharacters).toBeLessThanOrEqual(MAX_ARCHIVE_CIPHERTEXT_CHARACTERS);
  });

  it("is longer than the 128 MiB the browser's old ceiling allowed, which is why the card refused it", () => {
    expect(ciphertextCharacters).toBeGreaterThan(128 * 1024 * 1024);
  });
});
