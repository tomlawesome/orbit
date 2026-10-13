import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import path from "node:path";
import { describe, expect, it } from "vitest";

/*
 * #1408: fixtures, mockups and docs use invented names only. This guard keeps
 * a real person's name from coming back. Only the digest of the banned word is
 * stored, so the guard does not itself repeat the name. The same guard keeps
 * real host logins and private network addresses out of tracked text.
 */
const root = path.resolve(import.meta.dirname, "../..");

/** sha256 of each banned word, lower case. */
const BANNED = new Set([
  // a real person's surname, #1408
  "4aa59b5a3761c43828cf2c0f44a385d94d078934936482f66e573cb444e7e481",
]);

/** @type {Map<string, boolean>} */
const seen = new Map();
/** @param {string} word */
function banned(word) {
  let hit = seen.get(word);
  if (hit === undefined) {
    hit = BANNED.has(createHash("sha256").update(word).digest("hex"));
    seen.set(word, hit);
  }
  return hit;
}

function trackedTextFiles() {
  const names = execFileSync("git", ["ls-files", "-z"], { cwd: root, encoding: "utf8" })
    .split("\0")
    .filter(Boolean);
  /** @type {{ name: string, text: string }[]} */
  const files = [];
  for (const name of names) {
    let data;
    try {
      data = readFileSync(path.join(root, name));
    } catch {
      continue; // deleted in the working tree, or a directory entry such as a submodule
    }
    if (data.subarray(0, 8192).includes(0)) continue; // binary
    files.push({ name, text: data.toString("utf8") });
  }
  return files;
}

/*
 * A real login name leaks through a home-directory path. Only path segments
 * are checked, because a login can also be an ordinary first name that the
 * fixtures legitimately use. Digests only, as above.
 */
const BANNED_LOGINS = new Set([
  // the owner's host login, #1408
  "e1608f75c5d7813f3d4031cb30bfb786507d98137538ff8e128a6ff74e84e643",
  // the account automated agents run under on the development host, #1408
  "57de4cf40144bdf7d00010f2f5557a7d642c2b9705309bfade167dd313e2ca93",
]);

/** `/home/<login>`, `/Users/<login>`, `C:\Users\<login>` (any slash, escaped or not), `~<login>/`. */
const HOME_DIRECTORY = /(?:\/home\/|[/\\]+Users[/\\]+|(?<![\w/])~)([A-Za-z0-9._-]+)/gu;

/** A dotted quad not embedded in a longer run of digits and dots (version strings, OIDs). */
const IPV4 = /(?<![\d.])(?:\d{1,3}\.){3}\d{1,3}(?![\d.]*\d)/gu;

/**
 * RFC 1918 private ranges and RFC 6598 shared (CGNAT) space. The documentation
 * ranges of RFC 5737 fall outside both, so they never match.
 * @param {string} address
 */
function isPrivateOrShared(address) {
  const [a, b, c, d] = address.split(".").map(Number);
  if ([a, b, c, d].some((octet) => octet > 255)) return false;
  return a === 10 || (a === 172 && b >= 16 && b <= 31) || (a === 192 && b === 168) || (a === 100 && b >= 64 && b <= 127);
}

/*
 * Fixture addresses known to be invented, per file. Each is a classifier or
 * redaction test input on a textbook subnet (the first hosts of 10/8,
 * a round 172.16-31 value, or 192.168.1.x, the consumer-router default), never
 * paired with a host name, port of a real service or anything else that would
 * place it on a real network. A new address means a new reason here.
 */
/** @type {Map<string, Set<string>>} */
const FAKE_ADDRESSES = new Map([
  // ORBIT_BIND_ADDRESS fixture beside APP_URL=https://orbit.internal
  ["scripts/test-backup-restore.test.mjs", new Set(["192.168.1.50"])],
  // text of a made-up connection error that must not leak into logs
  ["src/db/migration-outcome.test.ts", new Set(["10.0.0.5"])],
  ["src/server/boot.test.ts", new Set(["10.0.0.5"])],
  ["src/server/mail-in/mailbox-settings.test.ts", new Set(["10.0.0.1"])],
  // push endpoints the allow-list must refuse because they are private
  ["src/server/notification-worker.test.ts", new Set(["10.0.0.5", "172.20.3.4", "192.168.1.10"])],
  // inputs to the "your home network" classifier; 100.64.0.1 is the first
  // shared-space address, there to prove CGNAT is not treated as home
  ["src/server/sign-in-approvals.test.ts", new Set(["192.168.1.24", "10.0.0.5", "172.16.4.9", "172.31.255.1", "192.168.1.5", "100.64.0.1"])],
  // doc comment showing the IPv4-mapped form the classifier unwraps
  ["src/server/sign-in-approvals.ts", new Set(["192.168.1.5"])],
]);
const ALL_FAKE = new Set([...FAKE_ADDRESSES.values()].flatMap((set) => [...set]));
const SELF = "tests/unit/no-real-names.test.mjs";

