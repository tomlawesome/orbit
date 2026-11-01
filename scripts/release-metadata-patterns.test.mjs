import { spawnSync } from "node:child_process";
import { existsSync, readdirSync, readFileSync, statSync } from "node:fs";
import { dirname, join, relative } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

import { describe, expect, it } from "vitest";

/*
 * #1363 (shared script helpers): the digest and image-reference patterns are
 * defined once per language -- scripts/release-metadata-patterns.sh and its
 * .mjs twin -- and the signing-key preflight and the awk digest extractor
 * live once each in scripts/ci/lib-signing.sh and scripts/ci/lib-digest.sh.
 *
 * Not pinned here (the issue leaves them open): the names of the functions in
 * the two libs, whether the .mjs twin exports RegExp objects or pattern
 * strings (both are accepted), and what the strict registry pattern refuses
 * beyond the cases in STRICT_ONLY_REFUSALS below.
 */
const scriptsDir = dirname(fileURLToPath(import.meta.url));
const shellFile = join(scriptsDir, "release-metadata-patterns.sh");
const moduleFile = join(scriptsDir, "release-metadata-patterns.mjs");
const signingLib = join(scriptsDir, "ci", "lib-signing.sh");
const digestLib = join(scriptsDir, "ci", "lib-digest.sh");

const NAMES = ["ORBIT_DIGEST_PATTERN", "ORBIT_IMAGE_REFERENCE_PATTERN", "ORBIT_REGISTRY_REFERENCE_PATTERN"];

const HEX = "0123456789abcdef".repeat(4);
const digest = `sha256:${HEX}`;

/* value, then the expected verdict for each pattern: [digest, loose image reference, strict registry reference]. */
const TABLE = [
  ["valid digest", digest, [true, false, false]],
  ["uppercase hex digest", `sha256:${HEX.toUpperCase()}`, [false, false, false]],
  ["short hex digest (63)", `sha256:${HEX.slice(1)}`, [false, false, false]],
  ["long hex digest (65)", `sha256:${HEX}0`, [false, false, false]],
  ["digest without the sha256: prefix", HEX, [false, false, false]],
  ["other algorithm", `sha512:${HEX}`, [false, false, false]],
  ["digest with a trailing newline", `${digest}\n`, [false, false, false]],
  ["digest with a leading space", ` ${digest}`, [false, false, false]],
  ["empty string", "", [false, false, false]],
  ["tag-only reference", "ghcr.io/example/orbit:v1.2.3", [false, false, false]],
  ["tag-only reference with port", "registry.example.com:5000/orbit:latest", [false, false, false]],
  ["digest reference", `ghcr.io/example/orbit@${digest}`, [false, true, true]],
  ["registry reference with port", `registry.example.com:5000/orbit/app@${digest}`, [false, true, true]],
  ["tag plus digest reference", `ghcr.io/example/orbit:v1.2.3@${digest}`, [false, true, null]],
  ["reference with uppercase hex digest", `ghcr.io/example/orbit@sha256:${HEX.toUpperCase()}`, [false, false, false]],
  ["reference with short digest", `ghcr.io/example/orbit@sha256:${HEX.slice(1)}`, [false, false, false]],
  ["reference with a trailing newline", `ghcr.io/example/orbit@${digest}\n`, [false, false, false]],
  ["reference with embedded whitespace", `ghcr.io/example/or bit@${digest}`, [false, false, false]],
  ["reference with no repository", `@${digest}`, [false, false, false]],
  ["reference with an empty digest", "ghcr.io/example/orbit@", [false, false, false]],
];
/* null above means the issue does not say: not asserted for that pattern. */

