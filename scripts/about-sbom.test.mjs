import { mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { describe, expect, it } from "vitest";

import { spdxDocumentOf } from "./about-sbom.mjs";
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
