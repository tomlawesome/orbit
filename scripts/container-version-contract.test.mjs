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

import { describe, expect, it, vi } from "vitest";

import { PROCESS_TEST_TIMEOUT_MS, failOnProcessDeadline, processGuard } from "./process-budget.mjs";

// Every test here runs scripts/container-entrypoint.sh under bash; a spawn
// that takes tens of milliseconds quiet takes seconds on a starved core
// (#698). Budget and reasoning: scripts/process-budget.mjs.
vi.setConfig({ testTimeout: PROCESS_TEST_TIMEOUT_MS });

const dockerfile = readFileSync(new URL("../Dockerfile", import.meta.url), "utf8").replaceAll(
  "\r\n",
  "\n",
);
const configureScript = readFileSync(
  new URL("./configure.sh", import.meta.url),
  "utf8",
).replaceAll("\r\n", "\n");
const entrypoint = readFileSync(
  new URL("./container-entrypoint.sh", import.meta.url),
  "utf8",
).replaceAll("\r\n", "\n");
const healthRoute = readFileSync(
  new URL("../web/src/routes/api/health/+server.js", import.meta.url),
  "utf8",
);
const bash =
  process.platform === "win32" && existsSync("C:/Program Files/Git/bin/bash.exe")
    ? "C:/Program Files/Git/bin/bash.exe"
    : "bash";

const banner = [
  "─────────────────────────────────────────────────────────────────────────────",
  "      ·            ✦             ·                  ·           ✦      ·",
  "  ✦        ·               ○                ·             ·          ◯",
  "  ·      ·    ·    ██████╗  ██████╗  ██████╗  ██╗ ████████╗   ·      ·      ·",
  "·     ·      ·    ██╔═══██╗ ██╔══██╗ ██╔══██╗ ██║ ╚══██╔══╝   ·    ·        ·",
  "   ·      ·   ·   ██║   ██║ ██████╔╝ ██████╔╝ ██║    ██║        ·      ·    ·",
  " ·      ·     ·   ██║   ██║ ██╔══██╗ ██╔══██╗ ██║    ██║      ·      ·      ·",
  "    ·      ·      ╚██████╔╝ ██║  ██║ ██████╔╝ ██║    ██║      ·     ·     · ·",
  "·       ·     ·    ╚═════╝  ╚═╝  ╚═╝ ╚═════╝  ╚═╝    ╚═╝       ·      ·     ·",
  "    ·          ◯              ·                ✦             ·           ·",
  "         ✦             ·              ·                ○          ·",
  "─────────────────────────────────────────────────────────────────────────────",
].join("\n") + "\n";

function versionFixture(version = "v1.2.3", revision = "a".repeat(40), channel = "preview") {
  const root = mkdtempSync(join(tmpdir(), "orbit-version-contract-"));
  const scripts = join(root, "scripts");
  mkdirSync(scripts);
  const script = join(scripts, "container-entrypoint.sh");
  writeFileSync(script, entrypoint, "utf8");
  writeFileSync(join(root, "VERSION"), `${version}\n`, "utf8");
  writeFileSync(join(root, "REVISION"), `${revision}\n`, "utf8");
  writeFileSync(join(root, "CHANNEL"), `${channel}\n`, "utf8");
  return { root, script: script.replaceAll("\\", "/") };
}