describe("no real names (#1408)", () => {
  it("no tracked text file contains a banned word", () => {
    /** @type {string[]} */
    const hits = [];
    for (const { name, text } of trackedTextFiles()) {
      const lines = text.split("\n");
      for (let i = 0; i < lines.length; i++) {
        const tokens = new Set(lines[i].toLowerCase().match(/[a-z0-9]+/g) ?? []);
        for (const token of tokens) {
          if (banned(token)) hits.push(`${name}:${i + 1}`);
        }
      }
    }
    expect(hits, "use an invented name instead (#1408)").toEqual([]);
  }, 60_000); // reads every tracked file: seconds, not milliseconds

  it("no tracked text file names a real host login in a home-directory path", () => {
    /** @type {string[]} */
    const hits = [];
    for (const { name, text } of trackedTextFiles()) {
      const lines = text.split("\n");
      for (let i = 0; i < lines.length; i++) {
        for (const match of lines[i].matchAll(HOME_DIRECTORY)) {
          const login = match[1].toLowerCase();
          if (BANNED_LOGINS.has(createHash("sha256").update(login).digest("hex"))) hits.push(`${name}:${i + 1}`);
        }
      }
    }
    expect(hits, "use ~/..., <project root> or an invented account such as /home/alex (#1408)").toEqual([]);
  }, 60_000);

  it("no tracked text file holds a private or shared-address IPv4 address outside the known fake fixtures", () => {
    /** @type {string[]} */
    const hits = [];
    for (const { name, text } of trackedTextFiles()) {
      const lines = text.split("\n");
      for (let i = 0; i < lines.length; i++) {
        for (const match of lines[i].matchAll(IPV4)) {
          const address = match[0];
          if (!isPrivateOrShared(address)) continue;
          if (FAKE_ADDRESSES.get(name)?.has(address)) continue;
          if (name === SELF && ALL_FAKE.has(address)) continue; // the list below names them
          hits.push(`${name}:${i + 1} ${address}`);
        }
      }
    }
    expect(hits, "use a documentation address (192.0.2.x, 198.51.100.x, 203.0.113.x) or add a clearly fake fixture to FAKE_ADDRESSES (#1408)").toEqual([]);
  }, 60_000);
});

/*
 * The matchers, tested directly with invented words (no digests, no real
 * names). `wordsOf` and `loginsOf` are plain functions in this file. Written
 * with `it` and `assert` only, so they run unchanged under node:test.
 */
describe("the guard's matchers (#1408)", () => {
  /** @param {Set<string>} got @param {string[]} want */
  const includesAll = (got, want) => {
    for (const word of want) assert.ok(got.has(word), `${word} missing from ${JSON.stringify([...got])}`);
  };

  it("wordsOf finds a surname in its plural and possessive forms", () => {
    includesAll(wordsOf("the Brightwells' boiler"), ["brightwell"]);
    includesAll(wordsOf("BRIGHTWELLS"), ["brightwell"]);
  });

  it("wordsOf finds a surname inside a camelCase or upper-snake run", () => {
    includesAll(wordsOf("const brightwellItems = []"), ["brightwell", "items"]);
    includesAll(wordsOf("BRIGHTWELL_ITEMS"), ["brightwell"]);
  });

  it("wordsOf still finds the bare word, and does not join separate words", () => {
    includesAll(wordsOf("brightwell"), ["brightwell"]);
    assert.equal(wordsOf("bright well").has("brightwell"), false);
  });

  it("loginsOf finds a login that ends a sentence or is followed by a suffix", () => {
    includesAll(loginsOf("files live in /home/alex."), ["alex"]);
    includesAll(loginsOf("under ~alex."), ["alex"]);
    includesAll(loginsOf("/home/alex-old"), ["alex"]);
  });

  it("loginsOf finds a login in a lower-case Windows path and in an ordinary path", () => {
    includesAll(loginsOf("c:\\users\\alex\\x"), ["alex"]);
    includesAll(loginsOf("/home/alex/projects"), ["alex"]);
  });

  it("loginsOf ignores a path with no leading slash", () => {
    assert.equal(loginsOf("home/alex").size, 0);
  });
});
