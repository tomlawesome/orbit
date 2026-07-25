import { cpSync, existsSync, mkdirSync } from "node:fs";
import { resolve } from "node:path";

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

console.log("Standalone assets and migrations prepared.");
