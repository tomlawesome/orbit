import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { describe, expect, it } from "vitest";

/*
 * docs/encryption-at-rest.md, section 3 (#1316): the recovery-bundle bullet
 * must say what the bundle really holds. It carries the whole backup,
 * including the plaintext database dump, not only the wrapped key.
 */

const DOC = readFileSync(resolve(__dirname, "../../docs/encryption-at-rest.md"), "utf8");

// The bullet that starts at the export-recovery-bundle script and runs to the next bullet.
const bullet = () => {
  const start = DOC.indexOf("- **`scripts/export-recovery-bundle.sh`**");
  expect(start).toBeGreaterThanOrEqual(0);
  const rest = DOC.slice(start + 1);
  const next = rest.search(/\n- \*\*/);
  const text = next === -1 ? rest : rest.slice(0, next);
  return text.replace(/\s+/g, " ");
};

describe("encryption-at-rest doc, recovery-bundle bullet (#1316)", () => {
  it("no longer claims the bundle holds no documents or database rows", () => {
    expect(bullet()).not.toMatch(/does not contain documents or database rows/i);
  });

  it("says the bundle holds the whole backup", () => {
    expect(bullet()).toMatch(/orbit-backup\.tar|the backup you give it, whole/i);
  });

  it("says the whole backup includes the plaintext database dump", () => {
    expect(bullet()).toMatch(/plaintext/i);
    expect(bullet()).toMatch(/database dump/i);
  });
});
