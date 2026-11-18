import { spawnSync } from "node:child_process";
import { chmodSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";

import { makeFixture, prepareRepair, scratchDir } from "./repair-test-harness.mjs";

// Folders and a runner shared by the #1857 and #1858 tests: one deployment folder for each repair action that
// writes in the deployment folder, plus a runner that executes repair.sh under a hard wall-clock cap (a repair
// that hangs is a failing test, not a stuck worker) and reports how long it took.

export const RUNNING = { db: "running", app: "running" };
export const STOPPED = { db: "stopped", app: "stopped" };

export const FAKE_PASSWORD = "TEST-NOT-A-REAL-PASSWORD";
const IMAGE_COMPOSE = Buffer.from("name: orbit\nservices:\n  orbit-app:\n    image: busybox   \n    # café\n\n", "utf8");
export { IMAGE_COMPOSE };

/** retire-smtp-lines (already runs as the owner): the vehicle for the #1858 limits. */
export function mailFolder() {
  const targetDir = makeFixture();
  const envPath = join(targetDir, ".env-orbit");
  const lines = [
    "COMPOSE_FILE=docker-compose.yml:docker-compose.mail.yml",
    "SMTP_HOST=smtp.example.test",
    "SMTP_PORT=587",
    "SMTP_SECURITY=starttls",
    "SMTP_USER=orbit@example.test",
    `SMTP_PASSWORD=${FAKE_PASSWORD}`,
    "SMTP_FROM=Orbit <orbit@example.test>",
    "",
  ];
  writeFileSync(envPath, `${readFileSync(envPath, "utf8")}${lines.join("\n")}`);
  chmodSync(envPath, 0o600);
  const overlay = join(targetDir, "docker-compose.mail.yml");
  writeFileSync(overlay, "services:\n  orbit-app:\n    secrets:\n      - orbit-smtp-password\n");
  chmodSync(overlay, 0o640);
  writeFileSync(join(targetDir, ".orbit-secrets", "smtp-password"), FAKE_PASSWORD);
  chmodSync(join(targetDir, ".orbit-secrets", "smtp-password"), 0o600);
  return targetDir;
}

const real = (name) => spawnSync("bash", ["-c", `command -v ${name}`], { encoding: "utf8" }).stdout.trim();

// A fake docker whose "image" carries docker-compose.yml (as in repair-compose-from-image.test.mjs, reduced).
function fakeComposeDocker(content = IMAGE_COMPOSE) {
  const binDir = scratchDir("orbit-owner-fakedocker-");
  const imageDir = scratchDir("orbit-owner-image-");
  writeFileSync(join(imageDir, "docker-compose.yml"), content);
  const root = "/opt/orbit/deploy";
  writeFileSync(
    join(binDir, "docker"),
    `#!/usr/bin/env bash
case "\${1:-}" in
  ps|info|volume|compose) exit 0 ;;
  image)
    [[ "\${2:-}" == inspect ]] || exit 1
    case "$*" in
      *io.orbit.deployment-assets*) echo '${root}';;
      *Config.Labels*) echo 'map[io.orbit.deployment-assets:${root}]';;
      *) echo 'sha256:${"c".repeat(64)}';;
    esac
    exit 0 ;;
  inspect) exit 1 ;;
  create) echo fakecontainer; exit 0 ;;
  rm) exit 0 ;;
  run)
    for a in "$@"; do
      if [[ "$a" == '${root}'/* ]]; then cat '${imageDir}'/"\${a#'${root}'/}" || exit 1; exit 0; fi
    done
    exit 1 ;;
esac
echo "fake docker: unsupported: $*" >&2
exit 1
`,
  );
  chmodSync(join(binDir, "docker"), 0o755);
  return binDir;
}

/** A folder where repair plans restore-compose-file (docker-compose.yml missing); `content` is what the image carries (#1873 X4). */
export function composeFolder(content = IMAGE_COMPOSE) {
  const targetDir = makeFixture();
  rmSync(join(targetDir, "docker-compose.yml"));
  return { targetDir, state: {}, fakeBin: fakeComposeDocker(content) };
}

/** A folder where repair plans the .env-orbit configuration-rollback restore. */
export function rollbackFolder() {
  const targetDir = makeFixture();
  writeFileSync(join(targetDir, ".env-orbit.orbit-config.rollback"), readFileSync(join(targetDir, ".env-orbit"), "utf8"), { mode: 0o600 });
  chmodSync(join(targetDir, ".env-orbit.orbit-config.rollback"), 0o600);
  writeFileSync(join(targetDir, ".env-orbit"), "APP_URL=https://orbit.repair-test.internal\n", { mode: 0o600 });
  chmodSync(join(targetDir, ".env-orbit"), 0o600);
  return { targetDir, state: { ...RUNNING }, fakeBin: null };
}

/** A folder where repair plans start-services. */
export function startFolder() {
  return { targetDir: makeFixture(), state: { ...STOPPED }, fakeBin: null };
}

/** A folder where repair plans recreate-services (the containers were made in a folder that is gone). */
export function recreateFolder() {
  const targetDir = makeFixture();
  const scratch = scratchDir();
  const labels = join(scratch, "labels");
  writeFileSync(labels, `${join(scratch, "old-orbit-folder")}\n`);
  return { targetDir, state: { ...RUNNING, docker: { workingDirLabelsPath: labels } }, fakeBin: null };
}

export const ACTIONS = {
  "start-services": { make: startFolder, done: "execute action=start-services resolves=services-not-running result=done" },
  "recreate-services": { make: recreateFolder, done: "execute action=recreate-services resolves=folder-moved result=done" },
  "restore-compose-file": { make: composeFolder, done: "execute action=restore-compose-file resolves=compose-file-restorable result=done" },
  "restore-config-rollback": { make: rollbackFolder, done: "execute action=restore-transaction resolves=configuration-migration-interrupted result=done" },
};

const timeoutBinary = real("timeout") || "/usr/bin/timeout";

/**
 * Runs `repair.sh --execute --safe-only` with "y" confirmed. `state` is prepareRepair's options (fake docker
 * state); `fakeBin` goes first on PATH; `shims.env` carries the simulated root. The run is capped at `capSeconds`
 * (the whole process group is killed after it); `ms` is how long it took.
 */
export function runOwner(targetDir, { shims, state = {}, fakeBin = null, env = {}, imported = true, capSeconds = 25, args = ["--execute", "--safe-only"], input = "y\n" } = {}) {
  const options = { ...state, ...(imported ? { mailStatus: "mail-sending source=imported imported-from-environment=true" } : {}), env: { ...shims.env, ...env } };
  const { merged, decorate } = prepareRepair(targetDir, options);
  if (fakeBin) merged.PATH = `${fakeBin}:${merged.PATH}`;
  const started = Date.now();
  const result = spawnSync(timeoutBinary, ["-k", "2", String(capSeconds), "bash", join(targetDir, "scripts", "repair.sh"), ...args], {
    cwd: targetDir,
    encoding: "utf8",
    input,
    env: merged,
    timeout: (capSeconds + 15) * 1000,
    killSignal: "SIGKILL",
    maxBuffer: 64 * 1024 * 1024,
  });
  const decorated = decorate({ status: result.status, stdout: result.stdout ?? "", stderr: result.stderr ?? "" });
  return { ...decorated, ms: Date.now() - started, hung: result.status === 124 || result.status === 137 || result.status === null };
}

export function mkdirp(path, mode = 0o700) {
  mkdirSync(path, { recursive: true, mode });
}
