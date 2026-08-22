import { createHash } from "node:crypto";
import { cpSync, existsSync, linkSync, mkdirSync, readdirSync, readFileSync, rmSync, statSync } from "node:fs";
import { basename, join, resolve } from "node:path";

const projectRoot = resolve(import.meta.dirname, "..");
const standaloneRoot = resolve(projectRoot, ".next", "standalone");

if (!existsSync(standaloneRoot)) {
  throw new Error("Standalone output is missing. Run `pnpm build` first.");
}

/** Copies assets that Next.js intentionally excludes from standalone output. */
function copyDirectory(source, destination) {
  if (!existsSync(source)) return;
  mkdirSync(destination, { recursive: true });
  cpSync(source, destination, { recursive: true, force: true });
}

copyDirectory(resolve(projectRoot, "public"), resolve(standaloneRoot, "public"));
copyDirectory(resolve(projectRoot, ".next", "static"), resolve(standaloneRoot, ".next", "static"));
copyDirectory(resolve(projectRoot, "drizzle"), resolve(standaloneRoot, "drizzle"));

/**
 * Collapses the standalone-image duplication of `@napi-rs/canvas` (#493).
 *
 * On disk, pnpm keeps exactly one real copy of each package version (in its
 * content-addressable `.pnpm` store) and links every consumer to it —
 * `node_modules/@napi-rs/canvas-linux-x64-gnu`, and the copy nested inside
 * `@napi-rs/canvas`'s own `node_modules` (its optional dependency), are both
 * symlinks to that one store entry. Next's standalone output tracer does not
 * preserve those symlinks: it resolves each one and copies the real bytes to
 * every path that required it, so the ~34MB native addon for a single
 * platform ends up physically duplicated once per distinct require path
 * (observed as three on this codebase, one of them nested three directories
 * deep under `pdfjs-dist`'s own resolution of the same package).
 *
 * The fix is done here, after Next has already flattened the symlinks, rather
 * than by trying to change how Next traces: keep the first copy of each
 * `@napi-rs/canvas*` package directory found on disk as canonical, and
 * replace every later copy's files with hardlinks to the canonical file.
 * Hardlinks are indistinguishable from ordinary files to every consumer that
 * matters here — Node's native addon loader (`process.dlopen`), `require`,
 * and Docker's layer copy all operate on inodes, not on how many directory
 * entries point at one. Content is verified byte-for-byte identical (by
 * size, then by hash) before linking, so a future version skew between two
 * same-named directories fails safe by leaving them alone rather than
 * silently merging different bytes.
 */
function findNativeCanvasPackageDirs(nodeModulesRoot) {
  const found = [];
  if (!existsSync(nodeModulesRoot)) return found;
  const stack = [nodeModulesRoot];
  while (stack.length > 0) {
    const dir = stack.pop();
    let entries;
    try {
      entries = readdirSync(dir, { withFileTypes: true });
    } catch {
      continue;
    }
    for (const entry of entries) {
      if (!entry.isDirectory()) continue;
      const full = join(dir, entry.name);
      if (basename(dir) === "@napi-rs" && entry.name.startsWith("canvas")) {
        found.push(full);
        continue;
      }
      stack.push(full);
    }
  }
  return found;
}

function hashFile(path) {
  return createHash("sha256").update(readFileSync(path)).digest("hex");
}

function filesAreIdentical(canonicalPath, duplicatePath) {
  const canonicalStat = statSync(canonicalPath);
  const duplicateStat = statSync(duplicatePath);
  if (!canonicalStat.isFile() || !duplicateStat.isFile()) return false;
  if (canonicalStat.size !== duplicateStat.size) return false;
  if (canonicalStat.dev === duplicateStat.dev && canonicalStat.ino === duplicateStat.ino) return true;
  return hashFile(canonicalPath) === hashFile(duplicatePath);
}

function hardlinkDuplicateFiles(canonicalDir, duplicateDir) {
  let dedupedBytes = 0;
  let dedupedFiles = 0;
  let entries;
  try {
    entries = readdirSync(duplicateDir, { withFileTypes: true });
  } catch {
    return { dedupedBytes, dedupedFiles };
  }
  for (const entry of entries) {
    const duplicatePath = join(duplicateDir, entry.name);
    const canonicalPath = join(canonicalDir, entry.name);
    if (entry.isDirectory()) {
      const nested = hardlinkDuplicateFiles(canonicalPath, duplicatePath);
      dedupedBytes += nested.dedupedBytes;
      dedupedFiles += nested.dedupedFiles;
      continue;
    }
    if (!entry.isFile() || !existsSync(canonicalPath) || !filesAreIdentical(canonicalPath, duplicatePath)) continue;
    const size = statSync(duplicatePath).size;
    rmSync(duplicatePath);
    linkSync(canonicalPath, duplicatePath);
    dedupedBytes += size;
    dedupedFiles += 1;
  }
  return { dedupedBytes, dedupedFiles };
}

function dedupeNativeCanvasCopies(root) {
  const canonicalByPackageName = new Map();
  let dedupedBytes = 0;
  let dedupedFiles = 0;
  for (const dir of findNativeCanvasPackageDirs(resolve(root, "node_modules"))) {
    const packageName = basename(dir);
    const canonical = canonicalByPackageName.get(packageName);
    if (!canonical) {
      canonicalByPackageName.set(packageName, dir);
      continue;
    }
    const result = hardlinkDuplicateFiles(canonical, dir);
    dedupedBytes += result.dedupedBytes;
    dedupedFiles += result.dedupedFiles;
  }
  if (dedupedFiles > 0) {
    const megabytes = (dedupedBytes / (1024 * 1024)).toFixed(1);
    console.log(`Deduped ${dedupedFiles} duplicate @napi-rs/canvas file(s) into hardlinks (~${megabytes}MB reclaimed).`);
  }
}

dedupeNativeCanvasCopies(standaloneRoot);

console.log("Standalone assets and migrations prepared.");
