// Vitest setupFile (#1861), after tests/support/temp-root.ts: copy the CLI
// bundle the globalSetup built once for the run into this file's temporary
// root (a file copy, not a rebuild), and export its path as
// ORBIT_TEST_CLI_BUNDLE for the docker shims. The per-file root is removed when
// the file ends, so the copy goes with it.
import { copyFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { inject } from "vitest";

const built = inject("orbitTestCliBundle");
if (built !== undefined) {
  const copy = join(tmpdir(), "orbit-cli.js");
  copyFileSync(built, copy);
  process.env.ORBIT_TEST_CLI_BUNDLE = copy;
}
