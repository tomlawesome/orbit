import { spawnSync } from "node:child_process";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { afterAll, describe, expect, it } from "vitest";

import { OIDC_DISCOVERY_MAX_BYTES, buildDiscoveryUrl, validateDiscoveryDocument, verifyOidcDiscovery } from "./oidc-discovery";

// Parity between scripts/install.sh's OIDC discovery handling and this
// module (issue #295 slice 3), in two parts:
//
//  1. `oidc_discovery_parser` (the JS install.sh runs inside a sandboxed
//     container to validate the untrusted discovery document, guarantee
//     #27) is awk-extracted verbatim from the live, unmodified install.sh
//     and executed for real via `node --input-type=commonjs -e` — never
//     hand-copied — and compared against validateDiscoveryDocument for
//     identical raw stdin.
//  2. `verify_oidc_discovery` itself (install.sh:887-945, plus its
//     `is_regular_non_symlink_file`/`read_environment_value` dependencies)
//     is likewise awk-extracted and run as bash, with a single stub
//     `curl`/`docker` pair (Node scripts reading a JSON scenario file) put
//     first on PATH — the same "PATH-shim-testable seam" pattern
//     database-volume-safety.parity.test.ts established for `docker` in
//     slice 2 — so both the real script and verifyOidcDiscovery's
//     production orchestration observe the identical fetch/sandbox
//     responses and must reach the identical decision (reason, action, and
//     message).
//
// Extraction fails loudly (empty match) if any cited name is ever renamed,
// per the slice plan's established convention (docs/adr-notes/
// 295-install-port-plan.md).

const repoRoot = fileURLToPath(new URL("../..", import.meta.url));
const installScriptPath = join(repoRoot, "scripts", "install.sh");

function extractFunction(name: string): string {
  const script = `
    $0 ~ "^${name}\\\\(\\\\) \\\\{" { found = 1 }
    found { print; if ($0 == "}") { found = 0; exit } }
  `;
  const result = spawnSync("awk", [script, installScriptPath], { encoding: "utf8" });
  if (result.status !== 0 || !result.stdout.trim()) {
    throw new Error(`Could not extract ${name}() from install.sh; it may have been renamed.`);
  }
  return result.stdout;
}

// Extracts a `readonly <name>=...` statement verbatim, from its declaration
// line through the first subsequent line equal to `endLineExact` (a
// multi-line single-quoted value), or just its own line when omitted (a
// single-line value).
function extractReadonlyBlock(name: string, endLineExact?: string): string {
  const script = endLineExact
    ? `
      $0 ~ "^readonly ${name}=" { found = 1 }
      found { print; if ($0 == "${endLineExact}") { found = 0; exit } }
    `
    : `$0 ~ "^readonly ${name}=" { print; exit }`;
  const result = spawnSync("awk", [script, installScriptPath], { encoding: "utf8" });
  if (result.status !== 0 || !result.stdout.trim()) {
    throw new Error(`Could not extract readonly ${name} from install.sh; it may have been renamed or reshaped.`);
  }
  return result.stdout;
}

// --- Part 1: oidc_discovery_parser semantic parity -------------------------

