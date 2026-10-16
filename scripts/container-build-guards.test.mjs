import { readFileSync } from "node:fs";

import { describe, expect, it } from "vitest";

/*
 * Guards on files that outlive the retired GitHub-first container pipeline
 * (#1403 D1). They were cases in scripts/exact-image-workflow.test.mjs, which
 * was deleted with that pipeline; the files they read are still live, and no
 * other suite reads them, so the cases moved here instead of going with it.
 */
function read(path) {
  return readFileSync(new URL(path, import.meta.url), "utf8").replaceAll("\r\n", "\n");
}

function ciScript(name) {
  return read(`./ci/${name}`);
}

const dockerfile = read("../Dockerfile");
const gitlabCi = read("../.gitlab-ci.yml");

describe("production image", () => {
  it("removes build-only package managers from the production image", () => {
    // Matches whichever image the runner stage starts from, so long as it is
    // digest-pinned (#651): what is guarded is the package-manager removal,
    // not the base's identity.
    const runnerStart = dockerfile.search(/^FROM \S+@sha256:[0-9a-f]{64} AS runner$/mu);
    expect(runnerStart).toBeGreaterThanOrEqual(0);
    const runner = dockerfile.slice(runnerStart);

    expect(runner).toContain("rm -rf /usr/local/lib/node_modules /opt/yarn-v*");
    expect(runner).toContain("/usr/local/bin/corepack");
    expect(runner).toContain("/usr/local/bin/npm");
    expect(runner).toContain("/usr/local/bin/npx");
    expect(runner).toContain("/usr/local/bin/pnpm");
    expect(runner).toContain("/usr/local/bin/yarn");
  });
});

