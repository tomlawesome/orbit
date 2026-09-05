import { mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { describe, expect, it } from "vitest";

import {
  checkInstalledTree,
  discoverInstalledPackages,
  fontsourceShippedIdentities,
  isLicenceAllowed,
  loadPolicy,
  parsePnpmListProdJson,
  parsePurlException,
} from "./ci/licence-policy.mjs";

// Each test builds its own tree under a fresh temp directory; the test-file
// temp root (tests/support/temp-root.ts) removes everything when this file's
// run ends, so nothing here has to clean up after itself.
function scratchDir() {
  return mkdtempSync(join(tmpdir(), "orbit-licence-policy-"));
}

function writePolicy(dir, { allowLicenses, allowDependenciesLicenses = [] }) {
  const path = join(dir, "licence-policy.yml");
  const lines = [
    "allow-licenses:",
    ...allowLicenses.map((id) => `  - ${id}`),
    "allow-dependencies-licenses:",
    ...allowDependenciesLicenses.map((purl) => `  - ${purl}`),
  ];
  writeFileSync(path, lines.join("\n") + "\n", "utf8");
  return path;
}

function writePackage(root, packagePath, manifest) {
  const dir = join(root, packagePath);
  mkdirSync(dir, { recursive: true });
  writeFileSync(join(dir, "package.json"), JSON.stringify(manifest, null, 2), "utf8");
}

describe("loadPolicy", () => {
  it("reads the allow-licenses and allow-dependencies-licenses lists, ignoring comments", () => {
    const dir = scratchDir();
    const policyPath = join(dir, "policy.yml");
    writeFileSync(
      policyPath,
      [
        "# header comment",
        "allow-licenses:",
        "  - MIT",
        "  - ISC # inline comment",
        "# a comment above the exceptions",
        "allow-dependencies-licenses:",
        "  - pkg:npm/@img/sharp-libvips-linux-x64@1.3.0",
        "",
      ].join("\n"),
      "utf8",
    );
    const policy = loadPolicy(policyPath);
    expect(policy.allowLicences).toEqual(new Set(["MIT", "ISC"]));
    expect(policy.allowExactExceptions).toEqual(
      new Set(["@img/sharp-libvips-linux-x64@1.3.0"]),
    );
  });
});

describe("parsePurlException", () => {
  it("splits a scoped package name from its exact version", () => {
    expect(parsePurlException("pkg:npm/@img/sharp-libvips-linux-x64@1.3.0")).toEqual({
      name: "@img/sharp-libvips-linux-x64",
      version: "1.3.0",
    });
    expect(parsePurlException("pkg:npm/left-pad@1.0.0")).toEqual({
      name: "left-pad",
      version: "1.0.0",
    });
  });

  it("rejects a PURL with no version", () => {
    expect(() => parsePurlException("pkg:npm/left-pad")).toThrow();
  });
});

describe("isLicenceAllowed", () => {
  const allow = new Set(["MIT", "ISC", "Apache-2.0"]);

  it("passes a single allowed licence", () => {
    expect(isLicenceAllowed("MIT", allow)).toBe(true);
  });

  it("passes an OR expression when at least one branch is allowed", () => {
    expect(isLicenceAllowed("ISC OR GPL-3.0-only", allow)).toBe(true);
    expect(isLicenceAllowed("GPL-3.0-only OR ISC", allow)).toBe(true);
  });

  it("fails an AND expression when any part is disallowed", () => {
    expect(isLicenceAllowed("MIT AND GPL-3.0-only", allow)).toBe(false);
  });

  it("passes an AND expression only when every part is allowed", () => {
    expect(isLicenceAllowed("MIT AND ISC", allow)).toBe(true);
  });

  it("honours parentheses", () => {
    expect(isLicenceAllowed("(MIT OR GPL-3.0-only) AND ISC", allow)).toBe(true);
    expect(isLicenceAllowed("MIT OR (GPL-3.0-only AND ISC)", allow)).toBe(true);
    expect(isLicenceAllowed("(MIT AND GPL-3.0-only) OR BSD-3-Clause", allow)).toBe(false);
  });

  it("fails closed on missing, empty, UNLICENSED and SEE LICENSE IN", () => {
    expect(isLicenceAllowed(undefined, allow)).toBe(false);
    expect(isLicenceAllowed("", allow)).toBe(false);
    expect(isLicenceAllowed("   ", allow)).toBe(false);
    expect(isLicenceAllowed("UNLICENSED", allow)).toBe(false);
    expect(isLicenceAllowed("SEE LICENSE IN LICENSE.txt", allow)).toBe(false);
  });

  it("fails closed on an unparseable expression", () => {
    expect(isLicenceAllowed("(MIT", allow)).toBe(false);
    expect(isLicenceAllowed("MIT AND", allow)).toBe(false);
  });
});

describe("discoverInstalledPackages", () => {
  it("walks a flat node_modules tree", () => {
    const root = scratchDir();
    writePackage(root, "node_modules/mit-pkg", { name: "mit-pkg", version: "1.0.0", license: "MIT" });
    const packages = discoverInstalledPackages(root);
    expect(packages).toEqual([{ name: "mit-pkg", version: "1.0.0", licence: "MIT" }]);
  });

  it("walks the pnpm .pnpm store layout, including scoped packages", () => {
    const root = scratchDir();
    writePackage(
      root,
      "node_modules/.pnpm/@img+sharp-libvips-linux-x64@1.3.0/node_modules/@img/sharp-libvips-linux-x64",
      { name: "@img/sharp-libvips-linux-x64", version: "1.3.0", license: "LGPL-3.0-or-later" },
    );
    const packages = discoverInstalledPackages(root);
    expect(packages).toEqual([
      { name: "@img/sharp-libvips-linux-x64", version: "1.3.0", licence: "LGPL-3.0-or-later" },
    ]);
  });

  it("skips the root package and workspace members, not just their name", () => {
    const root = scratchDir();
    writeFileSync(join(root, "package.json"), JSON.stringify({ name: "orbit", version: "1.0.0", license: "AGPL-3.0-or-later" }), "utf8");
    writePackage(root, "node_modules/mit-pkg", { name: "mit-pkg", version: "1.0.0", license: "MIT" });
    const packages = discoverInstalledPackages(root);
    expect(packages).toEqual([{ name: "mit-pkg", version: "1.0.0", licence: "MIT" }]);
  });
});

describe("checkInstalledTree", () => {
  it("passes an allowed tree", () => {
    const root = scratchDir();
    writePackage(root, "node_modules/mit-pkg", { name: "mit-pkg", version: "1.0.0", license: "MIT" });
    writePackage(root, "node_modules/isc-pkg", { name: "isc-pkg", version: "2.0.0", license: "ISC" });
    const policyPath = writePolicy(scratchDir(), { allowLicenses: ["MIT", "ISC"] });
    const result = checkInstalledTree({ root, policyPath });
    expect(result.checked).toBe(2);
    expect(result.offending).toEqual([]);
  });

  it("fails a GPL-3.0-only package", () => {
    const root = scratchDir();
    writePackage(root, "node_modules/gpl-pkg", { name: "gpl-pkg", version: "2.0.0", license: "GPL-3.0-only" });
    const policyPath = writePolicy(scratchDir(), { allowLicenses: ["MIT"] });
    const result = checkInstalledTree({ root, policyPath });
    expect(result.checked).toBe(1);
    expect(result.offending).toEqual([{ name: "gpl-pkg", version: "2.0.0", licence: "GPL-3.0-only" }]);
  });

  it("fails a package with no licence field", () => {
    const root = scratchDir();
    writePackage(root, "node_modules/no-licence-pkg", { name: "no-licence-pkg", version: "1.0.0" });
    const policyPath = writePolicy(scratchDir(), { allowLicenses: ["MIT"] });
    const result = checkInstalledTree({ root, policyPath });
    expect(result.offending).toEqual([{ name: "no-licence-pkg", version: "1.0.0", licence: "" }]);
  });

  it("passes an exact-version dependency exception", () => {
    const root = scratchDir();
    writePackage(
      root,
      "node_modules/.pnpm/@img+sharp-libvips-linux-x64@1.3.0/node_modules/@img/sharp-libvips-linux-x64",
      { name: "@img/sharp-libvips-linux-x64", version: "1.3.0", license: "LGPL-3.0-or-later" },
    );
    const policyPath = writePolicy(scratchDir(), {
      allowLicenses: ["MIT"],
      allowDependenciesLicenses: ["pkg:npm/@img/sharp-libvips-linux-x64@1.3.0"],
    });
    const result = checkInstalledTree({ root, policyPath });
    expect(result.offending).toEqual([]);
  });

  it("fails the same exception name at a different version", () => {
    const root = scratchDir();
    writePackage(
      root,
      "node_modules/.pnpm/@img+sharp-libvips-linux-x64@1.4.0/node_modules/@img/sharp-libvips-linux-x64",
      { name: "@img/sharp-libvips-linux-x64", version: "1.4.0", license: "LGPL-3.0-or-later" },
    );
    const policyPath = writePolicy(scratchDir(), {
      allowLicenses: ["MIT"],
      allowDependenciesLicenses: ["pkg:npm/@img/sharp-libvips-linux-x64@1.3.0"],
    });
    const result = checkInstalledTree({ root, policyPath });
    expect(result.offending).toEqual([
      { name: "@img/sharp-libvips-linux-x64", version: "1.4.0", licence: "LGPL-3.0-or-later" },
    ]);
  });

  it("passes an OR expression with one allowed branch", () => {
    const root = scratchDir();
    writePackage(root, "node_modules/or-pkg", { name: "or-pkg", version: "1.0.0", license: "ISC OR GPL-3.0-only" });
    const policyPath = writePolicy(scratchDir(), { allowLicenses: ["ISC"] });
    const result = checkInstalledTree({ root, policyPath });
    expect(result.offending).toEqual([]);
  });

  it("fails an AND expression with one disallowed part", () => {
    const root = scratchDir();
    writePackage(root, "node_modules/and-pkg", { name: "and-pkg", version: "1.0.0", license: "MIT AND GPL-3.0-only" });
    const policyPath = writePolicy(scratchDir(), { allowLicenses: ["MIT"] });
    const result = checkInstalledTree({ root, policyPath });
    expect(result.offending).toEqual([
      { name: "and-pkg", version: "1.0.0", licence: "MIT AND GPL-3.0-only" },
    ]);
  });

  it("with shippedIdentities, ignores a disallowed package outside the shipped set", () => {
    const root = scratchDir();
    writePackage(root, "node_modules/gpl-build-tool", { name: "gpl-build-tool", version: "1.0.0", license: "GPL-3.0-only" });
    writePackage(root, "node_modules/mit-pkg", { name: "mit-pkg", version: "1.0.0", license: "MIT" });
    const policyPath = writePolicy(scratchDir(), { allowLicenses: ["MIT"] });
    const result = checkInstalledTree({
      root,
      policyPath,
      shippedIdentities: new Set(["mit-pkg@1.0.0"]),
    });
    expect(result.checked).toBe(1);
    expect(result.offending).toEqual([]);
  });

  it("with shippedIdentities, still fails a disallowed package inside the shipped set", () => {
    const root = scratchDir();
    writePackage(root, "node_modules/gpl-pkg", { name: "gpl-pkg", version: "2.0.0", license: "GPL-3.0-only" });
    const policyPath = writePolicy(scratchDir(), { allowLicenses: ["MIT"] });
    const result = checkInstalledTree({
      root,
      policyPath,
      shippedIdentities: new Set(["gpl-pkg@2.0.0"]),
    });
    expect(result.checked).toBe(1);
    expect(result.offending).toEqual([
      { name: "gpl-pkg", version: "2.0.0", licence: "GPL-3.0-only" },
    ]);
  });
});

describe("parsePnpmListProdJson", () => {
  it("collects name@version identities across every workspace project, nested dependencies included", () => {
    const json = JSON.stringify([
      {
        name: "orbit",
        dependencies: {
          zod: { from: "zod", version: "4.4.3", resolved: "https://example/zod" },
          jose: {
            from: "jose",
            version: "6.2.4",
            dependencies: {
              "nested-dep": { from: "nested-dep", version: "1.0.0" },
            },
          },
        },
      },
      {
        name: "orbit-web",
        dependencies: {
          zod: { from: "zod", version: "4.4.3" },
        },
      },
    ]);
    const identities = parsePnpmListProdJson(json);
    expect(identities).toEqual(new Set(["zod@4.4.3", "jose@6.2.4", "nested-dep@1.0.0"]));
  });

  it("returns an empty set for a project with no production dependencies", () => {
    expect(parsePnpmListProdJson(JSON.stringify([{ name: "orbit" }]))).toEqual(new Set());
  });
});

describe("fontsourceShippedIdentities", () => {
  it("keeps only the @fontsource-prefixed entries, by their declared exact version", () => {
    const identities = fontsourceShippedIdentities({
      "@fontsource/space-grotesk": "5.3.0",
      "@fontsource-variable/inter": "5.3.0",
      vite: "8.2.1",
    });
    expect(identities).toEqual(new Set(["@fontsource/space-grotesk@5.3.0", "@fontsource-variable/inter@5.3.0"]));
  });

  it("returns an empty set when there are no devDependencies", () => {
    expect(fontsourceShippedIdentities(undefined)).toEqual(new Set());
  });
});