function extractParserSource(): string {
  const raw = extractReadonlyBlock("oidc_discovery_parser", "}'");
  const lines = raw.replace(/\n$/, "").split("\n");
  lines[0] = lines[0].replace(/^readonly oidc_discovery_parser='/, "");
  const lastIndex = lines.length - 1;
  lines[lastIndex] = lines[lastIndex].replace(/'$/, "");
  return lines.join("\n");
}

function runExtractedParser(stdin: string): number {
  const result = spawnSync("node", ["--input-type=commonjs", "-e", extractParserSource()], {
    input: stdin,
    encoding: "utf8",
  });
  return result.status ?? -1;
}

const VALID_DOCUMENT = JSON.stringify({
  issuer: "https://idp.parity.invalid",
  authorization_endpoint: "https://idp.parity.invalid/authorize",
  token_endpoint: "https://idp.parity.invalid/token",
  jwks_uri: "https://idp.parity.invalid/jwks",
});

describe("oidc_discovery_parser parity (#27)", () => {
  const cases: Array<{ name: string; issuer: string; document: string }> = [
    { name: "well-formed matching document", issuer: "https://idp.parity.invalid", document: VALID_DOCUMENT },
    {
      name: "issuer mismatch",
      issuer: "https://idp.parity.invalid",
      document: JSON.stringify({ ...JSON.parse(VALID_DOCUMENT), issuer: "https://other.invalid" }),
    },
    { name: "malformed JSON", issuer: "https://idp.parity.invalid", document: "{not json" },
    { name: "document is an array", issuer: "https://idp.parity.invalid", document: "[]" },
    { name: "document is null", issuer: "https://idp.parity.invalid", document: "null" },
    {
      name: "missing jwks_uri",
      issuer: "https://idp.parity.invalid",
      document: (() => {
        const parsed = JSON.parse(VALID_DOCUMENT);
        delete parsed.jwks_uri;
        return JSON.stringify(parsed);
      })(),
    },
    {
      name: "plain http endpoint",
      issuer: "https://idp.parity.invalid",
      document: JSON.stringify({ ...JSON.parse(VALID_DOCUMENT), token_endpoint: "http://idp.parity.invalid/token" }),
    },
    {
      name: "endpoint with embedded credentials",
      issuer: "https://idp.parity.invalid",
      document: JSON.stringify({
        ...JSON.parse(VALID_DOCUMENT),
        authorization_endpoint: "https://user:pass@idp.parity.invalid/authorize",
      }),
    },
    {
      name: "endpoint with a fragment",
      issuer: "https://idp.parity.invalid",
      document: JSON.stringify({ ...JSON.parse(VALID_DOCUMENT), jwks_uri: "https://idp.parity.invalid/jwks#x" }),
    },
  ];

  for (const testCase of cases) {
    it(`agrees: ${testCase.name}`, () => {
      const stdin = `${testCase.issuer}\n${testCase.document}`;
      const bashExit = runExtractedParser(stdin);
      const tsResult = validateDiscoveryDocument(testCase.issuer, testCase.document);
      expect(tsResult).toBe(bashExit === 0);
    });
  }

  it("agrees: input exceeding the byte cap is rejected", () => {
    const oversized = "x".repeat(OIDC_DISCOVERY_MAX_BYTES + 8192 + 1);
    const stdin = `https://idp.parity.invalid\n${oversized}`;
    expect(runExtractedParser(stdin)).not.toBe(0);
    expect(validateDiscoveryDocument("https://idp.parity.invalid", oversized)).toBe(false);
  });
});

// --- Part 2: verify_oidc_discovery orchestration parity ---------------------

const harnessDir = mkdtempSync(join(tmpdir(), "orbit-oidc-discovery-parity-"));
const stubBinDir = join(harnessDir, "bin");
mkdirSync(stubBinDir);
const curlScenarioPath = join(harnessDir, "curl-scenario.json");

const stubCurlSource = `#!/usr/bin/env node
const fs = require("node:fs");
const scenario = JSON.parse(fs.readFileSync(process.env.STUB_CURL_SCENARIO, "utf8"));
const args = process.argv.slice(2);
function flag(name) {
  const index = args.indexOf(name);
  return index >= 0 ? args[index + 1] : undefined;
}
const url = args[args.length - 1];
const outputPath = flag("--output");
const entry = scenario[url];
if (!entry) {
  process.stdout.write("000");
  process.exit(6);
}
if (entry.body !== undefined && outputPath) {
  fs.writeFileSync(outputPath, entry.body);
}
process.stdout.write(entry.httpStatus ?? "000");
process.exit(entry.curlExitCode ?? 0);
`;
writeFileSync(join(stubBinDir, "curl"), stubCurlSource, { mode: 0o755 });

const stubDockerSource = `#!/usr/bin/env node
const chunks = [];
process.stdin.on("data", (chunk) => chunks.push(chunk));
process.stdin.on("end", () => {
  process.exit(Number(process.env.STUB_DOCKER_EXIT_CODE || "0"));
});
`;
writeFileSync(join(stubBinDir, "docker"), stubDockerSource, { mode: 0o755 });

interface CurlScenario {
  [url: string]: { curlExitCode?: number; httpStatus?: string; body?: string };
}

function writeCurlScenario(scenario: CurlScenario): void {
  writeFileSync(curlScenarioPath, JSON.stringify(scenario));
}

const driverDir = mkdtempSync(join(tmpdir(), "orbit-oidc-discovery-parity-driver-"));
const driverPath = join(driverDir, "driver.sh");

function buildDriverScript(): string {
  const maxBytes = extractReadonlyBlock("oidc_discovery_max_bytes");
  const parser = extractReadonlyBlock("oidc_discovery_parser", "}'");
  const functions = ["is_regular_non_symlink_file", "read_environment_value", "verify_oidc_discovery"]
    .map(extractFunction)
    .join("\n");

  return [
    "#!/usr/bin/env bash",
    "set -Eeuo pipefail",
    // Minimal stand-ins for install.sh's own fail()/fail_with(): the real
    // ones drive terminal UI/elapsed-time bookkeeping this test doesn't
    // exercise. Printing reason/action/message to stderr is enough to
    // compare install.sh's own classification and message text against
    // verifyOidcDiscovery's returned OidcDiscoveryOutcome.
    'fail() { printf "%s\\n" "$*" >&2; exit 1; }',
    'fail_with() { printf "reason=%s action=%s\\n" "$1" "$2" >&2; shift 2; fail "$@"; }',
    "",
    maxBytes,
    parser,
    "",
    functions,
    "",
    'environment_file="$1"',
    'staging_dir="$2"',
    'resolved_reference="$3"',
    "verify_oidc_discovery",
    'printf "status=ok\\n"',
    "",
  ].join("\n");
}

writeFileSync(driverPath, buildDriverScript(), { mode: 0o755 });

const sandboxes: string[] = [];
function makeSandbox(): { dir: string; stagingDir: string } {
  const dir = mkdtempSync(join(tmpdir(), "orbit-oidc-discovery-parity-sandbox-"));
  sandboxes.push(dir);
  const stagingDir = join(dir, "staging");
  mkdirSync(stagingDir);
  return { dir, stagingDir };
}

afterAll(() => {
  for (const sandbox of sandboxes) rmSync(sandbox, { recursive: true, force: true });
  rmSync(driverDir, { recursive: true, force: true });
  rmSync(harnessDir, { recursive: true, force: true });
});

function runDriver(
  environmentFile: string,
  stagingDir: string,
  dockerExitCode: number,
): { status: number; stdout: string; stderr: string } {
  const env = {
    ...process.env,
    PATH: `${stubBinDir}:${process.env.PATH}`,
    STUB_CURL_SCENARIO: curlScenarioPath,
    STUB_DOCKER_EXIT_CODE: String(dockerExitCode),
  };
  const result = spawnSync("bash", [driverPath, environmentFile, stagingDir, "stub-image"], {
    encoding: "utf8",
    env,
  });
  return { status: result.status ?? -1, stdout: result.stdout.trim(), stderr: result.stderr.trim() };
}

// Parses the two-line stderr shape fail_with's stand-in above produces
// ("reason=X action=Y" then the message) back into the same shape
// verifyOidcDiscovery returns, for a direct structural comparison.
function parseBashFailure(stderr: string): { reason: string; action: string; message: string } {
  const [first, ...rest] = stderr.split("\n");
  const match = /^reason=(\S+) action=(\S+)$/.exec(first ?? "");
  if (!match) throw new Error(`Unexpected driver stderr shape: ${stderr}`);
  return { reason: match[1], action: match[2], message: rest.join("\n") };
}

function tsAdapters(dockerExitCode: number) {
  return {
    fetch: {
      fetch: (url: string, destination: string) => {
        const scenario: CurlScenario = JSON.parse(readFileSync(curlScenarioPath, "utf8"));
        const entry = scenario[url];
        if (!entry) return { curlExitCode: 6, httpStatus: "000" };
        if (entry.body !== undefined) writeFileSync(destination, entry.body);
        return { curlExitCode: entry.curlExitCode ?? 0, httpStatus: entry.httpStatus ?? "000" };
      },
    },
    sandbox: { validate: () => dockerExitCode === 0 },
  };
}

const ISSUER = "https://idp.parity.invalid";
const DISCOVERY_URL = buildDiscoveryUrl(ISSUER);

describe("verify_oidc_discovery orchestration parity", () => {
  it("agrees: a fully valid discovery response succeeds", () => {
    const { dir, stagingDir } = makeSandbox();
    writeFileSync(join(dir, ".env-orbit"), `OIDC_ISSUER=${ISSUER}\n`, { mode: 0o600 });
    writeCurlScenario({ [DISCOVERY_URL]: { curlExitCode: 0, httpStatus: "200", body: VALID_DOCUMENT } });

    const bash = runDriver(join(dir, ".env-orbit"), stagingDir, 0);
    expect(bash.status).toBe(0);
    expect(bash.stdout).toContain("status=ok");

    const result = verifyOidcDiscovery(dir, join(stagingDir, "oidc-discovery.json"), tsAdapters(0));
    expect(result).toEqual({ status: "ok" });
  });

  it("agrees: OIDC_ISSUER missing from .env-orbit fails closed identically", () => {
    const { dir, stagingDir } = makeSandbox();
    writeFileSync(join(dir, ".env-orbit"), "APP_URL=https://orbit.parity.invalid\n", { mode: 0o600 });

    const bash = runDriver(join(dir, ".env-orbit"), stagingDir, 0);
    expect(bash.status).toBe(1);
    const bashFailure = parseBashFailure(bash.stderr);

    const result = verifyOidcDiscovery(dir, join(stagingDir, "oidc-discovery.json"), tsAdapters(0));
    expect(result).toEqual({
      status: "failed",
      reason: bashFailure.reason,
      action: bashFailure.action,
      message: bashFailure.message,
    });
  });

  it("agrees: curl exit 63 (--max-filesize exceeded) is a configuration-failure", () => {
    const { dir, stagingDir } = makeSandbox();
    writeFileSync(join(dir, ".env-orbit"), `OIDC_ISSUER=${ISSUER}\n`, { mode: 0o600 });
    writeCurlScenario({ [DISCOVERY_URL]: { curlExitCode: 63, httpStatus: "000" } });

    const bash = runDriver(join(dir, ".env-orbit"), stagingDir, 0);
    expect(bash.status).toBe(1);
    const bashFailure = parseBashFailure(bash.stderr);
    expect(bashFailure.reason).toBe("configuration-failure");

    const result = verifyOidcDiscovery(dir, join(stagingDir, "oidc-discovery.json"), tsAdapters(0));
    expect(result).toEqual({
      status: "failed",
      reason: bashFailure.reason,
      action: bashFailure.action,
      message: bashFailure.message,
    });
  });

  it("agrees: an unreachable provider (curl exit 7) is provider-unavailable", () => {
    const { dir, stagingDir } = makeSandbox();
    writeFileSync(join(dir, ".env-orbit"), `OIDC_ISSUER=${ISSUER}\n`, { mode: 0o600 });
    writeCurlScenario({ [DISCOVERY_URL]: { curlExitCode: 7, httpStatus: "000" } });

    const bash = runDriver(join(dir, ".env-orbit"), stagingDir, 0);
    const bashFailure = parseBashFailure(bash.stderr);
    expect(bashFailure.reason).toBe("provider-unavailable");

    const result = verifyOidcDiscovery(dir, join(stagingDir, "oidc-discovery.json"), tsAdapters(0));
    expect(result).toEqual({
      status: "failed",
      reason: bashFailure.reason,
      action: bashFailure.action,
      message: bashFailure.message,
    });
  });

  it("agrees: an HTTP 500 response is a configuration-failure", () => {
    const { dir, stagingDir } = makeSandbox();
    writeFileSync(join(dir, ".env-orbit"), `OIDC_ISSUER=${ISSUER}\n`, { mode: 0o600 });
    writeCurlScenario({ [DISCOVERY_URL]: { curlExitCode: 0, httpStatus: "500", body: VALID_DOCUMENT } });

    const bash = runDriver(join(dir, ".env-orbit"), stagingDir, 0);
    const bashFailure = parseBashFailure(bash.stderr);
    expect(bashFailure.reason).toBe("configuration-failure");

    const result = verifyOidcDiscovery(dir, join(stagingDir, "oidc-discovery.json"), tsAdapters(0));
    expect(result).toEqual({
      status: "failed",
      reason: bashFailure.reason,
      action: bashFailure.action,
      message: bashFailure.message,
    });
  });

  it("agrees: a symlinked destination is refused even after a successful fetch (#26)", () => {
    const { dir, stagingDir } = makeSandbox();
    writeFileSync(join(dir, ".env-orbit"), `OIDC_ISSUER=${ISSUER}\n`, { mode: 0o600 });
    const elsewhere = join(dir, "elsewhere.json");
    writeFileSync(elsewhere, VALID_DOCUMENT);
    const discoveryPath = join(stagingDir, "oidc-discovery.json");
    symlinkSync(elsewhere, discoveryPath);
    writeCurlScenario({ [DISCOVERY_URL]: { curlExitCode: 0, httpStatus: "200", body: VALID_DOCUMENT } });

    const bash = runDriver(join(dir, ".env-orbit"), stagingDir, 0);
    expect(bash.status).toBe(1);
    const bashFailure = parseBashFailure(bash.stderr);
    expect(bashFailure.reason).toBe("configuration-failure");

    const result = verifyOidcDiscovery(dir, discoveryPath, tsAdapters(0));
    expect(result).toEqual({
      status: "failed",
      reason: bashFailure.reason,
      action: bashFailure.action,
      message: bashFailure.message,
    });
  });

  it("agrees: an oversized on-disk file is refused, defence in depth beyond curl's own limit (#26)", () => {
    const { dir, stagingDir } = makeSandbox();
    writeFileSync(join(dir, ".env-orbit"), `OIDC_ISSUER=${ISSUER}\n`, { mode: 0o600 });
    writeCurlScenario({
      [DISCOVERY_URL]: { curlExitCode: 0, httpStatus: "200", body: "x".repeat(OIDC_DISCOVERY_MAX_BYTES + 1) },
    });

    const bash = runDriver(join(dir, ".env-orbit"), stagingDir, 0);
    expect(bash.status).toBe(1);
    const bashFailure = parseBashFailure(bash.stderr);
    expect(bashFailure.reason).toBe("configuration-failure");

    const result = verifyOidcDiscovery(dir, join(stagingDir, "oidc-discovery.json"), tsAdapters(0));
    expect(result).toEqual({
      status: "failed",
      reason: bashFailure.reason,
      action: bashFailure.action,
      message: bashFailure.message,
    });
  });

  it("agrees: the sandboxed validator rejecting the document is a configuration-failure (#27)", () => {
    const { dir, stagingDir } = makeSandbox();
    writeFileSync(join(dir, ".env-orbit"), `OIDC_ISSUER=${ISSUER}\n`, { mode: 0o600 });
    writeCurlScenario({ [DISCOVERY_URL]: { curlExitCode: 0, httpStatus: "200", body: VALID_DOCUMENT } });

    const bash = runDriver(join(dir, ".env-orbit"), stagingDir, 1);
    expect(bash.status).toBe(1);
    const bashFailure = parseBashFailure(bash.stderr);
    expect(bashFailure.reason).toBe("configuration-failure");

    const result = verifyOidcDiscovery(dir, join(stagingDir, "oidc-discovery.json"), tsAdapters(1));
    expect(result).toEqual({
      status: "failed",
      reason: bashFailure.reason,
      action: bashFailure.action,
      message: bashFailure.message,
    });
  });
});
