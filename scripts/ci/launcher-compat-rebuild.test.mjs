import { readFileSync } from "node:fs";

import { describe, expect, it } from "vitest";

// #1738 D-S2/D-S4 (ruling 2026-11-17): build_launcher_branch's archive keeps
// expiring after 3 days. A late retry of launcher_install_compat must not
// depend on it still being there: it rebuilds the archive when it is gone.

const pipeline = readFileSync(new URL("../../.gitlab-ci.yml", import.meta.url), "utf8").replaceAll("\r\n", "\n");
const start = pipeline.indexOf("\nlauncher_install_compat:\n");
const rest = pipeline.slice(start + 1);
const job = rest.slice(0, (rest.slice(1).search(/\n[A-Za-z_.][^\n]*:\s*(?:#.*)?\n/u) + 1) || rest.length);
const archive = ".orbit-launcher-artifacts/orbit-launcher_linux_amd64.tar.gz";

describe("launcher_install_compat after the launcher archive has expired (#1738 D-S2/D-S4)", () => {
  it("keeps build_launcher_branch's expiry at 3 days", () => {
    const branch = pipeline.slice(pipeline.indexOf("\n.build_launcher:\n"), pipeline.indexOf("\nbuild_launcher:\n"));
    expect(branch).toContain("expire_in: 3 days");
  });

  it("rebuilds the archive with build-launcher.sh when the downloaded one is missing", () => {
    const extract = job.indexOf(`--file "$CI_PROJECT_DIR/${archive}"`);
    expect(extract).toBeGreaterThan(-1);
    const before = job.slice(0, extract);
    expect(before).toMatch(/if \[ ! -s "\$CI_PROJECT_DIR\/\.orbit-launcher-artifacts\/orbit-launcher_linux_amd64\.tar\.gz" \]/u);
    expect(before).toContain('bash scripts/ci/build-launcher.sh "$CI_PROJECT_DIR/.orbit-launcher-artifacts"');
  });
});
