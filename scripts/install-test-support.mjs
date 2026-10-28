// Shared fixtures for the install.sh suites (scripts/install.*.test.mjs): the
// fake `docker`, the fake engine, the settings and the helpers they all use.
// Not a test file, so Vitest does not collect it; each test file imports it
// once per worker. The suite was one file, scripts/install.test.mjs, split so
// its parts run in parallel (#1377).

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
  statSync,
  watch,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { expect } from "vitest";
import { ptyWatchdog } from "./pty-deadline.mjs";
import { failOnProcessDeadline, processGuard, processWatchdog } from "./process-budget.mjs";

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

export const installScript = fileURLToPath(new URL("./install.sh", import.meta.url));
export const repositoryRoot = fileURLToPath(new URL("..", import.meta.url));
export const engineTsx = join(repositoryRoot, "node_modules", "tsx", "dist", "cli.mjs");
export const engineCli = join(repositoryRoot, "src", "cli", "orbit.ts");

export const repository = "example/orbit-fixture";
export const registry = "fake-registry.example";
export const imageRepository = `${registry}/${repository}`;
export const digest = "a".repeat(64);
export const revision = "b".repeat(40);
export const resolvedReference = `${imageRepository}@sha256:${digest}`;
export const preflightSuccessLine =
  "Orbit installer: configuration, OIDC discovery, and Docker Compose preflight passed; starting services.";
export const deploymentAssets = [
  "docker-compose.yml",
  "docker-compose.mail.yml",
  "docker-compose.kek-rotation.yml",
  "docker-compose.no-document-key.yml",
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
export const releaseManifestDir = mkdtempSync(join(tmpdir(), "orbit-install-manifest-fixture-"));
export const releaseManifestPath = join(releaseManifestDir, "orbit-release-manifest.json");
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
export const assetsRoot = mkdtempSync(join(tmpdir(), "orbit-install-assets-"));
for (const asset of deploymentAssets) {
  mkdirSync(dirname(join(assetsRoot, asset)), { recursive: true });
  copyFileSync(join(repositoryRoot, asset), join(assetsRoot, asset));
}

// The fake docker. Every call is appended to FAKE_CALL_LOG as
// "docker <args>"; the engine run's own argv and environment go to
// FAKE_ENGINE_LOG as JSON.
export const fakeDockerScript = `#!/usr/bin/env node
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
    // #1518: a start that never ends, and one that takes a while and records that it ran to the end (it must not be cut).
    if (env.FAKE_HANG_UP === "1") hang("up");
    if (env.FAKE_UP_DELAY) {
      if (env.FAKE_STATE_DIR) fs.writeFileSync(env.FAKE_STATE_DIR + "/hung-up", String(process.pid));
      Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, Number(env.FAKE_UP_DELAY) * 1000);
      if (env.FAKE_STATE_DIR) fs.writeFileSync(env.FAKE_STATE_DIR + "/up-finished", "");
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
export const fakeCurlScript = [
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

export const fakeCosignScript = [
  "#!/usr/bin/env bash",
  'if [[ "${1:-}" == "version" ]]; then [[ "${FAKE_COSIGN_UNUSABLE:-1}" == "0" ]] || exit 1; exit 0; fi',
  'if [[ "${1:-}" == "verify" || "${1:-}" == "verify-blob" ]]; then exit "${FAKE_COSIGN_VERIFY_EXIT:-0}"; fi',
  "exit 1",
  "",
].join("\n");

/** A fake bin whose docker is run through a wrapper, so `--env-file <path>` reaches the fake as an argument, as it reaches real docker. */
export function makePasteBin() {
  const binDir = mkdtempSync(join(tmpdir(), "orbit-install-pastebin-"));
  writeFileSync(join(binDir, "docker.cjs"), fakeDockerScript);
  writeFileSync(join(binDir, "docker"), `#!/usr/bin/env bash\nexec node "${join(binDir, "docker.cjs")}" -- "$@"\n`);
  chmodSync(join(binDir, "docker"), 0o755);
  return binDir;
}

