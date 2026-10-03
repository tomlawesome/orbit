#!/usr/bin/env node
// Builds the Windows bundle for reading real documents on the owner's own
// machine: `dist/orbit-extract.zip`, holding the reader as one JavaScript
// file, a Node runtime for Windows, the same Tika server the stack runs,
// the stack's Tika configuration, a launcher and a README.
//
//   node scripts/extract-bundle/build.mjs            # full bundle
//   node scripts/extract-bundle/build.mjs --no-fetch  # just the JavaScript
//
// Downloads are pinned and checked against the publishers' own checksums.
// Tika stays at 4.0.0 because that is the image the stack pins in
// docker-compose.yml: the point of the bundle is to read pages exactly as
// the deployment does, so it moves when the stack moves. Node is the
// version this host runs.

import { execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import { cpSync, existsSync, mkdirSync, readFileSync, renameSync, rmSync, writeFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { build } from "esbuild";

const here = dirname(fileURLToPath(import.meta.url));
const root = resolve(here, "../..");
const dist = join(root, "dist");
const out = join(dist, "orbit-extract");
const cache = join(dist, "extract-bundle-downloads");

const NODE_VERSION = "v22.23.2";
const NODE_ZIP = `node-${NODE_VERSION}-win-x64.zip`;
const TIKA_VERSION = "4.0.0";
const TIKA_ZIP = `tika-server-standard-${TIKA_VERSION}.zip`;

/*
 * O2-R5 (#1151): this used to write straight to `to`, so a download killed
 * or dropped partway left a half-written file there -- and the `existsSync`
 * check above protected that half file forever, since nothing ever looked at
 * its content again until a checksum comparison that then failed on every
 * later build. Writing to a sibling temp name and renaming into place once
 * the write has fully landed means a cache hit is never a half-written file:
 * a download that does not finish leaves only the temp name behind, never
 * `to` itself.
 */
export async function download(url, to, { fetchImpl = fetch } = {}) {
  if (existsSync(to)) return;
  console.error(`fetching ${url}`);
  const response = await fetchImpl(url);
  if (!response.ok) throw new Error(`${url}: ${response.status}`);
  const bytes = Buffer.from(await response.arrayBuffer());
  const partial = `${to}.part`;
  writeFileSync(partial, bytes);
  renameSync(partial, to);
}

export function digest(file, algorithm) {
  return createHash(algorithm).update(readFileSync(file)).digest("hex");
}

/*
 * The other half of O2-R5: a cache entry that was already corrupted (by the
 * bug above, or by anything else) fails `verify`, and the old code just threw
 * -- forever, since the bad file never moved. This deletes it and fetches it
 * again once; still bad after that is a real mismatch worth failing loudly
 * on, not an infinite retry.
 */
export async function downloadVerified(url, to, verify, options = {}) {
  await download(url, to, options);
  try {
    verify();
  } catch (error) {
    console.error(`${to}: ${error.message}; deleting the cached file and fetching it again`);
    rmSync(to, { force: true });
    await download(url, to, options);
    verify();
  }
}

export async function fetchNode({ fetchImpl } = {}) {
  const zip = join(cache, NODE_ZIP);
  const sums = join(cache, `SHASUMS256-${NODE_VERSION}.txt`);
  await download(`https://nodejs.org/dist/${NODE_VERSION}/SHASUMS256.txt`, sums, { fetchImpl });
  const expected = readFileSync(sums, "utf8").split("\n").find((line) => line.endsWith(`  ${NODE_ZIP}`))?.split(" ")[0];
  if (expected === undefined) throw new Error(`${NODE_ZIP}: no checksum line in SHASUMS256.txt`);
  await downloadVerified(
    `https://nodejs.org/dist/${NODE_VERSION}/${NODE_ZIP}`,
    zip,
    () => {
      if (digest(zip, "sha256") !== expected) throw new Error(`${NODE_ZIP}: checksum mismatch`);
    },
    { fetchImpl },
  );
  mkdirSync(join(out, "node"), { recursive: true });
  execFileSync("unzip", ["-o", "-j", "-q", zip, `node-${NODE_VERSION}-win-x64/node.exe`, `node-${NODE_VERSION}-win-x64/LICENSE`, "-d", join(out, "node")]);
}

export async function fetchTika({ fetchImpl } = {}) {
  const zip = join(cache, TIKA_ZIP);
  const base = `https://archive.apache.org/dist/tika/${TIKA_VERSION}/${TIKA_ZIP}`;
  const sumFile = `${zip}.sha512`;
  await download(`${base}.sha512`, sumFile, { fetchImpl });
  const expected = readFileSync(sumFile, "utf8").trim().split(/\s+/u)[0];
  await downloadVerified(
    base,
    zip,
    () => {
      if (digest(zip, "sha512") !== expected) throw new Error(`${TIKA_ZIP}: checksum mismatch`);
    },
    { fetchImpl },
  );
  // The server is a small jar whose manifest points at `lib/` beside it, so
  // the layout is kept; only the Unix launcher scripts are left out.
  mkdirSync(join(out, "tika"), { recursive: true });
  execFileSync("unzip", ["-o", "-q", zip, "-x", "bin/*", "-d", join(out, "tika")]);
}

async function main() {
  rmSync(out, { recursive: true, force: true });
  mkdirSync(out, { recursive: true });
  mkdirSync(cache, { recursive: true });

  await build({
    entryPoints: [join(here, "cli.ts")],
    bundle: true,
    platform: "node",
    target: "node22",
    format: "cjs",
    outfile: join(out, "orbit-extract.cjs"),
    tsconfig: join(root, "tsconfig.json"),
    logLevel: "warning",
  });
  cpSync(join(root, "config", "tika-config.json"), join(out, "tika-config.json"));
  cpSync(join(here, "run.cmd"), join(out, "run.cmd"));
  cpSync(join(here, "README.md"), join(out, "README.md"));
  mkdirSync(join(out, "docs"));
  writeFileSync(join(out, "docs", "put-your-documents-here.txt"), "Copy PDFs, JPGs or PNGs into this folder, then run run.cmd.\r\n");

  if (!process.argv.includes("--no-fetch")) {
    await fetchNode();
    await fetchTika();
  }

  const archive = join(dist, "orbit-extract.zip");
  rmSync(archive, { force: true });
  execFileSync("zip", ["-q", "-r", archive, "orbit-extract"], { cwd: dist });
  console.error(`built ${archive}`);
}

if (process.argv[1] && import.meta.url === new URL(`file://${process.argv[1]}`).href) {
  main().catch((error) => {
    console.error(error instanceof Error ? error.message : String(error));
    process.exitCode = 1;
  });
}
