// The image's Alpine (apk) packages join the About page's bill of materials
// (#1781). Standard pattern: a package-manager database scan of
// /lib/apk/db/installed, which is what Syft and Trivy do. Each package gets the
// purl pkg:apk/alpine/<name>@<version>?arch=<arch>&distro=alpine-<release>,
// the release read from /etc/alpine-release.
//
// It runs in the Dockerfile's runner stage, right after the web build is
// copied in (the packages exist only there), and rewrites the shipped
// client/about/sbom.spdx.json -- and libraries.json beside it -- in place. The
// same step fails the build if an apk licence is not allowed by
// supply-chain/licence-policy.yml (`allow-licenses-apk`).
//
// Deterministic, like scripts/about-sbom.mjs: packages sorted, the creation
// time and document identity of the input kept, the namespace hashed over the
// combined list. Re-running over an already merged file changes nothing.
//
// Dependency-free on purpose: the runner has no node_modules at this point.
//
// Usage: node scripts/about-sbom-apk.mjs [--db file] [--release-file file]
//   [--sbom file] [--policy file]

import { readFileSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

import { librariesOf } from "../web/src/lib/about/group.js";
import { checkApkLicences, loadPolicy } from "./ci/licence-policy.mjs";
import { documentNamespaceOf, spdxPackageOf } from "./about-sbom.mjs";

/**
 * Reads the apk database: stanzas separated by blank lines, one `X:value`
 * line per field. Only P (name), V (version), A (arch), L (licence) and U
 * (url) are kept; a missing L or U is null and the licence string stays raw.
 *
 * @param {string} text
 * @returns {{ name: string, version: string, arch: string, licence: string | null, url: string | null }[]}
 */
export function parseApkInstalled(text) {
  const packages = [];
  for (const stanza of String(text ?? "").split(/\r?\n\r?\n/)) {
    /** @type {Record<string, string>} */
    const fields = {};
    for (const line of stanza.split(/\r?\n/)) {
      const match = /^([A-Za-z]):(.*)$/.exec(line);
      if (match && !(match[1] in fields)) fields[match[1]] = match[2].trim();
    }
    if (!fields.P || !fields.V) continue;
    packages.push({
      name: fields.P,
      version: fields.V,
      arch: fields.A || "noarch",
      licence: fields.L || null,
      url: fields.U || null,
    });
  }
  return packages;
}

/** pkg:apk/alpine/<name>@<version>?arch=<arch>&distro=alpine-<release> */
export function apkPurl(pkg, release) {
  return `pkg:apk/alpine/${pkg.name}@${pkg.version}?arch=${pkg.arch}&distro=alpine-${release}`;
}

const isApkEntry = (/** @type {any} */ entry) =>
  (entry.externalRefs ?? []).some((/** @type {any} */ ref) => String(ref.referenceLocator ?? "").startsWith("pkg:apk/"));

/**
 * A new SPDX document: the input's packages (its own apk entries, from an
 * earlier run, dropped first) plus the apk ones, sorted, renumbered, with the
 * namespace hashed over the combined list. Neither input is mutated.
 */
export function mergeApkIntoSbom(document, apkPackages, release) {
  const entries = [
    ...document.packages.filter((entry) => !isApkEntry(entry)),
    ...apkPackages.map((pkg) => spdxPackageOf({
      name: pkg.name, version: pkg.version, licence: pkg.licence, homepage: pkg.url, purl: apkPurl(pkg, release),
    })),
  ];
  entries.sort((a, b) =>
    a.name.localeCompare(b.name, "en") || a.versionInfo.localeCompare(b.versionInfo, "en")
    || a.externalRefs[0].referenceLocator.localeCompare(b.externalRefs[0].referenceLocator, "en"));
  return {
    ...JSON.parse(JSON.stringify({ ...document, packages: undefined })),
    documentNamespace: documentNamespaceOf(entries.map((entry) => ({ name: entry.name, version: entry.versionInfo }))),
    packages: entries.map((entry, index) => ({ ...entry, SPDXID: `SPDXRef-Package-${index + 1}` })),
  };
}

function main() {
  const argv = process.argv.slice(2);
  const here = dirname(fileURLToPath(import.meta.url));
  const opts = {
    db: "/lib/apk/db/installed",
    "release-file": "/etc/alpine-release",
    sbom: "web/client/about/sbom.spdx.json",
    policy: join(here, "../supply-chain/licence-policy.yml"),
  };
  for (let i = 0; i < argv.length; i += 2) {
    const key = argv[i].replace(/^--/, "");
    if (!(key in opts) || argv[i + 1] === undefined) {
      console.error(`about-sbom-apk: unknown or incomplete option ${argv[i]}`);
      process.exitCode = 2;
      return;
    }
    opts[/** @type {keyof typeof opts} */ (key)] = argv[i + 1];
  }

  const release = readFileSync(opts["release-file"], "utf8").trim();
  const packages = parseApkInstalled(readFileSync(opts.db, "utf8"));
  if (packages.length === 0 || release === "") {
    console.error("about-sbom-apk: no apk packages or no release found");
    process.exitCode = 1;
    return;
  }

  const refused = checkApkLicences(packages, loadPolicy(opts.policy));
  if (refused.length > 0) {
    for (const pkg of refused) console.error(`${pkg.name}@${pkg.version}  ${pkg.licence ?? "(no licence)"}  -> not allowed`);
    console.error(`about-sbom-apk: ${refused.length} of ${packages.length} apk package(s) failed the licence policy.`);
    process.exitCode = 1;
    return;
  }

  const merged = mergeApkIntoSbom(JSON.parse(readFileSync(opts.sbom, "utf8")), packages, release);
  writeFileSync(opts.sbom, `${JSON.stringify(merged, null, 2)}\n`);
  // libraries.json beside the SBOM (#1575) must stay exactly librariesOf(document).
  writeFileSync(join(dirname(opts.sbom), "libraries.json"), `${JSON.stringify(librariesOf(merged), null, 2)}\n`);
  console.log(`about-sbom-apk: ${packages.length} apk package(s) (alpine ${release}) merged into ${opts.sbom}`);
}

if (process.argv[1] && fileURLToPath(import.meta.url) === process.argv[1]) main();