describe("immutable container version identity", () => {
  it("embeds validated version, channel, and revision files without runtime environment overrides", () => {
    expect(dockerfile).toContain("ARG ORBIT_VERSION");
    expect(dockerfile).toContain("ARG ORBIT_REVISION");
    expect(dockerfile).toContain("ARG ORBIT_CHANNEL");
    expect(dockerfile).toContain("> /opt/orbit/VERSION");
    expect(dockerfile).toContain("> /opt/orbit/REVISION");
    expect(dockerfile).toContain("> /opt/orbit/CHANNEL");
    expect(dockerfile).toContain('org.opencontainers.image.version="${ORBIT_VERSION}"');
    expect(dockerfile).toContain('io.github.tomlawesome.orbit.release-stage="${ORBIT_CHANNEL}"');
    expect(entrypoint).toContain('readonly version_path="${application_directory}/VERSION"');
    expect(entrypoint).toContain('readonly channel_path="${application_directory}/CHANNEL"');
    expect(entrypoint).not.toContain("${ORBIT_VERSION:-");
    expect(entrypoint).not.toContain("${ORBIT_REVISION:-");
    expect(entrypoint).not.toContain("${ORBIT_CHANNEL:-");
  });

  it("keeps bootstrap key generation separate from the versioned runtime image", () => {
    const helperStart = dockerfile.indexOf("FROM base AS vapid-generator");
    const runtimeStart = dockerfile.indexOf(" AS runner");
    const helper = dockerfile.slice(helperStart, runtimeStart);

    expect(helperStart).toBeGreaterThanOrEqual(0);
    expect(runtimeStart).toBeGreaterThan(helperStart);
    expect(helper).toContain("COPY scripts/generate-vapid.mjs ./scripts/generate-vapid.mjs");
    expect(helper).not.toContain("ORBIT_VERSION");
    expect(helper).not.toContain("ORBIT_CHANNEL");
    expect(configureScript).toContain("docker build --target vapid-generator");
    expect(configureScript).not.toContain("docker build --target runner");
  });

  it("handles --version before root and secret bootstrap checks", () => {
    const versionOutput = entrypoint.indexOf('printf "Orbit %s\\n" "$orbit_version"');
    const rootCheck = entrypoint.indexOf('[ "$(id -u)" = "0" ]');

    expect(versionOutput).toBeGreaterThanOrEqual(0);
    expect(rootCheck).toBeGreaterThan(versionOutput);

    const fixture = versionFixture();
    try {
      const result = failOnProcessDeadline(spawnSync(bash, [fixture.script, "--version"], {
        encoding: "utf8",
        env: {
          ...process.env,
          ORBIT_VERSION: "v9.9.9",
          ORBIT_REVISION: "f".repeat(40),
          ORBIT_CHANNEL: "latest",
        },
        ...processGuard(),
      }), { label: "--version before root and secret bootstrap checks" });
      expect(result.status).toBe(0);
      expect(result.stdout).toBe("Orbit v1.2.3\n");
      expect(result.stderr).toBe("");
    } finally {
      rmSync(fixture.root, { recursive: true, force: true });
    }
  });

  it("prints the exact banner and immutable identity once for default server startup", () => {
    const fixture = versionFixture();
    try {
      const result = failOnProcessDeadline(spawnSync(bash, [fixture.script, "node", "web/index.js"], {
        encoding: "utf8",
        env: {
          ...process.env,
          ORBIT_VERSION: "v9.9.9",
          ORBIT_REVISION: "f".repeat(40),
          ORBIT_CHANNEL: "latest",
        },
        ...processGuard(),
      }), { label: "banner and immutable identity for default server startup" });
      expect(result.stdout).toBe(
        `${banner}Orbit v1.2.3 | channel=preview | revision=${"a".repeat(40)}\n`,
      );
      expect(result.stdout.match(/██████╗  ██████╗/gu)).toHaveLength(1);
      expect(result.stdout.match(/Orbit v1\.2\.3 \| channel=preview \| revision=/gu)).toHaveLength(1);
    } finally {
      rmSync(fixture.root, { recursive: true, force: true });
    }
  });

  // #735: any other command is a one-off (the engine CLI, a shell), and
  // stamping the banner on those would corrupt machine-readable output.
  it("stays quiet for a command that is not the server", () => {
    const fixture = versionFixture();
    try {
      const result = failOnProcessDeadline(spawnSync(bash, [fixture.script, "node", "cli/orbit.js"], {
        encoding: "utf8",
        env: {
          ...process.env,
          ORBIT_VERSION: "v9.9.9",
          ORBIT_REVISION: "f".repeat(40),
          ORBIT_CHANNEL: "latest",
        },
        ...processGuard(),
      }), { label: "a command that is not the server" });
      expect(result.stdout).toBe("");
    } finally {
      rmSync(fixture.root, { recursive: true, force: true });
    }
  });

  it("exposes the canonical banner as a quiet one-off image command", () => {
    const fixture = versionFixture();
    try {
      const result = failOnProcessDeadline(spawnSync(bash, [fixture.script, "--banner"], {
        encoding: "utf8",
        env: {
          ...process.env,
          ORBIT_VERSION: "v9.9.9",
          ORBIT_REVISION: "f".repeat(40),
          ORBIT_CHANNEL: "latest",
        },
        ...processGuard(),
      }), { label: "canonical banner as a quiet one-off image command" });
      expect(result.status).toBe(0);
      expect(result.stdout).toBe(
        `${banner}Orbit v1.2.3 | channel=preview | revision=${"a".repeat(40)}\n`,
      );
      expect(result.stderr).toBe("");
    } finally {
      rmSync(fixture.root, { recursive: true, force: true });
    }
  });

  it("does not print startup identity or the banner for one-off commands", () => {
    const fixture = versionFixture();
    try {
      const result = failOnProcessDeadline(spawnSync(bash, [fixture.script, "sh", "-c", "exit 0"], {
        encoding: "utf8",
        ...processGuard(),
      }), { label: "no startup identity or banner for one-off commands" });
      expect(result.stdout).toBe("");
      expect(result.stdout).not.toContain("██████╗");
      expect(result.stdout).not.toContain("Orbit v1.2.3");
    } finally {
      rmSync(fixture.root, { recursive: true, force: true });
    }
  });

  it("fails closed for malformed embedded identity", () => {
    const fixture = versionFixture("next");
    try {
      const result = failOnProcessDeadline(spawnSync(bash, [fixture.script, "--version"], {
        encoding: "utf8",
        ...processGuard(),
      }), { label: "fails closed for malformed embedded identity" });
      expect(result.status).not.toBe(0);
      expect(result.stderr).toContain("embedded version identity is invalid");
      expect(result.stdout).toBe("");
    } finally {
      rmSync(fixture.root, { recursive: true, force: true });
    }
  });

  it("fails closed for a malformed embedded channel", () => {
    const fixture = versionFixture("v1.2.3", "a".repeat(40), "latest; injected");
    try {
      const result = failOnProcessDeadline(spawnSync(bash, [fixture.script, "--version"], {
        encoding: "utf8",
        ...processGuard(),
      }), { label: "fails closed for a malformed embedded channel" });
      expect(result.status).not.toBe(0);
      expect(result.stderr).toContain("embedded release channel is invalid");
      expect(result.stdout).toBe("");
    } finally {
      rmSync(fixture.root, { recursive: true, force: true });
    }
  });

  it("keeps immutable startup identity out of public health data", () => {
    expect(healthRoute).not.toMatch(/version|revision/u);
  });
});
