import { spawnSync } from "node:child_process";
import { chmodSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { afterEach, describe, expect, it, vi } from "vitest";

import { PROCESS_TEST_TIMEOUT_MS, failOnProcessDeadline, processGuard } from "./process-budget.mjs";

// Each test runs the real script under bash; budget in scripts/process-budget.mjs.
vi.setConfig({ testTimeout: PROCESS_TEST_TIMEOUT_MS });

// Issue #1241: stacks the scripts bring up must not be left behind. The sweep
// in scripts/cleanup-stacks.sh lists, and with --remove tears down, every
// orbit* Compose project. A fake `docker` on PATH answers the three listings
// from fixture files and records every call, so these tests can say exactly
// what was and was not removed without touching a real daemon.

const script = join(dirname(fileURLToPath(import.meta.url)), "cleanup-stacks.sh");

// ps rows: project|id|name|status|image|service|networks (project empty = not Compose)
const containers = [
  "orbit-a|c1|orbit-a-app-1|Up 3 minutes|orbit-app|orbit-app|orbit-a_default",
  "orbit-a|c2|orbit-a-db-1|Exited (0) 2 hours ago|postgres:18-alpine|orbit-db|orbit-a_default",
  "orbit-a|c3|orbit-a-tools-1|Exited (1) 1 hour ago|tools:1|tools-profile-svc|orbit-a_default",
  "orbit-a|c4|orbit-ollama|Up 2 days (healthy)|ollama/ollama:0.33.3|orbit-ollama|orbit-a_models",
  "orbit-b|c5|orbit-b-app-1|Up 1 minute|orbit-app|orbit-app|orbit-b_default",
  "orbit|c6|orbit-postgres|Up 1 hour|postgres:18-alpine|orbit-db|orbit_default",
  "other|c7|other-web-1|Up 1 hour|web:1|web|other_default",
  "orbit-stale|c10|orbit-stale-app-1|Exited (0) 3 hours ago|orbit-app|orbit-app|orbit-stale_default",
  "|c8|review-nginx|Up 5 hours|nginx:alpine||bridge",
  "|c9|orbit-lookalike-by-hand|Exited (0) 1 hour ago|nginx:alpine||bridge",
];
const volumes = [
  "orbit-a|orbit-a_orbit-db-data",
  "orbit-a|orbit-a_orbit-ollama-data",
  "orbit-b|orbit-b_orbit-db-data",
  "orbit-gone|orbit-gone_orbit-db-data",
  "orbit-stale|orbit-stale_orbit-db-data",
  "other|other_data",
];
const networks = [
  "orbit-a|orbit-a_default",
  "orbit-a|orbit-a_models",
  "orbit-b|orbit-b_default",
  "orbit-gone|orbit-gone_default",
  "orbit-stale|orbit-stale_default",
  "other|other_default",
];

const scratchDirs = [];
afterEach(() => {
  while (scratchDirs.length > 0) rmSync(scratchDirs.pop(), { recursive: true, force: true });
});

function fakeDocker({ failOn = [], psRows = containers } = {}) {
  const dir = mkdtempSync(join(tmpdir(), "orbit-cleanup-stacks-"));
  scratchDirs.push(dir);
  writeFileSync(join(dir, "ps.txt"), `${psRows.join("\n")}\n`);
  writeFileSync(join(dir, "volumes.txt"), `${volumes.join("\n")}\n`);
  writeFileSync(join(dir, "networks.txt"), `${networks.join("\n")}\n`);
  writeFileSync(join(dir, "fail.txt"), `${failOn.join("\n")}\n`);
  writeFileSync(join(dir, "calls.log"), "");
  const stub = join(dir, "docker");
  writeFileSync(
    stub,
    `#!/usr/bin/env bash
echo "$*" >> "${dir}/calls.log"
case "$1 $2" in
  "ps -a") cat "${dir}/ps.txt" ;;
  "volume ls") cat "${dir}/volumes.txt" ;;
  "network ls") cat "${dir}/networks.txt" ;;
  "rm -f") grep -qx -- "\${@: -1}" "${dir}/fail.txt" && exit 1; exit 0 ;;
  "volume rm"|"network rm") grep -qx -- "$3" "${dir}/fail.txt" && exit 1; exit 0 ;;
  *) echo "unexpected docker invocation: $*" >&2; exit 99 ;;
esac
`,
  );
  chmodSync(stub, 0o755);
  return dir;
}

function run(args, options = {}) {
  const dir = fakeDocker(options);
  const result = failOnProcessDeadline(
    spawnSync("bash", [script, ...args], {
      ...processGuard(),
      encoding: "utf8",
      env: { ...process.env, PATH: `${dir}:${process.env.PATH}` },
    }),
    { label: `cleanup-stacks.sh ${args.join(" ")}` },
  );
  const calls = readFileSync(join(dir, "calls.log"), "utf8").split("\n").filter(Boolean);
  const removed = {
    containers: calls.filter((c) => c.startsWith("rm -f")).map((c) => c.split(" ").pop()),
    volumes: calls.filter((c) => c.startsWith("volume rm")).map((c) => c.split(" ").pop()),
    networks: calls.filter((c) => c.startsWith("network rm")).map((c) => c.split(" ").pop()),
  };
  return { ...result, calls, removed };
}

const mutating = (call) => /^(rm|volume rm|network rm|stop|kill|compose|system|container|prune)\b/.test(call);

describe("cleanup-stacks.sh", () => {
  it("lists every orbit* project, stopped containers and empty-project leftovers included, and changes nothing", () => {
    const r = run([]);
    expect(r.status).toBe(0);
    expect(r.calls.some(mutating)).toBe(false);
    for (const project of ["orbit (running)", "orbit-a (running)", "orbit-b (running)", "orbit-gone (stale)", "orbit-stale (stale)"]) {
      expect(r.stdout).toContain(`Project: ${project}\n`);
    }
    expect(r.stdout).toContain("orbit-a-db-1 (Exited (0) 2 hours ago) image postgres:18-alpine");
    expect(r.stdout).toContain("orbit-a-tools-1");
    expect(r.stdout).toContain("orbit-gone_orbit-db-data");
    expect(r.stdout).toContain("orbit-gone_default");
    expect(r.stdout).toContain("Nothing was changed");
    expect(r.stdout).not.toContain("other-web-1");
    expect(r.stdout).not.toContain("other_data");
  });

  it("lists containers Compose did not create separately and says they are left alone", () => {
    const r = run([]);
    const tail = r.stdout.split("Not Compose-managed, left alone:")[1];
    expect(tail).toBeDefined();
    expect(tail).toContain("review-nginx");
    expect(tail).toContain("orbit-lookalike-by-hand");
    expect(r.stdout.split("Not Compose-managed, left alone:")[0]).not.toContain("review-nginx");
  });

  it("prints no colour codes", () => {
    const r = run([]);
    expect(r.stdout + r.stderr).not.toMatch(/\u001b\[/);
  });

  it("--remove --all removes the containers, volumes and networks of every orbit* project", () => {
    const r = run(["--remove", "--all"]);
    expect(r.status).toBe(0);
    // stopped (c2, c10) and profile (c3) containers included; ollama (c4) kept
    expect(r.removed.containers.sort()).toEqual(["c1", "c10", "c2", "c3", "c5", "c6"]);
    expect(r.removed.volumes.sort()).toEqual([
      "orbit-a_orbit-db-data",
      "orbit-b_orbit-db-data",
      "orbit-gone_orbit-db-data",
      "orbit-stale_orbit-db-data",
    ]);
    expect(r.removed.networks.sort()).toEqual([
      "orbit-a_default",
      "orbit-b_default",
      "orbit-gone_default",
      "orbit-stale_default",
    ]);
    expect(r.stdout).toContain("Removed container orbit-a-db-1");
    expect(r.stdout).toContain("Removed volume orbit-gone_orbit-db-data");
    expect(r.stdout).toContain("Removed network orbit-gone_default");
  });

  it("plain --remove removes only stale projects and skips every running one, naming what runs", () => {
    const r = run(["--remove"]);
    expect(r.status).toBe(0);
    expect(r.removed.containers).toEqual(["c10"]);
    expect(r.removed.volumes.sort()).toEqual(["orbit-gone_orbit-db-data", "orbit-stale_orbit-db-data"]);
    expect(r.removed.networks.sort()).toEqual(["orbit-gone_default", "orbit-stale_default"]);
    expect(r.stdout).toContain(
      "orbit-a skipped: running (orbit-a-app-1) -- remove it with --project orbit-a --remove, or --all",
    );
    expect(r.stdout).toContain("orbit-b skipped: running (orbit-b-app-1)");
    expect(r.stdout).toContain("orbit skipped: running (orbit-postgres)");
    expect(r.stdout).not.toContain("orbit-stale skipped");
    expect(r.stdout).not.toContain("orbit-gone skipped");
  });

  it("a project whose only running container is the kept orbit-ollama counts as stale", () => {
    const r = run(["--remove"], {
      psRows: [
        "orbit-a|c2|orbit-a-db-1|Exited (0) 2 hours ago|postgres:18-alpine|orbit-db|orbit-a_default",
        "orbit-a|c4|orbit-ollama|Up 2 days (healthy)|ollama/ollama:0.33.3|orbit-ollama|orbit-a_models",
      ],
    });
    expect(r.removed.containers).toEqual(["c2"]);
    expect(r.stdout).toContain("Project: orbit-a (stale)");
    // with --include-ollama the running model service shields it again
    const included = run(["--remove", "--include-ollama"], { psRows: ["orbit-a|c4|orbit-ollama|Up 2 days|ollama/ollama:0.33.3|orbit-ollama|orbit-a_models"] });
    expect(included.removed.containers).toEqual([]);
    expect(included.stdout).toContain("orbit-a skipped: running (orbit-ollama)");
  });

  it("removes containers before the networks and volumes they hold", () => {
    const r = run(["--remove", "--all"]);
    const lastContainer = Math.max(...r.calls.map((c, i) => (c.startsWith("rm -f") ? i : -1)));
    const firstOther = r.calls.findIndex((c) => c.startsWith("volume rm") || c.startsWith("network rm"));
    expect(lastContainer).toBeLessThan(firstOther);
  });

  it("never removes a container Compose did not create, or a project not named orbit*", () => {
    const r = run(["--remove", "--all", "--include-ollama"]);
    expect(r.removed.containers).not.toContain("c7");
    expect(r.removed.containers).not.toContain("c8");
    expect(r.removed.containers).not.toContain("c9");
    expect(r.removed.volumes).not.toContain("other_data");
    expect(r.removed.networks).not.toContain("other_default");
  });

  it("keeps orbit-ollama and its model volume by default and says how to include them", () => {
    const listing = run([]);
    expect(listing.stdout).toContain("--include-ollama");
    const r = run(["--remove", "--all"]);
    expect(r.removed.containers).not.toContain("c4");
    expect(r.removed.volumes).not.toContain("orbit-a_orbit-ollama-data");
    // a network the kept container still sits on cannot go either
    expect(r.removed.networks).not.toContain("orbit-a_models");
    expect(r.stdout).toContain("Kept the orbit-ollama service");
    expect(r.stdout).toContain("--include-ollama");
  });

  it("--include-ollama removes orbit-ollama, its model volume and its network", () => {
    const r = run(["--remove", "--all", "--include-ollama"]);
    expect(r.status).toBe(0);
    expect(r.removed.containers).toContain("c4");
    expect(r.removed.volumes).toContain("orbit-a_orbit-ollama-data");
    expect(r.removed.networks).toContain("orbit-a_models");
    expect(r.stdout).not.toContain("Kept the orbit-ollama service");
  });

  it("--project limits the listing to one project", () => {
    const r = run(["--project", "orbit-b"]);
    expect(r.stdout).toContain("Project: orbit-b (running)\n");
    // orbit-b has no model service, so no note about keeping one
    expect(r.stdout).not.toContain("orbit-ollama");
    expect(r.stdout).not.toContain("Project: orbit-a");
    expect(r.stdout).not.toContain("Project: orbit\n");
  });

  it("--project removes that one project even though it is running, and only it", () => {
    const r = run(["--remove", "--project", "orbit-a"]);
    expect(r.removed.containers.sort()).toEqual(["c1", "c2", "c3"]);
    expect(r.removed.volumes).toEqual(["orbit-a_orbit-db-data"]);
    expect(r.removed.networks).toEqual(["orbit-a_default"]);
  });

  it("--project does not match another project that merely shares its prefix", () => {
    const r = run(["--remove", "--project", "orbit"]);
    expect(r.removed.containers).toEqual(["c6"]);
    expect(r.removed.networks).toEqual([]);
  });

  it("refuses --project for a name that does not start with orbit, without touching docker", () => {
    const r = run(["--remove", "--project", "other"]);
    expect(r.status).toBe(2);
    expect(r.stderr).toContain("starts with \"orbit\"");
    expect(r.calls).toEqual([]);
  });

  it("exits non-zero and names what it could not remove, but still removes the rest", () => {
    const r = run(["--remove", "--all"], { failOn: ["c2", "orbit-b_default"] });
    expect(r.status).toBe(1);
    expect(r.stderr).toContain("COULD NOT REMOVE container orbit-a-db-1");
    expect(r.stderr).toContain("COULD NOT REMOVE network orbit-b_default");
    expect(r.removed.containers).toContain("c5");
    expect(r.removed.volumes).toContain("orbit-gone_orbit-db-data");
  });

  it("rejects an unknown option without calling docker", () => {
    const r = run(["--nuke"]);
    expect(r.status).toBe(2);
    expect(r.calls).toEqual([]);
  });
});
