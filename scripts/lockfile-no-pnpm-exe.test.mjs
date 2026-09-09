import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { describe, it } from "node:test";

// #901: pnpm 11 on the host writes a `packageManagerDependencies: '@pnpm/exe'`
// entry (plus a bare `@pnpm/exe@<version>` package/snapshot block) while
// handing off to the pinned pnpm 12.3.4 via corepack. A regeneration with the
// pinned 12.3.4 binary never writes it (#884), so its presence means the
// lockfile was regenerated with the wrong pnpm (2e37168 did this, regressing
// #884). This must stay outside the vitest suite -- see vitest.config.ts's
// exclude list -- and run standalone: `node --test
// scripts/lockfile-no-pnpm-exe.test.mjs`.
//
// The regex excludes the platform-specific `@pnpm/exe.<platform>@<version>`
// entries: those are pnpm's own optionalDependencies (confirmed via `npm view
// pnpm@12.3.4 optionalDependencies`) and belong in every lockfile that has
// pnpm as a devDependency, correct or not. Only a bare `@pnpm/exe` -- no `.`
// before the next `@` or `'` -- is the artifact.
const PNPM_EXE_ARTIFACT = /@pnpm\/exe(?!\.)/;

const lockfilePath = new URL("../pnpm-lock.yaml", import.meta.url);

describe("pnpm-lock.yaml has no @pnpm/exe packageManagerDependencies artifact", () => {
  it("contains no bare @pnpm/exe entry", () => {
    const lockfile = readFileSync(lockfilePath, "utf8");
    assert.doesNotMatch(lockfile, PNPM_EXE_ARTIFACT);
  });
});
