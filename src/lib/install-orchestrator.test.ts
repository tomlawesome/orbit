import { chmodSync, copyFileSync, existsSync, lstatSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, statSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { afterEach, describe, expect, it } from "vitest";

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
      expect(readFileSync(join(target, asset))).toEqual(readFileSync(join(repoRoot, asset)));
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

  it("rolls back on an unavailable provider, with its own reason (#25)", async () => {
    const target = preprovisioned(ENV_OIDC);
    const before = snapshot(target);
    const { outcome } = await run(target, {}, { fetchImpl: async () => Promise.reject(new Error("offline")) });
    expect(outcome).toMatchObject({ status: "failed", phase: "oidc", reason: "provider-unavailable", action: "retry" });
    expect(snapshot(target)).toEqual(before);
  });

  it("rolls back an update whose configuration does not pass the preflight (#50)", async () => {
    const target = recognised();
    writeFileSync(join(target, ".env-orbit"), "not an assignment\n", { mode: 0o600 });
    const before = snapshot(target);
    const { outcome } = await run(target);
    expect(outcome).toMatchObject({ status: "failed", message: "Configuration preflight failed; restoring the previous deployment." });
    expect(snapshot(target)).toEqual(before);
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
