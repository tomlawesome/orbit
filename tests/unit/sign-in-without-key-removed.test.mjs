import { readdirSync, readFileSync } from "node:fs";
import path from "node:path";
import { describe, expect, it } from "vitest";

/*
 * #1407: since #1405 an Orbit instance with no usable encryption key is in
 * maintenance and nobody signs in, so the code that let people sign in without
 * a key can never run. It is removed: the tolerant sign-in cipher
 * (`openInstanceMetadataCipher`, #969) and the `instance_locked` sign-in
 * verdict/error arms. A source tripwire in the style of door-locked-redirect.test.mjs:
 * neither name may appear anywhere under src/ or web/src/ (code, words or
 * comments), so nothing is left half-removed or documenting what is gone.
 */
const root = path.resolve(import.meta.dirname, "../..");
const SOURCE_EXTENSIONS = /\.(?:ts|js|mjs|cjs|svelte|json|md|css|html)$/u;

function sourceFiles(directory) {
  const found = [];
  for (const entry of readdirSync(directory, { withFileTypes: true })) {
    if (entry.name === "node_modules" || entry.name.startsWith(".")) continue;
    const full = path.join(directory, entry.name);
    if (entry.isDirectory()) found.push(...sourceFiles(full));
    else if (SOURCE_EXTENSIONS.test(entry.name)) found.push(full);
  }
  return found;
}

const files = [...sourceFiles(path.join(root, "src")), ...sourceFiles(path.join(root, "web/src"))];

function filesMentioning(pattern) {
  return files
    .filter((file) => pattern.test(readFileSync(file, "utf8")))
    .map((file) => path.relative(root, file))
    .sort();
}

describe("sign-in without an encryption key is gone (#1407)", () => {
  it("scans the real source tree", () => {
    expect(files.length).toBeGreaterThan(100);
    expect(files.some((file) => file.endsWith(path.join("src", "server", "metadata", "fields.ts")))).toBe(true);
    expect(files.some((file) => file.endsWith(path.join("web", "src", "lib", "flight", "SignIn.svelte")))).toBe(true);
  });

  it("has no tolerant sign-in cipher: openInstanceMetadataCipher exists nowhere", () => {
    expect(filesMentioning(/openInstanceMetadataCipher/u)).toEqual([]);
  });

  it("has no instance_locked verdict or error code anywhere", () => {
    expect(filesMentioning(/instance_locked/u)).toEqual([]);
  });

  it("keeps the strict writer that sign-in now uses", () => {
    const fields = readFileSync(path.join(root, "src/server/metadata/fields.ts"), "utf8");
    expect(fields).toMatch(/export (?:async )?function requireInstanceMetadataWriter\b/u);
  });
});
