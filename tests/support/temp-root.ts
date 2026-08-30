import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll } from "vitest";

/**
 * Give every test file its own temporary root, and delete it when the file ends.
 *
 * Registered as a Vitest `setupFile`, so this runs once per test file with no
 * call site changes. `os.tmpdir()` reads `TMPDIR` on every call, and the suites
 * all build their scratch paths as `join(tmpdir(), "orbit-...")`, so pointing
 * `TMPDIR` at a per-file root redirects all 219 `mkdtemp` sites at once (#654).
 *
 * The redirect happens at import time, NOT in `beforeAll`. Setup files are
 * imported before the test file is, while `beforeAll` runs after it — and some
 * suites call `mkdtemp` at module top level (install-transaction.parity.test.ts
 * builds its driver directory there). Those run before any hook, so a hook
 * would miss exactly the cases that are hardest to notice.
 *
 * Removing the root rather than each directory is what makes this hold for the
 * suites that SIGKILL their own children — restore-engine interruption, the pty
 * deadline tests. A killed child runs no cleanup, but it never owned the root:
 * the worker process does, and it is still alive to remove it.
 */
const previous = process.env.TMPDIR;
const root = mkdtempSync(join(tmpdir(), "orbit-vitest-"));
process.env.TMPDIR = root;

let removed = false;

function removeRoot(): void {
  if (removed) return;
  removed = true;
  if (previous === undefined) delete process.env.TMPDIR;
  else process.env.TMPDIR = previous;
  rmSync(root, { recursive: true, force: true });
}

// Belt and braces: afterAll does not run if the worker dies mid-file, and a
// leaked root is what filled this host's 12G /tmp in the first place.
process.once("exit", removeRoot);

afterAll(removeRoot);
