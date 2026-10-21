import { execFileSync, spawn, spawnSync } from "node:child_process";
import {
  appendFileSync,
  chmodSync,
  copyFileSync,
  existsSync,
  lstatSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  readdirSync,
  readlinkSync,
  rmSync,
  statSync,
  watch,
  symlinkSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { basename, dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { afterEach, describe, expect, it, vi } from "vitest";

import { PTY_TEST_TIMEOUT_MS, ptyWatchdog } from "./pty-deadline.mjs";
import { PROCESS_TEST_TIMEOUT_MS, failOnProcessDeadline, processGuard, processWatchdog } from "./process-budget.mjs";

// scripts/install.sh, the bootstrap shell around the install engine (#1212).
//
// Since the flip this script owns three things and this suite proves them:
// the bootstrap before the engine (arguments, settings, tools, the release
// manifest and its signatures, the pull, the image's labels and banner, the
// Docker facts the engine needs), the one engine run and what the shell does
// with its outcome, and Compose after the commit (service images, start,
// readiness, the completion screen). Everything the engine decides --
// target validation, volume safety, configuration, OIDC discovery, the file
// transaction, the launcher tree -- is proven in src/lib/*.test.ts and
// src/cli/orbit.install.test.ts. Every case the bash-era suite held is
// mapped to the test that now proves it in
// docs/adr-notes/1212-bash-test-retirement.md.
//
// Fully mocked: a fake `docker` first on PATH answers the bootstrap's calls
// from FAKE_* settings and runs the real engine from this checkout (through
// tsx) for the one `docker run ... /opt/orbit/cli/orbit.js install`, with
// the bind mounts translated back to host paths -- so the shell and the
// engine are exercised together without a daemon, an image or a network.

vi.setConfig({ testTimeout: PROCESS_TEST_TIMEOUT_MS });

const installScript = fileURLToPath(new URL("./install.sh", import.meta.url));
const repositoryRoot = fileURLToPath(new URL("..", import.meta.url));
const engineTsx = join(repositoryRoot, "node_modules", "tsx", "dist", "cli.mjs");
const engineCli = join(repositoryRoot, "src", "cli", "orbit.ts");

const repository = "example/orbit-fixture";
const registry = "fake-registry.example";
const imageRepository = `${registry}/${repository}`;
const digest = "a".repeat(64);
const revision = "b".repeat(40);
const resolvedReference = `${imageRepository}@sha256:${digest}`;
const preflightSuccessLine =
  "Orbit installer: configuration, OIDC discovery, and Docker Compose preflight passed; starting services.";
const deploymentAssets = [
  "docker-compose.yml",
  "docker-compose.mail.yml",
  "docker-compose.kek-rotation.yml",
  ".env-orbit.example",
  "config/tika-config.json",
  "scripts/configure.sh",
  "scripts/installer-ui.sh",
  "scripts/backup.sh",
  "scripts/restore.sh",
  "scripts/repair.sh",
  "scripts/export-recovery-bundle.sh",
  "scripts/import-recovery-bundle.sh",
  "scripts/end-maintenance.sh",
];

// A release manifest handed over already verified, as get-orbit.sh or the
// launcher would (ADR-0031 #7).
const releaseManifestDir = mkdtempSync(join(tmpdir(), "orbit-install-manifest-fixture-"));
const releaseManifestPath = join(releaseManifestDir, "orbit-release-manifest.json");
writeFileSync(
  releaseManifestPath,
  JSON.stringify(
    {
      schema: "https://tomlawson.io/schemas/orbit-release-manifest/v1",
      version: "v1.2.0",
      channel: "preview",
      commit: revision,
      image: { repository: imageRepository, digest: `sha256:${digest}` },
      launcher: { tag: "v1.0.0", commit: revision },
      files: {},
      recordedAt: "2026-09-24T00:00:00Z",
    },
    null,
    2,
  ),
);

// The image's bundled deployment assets (ADR-0019): this checkout's own.
const assetsRoot = mkdtempSync(join(tmpdir(), "orbit-install-assets-"));
for (const asset of deploymentAssets) {
  mkdirSync(dirname(join(assetsRoot, asset)), { recursive: true });
  copyFileSync(join(repositoryRoot, asset), join(assetsRoot, asset));
}

// The fake docker. Every call is appended to FAKE_CALL_LOG as
// "docker <args>"; the engine run's own argv and environment go to
// FAKE_ENGINE_LOG as JSON.
const fakeDockerScript = `#!/usr/bin/env node
const fs = require("node:fs");
const { spawnSync } = require("node:child_process");
const argv = process.argv.slice(2);
// A pasted-command wrapper passes "--" first: Node would otherwise act on a docker-style --env-file argument itself.
if (argv[0] === "--") argv.shift();
const env = process.env;
if (env.FAKE_CALL_LOG) fs.appendFileSync(env.FAKE_CALL_LOG, "docker " + argv.join(" ") + "\\n");
const out = (text) => process.stdout.write(text);
const json = (name, fallback) => (env[name] ? JSON.parse(env[name]) : fallback);
const flagValue = (flag) => {
  const index = argv.indexOf(flag);
  return index >= 0 ? argv[index + 1] : undefined;
};
const volumes = (env.FAKE_VOLUMES ?? "").split("\\n").filter(Boolean);
const exit = (code) => process.exit(code);
// Blocks until a signal kills this process (120s at most), after telling the test where it is.
function hang(name) {
  if (env.FAKE_STATE_DIR) fs.writeFileSync(env.FAKE_STATE_DIR + "/hung-" + name, String(process.pid));
  Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 120000);
}

function runEngine() {
  const engineEnv = { PATH: env.PATH, HOME: env.HOME, TERM: env.TERM, ORBIT_ENGINE_CONTEXT: "container", ORBIT_INSTALL_TEST_ASSETS_ROOT: env.FAKE_ASSETS_ROOT };
  const mounts = [];
  const valueFlags = new Set(["-e", "--env", "-v", "--volume", "--entrypoint", "--network", "--user", "--name"]);
  let index = 1;
  let entrypoint;
  for (; index < argv.length; index += 1) {
    const flag = argv[index];
    if (!flag.startsWith("-")) break;
    if (!valueFlags.has(flag)) continue;
    const value = argv[++index];
    if (flag === "-e" || flag === "--env") {
      const eq = value.indexOf("=");
      if (eq >= 0) engineEnv[value.slice(0, eq)] = value.slice(eq + 1);
      else if (env[value] !== undefined) engineEnv[value] = env[value];
    } else if (flag === "-v" || flag === "--volume") {
      const [source, target] = value.split(":");
      mounts.push([target, source]);
    } else if (flag === "--entrypoint") {
      entrypoint = value;
    }
  }
  const image = argv[index];
  const rest = argv.slice(index + 1);
  const translate = (value) => {
    for (const [target, source] of mounts) {
      if (value === target) return source;
      if (value.startsWith(target + "/")) return source + value.slice(target.length);
    }
    return value;
  };
  for (const key of Object.keys(engineEnv)) engineEnv[key] = translate(engineEnv[key]);
  Object.assign(engineEnv, json("FAKE_ENGINE_EXTRA_ENV", {}));
  if (env.FAKE_ENGINE_LOG) fs.appendFileSync(env.FAKE_ENGINE_LOG, JSON.stringify({ argv, entrypoint, image, rest, env: engineEnv }) + "\\n");
  if (entrypoint !== "node" || rest[0] !== "/opt/orbit/cli/orbit.js") {
    process.stderr.write("fake docker: unexpected run\\n");
    exit(125);
  }
  const targetRoot = () => translate(rest[rest.indexOf("--dir") + 1]);
  // A file the person saved in the folder while the engine was still running (redesign r2): written once, just before the engine hangs or exits.
  let personWrote = false;
  const personWrites = () => {
    if (personWrote || !env.FAKE_ENGINE_PERSON_WRITES) return;
    personWrote = true;
    const { path, content, mode } = JSON.parse(env.FAKE_ENGINE_PERSON_WRITES);
    const written = path.startsWith("/") ? path : targetRoot() + "/" + path;
    fs.writeFileSync(written, content);
    // The person's own mode, whatever umask the installer runs the engine under (redesign r5 B10).
    if (mode !== undefined) fs.chmodSync(written, mode);
  };
  // An engine still running before it commits anything (O-R4).
  if (env.FAKE_ENGINE_HANG_BEFORE === "1") {
    personWrites();
    hang("engine");
  }
  if (env.FAKE_ENGINE_EXIT !== undefined) {
    // A canned engine: leave the files asked for in the target, write the outcome asked for, if any, and exit.
    // Redesign r2: first, the journal of the names it may write, beside the outcome; unset, no journal (an engine that died first, or an older image).
    const journalAt = rest.indexOf("--outcome");
    if (env.FAKE_ENGINE_WRITTEN !== undefined && journalAt >= 0) {
      const outcomePath = translate(rest[journalAt + 1]);
      const names = env.FAKE_ENGINE_WRITTEN.endsWith("\\n") ? env.FAKE_ENGINE_WRITTEN : env.FAKE_ENGINE_WRITTEN + "\\n";
      fs.writeFileSync(outcomePath.slice(0, outcomePath.lastIndexOf("/")) + "/written", names, { mode: 0o600 });
    }
    if (env.FAKE_ENGINE_LEAVES) {
      // {"relative/path": content | null | {content | base64 | symlink, mode}}; a trailing "/" is a directory (redesign r1).
      const root = translate(rest[rest.indexOf("--dir") + 1]);
      const directoryModes = [];
      // "@<file>" reads the JSON from a file: a whole committed tree is too large for one environment string.
      const leaves = env.FAKE_ENGINE_LEAVES.startsWith("@") ? fs.readFileSync(env.FAKE_ENGINE_LEAVES.slice(1), "utf8") : env.FAKE_ENGINE_LEAVES;
      for (const [relative, value] of Object.entries(JSON.parse(leaves))) {
        const path = root + "/" + relative.replace(/\\/+$/, "");
        const spec = value !== null && typeof value === "object" ? value : { content: value };
        if (relative.endsWith("/")) {
          fs.mkdirSync(path, { recursive: true });
          if (spec.mode !== undefined) directoryModes.unshift([path, spec.mode]);
          continue;
        }
        fs.mkdirSync(path.slice(0, path.lastIndexOf("/")), { recursive: true });
        if (spec.symlink !== undefined) {
          fs.symlinkSync(spec.symlink, path);
          continue;
        }
        fs.writeFileSync(path, spec.base64 !== undefined ? Buffer.from(spec.base64, "base64") : (spec.content ?? ""));
        if (spec.mode !== undefined) fs.chmodSync(path, spec.mode);
      }
      // Directory modes last, deepest first, so a read-only directory still received its files.
      for (const [path, mode] of directoryModes) fs.chmodSync(path, mode);
    }
    const outcomeIndex = rest.indexOf("--outcome");
    if (env.FAKE_ENGINE_OUTCOME !== undefined && outcomeIndex >= 0) {
      fs.writeFileSync(translate(rest[outcomeIndex + 1]), env.FAKE_ENGINE_OUTCOME, { mode: 0o600 });
    }
    personWrites();
    // The canned engine committed (files and outcome written) and is still running (redesign r1).
    if (env.FAKE_ENGINE_HANG_AFTER === "1") hang("engine");
    exit(Number(env.FAKE_ENGINE_EXIT));
  }
  const result = spawnSync("node", [${JSON.stringify(engineTsx)}, ${JSON.stringify(engineCli)}, ...rest.slice(1).map(translate)], { stdio: "inherit", env: engineEnv });
  if (env.FAKE_OUTCOME_PATCH) {
    // Make the real engine's outcome name another profile / ask for the model download.
    const outcomeAt = rest.indexOf("--outcome");
    const file = translate(rest[outcomeAt + 1]);
    const patch = JSON.parse(env.FAKE_OUTCOME_PATCH);
    const lines = fs.readFileSync(file, "utf8").split("\\n").filter(Boolean).map((line) => {
      const key = line.slice(0, line.indexOf("="));
      return key in patch ? key + "=" + patch[key] : line;
    });
    fs.writeFileSync(file, lines.join("\\n") + "\\n", { mode: 0o600 });
  }
  personWrites();
  // The real engine committed (files and outcome written) and is still running (O-R4).
  if (env.FAKE_ENGINE_HANG_AFTER === "1") hang("engine");
  // The real engine committed; docker run still exits non-zero (#1456 follow-up).
  if (env.FAKE_ENGINE_REAL_THEN_EXIT !== undefined) exit(Number(env.FAKE_ENGINE_REAL_THEN_EXIT));
  if (result.signal === "SIGKILL") exit(137);
  exit(result.status === null ? 1 : result.status);
}

function compose() {
  if (argv[1] === "version") exit(env.FAKE_COMPOSE_MISSING === "1" ? 1 : 0);
  if (env.FAKE_COMPOSE_STRICT === "1") {
    // Behave like Compose: a project loaded from a compose file needs ORBIT_IMAGE,
    // from --env-file or the environment; asked only for a project name from a
    // directory without a compose file, it carries on.
    const directoryFlag = flagValue("--project-directory");
    const fileFlag = flagValue("-f") ?? flagValue("--file");
    const composeFile = fileFlag ?? (directoryFlag ? directoryFlag + "/docker-compose.yml" : "docker-compose.yml");
    const found = fs.existsSync(composeFile);
    if (env.FAKE_STATE_DIR) fs.appendFileSync(env.FAKE_STATE_DIR + "/strict-log", JSON.stringify({ cwd: process.cwd(), argv: argv.slice(1), found }) + "\\n");
    if (found) {
      let image = env.ORBIT_IMAGE ?? "";
      const envFile = flagValue("--env-file");
      if (!image && envFile && fs.existsSync(envFile)) {
        const match = /^ORBIT_IMAGE=(.+)$/m.exec(fs.readFileSync(envFile, "utf8"));
        if (match) image = match[1];
      }
      if (!image) {
        process.stderr.write('error while interpolating services.orbit-app.image: required variable ORBIT_IMAGE is missing a value\\n');
        exit(1);
      }
    }
  }
  const sub = argv.find((arg, i) => i > 0 && !arg.startsWith("-") && !["--project-name", "--env-file", "--profile"].includes(argv[i - 1]));
  const after = argv.slice(argv.indexOf(sub) + 1);
  if (argv.includes("orbit-ollama-model-pull") && (sub === "run" || sub === "up")) {
    // The model download as a one-off service (#1474); real Compose prints its words on stderr.
    if (env.FAKE_STATE_DIR) {
      // The container the client started: it outlives its client (Docker does not stop it when the client dies).
      const name = flagValue("--name") ?? (flagValue("--project-name") + "-orbit-ollama-model-pull-run-" + process.pid);
      // Docker refuses a second container under a name that is already in use, running or not.
      const taken = fs.existsSync(env.FAKE_STATE_DIR + "/model-pull-running") ? fs.readFileSync(env.FAKE_STATE_DIR + "/model-pull-running", "utf8").split("\\n") : [];
      if (taken.includes(name)) {
        process.stderr.write('Error response from daemon: Conflict. The container name "/' + name + '" is already in use\\n');
        exit(1);
      }
      fs.appendFileSync(env.FAKE_STATE_DIR + "/model-pull-running", name + "\\n");
      fs.appendFileSync(env.FAKE_STATE_DIR + "/model-pull-started", name + "\\n");
    }
    if (env.FAKE_HANG_MODEL_PULL === "1") hang("modelpull");
    // Finished normally: run --rm removes its container.
    if (env.FAKE_STATE_DIR) fs.writeFileSync(env.FAKE_STATE_DIR + "/model-pull-running", "");
    if (env.FAKE_MODEL_PULL_FAIL === "1") {
      if (env.FAKE_MODEL_PULL_STDERR) process.stderr.write(env.FAKE_MODEL_PULL_STDERR);
      exit(1);
    }
    exit(0);
  }
  if (["rm", "stop", "kill"].includes(sub) && env.FAKE_STATE_DIR) {
    // Scoped to a service: only that service's container goes (the fake models just the model-pull one).
    const services = after.filter((arg) => !arg.startsWith("-"));
    if (services.includes("orbit-ollama-model-pull")) fs.writeFileSync(env.FAKE_STATE_DIR + "/model-pull-running", "");
    exit(0);
  }
  if (sub === "logs") {
    // Container logs carry secrets (the claim code, database passwords): the installer must never ask.
    out("SECRET-LOG-LINE\\n");
    exit(0);
  }
  if (sub === "ps") {
    if (after.includes("-q") || after.includes("--quiet")) {
      const service = after.filter((arg) => !arg.startsWith("-")).at(-1);
      const container = json("FAKE_CONTAINERS", {})[service];
      if (service && !(container && container.status === "missing")) out(flagValue("--project-name") + "-" + service + "-1\\n");
    }
    exit(0);
  }
  if (sub === "config") exit(env.FAKE_COMPOSE_CONFIG_FAIL === "1" ? 1 : 0);
  if (sub === "pull") {
    if ((env.FAKE_HANG_PULL ?? "") === after[0]) hang("pull");
    const failing = (env.FAKE_COMPOSE_PULL_FAIL ?? "") === after[0];
    if (failing && env.FAKE_COMPOSE_PULL_STDERR) process.stderr.write(env.FAKE_COMPOSE_PULL_STDERR);
    exit(failing ? 1 : 0);
  }
  if (sub === "up") {
    // R6-2: docker volume ls fails only once compose up has been tried (the pre-flight listing succeeds).
    if (env.FAKE_STATE_DIR) fs.writeFileSync(env.FAKE_STATE_DIR + "/up-called", "");
    // A failed first start that still created its database volume.
    if (env.FAKE_UP_CREATES_VOLUME === "1" && env.FAKE_STATE_DIR) fs.writeFileSync(env.FAKE_STATE_DIR + "/created-volume", flagValue("--project-name") + "_orbit-db-data");
    // #1455/#1456 hooks: every volume the stack would create, Docker's own
    // words on stderr, and (for down) whether the Compose file was still there.
    if (env.FAKE_UP_CREATES_ALL_VOLUMES === "1" && env.FAKE_STATE_DIR) {
      const project = flagValue("--project-name");
      fs.writeFileSync(env.FAKE_STATE_DIR + "/created-volumes", ["orbit-db-data", "orbit-clamav-data", "orbit-documents-data"].map((name) => project + "_" + name).join("\\n") + "\\n");
    }
    if (env.FAKE_STATE_DIR) fs.writeFileSync(env.FAKE_STATE_DIR + "/containers", ["orbit-db", "orbit-app"].map((name) => flagValue("--project-name") + "-" + name + "-1\\n").join(""));
    // A file the person adds to the folder while the stack starts (O-S1).
    if (env.FAKE_UP_ADDS_FILE) {
      const added = JSON.parse(env.FAKE_UP_ADDS_FILE);
      fs.writeFileSync(added.path, added.content);
    }
    if (env.FAKE_COMPOSE_UP_STDERR) process.stderr.write(env.FAKE_COMPOSE_UP_STDERR);
    if (env.FAKE_SNAPSHOT_ROOTS && env.FAKE_STATE_DIR) {
      // Where the rollback copy lives while the stack starts (#1456 follow-up).
      const roots = JSON.parse(env.FAKE_SNAPSHOT_ROOTS);
      const list = (dir) => {
        const found = [];
        const walk = (current) => {
          let names = [];
          try { names = fs.readdirSync(current); } catch { return; }
          for (const name of names) {
            const path = current + "/" + name;
            const stats = fs.lstatSync(path);
            found.push({ path, name, mode: (stats.mode & 0o777).toString(8), directory: stats.isDirectory() });
            if (stats.isDirectory()) walk(path);
          }
        };
        walk(dir);
        return found;
      };
      // Every root named (tmp, xdg, and the target folder for redesign r5 B2), listed by its key.
      fs.writeFileSync(env.FAKE_STATE_DIR + "/snapshot.json", JSON.stringify(Object.fromEntries(Object.entries(roots).map(([key, root]) => [key, list(root)]))));
    }
    exit(env.FAKE_COMPOSE_UP_FAIL === "1" ? 1 : 0);
  }
  if (sub === "down") {
    if (env.FAKE_HANG_DOWN === "1") hang("down");
    // A slow but healthy down: answers after this many seconds.
    if (env.FAKE_DOWN_DELAY) Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, Number(env.FAKE_DOWN_DELAY) * 1000);
    if (env.FAKE_STATE_DIR) fs.appendFileSync(env.FAKE_STATE_DIR + "/down-log", (fs.existsSync("docker-compose.yml") ? "compose-file-present" : "compose-file-missing") + "\\n");
    if (env.FAKE_COMPOSE_DOWN_FAIL === "1") exit(1);
    if (env.FAKE_STATE_DIR) fs.writeFileSync(env.FAKE_STATE_DIR + "/model-pull-running", "");
    if (env.FAKE_STATE_DIR) fs.writeFileSync(env.FAKE_STATE_DIR + "/containers", "");
    exit(0);
  }
  if (sub === "exec") {
    // A probe is named by what it reaches: the service, or orbit-tika for
    // the probe the application runs against Tika.
    const text = after.join(" ");
    const probe = ["orbit-tika", "orbit-ollama", "orbit-clamav", "orbit-db", "orbit-app"].find((name) => text.includes(name));
    if (env.FAKE_HANG_PROBE && env.FAKE_HANG_PROBE === probe) hang("probe");
    if (after.at(-1) === "true") exit(env.FAKE_APP_RUNNING === "1" ? 0 : 1);
    if ((env.FAKE_PROBE_FAIL ?? "").split(",").includes(probe)) exit(1);
    const transient = json("FAKE_PROBE_FAIL_TIMES", {})[probe];
    if (transient !== undefined && env.FAKE_STATE_DIR) {
      const counter = env.FAKE_STATE_DIR + "/probe-" + probe;
      const seen = fs.existsSync(counter) ? Number(fs.readFileSync(counter, "utf8")) : 0;
      fs.writeFileSync(counter, String(seen + 1));
      if (seen < transient) exit(1);
    }
    exit(0);
  }
  process.stderr.write("fake docker: unsupported compose " + argv.join(" ") + "\\n");
  exit(1);
}

switch (argv[0]) {
  case "compose":
    compose();
    break;
  case "pull":
    if (env.FAKE_PULL_FAIL === "1" && env.FAKE_PULL_STDERR) process.stderr.write(env.FAKE_PULL_STDERR);
    exit(env.FAKE_PULL_FAIL === "1" ? 1 : 0);
    break;
  case "image": {
    const format = flagValue("--format") ?? "";
    if (env.FAKE_INSPECT_FAIL && format.includes(env.FAKE_INSPECT_FAIL)) exit(1);
    if (format.includes("RepoDigests")) out((env.FAKE_REPO_DIGEST ?? argv[argv.length - 1]) + "\\n");
    else if (format.includes("org.opencontainers.image.revision")) out((env.FAKE_DOCKER_REVISION ?? "") + "\\n");
    else if (format.includes("org.opencontainers.image.version")) out((env.FAKE_DOCKER_VERSION ?? "") + "\\n");
    else if (format.includes("io.orbit.deployment-assets")) out((env.FAKE_ASSETS_LABEL ?? "/opt/orbit/deploy") + "\\n");
    exit(0);
    break;
  }
  case "run":
    if (argv.includes("--banner")) {
      if (env.FAKE_BANNER_FAIL === "1") exit(1);
      out("ORBIT FAKE BANNER\\n");
      exit(0);
    }
    runEngine();
    break;
  case "volume":
    if (argv[1] === "ls") {
      if (env.FAKE_HANG_VOLUME_LS_AFTER_UP === "1" && fs.existsSync((env.FAKE_STATE_DIR ?? "/nonexistent") + "/up-called")) hang("volume-ls");
      if (env.FAKE_VOLUME_LS_FAIL === "1") exit(1);
      if (env.FAKE_VOLUME_LS_FAIL_AFTER_UP === "1" && fs.existsSync((env.FAKE_STATE_DIR ?? "/nonexistent") + "/up-called")) exit(1);
      const filter = (flagValue("--filter") ?? "").replace(/^name=/, "");
      const createdPath = (env.FAKE_STATE_DIR ?? "/nonexistent") + "/created-volume";
      if (fs.existsSync(createdPath)) volumes.push(fs.readFileSync(createdPath, "utf8"));
      const createdAllPath = (env.FAKE_STATE_DIR ?? "/nonexistent") + "/created-volumes";
      if (fs.existsSync(createdAllPath)) volumes.push(...fs.readFileSync(createdAllPath, "utf8").split("\\n").filter(Boolean));
      if (filter.startsWith("^")) {
        const exact = filter.slice(1, -1);
        if (env.FAKE_VOLUME_GONE !== "1" && volumes.includes(exact)) out(exact + "\\n");
      } else {
        for (const volume of volumes) if (volume.includes(filter)) out(volume + "\\n");
      }
      exit(0);
    }
    if (argv[1] === "inspect") {
      const volume = argv[argv.length - 1];
      const labels = json("FAKE_VOLUME_LABELS", {});
      const project = volume.replace(/_orbit-db-data$/, "");
      out((labels[volume] ?? project + "|orbit-db-data") + "\\n");
      exit(0);
    }
    if (argv[1] === "rm") {
      if (env.FAKE_HANG_VOLUME_RM === "1") hang("volume-rm");
      if (env.FAKE_VOLUME_RM_FAIL === "1") {
        process.stderr.write("fake docker: volume is in use\\n");
        exit(1);
      }
      // A removed volume is gone for the next run sharing FAKE_STATE_DIR.
      const names = argv.slice(2).filter((arg) => !arg.startsWith("-"));
      for (const file of ["created-volume", "created-volumes"]) {
        const path = (env.FAKE_STATE_DIR ?? "/nonexistent") + "/" + file;
        if (!fs.existsSync(path)) continue;
        const left = fs.readFileSync(path, "utf8").split("\\n").filter((line) => line && !names.includes(line));
        fs.writeFileSync(path, left.map((line) => line + "\\n").join(""));
      }
      exit(0);
    }
    break;
  case "rm":
  case "stop":
  case "kill": {
    // docker rm -f / stop / kill <container>: the named container is no longer running.
    const names = argv.slice(1).filter((arg) => !arg.startsWith("-"));
    const path = (env.FAKE_STATE_DIR ?? "/nonexistent") + "/model-pull-running";
    if (fs.existsSync(path)) fs.writeFileSync(path, fs.readFileSync(path, "utf8").split("\\n").filter((line) => line && !names.includes(line)).map((line) => line + "\\n").join(""));
    exit(0);
    break;
  }
  case "logs":
    out("SECRET-LOG-LINE\\n");
    exit(0);
    break;
  case "ps": {
    const filter = flagValue("--filter") ?? "";
    out(json("FAKE_PS", {})[filter] ?? "");
    exit(0);
    break;
  }
  case "inspect": {
    // Container facts per scenario (FAKE_CONTAINERS), answered for any --format template.
    const containers = json("FAKE_CONTAINERS", null);
    const target = argv[argv.length - 1];
    const service = ["orbit-clamav", "orbit-tika", "orbit-ollama", "orbit-db", "orbit-app"].find((name) => target.includes(name));
    if (containers && service) {
      const container = containers[service] ?? { status: "running" };
      if (container.status === "missing") {
        process.stderr.write("Error: No such object: " + target + "\\n");
        exit(1);
      }
      const values = {
        "State.Status": container.status,
        "State.Running": String(container.status === "running"),
        "State.ExitCode": String(container.exitCode ?? 0),
        "State.OOMKilled": String(container.oom ?? false),
        RestartCount: String(container.restarts ?? 0),
        "State.Health.Status": container.health ?? "none",
        "State.Error": container.error ?? "",
      };
      const format = flagValue("--format") ?? flagValue("-f") ?? "";
      if (container.restartsRising && format.includes("RestartCount") && env.FAKE_STATE_DIR) {
        // A crash loop: the count is higher at every read, by restartsStep (default 1).
        const counter = env.FAKE_STATE_DIR + "/restarts-" + service;
        const reads = fs.existsSync(counter) ? Number(fs.readFileSync(counter, "utf8")) : 0;
        fs.writeFileSync(counter, String(reads + 1));
        values.RestartCount = String((reads + 1) * (container.restartsStep ?? 1));
      }
      if (container.restartsJump !== undefined && format.includes("RestartCount") && env.FAKE_STATE_DIR) {
        // Restarted restartsJump times after the first read, then stable (O-S2).
        const counter = env.FAKE_STATE_DIR + "/restarts-" + service;
        const reads = fs.existsSync(counter) ? Number(fs.readFileSync(counter, "utf8")) : 0;
        fs.writeFileSync(counter, String(reads + 1));
        values.RestartCount = String((container.restarts ?? 0) + (reads === 0 ? 0 : container.restartsJump));
      }
      out(format.replace(/\\{\\{\\s*\\.([A-Za-z.]+)\\s*\\}\\}/g, (_match, field) => values[field] ?? "<no value>") + "\\n");
      exit(0);
    }
    out((json("FAKE_CONTAINER_IMAGES", {})[argv[argv.length - 1]] ?? "") + "\\n");
    exit(0);
    break;
  }
  case "info":
    if (env.FAKE_INFO_FAIL === "1") exit(1);
    out(env.FAKE_ROOTLESS === "1" ? "[name=seccomp,profile=builtin name=rootless]\\n" : "[name=seccomp,profile=builtin]\\n");
    exit(0);
    break;
}
process.stderr.write("fake docker: unsupported " + argv.join(" ") + "\\n");
exit(1);
`;

// Serves file:// release-manifest fixtures for the self-fetch tests; every
// other URL fails closed.
const fakeCurlScript = [
  "#!/usr/bin/env bash",
  "set -Eeuo pipefail",
  'if [[ -n "${FAKE_CALL_LOG:-}" ]]; then printf "curl %s\\n" "$*" >> "$FAKE_CALL_LOG"; fi',
  'output=""; url=""',
  "while [[ $# -gt 0 ]]; do",
  '  case "$1" in',
  '    --output|-o) output="$2"; shift 2 ;;',
  "    --connect-timeout|--max-time) shift 2 ;;",
  "    --fail|--silent|--show-error|--location) shift ;;",
  "    -*) printf 'curl: option %s: is unknown\\n' \"$1\" >&2; exit 2 ;;",
  '    *) url="$1"; shift ;;',
  "  esac",
  "done",
  'if [[ "$url" == file://* && -f "${url#file://}" ]]; then cp -- "${url#file://}" "$output"; exit 0; fi',
  "exit 22",
  "",
].join("\n");

const fakeCosignScript = [
  "#!/usr/bin/env bash",
  'if [[ "${1:-}" == "version" ]]; then [[ "${FAKE_COSIGN_UNUSABLE:-1}" == "0" ]] || exit 1; exit 0; fi',
  'if [[ "${1:-}" == "verify" || "${1:-}" == "verify-blob" ]]; then exit "${FAKE_COSIGN_VERIFY_EXIT:-0}"; fi',
  "exit 1",
  "",
].join("\n");

/** A fake bin whose docker is run through a wrapper, so `--env-file <path>` reaches the fake as an argument, as it reaches real docker. */
function makePasteBin() {
  const binDir = mkdtempSync(join(tmpdir(), "orbit-install-pastebin-"));
  writeFileSync(join(binDir, "docker.cjs"), fakeDockerScript);
  writeFileSync(join(binDir, "docker"), `#!/usr/bin/env bash\nexec node "${join(binDir, "docker.cjs")}" -- "$@"\n`);
  chmodSync(join(binDir, "docker"), 0o755);
  return binDir;
}

function makeFakeBin() {
  const binDir = mkdtempSync(join(tmpdir(), "orbit-install-fakebin-"));
  for (const [name, source] of [
    ["docker", fakeDockerScript],
    ["curl", fakeCurlScript],
    ["cosign", fakeCosignScript],
  ]) {
    writeFileSync(join(binDir, name), source);
    chmodSync(join(binDir, name), 0o755);
  }
  return binDir;
}

function makeTarget() {
  return mkdtempSync(join(tmpdir(), "orbit-install-target-"));
}

/** A local-only pre-provisioned target (guarantee #6): the unattended install path. */
function makePreprovisionedDeployment(targetDir, extraLines = []) {
  writeFileSync(
    join(targetDir, ".env-orbit"),
    ["APP_URL=https://orbit.preprovisioned-install.internal", "ORBIT_AUTH_OIDC=false", ...extraLines, ""].join("\n"),
    { mode: 0o600 },
  );
  mkdirSync(join(targetDir, ".orbit-secrets"), { mode: 0o700 });
  writeFileSync(join(targetDir, ".orbit-secrets", "oidc-client-secret"), "preprovisioned-oidc-secret", { mode: 0o600 });
}

function targetEntries(targetDir) {
  return readdirSync(targetDir).sort();
}

function stagingLeftovers(targetDir) {
  return readdirSync(targetDir).filter((name) => name.startsWith(".orbit-install-staging"));
}

function readOptional(path) {
  try {
    return readFileSync(path, "utf8");
  } catch (error) {
    if (error.code === "ENOENT") return "";
    throw error;
  }
}

function baseEnvironment(binDir, logDir) {
  return {
    PATH: `${binDir}:${process.env.PATH}`,
    HOME: process.env.HOME ?? tmpdir(),
    TERM: "xterm",
    ORBIT_REPOSITORY: repository,
    ORBIT_REGISTRY: registry,
    ORBIT_RELEASE_MANIFEST: releaseManifestPath,
    ORBIT_INSTALLER_READINESS_TIMEOUT_SECONDS: "2",
    ORBIT_INSTALLER_POLL_INTERVAL_SECONDS: "1",
    FAKE_DOCKER_REVISION: revision,
    FAKE_DOCKER_VERSION: "v1.2.0",
    FAKE_ASSETS_ROOT: assetsRoot,
    FAKE_CALL_LOG: join(logDir, "calls.log"),
    FAKE_ENGINE_LOG: join(logDir, "engine.log"),
    FAKE_STATE_DIR: logDir,
    // Keep the installer's private rollback copies out of the real home.
    XDG_STATE_HOME: join(logDir, "state"),
  };
}

function runInstall(targetDir, envOverrides = {}, args = []) {
  const binDir = makeFakeBin();
  const logDir = mkdtempSync(join(tmpdir(), "orbit-install-log-"));
  const result = failOnProcessDeadline(
    spawnSync("bash", [installScript, ...args], {
      cwd: targetDir,
      encoding: "utf8",
      env: { ...baseEnvironment(binDir, logDir), ...envOverrides },
      ...processGuard(),
    }),
    { label: "runInstall" },
  );
  return {
    ...result,
    calls: readOptional(join(logDir, "calls.log")),
    engineRuns: readOptional(join(logDir, "engine.log"))
      .split("\n")
      .filter(Boolean)
      .map((line) => JSON.parse(line)),
  };
}

/** Runs install.sh under `script`, so it has a controlling terminal, answering each prompt as it appears. */
function runInstallOnTerminal(targetDir, envOverrides = {}, interactions = [], args = []) {
  const binDir = makeFakeBin();
  const logDir = mkdtempSync(join(tmpdir(), "orbit-install-log-"));
  return new Promise((resolve, reject) => {
    const child = spawn("script", ["-qeE", "never", "-c", `bash ${installScript} ${args.join(" ")}`, "/dev/null"], {
      cwd: targetDir,
      env: { ...baseEnvironment(binDir, logDir), ...envOverrides },
    });
    let stdout = "";
    let stderr = "";
    let interactionIndex = 0;
    child.stdout.setEncoding("utf8");
    child.stderr.setEncoding("utf8");
    const watchdog = ptyWatchdog({ label: "runInstallOnTerminal", kill: () => child.kill("SIGKILL") });
    child.stdout.on("data", (chunk) => {
      stdout += chunk;
      watchdog.touch();
      // stdin stays open for the life of the child (docs/testing.md, "Local traps": pty tests).
      let interaction = interactions[interactionIndex];
      while (interaction && stdout.includes(interaction.after)) {
        child.stdin.write(interaction.input);
        interactionIndex += 1;
        interaction = interactions[interactionIndex];
      }
    });
    child.stderr.on("data", (chunk) => {
      stderr += chunk;
      watchdog.touch();
    });
    child.on("error", reject);
    child.on("close", (status, signal) => {
      watchdog.stop();
      if (watchdog.reason) {
        reject(watchdog.error({ stdout, stderr }));
        return;
      }
      resolve({
        status,
        signal,
        stdout,
        stderr,
        calls: readOptional(join(logDir, "calls.log")),
        engineRuns: readOptional(join(logDir, "engine.log"))
          .split("\n")
          .filter(Boolean)
          .map((line) => JSON.parse(line)),
        promptedInteractions: interactionIndex,
      });
    });
  });
}

function eventLines(output) {
  return output.split("\n").filter((line) => line.startsWith("phase="));
}

/** The recognised volume an update attaches to: one orbit-db, one orbit-app on the deployment's own image. */
function recognisedVolume(project, image = resolvedReference, dbId = "c".repeat(64), appId = "d".repeat(64)) {
  return {
    volume: `${project}_orbit-db-data`,
    ps: {
      [`volume=${project}_orbit-db-data`]: `${dbId}|${project}|orbit-db\n`,
      [`label=com.docker.compose.project=${project}`]: `${dbId}|${project}|orbit-db\n${appId}|${project}|orbit-app\n`,
    },
    images: { [appId]: image },
  };
}

describe("install.sh: arguments and settings, before anything runs", () => {
  it.each([[["--bogus"]], [["--install", "--update"]], [["extra"]]])("refuses %j as a usage error with no external call", (args) => {
    const targetDir = makeTarget();
    const result = runInstall(targetDir, {}, args);
    expect(result.status).toBe(2);
    expect(result.stderr).toContain("Usage:");
    expect(result.calls).toBe("");
  });

  it.each([
    ["ORBIT_INSTALLER_READINESS_TIMEOUT_SECONDS", "901", "must be between 1 and 900"],
    ["ORBIT_INSTALLER_READINESS_TIMEOUT_SECONDS", "0", "must be between 1 and 900"],
    ["ORBIT_INSTALLER_POLL_INTERVAL_SECONDS", "10", "must be between 1 and 9"],
    ["ORBIT_CHANNEL", "not a channel!", "ORBIT_CHANNEL is invalid"],
    ["ORBIT_REPOSITORY", "no-slash", "ORBIT_REPOSITORY is invalid"],
    ["ORBIT_REGISTRY", "bad registry", "ORBIT_REGISTRY is invalid"],
  ])("refuses %s=%s with exit 2 and no external call", (name, value, message) => {
    const result = runInstall(makeTarget(), { [name]: value });
    expect(result.status).toBe(2);
    expect(result.stderr).toContain(message);
    expect(result.calls).toBe("");
  });

  it("rejects hostile display identity overrides before any external call, without echoing them", () => {
    for (const overrides of [
      { ORBIT_CHANNEL: "latest\nSECRET=channel" },
      { ORBIT_REPOSITORY: "owner/repo\u001b[31m" },
      { ORBIT_REGISTRY: "registry.example\nSECRET=registry" },
    ]) {
      const targetDir = makeTarget();
      const result = runInstall(targetDir, overrides);
      expect(result.status).toBe(2);
      expect(result.calls).toBe("");
      expect(`${result.stdout}${result.stderr}`).not.toContain("SECRET=");
      expect(`${result.stdout}${result.stderr}`).not.toMatch(/\x1b\[/u);
      expect(targetEntries(targetDir)).toEqual([]);
    }
  });

  it("signposts --repair and exits 3 without touching Docker or the target (#533)", () => {
    const targetDir = makeTarget();
    const result = runInstall(targetDir, {}, ["--repair"]);
    expect(result.status).toBe(3);
    expect(result.stdout).toMatch(/^phase=rollback component=installer state=blocked reason=repair-unavailable action=repair elapsed=\d+s$/m);
    expect(result.stderr).toContain('Run "bash scripts/repair.sh --check" from this directory');
    expect(result.calls).toBe("");
    expect(targetEntries(targetDir)).toEqual([]);
  });

  it("refuses without Docker Compose v2", () => {
    const result = runInstall(makeTarget(), { FAKE_COMPOSE_MISSING: "1" });
    expect(result.status).toBe(1);
    expect(result.stderr).toContain("Docker Compose v2 is required.");
    expect(result.stdout).toMatch(/^phase=host component=host state=failed reason=docker-host action=retry/m);
    expect(result.calls).not.toContain("docker pull");
  });
});

describe("install.sh --simulate", () => {
  it("rejects --simulate combined with an installer action", () => {
    for (const action of ["--install", "--update", "--repair"]) {
      const result = runInstall(makeTarget(), {}, ["--simulate", action]);
      expect(result.status).toBe(2);
      expect(result.stderr).toContain("--simulate cannot be combined");
      expect(result.calls).toBe("");
    }
  });

  it("dispatches the plain simulation before any validation, without files or external calls", () => {
    const targetDir = makeTarget();
    writeFileSync(join(targetDir, "unrelated-file"), "not an Orbit deployment\n");
    const result = runInstall(targetDir, { ORBIT_CHANNEL: "not a valid channel" }, ["--plain", "--simulate"]);
    expect(result.status).toBe(0);
    expect(result.calls).toBe("");
    expect(targetEntries(targetDir)).toEqual(["unrelated-file"]);
    expect(result.stdout).toContain("simulation=true");
    expect(result.stdout).toContain("No deployment occurred.");
    expect(result.stdout).toContain("SIMULATED-DIGEST-NOT-REAL");
  });
});

describe("install.sh: the image's identity", () => {
  it("refuses a handed-over manifest path that is not a file", () => {
    const result = runInstall(makeTarget(), { ORBIT_RELEASE_MANIFEST: "/nonexistent/manifest.json" });
    expect(result.status).toBe(1);
    expect(result.stderr).toContain("ORBIT_RELEASE_MANIFEST does not point at a readable file");
    expect(result.calls).not.toContain("docker pull");
  });

  it("refuses a manifest that names no valid digest", () => {
    const dir = mkdtempSync(join(tmpdir(), "orbit-install-badmanifest-"));
    const manifest = join(dir, "manifest.json");
    writeFileSync(manifest, '{\n  "digest": "sha256:not-a-digest"\n}\n');
    const result = runInstall(makeTarget(), { ORBIT_RELEASE_MANIFEST: manifest });
    expect(result.status).toBe(1);
    expect(result.stderr).toContain("The release manifest names no valid image digest.");
    expect(result.calls).not.toContain("docker pull");
  });

  it("pulls by the manifest's digest and refuses when the pull fails", () => {
    const result = runInstall(makeTarget(), { FAKE_PULL_FAIL: "1" });
    expect(result.status).toBe(1);
    expect(result.calls).toContain(`docker pull --quiet ${resolvedReference}`);
    expect(result.stderr).toContain(`Could not pull ${resolvedReference}`);
    expect(result.stdout).toMatch(/^phase=identity component=image state=failed reason=image-registry action=retry/m);
  });

  it("refuses when the registry's digest does not match the manifest's", () => {
    const result = runInstall(makeTarget(), { FAKE_REPO_DIGEST: `${imageRepository}@sha256:${"e".repeat(64)}` });
    expect(result.status).toBe(1);
    expect(result.stderr).toContain("did not return an immutable digest matching");
    expect(result.engineRuns).toEqual([]);
  });

  it.each([
    ["RepoDigests", "Could not inspect fake-registry.example/example/orbit-fixture@sha256:"],
    ["org.opencontainers.image.revision", "for its source revision"],
  ])("reports a failed image inspection (%s) explicitly", (format, message) => {
    const result = runInstall(makeTarget(), { FAKE_INSPECT_FAIL: format });
    expect(result.status).toBe(1);
    expect(result.stderr).toContain(message);
    expect(result.engineRuns).toEqual([]);
  });

  it("installs a version tag whose image embeds that same version (#676)", () => {
    const targetDir = makeTarget();
    makePreprovisionedDeployment(targetDir);
    const result = runInstall(targetDir, { ORBIT_CHANNEL: "v1.3.0", FAKE_DOCKER_VERSION: "v1.3.0" }, ["--plain"]);
    expect(result.status).toBe(0);
    expect(result.stdout).toContain("Version: v1.3.0");
    expect(result.stdout).toContain("Channel: v1.3.0");
  });

  it("refuses an image that records no source revision", () => {
    const result = runInstall(makeTarget(), { FAKE_DOCKER_REVISION: "main" });
    expect(result.status).toBe(1);
    expect(result.stderr).toContain("does not record the source revision");
  });

  it("refuses a version label that is not a semantic version", () => {
    const result = runInstall(makeTarget(), { FAKE_DOCKER_VERSION: "preview-release-v1.0.0-1" });
    expect(result.status).toBe(1);
    expect(result.stderr).toContain("does not record a valid semantic version");
  });

  it("refuses a version tag whose image embeds a different version (#676)", () => {
    const result = runInstall(makeTarget(), { ORBIT_CHANNEL: "v1.3.0", ORBIT_RELEASE_MANIFEST: releaseManifestPath });
    expect(result.status).toBe(1);
    expect(result.stderr).toContain("does not match the requested version tag (v1.3.0)");
    expect(result.engineRuns).toEqual([]);
  });

  it("refuses, terminally, an image built before the deployment assets were bundled (#1038)", () => {
    const result = runInstall(makeTarget(), { FAKE_ASSETS_LABEL: "" });
    // Read from the label alone: such an image is never asked for its banner (#1016).
    expect(result.calls).not.toContain("--banner");
    expect(result.status).toBe(1);
    expect(result.stdout).toMatch(/^phase=identity component=image state=failed reason=image-registry action=abort/m);
    expect(result.stderr).toContain("is not a supported install target");
  });

  it("refuses an image that keeps its assets somewhere else", () => {
    const result = runInstall(makeTarget(), { FAKE_ASSETS_LABEL: "/elsewhere" });
    expect(result.status).toBe(1);
    expect(result.stderr).toContain("records deployment assets somewhere other than /opt/orbit/deploy");
  });

  it("refuses an image that cannot render its banner", () => {
    const result = runInstall(makeTarget(), { FAKE_BANNER_FAIL: "1" });
    expect(result.status).toBe(1);
    expect(result.stderr).toContain("could not render its canonical banner");
    expect(result.engineRuns).toEqual([]);
  });

  it("refuses an unsigned image on a stable channel when cosign is usable", () => {
    const result = runInstall(makeTarget(), { ORBIT_CHANNEL: "latest", FAKE_COSIGN_UNUSABLE: "0", FAKE_COSIGN_VERIFY_EXIT: "1" });
    expect(result.status).toBe(1);
    expect(result.stderr).toContain("cosign could not verify the countersignature");
    expect(result.engineRuns).toEqual([]);
  });

  it("continues on the preview channel without a countersignature, saying so", () => {
    const targetDir = makeTarget();
    makePreprovisionedDeployment(targetDir);
    const result = runInstall(targetDir, { ORBIT_CHANNEL: "preview", FAKE_COSIGN_UNUSABLE: "0", FAKE_COSIGN_VERIFY_EXIT: "1" });
    expect(result.status).toBe(0);
    expect(result.stderr).toContain("no countersignature yet");
  });
});

describe("install.sh: the engine run", () => {
  it("installs a pre-provisioned target: one engine run, then Compose, then the completion screen (#6)", () => {
    const targetDir = makeTarget();
    makePreprovisionedDeployment(targetDir);
    const result = runInstall(targetDir, {}, ["--plain"]);

    expect(result.stderr).toBe("");
    expect(result.status).toBe(0);
    expect(result.engineRuns).toHaveLength(1);
    // The engine committed the deployment from the image's assets.
    for (const asset of deploymentAssets) expect(existsSync(join(targetDir, asset))).toBe(true);
    expect(readFileSync(join(targetDir, ".env-orbit"), "utf8")).toContain(`ORBIT_IMAGE=${resolvedReference}\n`);
    expect(stagingLeftovers(targetDir)).toEqual([]);
    // Compose only after the engine, in the deployment's own project.
    const calls = result.calls.split("\n");
    const engineAt = calls.findIndex((line) => line.includes("/opt/orbit/cli/orbit.js install"));
    const configAt = calls.findIndex((line) => line.includes("config --quiet"));
    expect(engineAt).toBeGreaterThan(-1);
    expect(configAt).toBeGreaterThan(engineAt);
    expect(result.calls).toContain("docker compose --project-name orbit --env-file .env-orbit up -d --no-build --remove-orphans");
    expect(result.calls).toContain("compose --project-name orbit --env-file .env-orbit pull orbit-db");
    expect(result.calls).toContain("compose --project-name orbit --env-file .env-orbit pull orbit-clamav");
    expect(result.calls).not.toContain("pull orbit-tika");
    expect(result.stdout).toContain(preflightSuccessLine);
    expect(result.stdout).toContain("Orbit is ready.");
    expect(result.stdout).toContain("Public URL: https://orbit.preprovisioned-install.internal");
    expect(result.stdout).toContain("Version: v1.2.0");
    expect(result.stdout).toContain(`Revision: ${revision.slice(0, 12)}`);
    expect(result.stdout).toContain(`Image digest: sha256:${digest}`);
    expect(result.stdout).toContain("Optional profiles: standard");
    expect(result.stdout).toContain("Channel: latest");
    expect(result.stdout).toContain("Status: docker compose --env-file .env-orbit ps");
    expect(result.stdout).toContain("Logs: docker compose --env-file .env-orbit logs --tail 200");
    expect(result.stdout).toContain('Claim this instance: run "docker compose --env-file .env-orbit logs orbit-app"');
    // The image's own banner, from the digest reference, before the engine.
    expect(result.stdout).toContain("ORBIT FAKE BANNER");
    expect(result.calls).toContain(`docker run --rm --entrypoint /opt/orbit/scripts/container-entrypoint.sh ${resolvedReference} --banner`);
    // Compose validates, prepares the images and only then starts anything.
    const at = (needle) => calls.findIndex((line) => line.includes(needle));
    expect(at("pull orbit-db")).toBeGreaterThan(configAt);
    expect(at("pull orbit-clamav")).toBeGreaterThan(at("pull orbit-db"));
    expect(at(" up -d ")).toBeGreaterThan(at("pull orbit-clamav"));
    // Every event is in the plain vocabulary, the engine's included.
    const events = eventLines(result.stdout);
    for (const line of events) {
      expect(line).toMatch(/^phase=[a-z-]+ component=[a-z-]+ state=[a-z-]+ reason=[a-z-]+ action=[a-z-]+ elapsed=[0-9]+s$/);
    }
    expect(events.at(-1)).toMatch(/^phase=complete component=installer state=completed reason=deployment-ready action=complete/);
    // The shell's own phases are replayed and rendered in order around the engine's.
    const shellPhases = events
      .map((line) => line.split(" ")[0].slice("phase=".length))
      .filter((phase) => !["assets", "configuration", "oidc"].includes(phase));
    expect([...new Set(shellPhases)]).toEqual(["host", "identity", "compose", "preparation", "database", "application", "optional", "complete"]);
    expect(events.some((line) => line.startsWith("phase=assets component=assets state=completed"))).toBe(true);
    expect(events.some((line) => line.startsWith("phase=oidc component=oidc state=skipped"))).toBe(true);
  });

  it("runs the engine as a plain one-off of the verified image: no socket, default network, the target mounted, the operator's identity", () => {
    const targetDir = makeTarget();
    makePreprovisionedDeployment(targetDir);
    const result = runInstall(targetDir, {}, ["--install"]);
    expect(result.status).toBe(0);
    const [run] = result.engineRuns;
    expect(run.argv.slice(0, 3)).toEqual(["run", "--rm", "--init"]);
    expect(run.argv).not.toContain("--network");
    expect(run.argv).not.toContain("-t");
    expect(run.argv).not.toContain("-i");
    expect(run.argv.join(" ")).not.toContain("docker.sock");
    expect(run.argv).toContain(`${realPath(targetDir)}:/orbit-deploy:rw`);
    expect(run.image).toBe(resolvedReference);
    expect(run.rest).toEqual(["/opt/orbit/cli/orbit.js", "install", "--action", "install", "--dir", "/orbit-deploy", "--outcome", "/orbit-install-result/outcome"]);
    expect(run.env.ORBIT_IMAGE).toBe(resolvedReference);
    expect(run.env.ORBIT_HOST_UID).toBe(String(process.getuid()));
    expect(run.env.ORBIT_HOST_GID).toBe(String(process.getgid()));
    const facts = JSON.parse(run.env.ORBIT_INSTALL_HOST_FACTS);
    expect(facts).toMatchObject({ imageVersion: "v1.2.0", imageRevision: revision, appliedDigest: `sha256:${digest}`, cosignUsable: false });
    expect(Buffer.from(facts.targetBasename, "base64").toString()).toBe(basename(realPath(targetDir)));
  });

  it("passes the operator's root as 0:0 under rootless Docker", () => {
    // A canned engine: this test's own process is not root, so the real
    // engine could not hand files to uid 0.
    const result = runInstall(makeTarget(), { FAKE_ROOTLESS: "1", FAKE_ENGINE_EXIT: "1" });
    expect(result.engineRuns[0].env).toMatchObject({ ORBIT_HOST_UID: "0", ORBIT_HOST_GID: "0" });
  });

  it("stops before the engine when `docker info` fails, refusing to guess who should own the files (#1316 O1-R7)", () => {
    const targetDir = makeTarget();
    makePreprovisionedDeployment(targetDir);
    const result = runInstall(targetDir, { FAKE_INFO_FAIL: "1" }, ["--install"]);
    expect(result.status).not.toBe(0);
    expect(result.stderr).toMatch(/could not tell whether Docker is rootless/i);
    expect(result.stderr).toMatch(/refus\w* to guess/i);
    expect(result.engineRuns).toEqual([]);
    // The image banner one-off runs earlier and writes nothing; no other run.
    expect(result.calls.split("\n").filter((line) => line.startsWith("docker run ") && !line.endsWith(" --banner"))).toEqual([]);
    expect(result.calls).toContain("docker info");
  });

  it("hands stdin to the engine only for machine prompts", () => {
    const targetDir = makeTarget();
    makePreprovisionedDeployment(targetDir);
    const result = runInstall(targetDir, { ORBIT_CONFIGURE_PROMPTS: "machine" });
    expect(result.status).toBe(0);
    expect(result.engineRuns[0].argv).toContain("-i");
    expect(result.engineRuns[0].argv).not.toContain("-t");
    expect(result.engineRuns[0].env.ORBIT_INSTALL_INTERACTIVE).toBe("1");
  });

  it("describes every Orbit database volume on the host to the engine, which skips another project's on a fresh install (#1239)", () => {
    const targetDir = makeTarget();
    makePreprovisionedDeployment(targetDir);
    const other = recognisedVolume("someone-else", `${imageRepository}@sha256:${"f".repeat(64)}`);
    const result = runInstall(targetDir, {
      FAKE_VOLUMES: `${other.volume}\nunrelated-volume`,
      FAKE_PS: JSON.stringify(other.ps),
      FAKE_CONTAINER_IMAGES: JSON.stringify(other.images),
    });
    expect(result.status).toBe(0);
    const facts = JSON.parse(result.engineRuns[0].env.ORBIT_INSTALL_HOST_FACTS);
    expect(facts.volumes.map((volume) => Buffer.from(volume.name, "base64").toString())).toEqual([other.volume]);
    expect(Buffer.from(facts.volumes[0].labels, "base64").toString()).toBe("someone-else|orbit-db-data");
    expect(Buffer.from(facts.projects[0].name, "base64").toString()).toBe("someone-else");
    expect(Buffer.from(facts.images[0].image, "base64").toString()).toBe(other.images["d".repeat(64)]);
  });

  it("refuses a fresh install beside this install's own leftover volume, naming the removal command (#15)", () => {
    const targetDir = makeTarget();
    makePreprovisionedDeployment(targetDir);
    const result = runInstall(targetDir, { FAKE_VOLUMES: "orbit_orbit-db-data" });
    expect(result.status).toBe(1);
    expect(result.stderr).toContain("An existing Orbit database volume (orbit_orbit-db-data) requires a recognized deployment");
    expect(result.stderr).toContain("docker volume rm -- orbit_orbit-db-data");
    expect(result.calls).not.toContain(" up -d");
    expect(targetEntries(targetDir)).toEqual([".env-orbit", ".orbit-secrets"]);
  });

  it("fails closed when the volume listing itself fails", () => {
    const targetDir = makeTarget();
    makePreprovisionedDeployment(targetDir);
    const result = runInstall(targetDir, { FAKE_VOLUME_LS_FAIL: "1" });
    expect(result.status).toBe(1);
    expect(result.stderr).toContain("Could not verify the existing Orbit database volume; refusing to start Compose.");
  });

  it("updates beside another stack's database volume, attaching to its own and re-checking it before Compose (#1261, #17)", () => {
    const targetDir = makeTarget();
    makePreprovisionedDeployment(targetDir);
    expect(runInstall(targetDir).status).toBe(0);
    const own = recognisedVolume("orbit");
    const other = recognisedVolume("orbit-e2e-local-4242", `${imageRepository}@sha256:${"f".repeat(64)}`, "1".repeat(64), "2".repeat(64));
    const passwordBefore = readFileSync(join(targetDir, ".orbit-secrets", "postgres-password"));
    const environment = {
      FAKE_VOLUMES: `${other.volume}\n${own.volume}`,
      FAKE_PS: JSON.stringify({ ...own.ps, ...other.ps }),
      FAKE_CONTAINER_IMAGES: JSON.stringify({ ...own.images, ...other.images }),
    };

    const result = runInstall(targetDir, environment, ["--update"]);

    expect(result.stderr).toBe("");
    expect(result.status).toBe(0);
    expect(result.calls).toContain("docker volume ls --filter name=^orbit_orbit-db-data$ --format {{.Name}}");
    expect(readFileSync(join(targetDir, ".orbit-secrets", "postgres-password"))).toEqual(passwordBefore);

    // The same update refuses when the recognised volume vanished after the engine ran.
    const gone = runInstall(targetDir, { ...environment, FAKE_VOLUME_GONE: "1" }, ["--update"]);
    expect(gone.status).toBe(1);
    expect(gone.stderr).toContain("The existing Orbit database volume changed during installation; refusing to start Compose.");
    expect(gone.calls).not.toContain(" up -d");
  });
});

describe("install.sh: the engine's outcome", () => {
  it("emits the engine's failure as the terminal event, after the engine rolled the target back", () => {
    const targetDir = makeTarget();
    makePreprovisionedDeployment(targetDir);
    writeFileSync(join(targetDir, ".env-orbit"), "ORBIT_AUTH_OIDC=false\n", { mode: 0o600 });
    const result = runInstall(targetDir);
    expect(result.status).toBe(1);
    expect(result.stdout).toMatch(/^phase=configuration component=configuration state=failed reason=configuration-failure action=retry elapsed=\d+s$/m);
    expect(result.stderr).toContain("Orbit installer: configuration fields requiring attention: APP_URL.");
    expect(result.stderr).toContain("Orbit installer: Required configuration fields require attention; refusing to start Compose.");
    expect(result.calls).not.toContain("compose --project-name");
    expect(targetEntries(targetDir)).toEqual([".env-orbit", ".orbit-secrets"]);
    expect(readFileSync(join(targetDir, ".env-orbit"), "utf8")).toBe("ORBIT_AUTH_OIDC=false\n");
  });

  it("names docker run's exit status when the engine died without a result", () => {
    const result = runInstall(makeTarget(), { FAKE_ENGINE_EXIT: "137" });
    expect(result.status).toBe(1);
    expect(result.stderr).toContain("The install engine stopped without reporting a result (docker run exit status 137)");
    expect(result.stdout).toMatch(/state=failed reason=failure action=retry/);
  });

  it.each([
    ["an unknown key", "status=ok\nsurprise=1\n"],
    ["an unknown status", "status=maybe\n"],
    ["a message with a control character", "status=failed\nmessage=a\u0007b\n"],
  ])("treats an outcome with %s as no result", (_label, outcome) => {
    const result = runInstall(makeTarget(), { FAKE_ENGINE_EXIT: "1", FAKE_ENGINE_OUTCOME: outcome });
    expect(result.status).toBe(1);
    expect(result.stderr).toContain("stopped without reporting a result (docker run exit status 1)");
  });

  it.each([
    [130, "status=stopped\nmessage=Cancelled; no deployment files or services were changed.\n"],
    [1, "status=stopped\nmessage=The terminal closed before an answer was given.\n"],
    [2, "status=stopped\nmessage=refused\n"],
  ])("passes a stopped engine's exit %i through, starting nothing", (code, outcome) => {
    const result = runInstall(makeTarget(), { FAKE_ENGINE_EXIT: String(code), FAKE_ENGINE_OUTCOME: outcome });
    expect(result.status).toBe(code);
    expect(result.calls).not.toContain("compose --project-name");
  });

  it("exits 3 for the engine's Repair choice", () => {
    const result = runInstall(makeTarget(), { FAKE_ENGINE_EXIT: "3", FAKE_ENGINE_OUTCOME: "status=repair\n" });
    expect(result.status).toBe(3);
    expect(result.calls).not.toContain("compose --project-name");
  });

  it("refuses a success outcome from an engine that exited non-zero", () => {
    const result = runInstall(makeTarget(), {
      FAKE_ENGINE_EXIT: "1",
      FAKE_ENGINE_OUTCOME: "status=ok\nfresh=1\nprofile=standard\nmodel-pull=0\ndatabase-volume=\n",
    });
    expect(result.status).toBe(1);
    expect(result.stderr).toContain("reported success but exited with status 1");
  });
});

describe("install.sh: the launcher's configure tree (#1225)", () => {
  function launcherTree() {
    const tree = join(mkdtempSync(join(tmpdir(), "orbit-install-launcher-")), "tree");
    mkdirSync(tree, { mode: 0o700 });
    chmodSync(tree, 0o700);
    return tree;
  }

  it("mounts the launcher's directory into the engine, which writes the tree on a configuration-failure", () => {
    const targetDir = makeTarget();
    makePreprovisionedDeployment(targetDir);
    writeFileSync(join(targetDir, ".env-orbit"), "ORBIT_AUTH_OIDC=false\n", { mode: 0o600 });
    const tree = launcherTree();
    const result = runInstall(targetDir, { ORBIT_LAUNCHER_CONFIG_TREE: `${tree}/` });
    expect(result.status).toBe(1);
    expect(result.engineRuns[0].argv).toContain(`${realPath(tree)}:/orbit-launcher-config-tree:rw`);
    expect(readdirSync(tree).sort()).toEqual([".env-orbit.example", ".orbit-image", "scripts"]);
    expect(readFileSync(join(tree, ".orbit-image"), "utf8")).toBe(`${resolvedReference}\n`);
    expect(statSync(join(tree, "scripts", "configure.sh")).mode & 0o777).toBe(0o600);
  });

  it.each([
    ["a symlink", (parent) => {
      const real = join(parent, "real");
      mkdirSync(real, { mode: 0o700 });
      symlinkSync(real, join(parent, "link"));
      return join(parent, "link");
    }, "it is a symlink"],
    ["a symlink given with a trailing slash", (parent) => {
      const real = join(parent, "real");
      mkdirSync(real, { mode: 0o700 });
      symlinkSync(real, join(parent, "link"));
      return `${join(parent, "link")}//`;
    }, "it is a symlink"],
    ["missing", (parent) => join(parent, "absent"), "it does not exist"],
    ["a file", (parent) => {
      writeFileSync(join(parent, "file"), "x");
      return join(parent, "file");
    }, "it is not a directory"],
  ])("tells the engine why it could not mount a directory that is %s, and the engine says so once", (_label, arrange, reason) => {
    const targetDir = makeTarget();
    makePreprovisionedDeployment(targetDir);
    writeFileSync(join(targetDir, ".env-orbit"), "ORBIT_AUTH_OIDC=false\n", { mode: 0o600 });
    const tree = arrange(mkdtempSync(join(tmpdir(), "orbit-install-launcher-")));
    const result = runInstall(targetDir, { ORBIT_LAUNCHER_CONFIG_TREE: tree });
    expect(result.status).toBe(1);
    expect(result.engineRuns[0].env.ORBIT_LAUNCHER_CONFIG_TREE_UNAVAILABLE).toBe(reason);
    expect(result.stderr.split("\n").filter((line) => line.includes("ORBIT_LAUNCHER_CONFIG_TREE"))).toEqual([
      `Orbit installer: ORBIT_LAUNCHER_CONFIG_TREE was not written because ${reason}.`,
    ]);
  });

  it("passes nothing about a tree the launcher did not ask for", () => {
    const targetDir = makeTarget();
    makePreprovisionedDeployment(targetDir);
    const result = runInstall(targetDir, { ORBIT_LAUNCHER_CONFIG_TREE: "" });
    expect(result.status).toBe(0);
    expect(Object.keys(result.engineRuns[0].env).filter((key) => key.startsWith("ORBIT_LAUNCHER"))).toEqual([]);
  });
});

describe("install.sh: Compose, after the commit", () => {
  function installed(extra = {}) {
    const targetDir = makeTarget();
    makePreprovisionedDeployment(targetDir);
    return { targetDir, result: runInstall(targetDir, extra) };
  }

  it("reports an invalid Compose configuration as a plain failure, never a reconfigure, and starts nothing (#1227)", () => {
    const { targetDir, result } = installed({ FAKE_COMPOSE_CONFIG_FAIL: "1" });
    expect(result.status).toBe(1);
    expect(result.stdout).toMatch(/^phase=compose component=compose state=failed reason=failure action=retry/m);
    expect(result.stderr).toContain("Docker Compose configuration is invalid");
    expect(result.calls).not.toContain(" up -d");
    // A fresh install rolls back (#1456): the folder holds only what it started with.
    expect(existsSync(join(targetDir, "docker-compose.yml"))).toBe(false);
    expect(targetEntries(targetDir)).toEqual([".env-orbit", ".orbit-secrets"]);
  });

  it("refuses when a service image cannot be prepared", () => {
    const { result } = installed({ FAKE_COMPOSE_PULL_FAIL: "orbit-clamav" });
    expect(result.status).toBe(1);
    expect(result.stdout).toMatch(/^phase=preparation component=clamav state=failed reason=image-registry action=retry/m);
    expect(result.stderr).toContain("Could not prepare the private scanner image.");
  });

  it("tears a failed fresh start down and removes only this project's own volume, by its exact name (#1207)", () => {
    const { result } = installed({ FAKE_COMPOSE_UP_FAIL: "1", FAKE_VOLUMES: "" });
    expect(result.status).toBe(1);
    expect(result.calls).toContain("compose --project-name orbit --env-file .env-orbit down --remove-orphans");
    expect(result.calls).toContain("docker volume ls --filter name=orbit_orbit- --format {{.Name}}");
    expect(result.stdout).toMatch(/^phase=preparation component=compose state=failed reason=docker-host action=retry/m);
    expect(result.stderr).toContain("This install was rolled back");
  });

  it("bounds the database wait and points at repair", () => {
    const { result } = installed({ FAKE_PROBE_FAIL: "orbit-db" });
    expect(result.status).toBe(1);
    expect(result.stdout).toMatch(/^phase=database component=database state=failed reason=database-auth-migration action=repair/m);
    expect(result.stdout).toMatch(/^phase=database component=database state=waiting reason=database-health action=wait/m);
  });

  it("tells a running application that never reported ready from one that stopped", () => {
    const { result } = installed({ FAKE_PROBE_FAIL: "orbit-app", FAKE_CONTAINERS: JSON.stringify({ "orbit-app": { status: "exited", exitCode: 1 } }) });
    expect(result.status).toBe(1);
    expect(result.stdout).toMatch(/reason=application-startup action=retry/);
  });

  it("bounds the optional scanner's wait", () => {
    const { result } = installed({ FAKE_PROBE_FAIL: "orbit-clamav" });
    expect(result.status).toBe(0);
    expect(result.stdout).toMatch(/^phase=optional component=clamav state=waiting reason=optional-status action=continue/m);
    expect(result.stdout).toContain("Scanner: still starting");
  });

  it("pulls the confirmed local model after Ollama is healthy (guarantee #20)", () => {
    const targetDir = makeTarget();
    makePreprovisionedDeployment(targetDir);
    expect(runInstall(targetDir).status).toBe(0);
    // The model the engine's profile wizard saved, and a second run whose
    // engine reports the separately confirmed download.
    appendFileSync(join(targetDir, ".env-orbit"), "OLLAMA_MODEL=llama3.2:1b\n");
    const result = runInstall(targetDir, {
      FAKE_ENGINE_EXIT: "0",
      FAKE_ENGINE_OUTCOME: "status=ok\nfresh=0\nprofile=ai\nmodel-pull=1\ndatabase-volume=\n",
    });
    expect(result.status).toBe(0);
    expect(result.calls).toContain("compose --project-name orbit --env-file .env-orbit pull orbit-ollama");
    expect(result.calls).toContain("compose --project-name orbit --env-file .env-orbit --profile ai-model-pull run --rm -T --name orbit-orbit-ollama-model-pull-install orbit-ollama-model-pull");
    expect(result.calls).not.toContain("ollama pull");
    expect(result.stdout).toContain("Optional profiles: ai");
  });
});

describe("install.sh on a terminal", () => {
  it("passes the terminal through to the engine, which asks, and leaves on Exit with 130 having started nothing", async () => {
    const targetDir = makeTarget();
    const result = await runInstallOnTerminal(targetDir, {}, [{ after: "Choose [install/update/repair/exit]", input: "4\r" }]);
    expect(result.promptedInteractions).toBe(1);
    expect(result.status).toBe(130);
    expect(result.engineRuns[0].argv).toEqual(expect.arrayContaining(["-i", "-t"]));
    expect(result.engineRuns[0].env.ORBIT_INSTALL_INTERACTIVE).toBe("1");
    expect(result.calls).not.toContain("compose --project-name");
    expect(targetEntries(targetDir)).toEqual([]);
  }, PTY_TEST_TIMEOUT_MS);
});

// ADR-0031 #7: install.sh fetching and verifying its own release manifest
// when no caller handed one over.
describe("install.sh release manifest (ADR-0031 #7)", () => {
  function generateKeyPair(dir, name = "key") {
    const privatePem = join(dir, `${name}.pem`);
    const publicPem = join(dir, `${name}.pub.pem`);
    execFileSync("openssl", ["ecparam", "-name", "prime256v1", "-genkey", "-noout", "-out", privatePem]);
    execFileSync("openssl", ["ec", "-in", privatePem, "-pubout", "-out", publicPem], { stdio: ["ignore", "ignore", "ignore"] });
    return { privatePem, publicPem };
  }

  function buildSelfFetchFixture(dir, privatePem, overrides = {}, route = ["releases", "latest", "download"]) {
    const assetsDir = join(dir, ...route);
    mkdirSync(assetsDir, { recursive: true });
    const manifest = {
      schema: "https://tomlawson.io/schemas/orbit-release-manifest/v1",
      version: "v1.2.0",
      channel: "latest",
      commit: revision,
      image: { repository: imageRepository, digest: `sha256:${digest}` },
      launcher: { tag: "v1.0.0", commit: revision },
      files: {},
      recordedAt: "2026-09-24T00:00:00Z",
      ...overrides,
    };
    const manifestPath = join(assetsDir, "orbit-release-manifest.json");
    writeFileSync(manifestPath, JSON.stringify(manifest, null, 2));
    writeFileSync(
      join(assetsDir, "orbit-release-manifest.json.sig"),
      execFileSync("openssl", ["dgst", "-sha256", "-sign", privatePem, manifestPath]).toString("base64"),
    );
    return `file://${dir}`;
  }

  function selfFetch(extra = {}, overrides = {}, route = undefined) {
    const dir = mkdtempSync(join(tmpdir(), "orbit-install-selffetch-"));
    const { privatePem, publicPem } = generateKeyPair(dir);
    const baseUrl = buildSelfFetchFixture(dir, privatePem, overrides, route);
    return {
      ORBIT_RELEASE_MANIFEST: "",
      ORBIT_INSTALL_TEST_MANIFEST_BASE_URL: baseUrl,
      ORBIT_INSTALL_TEST_PUBLIC_KEY_FILE: publicPem,
      ORBIT_INSTALL_TEST_ALLOW_KEY_OVERRIDE: "1",
      ...extra,
    };
  }

  it("embeds the same cosign public key as get-orbit.sh and cosign.pub, byte for byte", () => {
    const cosignPub = readFileSync(fileURLToPath(new URL("../cosign.pub", import.meta.url)), "utf8");
    const match = /embedded_public_key='([\s\S]*?)'/u.exec(readFileSync(installScript, "utf8"));
    expect(`${match[1]}\n`).toBe(cosignPub);
  });

  it("fetches and verifies its own manifest, then removes its temporary directory (#1201)", () => {
    const targetDir = makeTarget();
    makePreprovisionedDeployment(targetDir);
    const privateTmpDir = mkdtempSync(join(tmpdir(), "orbit-install-selffetch-tmpdir-"));
    const result = runInstall(targetDir, selfFetch({ TMPDIR: privateTmpDir }));
    expect(result.stderr).toBe("");
    expect(result.status).toBe(0);
    expect(result.engineRuns[0].image).toBe(resolvedReference);
    expect(readdirSync(privateTmpDir)).toEqual([]);
  });

  it("refuses a manifest signed by the wrong key, before any pull", () => {
    const env = selfFetch();
    const dir = mkdtempSync(join(tmpdir(), "orbit-install-selffetch-other-"));
    env.ORBIT_INSTALL_TEST_PUBLIC_KEY_FILE = generateKeyPair(dir, "committed").publicPem;
    const result = runInstall(makeTarget(), env);
    expect(result.status).toBe(1);
    expect(result.stderr).toContain("Could not verify the release manifest's signature");
    expect(result.calls).not.toContain("docker pull");
  });

  it("refuses a validly signed manifest for another version than the pinned channel", () => {
    const result = runInstall(makeTarget(), selfFetch({ ORBIT_CHANNEL: "v1.2.0" }, { version: "v1.0.0" }, ["releases", "download", "v1.2.0"]));
    expect(result.status).toBe(1);
    expect(result.stderr).toContain("Asked for v1.2.0 but the signed release manifest is for v1.0.0");
    expect(result.calls).not.toContain("docker pull");
  });

  // #1378: the manifest comes from the real scripts/ci/write-release-manifest.sh
  // (run in a scratch copy of its tree, as scripts/ci/write-release-manifest.test.mjs
  // does), never hand-built, so the installer and its producer cannot drift on
  // what "version" holds. Signed with a throwaway key like selfFetch's.
  function realWriterManifest(label) {
    const work = mkdtempSync(join(tmpdir(), "orbit-install-realwriter-"));
    const scriptDir = join(work, "scripts", "ci");
    mkdirSync(scriptDir, { recursive: true });
    for (const [from, to] of [
      ["ci/write-release-manifest.sh", join(scriptDir, "write-release-manifest.sh")],
      ["ci/channel-name.sh", join(scriptDir, "channel-name.sh")],
      ["release-metadata-patterns.sh", join(work, "scripts", "release-metadata-patterns.sh")],
    ]) {
      copyFileSync(fileURLToPath(new URL(from, import.meta.url)), to);
    }
    const inputs = {};
    for (const name of ["amd64.tar.gz", "arm64.tar.gz", "install.sh", "get-orbit.sh"]) {
      inputs[name] = join(work, name);
      writeFileSync(inputs[name], `${name} fixture bytes`);
    }
    execFileSync("bash", [join(scriptDir, "write-release-manifest.sh"), imageRepository, `sha256:${digest}`], {
      env: {
        PATH: process.env.PATH,
        CI_COMMIT_SHA: revision,
        CI_COMMIT_BRANCH: "preview",
        ORBIT_VERSION: label,
        ORBIT_LAUNCHER_TAG: "v1.0.0",
        ORBIT_LAUNCHER_COMMIT: revision,
        ORBIT_LAUNCHER_AMD64_ARCHIVE: inputs["amd64.tar.gz"],
        ORBIT_LAUNCHER_ARM64_ARCHIVE: inputs["arm64.tar.gz"],
        ORBIT_INSTALL_SCRIPT: inputs["install.sh"],
        ORBIT_GET_ORBIT_SCRIPT: inputs["get-orbit.sh"],
      },
      stdio: ["ignore", "ignore", "pipe"],
    });
    return join(work, ".orbit-supply-chain", "orbit-release-manifest.json");
  }

  function selfFetchRealWriter(label, route, extra = {}) {
    const dir = mkdtempSync(join(tmpdir(), "orbit-install-selffetch-real-"));
    const { privatePem, publicPem } = generateKeyPair(dir);
    const assetsDir = join(dir, ...route);
    mkdirSync(assetsDir, { recursive: true });
    const manifestPath = join(assetsDir, "orbit-release-manifest.json");
    copyFileSync(realWriterManifest(label), manifestPath);
    writeFileSync(
      join(assetsDir, "orbit-release-manifest.json.sig"),
      execFileSync("openssl", ["dgst", "-sha256", "-sign", privatePem, manifestPath]).toString("base64"),
    );
    return {
      ORBIT_RELEASE_MANIFEST: "",
      ORBIT_INSTALL_TEST_MANIFEST_BASE_URL: `file://${dir}`,
      ORBIT_INSTALL_TEST_PUBLIC_KEY_FILE: publicPem,
      ORBIT_INSTALL_TEST_ALLOW_KEY_OVERRIDE: "1",
      ...extra,
    };
  }

  it("accepts a version-pinned install whose signed manifest, from the real writer, is for that version (#1378)", () => {
    const targetDir = makeTarget();
    makePreprovisionedDeployment(targetDir);
    const result = runInstall(
      targetDir,
      selfFetchRealWriter("v0.3.0", ["releases", "download", "v0.3.0"], { ORBIT_CHANNEL: "v0.3.0", FAKE_DOCKER_VERSION: "v0.3.0" }),
      ["--plain"],
    );
    expect(result.stderr).not.toContain("Asked for");
    expect(result.status).toBe(0);
    expect(result.engineRuns[0].image).toBe(resolvedReference);
  });

  it("refuses a version-pinned install whose real-writer manifest is for another version, naming both (#1378)", () => {
    const result = runInstall(
      makeTarget(),
      selfFetchRealWriter("v0.3.1", ["releases", "download", "v0.3.0"], { ORBIT_CHANNEL: "v0.3.0", FAKE_DOCKER_VERSION: "v0.3.0" }),
    );
    expect(result.status).toBe(1);
    expect(result.stderr).toContain("v0.3.0");
    expect(result.stderr).toContain("v0.3.1");
    expect(result.stderr).not.toContain("vv0.3");
    expect(result.calls).not.toContain("docker pull");
  });

  it("does not apply the pinned-version check on the stable channel, with a real-writer manifest (#1378)", () => {
    const targetDir = makeTarget();
    makePreprovisionedDeployment(targetDir);
    const result = runInstall(
      targetDir,
      selfFetchRealWriter("v0.3.0", ["releases", "latest", "download"], { ORBIT_CHANNEL: "latest", FAKE_DOCKER_VERSION: "v0.3.0" }),
      ["--plain"],
    );
    expect(result.stderr).not.toContain("Asked for");
    expect(result.status).toBe(0);
  });

  it("does not apply the pinned-version check on the preview channel, with a handed-over real-writer manifest (#1378)", () => {
    const targetDir = makeTarget();
    makePreprovisionedDeployment(targetDir);
    const result = runInstall(
      targetDir,
      { ORBIT_CHANNEL: "preview", ORBIT_RELEASE_MANIFEST: realWriterManifest("v0.3.0"), FAKE_DOCKER_VERSION: "v0.3.0" },
      ["--plain"],
    );
    expect(result.stderr).not.toContain("Asked for");
    expect(result.status).toBe(0);
  });

  it("refuses ORBIT_CHANNEL=preview without a handed-over manifest, fetching nothing (#1107)", () => {
    const result = runInstall(makeTarget(), { ORBIT_CHANNEL: "preview", ORBIT_RELEASE_MANIFEST: "" });
    expect(result.status).toBe(1);
    expect(result.stderr).toContain("only installs stable releases");
    expect(result.calls).not.toContain("curl");
    expect(result.calls).not.toContain("docker pull");
  });

  it("refuses to swap the trusted key without the second test-only flag", () => {
    const result = runInstall(makeTarget(), selfFetch({ ORBIT_INSTALL_TEST_ALLOW_KEY_OVERRIDE: "" }));
    expect(result.status).toBe(1);
    expect(result.stderr).toContain("refusing to swap the trust anchor");
  });
});

// Cases the bash-era suite held that sit at the seam between this script and
// the engine (docs/adr-notes/1212-bash-test-retirement.md).
describe("install.sh: identity, volumes and readiness across the seam", () => {
  it("hands an operator's COMPOSE_PROJECT_NAME to the engine, which persists it, and Compose uses it", () => {
    const targetDir = makeTarget();
    makePreprovisionedDeployment(targetDir);
    const result = runInstall(targetDir, { COMPOSE_PROJECT_NAME: "fresh-orbit" });
    expect(result.status).toBe(0);
    expect(result.engineRuns[0].argv).toEqual(expect.arrayContaining(["-e", "COMPOSE_PROJECT_NAME"]));
    expect(readFileSync(join(targetDir, ".env-orbit"), "utf8")).toMatch(/^COMPOSE_PROJECT_NAME=fresh-orbit$/m);
    expect(result.calls).toContain("docker compose --project-name fresh-orbit --env-file .env-orbit up -d");
  });

  it("still refuses a fresh install on its own project's volume when others are present, naming only its own (#1239)", () => {
    const targetDir = makeTarget();
    makePreprovisionedDeployment(targetDir);
    const result = runInstall(targetDir, { FAKE_VOLUMES: "someone-else_orbit-db-data\norbit_orbit-db-data" });
    expect(result.status).toBe(1);
    expect(result.stderr).toContain("An existing Orbit database volume (orbit_orbit-db-data) requires a recognized deployment");
    expect(result.stderr).not.toContain("someone-else");
  });

  it("removes the database volume a failed fresh start created, and only that one, by exact name (#1151 O1-S3, #1207)", () => {
    const targetDir = makeTarget();
    makePreprovisionedDeployment(targetDir);
    const other = recognisedVolume("someone-else", `${imageRepository}@sha256:${"f".repeat(64)}`);
    const result = runInstall(targetDir, {
      FAKE_COMPOSE_UP_FAIL: "1",
      FAKE_UP_CREATES_VOLUME: "1",
      FAKE_VOLUMES: other.volume,
      FAKE_PS: JSON.stringify(other.ps),
      FAKE_CONTAINER_IMAGES: JSON.stringify(other.images),
    });
    expect(result.status).toBe(1);
    const removals = result.calls.split("\n").filter((line) => line.startsWith("docker volume rm"));
    expect(removals).toEqual(["docker volume rm -- orbit_orbit-db-data"]);
  });

  it("never removes a database volume when an update's start fails", () => {
    const targetDir = makeTarget();
    makePreprovisionedDeployment(targetDir);
    expect(runInstall(targetDir).status).toBe(0);
    const own = recognisedVolume("orbit");
    const result = runInstall(
      targetDir,
      { FAKE_COMPOSE_UP_FAIL: "1", FAKE_VOLUMES: own.volume, FAKE_PS: JSON.stringify(own.ps), FAKE_CONTAINER_IMAGES: JSON.stringify(own.images) },
      ["--update"],
    );
    expect(result.status).toBe(1);
    expect(result.calls).not.toContain("volume rm");
    expect(result.calls).not.toContain(" down ");
  });

  it("asks Docker about stopped containers too when proving a volume is this deployment's", () => {
    const targetDir = makeTarget();
    makePreprovisionedDeployment(targetDir);
    expect(runInstall(targetDir).status).toBe(0);
    const own = recognisedVolume("orbit");
    const result = runInstall(
      targetDir,
      { FAKE_VOLUMES: own.volume, FAKE_PS: JSON.stringify(own.ps), FAKE_CONTAINER_IMAGES: JSON.stringify(own.images) },
      ["--update"],
    );
    expect(result.status).toBe(0);
    expect(result.calls).toContain("docker ps -a --filter volume=orbit_orbit-db-data");
    expect(result.calls).toContain("docker ps -a --filter label=com.docker.compose.project=orbit");
  });

  it("adds the scripts a recognised older deployment lacks", () => {
    const targetDir = makeTarget();
    makePreprovisionedDeployment(targetDir);
    expect(runInstall(targetDir).status).toBe(0);
    rmSync(join(targetDir, "scripts", "backup.sh"));
    rmSync(join(targetDir, "scripts", "restore.sh"));
    const result = runInstall(targetDir, {}, ["--update"]);
    expect(result.status).toBe(0);
    expect(readFileSync(join(targetDir, "scripts", "backup.sh"))).toEqual(readFileSync(join(assetsRoot, "scripts", "backup.sh")));
    expect(readFileSync(join(targetDir, "scripts", "restore.sh"))).toEqual(readFileSync(join(assetsRoot, "scripts", "restore.sh")));
  });

  it("waits through a transient database and application start before completing", () => {
    const targetDir = makeTarget();
    makePreprovisionedDeployment(targetDir);
    const result = runInstall(targetDir, {
      ORBIT_INSTALLER_READINESS_TIMEOUT_SECONDS: "20",
      FAKE_PROBE_FAIL_TIMES: JSON.stringify({ "orbit-db": 1, "orbit-app": 2 }),
    });
    expect(result.status).toBe(0);
    expect(result.stdout).toMatch(/^phase=database component=database state=waiting reason=database-health action=wait/m);
    expect(result.stdout).toMatch(/^phase=application component=application state=waiting reason=application-health action=wait/m);
    const events = eventLines(result.stdout);
    expect(events.findIndex((line) => line.startsWith("phase=application component=application state=healthy"))).toBeLessThan(
      events.findIndex((line) => line.startsWith("phase=complete")),
    );
  });

  it("withholds completion with a bounded health-timeout when the application runs but never reports ready", () => {
    const targetDir = makeTarget();
    makePreprovisionedDeployment(targetDir);
    const result = runInstall(targetDir, { FAKE_PROBE_FAIL: "orbit-app", FAKE_CONTAINERS: JSON.stringify({ "orbit-app": { status: "running", health: "starting" } }) });
    expect(result.status).toBe(1);
    expect(result.stdout).toMatch(/^phase=application component=application state=failed reason=health-timeout action=repair/m);
    expect(result.stderr).toMatch(/Orbit did not report ready within \d+ s; it is left running/);
    expect(result.stdout).not.toContain("Orbit is ready.");
  });

  it.each([
    ["processing", "orbit-tika", "The selected document-processing service did not become healthy"],
    ["ai", "orbit-ollama", "The selected local-model service did not become healthy"],
  ])("prepares the %s profile's service and fails its bounded wait with a stable reason", (profile, service, message) => {
    const targetDir = makeTarget();
    makePreprovisionedDeployment(targetDir);
    expect(runInstall(targetDir).status).toBe(0);
    const result = runInstall(targetDir, {
      FAKE_ENGINE_EXIT: "0",
      FAKE_ENGINE_OUTCOME: `status=ok\nfresh=0\nprofile=${profile}\nmodel-pull=0\ndatabase-volume=\n`,
      FAKE_PROBE_FAIL: service,
    });
    expect(result.status).toBe(1);
    expect(result.calls).toContain(`pull ${service}`);
    expect(result.stdout).toMatch(new RegExp(`^phase=optional component=${service.slice("orbit-".length)} state=failed reason=optional-unavailable action=repair`, "m"));
    expect(result.stderr).toContain(message);
  });

  it("reports a completion-screen failure after the commit as reason=failure (#1227)", () => {
    const targetDir = makeTarget();
    makePreprovisionedDeployment(targetDir);
    expect(runInstall(targetDir).status).toBe(0);
    const environment = readFileSync(join(targetDir, ".env-orbit"), "utf8").replace(/^APP_URL=.*\n/m, "");
    writeFileSync(join(targetDir, ".env-orbit"), environment, { mode: 0o600 });
    const tree = join(mkdtempSync(join(tmpdir(), "orbit-install-launcher-")), "tree");
    mkdirSync(tree, { mode: 0o700 });
    const result = runInstall(targetDir, {
      FAKE_ENGINE_EXIT: "0",
      FAKE_ENGINE_OUTCOME: "status=ok\nfresh=0\nprofile=standard\nmodel-pull=0\ndatabase-volume=\n",
      ORBIT_LAUNCHER_CONFIG_TREE: tree,
    });
    expect(result.status).toBe(1);
    expect(result.stdout).toMatch(/state=failed reason=failure action=retry/);
    expect(result.stderr).toContain("The validated public URL could not be read for completion.");
    expect(readdirSync(tree)).toEqual([]);
  });
});

describe("install.sh: the UI helper it sources after the commit (guarantee #5)", () => {
  it.each([
    ["a symlink", (path) => {
      rmSync(path);
      symlinkSync(join(assetsRoot, "scripts", "installer-ui.sh"), path);
    }],
    ["not valid bash", (path) => writeFileSync(path, "installer_ui_init() {\n")],
  ])("refuses to source a committed installer-ui.sh that is %s, and starts nothing", (_label, damage) => {
    const targetDir = makeTarget();
    makePreprovisionedDeployment(targetDir);
    expect(runInstall(targetDir).status).toBe(0);
    damage(join(targetDir, "scripts", "installer-ui.sh"));
    const result = runInstall(targetDir, {
      FAKE_ENGINE_EXIT: "0",
      FAKE_ENGINE_OUTCOME: "status=ok\nfresh=0\nprofile=standard\nmodel-pull=0\ndatabase-volume=\n",
    });
    expect(result.status).toBe(1);
    expect(result.stderr).toContain("The deployment's installer UI helper is unavailable.");
    expect(result.stdout).toMatch(/state=failed reason=failure action=retry/);
    expect(result.calls).not.toContain("compose --project-name");
  });
});

describe("install.sh: the application readiness probe (guarantee #34)", () => {
  // The probe is the exact text install.sh runs in the application
  // container; only its fixed address is pointed at a local server here.
  function probeSource() {
    const match = /^readonly app_readiness_probe='([\s\S]*?)'$/mu.exec(readFileSync(installScript, "utf8"));
    expect(match).not.toBeNull();
    return match[1];
  }

  async function probeAgainst(status, body) {
    const { createServer } = await import("node:http");
    const server = createServer((_request, response) => {
      response.writeHead(status, { "content-type": "application/json" }).end(body);
    });
    await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
    const { port } = server.address();
    try {
      const source = probeSource().replace("http://127.0.0.1:3000/", `http://127.0.0.1:${port}/`);
      return await new Promise((resolve) => {
        const child = spawn("node", ["-e", source]);
        child.on("close", (code) => resolve(code));
      });
    } finally {
      server.close();
    }
  }

  it.each([
    ["ready, from orbit", 200, '{"status":"ready","service":"orbit"}', 0],
    ["ready, from another service", 200, '{"status":"ready","service":"other"}', 1],
    ["starting", 200, '{"status":"starting","service":"orbit"}', 1],
    ["a 503", 503, '{"status":"ready","service":"orbit"}', 1],
    ["not JSON", 200, "ready", 1],
    ["a JSON array", 200, "[]", 1],
  ])("answers %s with exit %#", async (_label, status, body, code) => {
    expect(await probeAgainst(status, body)).toBe(code);
  });
});

describe("install.sh: what it holds by its source", () => {
  it("bounds every Compose health probe with timeout, stdin closed (guarantee #33)", () => {
    const source = readFileSync(installScript, "utf8");
    expect(source).toMatch(/timeout --signal=TERM --kill-after=1s 5s \\\n\s+docker compose --project-name "\$compose_project_name" --env-file "\$environment_file" "\$@" <\/dev\/null/u);
    for (const probe of ["probe_database_health", "probe_application_health", "probe_clamav_health", "probe_tika_health", "probe_ollama_health"]) {
      const body = new RegExp(`^${probe}\\(\\) \\{\\n([\\s\\S]*?)\\n\\}`, "mu").exec(source)?.[1] ?? "";
      expect(body, probe).toContain("bounded_compose_probe exec -T");
    }
  });

  it("uses literal delimiters for every Docker template it parses, the formats the engine's volume check documents", () => {
    const source = readFileSync(installScript, "utf8");
    const engineSide = readFileSync(join(repositoryRoot, "src", "lib", "database-volume-safety.ts"), "utf8");
    for (const format of [
      '{{index .Labels "com.docker.compose.project"}}|{{index .Labels "com.docker.compose.volume"}}',
      '{{.ID}}|{{.Label "com.docker.compose.project"}}|{{.Label "com.docker.compose.service"}}',
      "{{.Config.Image}}",
    ]) {
      expect(source).toContain(`--format '${format}'`);
      expect(engineSide).toContain(format);
    }
    expect(source).not.toMatch(/--format '[^']*\\t/u);
  });

  // #1345: they now pass the project explicitly -- derived, .env-orbit's own
  // COMPOSE_PROJECT_NAME first -- because without --project-name an exported
  // COMPOSE_PROJECT_NAME beat the persisted one. Never a hard-coded name.
  it("keeps backup and restore commands on the persisted env-file project", () => {
    for (const script of ["backup.sh", "restore.sh"]) {
      const source = readFileSync(join(repositoryRoot, "scripts", script), "utf8");
      expect(source).toContain('docker compose --project-name "$project" --env-file "$environment_file"');
      expect(source).toContain("read_environment_value COMPOSE_PROJECT_NAME");
      expect(source).not.toContain("--project-name orbit");
    }
  });

  it("documents the configuration and database recovery identity contract", () => {
    const procedure = readFileSync(join(repositoryRoot, "docs", "installer-guarantees.md"), "utf8");
    expect(procedure).toContain('preupgrade_config="$preupgrade_dir/orbit-pre-upgrade.env"');
    expect(procedure).toContain('chmod 600 "$preupgrade_config"');
    expect(procedure).toContain("configuration or pre-start failure automatically restores");
    expect(procedure).toContain(".orbit-install-staging.*");
    expect(procedure).toContain('cp -- "$preupgrade_config" .env-orbit');
    expect(procedure).toContain('bash scripts/restore.sh "$backup_path"');
    expect(procedure).toContain('rm -f -- "$preupgrade_config"');
    expect(procedure).toContain("validated `COMPOSE_PROJECT_NAME`");
  });
});

describe("install.sh --simulate on a terminal", () => {
  it("cancels the interactive simulation with a lone Escape at the profile menu", async () => {
    const targetDir = makeTarget();
    const result = await runInstallOnTerminal(
      targetDir,
      {},
      [
        { after: "Simulation: Greetings, what can we do for you today?", input: "\r" },
        { after: "Simulation: choose a deployment profile", input: "\x1b" },
      ],
      ["--simulate"],
    );
    expect(result.status).toBe(130);
    expect(result.promptedInteractions).toBe(2);
    expect(result.calls).toBe("");
    expect(targetEntries(targetDir)).toEqual([]);
  }, PTY_TEST_TIMEOUT_MS);
});

function realPath(path) {
  return execFileSync("realpath", [path], { encoding: "utf8" }).trim();
}

// ---------------------------------------------------------------------------
// #1455 (install.sh discards Docker's error when compose up fails) and
// #1456 (a failed fresh install leaves a folder the next install refuses).
//
// Written from the specification alone, before the fix. Chosen pattern for
// #1456: all-or-nothing install with rollback -- a fresh install that fails at
// any step after files are written puts the folder back the way it found it
// and removes the Docker objects it created (containers, then volumes by
// exact name). The "fresh" target here is the safe pre-provisioned bootstrap
// folder the rest of this file uses: its own files must survive byte for byte.
// ---------------------------------------------------------------------------

/** A bound on the Docker text the failure may carry (#1455): 2,000 characters. */
const dockerErrorBound = 2000;
const dockerReason = "no space left on device";
const controlCharacters = /[\u0000-\u0008\u000b-\u001f\u007f-\u009f]/u;

function terminalFailure(stdout) {
  return eventLines(stdout)
    .filter((line) => / state=failed /.test(line))
    .at(-1);
}

function longestRun(text, character) {
  return Math.max(0, ...(text.match(new RegExp(`${character}+`, "gu")) ?? []).map((run) => run.length));
}

/** Every file and directory under `dir` with its mode, so "the way it found it" can be compared whole. */
function treeSnapshot(dir) {
  const snapshot = {};
  const walk = (relative) => {
    for (const name of readdirSync(join(dir, relative)).sort()) {
      const path = join(relative, name);
      const stats = statSync(join(dir, path));
      if (stats.isDirectory()) {
        snapshot[`${path}/`] = (stats.mode & 0o777).toString(8);
        walk(path);
      } else {
        snapshot[path] = `${(stats.mode & 0o777).toString(8)}:${readFileSync(join(dir, path)).toString("base64")}`;
      }
    }
  };
  walk("");
  return snapshot;
}

function volumeRemovals(calls) {
  return calls
    .split("\n")
    .filter((line) => line.startsWith("docker volume rm"))
    .flatMap((line) => line.split(" ").slice(3))
    .filter((word) => word !== "--" && !word.startsWith("-"))
    .sort();
}

function volumesLeftBehind(stateDir) {
  return ["created-volume", "created-volumes"].flatMap((file) =>
    readOptional(join(stateDir, file))
      .split("\n")
      .filter(Boolean),
  );
}

/** A fresh pre-provisioned target, a state directory shared by every run on it, and another stack's volumes that must never be touched. */
function recoveryFixture(folderName) {
  const targetDir = folderName ? join(makeTarget(), folderName) : makeTarget();
  if (folderName) mkdirSync(targetDir);
  makePreprovisionedDeployment(targetDir);
  const stateDir = mkdtempSync(join(tmpdir(), "orbit-install-state-"));
  const other = recognisedVolume("someone-else", `${imageRepository}@sha256:${"f".repeat(64)}`);
  const environment = {
    FAKE_STATE_DIR: stateDir,
    FAKE_UP_CREATES_ALL_VOLUMES: "1",
    FAKE_VOLUMES: `${other.volume}\nunrelated-volume`,
    FAKE_PS: JSON.stringify(other.ps),
    FAKE_CONTAINER_IMAGES: JSON.stringify(other.images),
  };
  return { targetDir, stateDir, environment, preexistingVolumes: [other.volume, "unrelated-volume"], before: treeSnapshot(targetDir) };
}

describe("install.sh: a failed compose up reports Docker's reason (#1455)", () => {
  const dockerStderr = [
    `Container orbit-orbit-db-1  Error: first sighting, ${dockerReason}`,
    `\u001b[31mError response from daemon: ${dockerReason}\u001b[0m\u0007 progress\rrewritten`,
    "Z".repeat(5000),
    `dependency failed to start: container orbit-orbit-db-1 exited (1): ${dockerReason}`,
    "",
  ].join("\n");
  let cached;
  /** One failed fresh start, shared by the tests below: they read different parts of the same failure. */
  function failedStart() {
    if (!cached) {
      const fixture = recoveryFixture();
      const result = runInstall(fixture.targetDir, { ...fixture.environment, FAKE_COMPOSE_UP_FAIL: "1", FAKE_COMPOSE_UP_STDERR: dockerStderr });
      cached = { ...fixture, result, output: `${result.stdout}\n${result.stderr}` };
    }
    return cached;
  }

  it("shows Docker's own error output in the failure the launcher shows", () => {
    const { result, output } = failedStart();
    expect(result.status).toBe(1);
    expect(output).toContain(dockerReason);
  });

  it("strips control characters from Docker's text and keeps every event line well-formed", () => {
    const { result, output } = failedStart();
    expect(output).toContain(dockerReason);
    expect(output).not.toMatch(controlCharacters);
    for (const line of eventLines(result.stdout)) {
      expect(line).toMatch(/^phase=[a-z-]+ component=[a-z-]+ state=[a-z-]+ reason=[a-z-]+ action=[a-z-]+ elapsed=[0-9]+s$/);
    }
  });

  it(`bounds Docker's text to ${dockerErrorBound} characters, however long its lines`, () => {
    const { output } = failedStart();
    expect(output).toContain(dockerReason);
    expect(longestRun(output, "Z")).toBeLessThanOrEqual(dockerErrorBound);
  });

  it("keeps the failure code docker-host but does not call the start step `database`", () => {
    const { result } = failedStart();
    const failure = terminalFailure(result.stdout);
    expect(failure).toBeDefined();
    expect(failure).toMatch(/reason=docker-host /);
    expect(failure).not.toMatch(/^phase=database /);
    expect(eventLines(result.stdout).some((line) => /^phase=database .* state=failed /.test(line))).toBe(false);
  });

  it("removes every volume the failed start created, by exact name and never by wildcard or prune", () => {
    const { result, stateDir, preexistingVolumes } = failedStart();
    expect(volumeRemovals(result.calls)).toEqual(["orbit_orbit-clamav-data", "orbit_orbit-db-data", "orbit_orbit-documents-data"]);
    expect(result.calls).not.toMatch(/volume prune|system prune|\*/u);
    for (const volume of preexistingVolumes) expect(result.calls).not.toMatch(new RegExp(`volume rm.*${volume}`, "u"));
    expect(volumesLeftBehind(stateDir)).toEqual([]);
  });

  it("brings the containers down while the Compose file still exists, and only then removes volumes", () => {
    const { result, stateDir } = failedStart();
    expect(readOptional(join(stateDir, "down-log")).split("\n").filter(Boolean)).toEqual(["compose-file-present"]);
    const calls = result.calls.split("\n");
    expect(calls.findIndex((line) => line.includes(" down "))).toBeGreaterThan(-1);
    expect(calls.findIndex((line) => line.includes(" down "))).toBeLessThan(calls.findIndex((line) => line.startsWith("docker volume rm")));
  });
});

describe("install.sh: a failed fresh install leaves its folder as it found it (#1456)", () => {
  // Each row fails one step after the files were written. All of them create
  // the stack's volumes when `up` runs, so a rollback that forgets them shows.
  it.each([
    ["Compose rejects the written configuration", { FAKE_COMPOSE_CONFIG_FAIL: "1" }],
    ["the database image cannot be pulled", { FAKE_COMPOSE_PULL_FAIL: "orbit-db" }],
    ["the scanner image cannot be pulled", { FAKE_COMPOSE_PULL_FAIL: "orbit-clamav" }],
    ["compose up fails", { FAKE_COMPOSE_UP_FAIL: "1", FAKE_COMPOSE_UP_STDERR: `Error: ${dockerReason}\n` }],
    ["the database stops before it is healthy", { FAKE_PROBE_FAIL: "orbit-db", FAKE_CONTAINERS: JSON.stringify({ "orbit-db": { status: "exited", exitCode: 1 } }) }],
    ["the application stops before it reports ready", { FAKE_PROBE_FAIL: "orbit-app", FAKE_CONTAINERS: JSON.stringify({ "orbit-app": { status: "exited", exitCode: 1 } }) }],
  ])("when %s: rolls the folder and Docker back, then a retry in the same folder installs", (_step, failure) => {
    const { targetDir, stateDir, environment, preexistingVolumes, before } = recoveryFixture();

    const failed = runInstall(targetDir, { ...environment, ...failure });
    expect(failed.status).toBe(1);
    // The folder is exactly what it was: its own files byte for byte, nothing the install wrote.
    expect(treeSnapshot(targetDir)).toEqual(before);
    expect(targetEntries(targetDir)).toEqual([".env-orbit", ".orbit-secrets"]);
    // Everything this attempt created in Docker is gone; nothing else was touched.
    expect(volumesLeftBehind(stateDir)).toEqual([]);
    for (const volume of volumeRemovals(failed.calls)) expect(preexistingVolumes).not.toContain(volume);
    expect(failed.calls).not.toMatch(/volume prune|system prune/u);

    // A rollback that succeeded leaves a retry that can succeed.
    const retried = runInstall(targetDir, environment);
    expect(retried.stderr).toBe("");
    expect(retried.status).toBe(0);
    expect(retried.stdout).toContain("Orbit is ready.");
  });

  it("control: a failed image pull, before any file is written, leaves the folder as it was", () => {
    const { targetDir, environment, before } = recoveryFixture();
    const failed = runInstall(targetDir, { ...environment, FAKE_PULL_FAIL: "1" });
    expect(failed.status).not.toBe(0);
    expect(treeSnapshot(targetDir)).toEqual(before);
    expect(runInstall(targetDir, environment).status).toBe(0);
  });

  it("never rolls back an update: a failed start keeps the committed deployment and its files", () => {
    const targetDir = makeTarget();
    makePreprovisionedDeployment(targetDir);
    expect(runInstall(targetDir).status).toBe(0);
    const before = treeSnapshot(targetDir);
    const own = recognisedVolume("orbit");
    const result = runInstall(
      targetDir,
      { FAKE_COMPOSE_UP_FAIL: "1", FAKE_VOLUMES: own.volume, FAKE_PS: JSON.stringify(own.ps), FAKE_CONTAINER_IMAGES: JSON.stringify(own.images) },
      ["--update"],
    );
    expect(result.status).toBe(1);
    expect(treeSnapshot(targetDir)).toEqual(before);
    expect(result.calls).not.toContain("volume rm");
  });

});

// ---------------------------------------------------------------------------
// Review follow-ups for #1456 / #1455 (docs/installer-guarantees.md #58-60,
// docs/engine-events.md "install.sh after the commit"). Interrupts, a vanished
// launcher, unsafe folder names, an engine that exits non-zero after
// committing, Docker's words on a failed pull, and where the rollback copy of
// the user's files lives. Readiness-timeout behaviour is deliberately not
// tested here (a design decision is pending).
// ---------------------------------------------------------------------------

const wellFormedEvent = /^phase=[a-z-]+ component=[a-z-]+ state=[a-z-]+ reason=[a-z-]+ action=[a-z-]+ elapsed=[0-9]+s$/;
const allThreeVolumes = ["orbit_orbit-clamav-data", "orbit_orbit-db-data", "orbit_orbit-documents-data"];

function scratchDir(label) {
  return mkdtempSync(join(tmpdir(), `orbit-install-${label}-`));
}

/**
 * Runs install.sh in its own process group; once the fake docker has written
 * `marker` into its state directory, sends `signal` to the whole group (what a
 * terminal's Ctrl-C, a closing session or a service manager does).
 */
function pidAlive(pid) {
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    return error.code === "EPERM";
  }
}

function runInstallSignalled(targetDir, envOverrides, { signal, marker }) {
  const binDir = makeFakeBin();
  const logDir = scratchDir("log");
  const stateDir = envOverrides.FAKE_STATE_DIR;
  return new Promise((resolve, reject) => {
    const child = spawn("bash", [installScript, "--plain"], {
      cwd: targetDir,
      env: { ...baseEnvironment(binDir, logDir), ...envOverrides },
      detached: true,
      stdio: ["ignore", "pipe", "pipe"],
    });
    const killGroup = (name) => {
      try {
        process.kill(-child.pid, name);
      } catch {
        // already gone
      }
    };
    let stdout = "";
    let stderr = "";
    let sent = false;
    let sentAt = 0;
    const send = () => {
      if (sent || !existsSync(join(stateDir, marker))) return;
      sent = true;
      sentAt = Date.now();
      killGroup(signal);
    };
    const watcher = watch(stateDir, send);
    const watchdog = processWatchdog({ label: "runInstallSignalled", kill: () => killGroup("SIGKILL") });
    child.stdout.setEncoding("utf8");
    child.stderr.setEncoding("utf8");
    child.stdout.on("data", (chunk) => {
      stdout += chunk;
      watchdog.touch();
    });
    child.stderr.on("data", (chunk) => {
      stderr += chunk;
      watchdog.touch();
    });
    child.on("error", reject);
    child.on("close", (status, closedBy) => {
      watcher.close();
      watchdog.stop();
      // Is the hung fake docker still alive now that the installer has finished? (before the cleanup kill below)
      let hungPid = 0;
      try {
        hungPid = Number(readFileSync(join(stateDir, marker), "utf8"));
      } catch {
        // no marker written
      }
      const hungAlive = Number.isInteger(hungPid) && hungPid > 0 && pidAlive(hungPid);
      killGroup("SIGKILL");
      if (watchdog.reason) {
        reject(watchdog.error({ stdout, stderr }));
        return;
      }
      resolve({
        status,
        signal: closedBy,
        signalSent: sent,
        signalToExitMs: sent ? Date.now() - sentAt : 0,
        hungAlive,
        stdout,
        stderr,
        calls: readOptional(join(logDir, "calls.log")),
        engineRuns: readOptional(join(logDir, "engine.log"))
          .split("\n")
          .filter(Boolean)
          .map((line) => JSON.parse(line)),
      });
    });
    send();
  });
}

/** Runs install.sh with its stdout and/or stderr read end closed early, as a launcher that went away does. */
function runInstallWithClosedPipes(targetDir, envOverrides, closed) {
  const binDir = makeFakeBin();
  const logDir = scratchDir("log");
  return new Promise((resolve, reject) => {
    const child = spawn("bash", [installScript, "--plain"], {
      cwd: targetDir,
      env: { ...baseEnvironment(binDir, logDir), ...envOverrides },
      stdio: ["ignore", "pipe", "pipe"],
    });
    const watchdog = processWatchdog({ label: "runInstallWithClosedPipes", kill: () => child.kill("SIGKILL") });
    let gone = false;
    const goAway = () => {
      if (gone) return;
      gone = true;
      if (closed === "both") child.stdout.destroy();
      child.stderr.destroy();
    };
    child.stdout.on("data", () => {
      watchdog.touch();
      goAway();
    });
    child.stderr.on("data", () => watchdog.touch());
    if (closed === "stderr") goAway();
    child.on("error", reject);
    child.on("close", (status, signal) => {
      watchdog.stop();
      if (watchdog.reason) {
        reject(watchdog.error());
        return;
      }
      resolve({ status, signal, calls: readOptional(join(logDir, "calls.log")) });
    });
  });
}

/** A recovery fixture whose home, state and temp directories are scratch directories, so the rollback copy can be found. */
function privateStateFixture(options = {}) {
  // A string names the target folder, as recoveryFixture's argument does.
  const { xdg = true, folderName } = typeof options === "string" ? { folderName: options } : options;
  const fixture = recoveryFixture(folderName);
  const home = scratchDir("home");
  const tmp = scratchDir("tmp");
  const xdgHome = xdg ? scratchDir("xdg") : undefined;
  const stateRoot = join(xdgHome ?? join(home, ".local", "state"), "orbit");
  return {
    ...fixture,
    home,
    tmp,
    stateRoot,
    environment: {
      ...fixture.environment,
      HOME: home,
      TMPDIR: tmp,
      // undefined drops the base environment's XDG_STATE_HOME from the child.
      XDG_STATE_HOME: xdgHome,
      FAKE_SNAPSHOT_ROOTS: JSON.stringify({ tmp, xdg: stateRoot }),
    },
  };
}

function filesNamed(root, names) {
  const found = [];
  const walk = (dir) => {
    let entries = [];
    try {
      entries = readdirSync(dir);
    } catch {
      return;
    }
    for (const entry of entries) {
      const path = join(dir, entry);
      if (names.includes(entry)) found.push(path);
      if (statSync(path).isDirectory()) walk(path);
    }
  };
  walk(root);
  return found;
}

describe("install.sh: an interrupt rolls a fresh install back (#1456)", () => {
  it.each([
    ["SIGTERM", "SIGTERM", { FAKE_HANG_PROBE: "orbit-db" }, "hung-probe", true],
    ["SIGINT", "SIGINT", { FAKE_HANG_PROBE: "orbit-db" }, "hung-probe", true],
    ["SIGHUP", "SIGHUP", { FAKE_HANG_PROBE: "orbit-db" }, "hung-probe", true],
    ["SIGTERM during the image pull", "SIGTERM", { FAKE_HANG_PULL: "orbit-db" }, "hung-pull", false],
  ])("on %s: exits non-zero, restores the folder, removes the attempt's volumes by exact name, and a retry installs", async (_name, signal, hang, marker, createsVolumes) => {
    const { targetDir, stateDir, environment, preexistingVolumes, before } = recoveryFixture();

    const result = await runInstallSignalled(
      targetDir,
      { ...environment, ...hang, ORBIT_INSTALLER_READINESS_TIMEOUT_SECONDS: "60" },
      { signal, marker },
    );

    expect(result.signalSent).toBe(true);
    expect(result.status).not.toBe(0);
    expect(treeSnapshot(targetDir)).toEqual(before);
    expect(volumeRemovals(result.calls)).toEqual(createsVolumes ? allThreeVolumes : []);
    expect(volumesLeftBehind(stateDir)).toEqual([]);
    for (const volume of preexistingVolumes) expect(volumeRemovals(result.calls)).not.toContain(volume);

    const retried = runInstall(targetDir, environment);
    expect(retried.status).toBe(0);
    expect(retried.stdout).toContain("Orbit is ready.");
  });

  it("emits one well-formed terminal `failed` event after the rollback events, even though the exit was not a planned failure", async () => {
    const { targetDir, environment } = recoveryFixture();
    const result = await runInstallSignalled(
      targetDir,
      { ...environment, FAKE_HANG_PROBE: "orbit-db", ORBIT_INSTALLER_READINESS_TIMEOUT_SECONDS: "60" },
      { signal: "SIGTERM", marker: "hung-probe" },
    );
    const events = eventLines(result.stdout);
    for (const line of events) expect(line).toMatch(wellFormedEvent);
    const rollbackDone = events.findIndex((line) => /^phase=rollback component=installer state=completed /.test(line));
    expect(rollbackDone).toBeGreaterThan(-1);
    const terminal = events.at(-1);
    expect(terminal).toMatch(/ state=failed /);
    expect(events.indexOf(terminal)).toBeGreaterThan(rollbackDone);
    expect(events.filter((line) => / state=failed /.test(line))).toHaveLength(1);
  });

  it("B23: keeps the copy of the user's original files in the folder, and names it, when a second SIGTERM lands during the rollback", async () => {
    const fixture = privateStateFixture();
    const { targetDir, environment, stateRoot, before } = fixture;
    const result = await runInstallSignalled(
      targetDir,
      { ...environment, FAKE_COMPOSE_UP_FAIL: "1", FAKE_HANG_DOWN: "1" },
      { signal: "SIGTERM", marker: "hung-down" },
    );
    expect(result.signalSent).toBe(true);
    expect(result.status).not.toBe(0);
    if (JSON.stringify(ownTree(targetDir)) !== JSON.stringify(before)) {
      // Redesign r5: the folder was not put back, so the only copy of the originals is the start record inside the folder.
      const copies = filesNamed(backupsDir(targetDir), [".env-orbit"]);
      expect(copies).toHaveLength(1);
      expect(readFileSync(copies[0], "utf8")).toContain("APP_URL=https://orbit.preprovisioned-install.internal");
      expect(result.stderr).toContain(dirname(copies[0]));
    }
    expect(filesNamed(stateRoot, [".env-orbit"])).toEqual([]);
  });
});

describe("install.sh: the launcher going away does not stop the rollback (#1456)", () => {
  it.each([
    ["stdout and stderr both closed", "both"],
    ["stderr closed", "stderr"],
  ])("with %s: a failure after the commit still restores the folder and removes the volumes", async (_name, closed) => {
    const { targetDir, stateDir, environment, before } = recoveryFixture();
    const result = await runInstallWithClosedPipes(targetDir, { ...environment, FAKE_COMPOSE_UP_FAIL: "1" }, closed);
    expect(result.status === 0).toBe(false);
    expect(treeSnapshot(targetDir)).toEqual(before);
    expect(volumesLeftBehind(stateDir)).toEqual([]);
    expect(volumeRemovals(result.calls)).toEqual(allThreeVolumes);
  });
});

describe("install.sh: printed recovery commands are safe to paste (#1456)", () => {
  // Redesign r5 B24 (was r4 N12): a failed `down` prints one command; with a hostile folder name it parses, is safe, and reaches the engine/ folder.
  it.each([
    ["a space in the folder name", "orbit target folder"],
    ["a command substitution in the folder name", "orbit $(touch PWNED) folder"],
    ["a backquote and semicolon in the folder name", "orbit `touch PWNED`;touch PWNED"],
  ])("B24: with %s, the single command a failed `down` prints parses, creates no stray file run from elsewhere, and finds the Compose file in engine/", (_name, folderName) => {
    const { targetDir, stateDir, environment } = privateStateFixture(folderName);
    const result = runInstall(targetDir, { ...environment, ...r5DownFailedKnobs() });
    expect(result.status).toBe(1);
    const commands = recoveryCommands(result.stderr);
    expect(commands).toHaveLength(1);
    expect(commands[0].command).toMatch(r5DownCommand);
    // The recovery-command contract: one stdout line, the command whole on it, the same bytes as the stderr line.
    const offered = result.stdout.split("\n").filter((line) => line.startsWith(recoveryPrefix));
    expect(offered).toHaveLength(1);
    const command = offered[0].slice(recoveryPrefix.length);
    expect(command).toBe(commands[0].command);
    expect(command).toContain(volumesPart);
    expect(spawnSync("bash", ["-n"], { input: command, encoding: "utf8" }).status).toBe(0);

    // Run as printed, from another directory, with the strict fake.
    const engine = join(onlyStamp(targetDir), "engine");
    const { ran, scratch, loaded } = runPasted(command, stateDir);
    expect(`${command} -> ${ran.status} ${ran.stderr}`).toMatch(/-> 0 /u);
    for (const directory of [scratch, dirname(targetDir), targetDir, engine]) expect(existsSync(join(directory, "PWNED"))).toBe(false);
    expect(loaded?.found).toBe(true);
    expect(loaded?.cwd).toBe(realPath(engine));
  });
});

describe("install.sh: an engine that reports success but exits non-zero (#1456)", () => {
  it("rolls the committed fresh install back instead of advising retry on a committed folder", () => {
    const { targetDir, stateDir, environment, before } = recoveryFixture();
    const result = runInstall(targetDir, { ...environment, FAKE_ENGINE_REAL_THEN_EXIT: "1" });
    expect(result.status).toBe(1);
    expect(result.stderr).toContain("reported success but exited with status 1");
    expect(treeSnapshot(targetDir)).toEqual(before);
    expect(volumesLeftBehind(stateDir)).toEqual([]);
    expect(runInstall(targetDir, environment).status).toBe(0);
  });
});

describe("install.sh: a failed image pull shows Docker's own words (#1455)", () => {
  const pullStderr = [
    `pull access denied: first sighting, ${dockerReason}`,
    `\u001b[31mError response from daemon: ${dockerReason}\u001b[0m\u0007 progress\rrewritten`,
    "Z".repeat(5000),
    `failed to pull: ${dockerReason}`,
    "",
  ].join("\n");

  it.each([
    ["a service image (compose pull)", { FAKE_COMPOSE_PULL_FAIL: "orbit-db", FAKE_COMPOSE_PULL_STDERR: pullStderr }],
    ["the release image (docker pull)", { FAKE_PULL_FAIL: "1", FAKE_PULL_STDERR: pullStderr }],
  ])("for %s: bounded, control characters stripped", (_name, failure) => {
    const { targetDir, environment } = recoveryFixture();
    const result = runInstall(targetDir, { ...environment, ...failure });
    expect(result.status).not.toBe(0);
    const output = `${result.stdout}\n${result.stderr}`;
    expect(output).toContain(dockerReason);
    expect(output).not.toMatch(controlCharacters);
    expect(longestRun(output, "Z")).toBeLessThanOrEqual(dockerErrorBound);
    for (const line of eventLines(result.stdout)) expect(line).toMatch(wellFormedEvent);
  });
});

// ---------------------------------------------------------------------------
// #1485: the `Docker said:` excerpt carries Docker's error, not Compose's
// progress stream, and is at most 500 characters (the launcher's failure
// screen wraps the last six stderr lines, so a long excerpt pushes its menu
// off the bottom). Written from the specification alone, before the fix.
// ---------------------------------------------------------------------------

const dockerSaidPrefix = "Orbit installer: Docker said: ";
const dockerExcerptBound = 500;
const addressInUse =
  "Error response from daemon: failed to set up container networking: driver failed programming external connectivity on endpoint orbit (abc123): failed to bind host port 0.0.0.0:3000/tcp: address already in use";

/** The text after `Docker said: ` on stderr, and how many such lines there were. */
function dockerSaid(stderr) {
  const lines = stderr.split("\n").filter((line) => line.startsWith(dockerSaidPrefix));
  return { count: lines.length, excerpt: (lines[0] ?? "").slice(dockerSaidPrefix.length) };
}

function composeProgress() {
  const lines = [];
  for (const name of ["orbit_default", "orbit_net-a", "orbit_net-b"]) lines.push(` Network ${name}  Creating`, ` Network ${name}  Created`);
  for (const name of ["orbit-db-data", "orbit-clamav-data", "orbit-documents-data", "orbit-ollama-data"]) lines.push(` Volume ${name}  Creating`, ` Volume ${name}  Created`);
  for (const name of ["orbit-postgres", "orbit-clamav", "orbit-ollama", "orbit-mailpit", "orbit-worker"]) {
    lines.push(` Container ${name}  Creating`, ` Container ${name}  Created`, ` Container ${name}  Starting`, ` Container ${name}  Started`);
    lines.push(` Container ${name}  Waiting`, ` Container ${name}  Healthy`);
  }
  lines.push(" Image orbit/app:latest  Pulling", " Image orbit/app:latest  Pulled", " Container orbit  Starting");
  return lines;
}

describe("install.sh: the Docker said line carries the error, not the progress, and stays short (#1485)", () => {
  it("compose up: drops Compose progress lines, keeps the address-in-use error, at most 500 characters", () => {
    const { targetDir, environment } = recoveryFixture();
    const stderr = [...composeProgress(), addressInUse, ""].join("\n");
    const result = runInstall(targetDir, { ...environment, FAKE_COMPOSE_UP_FAIL: "1", FAKE_COMPOSE_UP_STDERR: stderr });
    expect(result.status).toBe(1);
    const { count, excerpt } = dockerSaid(result.stderr);
    expect(count).toBe(1);
    expect(excerpt).toContain("address already in use");
    expect(excerpt).toContain("0.0.0.0:3000/tcp");
    for (const progress of ["Creating", "Created", "Starting", "Started", "Waiting", "Healthy", "Pulling", "Pulled", "Network", "Volume", "Container orbit"]) {
      expect(excerpt).not.toContain(progress);
    }
    expect(excerpt.length).toBeLessThanOrEqual(dockerExcerptBound);
    expect(excerpt).not.toMatch(controlCharacters);
  });

  it("compose up: keeps every failure line (error, failed, denied) and joins them with ' | '", () => {
    const { targetDir, environment } = recoveryFixture();
    const stderr = [
      ...composeProgress().slice(0, 12),
      "Error response from daemon: pull access denied for orbit/app",
      " Container orbit-postgres  Healthy",
      "failed to solve: no space left on device",
      " Container orbit  Starting",
      "",
    ].join("\n");
    const result = runInstall(targetDir, { ...environment, FAKE_COMPOSE_UP_FAIL: "1", FAKE_COMPOSE_UP_STDERR: stderr });
    const { count, excerpt } = dockerSaid(result.stderr);
    expect(count).toBe(1);
    expect(excerpt).toBe("Error response from daemon: pull access denied for orbit/app | failed to solve: no space left on device");
  });

  it.each([
    ["compose up", { FAKE_COMPOSE_UP_FAIL: "1" }, "FAKE_COMPOSE_UP_STDERR"],
    ["compose pull", { FAKE_COMPOSE_PULL_FAIL: "orbit-db" }, "FAKE_COMPOSE_PULL_STDERR"],
    ["the release image pull", { FAKE_PULL_FAIL: "1" }, "FAKE_PULL_STDERR"],
  ])("%s: long error text is cut to 500 characters, keeping the end, marked with a leading '...'", (_name, failure, stderrVariable) => {
    const { targetDir, environment } = recoveryFixture();
    const longError = `Error response from daemon: ${"very long explanation of the failure ".repeat(40)}final cause: ${dockerReason} END-MARKER`;
    expect(longError.length).toBeGreaterThan(dockerExcerptBound);
    const result = runInstall(targetDir, { ...environment, ...failure, [stderrVariable]: `${longError}\n` });
    expect(result.status).not.toBe(0);
    const { count, excerpt } = dockerSaid(result.stderr);
    expect(count).toBe(1);
    expect(excerpt.length).toBeLessThanOrEqual(dockerExcerptBound);
    expect(excerpt.startsWith("...")).toBe(true);
    expect(excerpt.endsWith(`final cause: ${dockerReason} END-MARKER`)).toBe(true);
  });

  it("compose up: output that only looks like progress keeps its last line, so a cause is never lost", () => {
    const { targetDir, environment } = recoveryFixture();
    const stderr = [...composeProgress(), "something unexpected happened", ""].join("\n");
    const result = runInstall(targetDir, { ...environment, FAKE_COMPOSE_UP_FAIL: "1", FAKE_COMPOSE_UP_STDERR: stderr });
    expect(result.status).toBe(1);
    const { count, excerpt } = dockerSaid(result.stderr);
    expect(count).toBe(1);
    expect(excerpt).toBe("something unexpected happened");
  });

  it("compose up: progress-only output keeps its last line rather than printing an empty excerpt", () => {
    const { targetDir, environment } = recoveryFixture();
    const stderr = [...composeProgress(), ""].join("\n");
    const result = runInstall(targetDir, { ...environment, FAKE_COMPOSE_UP_FAIL: "1", FAKE_COMPOSE_UP_STDERR: stderr });
    expect(result.status).toBe(1);
    const { excerpt } = dockerSaid(result.stderr);
    expect(excerpt.trim()).not.toBe("");
    expect(excerpt).toContain("Container orbit  Starting");
  });
});

// ---------------------------------------------------------------------------
// #1456 decision (2026-10-17, note 40388): what a failed readiness wait does.
// Only a FAILURE (container not running at the deadline) rolls a fresh install
// back; a service still starting is left in place (`repair`); an optional
// service never fails the install (`state=waiting reason=optional-status
// action=continue`, a completion line each); a failed model download is a
// `continue` too, and runs through the `orbit-ollama-model-pull` service
// (#1474). Container facts come from single `docker inspect --format` fields;
// logs are never requested (the app log carries the claim code).
// ---------------------------------------------------------------------------

const logSentinel = "SECRET-LOG-LINE";
const freeSpaceLine = /free space|space free|available|free:/i;

function componentEvents(stdout, component) {
  return eventLines(stdout).filter((line) => line.startsWith(`phase=`) && line.includes(` component=${component} `));
}

function expectNoLogsRequested(result) {
  const output = `${result.stdout}\n${result.stderr}`;
  expect(output).not.toContain(logSentinel);
  for (const line of result.calls.split("\n")) {
    expect(line).not.toMatch(/^docker logs\b/u);
    expect(line).not.toMatch(/ logs( |$)/u);
    if (line.startsWith("docker inspect ")) {
      expect(line).toMatch(/ (--format|-f)[ =]/u);
      expect(line).not.toMatch(/\.Config\.Env|\.Args|\.Config(?!\.)/u);
    }
  }
}

describe("install.sh: a service that is not running at the deadline rolls a fresh install back (#1456 decision)", () => {
  const exited = { status: "exited", exitCode: 1, restarts: 3, oom: false };
  it.each([
    ["the database exited", "orbit-db", exited, ["status=exited", "exit-code=1", "oom-killed=false", "restarts=3"]],
    ["the database is restarting", "orbit-db", { status: "restarting", restarts: 5 }, ["status=restarting", "restarts=5"]],
    ["the database container is missing", "orbit-db", { status: "missing" }, []],
    ["the application exited", "orbit-app", exited, ["status=exited", "exit-code=1", "oom-killed=false", "restarts=3"]],
    ["the application is restarting", "orbit-app", { status: "restarting", restarts: 5 }, ["status=restarting", "restarts=5"]],
    ["the application container is missing", "orbit-app", { status: "missing" }, []],
  ])("when %s: rolls back, advises retry, names the container facts and free space, shows no logs, and a retry installs", (_name, service, facts, expectedFacts) => {
    const { targetDir, stateDir, environment, before } = recoveryFixture();
    const result = runInstall(targetDir, {
      ...environment,
      FAKE_PROBE_FAIL: service,
      FAKE_CONTAINERS: JSON.stringify({ [service]: facts }),
    });

    expect(result.status).toBe(1);
    expect(treeSnapshot(targetDir)).toEqual(before);
    expect(volumesLeftBehind(stateDir)).toEqual([]);
    const failure = terminalFailure(result.stdout);
    expect(failure).toMatch(/ action=retry /);
    expect(result.stderr).toContain(service);
    for (const fact of expectedFacts) expect(result.stderr).toContain(fact);
    expect(result.stderr).toMatch(freeSpaceLine);
    expectNoLogsRequested(result);

    const retried = runInstall(targetDir, environment);
    expect(retried.status).toBe(0);
  });
});

describe("install.sh: a service still running at the deadline is left in place (#1456 decision)", () => {
  it.each([
    ["the database", "orbit-db"],
    ["the application", "orbit-app"],
  ])("%s running with its probe still failing: no rollback, `repair`, left running, and an Update is accepted", (_name, service) => {
    const { targetDir, stateDir, environment } = recoveryFixture();
    const result = runInstall(targetDir, {
      ...environment,
      FAKE_PROBE_FAIL: service,
      FAKE_CONTAINERS: JSON.stringify({ [service]: { status: "running", health: "starting" } }),
    });

    expect(result.status).toBe(1);
    // The folder is a deployment, and nothing was torn down.
    for (const file of ["docker-compose.yml", ".env-orbit", ".orbit-secrets"]) expect(existsSync(join(targetDir, file))).toBe(true);
    expect(volumesLeftBehind(stateDir).sort()).toEqual(allThreeVolumes);
    expect(result.calls).not.toContain("volume rm");
    expect(result.calls).not.toContain(" down ");
    expect(terminalFailure(result.stdout)).toMatch(/ action=repair /);
    expect(result.stderr).toMatch(/did not report ready within \d+ ?s/);
    expect(result.stderr).toMatch(/left running/);
    expect(result.stderr).toMatch(/docker compose .* ps/);
    expect(result.stderr).toMatch(/Repair/);
    expectNoLogsRequested(result);

    // The next step is Update, never a refused Install.
    const own = recognisedVolume("orbit");
    const updated = runInstall(
      targetDir,
      { FAKE_VOLUMES: own.volume, FAKE_PS: JSON.stringify(own.ps), FAKE_CONTAINER_IMAGES: JSON.stringify(own.images) },
      ["--update"],
    );
    expect(updated.stderr).not.toMatch(/not empty|Refusing to install here|requires a recognized/);
    expect(updated.status).toBe(0);
  });
});

describe("install.sh: an optional service never fails the install (#1456 decision)", () => {
  it.each([
    ["the scanner is still starting", "clamav", undefined, { status: "running", health: "starting" }, /Scanner: still starting/],
    ["the scanner exited", "clamav", undefined, { status: "exited", exitCode: 2 }, /Scanner: stopped \(exit 2\)/],
    ["document processing is still starting", "tika", "processing", { status: "running", health: "starting" }, /(Document processing|Tika|Processing)[^\n]*still starting/i],
    ["document processing exited", "tika", "processing", { status: "exited", exitCode: 2 }, /(Document processing|Tika|Processing)[^\n]*stopped \(exit 2\)/i],
    ["the local model service is still starting", "ollama", "ai", { status: "running", health: "starting" }, /(Local model|Ollama|Model)[^\n]*still starting/i],
    ["the local model service exited", "ollama", "ai", { status: "exited", exitCode: 2 }, /(Local model|Ollama|Model)[^\n]*stopped \(exit 2\)/i],
  ])("when %s: the install exits 0, the component's last event is waiting/optional-status/continue, and a completion line names it", (_name, component, profile, facts, line) => {
    const { targetDir, stateDir, environment } = recoveryFixture();
    const result = runInstall(targetDir, {
      ...environment,
      ...(profile ? { FAKE_OUTCOME_PATCH: JSON.stringify({ profile }) } : {}),
      FAKE_PROBE_FAIL: `orbit-${component}`,
      FAKE_CONTAINERS: JSON.stringify({ [`orbit-${component}`]: facts }),
    });
    expect(result.status).toBe(0);
    expect(componentEvents(result.stdout, component).at(-1)).toMatch(/ state=waiting reason=optional-status action=continue /);
    expect(`${result.stdout}\n${result.stderr}`).toMatch(line);
    expect(eventLines(result.stdout).some((event) => / state=failed /.test(event))).toBe(false);
    // Nothing was rolled back: the stack stays.
    expect(result.calls).not.toContain("volume rm");
    expect(existsSync(join(targetDir, "docker-compose.yml"))).toBe(true);
    expect(volumesLeftBehind(stateDir).sort()).toEqual(allThreeVolumes);
    expectNoLogsRequested(result);
  });
});

describe("install.sh: the confirmed model download (#1456 decision, #1474)", () => {
  const pullWords = [`pull failed: first sighting, ${dockerReason}`, `\u001b[31mError: ${dockerReason}\u001b[0m\u0007 progress\rrewritten`, "Z".repeat(5000), `failed: ${dockerReason}`, ""].join("\n");
  // The profile triple cannot be pre-provisioned on a fresh target, so, as the
  // existing model test does, the deployment is installed first and the model
  // download is requested on the next run (an update).
  function modelFixture() {
    const fixture = recoveryFixture();
    expect(runInstall(fixture.targetDir, fixture.environment).status).toBe(0);
    appendFileSync(join(fixture.targetDir, ".env-orbit"), "OLLAMA_MODEL=llama3.2:1b\n");
    const own = recognisedVolume("orbit");
    return {
      ...fixture,
      environment: {
        FAKE_VOLUMES: own.volume,
        FAKE_PS: JSON.stringify(own.ps),
        FAKE_CONTAINER_IMAGES: JSON.stringify(own.images),
      },
    };
  }
  const withModelPull = { FAKE_ENGINE_EXIT: "0", FAKE_ENGINE_OUTCOME: "status=ok\nfresh=0\nprofile=ai\nmodel-pull=1\ndatabase-volume=\n" };

  it("when the download fails: the install exits 0, the component continues, and the pull's words are shown bounded and stripped", () => {
    const { targetDir, environment } = modelFixture();
    const result = runInstall(targetDir, { ...environment, ...withModelPull, FAKE_MODEL_PULL_FAIL: "1", FAKE_MODEL_PULL_STDERR: pullWords });
    expect(result.status).toBe(0);
    const output = `${result.stdout}\n${result.stderr}`;
    expect(eventLines(result.stdout).some((line) => /component=(ollama|model)[a-z-]* .* action=continue /.test(line))).toBe(true);
    expect(output).toContain(dockerReason);
    expect(output).not.toMatch(controlCharacters);
    expect(longestRun(output, "Z")).toBeLessThanOrEqual(dockerErrorBound);
    expect(eventLines(result.stdout).some((line) => / state=failed /.test(line))).toBe(false);
  });

  it.each([
    ["succeeds", {}],
    ["fails", { FAKE_MODEL_PULL_FAIL: "1", FAKE_MODEL_PULL_STDERR: pullWords }],
  ])("when the download %s: it runs through the orbit-ollama-model-pull service, never `exec … ollama pull`", (_name, outcome) => {
    const { targetDir, environment } = modelFixture();
    const result = runInstall(targetDir, { ...environment, ...withModelPull, ...outcome });
    expect(result.status).toBe(0);
    expect(result.calls).toMatch(/--profile ai-model-pull .*orbit-ollama-model-pull/);
    expect(result.calls).not.toMatch(/exec .*orbit-ollama .*ollama pull/);
  });

  it("G7-FR1: the failed-download note carries the `docker compose ... run --rm orbit-ollama-model-pull` command to try again and not the leftover container's name", () => {
    const { targetDir, environment } = modelFixture();
    const result = runInstall(targetDir, { ...environment, ...withModelPull, FAKE_MODEL_PULL_FAIL: "1" });
    expect(result.status).toBe(0);
    const output = `${result.stdout}\n${result.stderr}`;
    expect(output).toMatch(/To try again: docker compose .*--profile ai-model-pull run --rm orbit-ollama-model-pull/u);
    expect(output).not.toContain("orbit-orbit-ollama-model-pull-install");
  });
});

describe("install.sh: an update's failures are unchanged by the decision (#1456 decision)", () => {
  it.each([
    ["the database exited", "orbit-db", { status: "exited", exitCode: 1, restarts: 3 }],
    ["the application is still running but not ready", "orbit-app", { status: "running", health: "starting" }],
  ])("when %s during an update: no rollback, files kept, `repair`", (_name, service, facts) => {
    const targetDir = makeTarget();
    makePreprovisionedDeployment(targetDir);
    expect(runInstall(targetDir).status).toBe(0);
    const before = treeSnapshot(targetDir);
    const own = recognisedVolume("orbit");
    const result = runInstall(
      targetDir,
      {
        FAKE_VOLUMES: own.volume,
        FAKE_PS: JSON.stringify(own.ps),
        FAKE_CONTAINER_IMAGES: JSON.stringify(own.images),
        FAKE_PROBE_FAIL: service,
        FAKE_CONTAINERS: JSON.stringify({ [service]: facts }),
      },
      ["--update"],
    );
    expect(result.status).toBe(1);
    expect(terminalFailure(result.stdout)).toMatch(/ action=repair /);
    expect(result.calls).not.toContain("volume rm");
    expect(result.calls).not.toContain(" down ");
    expect(Object.keys(treeSnapshot(targetDir))).toEqual(expect.arrayContaining(Object.keys(before)));
    expect(eventLines(result.stdout).some((line) => /^phase=rollback /.test(line))).toBe(false);
  });
});

// ---------------------------------------------------------------------------
// Round-2 review findings on #1456 (rollback and readiness).
// ---------------------------------------------------------------------------

/** Recovery commands printed on stderr, each with the prose before it (which may say where to run it). */
function recoveryCommands(stderr) {
  const lines = stderr.split("\n");
  const commands = [];
  lines.forEach((line, index) => {
    const match = /((?:cd\s.*?&&\s*)?docker (?:compose|volume rm)\b.*|cp -a\b.*|rm -rf\b.*)$/u.exec(line);
    if (!match) return;
    // A line holding only the command is taken whole: its quoted folder may itself contain a backquote.
    // Inside a sentence, the command ends before a following sentence ("… ps. If it is not ready …") or a closing backquote.
    const command =
      match.index === 0
        ? match[1].trimEnd()
        : match[1].replace(/^`+/u, "").split(/`|\.\s+[A-Z]/u)[0].replace(/[.\s]+$/u, "");
    commands.push({ command, context: `${lines[index - 1] ?? ""}\n${line.slice(0, match.index)}` });
  });
  return commands;
}

function containersLeft(stateDir) {
  return readOptional(join(stateDir, "containers"))
    .split("\n")
    .filter(Boolean);
}

function modelUpdateFixture() {
  // As the model-download tests above: install first, then ask for the download on an update.
  const fixture = recoveryFixture();
  expect(runInstall(fixture.targetDir, fixture.environment).status).toBe(0);
  appendFileSync(join(fixture.targetDir, ".env-orbit"), "OLLAMA_MODEL=llama3.2:1b\n");
  const own = recognisedVolume("orbit");
  const stateDir = scratchDir("state");
  return {
    ...fixture,
    stateDir,
    environment: {
      FAKE_STATE_DIR: stateDir,
      FAKE_VOLUMES: own.volume,
      FAKE_PS: JSON.stringify(own.ps),
      FAKE_CONTAINER_IMAGES: JSON.stringify(own.images),
      FAKE_ENGINE_EXIT: "0",
      FAKE_ENGINE_OUTCOME: "status=ok\nfresh=0\nprofile=ai\nmodel-pull=1\ndatabase-volume=\n",
    },
  };
}

describe("install.sh: printed recovery commands work as printed (#1456 round 2)", () => {
  it("the `ps` check printed after `left running` names the folder and works from another directory", () => {
    const { targetDir, stateDir, environment } = recoveryFixture("orbit target folder");
    const result = runInstall(targetDir, {
      ...environment,
      FAKE_COMPOSE_STRICT: "1",
      FAKE_PROBE_FAIL: "orbit-db",
      FAKE_CONTAINERS: JSON.stringify({ "orbit-db": { status: "running", health: "starting" } }),
    });
    expect(result.status).toBe(1);
    expect(result.stderr).toMatch(/left running/u);
    const check = recoveryCommands(result.stderr).find((entry) => /\bps\b/u.test(entry.command));
    expect(check).toBeDefined();

    const scratch = scratchDir("elsewhere");
    const ran = failOnProcessDeadline(
      spawnSync("bash", ["-c", check.command], {
        cwd: scratch,
        env: { PATH: `${makePasteBin()}:${process.env.PATH}`, HOME: scratch, FAKE_STATE_DIR: stateDir, FAKE_COMPOSE_STRICT: "1", FAKE_CALL_LOG: join(scratch, "calls.log") },
        encoding: "utf8",
        ...processGuard(),
      }),
      { label: "printed ps check" },
    );
    expect(`${check.command} -> ${ran.status} ${ran.stderr}`).toMatch(/-> 0 /u);
    // Compose really loaded this deployment, not an empty directory.
    const loaded = JSON.parse(readOptional(join(stateDir, "strict-log")).split("\n").filter(Boolean).at(-1));
    expect(loaded.found).toBe(true);
    expect(loaded.cwd === realPath(targetDir) || loaded.argv.some((arg) => arg.includes(realPath(targetDir)))).toBe(true);
  });
});

describe("install.sh: a crash-looping required container counts as stopped (#1456 round 2)", () => {
  it.each([
    ["the database", "orbit-db"],
    ["the application", "orbit-app"],
  ])("%s reporting `running` with a rising restart count: rolled back, retry, and the facts show restarts and the exit code", (_name, service) => {
    const { targetDir, stateDir, environment, before } = recoveryFixture();
    const result = runInstall(targetDir, {
      ...environment,
      ORBIT_INSTALLER_READINESS_TIMEOUT_SECONDS: "6",
      FAKE_PROBE_FAIL: service,
      // Three restarts between any two reads: a crash loop by the 3-or-more threshold (O-S2).
      FAKE_CONTAINERS: JSON.stringify({ [service]: { status: "running", health: "starting", restartsRising: true, restartsStep: 3, exitCode: 137 } }),
    });
    expect(result.status).toBe(1);
    expect(treeSnapshot(targetDir)).toEqual(before);
    expect(volumesLeftBehind(stateDir)).toEqual([]);
    expect(terminalFailure(result.stdout)).toMatch(/ action=retry /);
    expect(result.stderr).toMatch(/restarts=\d+/u);
    expect(result.stderr).toContain("exit-code=137");
  });
});

describe("install.sh: the local model service never ready (#1456 round 2)", () => {
  it("even when the confirmed model download succeeds, the service's last event is waiting/optional-status/continue and the completion line agrees", () => {
    const { targetDir, environment } = modelUpdateFixture();
    const result = runInstall(targetDir, {
      ...environment,
      FAKE_PROBE_FAIL: "orbit-ollama",
      FAKE_CONTAINERS: JSON.stringify({ "orbit-ollama": { status: "running", health: "starting" } }),
    });
    expect(result.status).toBe(0);
    expect(componentEvents(result.stdout, "ollama").at(-1)).toMatch(/ state=waiting reason=optional-status action=continue /);
    expect(`${result.stdout}\n${result.stderr}`).toMatch(/(Local model|Ollama|Model)[^\n]*still starting/i);
    expect(eventLines(result.stdout).some((line) => / state=failed /.test(line))).toBe(false);
  });
});

describe("install.sh: the rollback copy failing part-way (#1456 round 2)", () => {
  it("leaves no partial copy of the secrets under the state directory, and the folder unchanged", () => {
    const fixture = privateStateFixture();
    const { targetDir, stateRoot, tmp, environment } = fixture;
    // A secret too big for the file-size limit below: the copy dies after the first file.
    writeFileSync(join(targetDir, ".orbit-secrets", "oidc-client-secret"), "x".repeat(20000), { mode: 0o600 });
    const before = treeSnapshot(targetDir);

    const binDir = makeFakeBin();
    const logDir = scratchDir("log");
    const result = failOnProcessDeadline(
      spawnSync("bash", ["-c", 'ulimit -c 0; ulimit -f 8; exec bash "$0" --plain', installScript], {
        cwd: targetDir,
        encoding: "utf8",
        env: { ...baseEnvironment(binDir, logDir), ...environment },
        ...processGuard(),
      }),
      { label: "limited install" },
    );

    expect(result.status).not.toBe(0);
    expect(treeSnapshot(targetDir)).toEqual(before);
    expect(filesNamed(stateRoot, [".env-orbit", ".orbit-secrets", "oidc-client-secret"])).toEqual([]);
    expect(filesNamed(tmp, [".env-orbit", ".orbit-secrets", "oidc-client-secret"])).toEqual([]);
  });
});

describe("install.sh: once the database and application are ready the rollback is disarmed (#1456 round 2)", () => {
  function expectLeftInPlace(result, { targetDir, stateDir }) {
    expect(result.signalSent).toBe(true);
    expect(result.status).toBe(0);
    const events = eventLines(result.stdout);
    expect(events.some((line) => /^phase=rollback /.test(line))).toBe(false);
    expect(events.some((line) => /^phase=complete .* state=completed /.test(line))).toBe(true);
    expect(existsSync(join(targetDir, "docker-compose.yml"))).toBe(true);
    expect(result.calls).not.toContain("volume rm");
    expect(volumesLeftBehind(stateDir).sort()).toEqual(allThreeVolumes);
    expect(result.hungAlive).toBe(false);
  }

  it("SIGTERM during the optional scanner wait: exits 0, scanner still starting, completes", async () => {
    const { targetDir, stateDir, environment } = recoveryFixture();
    const result = await runInstallSignalled(
      targetDir,
      { ...environment, FAKE_HANG_PROBE: "orbit-clamav", ORBIT_INSTALLER_READINESS_TIMEOUT_SECONDS: "60" },
      { signal: "SIGTERM", marker: "hung-probe" },
    );
    expectLeftInPlace(result, { targetDir, stateDir });
    expect(componentEvents(result.stdout, "clamav").at(-1)).toMatch(/ state=waiting reason=optional-status action=continue /);
    expect(`${result.stdout}\n${result.stderr}`).toMatch(/Scanner: still starting/u);
  });

  it("SIGTERM during the confirmed model download: exits 0, the model not downloaded, completes", async () => {
    const { targetDir, environment } = modelUpdateFixture();
    const result = await runInstallSignalled(
      targetDir,
      { ...environment, FAKE_HANG_MODEL_PULL: "1", ORBIT_INSTALLER_READINESS_TIMEOUT_SECONDS: "60" },
      { signal: "SIGTERM", marker: "hung-modelpull" },
    );
    expect(result.signalSent).toBe(true);
    expect(result.status).toBe(0);
    const events = eventLines(result.stdout);
    expect(events.some((line) => /^phase=rollback /.test(line))).toBe(false);
    expect(events.some((line) => /^phase=complete .* state=completed /.test(line))).toBe(true);
    expect(existsSync(join(targetDir, "docker-compose.yml"))).toBe(true);
    expect(result.calls).not.toContain("volume rm");
    expect(result.hungAlive).toBe(false);
    expect(events.filter((line) => /^phase=\S+ component=(ollama|model)/.test(line)).at(-1)).toMatch(/ state=waiting reason=optional-status action=continue /);
    expect(`${result.stdout}\n${result.stderr}`).toMatch(/(Local model|Model|Ollama)[^\n]*(not downloaded|still starting|still downloading)/i);
  });
});

describe("install.sh: a model-pull container left behind by an earlier run", () => {
  const leftover = "orbit-orbit-ollama-model-pull-install";
  const confirmed = { FAKE_ENGINE_EXIT: "0", FAKE_ENGINE_OUTCOME: "status=ok\nfresh=0\nprofile=ai\nmodel-pull=1\ndatabase-volume=\n" };

  it("the name is already held: the installer removes that container before the run, and the download succeeds", () => {
    const { targetDir, stateDir, environment } = modelUpdateFixture();
    writeFileSync(join(stateDir, "model-pull-running"), leftover + "\n");
    const result = runInstall(targetDir, { ...environment, ...confirmed });
    expect(result.status).toBe(0);
    const calls = result.calls.split("\n");
    const removal = calls.findIndex((line) => /^docker rm /.test(line) && / -f /.test(line) && line.split(" ").includes(leftover));
    const run = calls.findIndex((line) => /compose .* run .*orbit-ollama-model-pull/.test(line));
    expect(removal).toBeGreaterThanOrEqual(0);
    expect(run).toBeGreaterThan(removal);
    expect(`${result.stdout}\n${result.stderr}`).not.toMatch(/confirmed download did not complete/);
  });

  it("a download that does not complete: the retry hint names the container", () => {
    const { targetDir, environment } = modelUpdateFixture();
    const result = runInstall(targetDir, { ...environment, ...confirmed, FAKE_MODEL_PULL_FAIL: "1" });
    expect(result.status).toBe(0);
    const note = `${result.stdout}\n${result.stderr}`.split("\n").find((line) => /confirmed download did not complete/.test(line)) ?? "";
    expect(note).toContain(leftover);
  });
});

describe("install.sh: an interrupted model download leaves no container running (#1456 round 3)", () => {
  it("SIGTERM during the confirmed model download: the model-pull container the killed client started is removed, and only that one", async () => {
    const { targetDir, stateDir, environment } = modelUpdateFixture();
    const result = await runInstallSignalled(
      targetDir,
      { ...environment, FAKE_HANG_MODEL_PULL: "1", ORBIT_INSTALLER_READINESS_TIMEOUT_SECONDS: "60" },
      { signal: "SIGTERM", marker: "hung-modelpull" },
    );
    expect(result.signalSent).toBe(true);
    // The fake did start a model-pull container, and its client's death did not remove it.
    expect(readOptional(join(stateDir, "model-pull-started")).split("\n").filter(Boolean)).toHaveLength(1);
    const started = readOptional(join(stateDir, "model-pull-started")).trim();

    // The installer removed it.
    expect(readOptional(join(stateDir, "model-pull-running")).split("\n").filter(Boolean)).toEqual([]);

    // Scoped: any removal names only the model-pull container or service, never orbit-ollama or the whole project.
    for (const line of result.calls.split("\n")) {
      if (/^docker (rm|stop|kill) /.test(line)) expect(line.split(" ").slice(2).filter((arg) => !arg.startsWith("-"))).toEqual([started]);
      if (/^docker compose .* (rm|stop|kill) /.test(line)) {
        const afterVerb = line.split(/ (?:rm|stop|kill) /)[1].split(" ").filter((arg) => !arg.startsWith("-"));
        expect(afterVerb).toEqual(["orbit-ollama-model-pull"]);
      }
      expect(line).not.toMatch(/^docker compose .* down( |$)/);
    }
  });
});

// ---------------------------------------------------------------------------
// v0.3 acceptance findings on the rollback (O-R1, O-F6, O-S2, O-S1, O-R4,
// O-S4, O-F1, L-Q4). Written from the specification, before the fix.
// ---------------------------------------------------------------------------

/** Every directory called `name` anywhere under `root`. */
function directoriesNamed(root, name) {
  return filesNamed(root, [name]).filter((path) => statSync(path).isDirectory());
}

/** The `install-rollback.*` entries directly under a state root. */
function rollbackEntries(stateRoot) {
  return existsSync(stateRoot) ? readdirSync(stateRoot).filter((name) => name.startsWith("install-rollback.")) : [];
}

/** A HOME that does not exist and cannot be created, with XDG_STATE_HOME unset. */
function unwritableHome() {
  const parent = scratchDir("nohome");
  chmodSync(parent, 0o500);
  return { HOME: join(parent, "missing"), XDG_STATE_HOME: undefined };
}

describe("install.sh: the rollback's shutdown is bounded (O-F6)", () => {
  it("the rollback's `compose down` carries `--timeout 5`", () => {
    const { targetDir, environment } = recoveryFixture();
    const result = runInstall(targetDir, { ...environment, FAKE_COMPOSE_UP_FAIL: "1" });
    expect(result.status).toBe(1);
    const downs = result.calls.split("\n").filter((line) => /^docker compose .* down( |$)/u.test(line));
    expect(downs.length).toBeGreaterThan(0);
    for (const line of downs) expect(line).toMatch(/ --timeout 5( |$)/u);
  });
});

describe("install.sh: one or two restarts are not a crash loop; three are (O-S2)", () => {
  it("the database running, restart count +2 since the earlier sample: left in place, `repair`, no rollback", () => {
    const { targetDir, stateDir, environment } = recoveryFixture();
    const result = runInstall(targetDir, {
      ...environment,
      ORBIT_INSTALLER_READINESS_TIMEOUT_SECONDS: "6",
      FAKE_PROBE_FAIL: "orbit-db",
      FAKE_CONTAINERS: JSON.stringify({ "orbit-db": { status: "running", health: "starting", restarts: 1, restartsJump: 2 } }),
    });
    expect(result.status).toBe(1);
    for (const file of ["docker-compose.yml", ".env-orbit", ".orbit-secrets"]) expect(existsSync(join(targetDir, file))).toBe(true);
    expect(volumesLeftBehind(stateDir).sort()).toEqual(allThreeVolumes);
    expect(result.calls).not.toContain("volume rm");
    expect(result.calls).not.toContain(" down ");
    expect(terminalFailure(result.stdout)).toMatch(/ action=repair /);
    expect(result.stderr).toMatch(/left running/u);
  });

  it("the database running, restart count +3 since the earlier sample: a crash loop, rolled back, `retry`", () => {
    const { targetDir, stateDir, environment, before } = recoveryFixture();
    const result = runInstall(targetDir, {
      ...environment,
      ORBIT_INSTALLER_READINESS_TIMEOUT_SECONDS: "6",
      FAKE_PROBE_FAIL: "orbit-db",
      FAKE_CONTAINERS: JSON.stringify({ "orbit-db": { status: "running", health: "starting", restarts: 1, restartsJump: 3 } }),
    });
    expect(result.status).toBe(1);
    expect(treeSnapshot(targetDir)).toEqual(before);
    expect(volumesLeftBehind(stateDir)).toEqual([]);
    expect(terminalFailure(result.stdout)).toMatch(/ action=retry /);
  });
});

describe("install.sh: an interrupt while the engine runs (O-R4)", () => {
  it("SIGTERM after the engine committed a fresh install: the folder is put back, the engine's files are removed rather than moved aside, the copy is released, and the next run is a fresh install", async () => {
    // Redesign r1 test 3: privateStateFixture, so the state root is known.
    const { targetDir, stateRoot, environment, before } = privateStateFixture();
    const result = await runInstallSignalled(
      targetDir,
      { ...environment, FAKE_ENGINE_HANG_AFTER: "1" },
      { signal: "SIGTERM", marker: "hung-engine" },
    );
    expect(result.signalSent).toBe(true);
    expect(result.status).not.toBe(0);
    expect(result.status).toBe(143);
    expect(targetEntries(targetDir)).toEqual([".env-orbit", ".orbit-secrets"]);
    expect(treeSnapshot(targetDir)).toEqual(before);
    expect(result.stderr).not.toContain("did not write");
    expect(directoriesNamed(stateRoot, "added")).toEqual([]);
    expect(filesNamed(stateRoot, [".env-orbit"])).toEqual([]);

    const retried = runInstall(targetDir, environment);
    expect(retried.stderr).not.toMatch(/not empty|Refusing to install here|requires a recognized/u);
    expect(retried.status).toBe(0);
    expect(retried.stdout).toContain("Orbit is ready.");
  });

  it("SIGTERM while the engine runs, before it commits: the folder and the original files are unchanged", async () => {
    const { targetDir, environment, before } = recoveryFixture();
    const result = await runInstallSignalled(
      targetDir,
      { ...environment, FAKE_ENGINE_HANG_BEFORE: "1" },
      { signal: "SIGTERM", marker: "hung-engine" },
    );
    expect(result.signalSent).toBe(true);
    expect(result.status).not.toBe(0);
    expect(treeSnapshot(targetDir)).toEqual(before);
    expect(runInstall(targetDir, environment).status).toBe(0);
  });
});

// Redesign r2 helpers. The engine journals the names it may write
// (`<outcome dir>/written`); the rollback removes what the journal names and
// moves anything else new aside, so a file the person saved while the engine
// ran is never deleted.
const personNotes = "notes the person saved while the engine ran\n";

/** "Folder put back": as found (`before`, pre-provisioned) or empty (`before` undefined), apart from orbit-install-backups/ (redesign r5), and the terminal event advises retry. */
function expectFolderPutBack(result, targetDir, before) {
  if (before === undefined) expect(targetEntries(targetDir).filter((name) => name !== backupsName)).toEqual([]);
  else expect(ownTree(targetDir)).toEqual(before);
  expect(terminalFailure(result.stdout)).toMatch(/ action=retry /u);
}

// "Moved aside" (redesign r5): kept unchanged under <folder>/orbit-install-backups/<stamp>/moved/, and the output says so and where. Returns the kept path.
function expectMovedAside(result, targetDir, name, content, { rollbackLine = true } = {}) {
  const kept = filesNamed(backupsDir(targetDir), [name]);
  expect(kept).toHaveLength(1);
  expect(kept[0]).toMatch(new RegExp(`/orbit-install-backups/\\d{8}T\\d{6}Z(-[2-9])?/moved/${name.replace(/[.]/gu, "\\.")}$`, "u"));
  expect(readFileSync(kept[0], "utf8")).toBe(content);
  expect(result.stderr).toContain("moved, not deleted");
  expect(result.stderr).toContain(dirname(kept[0]));
  expect(result.stderr).not.toContain("Delete that directory");
  if (rollbackLine) {
    const lines = result.stderr.split("\n").filter((line) => line.includes("rolled back"));
    expect(lines.join("\n")).toContain("apart from the files moved out");
  }
  return kept[0];
}

// O-S4 as redesigned (r1): the rollback runs when the engine dies without a
// result, restores from the copy, then releases it (keeping the copy for ever
// after a verified restore was O-S4-FR1).
describe("install.sh: an engine killed hard on a fresh install is rolled back (O-S4, redesign r1)", () => {
  // Redesign r2 T6 (replaces r1's half-commit test): the engine's journal names what it may have written, and a person's file is moved aside.
  it("engine exits 137 with no outcome after a half commit: the folder is put back, staging and lock removed, the person's file moved aside and the copy released (redesign r5)", () => {
    const { targetDir, stateRoot, environment, before } = privateStateFixture();
    const result = runInstall(targetDir, {
      ...environment,
      FAKE_ENGINE_EXIT: "137",
      FAKE_ENGINE_WRITTEN: engineWritten,
      FAKE_ENGINE_LEAVES: JSON.stringify({
        ".orbit-install-staging.test/x": "half-written staging file\n",
        ".orbit-engine.lock": "",
        "docker-compose.yml": "services: {}\n",
        "scripts/orbit-ops.sh": "#!/bin/sh\n",
        ".env-orbit": "APP_URL=https://overwritten-by-a-half-commit.internal\n",
      }),
      FAKE_ENGINE_PERSON_WRITES: JSON.stringify({ path: "notes.txt", content: personNotes }),
    });
    expect(result.status).toBe(1);
    expectFolderPutBack(result, targetDir, before);
    expect(stagingLeftovers(targetDir)).toEqual([]);
    expect(existsSync(join(targetDir, ".orbit-engine.lock"))).toBe(false);
    const kept = expectMovedAside(result, targetDir, "notes.txt", personNotes);
    expect(result.stderr).toContain("stopped without reporting a result (docker run exit status 137)");
    expect(result.stderr).toContain("This install was rolled back");
    expect(result.stderr).not.toContain("staging directory");
    // Redesign r5: the copy is released after a verified restore; the engine's files are removed, not kept.
    const stamp = dirname(dirname(kept));
    expect(existsSync(join(stamp, "originals"))).toBe(false);
    expect(filesNamed(backupsDir(targetDir), [".env-orbit", "oidc-client-secret", "docker-compose.yml", "orbit-ops.sh"])).toEqual([]);
    expect(filesNamed(stateRoot, [".env-orbit", "notes.txt"])).toEqual([]);
  });

  it("engine exits 137 with no outcome, nothing written: the folder is unchanged and the copy released", () => {
    const { targetDir, stateRoot, environment, before } = privateStateFixture();
    const result = runInstall(targetDir, { ...environment, FAKE_ENGINE_EXIT: "137" });
    expect(result.status).toBe(1);
    expect(treeSnapshot(targetDir)).toEqual(before);
    // Redesign r5: the copy lived in the folder and is gone with its folders.
    expect(backups(targetDir)).toEqual([]);
    expect(filesNamed(stateRoot, [".env-orbit", "oidc-client-secret"])).toEqual([]);
    expect(result.stderr).not.toContain("staging directory");
  });

  it("guard: engine exits 137 with no outcome on an update: the folder is unchanged and nothing claims a rollback", () => {
    const targetDir = makeTarget();
    makePreprovisionedDeployment(targetDir);
    expect(runInstall(targetDir).status).toBe(0);
    const before = treeSnapshot(targetDir);
    const own = recognisedVolume("orbit");
    const result = runInstall(
      targetDir,
      { FAKE_VOLUMES: own.volume, FAKE_PS: JSON.stringify(own.ps), FAKE_CONTAINER_IMAGES: JSON.stringify(own.images), FAKE_ENGINE_EXIT: "137" },
      ["--update"],
    );
    expect(result.status).toBe(1);
    expect(treeSnapshot(targetDir)).toEqual(before);
    expect(result.stderr).toContain("A hard interruption leaves its staging directory for review");
    expect(result.stderr).not.toContain("rolled back");
  });
});

// Redesign r1: an empty folder. The real engine cannot commit an unattended
// install into an empty folder (it needs answers), so the commit is staged by
// the canned engine: FAKE_ENGINE_LEAVES writes the tree a real engine committed
// (from one real install of a pre-provisioned folder), then a fresh `ok`
// outcome is written.
let committedLeaves;
let committedJournal;
function emptyFolderCommit() {
  if (!committedLeaves) {
    const source = makeTarget();
    makePreprovisionedDeployment(source);
    expect(runInstall(source).status).toBe(0);
    const leaves = {};
    const walk = (relative) => {
      for (const name of readdirSync(join(source, relative)).sort()) {
        const path = relative ? `${relative}/${name}` : name;
        const stats = lstatSync(join(source, path));
        const mode = stats.mode & 0o777;
        if (stats.isSymbolicLink()) {
          leaves[path] = { symlink: readlinkSync(join(source, path)) };
        } else if (stats.isDirectory()) {
          leaves[`${path}/`] = { mode };
          walk(path);
        } else {
          leaves[path] = { base64: readFileSync(join(source, path)).toString("base64"), mode };
        }
      }
    };
    walk("");
    committedLeaves = `@${join(scratchDir("committed-tree"), "leaves.json")}`;
    writeFileSync(committedLeaves.slice(1), JSON.stringify(leaves));
    // The current engine journals every file it may write, by full relative
    // path, before it touches the folder; .orbit-secrets/ is claimed whole.
    committedJournal = [
      ...Object.keys(leaves).filter((path) => !path.endsWith("/") && !path.startsWith(".orbit-secrets/")),
      ".orbit-secrets/",
    ].join("\n");
  }
  return {
    FAKE_ENGINE_WRITTEN: committedJournal,
    FAKE_ENGINE_EXIT: "0",
    FAKE_ENGINE_OUTCOME: "status=ok\nfresh=1\nprofile=standard\nmodel-pull=0\ndatabase-volume=\n",
    FAKE_ENGINE_LEAVES: committedLeaves,
  };
}

describe("install.sh: an interrupt while the engine runs, empty folder (redesign r1)", () => {
  it("SIGTERM after the engine committed: the folder is empty again, the output says it was rolled back, and a rerun installs", async () => {
    const targetDir = makeTarget();
    const stateDir = scratchDir("state");
    const xdg = scratchDir("xdg");
    const stateRoot = join(xdg, "orbit");
    const result = await runInstallSignalled(
      targetDir,
      { ...emptyFolderCommit(), FAKE_STATE_DIR: stateDir, XDG_STATE_HOME: xdg, FAKE_ENGINE_HANG_AFTER: "1" },
      { signal: "SIGTERM", marker: "hung-engine" },
    );
    expect(result.signalSent).toBe(true);
    expect(result.status).not.toBe(0);
    expect(targetEntries(targetDir)).toEqual([]);
    expect(result.stderr).toContain("was rolled back");
    expect(result.stderr).toContain("You can install again");
    expect(result.stderr).not.toContain("did not write");
    expect(result.stderr).not.toContain("Move these out");
    expect(result.stderr).not.toContain("could not be fully rolled back");
    expect(terminalFailure(result.stdout)).toMatch(/ action=retry /u);
    expect(rollbackEntries(stateRoot)).toEqual([]);

    const retried = runInstall(targetDir, { ...emptyFolderCommit(), XDG_STATE_HOME: xdg });
    expect(retried.status).toBe(0);
    expect(retried.stdout).toContain("Orbit is ready.");
  });

  it("guard: SIGTERM before the engine committed: the folder stays empty and a rerun installs", async () => {
    const targetDir = makeTarget();
    const stateDir = scratchDir("state");
    const xdg = scratchDir("xdg");
    const result = await runInstallSignalled(
      targetDir,
      { ...emptyFolderCommit(), FAKE_STATE_DIR: stateDir, XDG_STATE_HOME: xdg, FAKE_ENGINE_HANG_BEFORE: "1" },
      { signal: "SIGTERM", marker: "hung-engine" },
    );
    expect(result.signalSent).toBe(true);
    expect(targetEntries(targetDir)).toEqual([]);
    expect(runInstall(targetDir, { ...emptyFolderCommit(), XDG_STATE_HOME: xdg }).status).toBe(0);
  });
});

// ---------------------------------------------------------------------------
// Redesign r2: the rollback removes only what the engine's journal names, and
// moves anything else new aside, so a file the person saved while the engine
// was still running is kept (T1-T5, T7-T10; T6 replaced r1's half-commit test
// above). Written from the specification alone, before the fix.
// ---------------------------------------------------------------------------

describe("install.sh: a file saved while the engine runs survives an interrupt (redesign r2)", () => {
  const personWrites = { FAKE_ENGINE_PERSON_WRITES: JSON.stringify({ path: "notes.txt", content: personNotes }) };

  it("B22 (T1 re-homed): SIGTERM after the real engine committed: the folder is put back, the person's file moved into <stamp>/moved, the engine's files removed, the copy released, and a rerun installs", async () => {
    const { targetDir, stateRoot, environment, before } = privateStateFixture();
    const result = await runInstallSignalled(
      targetDir,
      { ...environment, ...personWrites, FAKE_ENGINE_HANG_AFTER: "1" },
      { signal: "SIGTERM", marker: "hung-engine" },
    );
    expect(result.signalSent).toBe(true);
    expect(result.status).toBe(143);
    expectFolderPutBack(result, targetDir, before);
    const kept = expectMovedAside(result, targetDir, "notes.txt", personNotes);
    expect(existsSync(join(dirname(dirname(kept)), "originals"))).toBe(false);
    // Section 13.2: the EXIT trap's closing line, on an interrupt.
    const closing = result.stderr.split("\n").find((line) => line.includes("The install stopped before it finished (interrupted"));
    expect(closing).toBeDefined();
    expect(closing).toContain("and was rolled back: the folder is as it was before");
    expect(closing.endsWith(interruptClosing)).toBe(true);
    expect(result.stderr).not.toContain(failClosing);
    expect(filesNamed(backupsDir(targetDir), ["docker-compose.yml", "orbit-ops.sh"])).toEqual([]);
    expect(filesNamed(stateRoot, ["notes.txt", "docker-compose.yml", "scripts"])).toEqual([]);

    const retried = runInstall(targetDir, environment);
    expect(retried.status).toBe(0);
    expect(retried.stdout).toContain("Orbit is ready.");
  });

  it("T2: SIGTERM before the real engine commits: the person's file is moved aside, the folder put back, and a rerun installs", async () => {
    const { targetDir, stateRoot, environment, before } = privateStateFixture();
    const result = await runInstallSignalled(
      targetDir,
      { ...environment, ...personWrites, FAKE_ENGINE_HANG_BEFORE: "1" },
      { signal: "SIGTERM", marker: "hung-engine" },
    );
    expect(result.signalSent).toBe(true);
    expectMovedAside(result, targetDir, "notes.txt", personNotes);
    expectFolderPutBack(result, targetDir, before);
    expect(filesNamed(stateRoot, ["notes.txt"])).toEqual([]);
    expect(runInstall(targetDir, environment).status).toBe(0);
  });

});

describe("install.sh: a file saved while the engine ran survives a failed start (redesign r2)", () => {
  it("T5: the real engine completes, the person saves a file, compose up fails: the folder is put back, the file moved aside, the engine's files removed", () => {
    const { targetDir, stateRoot, environment, before } = privateStateFixture();
    const result = runInstall(targetDir, {
      ...environment,
      FAKE_ENGINE_PERSON_WRITES: JSON.stringify({ path: "notes.txt", content: personNotes }),
      FAKE_COMPOSE_UP_FAIL: "1",
    });
    expect(result.status).toBe(1);
    expectFolderPutBack(result, targetDir, before);
    expectMovedAside(result, targetDir, "notes.txt", personNotes);
    expect(filesNamed(backupsDir(targetDir), ["docker-compose.yml", "orbit-ops.sh"])).toEqual([]);
    expect(filesNamed(stateRoot, ["notes.txt", "docker-compose.yml", "scripts"])).toEqual([]);
  });
});

describe("install.sh: an engine killed hard, by what its journal says (redesign r2)", () => {
  it("T7: no journal, only staging and the lock left: both removed by their fixed names, the folder put back, nothing moved, the copy released", () => {
    const { targetDir, stateRoot, environment, before } = privateStateFixture();
    const result = runInstall(targetDir, {
      ...environment,
      FAKE_ENGINE_EXIT: "137",
      FAKE_ENGINE_LEAVES: JSON.stringify({
        ".orbit-install-staging.test/x": "half-written staging file\n",
        ".orbit-engine.lock": "",
      }),
    });
    expect(result.status).toBe(1);
    expect(stagingLeftovers(targetDir)).toEqual([]);
    expect(existsSync(join(targetDir, ".orbit-engine.lock"))).toBe(false);
    expectFolderPutBack(result, targetDir, before);
    // Redesign r5: nothing moved and the copy released, so no orbit-install-backups is left.
    expect(existsSync(backupsDir(targetDir))).toBe(false);
    expect(filesNamed(stateRoot, [".env-orbit"])).toEqual([]);
    expect(result.stderr).toContain("This install was rolled back");
  });

  it.each([
    ["a name that climbs out of the folder", "../x\ndocker-compose.yml"],
    // Redesign r5 (section 2): a slash is now allowed (full relative paths), so this row is a `.` component instead.
    ["a `.` component", "./docker-compose.yml\ndocker-compose.yml"],
  ])("T8: a journal with %s is rejected: docker-compose.yml is moved aside, not deleted, and the folder put back", (_label, written) => {
    const { targetDir, stateRoot, environment, before } = privateStateFixture();
    const result = runInstall(targetDir, {
      ...environment,
      FAKE_ENGINE_EXIT: "137",
      FAKE_ENGINE_WRITTEN: written,
      FAKE_ENGINE_LEAVES: JSON.stringify({ "docker-compose.yml": "services: {}\n" }),
    });
    expect(result.status).toBe(1);
    expectMovedAside(result, targetDir, "docker-compose.yml", "services: {}\n");
    expectFolderPutBack(result, targetDir, before);
    expect(filesNamed(stateRoot, ["docker-compose.yml"])).toEqual([]);
    // Redesign r3 U6, in r4 N11's wording: the missing (here, rejected) journal is named.
    expect(result.stderr).toContain("did not record which files it wrote");
    expectNoRecoveryField(result.stdout);
  });

  it("T9: an older image writes no journal: staging is removed, docker-compose.yml moved aside, the folder put back, and the copy released (redesign r5)", () => {
    const { targetDir, stateRoot, environment, before } = privateStateFixture();
    const result = runInstall(targetDir, {
      ...environment,
      FAKE_ENGINE_EXIT: "137",
      FAKE_ENGINE_LEAVES: JSON.stringify({
        "docker-compose.yml": "services: {}\n",
        ".orbit-install-staging.test/x": "half-written staging file\n",
      }),
    });
    expect(result.status).toBe(1);
    expect(stagingLeftovers(targetDir)).toEqual([]);
    const kept = expectMovedAside(result, targetDir, "docker-compose.yml", "services: {}\n");
    expectFolderPutBack(result, targetDir, before);
    expect(existsSync(join(dirname(dirname(kept)), "originals"))).toBe(false);
    expect(filesNamed(stateRoot, [".env-orbit", "docker-compose.yml"])).toEqual([]);
    // Redesign r3 U6, in r4 N11's wording: the missing journal is named.
    expect(result.stderr).toContain("did not record which files it wrote");
    expectNoRecoveryField(result.stdout);
  });
});

// ---------------------------------------------------------------------------
// Redesign r3 (U1-U7): the rollback states its rule for .env-orbit and
// .orbit-secrets; with no journal and a failed `down` the folder is left as
// committed; a person's file is never listed for deletion; the engine's own
// scratch names are cleared; a missing journal is named. Written from the
// specification alone, before the fix.
// ---------------------------------------------------------------------------

/**
 * The canned committed engine's journal. Redesign r5 (section 2): full relative paths, a directory the engine owns whole
 * with a trailing slash; it claims every file committedCanned leaves (section 9 lists the first four; scripts/installer-ui.sh
 * is left too, as guarantee #5 needs it, so it is claimed too).
 */
const engineWritten = [".env-orbit", ".orbit-secrets/", "docker-compose.yml", "scripts/orbit-ops.sh", "scripts/installer-ui.sh"].join("\n");

/**
 * The committed canned engine: an `ok` fresh outcome, its journal unless `journal` is false, and docker-compose.yml and
 * scripts/orbit-ops.sh left in the folder. A commit always carries the .env-orbit and installer UI helper the installer
 * reads next (guarantee #5), so those, and docker-compose.yml, are taken from the real engine's committed tree.
 */
function committedCanned({ journal = true } = {}) {
  const realTree = JSON.parse(readFileSync(emptyFolderCommit().FAKE_ENGINE_LEAVES.slice(1), "utf8"));
  return {
    FAKE_ENGINE_EXIT: "0",
    FAKE_ENGINE_OUTCOME: "status=ok\nfresh=1\nprofile=standard\nmodel-pull=0\ndatabase-volume=\n",
    ...(journal ? { FAKE_ENGINE_WRITTEN: engineWritten } : {}),
    FAKE_ENGINE_LEAVES: JSON.stringify({
      ".env-orbit": realTree[".env-orbit"],
      "docker-compose.yml": realTree["docker-compose.yml"],
      "scripts/installer-ui.sh": realTree["scripts/installer-ui.sh"],
      "scripts/orbit-ops.sh": "#!/bin/sh\n",
    }),
  };
}

describe("install.sh: the rollback states its rule for .env-orbit and .orbit-secrets (redesign r3)", () => {
  it("U1: a file added to .orbit-secrets while the engine ran is replaced with the folder, and the rule is stated", () => {
    const { targetDir, stateRoot, environment, before } = privateStateFixture();
    const result = runInstall(targetDir, {
      ...environment,
      ...committedCanned(),
      FAKE_ENGINE_PERSON_WRITES: JSON.stringify({ path: ".orbit-secrets/extra-secret", content: "added while the engine ran\n" }),
      FAKE_COMPOSE_UP_FAIL: "1",
    });
    expect(result.status).toBe(1);
    expect(terminalFailure(result.stdout)).toMatch(/ action=retry /u);
    expect(treeSnapshot(targetDir)).toEqual(before);
    // Redesign r4 (N10): the rule now lives in the closing "rolled back" line.
    expect(result.stderr.split("\n").find((line) => line.includes("This install was rolled back"))).toContain("put back as a unit");
    expectNoRecoveryField(result.stdout);
    expect(result.stderr).toContain("This install was rolled back");
    expect(filesNamed(stateRoot, ["extra-secret"])).toEqual([]);
  });

  it("U2: an empty folder had nothing to put back, so the rule is not stated", () => {
    const result = runInstall(makeTarget(), { ...committedCanned(), FAKE_COMPOSE_UP_FAIL: "1" });
    expect(result.status).toBe(1);
    expect(result.stderr).not.toContain("put back exactly as they were");
  });
});

describe("install.sh: the engine's own scratch names are cleared (redesign r3)", () => {
  const scratchNames = [".env-orbit.migrating.ab12cd", ".env-orbit.installing.ab12cd", ".env-orbit.updating.ab12cd", ".orbit-engine.lock.stale-4242"];

  it.each([["a pre-provisioned folder", true], ["an empty folder", false]])("U5: engine exits 137 leaving its scratch files in %s: the folder is put back and nothing is moved out", (_label, preprovisioned) => {
    const fixture = privateStateFixture();
    const { stateRoot, environment } = fixture;
    const targetDir = preprovisioned ? fixture.targetDir : makeTarget();
    const before = preprovisioned ? fixture.before : undefined;
    const result = runInstall(targetDir, {
      ...environment,
      FAKE_ENGINE_EXIT: "137",
      FAKE_ENGINE_WRITTEN: engineWritten,
      FAKE_ENGINE_LEAVES: JSON.stringify(Object.fromEntries(scratchNames.map((name) => [name, "engine scratch\n"]))),
    });
    expect(result.status).toBe(1);
    expectFolderPutBack(result, targetDir, before);
    expect(filesNamed(stateRoot, scratchNames)).toEqual([]);
    // Redesign r5: scratch names are removed, never moved, so no orbit-install-backups is made.
    expect(existsSync(backupsDir(targetDir))).toBe(false);
    expect(result.stderr).not.toContain("moved, not deleted");
    expect(result.stderr).toContain("This install was rolled back");
    expect(filesNamed(stateRoot, [".env-orbit"])).toEqual([]);
  });
});

describe("install.sh: the rollback names a missing journal (redesign r3)", () => {
  it("U6: no journal and a failed start: docker-compose.yml is moved out, and the output says the engine did not record which files it wrote", () => {
    const { targetDir, stateRoot, environment, before } = privateStateFixture();
    const result = runInstall(targetDir, { ...environment, ...committedCanned({ journal: false }), FAKE_COMPOSE_UP_FAIL: "1" });
    expect(result.status).toBe(1);
    expectFolderPutBack(result, targetDir, before);
    // Redesign r5: moved into <folder>/orbit-install-backups/<stamp>/moved, never under the state root.
    const kept = filesNamed(backupsDir(targetDir), ["docker-compose.yml"]);
    expect(kept).toHaveLength(1);
    expect(kept[0]).toMatch(/\/orbit-install-backups\/\d{8}T\d{6}Z(-[2-9])?\/moved\/docker-compose\.yml$/u);
    expect(filesNamed(stateRoot, ["docker-compose.yml"])).toEqual([]);
    expect(result.stderr).toContain("did not record which files it wrote");
    expectNoRecoveryField(result.stdout);
    expect(result.stderr).toContain("so everything new was moved, not deleted");
    expect(result.stderr).toContain(dirname(kept[0]));
    expect(result.stderr).not.toContain("Delete that directory");
    expect(result.stderr).not.toContain("Files this install did not write");
  });

  it("U7: with a journal the line names files this install did not write, moved, not deleted", () => {
    const { targetDir, environment } = privateStateFixture();
    const result = runInstall(targetDir, {
      ...environment,
      ...committedCanned(),
      FAKE_ENGINE_PERSON_WRITES: JSON.stringify({ path: "notes.txt", content: personNotes }),
      FAKE_COMPOSE_UP_FAIL: "1",
    });
    expect(result.status).toBe(1);
    expect(result.stderr).toContain("Files this install did not write were moved, not deleted");
    expect(result.stderr).not.toContain("did not say which files");
  });
});

// ---------------------------------------------------------------------------
// Redesign r5 (.agents/reviews/v0.3.1-mr1074/redesign-r5.md, #1456): no state
// between runs. The start record (originals/), the files moved aside (moved/)
// and, when the containers could not be stopped, the files the engine wrote
// (engine/) live in <folder>/orbit-install-backups/<stamp>/; nothing is
// written under HOME, XDG_STATE_HOME or TMPDIR, and nothing is ever deleted
// that the engine's journal does not claim. B1-B26 (section 9), written from
// the design alone, before the fix.
// ---------------------------------------------------------------------------

const backupsName = "orbit-install-backups";
/** "Stamp": the run's UTC start time to the second, `-2`..`-9` appended on a collision. */
const stampPattern = /^\d{8}T\d{6}Z(-[2-9])?$/u;
const recoveryPrefix = "recovery-command: ";
/**
 * The one command after a failed `down` (sections 5 and 13.1): run from the dated folder's engine/, then this attempt's
 * volumes by exact name on the same line (absent when the attempt created none, or the listing failed).
 */
const r5DownCommand =
  /^cd \S.*\/orbit-install-backups\/\d{8}T\d{6}Z(-[2-9])?\/engine && docker compose --project-name \S+ --env-file \.env-orbit down --remove-orphans( && docker volume rm -- \S+( \S+)*)?$/u;
const volumesPart = " && docker volume rm -- ";
/** The stderr line after a down-failed command that names no volume (section 13.1). */
const noVolumesLine = "If the next install names a volume this install left, remove that volume by the name it prints.";
/** Closing lines (section 13.2): a planned failure, and an interrupt or unplanned exit. */
const failClosing = "Fix the cause, then install again.";
const interruptClosing = "You can install again.";
/** Never printed on any path ("moved, not deleted" is allowed and expected). */
const forbiddenWords = [
  "rm -rf",
  "cp -a",
  "rm -r",
  "volume prune",
  "Delete that",
  "delete it",
  "move out",
  "Move these",
  "or delete",
  "Install again to finish",
  "recovery record",
  "Clear what is named above",
];

/** The recovery-command contract (addendum): one plain stdout line carrying the command, just before the terminal event, which ends ` recovery=command`. */
function expectRecoveryCommand(result, command, action) {
  const out = result.stdout.split("\n");
  const found = out.filter((line) => line.startsWith(recoveryPrefix));
  expect(found).toHaveLength(1);
  expect(found[0].slice(recoveryPrefix.length)).toBe(command);
  const terminal = terminalFailure(result.stdout);
  expect(terminal).toBeDefined();
  expect(out[out.lastIndexOf(terminal) - 1]).toBe(found[0]);
  expect(terminal.endsWith(" recovery=command")).toBe(true);
  expect(terminal).toMatch(new RegExp(` action=${action} `, "u"));
}

/** No recovery command offered: no `recovery-command:` line and no `recovery=` on any event. */
function expectNoRecoveryField(stdout) {
  expect(stdout.split("\n").filter((line) => line.startsWith(recoveryPrefix))).toEqual([]);
  expect(eventLines(stdout).filter((line) => line.includes("recovery="))).toEqual([]);
}

/** "No command": none on stderr, no `recovery-command:` line, no `recovery=` on any event. */
function expectNoCommand(result) {
  expect(recoveryCommands(result.stderr)).toEqual([]);
  expectNoRecoveryField(result.stdout);
}

function expectNoForbiddenWords(stderr) {
  for (const word of forbiddenWords) expect(stderr, `stderr says "${word}"`).not.toContain(word);
}

function backupsDir(targetDir) {
  return join(targetDir, backupsName);
}

/** Sorted names under <target>/orbit-install-backups; [] when the directory is absent. */
function backups(targetDir) {
  return existsSync(backupsDir(targetDir)) ? readdirSync(backupsDir(targetDir)).sort() : [];
}

function modeOf(path) {
  return statSync(path).mode & 0o777;
}

/** The one dated folder this run made (every name not in `earlier`), as a path. */
function onlyStamp(targetDir, earlier = []) {
  const made = backups(targetDir).filter((name) => !earlier.includes(name));
  expect(made).toHaveLength(1);
  expect(made[0]).toMatch(stampPattern);
  return join(backupsDir(targetDir), made[0]);
}

/** The folder's own tree, leaving out orbit-install-backups/. */
function ownTree(targetDir) {
  return Object.fromEntries(Object.entries(treeSnapshot(targetDir)).filter(([path]) => path !== `${backupsName}/` && !path.startsWith(`${backupsName}/`)));
}

/** The start record's two entries in a treeSnapshot: .env-orbit and everything under .orbit-secrets. */
function originalsIn(snapshot) {
  return Object.fromEntries(Object.entries(snapshot).filter(([path]) => path === ".env-orbit" || path.startsWith(".orbit-secrets/")));
}

function closingLine(stderr) {
  return stderr.split("\n").find((line) => line.includes("This install was rolled back"));
}

/** A UTC stamp for `ms`, as `date -u +%Y%m%dT%H%M%SZ` prints it. */
function stampAt(ms) {
  return new Date(ms).toISOString().replace(/[-:]/gu, "").replace(/\.\d{3}Z$/u, "Z");
}

const personNotesWrite = { FAKE_ENGINE_PERSON_WRITES: JSON.stringify({ path: "notes.txt", content: personNotes }) };

/** B11's knobs: the committed canned engine, the person's notes.txt, then `up` and `down` both fail. */
function r5DownFailedKnobs({ journal = true } = {}) {
  return { ...committedCanned({ journal }), ...personNotesWrite, FAKE_COMPOSE_UP_FAIL: "1", FAKE_COMPOSE_DOWN_FAIL: "1" };
}

/** Runs a printed command with bash from a scratch directory, through the paste fake and the strict Compose fake. */
function runPasted(command, stateDir) {
  const scratch = scratchDir("elsewhere");
  const logs = scratchDir("pasted-log");
  const ran = failOnProcessDeadline(
    spawnSync("bash", ["-c", command], {
      cwd: scratch,
      env: { PATH: `${makePasteBin()}:${process.env.PATH}`, HOME: logs, FAKE_STATE_DIR: stateDir, FAKE_COMPOSE_STRICT: "1", FAKE_CALL_LOG: join(logs, "calls.log") },
      encoding: "utf8",
      ...processGuard(),
    }),
    { label: "pasted recovery command" },
  );
  const strict = readOptional(join(stateDir, "strict-log")).split("\n").filter(Boolean);
  return { ran, scratch, loaded: strict.length > 0 ? JSON.parse(strict.at(-1)) : undefined };
}

/** No copy of the folder's files under the state root, the home's .local or TMPDIR. */
function expectNothingPrivate({ stateRoot, home, tmp }) {
  for (const root of [stateRoot, join(home, ".local"), tmp]) expect(filesNamed(root, [".env-orbit", ".orbit-secrets"]), root).toEqual([]);
}

describe("install.sh: a complete rollback, with backups inside the folder (redesign r5)", () => {
  it("B1: nothing of the person's: the folder as found, no orbit-install-backups, nothing under the state root, home or TMPDIR, and the same after a success", () => {
    const { targetDir, environment, before, stateRoot, home, tmp } = privateStateFixture();
    const result = runInstall(targetDir, { ...environment, FAKE_COMPOSE_UP_FAIL: "1" });
    expect(result.status).toBe(1);
    expect(terminalFailure(result.stdout)).toMatch(/ action=retry /u);
    expect(treeSnapshot(targetDir)).toEqual(before);
    expect(backups(targetDir)).toEqual([]);
    expect(existsSync(backupsDir(targetDir))).toBe(false);
    expectNothingPrivate({ stateRoot, home, tmp });
    const closing = closingLine(result.stderr);
    expect(closing).toBeDefined();
    expect(closing).toContain("put back as a unit");
    expect(closing.endsWith(failClosing)).toBe(true);
    expectNoForbiddenWords(result.stderr);
    expectNoCommand(result);

    const fresh = privateStateFixture();
    const succeeded = runInstall(fresh.targetDir, fresh.environment);
    expect(succeeded.status).toBe(0);
    expect(succeeded.stdout).toContain("Orbit is ready.");
    expect(backups(fresh.targetDir)).toEqual([]);
    expectNothingPrivate(fresh);
  });

  it("B2 (and B10's copy modes): while the run is in flight the copy is in orbit-install-backups/<stamp>/originals, every directory 0700, the secret 0600, and none in the state root or TMPDIR", () => {
    const { targetDir, stateDir, stateRoot, tmp, environment } = privateStateFixture();
    const result = runInstall(targetDir, {
      ...environment,
      FAKE_SNAPSHOT_ROOTS: JSON.stringify({ tmp, xdg: stateRoot, target: targetDir }),
      FAKE_COMPOSE_UP_FAIL: "1",
    });
    expect(result.status).toBe(1);
    const during = JSON.parse(readFileSync(join(stateDir, "snapshot.json"), "utf8"));
    const envCopies = during.target.filter((entry) => /\/orbit-install-backups\/\d{8}T\d{6}Z(-[2-9])?\/originals\/\.env-orbit$/u.test(entry.path));
    expect(envCopies).toHaveLength(1);
    const originals = dirname(envCopies[0].path);
    expect(dirname(dirname(originals))).toBe(backupsDir(targetDir));
    const secretCopy = during.target.find((entry) => entry.path === join(originals, ".orbit-secrets", "oidc-client-secret"));
    expect(secretCopy).toBeDefined();
    expect(secretCopy.mode).toBe("600");
    for (const directory of [backupsDir(targetDir), dirname(originals), originals, join(originals, ".orbit-secrets")]) {
      expect(during.target.find((entry) => entry.path === directory)?.mode, directory).toBe("700");
    }
    expect(during.xdg.filter((entry) => entry.name === ".env-orbit")).toEqual([]);
    expect(during.tmp.filter((entry) => entry.name === ".env-orbit")).toEqual([]);
  });

  it("B18: verification is real: an .env-orbit overwritten during `compose up` is put back with the original bytes, and the copy released", () => {
    const { targetDir, environment, before } = privateStateFixture();
    const original = readFileSync(join(targetDir, ".env-orbit"));
    const result = runInstall(targetDir, {
      ...environment,
      FAKE_UP_ADDS_FILE: JSON.stringify({ path: join(targetDir, ".env-orbit"), content: "APP_URL=https://overwritten-during-compose-up.internal\n" }),
      FAKE_COMPOSE_UP_FAIL: "1",
    });
    expect(result.status).toBe(1);
    expect(readFileSync(join(targetDir, ".env-orbit"))).toEqual(original);
    expect(treeSnapshot(targetDir)).toEqual(before);
    expect(backups(targetDir)).toEqual([]);
  });

  it("B19: nothing is written under HOME, XDG_STATE_HOME or TMPDIR, whatever the run", () => {
    const home = scratchDir("b19-home");
    const tmp = scratchDir("b19-tmp");
    const xdg = scratchDir("b19-xdg");
    const stateRoot = join(xdg, "orbit");
    const roots = { HOME: home, TMPDIR: tmp, XDG_STATE_HOME: xdg };
    const expectNothingUnder = (label) => {
      expect(existsSync(stateRoot), `${label}: ${stateRoot}`).toBe(false);
      for (const root of [home, tmp]) expect(filesNamed(root, [".env-orbit", ".orbit-secrets", "notes.txt"]), `${label}: ${root}`).toEqual([]);
    };
    try {
      const b3 = recoveryFixture();
      expect(runInstall(b3.targetDir, { ...b3.environment, ...roots, ...committedCanned(), ...personNotesWrite, FAKE_COMPOSE_UP_FAIL: "1" }).status).toBe(1);
      expectNothingUnder("B3's run");
      const b11 = recoveryFixture();
      expect(runInstall(b11.targetDir, { ...b11.environment, ...roots, ...r5DownFailedKnobs() }).status).toBe(1);
      expectNothingUnder("B11's run");
      expect(runInstall(makeTarget(), { ...roots, ...committedCanned(), ...personNotesWrite, FAKE_COMPOSE_UP_FAIL: "1" }).status).toBe(1);
      expectNothingUnder("B6's run");
      const success = recoveryFixture();
      expect(runInstall(success.targetDir, { ...success.environment, ...roots }).status).toBe(0);
      expectNothingUnder("a success");
    } finally {
      // Only the roots this test made.
      for (const root of [home, tmp, xdg]) rmSync(root, { recursive: true, force: true });
    }
  });

  it("B26: the rollback never reads, runs, moves or deletes anything in an earlier run's folder; its own folder is a sibling", () => {
    const { targetDir, environment } = recoveryFixture();
    const old = join(backupsDir(targetDir), "20200101T000000Z");
    mkdirSync(join(old, "moved"), { recursive: true, mode: 0o700 });
    chmodSync(backupsDir(targetDir), 0o700);
    writeFileSync(join(old, "moved", "secret.txt"), "PLANTED");
    writeFileSync(join(old, "moved", "run-me.sh"), "echo EXECUTED\n", { mode: 0o755 });
    chmodSync(join(old, "moved", "run-me.sh"), 0o755);
    const oldBefore = treeSnapshot(old);
    const result = runInstall(targetDir, { ...environment, ...committedCanned({ journal: false }), FAKE_COMPOSE_UP_FAIL: "1" });
    expect(result.status).toBe(1);
    expect(treeSnapshot(old)).toEqual(oldBefore);
    expect(modeOf(join(old, "moved", "run-me.sh"))).toBe(0o755);
    for (const text of [result.stdout, result.stderr, result.calls]) {
      expect(text).not.toContain("PLANTED");
      expect(text).not.toContain("EXECUTED");
    }
    const stamp = onlyStamp(targetDir, ["20200101T000000Z"]);
    expect(dirname(stamp)).toBe(backupsDir(targetDir));
    expect(existsSync(join(stamp, "moved", "docker-compose.yml"))).toBe(true);
  });

  it("N10 (re-homed): the closing line carries the unit clause when there was something to put back, and only then", () => {
    const { targetDir, environment } = privateStateFixture();
    const preprovisioned = runInstall(targetDir, { ...environment, ...committedCanned(), FAKE_COMPOSE_UP_FAIL: "1" });
    expect(preprovisioned.status).toBe(1);
    const closing = preprovisioned.stderr.split("\n").find((line) => line.includes("This install was rolled back"));
    expect(closing).toBeDefined();
    expect(closing).toContain("put back as a unit");
    expectNoRecoveryField(preprovisioned.stdout);

    const empty = runInstall(makeTarget(), { ...committedCanned(), HOME: scratchDir("home"), XDG_STATE_HOME: scratchDir("xdg"), FAKE_COMPOSE_UP_FAIL: "1" });
    expect(empty.status).toBe(1);
    const emptyClosing = empty.stderr.split("\n").find((line) => line.includes("This install was rolled back"));
    expect(emptyClosing).toBeDefined();
    expect(emptyClosing).not.toContain("as a unit");
    expectNoRecoveryField(empty.stdout);
  });
});

describe("install.sh: the closing lines say what to do about the obstacle, and the docs match (round 6, #1456)", () => {
  // R6-1, R6-2, R6-4 and R6-5 make a directory read-only; give it back so the scratch directories can be removed.
  const lockedDirectories = [];
  afterEach(() => {
    for (const directory of lockedDirectories.splice(0)) {
      try {
        chmodSync(directory, 0o700);
      } catch {
        // already gone
      }
    }
  });

  /** The engine leaves its committed tree with scripts/ read-only, so the rollback cannot remove it. */
  function lockedScriptsKnobs(targetDir) {
    const canned = committedCanned();
    const leaves = { ...JSON.parse(canned.FAKE_ENGINE_LEAVES), "scripts/": { mode: 0o500 } };
    lockedDirectories.push(join(targetDir, "scripts"));
    return { ...canned, FAKE_ENGINE_LEAVES: JSON.stringify(leaves), FAKE_COMPOSE_UP_FAIL: "1" };
  }

  const stderrLines = (stderr) => stderr.split("\n");

  it.skipIf(process.geteuid?.() === 0)("R6-1: the folder failed and volumes could not be removed: each volume is named, then `docker volume rm --` alone on a line, `abort`, no recovery field", () => {
    const { targetDir, environment, preexistingVolumes } = recoveryFixture();
    const result = runInstall(targetDir, { ...environment, ...lockedScriptsKnobs(targetDir), FAKE_VOLUME_RM_FAIL: "1" });
    lockedDirectories.push(...directoriesNamed(targetDir, "scripts"));
    expect(result.status).toBe(1);
    expect(terminalFailure(result.stdout)).toMatch(/ action=abort /u);
    expectNoRecoveryField(result.stdout);
    const lines = stderrLines(result.stderr);
    expect(result.stderr).toContain("Could not remove");
    expect(result.stderr).toContain(join(targetDir, "scripts"));
    for (const volume of allThreeVolumes) expect(lines, volume).toContain(`Orbit installer: The volume ${volume} could not be removed.`);
    for (const volume of preexistingVolumes) expect(result.stderr).not.toContain(`The volume ${volume} could not be removed`);
    const intro = lines.indexOf("Orbit installer: To remove the volumes, run this in a terminal:");
    expect(intro).toBeGreaterThanOrEqual(0);
    const command = lines[intro + 1];
    expect(command).toMatch(/^docker volume rm -- /u);
    expect(command.slice("docker volume rm -- ".length).split(" ").sort()).toEqual(allThreeVolumes);
    for (const volume of preexistingVolumes) expect(command).not.toContain(volume);
    expect(lines.filter((line) => line.startsWith("docker volume rm -- "))).toEqual([command]);
    expectNoForbiddenWords(result.stderr);
  });

  it.skipIf(process.geteuid?.() === 0)("R6-2: the folder failed and the volumes could not be listed: the listing line is printed, and the folder obstacle", () => {
    const targetDir = makeTarget();
    const home = scratchDir("home");
    const xdg = scratchDir("xdg");
    const result = runInstall(targetDir, { ...lockedScriptsKnobs(targetDir), HOME: home, XDG_STATE_HOME: xdg, FAKE_VOLUME_LS_FAIL_AFTER_UP: "1" });
    lockedDirectories.push(...directoriesNamed(targetDir, "scripts"));
    expect(result.status).toBe(1);
    expect(terminalFailure(result.stdout)).toMatch(/ action=abort /u);
    expectNoRecoveryField(result.stdout);
    expect(result.stderr).toContain("Could not remove");
    expect(result.stderr).toContain(join(targetDir, "scripts"));
    expect(stderrLines(result.stderr)).toContain(
      "Orbit installer: The volumes this install created could not be listed. If the next install names a volume this install left, remove that volume by the name it prints.",
    );
    expect(result.stderr).toContain("could not be listed");
    expect(stderrLines(result.stderr).filter((line) => line.startsWith("docker volume rm -- "))).toEqual([]);
    expectNoForbiddenWords(result.stderr);
  });

  it.skipIf(process.geteuid?.() === 0)("R6-3: an original cannot be put back: one line says to replace the live path with the copy, and nothing says to clear anything", () => {
    const { targetDir, environment } = recoveryFixture();
    const canned = committedCanned();
    const leaves = {
      ...JSON.parse(canned.FAKE_ENGINE_LEAVES),
      ".orbit-secrets/locked/": { mode: 0o500 },
      ".orbit-secrets/locked/x": "a file the rollback cannot remove\n",
    };
    lockedDirectories.push(join(targetDir, ".orbit-secrets", "locked"));
    const result = runInstall(targetDir, { ...environment, ...canned, FAKE_ENGINE_LEAVES: JSON.stringify(leaves), FAKE_COMPOSE_UP_FAIL: "1" });
    lockedDirectories.push(...directoriesNamed(targetDir, "locked"));
    expect(result.status).toBe(1);
    expect(terminalFailure(result.stdout)).toMatch(/ action=abort /u);
    const stamp = onlyStamp(targetDir);
    expect(stderrLines(result.stderr)).toContain(
      `Orbit installer: Replace ${join(targetDir, ".orbit-secrets")} with the copy in ${join(stamp, "originals", ".orbit-secrets")}, then install again.`,
    );
    expect(result.stderr).not.toContain("Clear");
    expect(result.stderr).not.toContain("Clear what is named above");
    expectNoForbiddenWords(result.stderr);
  });

  it.skipIf(process.geteuid?.() === 0)("R6-4: nothing could be moved because the backups folder could not be made: the containers-and-volumes-removed line, `abort`, no `Clear`", () => {
    // An empty folder; the engine leaves only the person's file and then the folder itself read-only, so orbit-install-backups/ cannot be made.
    const targetDir = makeTarget();
    lockedDirectories.push(targetDir);
    const result = runInstall(targetDir, {
      ...committedCanned(),
      FAKE_ENGINE_LEAVES: JSON.stringify({ "notes.txt": personNotes, "/": { mode: 0o500 } }),
      HOME: scratchDir("home"),
      XDG_STATE_HOME: scratchDir("xdg"),
      FAKE_COMPOSE_UP_FAIL: "1",
    });
    expect(result.status).toBe(1);
    expect(terminalFailure(result.stdout)).toMatch(/ action=abort /u);
    expectNoRecoveryField(result.stdout);
    expect(result.stderr).toContain(backupsName);
    expect(stderrLines(result.stderr)).toContain(
      "Orbit installer: The containers and volumes were removed; the files this install wrote are still in the folder. Fix the cause named above, then install again.",
    );
    expect(result.stderr).not.toContain("Clear");
    expectNoForbiddenWords(result.stderr);
  });

  it.skipIf(process.geteuid?.() === 0)("R6-5: an engine entry cannot be removed and the originals were put back: the clear line, with the copy sentence because the copy line is printed", () => {
    const { targetDir, environment } = recoveryFixture();
    const result = runInstall(targetDir, { ...environment, ...lockedScriptsKnobs(targetDir) });
    lockedDirectories.push(...directoriesNamed(targetDir, "scripts"));
    expect(result.status).toBe(1);
    expect(terminalFailure(result.stdout)).toMatch(/ action=abort /u);
    const lines = stderrLines(result.stderr);
    const stamp = onlyStamp(targetDir);
    const copyLine = lines.find((line) => line.includes("A copy of this folder's original files is kept in"));
    expect(copyLine).toBeDefined();
    expect(copyLine).toContain(join(stamp, "originals"));
    expect(lines).toContain(
      "Orbit installer: Clear the entries this install could not remove, named above, then install again. The copy of your original files can stay where it is.",
    );
    expect(result.stderr).not.toContain("Clear what is named above");
    expectNoForbiddenWords(result.stderr);
  });

  it("R6-6: the docs state the unit rule and which folders are untouched", () => {
    const read = (name) => readFileSync(join(repositoryRoot, "docs", name), "utf8");
    const installing = read("installing.md");
    const events = read("engine-events.md");
    const guarantees = read("installer-guarantees.md");
    expect(installing).toContain("put back whole from the copy");
    expect(events).toContain("put back whole from the copy");
    expect(installing).not.toContain("It never deletes a file it did not write");
    for (const [name, text] of [["installing.md", installing], ["installer-guarantees.md", guarantees]]) {
      expect(text, name).not.toContain("never reads, runs, moves or deletes anything in it");
      expect(text, name).not.toContain("Nothing under `orbit-install-backups/` is read");
      expect(text, name).toContain("earlier run");
      expect(text, name).not.toContain("Clear what is named above");
    }
  });

  it("R6-7: a failed start after the commit leaves an earlier run's folder byte-identical, releases this run's own originals, and keeps its moved files", () => {
    const { targetDir, environment } = recoveryFixture();
    const old = join(backupsDir(targetDir), "20200101T000000Z");
    mkdirSync(join(old, "moved"), { recursive: true, mode: 0o700 });
    chmodSync(backupsDir(targetDir), 0o700);
    writeFileSync(join(old, "moved", "earlier.txt"), "AN EARLIER RUN");
    const oldBefore = treeSnapshot(old);
    const result = runInstall(targetDir, { ...environment, ...committedCanned(), ...personNotesWrite, FAKE_COMPOSE_UP_FAIL: "1" });
    expect(result.status).toBe(1);
    expect(treeSnapshot(old)).toEqual(oldBefore);
    const stamp = onlyStamp(targetDir, ["20200101T000000Z"]);
    expect(existsSync(join(stamp, "originals"))).toBe(false);
    expect(readOptional(join(stamp, "moved", "notes.txt"))).toBe(personNotes);
  });

  it("R6-8: a file the engine planted inside .orbit-secrets is gone after the rollback, the folder is byte-identical, and the closing line says it was put back as a unit", () => {
    const { targetDir, environment, before } = privateStateFixture();
    const result = runInstall(targetDir, {
      ...environment,
      ...committedCanned(),
      FAKE_ENGINE_PERSON_WRITES: JSON.stringify({ path: ".orbit-secrets/notes.txt", content: "planted after the commit\n" }),
      FAKE_COMPOSE_UP_FAIL: "1",
    });
    expect(result.status).toBe(1);
    expect(existsSync(join(targetDir, ".orbit-secrets", "notes.txt"))).toBe(false);
    expect(treeSnapshot(targetDir)).toEqual(before);
    const closing = result.stderr.split("\n").find((line) => line.includes("This install was rolled back"));
    expect(closing).toBeDefined();
    expect(closing).toContain("put back as a unit");
  });

  it.skipIf(process.geteuid?.() === 0)("R6-9: compose down fails and the backups folder cannot be made: the stop command is offered, no removed claim, the files-still-in-folder line, `abort`", () => {
    const targetDir = makeTarget();
    lockedDirectories.push(targetDir);
    const result = runInstall(targetDir, {
      ...committedCanned(),
      // The engine's usual files too, so `compose up` runs and `down` can fail (R6-4's bare fixture never starts Docker).
      FAKE_ENGINE_LEAVES: JSON.stringify({ ...JSON.parse(committedCanned().FAKE_ENGINE_LEAVES), "notes.txt": personNotes, "/": { mode: 0o500 } }),
      HOME: scratchDir("home"),
      XDG_STATE_HOME: scratchDir("xdg"),
      FAKE_COMPOSE_UP_FAIL: "1",
      FAKE_COMPOSE_DOWN_FAIL: "1",
    });
    expect(result.status).toBe(1);
    expect(terminalFailure(result.stdout)).toMatch(/ action=abort /u);
    expect(result.stderr).toContain("To stop the containers, run this in a terminal:");
    expect(result.stderr).not.toContain("The containers and volumes were removed");
    expect(stderrLines(result.stderr)).toContain(
      "Orbit installer: The files this install wrote are still in the folder. Fix the cause named above, then install again.",
    );
    expectNoForbiddenWords(result.stderr);
  });

  it.skipIf(process.geteuid?.() === 0)("R6-10: an original cannot be put back and an engine entry cannot be removed: both lines, with the copy sentence", () => {
    const { targetDir, environment } = recoveryFixture();
    const knobs = lockedScriptsKnobs(targetDir);
    const leaves = {
      ...JSON.parse(knobs.FAKE_ENGINE_LEAVES),
      ".orbit-secrets/locked/": { mode: 0o500 },
      ".orbit-secrets/locked/x": "a file the rollback cannot remove\n",
    };
    lockedDirectories.push(join(targetDir, ".orbit-secrets", "locked"));
    const result = runInstall(targetDir, { ...environment, ...knobs, FAKE_ENGINE_LEAVES: JSON.stringify(leaves) });
    lockedDirectories.push(...directoriesNamed(targetDir, "scripts"), ...directoriesNamed(targetDir, "locked"));
    expect(result.status).toBe(1);
    expect(terminalFailure(result.stdout)).toMatch(/ action=abort /u);
    const stamp = onlyStamp(targetDir);
    const lines = stderrLines(result.stderr);
    expect(lines).toContain(
      `Orbit installer: Replace ${join(targetDir, ".orbit-secrets")} with the copy in ${join(stamp, "originals", ".orbit-secrets")}, then install again.`,
    );
    expect(lines).toContain(
      "Orbit installer: Clear the entries this install could not remove, named above, then install again. The copy of your original files can stay where it is.",
    );
    expect(result.stderr).not.toContain("Clear what is named above");
    expectNoForbiddenWords(result.stderr);
  });
});

describe("install.sh: the journal lists files, and the person's files are moved, not deleted (redesign r5)", () => {
  it("B3: the person's top-level file is moved into <stamp>/moved, the folder put back, the copy released, and the output says where", () => {
    const { targetDir, environment, before } = recoveryFixture();
    const result = runInstall(targetDir, { ...environment, ...committedCanned(), ...personNotesWrite, FAKE_COMPOSE_UP_FAIL: "1" });
    expect(result.status).toBe(1);
    expect(terminalFailure(result.stdout)).toMatch(/ action=retry /u);
    const stamp = onlyStamp(targetDir);
    expect(readOptional(join(stamp, "moved", "notes.txt"))).toBe(personNotes);
    expect(existsSync(join(stamp, "originals"))).toBe(false);
    expect(existsSync(join(stamp, "engine"))).toBe(false);
    expect(targetEntries(targetDir)).toEqual([".env-orbit", ".orbit-secrets", backupsName]);
    expect(ownTree(targetDir)).toEqual(before);
    expect(result.stderr).toContain("moved, not deleted");
    expect(result.stderr).toContain(join(stamp, "moved"));
    expect(closingLine(result.stderr)).toContain("apart from the files moved out and named above");
    expect(closingLine(result.stderr).endsWith(failClosing)).toBe(true);
    expectNoForbiddenWords(result.stderr);
  });

  it("B4: a file the person put inside a directory the engine created is moved with its path kept; the engine's own files are removed (O-S1-FR3)", () => {
    const { targetDir, environment, before } = recoveryFixture();
    const helper = "#!/bin/sh\necho the person's own helper\n";
    const result = runInstall(targetDir, {
      ...environment,
      ...committedCanned(),
      FAKE_UP_ADDS_FILE: JSON.stringify({ path: join(targetDir, "scripts", "my-helper.sh"), content: helper }),
      FAKE_COMPOSE_UP_FAIL: "1",
    });
    expect(result.status).toBe(1);
    const stamp = onlyStamp(targetDir);
    expect(readOptional(join(stamp, "moved", "scripts", "my-helper.sh"))).toBe(helper);
    expect(readdirSync(join(stamp, "moved", "scripts"))).toEqual(["my-helper.sh"]);
    expect(existsSync(join(targetDir, "scripts"))).toBe(false);
    expect(existsSync(join(targetDir, "docker-compose.yml"))).toBe(false);
    expect(modeOf(join(stamp, "moved"))).toBe(0o700);
    expect(modeOf(join(stamp, "moved", "scripts"))).toBe(0o700);
    expect(ownTree(targetDir)).toEqual(before);
  });

  it("B5: an older engine's top-level journal is not trusted: everything new is moved, not deleted, and the output says why", () => {
    const { targetDir, environment, before } = recoveryFixture();
    const result = runInstall(targetDir, {
      ...environment,
      ...committedCanned(),
      FAKE_ENGINE_WRITTEN: [".env-orbit", ".orbit-secrets", "docker-compose.yml", "scripts"].join("\n"),
      FAKE_UP_ADDS_FILE: JSON.stringify({ path: join(targetDir, "scripts", "my-helper.sh"), content: "#!/bin/sh\n" }),
      FAKE_COMPOSE_UP_FAIL: "1",
    });
    expect(result.status).toBe(1);
    const stamp = onlyStamp(targetDir);
    expect(existsSync(join(stamp, "moved", "scripts", "orbit-ops.sh"))).toBe(true);
    expect(existsSync(join(stamp, "moved", "docker-compose.yml"))).toBe(true);
    expect(result.stderr).toContain("did not record which files it wrote");
    expect(originalsIn(treeSnapshot(targetDir))).toEqual(originalsIn(before));
    expect(filesNamed(join(targetDir, "scripts"), ["orbit-ops.sh"])).toEqual([]);
  });

  it("B6: an empty folder: the person's file is moved, the folder holds only orbit-install-backups, and the next run installs without touching it", () => {
    const targetDir = makeTarget();
    const result = runInstall(targetDir, { ...committedCanned(), ...personNotesWrite, FAKE_COMPOSE_UP_FAIL: "1" });
    expect(result.status).toBe(1);
    expect(terminalFailure(result.stdout)).toMatch(/ action=retry /u);
    expect(readdirSync(targetDir)).toEqual([backupsName]);
    const stamp = onlyStamp(targetDir);
    expect(readOptional(join(stamp, "moved", "notes.txt"))).toBe(personNotes);
    expect(existsSync(join(stamp, "originals"))).toBe(false);

    const kept = treeSnapshot(backupsDir(targetDir));
    const rerun = runInstall(targetDir, committedCanned());
    expect(rerun.status).toBe(0);
    expect(rerun.stdout).toContain("Orbit is ready.");
    expect(rerun.engineRuns).toHaveLength(1);
    expect(treeSnapshot(backupsDir(targetDir))).toEqual(kept);
  });

  it("B7: an empty folder with nothing to move is empty again, and no orbit-install-backups was made", () => {
    const targetDir = makeTarget();
    const result = runInstall(targetDir, { ...committedCanned(), FAKE_COMPOSE_UP_FAIL: "1" });
    expect(result.status).toBe(1);
    expect(readdirSync(targetDir)).toEqual([]);
    expect(existsSync(backupsDir(targetDir))).toBe(false);
  });

  it("B8: an earlier run's folder is ignored and untouched, by a success and by a failure", () => {
    const plant = (targetDir) => {
      const old = join(backupsDir(targetDir), "20200101T000000Z");
      mkdirSync(join(old, "moved"), { recursive: true, mode: 0o700 });
      chmodSync(backupsDir(targetDir), 0o700);
      writeFileSync(join(old, "moved", "old.txt"), "from an earlier run\n");
      return { old, oldBefore: treeSnapshot(old) };
    };

    const succeeding = recoveryFixture();
    const kept = plant(succeeding.targetDir);
    const success = runInstall(succeeding.targetDir, succeeding.environment);
    expect(success.status).toBe(0);
    expect(treeSnapshot(kept.old)).toEqual(kept.oldBefore);
    expect(backups(succeeding.targetDir)).toEqual(["20200101T000000Z"]);

    const failing = recoveryFixture();
    const keptToo = plant(failing.targetDir);
    const failure = runInstall(failing.targetDir, { ...failing.environment, ...committedCanned(), ...personNotesWrite, FAKE_COMPOSE_UP_FAIL: "1" });
    expect(failure.status).toBe(1);
    expect(backups(failing.targetDir)).toHaveLength(2);
    expect(treeSnapshot(keptToo.old)).toEqual(keptToo.oldBefore);
    const stamp = onlyStamp(failing.targetDir, ["20200101T000000Z"]);
    expect(readOptional(join(stamp, "moved", "notes.txt"))).toBe(personNotes);
  });

  it.each([["a symlink"], ["a dangling symlink"], ["a regular file"]])("B9: %s at orbit-install-backups is refused before anything changes", (kind) => {
    const { targetDir, environment } = recoveryFixture();
    const linkTarget = scratchDir("backups-link-target");
    if (kind === "a symlink") symlinkSync(linkTarget, backupsDir(targetDir));
    else if (kind === "a dangling symlink") symlinkSync(join(linkTarget, "missing"), backupsDir(targetDir));
    else writeFileSync(backupsDir(targetDir), "");
    // lstat-based, so a dangling link can be recorded too.
    const state = () => {
      const entry = lstatSync(backupsDir(targetDir));
      return {
        entries: targetEntries(targetDir),
        envOrbit: `${modeOf(join(targetDir, ".env-orbit")).toString(8)}:${readFileSync(join(targetDir, ".env-orbit")).toString("base64")}`,
        secrets: treeSnapshot(join(targetDir, ".orbit-secrets")),
        secretsMode: modeOf(join(targetDir, ".orbit-secrets")),
        backups: entry.isSymbolicLink() ? `link:${readlinkSync(backupsDir(targetDir))}` : `file:${readFileSync(backupsDir(targetDir)).toString("base64")}`,
      };
    };
    const before = state();
    const result = runInstall(targetDir, environment);
    expect(result.status).toBe(1);
    // Section 13.3: `fail_with failure abort` from snapshot_fresh_target, phase and component `host`.
    expect(terminalFailure(result.stdout)).toMatch(/^phase=host component=host state=failed reason=failure action=abort /u);
    expect(result.engineRuns).toHaveLength(0);
    expect(result.calls.split("\n").filter((line) => /^docker compose /u.test(line) && !/^docker compose version\b/u.test(line))).toEqual([]);
    expect(result.stderr).toContain(
      `Orbit installer: ${backupsDir(targetDir)} is not a folder: the installer keeps its backups under that name and cannot use a file or a link there. Rename it, then install again. Nothing was changed.`,
    );
    expect(readdirSync(linkTarget)).toEqual([]);
    expect(state()).toEqual(before);
  });

  it("B10: modes: the backups root is made 0700, the dated folder and moved/ 0700, and the person's file keeps its own 0644", () => {
    const { targetDir, environment } = recoveryFixture();
    mkdirSync(backupsDir(targetDir), { mode: 0o755 });
    chmodSync(backupsDir(targetDir), 0o755);
    const result = runInstall(targetDir, {
      ...environment,
      ...committedCanned(),
      FAKE_ENGINE_PERSON_WRITES: JSON.stringify({ path: "notes.txt", content: personNotes, mode: 0o644 }),
      FAKE_COMPOSE_UP_FAIL: "1",
    });
    expect(result.status).toBe(1);
    const stamp = onlyStamp(targetDir);
    expect(modeOf(backupsDir(targetDir))).toBe(0o700);
    expect(modeOf(stamp)).toBe(0o700);
    expect(modeOf(join(stamp, "moved"))).toBe(0o700);
    expect(modeOf(join(stamp, "moved", "notes.txt"))).toBe(0o644);
  });

  it("B20: an unwritable home changes nothing: an empty folder's person's file is still moved into the folder's backups", () => {
    const targetDir = makeTarget();
    const home = unwritableHome();
    const result = runInstall(targetDir, { ...committedCanned(), ...home, ...personNotesWrite, FAKE_COMPOSE_UP_FAIL: "1" });
    expect(result.status).toBe(1);
    expect(terminalFailure(result.stdout)).toMatch(/ action=retry /u);
    expect(readdirSync(targetDir)).toEqual([backupsName]);
    expect(readOptional(join(onlyStamp(targetDir), "moved", "notes.txt"))).toBe(personNotes);
    expect(readdirSync(dirname(home.HOME))).toEqual([]);
  });

  it("B21: dated folder names never collide: an existing name is skipped, never reused or emptied; past -9 the install is refused at the start", () => {
    const premake = (targetDir, suffixes) => {
      mkdirSync(backupsDir(targetDir), { mode: 0o700 });
      chmodSync(backupsDir(targetDir), 0o700);
      const now = Math.floor(Date.now() / 1000) * 1000;
      const names = [];
      for (let second = 0; second <= 180; second += 1) {
        for (const suffix of suffixes) {
          const name = `${stampAt(now + second * 1000)}${suffix}`;
          mkdirSync(join(backupsDir(targetDir), name), { mode: 0o700 });
          names.push(name);
        }
      }
      return names;
    };
    const failingKnobs = { ...committedCanned(), ...personNotesWrite, FAKE_COMPOSE_UP_FAIL: "1" };

    // (a) every plain stamp taken: the run uses <stamp>-2.
    const first = recoveryFixture();
    const plain = premake(first.targetDir, [""]);
    expect(runInstall(first.targetDir, { ...first.environment, ...failingKnobs }).status).toBe(1);
    const used = onlyStamp(first.targetDir, plain);
    expect(basename(used)).toMatch(/^\d{8}T\d{6}Z-2$/u);
    for (const name of plain) expect(readdirSync(join(backupsDir(first.targetDir), name)), name).toEqual([]);
    expect(readOptional(join(used, "moved", "notes.txt"))).toBe(personNotes);

    // (b) -2 through -9 taken too: refused before the engine, nothing changed.
    const second = recoveryFixture();
    premake(second.targetDir, ["", "-2", "-3", "-4", "-5", "-6", "-7", "-8", "-9"]);
    const premade = treeSnapshot(second.targetDir);
    const refused = runInstall(second.targetDir, { ...second.environment, ...failingKnobs });
    expect(refused.status).toBe(1);
    expect(terminalFailure(refused.stdout)).toMatch(/ action=abort /u);
    expect(refused.engineRuns).toHaveLength(0);
    expect(refused.stderr).toContain("Could not make a backup folder");
    expect(treeSnapshot(second.targetDir)).toEqual(premade);

    // (c) two failing runs, one after the other: two folders, each with its own file.
    const third = recoveryFixture();
    expect(runInstall(third.targetDir, { ...third.environment, ...failingKnobs }).status).toBe(1);
    expect(runInstall(third.targetDir, { ...third.environment, ...failingKnobs }).status).toBe(1);
    const names = backups(third.targetDir);
    expect(names).toHaveLength(2);
    expect(new Set(names).size).toBe(2);
    for (const name of names) {
      expect(name).toMatch(stampPattern);
      expect(readOptional(join(backupsDir(third.targetDir), name, "moved", "notes.txt")), name).toBe(personNotes);
    }
  });
});

describe("install.sh: a refused backup folder names its cause and the way back", () => {
  /** A bin directory ahead of the fake one: the same fakes, plus `tools` (name to shell body) that shadow real commands. */
  function toolsPath(tools) {
    const dir = mkdtempSync(join(tmpdir(), "orbit-install-shadow-"));
    for (const [name, source] of [
      ["docker", fakeDockerScript],
      ["curl", fakeCurlScript],
      ["cosign", fakeCosignScript],
    ]) {
      writeFileSync(join(dir, name), source);
      chmodSync(join(dir, name), 0o755);
    }
    for (const [name, body] of Object.entries(tools)) {
      writeFileSync(join(dir, name), `#!/bin/sh\n${body}\n`);
      chmodSync(join(dir, name), 0o755);
    }
    return `${dir}:${process.env.PATH}`;
  }

  function refusal(targetDir, environment, tools) {
    const result = runInstall(targetDir, { ...environment, PATH: toolsPath(tools) });
    expect(result.status).toBe(1);
    expect(terminalFailure(result.stdout)).toMatch(/ action=abort /u);
    expect(result.engineRuns).toHaveLength(0);
    return result.stderr;
  }

  const generic = "Could not make a backup folder under";

  it("the run's timestamp cannot be read: says the clock could not be read and to try again", () => {
    const { targetDir, environment } = recoveryFixture();
    const before = treeSnapshot(targetDir);
    const text = refusal(targetDir, environment, { date: "exit 1" });
    expect(text).toMatch(/(clock|date|time)/iu);
    expect(text).toMatch(/(try again|run it again|install again|retry)/iu);
    expect(text).not.toMatch(new RegExp(`${generic} \\S+; nothing was changed\\.`, "u"));
    expect(treeSnapshot(targetDir)).toEqual(before);
  });

  it("the backups folder cannot be made private (not ours, or chmod fails): names the folder, says it is not usable by this user, and to change its owner, rename it or remove it", () => {
    const { targetDir, environment } = recoveryFixture();
    mkdirSync(backupsDir(targetDir), { mode: 0o755 });
    const text = refusal(targetDir, environment, { chmod: 'case "$*" in *orbit-install-backups*) exit 1;; esac\nexec /bin/chmod "$@"' });
    expect(text).toContain(backupsDir(targetDir));
    expect(text).toMatch(/(owned by|another user|permission|private|0700|700)/iu);
    expect(text).toMatch(/(chown|rename|remove)/iu);
    expect(text).not.toMatch(new RegExp(`${generic} \\S+; nothing was changed\\.`, "u"));
  });

  it("a dated folder cannot be created: says it could not be created and names the folder to check", () => {
    const { targetDir, environment } = recoveryFixture();
    const text = refusal(targetDir, environment, { mkdir: 'case "$*" in *orbit-install-backups*) exit 1;; esac\nexec /bin/mkdir "$@"' });
    expect(text).toContain(backupsName);
    expect(text).toMatch(/could not create/iu);
    expect(text).toMatch(/(space|permission|writable|check)/iu);
    expect(text).not.toMatch(new RegExp(`${generic} \\S+; nothing was changed\\.`, "u"));
  });

  it("all nine same-second names are taken: says so and to remove old dated folders", () => {
    const { targetDir, environment } = recoveryFixture();
    const now = Date.now();
    for (let second = -2; second <= 180; second += 1) {
      for (const suffix of ["", "-2", "-3", "-4", "-5", "-6", "-7", "-8", "-9"]) {
        mkdirSync(join(backupsDir(targetDir), `${stampAt(now + second * 1000)}${suffix}`), { recursive: true, mode: 0o700 });
      }
    }
    chmodSync(backupsDir(targetDir), 0o700);
    const text = refusal(targetDir, environment, {});
    expect(text).toMatch(/(taken|already exist|in use)/iu);
    expect(text).toMatch(/remove (the )?old/iu);
    expect(text).toContain(backupsName);
    expect(text).not.toMatch(new RegExp(`${generic} \\S+; nothing was changed\\.`, "u"));
  });
});

describe("install.sh: the containers could not be stopped (redesign r5)", () => {
  it("B11: the folder is put back, the engine's files kept whole in <stamp>/engine, and one command, last and alone, run from there, `retry`", () => {
    const { targetDir, stateDir, environment, before } = privateStateFixture();
    const result = runInstall(targetDir, { ...environment, ...r5DownFailedKnobs() });
    expect(result.status).toBe(1);
    const offered = result.stdout.split("\n").filter((line) => line.startsWith(recoveryPrefix));
    expect(offered).toHaveLength(1);
    const command = offered[0].slice(recoveryPrefix.length);
    expectRecoveryCommand(result, command, "retry");
    expect(recoveryCommands(result.stderr).map((entry) => entry.command)).toEqual([command]);
    expect(command).toMatch(r5DownCommand);
    const lines = result.stderr.split("\n").filter((line) => line.trim() !== "");
    expect(lines.at(-1)).toBe(command);
    expect(lines.at(-2).endsWith("then install again:")).toBe(true);
    expect(result.stderr).toContain("the containers could not be stopped");
    expect(result.stderr).toContain("kept in");

    expect(targetEntries(targetDir)).toEqual([".env-orbit", ".orbit-secrets", backupsName]);
    expect(ownTree(targetDir)).toEqual(before);
    const stamp = onlyStamp(targetDir);
    expect(command).toContain(`/${basename(stamp)}/engine && `);
    // Section 13.1: this attempt's volumes, by exact name, and no other.
    expect(command).toContain(volumesPart);
    expect(command.slice(command.indexOf(volumesPart) + volumesPart.length).split(" ").sort()).toEqual(allThreeVolumes);
    expect(result.stderr).not.toContain(noVolumesLine);
    const engine = join(stamp, "engine");
    for (const path of ["docker-compose.yml", "scripts/orbit-ops.sh", ".env-orbit"]) expect(existsSync(join(engine, path)), path).toBe(true);
    expect(readOptional(join(engine, ".env-orbit"))).toContain("COMPOSE_PROJECT_NAME=");
    expect(lstatSync(join(engine, ".orbit-secrets")).isDirectory()).toBe(true);
    expect(readOptional(join(stamp, "moved", "notes.txt"))).toBe(personNotes);
    expect(existsSync(join(stamp, "originals"))).toBe(false);
    expectNoForbiddenWords(result.stderr);
    expect(volumesLeftBehind(stateDir)).not.toEqual([]);
  });

  /** B11 with the strict Compose fake, then the one command run as printed from elsewhere (B12). */
  function downFailedThenPasted() {
    const fixture = privateStateFixture();
    const environment = { ...fixture.environment, ...r5DownFailedKnobs(), FAKE_COMPOSE_STRICT: "1" };
    const failed = runInstall(fixture.targetDir, environment);
    expect(failed.status).toBe(1);
    const commands = recoveryCommands(failed.stderr).map((entry) => entry.command);
    expect(commands).toHaveLength(1);
    expect(commands[0]).toMatch(r5DownCommand);
    const stamp = onlyStamp(fixture.targetDir);
    expect(containersLeft(fixture.stateDir)).not.toEqual([]);
    expect(volumesLeftBehind(fixture.stateDir)).not.toEqual([]);
    return { ...fixture, environment, failed, stamp, command: commands[0], pasted: runPasted(commands[0], fixture.stateDir) };
  }

  it("B12: the printed command works from another directory: it finds the compose file in engine/ and stops the containers", () => {
    const { stateDir, stamp, command, pasted } = downFailedThenPasted();
    expect(`${command} -> ${pasted.ran.status} ${pasted.ran.stderr}`).toMatch(/-> 0 /u);
    expect(pasted.loaded?.found).toBe(true);
    expect(pasted.loaded?.cwd.endsWith("/engine")).toBe(true);
    expect(pasted.loaded?.cwd).toBe(realPath(join(stamp, "engine")));
    expect(readdirSync(pasted.scratch)).toEqual([]);
    expect(containersLeft(stateDir)).toEqual([]);
    // Section 13.1: the same command removed this attempt's volumes once the containers were gone.
    expect(volumesLeftBehind(stateDir)).toEqual([]);
  });

  it("B13: once the command has run, installing again is a fresh install that leaves the earlier dated folder as it was", () => {
    const { targetDir, environment, stamp, pasted } = downFailedThenPasted();
    expect(pasted.ran.status).toBe(0);
    const kept = treeSnapshot(stamp);
    const rerunEnvironment = Object.fromEntries(Object.entries(environment).filter(([key]) => !["FAKE_COMPOSE_UP_FAIL", "FAKE_COMPOSE_DOWN_FAIL"].includes(key)));
    const rerun = runInstall(targetDir, rerunEnvironment);
    expect(rerun.status).toBe(0);
    expect(rerun.stdout).toContain("Orbit is ready.");
    expect(rerun.engineRuns).toHaveLength(1);
    expect(treeSnapshot(stamp)).toEqual(kept);
    expect(backups(targetDir)).toEqual([basename(stamp)]);
  });

  it("B14: no journal and `down` failed: everything new is kept together in engine/, nothing deleted, and the command works from there", () => {
    const { targetDir, stateDir, environment } = privateStateFixture();
    const result = runInstall(targetDir, { ...environment, ...r5DownFailedKnobs({ journal: false }), FAKE_COMPOSE_STRICT: "1" });
    expect(result.status).toBe(1);
    const stamp = onlyStamp(targetDir);
    expect(existsSync(join(stamp, "engine", "docker-compose.yml"))).toBe(true);
    expect(readOptional(join(stamp, "engine", "notes.txt"))).toBe(personNotes);
    expect(existsSync(join(stamp, "moved"))).toBe(false);
    expect(result.stderr).toContain("did not record which files it wrote");
    expect(result.stderr).toContain("kept together");
    expectNoForbiddenWords(result.stderr);
    const commands = recoveryCommands(result.stderr).map((entry) => entry.command);
    expect(commands).toHaveLength(1);
    expect(commands[0]).toMatch(r5DownCommand);
    expect(commands[0]).toContain(volumesPart);
    expect(volumesLeftBehind(stateDir)).not.toEqual([]);
    const pasted = runPasted(commands[0], stateDir);
    expect(`${commands[0]} -> ${pasted.ran.status} ${pasted.ran.stderr}`).toMatch(/-> 0 /u);
    expect(pasted.loaded?.found).toBe(true);
    expect(pasted.loaded?.cwd).toBe(realPath(join(stamp, "engine")));
    expect(volumesLeftBehind(stateDir)).toEqual([]);
  });

  it("B11 (section 13.1): when the attempt created no volume, the command ends after --remove-orphans and one line says what to do if the next install names a volume", () => {
    const { targetDir, environment } = privateStateFixture();
    const { FAKE_UP_CREATES_ALL_VOLUMES: _created, ...noVolumes } = { ...environment, ...r5DownFailedKnobs() };
    const result = runInstall(targetDir, noVolumes);
    expect(result.status).toBe(1);
    const commands = recoveryCommands(result.stderr).map((entry) => entry.command);
    expect(commands).toHaveLength(1);
    expect(commands[0]).toMatch(r5DownCommand);
    expect(commands[0].endsWith(" down --remove-orphans")).toBe(true);
    expectRecoveryCommand(result, commands[0], "retry");
    const lines = result.stderr.split("\n");
    expect(lines[lines.indexOf(commands[0]) + 1]).toContain(noVolumesLine);
  });

  it("B25: on a terminal no `recovery-command:` line is printed; the command is still shown once", async () => {
    const { targetDir, environment } = privateStateFixture();
    const result = await runInstallOnTerminal(targetDir, { ...environment, ...r5DownFailedKnobs() });
    expect(result.status).toBe(1);
    // On a terminal stdout and stderr share the pty: strip carriage returns and colour before reading lines.
    const lines = result.stdout.split("\n").map((line) => line.replace(/\r/gu, "").replace(/\u001b\[[0-9;]*[A-Za-z]/gu, ""));
    expect(lines.filter((line) => line.startsWith(recoveryPrefix))).toEqual([]);
    expect(lines.filter((line) => r5DownCommand.test(line))).toHaveLength(1);
  }, PTY_TEST_TIMEOUT_MS);
});

describe("install.sh: a rollback that cannot finish names what is left (redesign r5)", () => {
  // B16 and B17 make a directory read-only; give it back so the scratch directories can be removed.
  const lockedDirectories = [];
  afterEach(() => {
    for (const directory of lockedDirectories.splice(0)) {
      try {
        chmodSync(directory, 0o700);
      } catch {
        // already gone
      }
    }
  });

  it("B15: a volume that could not be removed: the folder is put back and the one command is `docker volume rm --` with this attempt's volumes, `retry`", () => {
    const { targetDir, environment, before, preexistingVolumes } = recoveryFixture();
    const result = runInstall(targetDir, { ...environment, FAKE_COMPOSE_UP_FAIL: "1", FAKE_VOLUME_RM_FAIL: "1" });
    expect(result.status).toBe(1);
    const commands = recoveryCommands(result.stderr).map((entry) => entry.command);
    expect(commands).toHaveLength(1);
    expect(commands[0]).toMatch(/^docker volume rm -- /u);
    expect(commands[0].slice("docker volume rm -- ".length).split(" ").sort()).toEqual(allThreeVolumes);
    for (const volume of preexistingVolumes) expect(commands[0]).not.toContain(volume);
    expectRecoveryCommand(result, commands[0], "retry");
    expect(result.stderr).toContain("could not be removed");
    for (const volume of allThreeVolumes) expect(result.stderr).toContain(volume);
    expect(treeSnapshot(targetDir)).toEqual(before);
    expect(backups(targetDir)).toEqual([]);
  });

  it.skipIf(process.geteuid?.() === 0)("B16: an engine entry that cannot be removed is named, the originals are put back, and the run ends `abort` with no command", () => {
    const { targetDir, environment, before } = recoveryFixture();
    const canned = committedCanned();
    const leaves = { ...JSON.parse(canned.FAKE_ENGINE_LEAVES), "scripts/": { mode: 0o500 } };
    lockedDirectories.push(join(targetDir, "scripts"));
    const result = runInstall(targetDir, { ...environment, ...canned, FAKE_ENGINE_LEAVES: JSON.stringify(leaves), FAKE_COMPOSE_UP_FAIL: "1" });
    lockedDirectories.push(...directoriesNamed(targetDir, "scripts"));
    expect(result.status).toBe(1);
    expect(terminalFailure(result.stdout)).toMatch(/ action=abort /u);
    expectNoCommand(result);
    expect(result.stderr).toContain("Could not remove");
    expect(result.stderr).toContain(join(targetDir, "scripts"));
    expect(result.stderr).toContain("then install again");
    expect(originalsIn(treeSnapshot(targetDir))).toEqual(originalsIn(before));
    expectNoForbiddenWords(result.stderr);
  });

  it.skipIf(process.geteuid?.() === 0)("B17: an original that cannot be put back keeps its copy in <stamp>/originals, named, `abort`", () => {
    const { targetDir, environment } = recoveryFixture();
    const canned = committedCanned();
    const leaves = {
      ...JSON.parse(canned.FAKE_ENGINE_LEAVES),
      ".orbit-secrets/locked/": { mode: 0o500 },
      ".orbit-secrets/locked/x": "a file the rollback cannot remove\n",
    };
    lockedDirectories.push(join(targetDir, ".orbit-secrets", "locked"));
    const result = runInstall(targetDir, { ...environment, ...canned, FAKE_ENGINE_LEAVES: JSON.stringify(leaves), FAKE_COMPOSE_UP_FAIL: "1" });
    lockedDirectories.push(...directoriesNamed(targetDir, "locked"));
    expect(result.status).toBe(1);
    expect(terminalFailure(result.stdout)).toMatch(/ action=abort /u);
    expect(result.stderr).toContain("Could not put back");
    expect(result.stderr).toContain(join(targetDir, ".orbit-secrets"));
    expect(result.stderr).toContain("originals");
    const stamp = onlyStamp(targetDir);
    expect(readOptional(join(stamp, "originals", ".orbit-secrets", "oidc-client-secret"))).toBe("preprovisioned-oidc-secret");
    expect(existsSync(join(stamp, "originals", ".env-orbit"))).toBe(true);
  });
});

describe("install.sh: the rollback lists first, stops briefly and names the real cause (R1)", () => {
  // A hung Docker daemon must not hold the rollback past the launcher's 15 s stop grace. Order: list the volumes,
  // then `down --timeout 2`, then remove each volume. The three Docker calls are capped at 5, 6 and 5 s inside an
  // 8 s deadline. The rollback is measured from the `phase=rollback state=running` event to the terminal `failed`
  // event (whole seconds). The fake hangs for 120 s.
  const rollbackBudgetSeconds = 10;
  const causeLine =
    "Docker did not finish within 8 s, so the rollback stopped waiting for it; what it could not do is named below. Once Docker is answering again (check that it is running and its disk is not full), run the command below.";
  const containersLine = "the containers could not be stopped";
  const listedLine = "could not be listed";
  const stopCommand = /docker compose .* down --remove-orphans/u;

  function rollbackSeconds(stdout) {
    const start = /^phase=rollback .* state=running .* elapsed=(\d+)s$/mu.exec(stdout);
    const end = /^phase=[a-z-]+ .* state=failed .* elapsed=(\d+)s(?: .*)?$/mu.exec(stdout);
    expect(start, "a phase=rollback state=running event").not.toBeNull();
    expect(end, "a terminal failed event").not.toBeNull();
    return Number(end[1]) - Number(start[1]);
  }

  function timedFailure(knobs) {
    const { targetDir, environment } = recoveryFixture();
    return runInstall(targetDir, { ...environment, FAKE_COMPOSE_UP_FAIL: "1", ...knobs }, ["--plain"]);
  }

  const occurrences = (text, needle) => text.split(needle).length - 1;
  const callLines = (result) => result.calls.split("\n").filter(Boolean);
  const isUp = (line) => /^docker compose .* up( |$)/u.test(line);
  const isDown = (line) => /^docker compose .* down( |$)/u.test(line);
  const isVolumeLs = (line) => /^docker volume ls( |$)/u.test(line);
  const isVolumeRm = (line) => /^docker volume rm( |$)/u.test(line);
  const afterUp = (result) => {
    const calls = callLines(result);
    return calls.slice(calls.findLastIndex(isUp) + 1);
  };

  it("a slow but healthy `compose down` (4 s) is not a timeout: the rollback completes, no cause line, all three volumes removed (guards FR2)", () => {
    const result = timedFailure({ FAKE_DOWN_DELAY: "4" });
    expect(result.status).toBe(1);
    expect(result.stderr).not.toContain("Docker did not finish within");
    expect(result.stderr).not.toContain(containersLine);
    expect(result.stderr).not.toContain(listedLine);
    expect(recoveryCommands(result.stderr)).toEqual([]);
    const removed = afterUp(result).filter(isVolumeRm).join(" ");
    for (const volume of allThreeVolumes) expect(removed).toContain(volume);
  });

  it("a hung `compose down`: the cause line says \"did not finish within 8 s\", once, before the obstacle, within 10 s", () => {
    const result = timedFailure({ FAKE_HANG_DOWN: "1" });
    expect(result.status).toBe(1);
    expect(rollbackSeconds(result.stdout)).toBeLessThanOrEqual(rollbackBudgetSeconds);
    expect(result.stderr).toContain(containersLine);
    expect(occurrences(result.stderr, causeLine)).toBe(1);
    expect(result.stderr.indexOf(causeLine)).toBeLessThan(result.stderr.indexOf(containersLine));
  });

  it("a hung `compose down`: the one stop command ends in `docker volume rm` naming all three volumes", () => {
    const result = timedFailure({ FAKE_HANG_DOWN: "1" });
    const commands = recoveryCommands(result.stderr).map((entry) => entry.command);
    expect(commands).toHaveLength(1);
    expect(commands[0]).toMatch(stopCommand);
    expect(commands[0]).toContain(volumesPart);
    expect(commands[0].slice(commands[0].indexOf(volumesPart) + volumesPart.length).split(" ").sort()).toEqual(allThreeVolumes);
  });

  it("a hung `compose down`: exactly one `volume ls` after the up and before the `down`, and nothing after the `down`", () => {
    const result = timedFailure({ FAKE_HANG_DOWN: "1" });
    const calls = afterUp(result);
    const down = calls.findIndex(isDown);
    expect(down).toBeGreaterThanOrEqual(0);
    expect(calls.slice(0, down).filter(isVolumeLs)).toHaveLength(1);
    expect(calls.slice(down + 1)).toEqual([]);
  });

  it("a hung `volume ls`: no `down` and no `volume rm` is run; the containers line, the listing line, the stop command, the next-install line and the cause line once", () => {
    const result = timedFailure({ FAKE_HANG_VOLUME_LS_AFTER_UP: "1" });
    expect(result.status).toBe(1);
    expect(rollbackSeconds(result.stdout)).toBeLessThanOrEqual(rollbackBudgetSeconds);
    const calls = afterUp(result);
    expect(calls.filter(isDown)).toEqual([]);
    expect(calls.filter(isVolumeRm)).toEqual([]);
    expect(result.stderr).toContain(containersLine);
    expect(result.stderr).toContain(listedLine);
    const commands = recoveryCommands(result.stderr).map((entry) => entry.command);
    expect(commands).toHaveLength(1);
    expect(commands[0]).toMatch(stopCommand);
    expect(commands[0]).not.toContain(volumesPart);
    expect(result.stderr).toContain(noVolumesLine);
    expect(occurrences(result.stderr, causeLine)).toBe(1);
  });

  it("a hung `volume rm`: every volume is named, the `docker volume rm` command is given, no stop command, cause once", () => {
    const result = timedFailure({ FAKE_HANG_VOLUME_RM: "1" });
    expect(result.status).toBe(1);
    expect(rollbackSeconds(result.stdout)).toBeLessThanOrEqual(rollbackBudgetSeconds);
    expect(result.stderr).toContain("could not be removed");
    for (const volume of allThreeVolumes) expect(result.stderr).toContain(volume);
    const commands = recoveryCommands(result.stderr).map((entry) => entry.command);
    expect(commands).toHaveLength(1);
    expect(commands[0]).toMatch(/^docker volume rm -- /u);
    expect(result.stderr).not.toMatch(stopCommand);
    expect(occurrences(result.stderr, causeLine)).toBe(1);
  });

  it("a rollback in which Docker answers (even with a failure) carries no cause line", () => {
    const result = timedFailure({ FAKE_COMPOSE_DOWN_FAIL: "1" });
    expect(result.status).toBe(1);
    expect(result.stderr).not.toContain("Docker did not finish within");
  });

  it("SIGTERM during a hung `down`: the process exits within 15 s of the signal with one terminal failed event", async () => {
    const { targetDir, environment } = recoveryFixture();
    const result = await runInstallSignalled(
      targetDir,
      { ...environment, FAKE_COMPOSE_UP_FAIL: "1", FAKE_HANG_DOWN: "1" },
      { signal: "SIGTERM", marker: "hung-down" },
    );
    expect(result.signalSent).toBe(true);
    expect(result.signalToExitMs).toBeLessThan(15_000);
    expect(eventLines(result.stdout).filter((line) => / state=failed /u.test(line))).toHaveLength(1);
  }, PTY_TEST_TIMEOUT_MS);

  it("SIGTERM during a hung readiness probe with `volume ls` also hung: the process exits within 15 s of the signal with one terminal failed event", async () => {
    const { targetDir, environment } = recoveryFixture();
    const result = await runInstallSignalled(
      targetDir,
      { ...environment, FAKE_HANG_PROBE: "orbit-db", FAKE_HANG_VOLUME_LS_AFTER_UP: "1", ORBIT_INSTALLER_READINESS_TIMEOUT_SECONDS: "60" },
      { signal: "SIGTERM", marker: "hung-probe" },
    );
    expect(result.signalSent).toBe(true);
    expect(result.signalToExitMs).toBeLessThan(15_000);
    expect(eventLines(result.stdout).filter((line) => / state=failed /u.test(line))).toHaveLength(1);
  }, PTY_TEST_TIMEOUT_MS);
});
