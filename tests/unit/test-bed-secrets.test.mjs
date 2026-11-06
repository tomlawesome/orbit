import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

import { describe, expect, it } from "vitest";

/**
 * #1722 (audit D-F1): `scripts/dev/test-bed.sh up` started the acceptance
 * stack without `.orbit-secrets/dkim-test-record.txt`. Docker then creates a
 * directory at that bind-mount path, tests/dkim-dns/server.mjs throws EISDIR,
 * and `compose up --wait` fails.
 *
 * Contract: every file a compose file used by the bed bind-mounts from
 * .orbit-secrets/ is produced by test-bed.sh, directly or by a script it runs.
 * Secrets declared as top-level `file:` secrets are made by configure.sh and
 * are out of scope here; only bind mounts (`- ./.orbit-secrets/NAME:`) are
 * checked, because a missing one silently becomes a directory.
 */

const root = join(dirname(fileURLToPath(import.meta.url)), "../..");
const read = (path) => readFileSync(join(root, path), "utf8");

const bed = read("scripts/dev/test-bed.sh");

function composeFiles() {
  const block = /compose_files=\(([^)]*)\)/.exec(bed);
  if (!block) throw new Error("test-bed.sh declares no compose_files array");
  return block[1].split(/\s+/).filter(Boolean);
}

function mountedSecrets() {
  const names = new Set();
  for (const file of composeFiles()) {
    for (const m of read(file).matchAll(/^\s*-\s*\.\/\.orbit-secrets\/([^:\s]+):/gm)) {
      names.add(m[1]);
    }
  }
  return [...names].sort();
}

/* The bed's own text plus every `bash scripts/...sh` it runs. */
function producerText() {
  let text = bed;
  for (const m of bed.matchAll(/bash\s+(scripts\/[\w./-]+\.sh)/g)) {
    text += "\n" + read(m[1]);
  }
  return text;
}

describe("test bed makes every secret its compose files mount (#1722)", () => {
  it("finds the mounted secrets, so a rename cannot silently empty this test", () => {
    expect(mountedSecrets()).toContain("dkim-test-record.txt");
    expect(mountedSecrets().length).toBeGreaterThan(2);
  });

  it.each(mountedSecrets())("produces .orbit-secrets/%s", (name) => {
    expect(producerText()).toContain(name);
  });

  it("makes the DKIM record with scripts/dev-dkim-test-key.sh, as the other producers do", () => {
    expect(bed).toMatch(/bash\s+scripts\/dev-dkim-test-key\.sh/);
  });

  it("clears a leftover directory at the DKIM record path before making it", () => {
    expect(bed).toMatch(/-d\s+"?\.orbit-secrets\/dkim-test-record\.txt/);
  });
});
