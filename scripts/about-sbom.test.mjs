import { mkdirSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { describe, expect, it } from "vitest";

import { librariesOf } from "../web/src/lib/about/group.js";
import { spdxDocumentOf, writeAboutFiles } from "./about-sbom.mjs";
import { discoverInstalledPackages } from "./ci/licence-policy.mjs";

/*
 * The About page's bill of materials (#1256): an SPDX 2.3 document of what
 * ships, made in the image build from licence-policy.mjs's own walk. The
 * same tree must give the same bytes (ADR-0028's content ID), and no
 * maintainer's e-mail address is carried into the page.
 */

function writePackage(root, packagePath, manifest) {
  const dir = join(root, packagePath);
  mkdirSync(dir, { recursive: true });
  writeFileSync(join(dir, "package.json"), JSON.stringify(manifest, null, 2), "utf8");
}

describe("discoverInstalledPackages({ details: true }) (#1256)", () => {
  it("adds the author's name and a web address, and nothing when not asked", () => {
    const root = mkdtempSync(join(tmpdir(), "orbit-about-sbom-"));
    writePackage(root, "node_modules/a", {
      name: "a", version: "1.0.0", license: "MIT",
      author: "Jane Doe <jane@example.com> (https://jane.example)",
      repository: "git+https://github.com/jane/a.git",
    });
    writePackage(root, "node_modules/b", {
      name: "b", version: "2.0.0", license: "ISC",
      author: { name: "B Team", email: "team@example.com" },
      repository: "github:bteam/b",
      homepage: "https://b.example/",
    });
    writePackage(root, "node_modules/c", { name: "c", version: "3.0.0", license: "MIT", repository: { url: "ssh://git@github.com/c/c.git" } });

    const byName = Object.fromEntries(discoverInstalledPackages(root, { details: true }).map((pkg) => [pkg.name, pkg]));
    expect(byName.a).toEqual({ name: "a", version: "1.0.0", licence: "MIT", author: "Jane Doe", homepage: "https://github.com/jane/a" });
    expect(byName.b).toEqual({ name: "b", version: "2.0.0", licence: "ISC", author: "B Team", homepage: "https://b.example/" });
    expect(byName.c).toEqual({ name: "c", version: "3.0.0", licence: "MIT", author: "", homepage: "https://github.com/c/c" });
    expect(JSON.stringify(byName)).not.toMatch(/@example\.com/);

    expect(discoverInstalledPackages(root).find((pkg) => pkg.name === "a")).toEqual({ name: "a", version: "1.0.0", licence: "MIT" });
  });
});

describe("spdxDocumentOf (#1256)", () => {
  const PACKAGES = [
    { name: "zod", version: "4.6.5", licence: "MIT", author: "Colin McDonnell", homepage: "https://zod.dev/" },
    { name: "@napi-rs/canvas", version: "1.0.9", licence: "MIT", author: "", homepage: "" },
    { name: "odd", version: "0.0.1", licence: "SEE LICENSE IN LICENCE.md", author: "", homepage: "" },
    { name: "zod", version: "4.6.5", licence: "MIT", author: "Colin McDonnell", homepage: "https://zod.dev/" },
  ];

  it("writes an SPDX 2.3 document, one package per name@version, sorted", () => {
    const document = spdxDocumentOf(PACKAGES);
    expect(document.spdxVersion).toBe("SPDX-2.3");
    expect(document.dataLicense).toBe("CC0-1.0");
    expect(document.packages.map((pkg) => `${pkg.name}@${pkg.versionInfo}`)).toEqual(
      ["@napi-rs/canvas@1.0.9", "odd@0.0.1", "zod@4.6.5"]);
    const zod = document.packages[2];
    expect(zod).toMatchObject({
      SPDXID: "SPDXRef-Package-3",
      supplier: "Person: Colin McDonnell",
      homepage: "https://zod.dev/",
      licenseDeclared: "MIT",
    });
    expect(zod.externalRefs[0].referenceLocator).toBe("pkg:npm/zod@4.6.5");
    expect(document.packages[0].externalRefs[0].referenceLocator).toBe("pkg:npm/%40napi-rs/canvas@1.0.9");
    expect(document.packages[0]).toMatchObject({ supplier: "NOASSERTION", homepage: "NOASSERTION" });
    expect(document.packages[1].licenseDeclared).toBe("NOASSERTION");
  });

  it("gives the same bytes for the same tree, whatever order it was walked in", () => {
    const once = JSON.stringify(spdxDocumentOf(PACKAGES));
    const again = JSON.stringify(spdxDocumentOf([...PACKAGES].reverse()));
    expect(again).toBe(once);
    expect(spdxDocumentOf(PACKAGES).creationInfo.created).toBe("1970-01-01T00:00:00Z");
    expect(spdxDocumentOf(PACKAGES.slice(0, 1)).documentNamespace)
      .not.toBe(spdxDocumentOf(PACKAGES).documentNamespace);
  });
});

/*
 * #1575: the image build also writes the finished library list the About page
 * shows, so the page reads a ready list and never groups the SBOM at request
 * time. Interface assumed: `writeAboutFiles(packages, output, { created })`
 * writes the SPDX document to `output` (as before) and the exact
 * `librariesOf(document)` list to `libraries.json` in the same directory, both
 * as `JSON.stringify(value, null, 2)` plus a newline; main() calls it.
 */
describe("writeAboutFiles (#1575)", () => {
  const PACKAGES = [
    { name: "zod", version: "4.6.5", licence: "MIT", author: "Colin McDonnell", homepage: "https://zod.dev/" },
    { name: "@napi-rs/canvas", version: "1.0.9", licence: "MIT", author: "", homepage: "" },
    { name: "odd", version: "0.0.1", licence: "SEE LICENSE IN LICENCE.md", author: "", homepage: "" },
  ];

  const run = (packages = PACKAGES) => {
    const dir = mkdtempSync(join(tmpdir(), "orbit-about-files-"));
    const output = join(dir, "about", "sbom.spdx.json");
    writeAboutFiles(packages, output);
    return {
      sbom: readFileSync(output, "utf8"),
      libraries: readFileSync(join(dir, "about", "libraries.json"), "utf8"),
    };
  };

  it("writes libraries.json beside the SBOM, equal to librariesOf of that SBOM", () => {
    const { sbom, libraries } = run();
    expect(JSON.parse(libraries)).toEqual(librariesOf(JSON.parse(sbom)));
    expect(JSON.parse(libraries).map((one) => one.name)).toEqual(["@napi-rs/canvas", "odd", "zod"]);
  });

  it("leaves the SBOM exactly as it was", () => {
    expect(run().sbom).toBe(`${JSON.stringify(spdxDocumentOf(PACKAGES), null, 2)}\n`);
  });

  it("gives byte-identical files on two runs, whatever order the tree was walked in (ADR-0028)", () => {
    const first = run();
    const second = run([...PACKAGES].reverse());
    expect(second.libraries).toBe(first.libraries);
    expect(second.sbom).toBe(first.sbom);
    expect(first.libraries.endsWith("\n")).toBe(true);
  });
});