function shellMatches(name, value) {
  const result = spawnSync(
    "bash",
    ["-c", `source "$PATTERN_FILE" && [[ -n "\${!PATTERN_NAME+x}" ]] || exit 2; [[ "$VALUE" =~ \${!PATTERN_NAME} ]]`],
    { encoding: "utf8", env: { ...process.env, PATTERN_FILE: shellFile, PATTERN_NAME: name, VALUE: value } },
  );
  if (result.status === 2) {
    throw new Error(`${relative(scriptsDir, shellFile)} does not define ${name}`);
  }
  if (result.status !== 0 && result.status !== 1) {
    throw new Error(`bash failed (${result.status}): ${result.stderr}`);
  }
  return result.status === 0;
}

async function moduleMatches(name, value) {
  const loaded = await import(pathToFileURL(moduleFile).href);
  const pattern = loaded[name];
  if (pattern === undefined) {
    throw new Error(`${relative(scriptsDir, moduleFile)} does not export ${name}`);
  }
  const regExp = pattern instanceof RegExp ? new RegExp(pattern.source, pattern.flags.replace(/[gy]/gu, "")) : new RegExp(pattern, "u");
  return regExp.test(value);
}

describe("release metadata patterns are defined once per language (#1363)", () => {
  it("scripts/release-metadata-patterns.sh defines the three patterns", () => {
    const source = readFileSync(shellFile, "utf8");
    for (const name of NAMES) {
      expect(source, `${name} in the shell file`).toMatch(new RegExp(`^(?:readonly\\s+)?${name}=`, "mu"));
    }
  });

  it("scripts/release-metadata-patterns.mjs exports the three patterns", async () => {
    expect(existsSync(moduleFile), "scripts/release-metadata-patterns.mjs exists").toBe(true);
    const loaded = await import(pathToFileURL(moduleFile).href);
    for (const name of NAMES) {
      expect(loaded[name], `${name} export`).toBeDefined();
    }
  });

  NAMES.forEach((name, column) => {
    describe(name, () => {
      for (const [label, value, verdicts] of TABLE) {
        const expected = verdicts[column];
        if (expected === null) {
          continue;
        }
        const word = expected ? "accepts" : "refuses";
        it(`bash ${word} ${label}`, () => {
          expect(shellMatches(name, value)).toBe(expected);
        });
        it(`node ${word} ${label}`, async () => {
          expect(await moduleMatches(name, value)).toBe(expected);
        });
      }

      it("bash and node agree on every row of the table", async () => {
        for (const [label, value] of TABLE) {
          expect(await moduleMatches(name, value), `node vs bash on: ${label}`).toBe(shellMatches(name, value));
        }
      });
    });
  });

  it("the strict registry pattern never accepts what the loose image reference pattern refuses", () => {
    for (const [label, value] of TABLE) {
      if (shellMatches("ORBIT_REGISTRY_REFERENCE_PATTERN", value)) {
        expect(shellMatches("ORBIT_IMAGE_REFERENCE_PATTERN", value), label).toBe(true);
      }
    }
  });
});

/* Files that may keep their own literal digest regex (#1363). Paths are relative to scripts/. */
const LITERAL_DIGEST_ALLOW_LIST = new Set([
  "install.sh", // keeps its own patterns: it ships standalone to the owner's host
  "repair.sh", // likewise
  "configure.sh", // likewise: the launcher fetches it on its own, so it cannot source the patterns file
  "dev/get-orbit-preview.sh", // likewise: piped from curl, nothing else is on disk to source
  "release-metadata-patterns.sh",
  "release-metadata-patterns.mjs",
]);
const isTestFile = (path) => /\.(?:test|fixture)\.mjs$/u.test(path);
const LITERAL_DIGEST = /sha256:\\?\[0-9a-f\]/u;

function walk(dir) {
  const found = [];
  for (const entry of readdirSync(dir)) {
    if (entry === "node_modules" || entry.startsWith(".git")) {
      continue;
    }
    const full = join(dir, entry);
    if (statSync(full).isDirectory()) {
      found.push(...walk(full));
    } else if (/\.(?:sh|bash|mjs|js|cjs|ts)$/u.test(entry)) {
      found.push(full);
    }
  }
  return found;
}

