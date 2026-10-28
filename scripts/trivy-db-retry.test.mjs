import { chmodSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { spawnSync } from "node:child_process";

import { describe, expect, it, vi } from "vitest";

import { PROCESS_TEST_TIMEOUT_MS, failOnProcessDeadline, processGuard } from "./process-budget.mjs";

// Tests here run scripts/trivy-db-retry.sh under bash; a spawn that takes
// tens of milliseconds quiet takes seconds on a starved core (#698). Budget
// and reasoning: scripts/process-budget.mjs.
vi.setConfig({ testTimeout: PROCESS_TEST_TIMEOUT_MS });

const script = new URL("./trivy-db-retry.sh", import.meta.url).pathname;
// The exact-image scan lives in scripts/ci/scan-image.sh (#801), and it is the
// only place Orbit's own scripts download the Trivy database through Docker.
// The GitLab source-scan job runs Trivy as its job image instead.
const imageScan = readFileSync(
  new URL("./ci/scan-image.sh", import.meta.url),
  "utf8",
).replaceAll("\r\n", "\n");

// The exact FATAL shape Trivy 0.72 printed for the 403 that motivated #673,
// and the Java DB variant image scans can also hit.
const dbFailure =
  "FATAL Fatal error run error: init error: DB error: failed to download vulnerability DB: OCI repository error";
const javaDbFailure =
  "FATAL Fatal error run error: scan error: failed to download Java DB: OCI repository error";
// A policy verdict exits nonzero through --exit-code with scan output on
// stderr that carries no DB-download signature.
const policyFailure = "Total: 3 (HIGH: 2, CRITICAL: 1)";

function makeStub({ failures, exitCode, message }) {
  const dir = mkdtempSync(join(tmpdir(), "trivy-retry-"));
  const countFile = join(dir, "count");
  writeFileSync(countFile, "0\n");
  const stub = join(dir, "stub.sh");
  writeFileSync(
    stub,
    [
      "#!/usr/bin/env bash",
      `count=$(($(cat "${countFile}") + 1))`,
      `printf '%s\\n' "$count" > "${countFile}"`,
      `if [ "$count" -le ${failures} ]; then`,
      `  printf '%s\\n' ${JSON.stringify(message)} >&2`,
      `  exit ${exitCode}`,
      "fi",
      'printf "scan-output\\n"',
      "exit 0",
      "",
    ].join("\n"),
  );
  chmodSync(stub, 0o755);
  return { stub, attempts: () => Number(readFileSync(countFile, "utf8")) };
}

function run(stub) {
  return failOnProcessDeadline(spawnSync("bash", [script, "bash", stub], {
    encoding: "utf8",
    env: { ...process.env, TRIVY_DB_RETRY_BACKOFF_SECONDS: "0" },
    ...processGuard(),
  }), { label: "run" });
}

describe("trivy-db-retry.sh", () => {
  it("passes a clean scan through on the first attempt", () => {
    const { stub, attempts } = makeStub({
      failures: 0,
      exitCode: 0,
      message: "",
    });
    const result = run(stub);
    expect(result.status).toBe(0);
    expect(attempts()).toBe(1);
    expect(result.stdout).toContain("scan-output");
  });

  it("never retries a policy verdict", () => {
    const { stub, attempts } = makeStub({
      failures: 99,
      exitCode: 1,
      message: policyFailure,
    });
    const result = run(stub);
    expect(result.status).toBe(1);
    expect(attempts()).toBe(1);
    expect(result.stderr).toContain(policyFailure);
    expect(result.stderr).not.toContain("infrastructure failure");
  });

  it("retries a vulnerability-DB download failure and succeeds", () => {
    const { stub, attempts } = makeStub({
      failures: 1,
      exitCode: 1,
      message: dbFailure,
    });
    const result = run(stub);
    expect(result.status).toBe(0);
    expect(attempts()).toBe(2);
    // The failed attempt's own words stay in the log.
    expect(result.stderr).toContain("failed to download vulnerability DB");
  });

  it("retries a Java DB download failure too", () => {
    const { stub, attempts } = makeStub({
      failures: 1,
      exitCode: 1,
      message: javaDbFailure,
    });
    const result = run(stub);
    expect(result.status).toBe(0);
    expect(attempts()).toBe(2);
  });

  it("exhausts its attempts, names the fault infrastructure, and still fails", () => {
    const { stub, attempts } = makeStub({
      failures: 99,
      exitCode: 2,
      message: dbFailure,
    });
    const result = run(stub);
    expect(result.status).toBe(2);
    expect(attempts()).toBe(3);
    expect(result.stderr).toContain("infrastructure failure");
    expect(result.stderr).toContain("not a scan verdict");
  });
});

describe("Trivy wiring in scripts/ci/scan-image.sh", () => {
  const lines = imageScan.split("\n");

  it("routes every DB-downloading Trivy invocation through the retry wrapper", () => {
    const scanSites = lines
      .map((line, index) => ({ line, index }))
      .filter(({ line }) => /"\$\{TRIVY_IMAGE\}" (fs|image) \\/.test(line));
    expect(scanSites.length).toBe(2);
    for (const site of scanSites) {
      let start = site.index;
      while (start >= 0 && !lines[start].includes("docker run")) {
        start -= 1;
      }
      expect(
        lines[start],
        `docker run for line ${site.index + 1} must use the retry wrapper`,
      ).toContain("bash scripts/trivy-db-retry.sh docker run");
    }
  });

  it("leaves the offline version stamps unwrapped", () => {
    const versionSites = lines.filter((line) =>
      line.includes('"${TRIVY_IMAGE}" version'),
    );
    expect(versionSites.length).toBeGreaterThan(0);
    const wrapped = lines.filter(
      (line) =>
        line.includes("trivy-db-retry.sh") && line.includes('" version'),
    );
    expect(wrapped.length).toBe(0);
  });

  it("keeps the gate unweakened where the retry is introduced", () => {
    // #673: no continue-on-error, no || true anywhere in the change. The
    // wrapper and the scan invocations it guards stay fail-closed; the
    // sidecar job's pre-existing continue-on-error is #647's, not ours.
    const wrapper = readFileSync(
      new URL("./trivy-db-retry.sh", import.meta.url),
      "utf8",
    );
    expect(wrapper).not.toContain("|| true");
    for (const line of lines) {
      if (line.includes("${TRIVY_IMAGE}") || line.includes("trivy-db-retry")) {
        expect(line).not.toContain("|| true");
      }
    }
  });
});

describe("Trivy databases through the runner host's image cache (#1547)", () => {
  const ci = readFileSync(
    new URL("../.gitlab-ci.yml", import.meta.url),
    "utf8",
  ).replaceAll("\r\n", "\n");
  const block = (anchor) => {
    const start = ci.indexOf(`${anchor}: &`);
    expect(start, `${anchor} anchor`).toBeGreaterThan(-1);
    const end = ci.indexOf("\n\n", start);
    return ci.slice(start, end);
  };

  it("builds both database repositories from CI_IMAGE_CACHE_GHCR inside a job script", () => {
    const dir = block(".trivy_db_dir");
    expect(dir).toContain(
      'export TRIVY_DB_REPOSITORY="$CI_IMAGE_CACHE_GHCR/aquasecurity/trivy-db:2"',
    );
    expect(dir).toContain(
      'export TRIVY_JAVA_DB_REPOSITORY="$CI_IMAGE_CACHE_GHCR/aquasecurity/trivy-java-db:1"',
    );
    // The cache is plain HTTP.
    expect(dir).toContain("export TRIVY_INSECURE=true");
  });

  it("names neither database on ghcr.io directly nor in the variables block", () => {
    expect(ci).not.toMatch(/(?<!GHCR\/)ghcr\.io\/aquasecurity/);
    expect(ci).not.toMatch(/^ {2}TRIVY_(JAVA_)?(DB_REPOSITORY|INSECURE):/m);
  });

  it("downloads both databases through the retry wrapper, with the long timeout", () => {
    expect(ci).not.toContain("trivy_fetch");
    expect(block(".trivy_db_warm")).toContain(
      "bash scripts/trivy-db-retry.sh trivy image --download-db-only --timeout 40m",
    );
    expect(ci).toContain(
      "bash scripts/trivy-db-retry.sh trivy image --download-java-db-only --timeout 40m",
    );
  });

  it("gives supply_chain_source the bash the wrapper needs", () => {
    const job = ci.slice(ci.indexOf("\nsupply_chain_source:"));
    expect(job.slice(0, job.indexOf("\n  artifacts:"))).toContain(
      "apk_add bash nodejs",
    );
  });

  it("passes the repositories and TRIVY_INSECURE into scan-image.sh's scanner", () => {
    for (const name of [
      "TRIVY_DB_REPOSITORY",
      "TRIVY_JAVA_DB_REPOSITORY",
      "TRIVY_INSECURE",
    ]) {
      expect(imageScan.split(`  --env ${name} \\`).length - 1, name).toBe(2);
    }
  });
});
