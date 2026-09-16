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
import { cpSync, existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
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

async function download(url, to) {
  if (existsSync(to)) return;
  console.error(`fetching ${url}`);
  const response = await fetch(url);
  if (!response.ok) throw new Error(`${url}: ${response.status}`);
  writeFileSync(to, Buffer.from(await response.arrayBuffer()));
}

function digest(file, algorithm) {
  return createHash(algorithm).update(readFileSync(file)).digest("hex");
}

async function fetchNode() {
  const zip = join(cache, NODE_ZIP);
  await download(`https://nodejs.org/dist/${NODE_VERSION}/${NODE_ZIP}`, zip);
  const sums = join(cache, `SHASUMS256-${NODE_VERSION}.txt`);
  await download(`https://nodejs.org/dist/${NODE_VERSION}/SHASUMS256.txt`, sums);
  const expected = readFileSync(sums, "utf8").split("\n").find((line) => line.endsWith(`  ${NODE_ZIP}`))?.split(" ")[0];
  if (expected === undefined || digest(zip, "sha256") !== expected) throw new Error(`${NODE_ZIP}: checksum mismatch`);
  mkdirSync(join(out, "node"), { recursive: true });
  execFileSync("unzip", ["-o", "-j", "-q", zip, `node-${NODE_VERSION}-win-x64/node.exe`, `node-${NODE_VERSION}-win-x64/LICENSE`, "-d", join(out, "node")]);
}

async function fetchTika() {
  const zip = join(cache, TIKA_ZIP);
  const base = `https://archive.apache.org/dist/tika/${TIKA_VERSION}/${TIKA_ZIP}`;
  await download(base, zip);
  await download(`${base}.sha512`, `${zip}.sha512`);
  const expected = readFileSync(`${zip}.sha512`, "utf8").trim().split(/\s+/u)[0];
  if (digest(zip, "sha512") !== expected) throw new Error(`${TIKA_ZIP}: checksum mismatch`);
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

main().catch((error) => {
  console.error(error instanceof Error ? error.message : String(error));
  process.exitCode = 1;
});
