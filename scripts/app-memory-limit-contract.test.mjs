import { spawnSync } from "node:child_process";
import { copyFileSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, describe, expect, it } from "vitest";

// #1429 (owner decision 8a): the application container has a memory limit,
// 2 GB by default, that an operator can change from .env-orbit through its own
// variable, the same way CLAMAV_MEMORY_LIMIT, TIKA_MEMORY_LIMIT and
// OLLAMA_MEMORY_LIMIT work. A maximum-size archive preview peaks near 1.45 GB,
// an import near 1.2 GB and an export near 0.25 GB (measured, #1537), which the
// 2 GB default fits. The limit must also be documented where the others are.

const repoRoot = join(import.meta.dirname, "..");
const read = (path) => readFileSync(join(repoRoot, path), "utf8").replaceAll("\r\n", "\n");
const compose = read("docker-compose.yml");
const environmentExample = read(".env-orbit.example");
const operationsGuide = read("docs/administrator-operations.md");

const TWO_GIB = String(2 * 1024 * 1024 * 1024);
const ONE_GIB = String(1024 * 1024 * 1024);

function serviceBlock(name) {
  const start = compose.indexOf(`  ${name}:`);
  if (start < 0) throw new Error(`Service ${name} is not declared`);
  const rest = compose.slice(start + 1);
  const nextSibling = rest.search(/\n {2}[a-z][a-z0-9-]*:\n|\n[a-z]/u);
  return nextSibling < 0 ? rest : rest.slice(0, nextSibling);
}

const scratchDirs = [];
afterAll(() => {
  for (const dir of scratchDirs) rmSync(dir, { recursive: true, force: true });
});

/**
 * Renders the compose file the way an operator's `docker compose config`
 * would, from a scratch directory holding only the compose file and an
 * .env-orbit, and returns the parsed services. No daemon is contacted.
 */
function renderServices(extraEnvLines = [], profiles = []) {
  const dir = mkdtempSync(join(tmpdir(), "orbit-app-memory-limit-"));
  scratchDirs.push(dir);
  copyFileSync(join(repoRoot, "docker-compose.yml"), join(dir, "docker-compose.yml"));
  const image = `example.invalid/orbit@sha256:${"0".repeat(64)}`;
  writeFileSync(join(dir, ".env-orbit"), [`ORBIT_IMAGE=${image}`, ...extraEnvLines, ""].join("\n"));
  const args = ["compose", "--env-file", ".env-orbit", ...profiles.flatMap((p) => ["--profile", p]), "config", "--format", "json"];
  const result = spawnSync("docker", args, { cwd: dir, encoding: "utf8", env: { PATH: process.env.PATH, HOME: process.env.HOME ?? tmpdir() } });
  expect(result.status, `docker compose config failed: ${result.stderr}`).toBe(0);
  return JSON.parse(result.stdout).services;
}

describe("orbit-app has an overridable memory limit (#1429)", () => {
  it("declares mem_limit from ORBIT_MEMORY_LIMIT with a 2g default, like the other services", () => {
    expect(serviceBlock("orbit-app")).toContain("mem_limit: ${ORBIT_MEMORY_LIMIT:-2g}");
    // The existing limits it is modelled on keep their shape.
    expect(compose).toContain("mem_limit: ${CLAMAV_MEMORY_LIMIT:-4g}");
    expect(compose).toContain("mem_limit: ${TIKA_MEMORY_LIMIT:-1g}");
  });

  it("renders a 2 GB limit for orbit-app when nothing overrides it", () => {
    const services = renderServices();
    expect(String(services["orbit-app"].mem_limit)).toBe(TWO_GIB);
  });

  it("renders the operator's value when ORBIT_MEMORY_LIMIT is set in .env-orbit", () => {
    const services = renderServices(["ORBIT_MEMORY_LIMIT=3g"]);
    expect(String(services["orbit-app"].mem_limit)).toBe(String(3 * 1024 * 1024 * 1024));
  });

  it("does not leak the app limit into the other services' limits", () => {
    // Positive half: the override reaches orbit-app. Negative half: a sibling
    // service's limit is unchanged by it, so the variable is not shared.
    const services = renderServices(["ORBIT_MEMORY_LIMIT=3g"], ["processing"]);
    expect(String(services["orbit-app"].mem_limit)).toBe(String(3 * 1024 * 1024 * 1024));
    expect(String(services["orbit-tika"].mem_limit)).toBe(ONE_GIB);
  });

  it("is not changed by the other services' limit variables", () => {
    const services = renderServices(["TIKA_MEMORY_LIMIT=512m", "CLAMAV_MEMORY_LIMIT=1g", "OLLAMA_MEMORY_LIMIT=1g"]);
    expect(String(services["orbit-app"].mem_limit)).toBe(TWO_GIB);
  });
});

