// The orbit CLI bundle the test shims run in place of `docker run ... orbit.js`
// (#1861). scripts/vitest-global-setup.mjs builds it once per Vitest run;
// scripts/vitest-cli-bundle-setup.mjs puts a copy in each test file's temporary
// root and exports the path as ORBIT_TEST_CLI_BUNDLE.

export function testCliBundle() {
  const path = process.env.ORBIT_TEST_CLI_BUNDLE;
  if (path === undefined || path === "") {
    throw new Error(
      "ORBIT_TEST_CLI_BUNDLE is not set: run the tests through Vitest with the scripts/vitest-global-setup.mjs globalSetup and scripts/vitest-cli-bundle-setup.mjs setup file (vitest.config.ts), or build one with `node scripts/bundle-orbit-cli.mjs <file>` and export the path.",
    );
  }
  return path;
}