function codeLines(path) {
  return readFileSync(path, "utf8")
    .split("\n")
    .map((text, index) => ({ line: index + 1, text }))
    .filter(({ text }) => !/^\s*(?:#|\/\/|\*|\/\*)/u.test(text));
}

describe("no script keeps its own sha256 digest regex (#1363)", () => {
  it("only the allow-listed files hold a literal sha256:[0-9a-f] pattern", () => {
    const offenders = [];
    for (const file of walk(scriptsDir)) {
      const rel = relative(scriptsDir, file);
      if (LITERAL_DIGEST_ALLOW_LIST.has(rel) || isTestFile(rel) || rel === "release-metadata-patterns.test.mjs") {
        continue;
      }
      for (const { line, text } of codeLines(file)) {
        if (LITERAL_DIGEST.test(text)) {
          offenders.push(`scripts/${rel}:${line}: ${text.trim().slice(0, 100)}`);
        }
      }
    }
    expect(offenders, `literal digest regex outside the allow-list:\n${offenders.join("\n")}`).toEqual([]);
  });

  it("the allow-list names only files that exist", () => {
    for (const rel of LITERAL_DIGEST_ALLOW_LIST) {
      expect(existsSync(join(scriptsDir, rel)), rel).toBe(true);
    }
  });
});

/* Non-test, non-comment lines under scripts/ containing `needle`, as "path:line". */
function definitionSites(needle) {
  const sites = [];
  for (const file of walk(scriptsDir)) {
    const rel = relative(scriptsDir, file);
    if (isTestFile(rel) || rel === "release-metadata-patterns.test.mjs") {
      continue;
    }
    for (const { line, text } of codeLines(file)) {
      if (text.includes(needle)) {
        sites.push(`scripts/${rel}:${line}`);
      }
    }
  }
  return sites;
}

const sourcesLib = (script, lib) =>
  new RegExp(`^\\s*(?:source|\\.)\\s+.*${lib.replace(".", "\\.")}`, "mu").test(readFileSync(join(scriptsDir, "ci", script), "utf8"));

describe("shared CI helpers exist and are defined once (#1363)", () => {
  it("scripts/ci/lib-signing.sh and scripts/ci/lib-digest.sh exist and define functions", () => {
    for (const lib of [signingLib, digestLib]) {
      expect(existsSync(lib), relative(scriptsDir, lib)).toBe(true);
      expect(readFileSync(lib, "utf8"), relative(scriptsDir, lib)).toMatch(/^(?:function\s+)?[A-Za-z_][A-Za-z0-9_]*\s*\(\)\s*\{/mu);
    }
  });

  it("the signing-key preflight has exactly one definition, in lib-signing.sh", () => {
    // The preflight today is the "ORBIT_SIGNING_DIR is not a directory" refusal, duplicated inline.
    const sites = definitionSites("ORBIT_SIGNING_DIR is not a directory");
    expect(sites.map((site) => site.replace(/:\d+$/u, "")), `definition sites:\n${sites.join("\n")}`).toEqual([
      "scripts/ci/lib-signing.sh",
    ]);
    expect(sites).toHaveLength(1);
  });

  it("the awk digest extractor has exactly one definition, in lib-digest.sh", () => {
    const sites = definitionSites('$1 == "Digest:"');
    expect(sites.map((site) => site.replace(/:\d+$/u, "")), `definition sites:\n${sites.join("\n")}`).toEqual([
      "scripts/ci/lib-digest.sh",
    ]);
    expect(sites).toHaveLength(1);
  });

  it.each(["attest-tested-image.sh", "sign-release-manifest.sh"])("%s sources lib-signing.sh", (script) => {
    expect(sourcesLib(script, "lib-signing.sh")).toBe(true);
  });

  it.each(["promote-stable.sh", "publish-channel.sh", "publish-image.sh"])("%s sources lib-digest.sh", (script) => {
    expect(sourcesLib(script, "lib-digest.sh")).toBe(true);
  });
});
