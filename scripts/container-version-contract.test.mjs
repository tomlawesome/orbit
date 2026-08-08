import { spawnSync } from "node:child_process";
import {
  mkdirSync,
  mkdtempSync,
  existsSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { describe, expect, it } from "vitest";

const dockerfile = readFileSync(new URL("../Dockerfile", import.meta.url), "utf8").replaceAll(
  "\r\n",
  "\n",
);
const entrypoint = readFileSync(
  new URL("./container-entrypoint.sh", import.meta.url),
  "utf8",
).replaceAll("\r\n", "\n");
const healthRoute = readFileSync(
  new URL("../src/app/api/health/route.ts", import.meta.url),
  "utf8",
);
const bash =
  process.platform === "win32" && existsSync("C:/Program Files/Git/bin/bash.exe")
    ? "C:/Program Files/Git/bin/bash.exe"
    : "bash";

function versionFixture(version = "v1.2.3", revision = "a".repeat(40)) {
  const root = mkdtempSync(join(tmpdir(), "orbit-version-contract-"));
  const scripts = join(root, "scripts");
  mkdirSync(scripts);
  const script = join(scripts, "container-entrypoint.sh");
  writeFileSync(script, entrypoint, "utf8");
  writeFileSync(join(root, "VERSION"), `${version}\n`, "utf8");
  writeFileSync(join(root, "REVISION"), `${revision}\n`, "utf8");
  return { root, script: script.replaceAll("\\", "/") };
}

describe("immutable container version identity", () => {
  it("embeds validated version and revision files without runtime environment overrides", () => {
    expect(dockerfile).toContain("ARG ORBIT_VERSION");
    expect(dockerfile).toContain("ARG ORBIT_REVISION");
    expect(dockerfile).toContain("> /opt/orbit/VERSION");
    expect(dockerfile).toContain("> /opt/orbit/REVISION");
    expect(dockerfile).toContain('org.opencontainers.image.version="${ORBIT_VERSION}"');
    expect(entrypoint).toContain('readonly version_path="${application_directory}/VERSION"');
    expect(entrypoint).not.toContain("${ORBIT_VERSION:-");
    expect(entrypoint).not.toContain("${ORBIT_REVISION:-");
  });

  it("handles --version before root and secret bootstrap checks", () => {
    const versionOutput = entrypoint.indexOf('printf "Orbit %s\\n" "$orbit_version"');
    const rootCheck = entrypoint.indexOf('[ "$(id -u)" = "0" ]');

    expect(versionOutput).toBeGreaterThanOrEqual(0);
    expect(rootCheck).toBeGreaterThan(versionOutput);

    const fixture = versionFixture();
    try {
      const result = spawnSync(bash, [fixture.script, "--version"], {
        encoding: "utf8",
        env: {
          ...process.env,
          ORBIT_VERSION: "v9.9.9",
          ORBIT_REVISION: "f".repeat(40),
        },
      });
      expect(result.status).toBe(0);
      expect(result.stdout).toBe("Orbit v1.2.3\n");
      expect(result.stderr).toBe("");
    } finally {
      rmSync(fixture.root, { recursive: true, force: true });
    }
  });

  it("fails closed for malformed embedded identity", () => {
    const fixture = versionFixture("next");
    try {
      const result = spawnSync(bash, [fixture.script, "--version"], {
        encoding: "utf8",
      });
      expect(result.status).not.toBe(0);
      expect(result.stderr).toContain("embedded version identity is invalid");
      expect(result.stdout).toBe("");
    } finally {
      rmSync(fixture.root, { recursive: true, force: true });
    }
  });

  it("logs a bounded startup identity but keeps it out of public health data", () => {
    expect(entrypoint).toContain(
      'printf "Orbit startup: version=%s revision=%s\\n" "$orbit_version" "$orbit_revision"',
    );
    expect(healthRoute).not.toMatch(/version|revision/u);
  });
});