describe("GitLab pipeline definition", () => {
  it("takes the pnpm version from package.json alone", () => {
    // Renovate bumps package.json's packageManager and nothing else: a second
    // copy of the version in the pipeline drifts, and pnpm then refuses to
    // start. package.json is the one place it lives.
    const packageJson = JSON.parse(read("../package.json"));

    expect(packageJson.packageManager).toMatch(/^pnpm@\d+\.\d+\.\d+$/u);
    expect(gitlabCi).not.toMatch(/pnpm@\d/u);
    expect(gitlabCi).not.toMatch(/version: *["']?\d+\.\d+\.\d+/u);
    expect(gitlabCi).not.toContain("PNPM_VERSION");
    expect(gitlabCi).toContain("require('./package.json').packageManager");
  });

  it("routes every pull of the disposable registry through the dependency proxy (#1111)", () => {
    // Three jobs start scripts/ci/start-installer-registry.sh's disposable
    // registry -- acceptance, repair_journeys and launcher_install_compat --
    // and all three once pulled it straight from Docker Hub and tripped its
    // anonymous rate limit. The script's fallback stays a direct pull, so the
    // pipeline must always override it with a proxied, digest-pinned image.
    const proxyPrefix = "${CI_DEPENDENCY_PROXY_GROUP_IMAGE_PREFIX}/library/";
    const registryDigest =
      "registry:2.8.3@sha256:a3d8aaa63ed8681a604f1dea0aa03f100d5895b6a58ace528858a7b332415373";
    const lines = gitlabCi.split(/\r?\n/u);

    const installerRegistryLine = lines.find((line) =>
      /^\s*ORBIT_INSTALLER_REGISTRY_IMAGE:/u.test(line),
    );
    expect(installerRegistryLine, "ORBIT_INSTALLER_REGISTRY_IMAGE must be set").toBeDefined();
    expect(installerRegistryLine).toContain(proxyPrefix);
    expect(installerRegistryLine).toContain(registryDigest);

    // repair_journeys keeps its own job-level variable; it must still resolve
    // to the same proxied, digest-pinned image, never a bare Docker Hub tag.
    const repairRegistryLine = lines.find((line) =>
      /^\s*ORBIT_REPAIR_JOURNEYS_REGISTRY_IMAGE:/u.test(line),
    );
    expect(repairRegistryLine, "ORBIT_REPAIR_JOURNEYS_REGISTRY_IMAGE must be set").toBeDefined();
    expect(repairRegistryLine).toMatch(
      /\$\{(?:CI_DEPENDENCY_PROXY_GROUP_IMAGE_PREFIX\}\/library\/registry|ORBIT_INSTALLER_REGISTRY_IMAGE\})/u,
    );
    expect(repairRegistryLine).not.toMatch(/registry:2\s*$/u);

    // The disposable OIDC sidecar `smoke` builds pulls a Docker Hub base image
    // and needs the same proxy route.
    const oidcPrefixLine = lines.find((line) => /^\s*OIDC_BASE_IMAGE_PREFIX:/u.test(line));
    expect(oidcPrefixLine, "OIDC_BASE_IMAGE_PREFIX must be set").toBeDefined();
    expect(oidcPrefixLine).toContain(proxyPrefix);
  });
});

describe("container validation scripts", () => {
  it("requires the database-backed ready contract before smoke acceptance continues", () => {
    const health = ciScript("verify-health-endpoint.sh");
    expect(health).toContain('.status == "ready" and .service == "orbit"');
    expect(health).not.toContain('.status == "ok" and .service == "orbit"');
  });

  it("falls back to a placeholder ORBIT_IMAGE when diagnostics run before an image exists", () => {
    const fallback = 'export ORBIT_IMAGE="${ORBIT_IMAGE:-orbit-local:000000000000}"';
    expect(ciScript("show-stack-diagnostics.sh")).toContain(fallback);
    expect(ciScript("stop-acceptance-stack.sh")).toContain(fallback);
  });

  it("validates the supported mail secret overlay", () => {
    const configuration = ciScript("create-test-configuration.sh");
    expect(configuration).toContain("openssl rand -hex 32 > .orbit-secrets/smtp-password");
    expect(configuration).toContain("SMTP_HOST=smtp.example.invalid");
    expect(configuration).not.toContain("IMAP_");

    const composeValidation = ciScript("validate-compose.sh");
    expect(composeValidation).toContain(
      "-f docker-compose.yml -f docker-compose.mail.yml config --quiet",
    );
    expect(composeValidation).not.toContain("docker-compose.mail-alias-rotation.yml");

    // The acceptance stack runs the mail overlay too, and is brought up
    // without a rebuild.
    const stack = ciScript("start-acceptance-stack.sh");
    expect(stack).toContain(
      "-f docker-compose.yml -f docker-compose.mail.yml -f compose/docker-compose.acceptance.yml",
    );
    expect(stack).toContain("COMPOSE_FILES:-${default_compose_files}");
    expect(stack).toContain("up --detach --no-build --wait");
  });
});

describe("installer validation scripts", () => {
  it("pins the disposable registry and pushes the tested image rather than building one", () => {
    const registryStep = ciScript("start-installer-registry.sh");
    expect(registryStep).toContain(
      "registry:2.8.3@sha256:a3d8aaa63ed8681a604f1dea0aa03f100d5895b6a58ace528858a7b332415373",
    );
    expect(registryStep).toContain("--publish 127.0.0.1:5000:5000");
    expect(registryStep).toContain('local_tag="127.0.0.1:5000/${IMAGE_NAME}:${channel}"');
    expect(registryStep).toContain('[[ "${source_id}" == "${TESTED_IMAGE_ID}" ]]');
    expect(registryStep).toContain("docker tag");
    expect(registryStep).toContain("docker push");
    expect(registryStep).not.toContain("docker build");
    expect(registryStep).toContain('registry_id="$(');
    expect(registryStep).toContain('[[ "${registry_id}" =~ ^[0-9a-f]{64}$ ]]');
    expect(registryStep).toContain("127.0.0.1:5000/${IMAGE_NAME}");
  });

  it("prepares an empty target with a guard that records any use of Git", () => {
    const prepareStep = ciScript("prepare-installer-target.sh");
    expect(prepareStep).toContain('runner_temp="${RUNNER_TEMP:-');
    expect(prepareStep).toContain('mktemp -d "${runner_temp}/orbit-installer-target.XXXXXX"');
    expect(prepareStep).toContain('[[ "${#entries[@]}" -eq 0 ]]');
    expect(prepareStep).toContain("orbit-installer-git-guard.XXXXXX");
    expect(prepareStep).toContain("git-was-invoked");
  });

  it("refuses an unattended install on an empty target without starting Compose or touching Git", () => {
    const refusalStep = ciScript("verify-installer-refusal.sh");
    expect(refusalStep).toContain('runner_temp="${RUNNER_TEMP:-');
    expect(refusalStep).toContain('refusal_output="${runner_temp}/orbit-installer-refusal-');
    expect(refusalStep).toContain("exec < /dev/null");
    expect(refusalStep).toContain("[[ ! -t 0 ]]");
    expect(refusalStep).toContain("installer_status=$?");
    expect(refusalStep).toContain('[[ "${installer_status}" -ne 0 ]]');
    // OIDC is off by default (M7, #909), so an empty target owes only APP_URL.
    expect(refusalStep).toContain(
      "Orbit installer: configuration fields requiring attention: APP_URL.",
    );
    expect(refusalStep).toContain(
      "Orbit installer: Required configuration fields require attention; refusing to start Compose.",
    );
    expect(refusalStep).toContain("docker inspect orbit");
    expect(refusalStep).toContain('[[ ! -e "${GIT_MARKER}" ]]');
    expect(refusalStep).toContain('[[ "${#entries[@]}" -eq 0 ]]');

    // #770: a wrong field list and an installer that never reached the field
    // check are reported differently, and failures show the exit code and
    // what the target directory held.
    expect(refusalStep).toContain("required_fields_prefix=");
    expect(refusalStep).toContain("without ever reaching the field check");
    expect(refusalStep).toContain("reported the wrong required fields");
    expect(refusalStep).toContain("actual_fields_line=");
    expect(refusalStep).toContain("installer exit status: %s");
    expect(refusalStep).toContain("target directory contents");
    expect(refusalStep).toMatch(/did not restore the target to empty.*\$\{entries\[\*\]\}/);

    // #770: a database volume leaked by an earlier stage is named as a
    // defect in the environment, not misreported as a field-check failure.
    expect(refusalStep).toContain("docker volume ls --filter 'name=orbit-db-data'");
    expect(refusalStep).toContain("leaked-state defect in the environment, not the installer");
  });

  it("provisions the target from the documented example with fixed non-secret inputs and an owner-only generated secret", () => {
    const provisionStep = ciScript("provision-installer-target.sh");
    expect(provisionStep).toContain('workspace="${GITHUB_WORKSPACE:-');
    expect(provisionStep).toContain('cp -- "${workspace}/.env-orbit.example" "${env_file}"');
    expect(provisionStep).toContain("ORBIT_CONFIG_SCHEMA_VERSION=1");
    expect(provisionStep).toContain("APP_URL=https://orbit.install-test.invalid");
    expect(provisionStep).toContain("OIDC_ISSUER=https://accounts.google.com");
    expect(provisionStep).toContain("OIDC_CLIENT_ID=orbit-install-test-client");
    expect(provisionStep).toContain("OIDC_CLIENT_SECRET=|");
    expect(provisionStep).toContain(
      "OIDC_CLIENT_SECRET_FILE=/run/orbit-secrets/orbit-oidc-client-secret",
    );
    expect(provisionStep).toContain(
      "OIDC_CALLBACK_URL=https://orbit.install-test.invalid/api/auth/callback",
    );
    expect(provisionStep).toContain('mkdir -- "${secrets_directory}"');
    expect(provisionStep).toContain('chmod 700 "${secrets_directory}"');
    expect(provisionStep).toContain(
      'openssl rand -hex 32 > "${secrets_directory}/oidc-client-secret"',
    );
    expect(provisionStep).toContain('chmod 600 "${secrets_directory}/oidc-client-secret"');
    expect(provisionStep).toContain("stat -c '%a'");
    expect(provisionStep).toContain('[[ "${#entries[@]}" -eq 2 ]]');
    expect(provisionStep).toContain(
      "for marker in .git Dockerfile src package.json package-lock.json pnpm-lock.yaml yarn.lock",
    );
    expect(provisionStep).not.toContain("OIDC_CLIENT_SECRET=orbit-");
  });

  it("runs the installer with stdin closed and a Git guard first on PATH", () => {
    const installerStep = ciScript("run-installer.sh");
    expect(installerStep).toContain("exec < /dev/null");
    expect(installerStep).toContain("[[ ! -t 0 ]]");
    expect(installerStep).toContain('PATH="${GIT_GUARD_DIR}:${PATH}"');
    expect(installerStep).toContain('workspace="${GITHUB_WORKSPACE:-');
    expect(installerStep).toContain('bash "${workspace}/scripts/install.sh"');
  });

  it("verifies the installed image by digest, revision, fetched assets and a ready health response", () => {
    const verifyStep = ciScript("verify-installed-image.sh");
    expect(verifyStep).toContain("ORBIT_IMAGE=127.0.0.1:5000/${IMAGE_NAME}@sha256:");
    expect(verifyStep).toContain('[[ "${digest}" =~ ^[0-9a-f]{64}$ ]]');
    expect(verifyStep).toContain('[[ "${resolved_id}" == "${TESTED_IMAGE_ID}" ]]');
    expect(verifyStep).toContain('[[ "${running_id}" == "${TESTED_IMAGE_ID}" ]]');
    expect(verifyStep).toContain('[[ "${revision_label}" == "${ORBIT_REVISION}" ]]');
    expect(verifyStep).toContain("org.opencontainers.image.revision");

    // Fetched assets match the checkout.
    expect(verifyStep).toContain("docker-compose.yml");
    expect(verifyStep).toContain("scripts/configure.sh");
    expect(verifyStep).toContain("cmp --silent");

    // No source or build markers in the installed target.
    expect(verifyStep).toContain(".git");
    expect(verifyStep).toContain("Dockerfile");
    expect(verifyStep).toContain("package.json");
    expect(verifyStep).toContain("pnpm-lock.yaml");

    expect(verifyStep).toContain("curl");
    expect(verifyStep).toContain("/api/health");
    expect(verifyStep).toContain('.status == "ready"');
    expect(verifyStep).toContain('.service == "orbit"');
  });

  it("cleans up only its own target and registry", () => {
    const cleanupSection = ciScript("clean-up-installer.sh");
    expect(cleanupSection).toContain('runner_temp="${RUNNER_TEMP:-');
    expect(cleanupSection).toContain('"${runner_temp}"/orbit-installer-target.');
    expect(cleanupSection).toContain("! -L");
    expect(cleanupSection).toContain("down --volumes --remove-orphans");
    expect(cleanupSection).toContain('docker rm --force "${REGISTRY_ID}"');
    expect(cleanupSection).toContain("current_registry_id=");
    expect(cleanupSection).toContain('${current_registry_id}" == "${REGISTRY_ID}"');
  });
});
