import { chmodSync, copyFileSync, existsSync, lstatSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, statSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { afterEach, describe, expect, it, vi } from "vitest";

import { NOT_UTF8_FAILURE_MESSAGE } from "./configuration-migration";
import { DEPLOYMENT_ASSETS } from "./deployment-assets";
import type { EngineEvent } from "./engine-event";
import { type HostFacts, parseHostFacts } from "./host-facts";
import { type ConfigurationAnswers, type InstallContext, type InstallDependencies, runInstall } from "./install-orchestrator";
import { InstallPromptStop } from "./install-terminal";
import { scriptedTerminal } from "../../tests/support/scripted-terminal";

// The install/update engine (#1212), driven end to end against real
// directories: the deployment assets come from a fixture copy of this
// repository's own bundle, configuration is the real configure engine and
// migration, and the only seams are the ones the engine itself has -- the
// shell's Docker facts (F3), the operator's terminal (F4) and the OIDC
// transport (F5). Nothing here runs Docker, bash or a network call.

const repoRoot = fileURLToPath(new URL("../..", import.meta.url));
const DIGEST = `sha256:${"a".repeat(64)}`;
const REFERENCE = `ghcr.io/tomlawesome/orbit@${DIGEST}`;
const OLD_REFERENCE = `ghcr.io/tomlawesome/orbit@sha256:${"9".repeat(64)}`;
const VALID_DISCOVERY = JSON.stringify({
  issuer: "https://issuer.example.invalid",
  authorization_endpoint: "https://issuer.example.invalid/authorize",
  token_endpoint: "https://issuer.example.invalid/token",
  jwks_uri: "https://issuer.example.invalid/jwks",
});

const sandboxes: string[] = [];
afterEach(() => {
  for (const sandbox of sandboxes.splice(0)) rmSync(sandbox, { recursive: true, force: true });
});

function sandbox(prefix: string): string {
  const dir = mkdtempSync(join(tmpdir(), prefix));
  sandboxes.push(dir);
  return dir;
}

/** A copy of the image's /opt/orbit/deploy: the nine assets, plus something outside the allowlist. */
function assetsRoot(): string {
  const root = sandbox("orbit-install-assets-");
  for (const asset of DEPLOYMENT_ASSETS) {
    mkdirSync(dirname(join(root, asset)), { recursive: true });
    copyFileSync(join(repoRoot, asset), join(root, asset));
    chmodSync(join(root, asset), 0o755);
  }
  writeFileSync(join(root, "not-on-the-allowlist.txt"), "never installed\n");
  return root;
}

const b64 = (value: string) => Buffer.from(value, "utf8").toString("base64");

interface VolumeFacts {
  name: string;
  labels: string | null;
  containers: string | null;
}

function facts(options: { basename?: string; volumes?: VolumeFacts[]; projects?: Array<[string, string | null]>; images?: Array<[string, string | null]> } = {}): HostFacts {
  const volumes = options.volumes ?? [];
  return parseHostFacts(
    JSON.stringify({
      targetBasename: b64(options.basename ?? "household"),
      cosignUsable: false,
      imageVersion: "v1.2.3",
      imageRevision: "b".repeat(40),
      appliedDigest: DIGEST,
      volumeList: b64(volumes.map((volume) => volume.name).join("\n")),
      volumes: volumes.map((volume) => ({
        name: b64(volume.name),
        labels: volume.labels === null ? null : b64(volume.labels),
        containers: volume.containers === null ? null : b64(volume.containers),
      })),
      projects: (options.projects ?? []).map(([name, containers]) => ({ name: b64(name), containers: containers === null ? null : b64(containers) })),
      images: (options.images ?? []).map(([container, image]) => ({ container: b64(container), image: image === null ? null : b64(image) })),
    }),
  );
}

/** The facts for an update whose own volume is proven: one orbit-db and one orbit-app container in its project, the app on the recorded image. */
function provenVolumeFacts(project: string, recordedImage: string): HostFacts {
  return facts({
    volumes: [{ name: `${project}_orbit-db-data`, labels: `${project}|orbit-db-data`, containers: `${"c".repeat(12)}|${project}|orbit-db` }],
    projects: [[project, `${"c".repeat(12)}|${project}|orbit-db\n${"d".repeat(12)}|${project}|orbit-app`]],
    images: [["d".repeat(12), recordedImage]],
  });
}

const ENV_LOCAL = ["APP_URL=https://orbit.example.invalid", "ORBIT_AUTH_OIDC=false", ""].join("\n");
const ENV_OIDC = [
  "APP_URL=https://orbit.example.invalid",
  "ORBIT_AUTH_OIDC=true",
  "OIDC_ISSUER=https://issuer.example.invalid",
  "OIDC_CLIENT_ID=orbit-client",
  "OIDC_CALLBACK_URL=https://orbit.example.invalid/api/auth/callback",
  "OIDC_CLIENT_SECRET_FILE=/run/orbit-secrets/orbit-oidc-client-secret",
  "",
].join("\n");

/** is_preprovisioned_input's exact shape (guarantee #6). */
function preprovisioned(env: string = ENV_LOCAL): string {
  const target = sandbox("orbit-install-target-");
  writeFileSync(join(target, ".env-orbit"), env, { mode: 0o600 });
  mkdirSync(join(target, ".orbit-secrets"), { mode: 0o700 });
  writeFileSync(join(target, ".orbit-secrets", "oidc-client-secret"), "s3cr3t", { mode: 0o600 });
  return target;
}

/** A recognised deployment that an earlier install left behind, on the old image. */
function recognised(extraEnv: string[] = []): string {
  const target = sandbox("orbit-install-target-");
  writeFileSync(join(target, "docker-compose.yml"), readFileSync(join(repoRoot, "docker-compose.yml")));
  writeFileSync(
    join(target, ".env-orbit"),
    [`ORBIT_IMAGE=${OLD_REFERENCE}`, "ORBIT_CONFIG_SCHEMA_VERSION=1", "COMPOSE_PROJECT_NAME=orbit", ...ENV_LOCAL.trim().split("\n"), ...extraEnv, ""].join("\n"),
    { mode: 0o600 },
  );
  mkdirSync(join(target, ".orbit-secrets"), { mode: 0o700 });
  for (const name of ["session-secret", "postgres-password", "document-kek"]) {
    writeFileSync(join(target, ".orbit-secrets", name), `${"e".repeat(64)}\n`, { mode: 0o600 });
  }
  return target;
}

function snapshot(dir: string): Record<string, string> {
  const result: Record<string, string> = {};
  const walk = (relative: string) => {
    for (const entry of readdirSync(join(dir, relative)).sort()) {
      const path = join(relative, entry);
      const stat = lstatSync(join(dir, path));
      if (stat.isDirectory()) {
        result[`${path}/`] = (stat.mode & 0o777).toString(8);
        walk(path);
      } else {
        result[path] = `${(stat.mode & 0o777).toString(8)}:${readFileSync(join(dir, path), "utf8")}`;
      }
    }
  };
  walk("");
  return result;
}

const noAnswers: ConfigurationAnswers = {
  guidedInit: () => {
    throw new InstallPromptStop(1, "no terminal");
  },
  oidcSecret: () => {
    throw new InstallPromptStop(1, "no terminal");
  },
};

function discoveryFetch(body = VALID_DISCOVERY, status = 200): typeof fetch {
  return async () => new Response(body, { status });
}

async function run(target: string, overrides: Partial<InstallContext> = {}, dependencies: Partial<InstallDependencies> = {}) {
  const events: EngineEvent[] = [];
  const said: string[] = [];
  const context: InstallContext = {
    targetDir: target,
    requestedAction: undefined,
    plainMode: false,
    interactive: false,
    resolvedReference: REFERENCE,
    channel: "latest",
    facts: facts(),
    assetsRoot: assetsRoot(),
    ...overrides,
  };
  const outcome = await runInstall(
    context,
    { answers: noAnswers, fetchImpl: discoveryFetch(), capacity: () => "sufficient", say: (line) => said.push(line), ...dependencies },
    (event) => events.push(event),
  );
  return { outcome, events, said, context };
}

const eventKey = (event: EngineEvent) => `${event.phase} ${event.component} ${event.state} ${event.reason} ${event.action}`;

describe("runInstall: success", () => {
  it("installs a pre-provisioned target unattended: assets from the image, secrets, migration, digest (#6, #42, #45, #53)", async () => {
    const target = preprovisioned();
    const { outcome, events } = await run(target);

    expect(outcome).toEqual({ status: "ok", fresh: true, selectedProfile: "standard", modelPullRequested: false, databaseVolume: undefined });
    for (const asset of DEPLOYMENT_ASSETS) {
      expect(readFileSync(join(target, asset)).equals(readFileSync(join(repoRoot, asset))), `${asset} is not byte-identical to the image copy`).toBe(true);
      expect(statSync(join(target, asset)).mode & 0o777).toBe(0o644);
    }
    expect(existsSync(join(target, "not-on-the-allowlist.txt"))).toBe(false);
    const env = readFileSync(join(target, ".env-orbit"), "utf8");
    expect(env.match(/^ORBIT_IMAGE=.*$/gm)).toEqual([`ORBIT_IMAGE=${REFERENCE}`]);
    expect(env).toContain("ORBIT_CONFIG_SCHEMA_VERSION=1\n");
    expect(env).toContain("ORBIT_CONFIG_APPLIED_VERSION=v1.2.3\n");
    expect(env).toContain(`ORBIT_CONFIG_APPLIED_DIGEST=${DIGEST}\n`);
    for (const secret of ["session-secret", "postgres-password", "document-kek"]) {
      expect(statSync(join(target, ".orbit-secrets", secret)).mode & 0o777).toBe(0o600);
    }
    expect(events.map(eventKey)).toEqual([
      "assets assets starting assets-verified fetch",
      "assets assets completed assets-verified fetch",
      "configuration configuration starting configuration-migration configure",
      "configuration configuration running configuration-migration verify",
      "configuration configuration completed configuration-migration verify",
      "oidc oidc skipped provider-discovery skip",
    ]);
    // Nothing but the deployment is left in the target: no staging, scratch or lock.
    expect(readdirSync(target).filter((entry) => entry.startsWith(".orbit-")).sort()).toEqual([".orbit-secrets"]);
  });

  it("names a fresh install's Compose project from the bundled docker-compose.yml, not the directory (#999)", async () => {
    const target = preprovisioned();
    await run(target, { facts: facts({ basename: "household" }) });
    expect(readFileSync(join(target, ".env-orbit"), "utf8")).toContain("COMPOSE_PROJECT_NAME=orbit\n");
  });

  it("verifies OIDC discovery in the engine when the deployment turned a provider on (#25-27, F5)", async () => {
    const target = preprovisioned(ENV_OIDC);
    const { outcome, events } = await run(target);
    expect(outcome).toMatchObject({ status: "ok" });
    expect(events.map(eventKey)).toContain("oidc oidc completed provider-discovery verify");
  });

  it("updates a recognised deployment on its proven volume, preserving the profile and every secret (#13, #19)", async () => {
    const target = recognised(["COMPOSE_PROFILES=processing", "TIKA_URL=http://orbit-tika:9998"]);
    const secretsBefore = snapshot(join(target, ".orbit-secrets"));
    const { outcome } = await run(target, { facts: provenVolumeFacts("orbit", OLD_REFERENCE) });

    expect(outcome).toEqual({ status: "ok", fresh: false, selectedProfile: "processing", modelPullRequested: false, databaseVolume: "orbit_orbit-db-data" });
    const after = snapshot(join(target, ".orbit-secrets"));
    for (const [path, value] of Object.entries(secretsBefore)) expect(after[path]).toBe(value);
    expect(readFileSync(join(target, ".env-orbit"), "utf8")).toContain(`ORBIT_IMAGE=${REFERENCE}\n`);
  });
});

describe("runInstall: target and action (guarantees #7, #21)", () => {
  it("refuses an unrecognisable directory, changing nothing", async () => {
    const target = sandbox("orbit-install-target-");
    writeFileSync(join(target, "notes.txt"), "mine\n");
    const { outcome } = await run(target);
    expect(outcome).toMatchObject({ status: "failed", phase: "host", reason: "docker-host" });
    expect(readdirSync(target)).toEqual(["notes.txt"]);
  });

  it("refuses an update whose optional-service configuration matches no supported profile (#23)", async () => {
    const target = recognised(["COMPOSE_PROFILES=ai"]);
    const before = snapshot(target);
    const { outcome } = await run(target, { facts: provenVolumeFacts("orbit", OLD_REFERENCE) });
    expect(outcome).toMatchObject({ status: "failed", phase: "host", message: "The existing optional-service configuration is unsupported or ambiguous." });
    expect(snapshot(target)).toEqual(before);
  });

  // An open document-key rotation (the .orbit-secrets/document-kek-next
  // overlay) must be finished or aborted before anything else changes the
  // deployment (#1316).
  it("refuses an update while a document-key rotation is open, before any file changes (#1316)", async () => {
    const target = recognised();
    writeFileSync(join(target, ".orbit-secrets", "document-kek-next"), `${"f".repeat(64)}\n`, { mode: 0o600 });
    const before = snapshot(target);
    const { outcome } = await run(target, { facts: provenVolumeFacts("orbit", OLD_REFERENCE) });

    expect(outcome.status).toBe("failed");
    const message = outcome.status === "failed" ? outcome.message : "";
    expect(message).toMatch(/document-key rotation is open/i);
    expect(message).toMatch(/finish/i);
    expect(message).toMatch(/rewrap/i);
    expect(message).toMatch(/overlay/i);
    expect(message).toMatch(/abort/i);
    expect(snapshot(target)).toEqual(before);
  });

  it("refuses an explicit install over a recognised deployment, and an explicit update of an empty target", async () => {
    expect((await run(recognised(), { requestedAction: "install" })).outcome).toMatchObject({
      status: "failed",
      message: "Install requires an empty target or safe pre-provisioned bootstrap; use Update for a recognized deployment.",
    });
    expect((await run(sandbox("orbit-install-target-"), { requestedAction: "update" })).outcome).toMatchObject({
      status: "failed",
      message: "Update requires a recognized existing Orbit deployment.",
    });
  });

  it("signposts repair from the menu and changes nothing (#22)", async () => {
    const target = sandbox("orbit-install-target-");
    const { outcome, events } = await run(target, { interactive: true }, { terminal: scriptedTerminal(["repair"]) });
    expect(outcome).toEqual({ status: "repair" });
    expect(events.map(eventKey)).toEqual(["rollback installer blocked repair-unavailable repair"]);
    expect(readdirSync(target)).toEqual([]);
  });

  it("treats Exit on the menu as the operator declining (130)", async () => {
    const { outcome } = await run(sandbox("orbit-install-target-"), { interactive: true }, { terminal: scriptedTerminal(["exit"]) });
    expect(outcome).toMatchObject({ status: "stopped", exitCode: 130 });
  });

  it("asks no question in plain mode, even at a terminal", async () => {
    const terminal = scriptedTerminal([]);
    const { outcome } = await run(preprovisioned(), { interactive: true, plainMode: true }, { terminal });
    expect(outcome.status).toBe("ok");
    expect(terminal.output()).toBe("");
  });
});

describe("runInstall: database volume safety from the shell's facts (#13-18, F3)", () => {
  it("refuses a fresh install whose own volume already exists, naming it and the removal command", async () => {
    const { outcome } = await run(preprovisioned(), {
      facts: facts({ volumes: [{ name: "orbit_orbit-db-data", labels: "orbit|orbit-db-data", containers: "" }] }),
    });
    expect(outcome).toMatchObject({ status: "failed", phase: "host" });
    if (outcome.status === "failed") expect(outcome.message).toContain("docker volume rm -- orbit_orbit-db-data");
  });

  it("ignores another project's volume on a fresh install (#1239)", async () => {
    const { outcome } = await run(preprovisioned(), {
      facts: facts({ volumes: [{ name: "other_orbit-db-data", labels: "other|orbit-db-data", containers: "" }] }),
    });
    expect(outcome.status).toBe("ok");
  });

  it("fails closed when a fact the proof needs is missing, as a failed docker call did (#14)", async () => {
    const target = recognised();
    const before = snapshot(target);
    const { outcome } = await run(target, {
      facts: facts({ volumes: [{ name: "orbit_orbit-db-data", labels: "orbit|orbit-db-data", containers: null }] }),
    });
    expect(outcome).toMatchObject({ status: "failed", message: "Could not verify the existing Orbit database volume ownership; refusing to start Compose." });
    expect(snapshot(target)).toEqual(before);
  });
});

describe("runInstall: deployment assets from the image (F2, #42, #45)", () => {
  it.each([
    ["missing", (root: string) => rmSync(join(root, "config/tika-config.json")), "Bundled config/tika-config.json is not a regular file."],
    ["a symlink", (root: string) => {
      rmSync(join(root, "scripts/repair.sh"));
      symlinkSync("/etc/passwd", join(root, "scripts/repair.sh"));
    }, "Bundled scripts/repair.sh is not a regular file."],
    ["empty", (root: string) => writeFileSync(join(root, "docker-compose.mail.yml"), ""), "Bundled docker-compose.mail.yml is empty."],
    ["a directory", (root: string) => {
      rmSync(join(root, "scripts/backup.sh"));
      mkdirSync(join(root, "scripts/backup.sh"));
    }, "Bundled scripts/backup.sh is not a regular file."],
  ])("refuses a bundle whose asset is %s, before touching the target", async (_label, damage, message) => {
    const target = preprovisioned();
    const before = snapshot(target);
    const root = assetsRoot();
    damage(root);
    const { outcome } = await run(target, { assetsRoot: root });
    expect(outcome).toMatchObject({ status: "failed", phase: "assets", reason: "image-registry", message });
    expect(snapshot(target)).toEqual(before);
  });
});

describe("runInstall: refusals inside the transaction roll back (#11, #56)", () => {
  it("refuses an unattended run with required fields missing, printing the remediation guidance (#24)", async () => {
    const target = preprovisioned("ORBIT_AUTH_OIDC=false\n");
    const before = snapshot(target);
    const { outcome } = await run(target);
    expect(outcome).toMatchObject({
      status: "failed",
      phase: "configuration",
      reason: "configuration-failure",
      action: "retry",
      message: "Required configuration fields require attention; refusing to start Compose.",
    });
    if (outcome.status === "failed") expect(outcome.guidance?.[0]).toMatch(/^Orbit installer: configuration fields requiring attention: /);
    expect(snapshot(target)).toEqual(before);
  });

  it("reports the retired ORBIT_SECRETS_DIR setting of a recognised update in the failure message, and rolls back (#1316)", async () => {
    const target = recognised(["ORBIT_SECRETS_DIR=/srv/secrets"]);
    const before = snapshot(target);
    const { outcome } = await run(target, { facts: provenVolumeFacts("orbit", OLD_REFERENCE) });
    expect(outcome).toMatchObject({ status: "failed", phase: "configuration", reason: "configuration-failure" });
    if (outcome.status === "failed") expect(outcome.message).toContain("ORBIT_SECRETS_DIR");
    expect(snapshot(target)).toEqual(before);
  });

  it("rolls back on an unavailable provider, with its own reason (#25)", async () => {
    const target = preprovisioned(ENV_OIDC);
    const before = snapshot(target);
    const { outcome } = await run(target, {}, { fetchImpl: async () => Promise.reject(new Error("offline")) });
    expect(outcome).toMatchObject({ status: "failed", phase: "oidc", reason: "provider-unavailable", action: "retry" });
    expect(snapshot(target)).toEqual(before);
  });

  it("hands the launcher its tree once, before rolling back, on a configuration failure such as a non-2xx discovery answer (#1225)", async () => {
    const target = preprovisioned(ENV_OIDC);
    const before = snapshot(target);
    let handedOver = 0;
    let targetAtHandOver: Record<string, string> | undefined;
    const { outcome } = await run(target, {}, {
      fetchImpl: discoveryFetch("not here", 404),
      onConfigurationFailure: () => {
        handedOver += 1;
        targetAtHandOver = snapshot(target);
      },
    });
    expect(outcome).toMatchObject({ status: "failed", phase: "oidc", reason: "configuration-failure" });
    expect(handedOver).toBe(1);
    // Called while the transaction still held the run's changes: before the rollback.
    expect(targetAtHandOver).not.toEqual(before);
    expect(snapshot(target)).toEqual(before);
  });

  it("never offers the launcher tree for a failure that is not a configuration failure", async () => {
    let handedOver = 0;
    const { outcome } = await run(preprovisioned(ENV_OIDC), {}, {
      fetchImpl: async () => Promise.reject(new Error("offline")),
      onConfigurationFailure: () => {
        handedOver += 1;
      },
    });
    expect(outcome).toMatchObject({ status: "failed", reason: "provider-unavailable" });
    expect(handedOver).toBe(0);
  });

  it("rolls back a recognised update if configuration changed the preserved database password (#19)", async () => {
    const target = recognised();
    const before = snapshot(target);
    const password = join(target, ".orbit-secrets", "postgres-password");
    let tampered = false;
    const { outcome } = await run(target, { facts: provenVolumeFacts("orbit", OLD_REFERENCE) }, {
      // Inside the transaction (after its backup), as a misbehaving configure step would.
      say: () => {
        if (tampered) return;
        tampered = true;
        writeFileSync(password, `${"f".repeat(64)}\n`, { mode: 0o600 });
      },
    });
    expect(tampered).toBe(true);
    expect(outcome).toMatchObject({
      status: "failed",
      message: "The existing POSTGRES_PASSWORD_FILE changed during configuration; refusing to start Compose.",
    });
    expect(snapshot(target)).toEqual(before);
  });

  it("persists exactly one resolved image line on its own line, from a file with no final newline (#53)", async () => {
    const target = recognised();
    const environment = join(target, ".env-orbit");
    writeFileSync(environment, readFileSync(environment, "utf8").replace(/\n$/, ""), { mode: 0o600 });
    const { outcome } = await run(target, { facts: provenVolumeFacts("orbit", OLD_REFERENCE) });
    expect(outcome).toMatchObject({ status: "ok" });
    const content = readFileSync(environment, "utf8");
    expect(content.split("\n").filter((line) => line.startsWith("ORBIT_IMAGE"))).toEqual([`ORBIT_IMAGE=${REFERENCE}`]);
    expect(content.endsWith("\n")).toBe(true);
  });

  it("refuses, and rolls back, a file that assigns the image twice: the preflight never lets a duplicated key through (#50, #53)", async () => {
    const target = recognised();
    const environment = join(target, ".env-orbit");
    writeFileSync(environment, `${readFileSync(environment, "utf8")}ORBIT_IMAGE=${OLD_REFERENCE}\n`, { mode: 0o600 });
    const before = snapshot(target);
    const { outcome } = await run(target, { facts: provenVolumeFacts("orbit", OLD_REFERENCE) });
    expect(outcome).toMatchObject({ status: "failed", message: "Configuration preflight failed; restoring the previous deployment." });
    expect(snapshot(target)).toEqual(before);
  });

  it("names an unknown setting in the failure, with what to do about it (#1316)", async () => {
    const target = recognised(["IMAP_HOST=mail.example.test"]);
    const before = snapshot(target);
    const { outcome } = await run(target, { facts: provenVolumeFacts("orbit", OLD_REFERENCE) });
    expect(outcome).toMatchObject({ status: "failed", phase: "configuration", reason: "configuration-failure" });
    const message = outcome.status === "failed" ? outcome.message : "";
    expect(message).toContain("IMAP_HOST");
    expect(message).toMatch(/not an Orbit setting/);
    expect(message).toMatch(/delete or correct (the|that) line/i);
    expect(message).toMatch(/re-?run/i);
    expect(snapshot(target)).toEqual(before);
  });

  it("names the conflicting pair when a secret and its _FILE twin are both set (#1316)", async () => {
    const target = recognised(["SESSION_SECRET=direct-value", "SESSION_SECRET_FILE=/run/orbit-secrets/session-secret"]);
    const before = snapshot(target);
    const { outcome } = await run(target, { facts: provenVolumeFacts("orbit", OLD_REFERENCE) });
    expect(outcome).toMatchObject({ status: "failed", phase: "configuration", reason: "configuration-failure" });
    const message = outcome.status === "failed" ? outcome.message : "";
    expect(message).toContain("SESSION_SECRET");
    expect(message).toContain("SESSION_SECRET_FILE");
    expect(message).not.toBe("Configuration preflight failed; restoring the previous deployment.");
    expect(snapshot(target)).toEqual(before);
  });

  it("names only session-ttl when SESSION_TTL_SECONDS is out of range in an otherwise complete deployment (#1316)", async () => {
    const target = recognised(["SESSION_TTL_SECONDS=100"]);
    const before = snapshot(target);
    const { outcome } = await run(target, { facts: provenVolumeFacts("orbit", OLD_REFERENCE) });
    expect(outcome).toMatchObject({ status: "failed", phase: "configuration", reason: "configuration-failure" });
    const message = outcome.status === "failed" ? outcome.message : "";
    expect(message).toContain("session-ttl");
    expect(message).not.toContain("APP_URL");
    expect(message).not.toContain("ORBIT_IMAGE");
    expect(message).not.toMatch(/OIDC_/);
    expect(snapshot(target)).toEqual(before);
  });

  it("names memory-limit when ORBIT_MEMORY_LIMIT is malformed in an otherwise complete deployment (F2)", async () => {
    const target = recognised(["ORBIT_MEMORY_LIMIT=lots"]);
    const before = snapshot(target);
    const { outcome } = await run(target, { facts: provenVolumeFacts("orbit", OLD_REFERENCE) });
    expect(outcome).toMatchObject({ status: "failed", phase: "configuration", reason: "configuration-failure" });
    const message = outcome.status === "failed" ? outcome.message : "";
    expect(message).toContain("memory-limit");
    expect(message).not.toContain("lots");
    expect(message).not.toContain("APP_URL");
    expect(message).not.toContain("ORBIT_IMAGE");
    expect(snapshot(target)).toEqual(before);
  });

  it("says the memory warning once, in the installer window, when ORBIT_MEMORY_LIMIT is below 1g (F2)", async () => {
    const target = recognised(["ORBIT_MEMORY_LIMIT=512m"]);
    const { said } = await run(target, { facts: provenVolumeFacts("orbit", OLD_REFERENCE) });
    expect(said.filter((line) => line.startsWith("warning ORBIT_MEMORY_LIMIT is below about 1 GB"))).toHaveLength(1);
  });

  it("says no memory warning at 2g (F2)", async () => {
    const target = recognised(["ORBIT_MEMORY_LIMIT=2g"]);
    const { said } = await run(target, { facts: provenVolumeFacts("orbit", OLD_REFERENCE) });
    expect(said.filter((line) => line.includes("ORBIT_MEMORY_LIMIT"))).toEqual([]);
  });

  it("rolls back an update whose configuration does not pass the preflight (#50)", async () => {
    const target = recognised();
    writeFileSync(join(target, ".env-orbit"), "not an assignment\n", { mode: 0o600 });
    const before = snapshot(target);
    const { outcome } = await run(target);
    expect(outcome).toMatchObject({ status: "failed", message: "Configuration preflight failed; restoring the previous deployment." });
    expect(snapshot(target)).toEqual(before);
  });

  it("reports a .env-orbit that is not valid UTF-8 as a failed outcome, not a thrown refusal, and leaves the target unchanged (#1316)", async () => {
    const target = recognised();
    const envPath = join(target, ".env-orbit");
    writeFileSync(envPath, Buffer.concat([readFileSync(envPath), Buffer.from("# caf"), Buffer.from([0xe9]), Buffer.from("\n")]), { mode: 0o600 });
    const bytesBefore = readFileSync(envPath);
    const before = snapshot(target);
    const { outcome } = await run(target);
    expect(outcome).toMatchObject({ status: "failed", message: NOT_UTF8_FAILURE_MESSAGE });
    expect(snapshot(target)).toEqual(before);
    expect(readFileSync(envPath).equals(bytesBefore)).toBe(true);
  });
});

describe("runInstall: at the operator's terminal (F4)", () => {
  it("stages a guided fresh install and applies it only after the final review (#30-32)", async () => {
    const target = sandbox("orbit-install-target-");
    const terminal = scriptedTerminal(["install", "standard", "apply", "apply"]);
    const answers: ConfigurationAnswers = {
      guidedInit: (hint) => {
        expect(hint).toBeUndefined();
        return { appUrl: "https://guided.example.invalid", authMode: "local" };
      },
      oidcSecret: () => {
        throw new Error("local-only: no secret is asked");
      },
    };
    const { outcome } = await run(target, { interactive: true }, { terminal, answers });
    expect(outcome).toMatchObject({ status: "ok", fresh: true, selectedProfile: "standard" });
    expect(readFileSync(join(target, ".env-orbit"), "utf8")).toContain("APP_URL=https://guided.example.invalid\n");
    expect(terminal.output()).toContain("Final review: apply the collected core settings and selected standard profile.");
    expect(terminal.remaining()).toBe(0);
  });

  it("asks for the OIDC client secret when the guided answers turned a provider on", async () => {
    const target = sandbox("orbit-install-target-");
    const answers: ConfigurationAnswers = {
      guidedInit: () => ({ appUrl: "https://guided.example.invalid", authMode: "oidc", issuer: "https://issuer.example.invalid", clientId: "orbit-client" }),
      oidcSecret: () => "s3cr3t-guided",
    };
    const { outcome } = await run(target, { interactive: true }, { terminal: scriptedTerminal(["install", "standard", "apply", "apply"]), answers });
    expect(outcome.status).toBe("ok");
    expect(readFileSync(join(target, ".orbit-secrets", "oidc-client-secret"), "utf8")).toBe("s3cr3t-guided");
  });

  it("changes nothing when the final review is cancelled (130)", async () => {
    const target = sandbox("orbit-install-target-");
    const answers: ConfigurationAnswers = { ...noAnswers, guidedInit: () => ({ appUrl: "https://guided.example.invalid", authMode: "local" }) };
    const { outcome } = await run(target, { interactive: true }, { terminal: scriptedTerminal(["install", "standard", "apply", "cancel"]), answers });
    expect(outcome).toMatchObject({ status: "stopped", exitCode: 130 });
    expect(readdirSync(target)).toEqual([]);
  });

  it("fails as a configuration failure, target unchanged, when guided answers are cancelled", async () => {
    const target = sandbox("orbit-install-target-");
    const { outcome } = await run(target, { interactive: true }, { terminal: scriptedTerminal(["install", "standard", "apply"]) });
    expect(outcome).toMatchObject({
      status: "failed",
      phase: "configuration",
      reason: "configuration-failure",
      message: "Guided configuration was cancelled or invalid; the target remains unchanged.",
    });
    expect(readdirSync(target)).toEqual([]);
  });

  it("asks an update's missing fields with the deployment's own sign-in mode (#918)", async () => {
    const target = recognised();
    writeFileSync(join(target, ".env-orbit"), readFileSync(join(target, ".env-orbit"), "utf8").replace("APP_URL=https://orbit.example.invalid\n", ""), { mode: 0o600 });
    let hint: string | undefined = "unset";
    const answers: ConfigurationAnswers = {
      ...noAnswers,
      guidedInit: (authModeHint) => {
        hint = authModeHint;
        return { appUrl: "https://asked.example.invalid", authMode: "local" };
      },
    };
    const { outcome } = await run(target, { interactive: true, requestedAction: "update" }, { answers, terminal: scriptedTerminal([]) });
    expect(outcome.status).toBe("ok");
    expect(hint).toBe("local");
    expect(readFileSync(join(target, ".env-orbit"), "utf8")).toContain("APP_URL=https://asked.example.invalid\n");
  });

  it("records a confirmed model download for the shell, with the model in .env-orbit (#20)", async () => {
    const target = recognised();
    const terminal = scriptedTerminal(["update", "change", "full", "llama3.2:3b", "pull", "apply"]);
    const { outcome } = await run(target, { interactive: true }, { terminal });
    expect(outcome).toMatchObject({ status: "ok", selectedProfile: "full", modelPullRequested: true });
    expect(readFileSync(join(target, ".env-orbit"), "utf8")).toContain("OLLAMA_MODEL=llama3.2:3b\n");
    expect(terminal.output()).toContain("Current: schema=v1");
  });
});

// Redesign r5 (B27, section 13.5): the drill's `transaction-committed` kill
// point is the `afterTransactionCommitted` dependency, beside
// `afterTransactionBegun`, which the orchestrator calls right after
// `transaction.commit()`, before it hands back the outcome the CLI writes.
// The CLI maps ORBIT_INSTALL_TEST_HARD_INTERRUPT_STAGE=transaction-committed
// to it (src/cli/orbit.install.test.ts drives that half).
describe("runInstall: the hook after the transaction commits (redesign r5)", () => {
  it("calls afterTransactionCommitted once, after the commit put the files in place and before the outcome is returned", async () => {
    const target = preprovisioned();
    const before = readFileSync(join(target, ".env-orbit"), "utf8");
    const order: string[] = [];
    const seen: { composeFile?: boolean; envRewritten?: boolean } = {};
    const hook = () => {
      order.push("committed");
      seen.composeFile = existsSync(join(target, "docker-compose.yml"));
      seen.envRewritten = readFileSync(join(target, ".env-orbit"), "utf8") !== before;
    };
    const { outcome } = await run(target, {}, { afterTransactionCommitted: hook } as Partial<InstallDependencies>);
    order.push("returned");
    expect(outcome).toMatchObject({ status: "ok", fresh: true });
    expect(order).toEqual(["committed", "returned"]);
    expect(seen).toEqual({ composeFile: true, envRewritten: true });
  });

  it("guard: never calls it when nothing is committed (a refused target, or a refusal inside the transaction)", async () => {
    const calls: string[] = [];
    const hook = () => calls.push("committed");
    const unrecognisable = sandbox("orbit-install-target-");
    writeFileSync(join(unrecognisable, "notes.txt"), "mine\n");
    expect((await run(unrecognisable, {}, { afterTransactionCommitted: hook } as Partial<InstallDependencies>)).outcome.status).toBe("failed");
    expect((await run(preprovisioned("ORBIT_AUTH_OIDC=false\n"), {}, { afterTransactionCommitted: hook } as Partial<InstallDependencies>)).outcome.status).toBe("failed");
    expect(calls).toEqual([]);
  });
});

// #1504: ORBIT_INSTALL_PROFILE, as the CLI hands it to the engine in
// InstallContext.requestedProfile, picks the profile of a plain-mode fresh
// install. The engine runs no Docker: the shell starts the services named by
// the outcome's selectedProfile (orbit-tika for processing).
describe("runInstall: requested profile on a non-interactive install (#1504)", () => {
  it("installs the processing profile: Tika configured and the outcome naming processing (#1504)", async () => {
    const target = preprovisioned();
    const { outcome } = await run(target, { requestedProfile: "processing" });
    expect(outcome).toEqual({ status: "ok", fresh: true, selectedProfile: "processing", modelPullRequested: false, databaseVolume: undefined });
    const env = readFileSync(join(target, ".env-orbit"), "utf8");
    expect(env).toContain("COMPOSE_PROFILES=processing\n");
    expect(env).toContain("TIKA_URL=http://orbit-tika:9998\n");
  });

  it.each([["standard"], [undefined]])("installs the standard profile for requestedProfile %j, as before (#1504)", async (requestedProfile) => {
    const target = preprovisioned();
    const { outcome } = await run(target, { requestedProfile });
    expect(outcome).toEqual({ status: "ok", fresh: true, selectedProfile: "standard", modelPullRequested: false, databaseVolume: undefined });
    const env = readFileSync(join(target, ".env-orbit"), "utf8");
    expect(env).not.toContain("COMPOSE_PROFILES=processing");
    expect(env).not.toContain("TIKA_URL=http://orbit-tika:9998");
  });

  it.each([["ai"], ["full"], ["bogus"]])("refuses the %s profile in the host phase, before anything is written (#1504)", async (requestedProfile) => {
    const target = preprovisioned();
    const before = snapshot(target);
    const { outcome } = await run(target, { requestedProfile });
    expect(outcome).toMatchObject({ status: "failed", phase: "host", component: "host", message: "ORBIT_INSTALL_PROFILE must be standard or processing." });
    expect(snapshot(target)).toEqual(before);
    expect(readdirSync(target).sort()).toEqual([".env-orbit", ".orbit-secrets"]);
  });

  it("ignores the request when the interactive wizard was shown: the wizard's answer wins (#1504)", async () => {
    const target = sandbox("orbit-install-target-");
    const terminal = scriptedTerminal(["install", "standard", "apply", "apply"]);
    const answers: ConfigurationAnswers = {
      guidedInit: () => ({ appUrl: "https://guided.example.invalid", authMode: "local" }),
      oidcSecret: () => {
        throw new Error("local-only: no secret is asked");
      },
    };
    const { outcome } = await run(target, { interactive: true, requestedProfile: "processing" }, { terminal, answers });
    expect(outcome).toMatchObject({ status: "ok", fresh: true, selectedProfile: "standard" });
    expect(readFileSync(join(target, ".env-orbit"), "utf8")).not.toContain("COMPOSE_PROFILES=processing");
  });

  it("ignores an invalid request when the interactive wizard was shown (#1504)", async () => {
    const target = sandbox("orbit-install-target-");
    const terminal = scriptedTerminal(["install", "standard", "apply", "apply"]);
    const answers: ConfigurationAnswers = {
      guidedInit: () => ({ appUrl: "https://guided.example.invalid", authMode: "local" }),
      oidcSecret: () => {
        throw new Error("local-only: no secret is asked");
      },
    };
    const { outcome } = await run(target, { interactive: true, requestedProfile: "bogus" }, { terminal, answers });
    expect(outcome).toMatchObject({ status: "ok", fresh: true, selectedProfile: "standard" });
  });

  it.each([["standard"], ["bogus"]])("ignores requestedProfile %j on an update and keeps the existing profile (#1504)", async (requestedProfile) => {
    const target = recognised(["COMPOSE_PROFILES=processing", "TIKA_URL=http://orbit-tika:9998"]);
    const { outcome } = await run(target, { requestedProfile, facts: provenVolumeFacts("orbit", OLD_REFERENCE) });
    expect(outcome).toEqual({ status: "ok", fresh: false, selectedProfile: "processing", modelPullRequested: false, databaseVolume: "orbit_orbit-db-data" });
    expect(readFileSync(join(target, ".env-orbit"), "utf8")).toContain("COMPOSE_PROFILES=processing\n");
  });
});

// #1519: the launcher leaves its configuration (.env-orbit, .orbit-secrets/)
// in the tree it mounted into the engine; the engine takes it in through its
// own transaction, so the engine is the only writer of the deployment folder.
// `InstallContext.launcherConfigTree` and `InstallDependencies.notice` are the
// new seams; until they exist these tests fail on behaviour and, under tsc,
// on the unknown fields.
describe("runInstall: the launcher's configuration goes through the install transaction (#1519)", () => {
  const TREE_ENV = ["APP_URL=https://tree.example.invalid", "ORBIT_AUTH_OIDC=false", ""].join("\n");
  const TREE_SECRETS = { "oidc-client-secret": "tree-s3cr3t\n" };

  /** The directory the launcher mounted (mode 0700), holding what the launcher saved there. */
  function launcherTree(files: { env?: string; secrets?: Record<string, string> } = {}): string {
    const tree = join(sandbox("orbit-install-launcher-"), "tree");
    mkdirSync(tree, { mode: 0o700 });
    chmodSync(tree, 0o700);
    if (files.env !== undefined) writeFileSync(join(tree, ".env-orbit"), files.env, { mode: 0o600 });
    if (files.secrets) {
      mkdirSync(join(tree, ".orbit-secrets"), { mode: 0o700 });
      chmodSync(join(tree, ".orbit-secrets"), 0o700);
      for (const [name, content] of Object.entries(files.secrets)) writeFileSync(join(tree, ".orbit-secrets", name), content, { mode: 0o600 });
    }
    return tree;
  }

  const treeNotices = (said: string[]) => said.filter((line) => line.includes("ORBIT_LAUNCHER_CONFIG_TREE"));

  async function runWithTree(target: string, tree: string | undefined, overrides: Partial<InstallContext> = {}, dependencies: Partial<InstallDependencies> = {}) {
    const notices: string[] = [];
    const result = await run(target, { launcherConfigTree: tree, ...overrides }, { notice: (line) => notices.push(line), ...dependencies });
    return { ...result, notices };
  }

  describe("taken in", () => {
    it("installs a complete handed-in configuration with no terminal, asking nothing, and leaves the launcher's tree as it was", async () => {
      const target = sandbox("orbit-install-target-");
      const tree = launcherTree({ env: TREE_ENV, secrets: TREE_SECRETS });
      const treeBefore = snapshot(tree);
      const { outcome, notices } = await runWithTree(target, tree);

      expect(outcome).toMatchObject({ status: "ok", fresh: true, selectedProfile: "standard" });
      const env = readFileSync(join(target, ".env-orbit"), "utf8");
      expect(env).toContain("APP_URL=https://tree.example.invalid\n");
      expect(env).toContain("ORBIT_AUTH_OIDC=false\n");
      expect(env.match(/^ORBIT_IMAGE=.*$/gm)).toEqual([`ORBIT_IMAGE=${REFERENCE}`]);
      expect(statSync(join(target, ".env-orbit")).mode & 0o777).toBe(0o600);
      expect(readFileSync(join(target, ".orbit-secrets", "oidc-client-secret"))).toEqual(Buffer.from(TREE_SECRETS["oidc-client-secret"]));
      expect(statSync(join(target, ".orbit-secrets")).mode & 0o777).toBe(0o700);
      expect(statSync(join(target, ".orbit-secrets", "oidc-client-secret")).mode & 0o777).toBe(0o600);
      expect(notices).toEqual([]);
      // The engine copies; it never moves or edits what the launcher left.
      expect(snapshot(tree)).toEqual(treeBefore);
    });

    it("takes it in at a terminal in plain mode too, without showing a prompt", async () => {
      const target = sandbox("orbit-install-target-");
      const terminal = scriptedTerminal([]);
      const { outcome } = await runWithTree(target, launcherTree({ env: TREE_ENV, secrets: TREE_SECRETS }), { interactive: true, plainMode: true }, { terminal });
      expect(outcome.status).toBe("ok");
      expect(terminal.output()).toBe("");
      expect(readFileSync(join(target, ".env-orbit"), "utf8")).toContain("APP_URL=https://tree.example.invalid\n");
    });

    it("takes in a .env-orbit that comes without a .orbit-secrets directory, and the engine makes the secrets it needs", async () => {
      const target = sandbox("orbit-install-target-");
      const { outcome } = await runWithTree(target, launcherTree({ env: TREE_ENV }));
      expect(outcome.status).toBe("ok");
      expect(readFileSync(join(target, ".env-orbit"), "utf8")).toContain("APP_URL=https://tree.example.invalid\n");
      for (const secret of ["session-secret", "postgres-password", "document-kek"]) {
        expect(statSync(join(target, ".orbit-secrets", secret)).mode & 0o777).toBe(0o600);
      }
    });
  });

  // L-F1 (v0.3.2 audit): an unset ORBIT_INSTALL_PROFILE on a handed-in install
  // keeps the launcher's profile; a set one wins and the install says so.
  describe("profile of a handed-in configuration (L-F1)", () => {
    const PROCESSING_ENV = [TREE_ENV.trimEnd(), "COMPOSE_PROFILES=processing", "TIKA_URL=http://orbit-tika:9998", ""].join("\n");
    const REPLACE_LINE = "ORBIT_INSTALL_PROFILE=standard replaces the processing profile in the handed-in configuration";

    // Fails today: the handed-in branch resolves standard with profileChange=true
    // when the variable is unset and calls setDeploymentProfile, which strips
    // COMPOSE_PROFILES and TIKA_URL and reports standard.
    it("keeps the handed-in processing profile and its TIKA_URL when the variable is unset", async () => {
      const target = sandbox("orbit-install-target-");
      const tree = launcherTree({ env: PROCESSING_ENV, secrets: TREE_SECRETS });
      const { outcome, said, notices } = await runWithTree(target, tree, { requestedProfile: undefined });
      expect(outcome).toMatchObject({ status: "ok", fresh: true, selectedProfile: "processing" });
      const env = readFileSync(join(target, ".env-orbit"), "utf8");
      expect(env).toContain("COMPOSE_PROFILES=processing\n");
      expect(env).toContain("TIKA_URL=http://orbit-tika:9998\n");
      expect([...said, ...notices]).not.toContain(REPLACE_LINE);
    });

    // Fails today: the variable already wins, but no line says it replaced the
    // handed-in profile, so the said-line assertion fails.
    it("lets ORBIT_INSTALL_PROFILE=standard win over a handed-in processing profile, and says so in one line", async () => {
      const target = sandbox("orbit-install-target-");
      const tree = launcherTree({ env: PROCESSING_ENV, secrets: TREE_SECRETS });
      const { outcome, said } = await runWithTree(target, tree, { requestedProfile: "standard" });
      expect(outcome).toMatchObject({ status: "ok", fresh: true, selectedProfile: "standard" });
      const env = readFileSync(join(target, ".env-orbit"), "utf8");
      expect(env).not.toContain("COMPOSE_PROFILES=processing");
      expect(env).not.toContain("TIKA_URL=http://orbit-tika:9998");
      expect(said.filter((line) => line === REPLACE_LINE)).toHaveLength(1);
    });

    // Passes today and must keep passing: a regression guard for the no-profile case.
    it("installs standard when the variable is unset and the handed-in file names no profile", async () => {
      const target = sandbox("orbit-install-target-");
      const tree = launcherTree({ env: TREE_ENV, secrets: TREE_SECRETS });
      const { outcome, said } = await runWithTree(target, tree, { requestedProfile: undefined });
      expect(outcome).toMatchObject({ status: "ok", fresh: true, selectedProfile: "standard" });
      expect(readFileSync(join(target, ".env-orbit"), "utf8")).not.toContain("COMPOSE_PROFILES=processing");
      expect(said).not.toContain(REPLACE_LINE);
    });
  });

  // G2-R2 (#1536): a handed-in profile kept because ORBIT_INSTALL_PROFILE is
  // unset is a chosen profile all the same, so a local-AI one gets the capacity
  // check the wizard gives it. A non-interactive run has no download
  // confirmation to ask, so nothing here expects a model pull to be requested.
  describe("capacity check for a kept handed-in local-AI profile (G2-R2)", () => {
    const withProfile = (...lines: string[]) => [TREE_ENV.trimEnd(), ...lines, ""].join("\n");
    const AI_ENV = withProfile("COMPOSE_PROFILES=ai", "OLLAMA_MODEL=llama3.2:3b");
    const FULL_ENV = withProfile("COMPOSE_PROFILES=processing,ai", "TIKA_URL=http://orbit-tika:9998", "OLLAMA_MODEL=llama3.2:3b");
    const PROCESSING_ENV = withProfile("COMPOSE_PROFILES=processing", "TIKA_URL=http://orbit-tika:9998");
    const capacityLines = (lines: string[]) => lines.filter((line) => line.startsWith("Host capacity check:"));

    it.each([
      ["ai", AI_ENV],
      ["full", FULL_ENV],
    ])("checks the host's capacity once and reports it for a kept %s profile, as the wizard does for a chosen one", async (profileName, env) => {
      const target = sandbox("orbit-install-target-");
      const tree = launcherTree({ env, secrets: TREE_SECRETS });
      let checks = 0;
      const { outcome, said, notices } = await runWithTree(target, tree, { requestedProfile: undefined }, {
        capacity: () => {
          checks += 1;
          return "below";
        },
      });
      expect(outcome).toMatchObject({ status: "ok", fresh: true, selectedProfile: profileName });
      expect(checks).toBe(1);
      const lines = capacityLines([...said, ...notices]);
      expect(lines).toHaveLength(1);
      expect(lines[0]).toMatch(/below/);
    });

    // Passes today and must keep passing: only the local-AI profiles ask about capacity.
    it("does not check capacity for a kept processing profile", async () => {
      const target = sandbox("orbit-install-target-");
      const tree = launcherTree({ env: PROCESSING_ENV, secrets: TREE_SECRETS });
      let checks = 0;
      const { outcome, said, notices } = await runWithTree(target, tree, { requestedProfile: undefined }, {
        capacity: () => {
          checks += 1;
          return "sufficient";
        },
      });
      expect(outcome).toMatchObject({ status: "ok", selectedProfile: "processing" });
      expect(checks).toBe(0);
      expect(capacityLines([...said, ...notices])).toEqual([]);
    });
  });

  // RG-R5 (#1536): the handed-in file's profile lines match no known profile
  // and ORBIT_INSTALL_PROFILE is unset. Running the same command again cannot
  // succeed, so the outcome must not say "retry" (docs/engine-events.md: the
  // only other action is "abort", for a failure no retry can clear), and it
  // must name the edit.
  describe("a handed-in configuration whose profile cannot be read (RG-R5)", () => {
    const BAD_PROFILE_ENV = [TREE_ENV.trimEnd(), "COMPOSE_PROFILES=ai", "TIKA_URL=http://orbit-tika:9998", ""].join("\n");

    it("fails with action abort, not retry, and names the lines to edit", async () => {
      const target = sandbox("orbit-install-target-");
      const tree = launcherTree({ env: BAD_PROFILE_ENV, secrets: TREE_SECRETS });
      const { outcome } = await runWithTree(target, tree, { requestedProfile: undefined });
      expect(outcome).toMatchObject({ status: "failed", phase: "configuration", reason: "configuration-failure" });
      if (outcome.status !== "failed") return;
      expect(outcome.action).toBe("abort");
      const text = [outcome.message, ...(outcome.guidance ?? [])].join("\n");
      expect(text).toContain("COMPOSE_PROFILES");
      expect(readdirSync(target)).toEqual([]);
    });
  });

  // D-F5 (#1536): the tree holds a .orbit-secrets and no .env-orbit. The
  // secrets are not taken in (there is no configuration to go with them), and
  // the operator must be told so rather than get fresh secrets in silence.
  describe("a tree that holds only a .orbit-secrets (D-F5)", () => {
    const told = (lines: string[]) => lines.some((line) => line.includes("ORBIT_LAUNCHER_CONFIG_TREE") && line.includes(".orbit-secrets"));

    it("tells the operator it was not used, on a guided install at a terminal", async () => {
      const target = sandbox("orbit-install-target-");
      const tree = launcherTree({ secrets: TREE_SECRETS });
      const treeBefore = snapshot(tree);
      const terminal = scriptedTerminal(["install", "standard", "apply", "apply"]);
      const answers: ConfigurationAnswers = {
        guidedInit: () => ({ appUrl: "https://guided.example.invalid", authMode: "local" }),
        oidcSecret: () => {
          throw new Error("local-only: no secret is asked");
        },
      };
      const { outcome, said, notices } = await runWithTree(target, tree, { interactive: true }, { terminal, answers });
      const shown = terminal.output().split("\n");
      const outcomeText = outcome.status === "failed" ? [outcome.message, ...(outcome.guidance ?? [])] : [];
      expect(told([...notices, ...said, ...shown, ...outcomeText]), `nothing told the operator; notices=${JSON.stringify(notices)}`).toBe(true);
      expect(snapshot(tree)).toEqual(treeBefore);
    });

    it("tells the operator it was not used, with no terminal", async () => {
      const target = sandbox("orbit-install-target-");
      const tree = launcherTree({ secrets: TREE_SECRETS });
      const { outcome, said, notices } = await runWithTree(target, tree);
      const outcomeText = outcome.status === "failed" ? [outcome.message, ...(outcome.guidance ?? [])] : [];
      expect(told([...notices, ...said, ...outcomeText]), `nothing told the operator; notices=${JSON.stringify(notices)}`).toBe(true);
    });
  });

  // O-R2 (#1536): copying the launcher's configuration into the install's
  // scratch directory fails (a full /tmp in the engine). It must come back as
  // the normal configuration failure, with the launcher's tree handed back,
  // not as an error thrown out of runInstall. The failure is real, not mocked:
  // the test makes a directory of the name the copy creates, once the assets
  // are staged and the scratch directory is known.
  describe("a write failure while copying the handed-in configuration into scratch (O-R2)", () => {
    it("is a configuration failure, hands the tree back once, and leaves the target and scratch clean", async () => {
      const target = sandbox("orbit-install-target-");
      const tree = launcherTree({ env: TREE_ENV, secrets: TREE_SECRETS });
      const treeBefore = snapshot(tree);
      const scratchRoot = sandbox("orbit-install-scratch-root-");
      const context: InstallContext = {
        targetDir: target,
        requestedAction: undefined,
        plainMode: false,
        interactive: false,
        resolvedReference: REFERENCE,
        channel: "latest",
        facts: facts(),
        assetsRoot: assetsRoot(),
        launcherConfigTree: tree,
      };
      let handedBack = 0;
      vi.stubEnv("TMPDIR", scratchRoot);
      try {
        const outcome = await runInstall(
          context,
          {
            answers: noAnswers,
            fetchImpl: discoveryFetch(),
            capacity: () => "sufficient",
            onConfigurationFailure: () => {
              handedBack += 1;
            },
          },
          (event) => {
            if (event.phase !== "assets" || event.state !== "completed") return;
            for (const name of readdirSync(scratchRoot)) {
              if (name.startsWith("orbit-install-scratch-")) mkdirSync(join(scratchRoot, name, ".env-orbit"));
            }
          },
        );
        expect(outcome).toMatchObject({ status: "failed", phase: "configuration", reason: "configuration-failure" });
      } finally {
        vi.unstubAllEnvs();
      }
      expect(handedBack).toBe(1);
      expect(readdirSync(target)).toEqual([]);
      expect(readdirSync(scratchRoot)).toEqual([]);
      expect(snapshot(tree)).toEqual(treeBefore);
    });
  });

  describe("incomplete", () => {
    it.each([
      ["APP_URL missing", "ORBIT_AUTH_OIDC=false\n"],
      ["APP_URL empty", "APP_URL=\nORBIT_AUTH_OIDC=false\n"],
    ])("fails as a configuration failure when %s, changing nothing and offering the configure tree", async (_label, env) => {
      const target = sandbox("orbit-install-target-");
      const tree = launcherTree({ env, secrets: TREE_SECRETS });
      const treeBefore = snapshot(tree);
      let handedOver = 0;
      const { outcome } = await runWithTree(target, tree, {}, { onConfigurationFailure: () => { handedOver += 1; } });

      expect(outcome).toMatchObject({ status: "failed", phase: "configuration", reason: "configuration-failure", action: "retry" });
      // The readiness check ran on the handed-in settings: it names the field, it does not ask for everything again.
      if (outcome.status === "failed") expect(outcome.guidance?.[0]).toMatch(/^Orbit installer: configuration fields requiring attention: APP_URL\b/);
      expect(readdirSync(target)).toEqual([]);
      expect(handedOver).toBe(1);
      // Writing the configure tree is the callback's job; the orchestrator itself leaves the handed-in files alone.
      expect(snapshot(tree)).toEqual(treeBefore);
    });
  });

  describe("unsafe", () => {
    const outsideConfig = () => {
      const outside = sandbox("orbit-install-outside-");
      writeFileSync(join(outside, "config"), TREE_ENV, { mode: 0o600 });
      mkdirSync(join(outside, "secrets"), { mode: 0o700 });
      writeFileSync(join(outside, "secrets", "oidc-client-secret"), "outside\n", { mode: 0o600 });
      return outside;
    };

    const writeMode = (path: string, content: string, mode: number) => {
      writeFileSync(path, content, { mode });
      chmodSync(path, mode);
    };
    const withSecrets = (tree: string, mode: number) => {
      writeMode(join(tree, ".env-orbit"), TREE_ENV, 0o600);
      mkdirSync(join(tree, ".orbit-secrets"), { mode: 0o700 });
      writeMode(join(tree, ".orbit-secrets", "oidc-client-secret"), "x\n", mode);
    };

    it.each([
      ["a symlink to a complete configuration", (tree: string) => symlinkSync(join(outsideConfig(), "config"), join(tree, ".env-orbit"))],
      ["a directory", (tree: string) => mkdirSync(join(tree, ".env-orbit"), { mode: 0o700 })],
      ["readable by other users (0644)", (tree: string) => writeMode(join(tree, ".env-orbit"), TREE_ENV, 0o644)],
      ["readable by its group (0640)", (tree: string) => writeMode(join(tree, ".env-orbit"), TREE_ENV, 0o640)],
      ["next to a .orbit-secrets that is a symlink to a directory of secrets", (tree: string) => {
        writeMode(join(tree, ".env-orbit"), TREE_ENV, 0o600);
        symlinkSync(join(outsideConfig(), "secrets"), join(tree, ".orbit-secrets"));
      }],
      ["next to a secret readable by other users (0644)", (tree: string) => withSecrets(tree, 0o644)],
      ["next to a secret readable by its group (0640)", (tree: string) => withSecrets(tree, 0o640)],
    ])("refuses a tree whose configuration is %s, as a configuration failure, changing nothing", async (_label, arrange) => {
      const target = sandbox("orbit-install-target-");
      const tree = launcherTree();
      arrange(tree);
      const { outcome } = await runWithTree(target, tree);

      expect(outcome).toMatchObject({ status: "failed", reason: "configuration-failure", action: "retry" });
      expect(readdirSync(target)).toEqual([]);
    });
  });

  describe("already configured", () => {
    it("ignores the handed-in configuration of a pre-provisioned folder: one notice, the folder's own .env-orbit used, the rest as without a tree", async () => {
      const target = preprovisioned();
      const control = preprovisioned();
      const tree = launcherTree({ env: "APP_URL=https://tree-should-lose.example.invalid\nORBIT_AUTH_OIDC=false\n", secrets: TREE_SECRETS });
      const treeBefore = snapshot(tree);

      const { outcome, notices } = await runWithTree(target, tree);
      const without = await runWithTree(control, undefined);

      expect(treeNotices(notices)).toHaveLength(1);
      expect(notices).toHaveLength(1);
      expect(notices[0]).toContain("ORBIT_LAUNCHER_CONFIG_TREE");
      expect(notices[0]).toMatch(/ignored/i);
      expect(without.notices).toEqual([]);
      expect(outcome).toEqual(without.outcome);
      const env = readFileSync(join(target, ".env-orbit"), "utf8");
      expect(env).toContain("APP_URL=https://orbit.example.invalid\n");
      expect(env).not.toContain("tree-should-lose");
      // Every run generates its own VAPID key pair, so those lines are left out of the comparison.
      const withoutVapid = (text: string) => text.split("\n").filter((line) => !line.startsWith("VAPID_")).join("\n");
      expect(withoutVapid(env)).toEqual(withoutVapid(readFileSync(join(control, ".env-orbit"), "utf8")));
      expect(readFileSync(join(target, ".orbit-secrets", "oidc-client-secret"), "utf8")).toBe("s3cr3t");
      expect(snapshot(tree)).toEqual(treeBefore);
    });

    it("ignores it on an update of a recognised deployment, the same way", async () => {
      const target = recognised();
      const tree = launcherTree({ env: "APP_URL=https://tree-should-lose.example.invalid\nORBIT_AUTH_OIDC=false\n", secrets: TREE_SECRETS });
      const { outcome, notices } = await runWithTree(target, tree, { facts: provenVolumeFacts("orbit", OLD_REFERENCE) });

      expect(outcome).toMatchObject({ status: "ok", fresh: false });
      expect(notices).toHaveLength(1);
      expect(notices[0]).toContain("ORBIT_LAUNCHER_CONFIG_TREE");
      expect(notices[0]).toMatch(/ignored/i);
      expect(readFileSync(join(target, ".env-orbit"), "utf8")).toContain("APP_URL=https://orbit.example.invalid\n");
      expect(readFileSync(join(target, ".env-orbit"), "utf8")).not.toContain("tree-should-lose");
    });

    it("says nothing about a tree when none was set", async () => {
      const { notices } = await runWithTree(preprovisioned(), undefined);
      expect(notices).toEqual([]);
    });
  });

  describe("rollback of the handed-in files", () => {
    it("removes them again when a later step fails before the commit: the folder is as the person had it, the tree untouched", async () => {
      const target = sandbox("orbit-install-target-");
      const tree = launcherTree({ env: ENV_OIDC, secrets: { "oidc-client-secret": "tree-s3cr3t\n" } });
      const treeBefore = snapshot(tree);
      const { outcome } = await runWithTree(target, tree, {}, { fetchImpl: async () => Promise.reject(new Error("offline")) });

      expect(outcome).toMatchObject({ status: "failed", phase: "oidc", reason: "provider-unavailable", action: "retry" });
      expect(readdirSync(target)).toEqual([]);
      expect(existsSync(join(target, ".env-orbit"))).toBe(false);
      expect(existsSync(join(target, ".orbit-secrets"))).toBe(false);
      expect(snapshot(tree)).toEqual(treeBefore);
    });
  });

  describe("guard: no handed-in configuration", () => {
    it("still ends in a configuration failure for a non-interactive fresh install with no tree set", async () => {
      const target = sandbox("orbit-install-target-");
      const { outcome, notices } = await runWithTree(target, undefined);
      expect(outcome).toMatchObject({ status: "failed", reason: "configuration-failure", action: "retry" });
      expect(readdirSync(target)).toEqual([]);
      expect(notices).toEqual([]);
    });

    it("still ends in a configuration failure when the tree is empty", async () => {
      const target = sandbox("orbit-install-target-");
      const { outcome } = await runWithTree(target, launcherTree());
      expect(outcome).toMatchObject({ status: "failed", reason: "configuration-failure", action: "retry" });
      expect(readdirSync(target)).toEqual([]);
    });
  });
});