describe("ORBIT_MEMORY_LIMIT is documented where the other limits are (#1429)", () => {
  it(".env-orbit.example lists ORBIT_MEMORY_LIMIT=2g with a comment, next to the other limits", () => {
    const lines = environmentExample.split("\n");
    const index = lines.findIndex((line) => /^#?\s*ORBIT_MEMORY_LIMIT=2g\s*$/u.test(line));
    expect(index).toBeGreaterThan(0);
    // A comment line sits directly above (or the line itself is commented
    // out like the sibling limits), so the setting explains itself.
    const above = lines.slice(Math.max(0, index - 4), index).join("\n");
    expect(above).toMatch(/^#\s*\S.*(memory|limit|archive|import)/imu);
    // The sibling limits it is listed with are still there.
    expect(environmentExample).toContain("# CLAMAV_MEMORY_LIMIT=4g");
    expect(environmentExample).toContain("# TIKA_MEMORY_LIMIT=1g");
  });

  it("the administrator operations guide lists ORBIT_MEMORY_LIMIT in the settings table with its 2g default", () => {
    const row = operationsGuide.split("\n").find((line) => line.startsWith("| `ORBIT_MEMORY_LIMIT`"));
    expect(row, "no ORBIT_MEMORY_LIMIT row in docs/administrator-operations.md").toBeDefined();
    expect(row).toContain("Compose");
    expect(row).toContain("`2g`");
    // The rows it is modelled on are still present.
    expect(operationsGuide).toContain("| `CLAMAV_MEMORY_LIMIT` | Compose |");
  });

  it(".env-orbit.example says the limit must cover the import peak plus the 256 MiB quarantine space, and that the heap follows it (#1429 B1)", () => {
    const lines = environmentExample.split("\n");
    const index = lines.findIndex((line) => /^#?\s*ORBIT_MEMORY_LIMIT=2g\s*$/u.test(line));
    expect(index).toBeGreaterThan(0);
    const comment = lines.slice(Math.max(0, index - 8), index).join("\n");
    expect(comment).toContain("1.45 GB");
    expect(comment).not.toContain("1.9 GB");
    expect(comment).toMatch(/quarantine/iu);
    expect(comment).toContain("256 MiB");
    expect(comment).toMatch(/overhead/iu);
    expect(comment).toMatch(/2 GB.*default|default.*2 GB/isu);
    expect(comment).toContain("70%");
    expect(comment).toContain("NODE_OPTIONS");
  });

  it("the administrator operations guide row says the same: import peak, quarantine space, 70% heap unless NODE_OPTIONS sets it (#1429 B1)", () => {
    const row = operationsGuide.split("\n").find((line) => line.startsWith("| `ORBIT_MEMORY_LIMIT`"));
    expect(row, "no ORBIT_MEMORY_LIMIT row in docs/administrator-operations.md").toBeDefined();
    expect(row).toContain("1.45 GB");
    expect(row).not.toContain("1.9 GB");
    expect(row).toMatch(/quarantine/iu);
    expect(row).toContain("256 MiB");
    expect(row).toMatch(/overhead/iu);
    expect(row).toContain("70%");
    expect(row).toContain("NODE_OPTIONS");
    expect(row).toContain("`2g`");
  });
});

describe("the measured archive memory peak is stated everywhere, and the stale figure is gone (#1537)", () => {
  it("the compose mem_limit comment states 1.45 GB, not a 1 GB import peak", () => {
    const lines = serviceBlock("orbit-app").split("\n");
    const index = lines.findIndex((line) => line.includes("mem_limit: ${ORBIT_MEMORY_LIMIT:-2g}"));
    expect(index).toBeGreaterThan(0);
    const comment = lines.slice(Math.max(0, index - 5), index).join("\n");
    expect(comment).toContain("1.45 GB");
    expect(comment).not.toMatch(/about 1 GB, the peak/iu);
  });

  it.each([
    ["docker-compose.yml", () => compose],
    [".env-orbit.example", () => environmentExample],
    ["docs/administrator-operations.md", () => operationsGuide],
  ])("%s no longer states the stale 1.9 GB figure", (_name, text) => {
    expect(text()).not.toContain("1.9 GB");
  });

  it("the administrator guide row gives preview 1.45 GB, import 1.2 GB, export 0.25 GB and keeps the 3g advice", () => {
    const row = operationsGuide.split("\n").find((line) => line.startsWith("| `ORBIT_MEMORY_LIMIT`"));
    expect(row).toBeDefined();
    expect(row).toContain("1.45 GB");
    expect(row).toContain("1.2 GB");
    expect(row).toContain("0.25 GB");
    expect(row).toContain("`3g`");
  });
});
