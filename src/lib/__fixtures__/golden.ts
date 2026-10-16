import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

// Golden files for the retired bash twins (#1210 build note D10). Each JSON
// file under <flow>/ holds what the bash implementation produced for one
// case, captured once before the bash was deleted (see README.md for the
// commit). Tests compare the engine against these instead of spawning bash.

const root = dirname(fileURLToPath(import.meta.url));

function slug(name: string): string {
  return name
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, 100);
}

export function goldenPath(flow: string, name: string): string {
  return join(root, flow, `${slug(name)}.json`);
}

export function readGolden<T>(flow: string, name: string): T {
  return JSON.parse(readFileSync(goldenPath(flow, name), "utf8")) as T;
}

/** Capture-time only: writes one case. Kept so a later twin's capture can reuse it. */
export function writeGolden(flow: string, name: string, value: unknown): void {
  const path = goldenPath(flow, name);
  mkdirSync(dirname(path), { recursive: true });
  writeFileSync(path, `${JSON.stringify(value, null, 2)}\n`);
}
