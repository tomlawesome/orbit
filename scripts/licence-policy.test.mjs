import { mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { describe, expect, it } from "vitest";

import {
  checkApkLicences,
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

// #1781: the image's apk packages are checked against the same policy file.
describe("apk licences (#1781)", () => {
  function apkPolicy(dir, { allow = ["MIT"], allowApk = [], exceptions = [] }) {
    const path = join(dir, "apk-policy.yml");
    writeFileSync(path, [
      "allow-licenses:", ...allow.map((id) => `  - ${id}`),
      "allow-licenses-apk:", ...allowApk.map((id) => `  - ${id}`),
      "allow-dependencies-licenses:", ...exceptions.map((purl) => `  - ${purl}`), "",
    ].join("\n"), "utf8");
    return path;
  }
  const pkg = (name, licence, version = "1.0-r0") => ({ name, version, arch: "x86_64", licence, url: null });
  const refusedNames = (packages, policy) => checkApkLicences(packages, policy).map((one) => one.name);

  it("allows an apk licence from allow-licenses-apk and from allow-licenses", () => {
    const policy = loadPolicy(apkPolicy(scratchDir(), { allowApk: ["GPL-2.0-only"] }));
    expect(checkApkLicences([pkg("busybox", "GPL-2.0-only"), pkg("musl", "MIT")], policy)).toEqual([]);
  });

  it("refuses a licence in neither list", () => {
    const policy = loadPolicy(apkPolicy(scratchDir(), {}));
    expect(refusedNames([pkg("busybox", "GPL-2.0-only"), pkg("musl", "MIT")], policy)).toEqual(["busybox"]);
  });

  it("reads bare space-separated ids as AND", () => {
    const policy = loadPolicy(apkPolicy(scratchDir(), { allow: ["MIT", "BSD-2-Clause"] }));
    expect(checkApkLicences([pkg("both", "MIT BSD-2-Clause")], policy)).toEqual([]);
    expect(refusedNames([pkg("half", "MIT GPL-3.0-only")], policy)).toEqual(["half"]);
  });

  it("fails closed on custom, a missing licence and unparseable text unless excepted", () => {
    const dir = scratchDir();
    const bad = [pkg("blob", "custom"), pkg("none", null), pkg("odd", "MIT AND (")];
    expect(refusedNames(bad, loadPolicy(apkPolicy(dir, {})))).toEqual(["blob", "none", "odd"]);
    const excepted = loadPolicy(apkPolicy(dir, { exceptions: ["pkg:apk/alpine/blob", "pkg:apk/alpine/none", "pkg:apk/alpine/odd"] }));
    expect(checkApkLicences(bad, excepted)).toEqual([]);
  });

  it("matches a version-free apk exception against any version", () => {
    const policy = loadPolicy(apkPolicy(scratchDir(), { exceptions: ["pkg:apk/alpine/blob"] }));
    expect(checkApkLicences([pkg("blob", "custom", "1.0-r0"), pkg("blob", "custom", "9.9-r7")], policy)).toEqual([]);
    expect(refusedNames([pkg("other", "custom")], policy)).toEqual(["other"]);
  });

  it("never lets allow-licenses-apk allow an npm package's licence", () => {
    const dir = scratchDir();
    const root = join(dir, "tree");
    writePackage(root, "node_modules/copyleft", { name: "copyleft", version: "1.0.0", license: "GPL-2.0-only" });
    const policyPath = apkPolicy(dir, { allowApk: ["GPL-2.0-only"] });
    const { offending } = checkInstalledTree({ root, policyPath });
    expect(offending.map((one) => one.name)).toEqual(["copyleft"]);
  });

  it("keeps npm exceptions exact-version, and an apk exception does not excuse an npm package", () => {
    const dir = scratchDir();
    const root = join(dir, "tree");
    writePackage(root, "node_modules/font", { name: "font", version: "2.0.0", license: "OFL-1.1" });
    const exact = apkPolicy(dir, { exceptions: ["pkg:npm/font@2.0.0"] });
    expect(checkInstalledTree({ root, policyPath: exact }).offending).toEqual([]);
    const otherVersion = apkPolicy(dir, { exceptions: ["pkg:npm/font@1.0.0"] });
    expect(checkInstalledTree({ root, policyPath: otherVersion }).offending.map((one) => one.name)).toEqual(["font"]);
    const apkNamed = apkPolicy(dir, { exceptions: ["pkg:apk/alpine/font"] });
    expect(checkInstalledTree({ root, policyPath: apkNamed }).offending.map((one) => one.name)).toEqual(["font"]);
  });

  it("still rejects a version-free npm exception", () => {
    const path = apkPolicy(scratchDir(), { exceptions: ["pkg:npm/font"] });
    expect(() => loadPolicy(path)).toThrow();
  });
});
