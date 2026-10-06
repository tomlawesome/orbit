import { spawnSync } from "node:child_process";
import { chmodSync, copyFileSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { afterEach, describe, expect, it, vi } from "vitest";

import { PROCESS_TEST_TIMEOUT_MS, failOnProcessDeadline, processGuard } from "../process-budget.mjs";

// Each test runs the real script under bash; budget in scripts/process-budget.mjs.
vi.setConfig({ testTimeout: PROCESS_TEST_TIMEOUT_MS });

// Issue #1241: the demo / acceptance test bed must tear itself down completely.
// The script is copied into a throwaway tree beside a fake docker, openssl, git
// and build script, so these tests say exactly which Compose files, overrides
// and removals the script asked for without touching a real daemon.

const realScript = join(dirname(fileURLToPath(import.meta.url)), "test-bed.sh");
const digest = `registry.example/orbit@sha256:${"a".repeat(64)}`;
const host = "192.0.2.10";
const files = [
  "docker-compose.yml",
  "docker-compose.mail.yml",
  "compose/docker-compose.acceptance.yml",
  "compose/docker-compose.demo.yml",
];

// container rows: id|name|image|service|networks
const appRows = [
  `c1|orbit|${digest}|orbit-app|orbit_default`,
  `c2|orbit-postgres|postgres:18-alpine|orbit-db|orbit_default`,
];
const ollamaRow = "c9|orbit-ollama|ollama/ollama:0.33.3|orbit-ollama|orbit_orbit-document-processing";

const scratchDirs = [];
afterEach(() => {
  while (scratchDirs.length > 0) rmSync(scratchDirs.pop(), { recursive: true, force: true });
});

function lines(text) {
  return text.split("\n").filter(Boolean);
}

function setup({ containers = [], volumes = [], networks = [], failOn = [], keep = false, stopped = false, appEnv = [`APP_URL=https://${host}:3443`] } = {}) {
  const dir = mkdtempSync(join(tmpdir(), "orbit-test-bed-"));
  scratchDirs.push(dir);
  const bin = join(dir, "bin");
  const tree = join(dir, "tree");
  const state = join(dir, "state");
  for (const d of [bin, state, join(tree, "scripts/dev"), join(tree, "demo-tls")]) mkdirSync(d, { recursive: true });
  copyFileSync(realScript, join(tree, "scripts/dev/test-bed.sh"));
  writeFileSync(join(tree, ".env-orbit"), "ORBIT_TEST_ONLY=fixture\n");
  writeFileSync(join(tree, "scripts/build-container.sh"), `#!/usr/bin/env bash\necho "build-container.sh" >> "${state}/calls.log"\n`);
  writeFileSync(join(state, "containers.txt"), containers.map((l) => `${l}\n`).join(""));
  writeFileSync(join(state, "volumes.txt"), volumes.map((l) => `${l}\n`).join(""));
  writeFileSync(join(state, "networks.txt"), networks.map((l) => `${l}\n`).join(""));
  writeFileSync(join(state, "fail.txt"), failOn.map((l) => `${l}\n`).join(""));
  writeFileSync(join(state, "calls.log"), "");
  writeFileSync(join(state, "env.log"), "");
  writeFileSync(join(state, "app-env.txt"), appEnv.map((l) => `${l}\n`).join(""));
  if (stopped) writeFileSync(join(state, "stopped"), "");
  if (keep) writeFileSync(join(state, "keep"), "");
  writeFileSync(
    join(bin, "docker"),
    `#!/usr/bin/env bash
S="${state}"
echo "$*" >> "$S/calls.log"
if [[ "$1" == compose && "$2" != version ]]; then
  echo "ORBIT_IMAGE=$ORBIT_IMAGE DEMO_HOST=$DEMO_HOST ORBIT_BIND_ADDRESS=$ORBIT_BIND_ADDRESS ORBIT_PORT=$ORBIT_PORT" >> "$S/env.log"
fi
while IFS= read -r pattern; do
  [[ -n "$pattern" && " $* " == *"$pattern"* ]] && exit 1
done < "$S/fail.txt"
case "$1 $2" in
  "compose version") exit 0 ;;
  "ps -a") [[ " $* " == *" status=running "* && -f "$S/stopped" ]] || cat "$S/containers.txt" ;;
  "inspect --format") cat "$S/app-env.txt" ;;
  "volume ls") cat "$S/volumes.txt" ;;
  "network ls") cat "$S/networks.txt" ;;
  "volume rm") grep -vxF -- "$3" "$S/volumes.txt" > "$S/v.tmp"; mv "$S/v.tmp" "$S/volumes.txt" ;;
  "network rm") grep -vxF -- "$3" "$S/networks.txt" > "$S/n.tmp"; mv "$S/n.tmp" "$S/networks.txt" ;;
  "rm -f") grep -v "^\${@: -1}|" "$S/containers.txt" > "$S/c.tmp"; mv "$S/c.tmp" "$S/containers.txt" ;;
  "image inspect"|"rmi "*) exit 0 ;;
  compose*)
    case " $* " in
      *" down "*) [[ -f "$S/keep" ]] || : > "$S/containers.txt"; [[ -f "$S/keep" ]] || : > "$S/volumes.txt"; [[ -f "$S/keep" ]] || : > "$S/networks.txt" ;;
      *" logs "*) echo "fake compose logs" ;;
      *" ps "*) echo "fake compose ps" ;;
    esac ;;
  *) echo "unexpected docker invocation: $*" >&2; exit 99 ;;
esac
`,
  );
  writeFileSync(join(bin, "openssl"), `#!/usr/bin/env bash\necho "openssl $*" >> "${state}/calls.log"\n: > demo-tls/demo.key\n: > demo-tls/demo.crt\n`);
  writeFileSync(join(bin, "git"), `#!/usr/bin/env bash\necho abc123def456\n`);
  for (const f of ["docker", "openssl", "git"]) chmodSync(join(bin, f), 0o755);
  chmodSync(join(tree, "scripts/build-container.sh"), 0o755);
  return { dir, bin, tree, state, backups: join(dir, "backups") };
}

function run(args, options = {}) {
  const s = setup(options);
  const env = { ...process.env, PATH: `${s.bin}:${process.env.PATH}`, ORBIT_TEST_BED_BACKUPS: s.backups };
  delete env.DEMO_HOST;
  delete env.COMPOSE_PROJECT_NAME;
  const result = failOnProcessDeadline(
    spawnSync("bash", [join(s.tree, "scripts/dev/test-bed.sh"), ...args], { ...processGuard(), encoding: "utf8", env }),
    { label: `test-bed.sh ${args.join(" ")}` },
  );
  const calls = lines(readFileSync(join(s.state, "calls.log"), "utf8"));
  const envs = lines(readFileSync(join(s.state, "env.log"), "utf8"));
  return { ...result, ...s, calls, envs, compose: calls.filter((c) => c.startsWith("compose ") && c !== "compose version") };
}

const fileArgs = (call) => [...call.matchAll(/ -f (\S+)/g)].map((m) => m[1]);

describe("test-bed.sh up", () => {
  it("passes the four Compose files and the environment overrides, waits for health and never writes .env-orbit", () => {
    const r = run(["up", "--image", digest, "--host", host]);
    expect(r.status).toBe(0);
    const up = r.compose.find((c) => / up /.test(c));
    expect(up).toContain("-p orbit ");
    expect(up).toContain("--env-file .env-orbit");
    expect(fileArgs(up)).toEqual(files);
    expect(up).toMatch(/ up -d --wait$/);
    expect(r.envs.at(-1)).toBe(`ORBIT_IMAGE=${digest} DEMO_HOST=${host} ORBIT_BIND_ADDRESS=127.0.0.1 ORBIT_PORT=3001`);
    expect(readFileSync(join(r.tree, ".env-orbit"), "utf8")).toBe("ORBIT_TEST_ONLY=fixture\n");
    expect(r.stdout).toContain(`https://${host}:3443/`);
    expect(r.stdout).toContain(`https://${host}:4443/`);
    expect(r.stdout).toContain("browser warns once");
    expect(r.stdout).not.toContain("COMPOSE_PROJECT_NAME");
    expect(r.stdout).toContain("Operator scripts against the bed: bash scripts/dev/test-bed.sh run -- bash scripts/backup.sh");
  });

  it("prints the project prefix for backup.sh when --project is not orbit", () => {
    const r = run(["up", "--image", digest, "--host", host, "--project", "orbit-demo"]);
    expect(r.status).toBe(0);
    expect(r.compose.find((c) => / up /.test(c))).toContain("-p orbit-demo ");
    expect(r.stdout).toContain("COMPOSE_PROJECT_NAME=orbit-demo");
  });

  it("builds with scripts/build-container.sh and uses the tag it made", () => {
    const r = run(["up", "--build", "--host", host]);
    expect(r.status).toBe(0);
    expect(r.calls).toContain("build-container.sh");
    expect(r.envs.at(-1)).toContain("ORBIT_IMAGE=orbit-local:abc123def456 ");
  });

  it("needs a host", () => {
    const r = run(["up", "--image", digest]);
    expect(r.status).not.toBe(0);
    expect(r.stderr).toContain("--host");
    expect(r.compose).toEqual([]);
  });

  it("rejects a mutable tag or a short digest before touching Docker", () => {
    for (const bad of ["registry.example/orbit:latest", "registry.example/orbit:1.2.3", `registry.example/orbit@sha256:${"a".repeat(10)}`]) {
      const r = run(["up", "--image", bad, "--host", host]);
      expect(r.status).not.toBe(0);
      expect(r.stderr).toContain("registry digest");
      expect(r.calls.filter((c) => c !== "compose version")).toEqual([]);
    }
  });

  it("refuses when the project already has containers, and says to run down", () => {
    const r = run(["up", "--image", digest, "--host", host], { containers: appRows });
    expect(r.status).not.toBe(0);
    expect(r.stderr).toContain("already has");
    expect(r.stderr).toContain("test-bed.sh down");
    expect(r.compose).toEqual([]);
  });

  it("is not blocked by a kept orbit-ollama, its model volume or its network", () => {
    const r = run(["up", "--image", digest, "--host", host], {
      containers: [ollamaRow],
      volumes: ["orbit_orbit-ollama-data"],
      networks: ["orbit_orbit-document-processing"],
    });
    expect(r.status).toBe(0);
    expect(r.compose.some((c) => / up /.test(c))).toBe(true);
  });

  it("a failed up saves logs and the container list, then removes everything", () => {
    const r = run(["up", "--image", digest, "--host", host], { failOn: [" up "] });
    expect(r.status).toBe(1);
    const kinds = r.compose.map((c) => (/ up /.test(c) ? "up" : / logs /.test(c) ? "logs" : / ps /.test(c) ? "ps" : / down /.test(c) ? "down" : "other"));
    expect(kinds).toEqual(["up", "logs", "ps", "down"]);
    expect(r.compose.at(-1)).toContain("--profile * down --volumes --remove-orphans");
    const saved = readdirSync(r.backups);
    expect(saved).toHaveLength(1);
    expect(saved[0]).toMatch(/^test-bed-orbit-\d{8}T\d{6}Z$/);
    expect(readFileSync(join(r.backups, saved[0], "compose-logs.txt"), "utf8")).toContain("fake compose logs");
    expect(readFileSync(join(r.backups, saved[0], "ps.txt"), "utf8")).toContain("fake compose ps");
    expect(r.stderr).toContain(join(r.backups, saved[0]));
  });
});

describe("test-bed.sh down", () => {
  const present = { containers: appRows, volumes: ["orbit_orbit-db-data"], networks: ["orbit_default"] };

  it("removes profile services, volumes and orphans, then checks by label that nothing is left", () => {
    const r = run(["down"], present);
    expect(r.status).toBe(0);
    const downIndex = r.calls.findIndex((c) => c.includes("--profile * down --volumes --remove-orphans"));
    expect(downIndex).toBeGreaterThan(-1);
    expect(fileArgs(r.calls[downIndex])).toEqual(files);
    const after = r.calls.slice(downIndex + 1);
    expect(after.some((c) => c.startsWith("ps -a --filter label=com.docker.compose.project=orbit "))).toBe(true);
    expect(after.some((c) => c.startsWith("volume ls --filter label=com.docker.compose.project=orbit "))).toBe(true);
    expect(after.some((c) => c.startsWith("network ls --filter label=com.docker.compose.project=orbit "))).toBe(true);
    expect(r.stdout).toContain("nothing is left");
  });

  it("fails loudly and names what is left when something survives", () => {
    const r = run(["down"], { ...present, keep: true });
    expect(r.status).not.toBe(0);
    expect(r.stderr).toContain("FAILED to remove everything");
    expect(r.stderr).toContain("container orbit");
    expect(r.stderr).toContain("volume orbit_orbit-db-data");
    expect(r.stderr).toContain("network orbit_default");
  });

  it("removes the image it built, and only that kind of image", () => {
    const built = run(["down"], { containers: ["c1|orbit|orbit-local:abc123def456|orbit-app|orbit_default"] });
    expect(built.calls).toContain("rmi orbit-local:abc123def456");
    const registry = run(["down"], present);
    expect(registry.calls.some((c) => c.startsWith("rmi "))).toBe(false);
  });

  const withOllama = {
    containers: [...appRows, ollamaRow],
    volumes: ["orbit_orbit-db-data", "orbit_orbit-ollama-data"],
    networks: ["orbit_default", "orbit_orbit-document-processing"],
  };

  it("keeps orbit-ollama, its model volume and its network by default, and says how to include them", () => {
    const r = run(["down"], withOllama);
    expect(r.status).toBe(0);
    expect(r.compose.some((c) => / down /.test(c))).toBe(false);
    const removed = r.calls.filter((c) => /^(rm|volume rm|network rm)\b/.test(c)).map((c) => c.split(" ").pop());
    expect(removed.sort()).toEqual(["c1", "c2", "orbit_default", "orbit_orbit-db-data"].sort());
    expect(r.stdout).toContain("Kept the orbit-ollama service and its model volume");
    expect(r.stdout).toContain("--include-ollama");
    expect(readFileSync(join(r.state, "containers.txt"), "utf8")).toBe(`${ollamaRow}\n`);
  });

  it("--include-ollama removes the lot with the whole-project down", () => {
    const r = run(["down", "--include-ollama"], withOllama);
    expect(r.status).toBe(0);
    expect(r.compose.some((c) => c.includes("--profile * down --volumes --remove-orphans"))).toBe(true);
    expect(r.stdout).not.toContain("Kept the orbit-ollama");
  });

  it("does not accept --include-ollama on up", () => {
    const r = run(["up", "--image", digest, "--host", host, "--include-ollama"]);
    expect(r.status).not.toBe(0);
    expect(r.stderr).toContain("only applies to down");
  });
});

describe("test-bed.sh restart and status", () => {
  it("restarts with the same files, project and overrides as up, keeping the running image", () => {
    const up = run(["up", "--image", digest, "--host", host]);
    const restart = run(["restart", "--host", host], { containers: appRows });
    expect(restart.status).toBe(0);
    const stop = restart.compose.find((c) => / stop$/.test(c));
    const upAgain = restart.compose.find((c) => / up /.test(c));
    expect(fileArgs(stop)).toEqual(files);
    expect(fileArgs(upAgain)).toEqual(files);
    expect(upAgain).toMatch(/ up -d --wait$/);
    expect(restart.compose.indexOf(stop)).toBeLessThan(restart.compose.indexOf(upAgain));
    expect(restart.envs.at(-1)).toBe(up.envs.at(-1));
    expect(restart.envs.every((e) => e === up.envs.at(-1))).toBe(true);
  });

  it("restart with no bed running tells you to use up", () => {
    const r = run(["restart", "--host", host]);
    expect(r.status).not.toBe(0);
    expect(r.stderr).toContain("use up");
  });

  it("status lists the project's containers by label and changes nothing", () => {
    const r = run(["status"], { containers: appRows });
    expect(r.status).toBe(0);
    expect(r.compose).toEqual([]);
    expect(r.calls.some((c) => c.startsWith("ps -a --filter label=com.docker.compose.project=orbit "))).toBe(true);
  });
});

describe("test-bed.sh run", () => {
  const probe = ["--", "bash", "-c", 'echo "$ORBIT_IMAGE $DEMO_HOST $ORBIT_BIND_ADDRESS $ORBIT_PORT $COMPOSE_PROJECT_NAME"; echo oops >&2; exit 7'];

  it("refuses when the bed is not running, and does not run the command", () => {
    for (const options of [{}, { containers: appRows, stopped: true }]) {
      const r = run(["run", ...probe], options);
      expect(r.status).not.toBe(0);
      expect(r.stderr).toContain("no running orbit-app container");
      expect(r.stdout).toBe("");
    }
  });

  it("exports the five variables, reading the image from the container and the host from its config, and passes output and exit status through", () => {
    const r = run(["run", ...probe], { containers: appRows });
    expect(r.status).toBe(7);
    expect(r.stdout).toBe(`${digest} ${host} 127.0.0.1 3001 orbit\n`);
    expect(r.stderr).toBe("oops\n");
    expect(readFileSync(join(r.tree, ".env-orbit"), "utf8")).toBe("ORBIT_TEST_ONLY=fixture\n");
  });

  it("uses --host over the container's config and exports the chosen project", () => {
    const r = run(["run", "--host", "192.0.2.77", "--project", "orbit-demo", ...probe], { containers: appRows });
    expect(r.status).toBe(7);
    expect(r.stdout).toBe(`${digest} 192.0.2.77 127.0.0.1 3001 orbit-demo\n`);
  });

  it("asks for --host when the container's config does not give one", () => {
    const r = run(["run", ...probe], { containers: appRows, appEnv: [] });
    expect(r.status).not.toBe(0);
    expect(r.stderr).toContain("--host");
    expect(r.stdout).toBe("");
  });

  it("needs a command after --", () => {
    const r = run(["run"], { containers: appRows });
    expect(r.status).not.toBe(0);
    expect(r.stderr).toContain("after --");
  });
});

describe("test-bed.sh as a script", () => {
  it("is never shipped in the image, and never edits .env-orbit", () => {
    const root = join(dirname(fileURLToPath(import.meta.url)), "../..");
    expect(readFileSync(join(root, "Dockerfile"), "utf8")).not.toContain("scripts/dev");
    const source = readFileSync(realScript, "utf8");
    expect(source).not.toMatch(/>>?\s*"?\$?\{?env_file/);
  });
});
