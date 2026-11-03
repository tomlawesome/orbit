import { spawnSync } from "node:child_process";
import {
  chmodSync,
  copyFileSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  readdirSync,
  rmSync,
  statSync,
  writeFileSync,
  appendFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { afterEach, describe, expect, it } from "vitest";

/*
 * scripts/ci/upgrade-shapes/<shape>.sh (#1662): the five configuration shapes
 * of the upgrade matrix (#1647). Written from the issue text alone.
 *
 * Spec gaps decided here (the builder should confirm or amend the spec):
 *  - the shapes run with the target as the working directory's argument
 *    only; a fake `docker` first on PATH plays the daemon. It prints the
 *    container environment as NAME=value lines for any command that is not
 *    `docker compose ...`, and for `docker compose ... ps` prints the service
 *    names. FAKE_DOCKER_DOWN=1 makes it behave as if nothing is running.
 *  - oidc drift is edited into .env-orbit, which also breaks env-file-intact;
 *    the test accepts either id because the snapshot layout is unspecified.
 *  - overlay-composed drift is "nothing running" (the mail overlay adds no
 *    service of its own, only orbit-app environment and a secret).
 */
const repoRoot = fileURLToPath(new URL("../..", import.meta.url));
const shapesDir = join(repoRoot, "scripts/ci/upgrade-shapes");
const SHAPES = ["plain", "mail", "secrets-file", "oidc", "all-keys"];
const SECRET_FILE_SHAPES = ["secrets-file", "mail"];
const hasDocker = spawnSync("docker", ["compose", "version"], { stdio: "ignore" }).status === 0;

const scratch = [];
function tmp(label) {
  const dir = mkdtempSync(join(tmpdir(), `orbit-upgrade-shapes-${label}-`));
  scratch.push(dir);
  return dir;
}
afterEach(() => {
  while (scratch.length > 0) rmSync(scratch.pop(), { recursive: true, force: true });
});

const CONTAINER_ENV_SECRET = "fake-container-env-value-0a1b2c3d";

function fakeDocker(root) {
  const bin = join(root, "bin");
  mkdirSync(bin, { recursive: true });
  const path = join(bin, "docker");
  writeFileSync(
    path,
    `#!/usr/bin/env bash
printf '%s\\n' "$*" >> "\${FAKE_DOCKER_LOG:?}"
if [ "\${1:-}" = compose ]; then
  case " $* " in
    *" ps "*) [ "\${FAKE_DOCKER_DOWN:-0}" = 1 ] || printf 'orbit-app\\norbit-db\\n' ;;
  esac
  exit 0
fi
[ "\${FAKE_DOCKER_DOWN:-0}" = 1 ] && exit 1
cat "\${FAKE_DOCKER_ENV:?}"
exit 0
`,
  );
  chmodSync(path, 0o755);
  return bin;
}

const mode = (p) => statSync(p).mode & 0o777;

function parseEnv(text) {
  const out = {};
  for (const line of text.split("\n")) {
    const m = /^([A-Za-z_][A-Za-z0-9_]*)=(.*)$/.exec(line);
    if (m) out[m[1]] = m[2];
  }
  return out;
}

function makeWorld(shape) {
  const root = tmp(shape);
  const oldTree = join(root, "old");
  mkdirSync(oldTree);
  // Built from the real example, plus keys only this "old release" documents.
  copyFileSync(join(repoRoot, ".env-orbit.example"), join(oldTree, ".env-orbit.example"));
  appendFileSync(
    join(oldTree, ".env-orbit.example"),
    "\n# Documented only by the fixture's old release.\n# ORBIT_FIXTURE_OLD_ONLY_KEY=fixture-old-value\n",
  );
  const target = join(root, "target");
  mkdirSync(target);
  for (const f of ["docker-compose.yml", "docker-compose.mail.yml"]) {
    copyFileSync(join(repoRoot, f), join(target, f));
  }
  const bin = fakeDocker(root);
  const envFile = join(root, "container-env");
  const log = join(root, "docker.log");
  writeFileSync(log, "");
  const env = {
    PATH: `${bin}:${process.env.PATH}`,
    HOME: root,
    FAKE_DOCKER_LOG: log,
    FAKE_DOCKER_ENV: envFile,
  };
  return { root, oldTree, target, envFile, log, env, shape };
}

function run(world, verb, extraEnv = {}) {
  const r = spawnSync(
    "bash",
    [join(shapesDir, `${world.shape}.sh`), verb, world.target, world.oldTree],
    { cwd: repoRoot, encoding: "utf8", env: { ...world.env, ...extraEnv }, timeout: 60_000 },
  );
  world.outputs = (world.outputs ?? "") + r.stdout + r.stderr;
  return r;
}

// The container as the (fake) daemon reports it: every *_FILE name from
// .env-orbit, the names compose always sets, and one value-bearing variable
// that must never be echoed.
function writeContainerEnv(world) {
  const names = new Set([
    "SESSION_SECRET_FILE",
    "DOCUMENT_KEK_FILE",
    "POSTGRES_PASSWORD_FILE",
    "VAPID_PRIVATE_KEY_FILE",
    "ORBIT_IMAGE",
  ]);
  const dotenv = parseEnv(readFileSync(join(world.target, ".env-orbit"), "utf8"));
  for (const k of Object.keys(dotenv)) if (k.endsWith("_FILE")) names.add(k);
  if (world.shape === "mail") names.add("SMTP_PASSWORD_FILE");
  const lines = [...names].map((n) => `${n}=/run/orbit-secrets/${n.toLowerCase()}`);
  lines.push(`ORBIT_UNRELATED_TOKEN=${CONTAINER_ENV_SECRET}`);
  writeFileSync(world.envFile, `${lines.join("\n")}\n`);
}

function secretValues(world) {
  const values = new Set([CONTAINER_ENV_SECRET]);
  const dir = join(world.target, ".orbit-secrets");
  if (existsSync(dir)) {
    for (const f of readdirSync(dir)) {
      const v = readFileSync(join(dir, f), "utf8").trim();
      if (v.length >= 8) values.add(v);
    }
  }
  const envPath = join(world.target, ".env-orbit");
  if (existsSync(envPath)) {
    for (const [k, v] of Object.entries(parseEnv(readFileSync(envPath, "utf8")))) {
      if (!k.endsWith("_FILE") && /(SECRET|PASSWORD|KEK|TOKEN|PRIVATE_KEY)$/.test(k) && v.length >= 8) {
        values.add(v);
      }
    }
  }
  return [...values];
}

function expectNoSecrets(world) {
  const secrets = secretValues(world);
  for (const s of secrets) expect(world.outputs).not.toContain(s);
}

function installed(shape) {
  const world = makeWorld(shape);
  const p = run(world, "provision");
  expect(p.status, p.stdout + p.stderr).toBe(0);
  writeContainerEnv(world);
  const a = run(world, "after_install");
  expect(a.status, a.stdout + a.stderr).toBe(0);
  if (shape === "mail") writeContainerEnv(world); // COMPOSE_FILE line is now in .env-orbit
  return world;
}

function snapshotFiles(world) {
  const dir = join(world.target, ".upgrade-snapshot");
  expect(existsSync(dir)).toBe(true);
  return readdirSync(dir, { recursive: true, withFileTypes: true })
    .filter((d) => d.isFile())
    .map((d) => join(d.parentPath ?? d.path, d.name));
}

describe.each(SHAPES)("%s shape: provision", (shape) => {
  it("writes .env-orbit at 600 and any secrets dir at 700 with 600 files", () => {
    const world = makeWorld(shape);
    const r = run(world, "provision");
    expect(r.status, r.stdout + r.stderr).toBe(0);
    expect(mode(join(world.target, ".env-orbit"))).toBe(0o600);
    const secrets = join(world.target, ".orbit-secrets");
    if (existsSync(secrets)) {
      expect(mode(secrets)).toBe(0o700);
      for (const f of readdirSync(secrets)) expect(mode(join(secrets, f))).toBe(0o600);
    }
    expectNoSecrets(world);
  });

  it("builds only from keys the old release's example documents", () => {
    const world = makeWorld(shape);
    run(world, "provision");
    const keys = Object.keys(parseEnv(readFileSync(join(world.target, ".env-orbit"), "utf8")));
    const documented = new Set(
      [...readFileSync(join(world.oldTree, ".env-orbit.example"), "utf8").matchAll(/^#?\s*([A-Z][A-Z0-9_]*)=/gm)].map((m) => m[1]),
    );
    for (const k of keys) {
      // COMPOSE_FILE is added by after_install in the mail shape, not here.
      expect(documented.has(k), `${shape} wrote undocumented key ${k}`).toBe(true);
    }
  });

  it.skipIf(!hasDocker)("gives a .env-orbit that docker compose config accepts", () => {
    const world = makeWorld(shape);
    run(world, "provision");
    const r = spawnSync("docker", ["compose", "--env-file", ".env-orbit", "config", "-q"], {
      cwd: world.target,
      encoding: "utf8",
      env: {
        PATH: process.env.PATH,
        HOME: world.root,
        ORBIT_IMAGE: `127.0.0.1:5000/orbit/test@sha256:${"1".repeat(64)}`,
      },
    });
    expect(r.status, r.stderr).toBe(0);
  });
});

// Reason shown when docker is absent, so a skip is never silent.
it.skipIf(hasDocker)("docker compose config checks are skipped: docker is not installed on this host", () => {});

describe("shape contents", () => {
  it("plain keeps the example's defaults: OIDC off, no SMTP host", () => {
    const world = makeWorld("plain");
    run(world, "provision");
    const env = parseEnv(readFileSync(join(world.target, ".env-orbit"), "utf8"));
    expect(env.ORBIT_AUTH_OIDC ?? "false").toBe("false");
    expect(env.SMTP_HOST ?? "").toBe("");
  });

  it("secrets-file keeps every secret as a *_FILE reference to an existing 600 file", () => {
    const world = makeWorld("secrets-file");
    run(world, "provision");
    const env = parseEnv(readFileSync(join(world.target, ".env-orbit"), "utf8"));
    for (const direct of ["SESSION_SECRET", "DOCUMENT_KEK", "POSTGRES_PASSWORD", "SMTP_PASSWORD", "OIDC_CLIENT_SECRET"]) {
      expect(env[direct] ?? "", `${direct} must not be set directly`).toBe("");
    }
    for (const ref of ["SESSION_SECRET_FILE", "DOCUMENT_KEK_FILE", "POSTGRES_PASSWORD_FILE"]) {
      expect(env[ref], ref).toBeTruthy();
      const file = join(world.target, env[ref]);
      expect(existsSync(file), file).toBe(true);
      expect(mode(file)).toBe(0o600);
    }
  });

  it("oidc sets issuer, client id and a client-secret file", () => {
    const world = makeWorld("oidc");
    run(world, "provision");
    const env = parseEnv(readFileSync(join(world.target, ".env-orbit"), "utf8"));
    expect(env.OIDC_ISSUER).toBeTruthy();
    expect(env.OIDC_CLIENT_ID).toBeTruthy();
    expect(env.OIDC_CLIENT_SECRET_FILE).toBeTruthy();
    expect(env.OIDC_CLIENT_SECRET ?? "").toBe("");
  });

  it("mail provisions SMTP settings without the overlay line or the password file yet", () => {
    const world = makeWorld("mail");
    run(world, "provision");
    const env = parseEnv(readFileSync(join(world.target, ".env-orbit"), "utf8"));
    expect(env.SMTP_HOST).toBeTruthy();
    expect(env.COMPOSE_FILE ?? "").toBe("");
  });

  it("all-keys sets a key only the old example documents, and every uncommented key", () => {
    const world = makeWorld("all-keys");
    run(world, "provision");
    const text = readFileSync(join(world.target, ".env-orbit"), "utf8");
    const env = parseEnv(text);
    expect(env.ORBIT_FIXTURE_OLD_ONLY_KEY).toBeTruthy();
    const example = readFileSync(join(world.oldTree, ".env-orbit.example"), "utf8");
    for (const m of example.matchAll(/^([A-Z][A-Z0-9_]*)=/gm)) {
      expect(Object.keys(env), m[1]).toContain(m[1]);
    }
  });

  it("other shapes do not set the fixture's old-only key", () => {
    const world = makeWorld("plain");
    run(world, "provision");
    const env = parseEnv(readFileSync(join(world.target, ".env-orbit"), "utf8"));
    expect(env.ORBIT_FIXTURE_OLD_ONLY_KEY).toBeUndefined();
  });
});

describe("after_install", () => {
  it("mail writes smtp-password (600), adds the overlay line and runs compose up -d", () => {
    const world = installed("mail");
    const pw = join(world.target, ".orbit-secrets/smtp-password");
    expect(existsSync(pw)).toBe(true);
    expect(mode(pw)).toBe(0o600);
    const env = parseEnv(readFileSync(join(world.target, ".env-orbit"), "utf8"));
    expect(env.COMPOSE_FILE).toContain("docker-compose.mail.yml");
    expect(readFileSync(world.log, "utf8")).toMatch(/compose .*--env-file \.env-orbit .*up -d/);
    expect(mode(join(world.target, ".env-orbit"))).toBe(0o600);
    expectNoSecrets(world);
  });

  it.each(["plain", "secrets-file", "oidc", "all-keys"])("%s does not start anything", (shape) => {
    const world = installed(shape);
    expect(readFileSync(world.log, "utf8")).not.toMatch(/ up /);
  });

  it.each(SHAPES)("%s writes a snapshot holding no secret value", (shape) => {
    const world = installed(shape);
    const files = snapshotFiles(world);
    expect(files.length).toBeGreaterThan(0);
    for (const f of files) {
      const text = readFileSync(f, "utf8");
      for (const s of secretValues(world)) expect(text, f).not.toContain(s);
    }
    expect(files.map((f) => readFileSync(f, "utf8")).join("\n")).toContain("SESSION_SECRET_FILE");
    expectNoSecrets(world);
  });
});

describe.each(SHAPES)("%s shape: assert", (shape) => {
  const bumpImage = (world) => {
    const p = join(world.target, ".env-orbit");
    const text = readFileSync(p, "utf8")
      .split("\n")
      .filter((l) => !l.startsWith("ORBIT_IMAGE="))
      .join("\n");
    writeFileSync(p, `${text.replace(/\n*$/, "\n")}ORBIT_IMAGE=127.0.0.1:5000/orbit/new@sha256:${"2".repeat(64)}\n`);
  };

  it("passes silently on a matching snapshot, whatever ORBIT_IMAGE became", () => {
    const world = installed(shape);
    bumpImage(world);
    const r = run(world, "assert");
    expect(r.status, r.stdout + r.stderr).toBe(0);
    expect(r.stdout + r.stderr).toBe("");
  });

  it("reports env-file-intact when .env-orbit gained a line", () => {
    const world = installed(shape);
    appendFileSync(join(world.target, ".env-orbit"), "ORBIT_LOG_LEVEL=debug\n");
    const r = run(world, "assert");
    expect(r.status).toBe(1);
    expect(r.stdout).toMatch(/^assertion=env-file-intact detail="[^"\n]*"\n?$/);
    expectNoSecrets(world);
  });

  it("reports env-file-intact when a value changed, without printing either value", () => {
    const world = installed(shape);
    const p = join(world.target, ".env-orbit");
    const changed = readFileSync(p, "utf8").replace(/^ORBIT_PORT=.*$/m, "ORBIT_PORT=4999-fake-drift-value");
    writeFileSync(p, changed);
    const r = run(world, "assert");
    expect(r.status).toBe(1);
    expect(r.stdout).toMatch(/^assertion=env-file-intact /);
    expect(r.stdout.trimEnd().split("\n")).toHaveLength(1);
    expectNoSecrets(world);
  });

  it("does not print a secret that drifted into .env-orbit", () => {
    const world = installed(shape);
    const drifted = "fake-drifted-secret-value-9f8e7d6c";
    appendFileSync(join(world.target, ".env-orbit"), `SESSION_SECRET=${drifted}\n`);
    const r = run(world, "assert");
    expect(r.status).toBe(1);
    expect(r.stdout + r.stderr).not.toContain(drifted);
    expectNoSecrets(world);
  });

  if (SECRET_FILE_SHAPES.includes(shape)) {
    it("reports secret-file-referenced when a referenced file is gone", () => {
      const world = installed(shape);
      rmSync(join(world.target, ".orbit-secrets/session-secret"), { force: true });
      const r = run(world, "assert");
      expect(r.status).toBe(1);
      expect(r.stdout).toMatch(/^assertion=secret-file-referenced detail="[^"\n]*"\n?$/);
      expectNoSecrets(world);
    });

    it("reports secret-file-referenced when a *_FILE variable left the container env", () => {
      const world = installed(shape);
      const kept = readFileSync(world.envFile, "utf8")
        .split("\n")
        .filter((l) => !l.startsWith("DOCUMENT_KEK_FILE="))
        .join("\n");
      writeFileSync(world.envFile, kept);
      const r = run(world, "assert");
      expect(r.status).toBe(1);
      expect(r.stdout).toMatch(/^assertion=secret-file-referenced /);
      expectNoSecrets(world);
    });
  }

  if (shape === "mail") {
    it("reports overlay-composed when nothing of the stack is running", () => {
      const world = installed(shape);
      const r = run(world, "assert", { FAKE_DOCKER_DOWN: "1" });
      expect(r.status).toBe(1);
      expect(r.stdout).toMatch(/^assertion=overlay-composed detail="[^"\n]*"\n?$/);
    });
  }

  if (shape === "oidc") {
    it("reports oidc-intact (or env-file-intact, which sees the same edit) when an OIDC key changes", () => {
      const world = installed(shape);
      const p = join(world.target, ".env-orbit");
      writeFileSync(
        p,
        readFileSync(p, "utf8").replace(/^OIDC_ISSUER=.*$/m, "OIDC_ISSUER=https://drifted.invalid/"),
      );
      const r = run(world, "assert");
      expect(r.status).toBe(1);
      expect(r.stdout).toMatch(/^assertion=(oidc-intact|env-file-intact) detail="[^"\n]*"\n?$/);
    });
  }

  if (shape === "plain") {
    it("checks only env-file-intact: a missing container does not fail it", () => {
      const world = installed(shape);
      const r = run(world, "assert", { FAKE_DOCKER_DOWN: "1" });
      expect(r.status, r.stdout + r.stderr).toBe(0);
    });
  }
});
