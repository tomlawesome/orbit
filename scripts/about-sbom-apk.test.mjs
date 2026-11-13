import { execFileSync, spawnSync } from "node:child_process";
import { mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";

import { describe, expect, it } from "vitest";

import { apkPurl, mergeApkIntoSbom, parseApkInstalled } from "./about-sbom-apk.mjs";
import { spdxDocumentOf } from "./about-sbom.mjs";

/*
 * #1781: the apk packages of the image (poppler-utils, font-liberation, the
 * base image's own) join the About page's bill of materials, read from
 * /lib/apk/db/installed.
 */

const fixture = readFileSync(fileURLToPath(new URL("./fixtures/apk-installed.txt", import.meta.url)), "utf8");
const script = fileURLToPath(new URL("./about-sbom-apk.mjs", import.meta.url));
const policyAllowing = (extra = []) => [
  "allow-licenses:", "  - MIT", "  - ISC", "  - BSD-2-Clause",
  "allow-licenses-apk:", "  - GPL-2.0-only", "  - GPL-2.0-or-later", "  - OFL-1.1",
  "allow-dependencies-licenses:", ...extra.map((purl) => `  - ${purl}`), "",
].join("\n");

const npmDoc = () => spdxDocumentOf([
  { name: "jose", version: "6.2.12", licence: "MIT" },
  { name: "@napi-rs/canvas", version: "0.1.0", licence: "MIT" },
]);

const byName = (list) => Object.fromEntries(list.map((one) => [one.name, one]));
const purlOf = (pkg) => pkg.externalRefs.find((ref) => ref.referenceType === "purl").referenceLocator;

describe("parseApkInstalled", () => {
  const parsed = parseApkInstalled(fixture);
  const named = byName(parsed);

  it("reads one entry per blank-line separated stanza", () => {
    expect(parsed).toHaveLength(7);
    expect(parsed.map((one) => one.name).sort()).toEqual(
      ["bare", "busybox", "fakeblob", "fakelib", "font-liberation", "musl", "poppler-utils"],
    );
  });

  it("reads name, version, arch, licence and url", () => {
    expect(named.musl).toEqual({
      name: "musl", version: "1.2.5-r9", arch: "x86_64", licence: "MIT", url: "https://musl.libc.org/",
    });
    expect(named["poppler-utils"].version).toBe("24.10.0-r2");
    expect(named["font-liberation"]).toMatchObject({ version: "2.1.5-r2", arch: "noarch", licence: "OFL-1.1" });
    expect(named.busybox.licence).toBe("GPL-2.0-only");
  });

  it("keeps a space-separated or custom licence string raw", () => {
    expect(named.fakelib.licence).toBe("MIT BSD-2-Clause");
    expect(named.fakeblob.licence).toBe("custom");
  });

  it("gives null for a missing L: and U:", () => {
    expect(named.bare).toEqual({ name: "bare", version: "0.1-r0", arch: "aarch64", licence: null, url: null });
  });

  it("copes with trailing blank lines, CRLF-free input and empty text", () => {
    expect(parseApkInstalled("")).toEqual([]);
    expect(parseApkInstalled(`\n\n${fixture}\n\n\n`)).toHaveLength(7);
  });
});

describe("apkPurl", () => {
  it("builds pkg:apk/alpine/<name>@<version>?arch=<arch>&distro=alpine-<release>", () => {
    expect(apkPurl({ name: "poppler-utils", version: "24.10.0-r2", arch: "x86_64" }, "3.21.3"))
      .toBe("pkg:apk/alpine/poppler-utils@24.10.0-r2?arch=x86_64&distro=alpine-3.21.3");
    expect(apkPurl({ name: "font-liberation", version: "2.1.5-r2", arch: "noarch" }, "3.22.0"))
      .toBe("pkg:apk/alpine/font-liberation@2.1.5-r2?arch=noarch&distro=alpine-3.22.0");
  });
});

describe("mergeApkIntoSbom", () => {
  const packages = parseApkInstalled(fixture);

  it("keeps the npm packages and adds the apk ones, with versions and purls", () => {
    const merged = mergeApkIntoSbom(npmDoc(), packages, "3.21.3");
    const named = byName(merged.packages);
    expect(named.jose.versionInfo).toBe("6.2.12");
    expect(purlOf(named.jose)).toBe("pkg:npm/jose@6.2.12");
    expect(named["@napi-rs/canvas"]).toBeDefined();
    expect(named["poppler-utils"].versionInfo).toBe("24.10.0-r2");
    expect(named["font-liberation"].versionInfo).toBe("2.1.5-r2");
    expect(purlOf(named["poppler-utils"]))
      .toBe("pkg:apk/alpine/poppler-utils@24.10.0-r2?arch=x86_64&distro=alpine-3.21.3");
    expect(named.busybox.licenseDeclared).toBe("GPL-2.0-only");
    expect(merged.packages).toHaveLength(2 + packages.length);
  });

  it("states a missing licence as NOASSERTION and a missing url as NOASSERTION", () => {
    const bare = byName(mergeApkIntoSbom(npmDoc(), packages, "3.21.3").packages).bare;
    expect(bare.licenseDeclared).toBe("NOASSERTION");
    expect(bare.homepage).toBe("NOASSERTION");
  });

  it("keeps the creation time and the document identity fields of the input", () => {
    const input = spdxDocumentOf([{ name: "jose", version: "6.2.12", licence: "MIT" }], { created: "2026-01-02T03:04:05Z" });
    const merged = mergeApkIntoSbom(input, packages, "3.21.3");
    expect(merged.creationInfo.created).toBe("2026-01-02T03:04:05Z");
    expect(merged.spdxVersion).toBe("SPDX-2.3");
    expect(merged.name).toBe(input.name);
  });

  it("sorts all packages deterministically with unique ids, whatever the input order", () => {
    const merged = mergeApkIntoSbom(npmDoc(), packages, "3.21.3");
    const names = merged.packages.map((one) => one.name);
    expect(names).toEqual([...names].sort((a, b) => a.localeCompare(b, "en")));
    const ids = merged.packages.map((one) => one.SPDXID);
    expect(new Set(ids).size).toBe(ids.length);
    const shuffled = mergeApkIntoSbom(npmDoc(), [...packages].reverse(), "3.21.3");
    expect(JSON.stringify(shuffled)).toBe(JSON.stringify(merged));
  });

  it("gives the same bytes on a rerun and does not mutate its input", () => {
    const input = npmDoc();
    const before = JSON.stringify(input);
    const first = JSON.stringify(mergeApkIntoSbom(input, packages, "3.21.3"));
    const second = JSON.stringify(mergeApkIntoSbom(input, packages, "3.21.3"));
    expect(second).toBe(first);
    expect(JSON.stringify(input)).toBe(before);
  });

  it("changes the namespace when the package list changes, not otherwise", () => {
    const a = mergeApkIntoSbom(npmDoc(), packages, "3.21.3");
    const same = mergeApkIntoSbom(npmDoc(), packages, "3.21.3");
    const fewer = mergeApkIntoSbom(npmDoc(), packages.slice(1), "3.21.3");
    expect(same.documentNamespace).toBe(a.documentNamespace);
    expect(fewer.documentNamespace).not.toBe(a.documentNamespace);
    expect(a.documentNamespace).not.toBe(npmDoc().documentNamespace);
  });
});

describe("about-sbom-apk CLI", () => {
  function setup(policy) {
    const dir = mkdtempSync(join(tmpdir(), "orbit-apk-sbom-"));
    const db = join(dir, "installed");
    const release = join(dir, "alpine-release");
    const sbom = join(dir, "sbom.spdx.json");
    const policyPath = join(dir, "policy.yml");
    writeFileSync(db, fixture);
    writeFileSync(release, "3.21.3\n");
    writeFileSync(sbom, `${JSON.stringify(npmDoc(), null, 2)}\n`);
    writeFileSync(policyPath, policy);
    return { db, release, sbom, policyPath, args: ["--db", db, "--release-file", release, "--sbom", sbom, "--policy", policyPath] };
  }

  it("rewrites the sbom in place with the apk packages when every licence is allowed", () => {
    const policy = policyAllowing(["pkg:apk/alpine/fakeblob"]);
    const { sbom, args } = setup(policy);
    execFileSync("node", [script, ...args], { encoding: "utf8" });
    const doc = JSON.parse(readFileSync(sbom, "utf8"));
    const named = byName(doc.packages);
    expect(purlOf(named["poppler-utils"])).toBe("pkg:apk/alpine/poppler-utils@24.10.0-r2?arch=x86_64&distro=alpine-3.21.3");
    expect(named.jose).toBeDefined();
    const once = readFileSync(sbom, "utf8");
    // A rerun over the already merged file must not duplicate or reorder anything.
    execFileSync("node", [script, ...args], { encoding: "utf8" });
    expect(JSON.parse(readFileSync(sbom, "utf8")).packages).toHaveLength(doc.packages.length);
    expect(once.length).toBeGreaterThan(0);
  });

  it("exits non-zero and names the package when an apk licence is not allowed", () => {
    const { args } = setup(policyAllowing()); // `custom` has no exception
    const result = spawnSync("node", [script, ...args], { encoding: "utf8" });
    expect(result.status).not.toBe(0);
    expect(`${result.stdout}${result.stderr}`).toContain("fakeblob");
  });
});
