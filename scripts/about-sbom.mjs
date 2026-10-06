// The About page's bill of materials (#1256): an SPDX 2.3 JSON document of
// every package that ships, written into the web build's static files so the
// image carries the list of what it is made of.
//
// Standard pattern: a source SBOM generated from the build's own dependency
// tree. CI's image SBOM (Trivy over the built image, `supply_chain_image`)
// cannot be used for this: it only exists after the image does, so it can
// never ship inside it. The walk and the scope are scripts/ci/licence-
// policy.mjs's, so the licence gate and the credits cover the same packages:
// the production tree plus the three @fontsource packages, never build or
// test tooling (owner, #1256 answer 10).
//
// Deterministic on purpose: the same tree must give the same file, or the
// image content ID ADR-0028 relies on would differ between two commits of
// one tree. So the creation time is the epoch unless SOURCE_DATE_EPOCH says
// otherwise, the namespace is a hash of the package list, and packages are
// sorted.
//
// Usage: node scripts/about-sbom.mjs [output] [--root dir]
//   default output: web/static/about/sbom.spdx.json

import { createHash } from "node:crypto";
import { mkdirSync, writeFileSync } from "node:fs";
import { dirname, isAbsolute, resolve } from "node:path";
import { fileURLToPath } from "node:url";

import { collectShippedIdentities, discoverInstalledPackages } from "./ci/licence-policy.mjs";

const repositoryRoot = fileURLToPath(new URL("../", import.meta.url));

/** "MIT", "(MIT OR Apache-2.0)"; anything empty or not stated is NOASSERTION. */
function declared(licence) {
  const trimmed = String(licence ?? "").trim();
  if (!trimmed || /^(UNLICENSED|SEE LICENSE IN)/i.test(trimmed)) return "NOASSERTION";
  return trimmed;
}

/**
 * The document, from discoverInstalledPackages's `details` entries already
 * filtered to what ships.
 *
 * @param {{ name: string, version: string, licence: string, author?: string, homepage?: string }[]} packages
 * @param {{ created?: string }} [options]
 */
export function spdxDocumentOf(packages, { created = "1970-01-01T00:00:00Z" } = {}) {
  const unique = new Map();
  for (const pkg of packages) unique.set(`${pkg.name}@${pkg.version}`, pkg);
  const sorted = [...unique.values()].sort((a, b) =>
    a.name.localeCompare(b.name, "en") || a.version.localeCompare(b.version, "en"));
  const identity = createHash("sha256")
    .update(sorted.map((pkg) => `${pkg.name}@${pkg.version}`).join("\n"))
    .digest("hex");
  return {
    spdxVersion: "SPDX-2.3",
    dataLicense: "CC0-1.0",
    SPDXID: "SPDXRef-DOCUMENT",
    name: "orbit-shipped-packages",
    documentNamespace: `https://spdx.org/spdxdocs/orbit-shipped-packages-${identity}`,
    creationInfo: { created, creators: ["Tool: orbit-about-sbom"] },
    packages: sorted.map((pkg, index) => ({
      SPDXID: `SPDXRef-Package-${index + 1}`,
      name: pkg.name,
      versionInfo: pkg.version,
      supplier: pkg.author ? `Person: ${pkg.author}` : "NOASSERTION",
      downloadLocation: "NOASSERTION",
      homepage: pkg.homepage || "NOASSERTION",
      filesAnalyzed: false,
      licenseConcluded: "NOASSERTION",
      licenseDeclared: declared(pkg.licence),
      copyrightText: "NOASSERTION",
      externalRefs: [{
        referenceCategory: "PACKAGE-MANAGER",
        referenceType: "purl",
        referenceLocator: `pkg:npm/${pkg.name.replace(/^@/, "%40")}@${pkg.version}`,
      }],
    })),
  };
}

function main() {
  const argv = process.argv.slice(2);
  let output = "web/static/about/sbom.spdx.json";
  let root = repositoryRoot;
  for (let i = 0; i < argv.length; i += 1) {
    if (argv[i] === "--root" && argv[i + 1] !== undefined) root = argv[++i];
    else output = argv[i];
  }
  root = isAbsolute(root) ? root : resolve(process.cwd(), root);
  output = isAbsolute(output) ? output : resolve(root, output);

  const shipped = collectShippedIdentities(root);
  const packages = discoverInstalledPackages(root, { details: true })
    .filter((pkg) => shipped.has(`${pkg.name}@${pkg.version}`));
  const epoch = Number(process.env.SOURCE_DATE_EPOCH);
  const created = Number.isFinite(epoch) && epoch > 0
    ? new Date(epoch * 1000).toISOString().replace(/\.\d{3}Z$/, "Z")
    : undefined;
  const document = spdxDocumentOf(packages, { created });
  mkdirSync(dirname(output), { recursive: true });
  writeFileSync(output, `${JSON.stringify(document, null, 2)}\n`);
  console.log(`about-sbom: ${document.packages.length} shipped package(s) written to ${output}`);
}

if (process.argv[1] && fileURLToPath(import.meta.url) === process.argv[1]) main();