export function makeFakeBin() {
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

export function makeTarget() {
  return mkdtempSync(join(tmpdir(), "orbit-install-target-"));
}

/** A local-only pre-provisioned target (guarantee #6): the unattended install path. */
export function makePreprovisionedDeployment(targetDir, extraLines = []) {
  writeFileSync(
    join(targetDir, ".env-orbit"),
    ["APP_URL=https://orbit.preprovisioned-install.internal", "ORBIT_AUTH_OIDC=false", ...extraLines, ""].join("\n"),
    { mode: 0o600 },
  );
  mkdirSync(join(targetDir, ".orbit-secrets"), { mode: 0o700 });
  writeFileSync(join(targetDir, ".orbit-secrets", "oidc-client-secret"), "preprovisioned-oidc-secret", { mode: 0o600 });
}

export function targetEntries(targetDir) {
  return readdirSync(targetDir).sort();
}

export function stagingLeftovers(targetDir) {
  return readdirSync(targetDir).filter((name) => name.startsWith(".orbit-install-staging"));
}

export function readOptional(path) {
  try {
    return readFileSync(path, "utf8");
  } catch (error) {
    if (error.code === "ENOENT") return "";
    throw error;
  }
}

export function baseEnvironment(binDir, logDir) {
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

export function runInstall(targetDir, envOverrides = {}, args = []) {
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
export function runInstallOnTerminal(targetDir, envOverrides = {}, interactions = [], args = []) {
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

export function eventLines(output) {
  return output.split("\n").filter((line) => line.startsWith("phase="));
}

/** The recognised volume an update attaches to: one orbit-db, one orbit-app on the deployment's own image. */
export function recognisedVolume(project, image = resolvedReference, dbId = "c".repeat(64), appId = "d".repeat(64)) {
  return {
    volume: `${project}_orbit-db-data`,
    ps: {
      [`volume=${project}_orbit-db-data`]: `${dbId}|${project}|orbit-db\n`,
      [`label=com.docker.compose.project=${project}`]: `${dbId}|${project}|orbit-db\n${appId}|${project}|orbit-app\n`,
    },
    images: { [appId]: image },
  };
}

export function realPath(path) {
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
export const dockerErrorBound = 2000;
export const dockerReason = "no space left on device";
export const controlCharacters = /[\u0000-\u0008\u000b-\u001f\u007f-\u009f]/u;

export function terminalFailure(stdout) {
  return eventLines(stdout)
    .filter((line) => / state=failed /.test(line))
    .at(-1);
}

export function longestRun(text, character) {
  return Math.max(0, ...(text.match(new RegExp(`${character}+`, "gu")) ?? []).map((run) => run.length));
}

/** Every file and directory under `dir` with its mode, so "the way it found it" can be compared whole. */
export function treeSnapshot(dir) {
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

export function volumeRemovals(calls) {
  return calls
    .split("\n")
    .filter((line) => line.startsWith("docker volume rm"))
    .flatMap((line) => line.split(" ").slice(3))
    .filter((word) => word !== "--" && !word.startsWith("-"))
    .sort();
}

export function volumesLeftBehind(stateDir) {
  return ["created-volume", "created-volumes"].flatMap((file) =>
    readOptional(join(stateDir, file))
      .split("\n")
      .filter(Boolean),
  );
}

/** A fresh pre-provisioned target, a state directory shared by every run on it, and another stack's volumes that must never be touched. */
export function recoveryFixture(folderName) {
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

// ---------------------------------------------------------------------------
// Review follow-ups for #1456 / #1455 (docs/installer-guarantees.md #58-60,
// docs/engine-events.md "install.sh after the commit"). Interrupts, a vanished
// launcher, unsafe folder names, an engine that exits non-zero after
// committing, Docker's words on a failed pull, and where the rollback copy of
// the user's files lives. Readiness-timeout behaviour is deliberately not
// tested here (a design decision is pending).
// ---------------------------------------------------------------------------

export const wellFormedEvent = /^phase=[a-z-]+ component=[a-z-]+ state=[a-z-]+ reason=[a-z-]+ action=[a-z-]+ elapsed=[0-9]+s$/;
export const allThreeVolumes = ["orbit_orbit-clamav-data", "orbit_orbit-db-data", "orbit_orbit-documents-data"];

export function scratchDir(label) {
  return mkdtempSync(join(tmpdir(), `orbit-install-${label}-`));
}

/**
 * Runs install.sh in its own process group; once the fake docker has written
 * `marker` into its state directory, sends `signal` to the whole group (what a
 * terminal's Ctrl-C, a closing session or a service manager does).
 */
export function pidAlive(pid) {
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    return error.code === "EPERM";
  }
}

export function runInstallSignalled(targetDir, envOverrides, { signal, marker }) {
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
export function runInstallWithClosedPipes(targetDir, envOverrides, closed) {
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
export function privateStateFixture(options = {}) {
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

export function filesNamed(root, names) {
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

// ---------------------------------------------------------------------------
// #1485: the `Docker said:` excerpt carries Docker's error, not Compose's
// progress stream, and is at most 500 characters (the launcher's failure
// screen wraps the last six stderr lines, so a long excerpt pushes its menu
// off the bottom). Written from the specification alone, before the fix.
// ---------------------------------------------------------------------------

export const dockerSaidPrefix = "Orbit installer: Docker said: ";
export const dockerExcerptBound = 500;
export const addressInUse =
  "Error response from daemon: failed to set up container networking: driver failed programming external connectivity on endpoint orbit (abc123): failed to bind host port 0.0.0.0:3000/tcp: address already in use";

/** The text after `Docker said: ` on stderr, and how many such lines there were. */
export function dockerSaid(stderr) {
  const lines = stderr.split("\n").filter((line) => line.startsWith(dockerSaidPrefix));
  return { count: lines.length, excerpt: (lines[0] ?? "").slice(dockerSaidPrefix.length) };
}

export function composeProgress() {
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

export const logSentinel = "SECRET-LOG-LINE";
export const freeSpaceLine = /free space|space free|available|free:/i;

export function componentEvents(stdout, component) {
  return eventLines(stdout).filter((line) => line.startsWith(`phase=`) && line.includes(` component=${component} `));
}

export function expectNoLogsRequested(result) {
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

// ---------------------------------------------------------------------------
// Round-2 review findings on #1456 (rollback and readiness).
// ---------------------------------------------------------------------------

/** Recovery commands printed on stderr, each with the prose before it (which may say where to run it). */
export function recoveryCommands(stderr) {
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

export function containersLeft(stateDir) {
  return readOptional(join(stateDir, "containers"))
    .split("\n")
    .filter(Boolean);
}

export function modelUpdateFixture() {
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

// ---------------------------------------------------------------------------
// v0.3 acceptance findings on the rollback (O-R1, O-F6, O-S2, O-S1, O-R4,
// O-S4, O-F1, L-Q4). Written from the specification, before the fix.
// ---------------------------------------------------------------------------

/** Every directory called `name` anywhere under `root`. */
export function directoriesNamed(root, name) {
  return filesNamed(root, [name]).filter((path) => statSync(path).isDirectory());
}

/** The `install-rollback.*` entries directly under a state root. */
export function rollbackEntries(stateRoot) {
  return existsSync(stateRoot) ? readdirSync(stateRoot).filter((name) => name.startsWith("install-rollback.")) : [];
}

/** A HOME that does not exist and cannot be created, with XDG_STATE_HOME unset. */
export function unwritableHome() {
  const parent = scratchDir("nohome");
  chmodSync(parent, 0o500);
  return { HOME: join(parent, "missing"), XDG_STATE_HOME: undefined };
}

// Redesign r2 helpers. The engine journals the names it may write
// (`<outcome dir>/written`); the rollback removes what the journal names and
// moves anything else new aside, so a file the person saved while the engine
// ran is never deleted.
export const personNotes = "notes the person saved while the engine ran\n";

/** "Folder put back": as found (`before`, pre-provisioned) or empty (`before` undefined), apart from orbit-install-backups/ (redesign r5), and the terminal event advises retry. */
export function expectFolderPutBack(result, targetDir, before) {
  if (before === undefined) expect(targetEntries(targetDir).filter((name) => name !== backupsName)).toEqual([]);
  else expect(ownTree(targetDir)).toEqual(before);
  expect(terminalFailure(result.stdout)).toMatch(/ action=retry /u);
}

// "Moved aside" (redesign r5): kept unchanged under <folder>/orbit-install-backups/<stamp>/moved/, and the output says so and where. Returns the kept path.
export function expectMovedAside(result, targetDir, name, content, { rollbackLine = true } = {}) {
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

// Redesign r1: an empty folder. The real engine cannot commit an unattended
// install into an empty folder (it needs answers), so the commit is staged by
// the canned engine: FAKE_ENGINE_LEAVES writes the tree a real engine committed
// (from one real install of a pre-provisioned folder), then a fresh `ok`
// outcome is written.
let committedLeaves;
let committedJournal;
export function emptyFolderCommit() {
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

// ---------------------------------------------------------------------------
// Redesign r2: the rollback removes only what the engine's journal names, and
// moves anything else new aside, so a file the person saved while the engine
// was still running is kept (T1-T5, T7-T10; T6 replaced r1's half-commit test
// above). Written from the specification alone, before the fix.
// ---------------------------------------------------------------------------

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
export const engineWritten = [".env-orbit", ".orbit-secrets/", "docker-compose.yml", "scripts/orbit-ops.sh", "scripts/installer-ui.sh"].join("\n");

/**
 * The committed canned engine: an `ok` fresh outcome, its journal unless `journal` is false, and docker-compose.yml and
 * scripts/orbit-ops.sh left in the folder. A commit always carries the .env-orbit and installer UI helper the installer
 * reads next (guarantee #5), so those, and docker-compose.yml, are taken from the real engine's committed tree.
 */
export function committedCanned({ journal = true } = {}) {
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

// ---------------------------------------------------------------------------
// Redesign r5 (.agents/reviews/v0.3.1-mr1074/redesign-r5.md, #1456): no state
// between runs. The start record (originals/), the files moved aside (moved/)
// and, when the containers could not be stopped, the files the engine wrote
// (engine/) live in <folder>/orbit-install-backups/<stamp>/; nothing is
// written under HOME, XDG_STATE_HOME or TMPDIR, and nothing is ever deleted
// that the engine's journal does not claim. B1-B26 (section 9), written from
// the design alone, before the fix.
// ---------------------------------------------------------------------------

export const backupsName = "orbit-install-backups";
/** "Stamp": the run's UTC start time to the second, `-2`..`-9` appended on a collision. */
export const stampPattern = /^\d{8}T\d{6}Z(-[2-9])?$/u;
export const recoveryPrefix = "recovery-command: ";
/**
 * The one command after a failed `down` (sections 5 and 13.1): run from the dated folder's engine/, then this attempt's
 * volumes by exact name on the same line (absent when the attempt created none, or the listing failed).
 */
export const r5DownCommand =
  /^cd \S.*\/orbit-install-backups\/\d{8}T\d{6}Z(-[2-9])?\/engine && docker compose --project-name \S+ --env-file \.env-orbit down --remove-orphans( && docker volume rm -- \S+( \S+)*)?$/u;
export const volumesPart = " && docker volume rm -- ";
/** The stderr line after a down-failed command that names no volume (section 13.1). */
export const noVolumesLine = "If the next install names a volume this install left, remove that volume by the name it prints.";
/** Closing lines (section 13.2): a planned failure, and an interrupt or unplanned exit. */
export const failClosing = "Fix the cause, then install again.";
export const interruptClosing = "You can install again.";
/** Never printed on any path ("moved, not deleted" is allowed and expected). */
export const forbiddenWords = [
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
export function expectRecoveryCommand(result, command, action) {
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
export function expectNoRecoveryField(stdout) {
  expect(stdout.split("\n").filter((line) => line.startsWith(recoveryPrefix))).toEqual([]);
  expect(eventLines(stdout).filter((line) => line.includes("recovery="))).toEqual([]);
}

/** "No command": none on stderr, no `recovery-command:` line, no `recovery=` on any event. */
export function expectNoCommand(result) {
  expect(recoveryCommands(result.stderr)).toEqual([]);
  expectNoRecoveryField(result.stdout);
}

export function expectNoForbiddenWords(stderr) {
  for (const word of forbiddenWords) expect(stderr, `stderr says "${word}"`).not.toContain(word);
}

export function backupsDir(targetDir) {
  return join(targetDir, backupsName);
}

/** Sorted names under <target>/orbit-install-backups; [] when the directory is absent. */
export function backups(targetDir) {
  return existsSync(backupsDir(targetDir)) ? readdirSync(backupsDir(targetDir)).sort() : [];
}

export function modeOf(path) {
  return statSync(path).mode & 0o777;
}

/** The one dated folder this run made (every name not in `earlier`), as a path. */
export function onlyStamp(targetDir, earlier = []) {
  const made = backups(targetDir).filter((name) => !earlier.includes(name));
  expect(made).toHaveLength(1);
  expect(made[0]).toMatch(stampPattern);
  return join(backupsDir(targetDir), made[0]);
}

/** The folder's own tree, leaving out orbit-install-backups/. */
export function ownTree(targetDir) {
  return Object.fromEntries(Object.entries(treeSnapshot(targetDir)).filter(([path]) => path !== `${backupsName}/` && !path.startsWith(`${backupsName}/`)));
}

/** The start record's two entries in a treeSnapshot: .env-orbit and everything under .orbit-secrets. */
export function originalsIn(snapshot) {
  return Object.fromEntries(Object.entries(snapshot).filter(([path]) => path === ".env-orbit" || path.startsWith(".orbit-secrets/")));
}

export function closingLine(stderr) {
  return stderr.split("\n").find((line) => line.includes("This install was rolled back"));
}

/** A UTC stamp for `ms`, as `date -u +%Y%m%dT%H%M%SZ` prints it. */
export function stampAt(ms) {
  return new Date(ms).toISOString().replace(/[-:]/gu, "").replace(/\.\d{3}Z$/u, "Z");
}

export const personNotesWrite = { FAKE_ENGINE_PERSON_WRITES: JSON.stringify({ path: "notes.txt", content: personNotes }) };

/** B11's knobs: the committed canned engine, the person's notes.txt, then `up` and `down` both fail. */
export function r5DownFailedKnobs({ journal = true } = {}) {
  return { ...committedCanned({ journal }), ...personNotesWrite, FAKE_COMPOSE_UP_FAIL: "1", FAKE_COMPOSE_DOWN_FAIL: "1" };
}

/** Runs a printed command with bash from a scratch directory, through the paste fake and the strict Compose fake. */
export function runPasted(command, stateDir) {
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
export function expectNothingPrivate({ stateRoot, home, tmp }) {
  for (const root of [stateRoot, join(home, ".local"), tmp]) expect(filesNamed(root, [".env-orbit", ".orbit-secrets"]), root).toEqual([]);
}

