// scripts/install.sh, the bootstrap shell around the install engine (#1212):
// one part of the suite that used to be scripts/install.test.mjs, split so the
// parts run in parallel (#1377). Fixtures and helpers: install-test-support.mjs.

import { execFileSync } from "node:child_process";
import {
  appendFileSync,
  chmodSync,
  copyFileSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  readdirSync,
  rmSync,
  statSync,
  symlinkSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { basename, join } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it, vi } from "vitest";
import { PTY_TEST_TIMEOUT_MS } from "./pty-deadline.mjs";
import { PROCESS_TEST_TIMEOUT_MS } from "./process-budget.mjs";
import {
  installScript,
  imageRepository,
  digest,
  revision,
  resolvedReference,
  preflightSuccessLine,
  deploymentAssets,
  releaseManifestPath,
  assetsRoot,
  makeTarget,
  makePreprovisionedDeployment,
  targetEntries,
  stagingLeftovers,
  runInstall,
  runInstallOnTerminal,
  eventLines,
  recognisedVolume,
  realPath,
} from "./install-test-support.mjs";

vi.setConfig({ testTimeout: PROCESS_TEST_TIMEOUT_MS });

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
