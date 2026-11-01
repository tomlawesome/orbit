import { spawnSync } from "node:child_process";
import { cpSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { afterAll, describe, expect, it, vi } from "vitest";

import { PROCESS_TEST_TIMEOUT_MS, failOnProcessDeadline, processGuard } from "../process-budget.mjs";

vi.setConfig({ testTimeout: PROCESS_TEST_TIMEOUT_MS });

/*
 * The test bed's resolved Compose configuration (#1158, #1445). The bed names
 * its Compose files in scripts/dev/test-bed.sh; these render exactly that list
 * with `docker compose config` (no daemon is contacted, as in
 * app-memory-limit-contract.test.mjs) from a scratch directory, with the same
 * environment overrides the script gives Compose. Nothing is started.
 *
 * Needs a real `docker` with the compose plugin, so the `fast` lane, which has
 * none, excludes this file (ORBIT_TEST_SKIP_DOCKER in vitest.config.ts) and
 * `fast_docker` runs it. test-bed.test.mjs, which stubs docker, stays in `fast`.
 */
const repoRoot = join(dirname(fileURLToPath(import.meta.url)), "../..");
const scriptSource = readFileSync(join(repoRoot, "scripts/dev/test-bed.sh"), "utf8");
const host = "192.0.2.10";
const digest = `registry.example/orbit@sha256:${"a".repeat(64)}`;

/** The Compose files the script passes, in order, read from its own list. */
function bedComposeFiles() {
  const block = scriptSource.match(/compose_files=\(([\s\S]*?)\n\)/);
  expect(block, "compose_files=( ... ) not found in test-bed.sh").not.toBeNull();
  return block[1].split("\n").map((line) => line.trim()).filter((line) => line && !line.startsWith("#"));
}

const scratchDirs = [];
afterAll(() => {
  for (const dir of scratchDirs) rmSync(dir, { recursive: true, force: true });
});

/** The bed's services as `docker compose config --format json` resolves them. */
function renderBed(project = "orbit") {
  const dir = mkdtempSync(join(tmpdir(), "orbit-test-bed-config-"));
  scratchDirs.push(dir);
  const files = bedComposeFiles();
  for (const file of files) {
    mkdirSync(dirname(join(dir, file)), { recursive: true });
    cpSync(join(repoRoot, file), join(dir, file));
  }
  writeFileSync(join(dir, ".env-orbit"), "ORBIT_TEST_ONLY=fixture\n");
  const args = ["compose", "-p", project, "--env-file", ".env-orbit", ...files.flatMap((f) => ["-f", f]), "--profile", "*", "config", "--format", "json"];
  const result = failOnProcessDeadline(
    spawnSync("docker", args, {
      ...processGuard(),
      cwd: dir,
      encoding: "utf8",
      env: {
        PATH: process.env.PATH,
        HOME: process.env.HOME ?? tmpdir(),
        ORBIT_IMAGE: digest,
        DEMO_HOST: host,
        ORBIT_BIND_ADDRESS: "127.0.0.1",
        ORBIT_PORT: "3001",
      },
    }),
    { label: "docker compose config" },
  );
  expect(result.status, `docker compose config failed: ${result.stderr}`).toBe(0);
  return { files, services: JSON.parse(result.stdout).services };
}

const published = (service) => (service.ports ?? []).map((p) => ({ published: String(p.published), target: Number(p.target) }));

describe("the bed's containers do not take the fixed names (#1158)", () => {
  // The names docker-compose.yml pins for the services a second Orbit stack on
  // the same host also runs. (orbit-ollama is kept across beds by design and is
  // not among them.)
  const fixed = { "orbit-app": "orbit", "orbit-db": "orbit-postgres", "orbit-clamav": "orbit-clamav", "orbit-tika": "orbit-tika" };

  it("does not use the e2e overlay, whose other settings must not leak into the bed", () => {
    expect(bedComposeFiles()).not.toContain("compose/docker-compose.local-e2e.yml");
  });

  // A project other than the default "orbit": a project-scoped name for the
  // default project can coincide with a fixed one (orbit-clamav), which the
  // specification leaves open, so only a distinct project is asserted.
  it("gives no service a fixed orbit* container name", () => {
    const { services } = renderBed("orbit-bed-check");
    for (const [service, fixedName] of Object.entries(fixed)) {
      expect(services[service], `${service} is not in the bed's resolved config`).toBeDefined();
      expect(services[service].container_name, `${service} keeps the fixed name`).not.toBe(fixedName);
    }
  });

  it("scopes each of those names to the project, so two projects cannot collide", () => {
    const project = "orbit-bed-check";
    const { services } = renderBed(project);
    for (const service of Object.keys(fixed)) {
      const name = services[service].container_name;
      // Absent is also project-scoped: Compose then names it <project>-<service>-1.
      if (name !== undefined) expect(name, `${service} container name`).toContain(project);
    }
    const other = renderBed("orbit-bed-other").services;
    for (const service of Object.keys(fixed)) {
      const [a, b] = [services[service].container_name, other[service].container_name];
      if (a !== undefined && b !== undefined) expect(b).not.toBe(a);
    }
  });

  it("leaves the app's own address alone: the e2e overlay's loopback APP_URL does not leak in", () => {
    const { services } = renderBed();
    expect(services["orbit-app"].environment.APP_URL).toBe(`https://${host}:3443`);
  });
});

describe("the bed's identity provider is published on 4444, not 4443 (#1445)", () => {
  it("publishes host port 4444 to the container's 4443, and nothing on host port 4443", () => {
    const { services } = renderBed();
    expect(published(services["orbit-oidc"])).toContainEqual({ published: "4444", target: 4443 });
    for (const [name, service] of Object.entries(services)) {
      expect(published(service).filter((p) => p.published === "4443"), `${name} publishes host port 4443`).toEqual([]);
    }
  });

  it("points both the app and the provider at the :4444 issuer URL", () => {
    const { services } = renderBed();
    expect(services["orbit-app"].environment.OIDC_ISSUER).toBe(`https://${host}:4444/`);
    expect(services["orbit-oidc"].environment.TEST_OIDC_ISSUER).toBe(`https://${host}:4444/`);
  });

  it("keeps the app's callback and address on the proxy's :3443", () => {
    const { services } = renderBed();
    expect(services["orbit-app"].environment.OIDC_CALLBACK_URL).toBe(`https://${host}:3443/api/auth/callback`);
    expect(published(services["demo-tls"])).toContainEqual({ published: "3443", target: 3443 });
  });
});
