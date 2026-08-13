import { chmodSync, existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";

import { checkCurlAvailable, createInstallAssetFetchAdapter, createInstallOidcFetchAdapter } from "./install-curl-adapter";

// PATH-shim coverage for issue #295 slice 5's shipped `curl` adapter — the
// production implementation the plan deferred from slice 3
// (OidcDiscoveryFetchAdapter) plus this slice's own asset-fetch adapter. A
// fake `curl` bash script logs its exact argv (mirroring
// recovery-bundle.docker-adapter.test.ts's fakeDockerScript technique) so
// each method's flag set can be asserted precisely against install.sh's own
// cited call sites, with no real network access.

const sandboxes: string[] = [];
afterEach(() => {
  for (const sandbox of sandboxes.splice(0)) rmSync(sandbox, { recursive: true, force: true });
});

function newSandbox(prefix: string): string {
  const sandbox = mkdtempSync(join(tmpdir(), prefix));
  sandboxes.push(sandbox);
  return sandbox;
}

function readArgvLog(logPath: string): string[] {
  if (!existsSync(logPath)) return [];
  return readFileSync(logPath, "utf8").split("\n").filter((line) => line.length > 0);
}

function makeFakeCurlBin(script: string): string {
  const binDir = mkdtempSync(join(tmpdir(), "orbit-curl-adapter-fakebin-"));
  writeFileSync(join(binDir, "curl"), script);
  chmodSync(join(binDir, "curl"), 0o755);
  return binDir;
}

function shimEnv(binDir: string, extra: Record<string, string> = {}): NodeJS.ProcessEnv {
  return { ...process.env, PATH: `${binDir}:${process.env.PATH}`, ...extra };
}

describe("checkCurlAvailable (install.sh:1262, guarantee #40)", () => {
  it("returns true when curl --version succeeds", () => {
    const binDir = makeFakeCurlBin(["#!/usr/bin/env bash", "exit 0", ""].join("\n"));
    expect(checkCurlAvailable({ env: shimEnv(binDir) })).toBe(true);
  });

  it("returns false when curl is not on PATH", () => {
    expect(checkCurlAvailable({ curlBinary: "orbit-definitely-not-a-real-binary" })).toBe(false);
  });
});

describe("createInstallAssetFetchAdapter (install.sh:1400-1404)", () => {
  it("spawns the exact fetch argv and writes the shim's output to destinationPath", () => {
    const sandbox = newSandbox("orbit-asset-fetch-");
    const logPath = join(sandbox, "argv.log");
    const script = [
      "#!/usr/bin/env bash",
      'for arg in "$@"; do printf \'%s\\n\' "$arg"; done >> "$ORBIT_ARGV_LOG"',
      'output=""',
      'while [[ $# -gt 0 ]]; do',
      '  if [[ "$1" == "--output" ]]; then output="$2"; fi',
      "  shift",
      "done",
      'printf \'fetched-content\' > "$output"',
      "exit 0",
      "",
    ].join("\n");
    const binDir = makeFakeCurlBin(script);
    const adapter = createInstallAssetFetchAdapter({ env: shimEnv(binDir, { ORBIT_ARGV_LOG: logPath }) });
    const destination = join(sandbox, "asset.txt");

    const result = adapter.fetchAsset("https://raw.githubusercontent.com/tomlawesome/orbit/deadbeef/docker-compose.yml", destination);

    expect(result.ok).toBe(true);
    expect(readFileSync(destination, "utf8")).toBe("fetched-content");
    expect(readArgvLog(logPath)).toEqual([
      "--fail",
      "--silent",
      "--show-error",
      "--location",
      "--output",
      destination,
      "https://raw.githubusercontent.com/tomlawesome/orbit/deadbeef/docker-compose.yml",
    ]);
  });

  it("reports ok=false on a nonzero curl exit", () => {
    const binDir = makeFakeCurlBin(["#!/usr/bin/env bash", "exit 22", ""].join("\n"));
    const adapter = createInstallAssetFetchAdapter({ env: shimEnv(binDir) });
    const result = adapter.fetchAsset("https://example.invalid/missing", "/dev/null");
    expect(result.ok).toBe(false);
  });
});

describe("createInstallOidcFetchAdapter (install.sh:899-905, guarantee #25)", () => {
  it("spawns the exact HTTPS-pinned, bounded fetch argv", () => {
    const sandbox = newSandbox("orbit-oidc-fetch-");
    const logPath = join(sandbox, "argv.log");
    const script = [
      "#!/usr/bin/env bash",
      'for arg in "$@"; do printf \'%s\\n\' "$arg"; done >> "$ORBIT_ARGV_LOG"',
      'printf \'200\'',
      "exit 0",
      "",
    ].join("\n");
    const binDir = makeFakeCurlBin(script);
    const adapter = createInstallOidcFetchAdapter({ env: shimEnv(binDir, { ORBIT_ARGV_LOG: logPath }) });
    const destination = join(sandbox, "discovery.json");

    const result = adapter.fetch("https://idp.example/.well-known/openid-configuration", destination);

    expect(result).toEqual({ curlExitCode: 0, httpStatus: "200" });
    const argv = readArgvLog(logPath);
    expect(argv).toContain("--proto");
    expect(argv).toContain("=https");
    expect(argv).toContain("--proto-redir");
    expect(argv).toContain("--tlsv1.2");
    expect(argv).toContain("--connect-timeout");
    expect(argv[argv.indexOf("--connect-timeout") + 1]).toBe("5");
    expect(argv).toContain("--max-time");
    expect(argv[argv.indexOf("--max-time") + 1]).toBe("10");
    expect(argv).toContain("--max-filesize");
    expect(argv[argv.indexOf("--max-filesize") + 1]).toBe("1048576");
    expect(argv).toContain("--write-out");
    expect(argv[argv.indexOf("--write-out") + 1]).toBe("%{http_code}");
    expect(argv[argv.length - 1]).toBe("https://idp.example/.well-known/openid-configuration");
  });

  it("reports the curl exit code and '000' http status on a connection failure", () => {
    const script = ["#!/usr/bin/env bash", "exit 7", ""].join("\n");
    const binDir = makeFakeCurlBin(script);
    const adapter = createInstallOidcFetchAdapter({ env: shimEnv(binDir) });
    const result = adapter.fetch("https://unreachable.example/.well-known/openid-configuration", "/tmp/does-not-matter");
    expect(result).toEqual({ curlExitCode: 7, httpStatus: "000" });
  });

  it("respects a custom maxBytes option", () => {
    const sandbox = newSandbox("orbit-oidc-fetch-maxbytes-");
    const logPath = join(sandbox, "argv.log");
    const script = ["#!/usr/bin/env bash", 'for arg in "$@"; do printf \'%s\\n\' "$arg"; done >> "$ORBIT_ARGV_LOG"', "printf '200'", ""].join(
      "\n",
    );
    const binDir = makeFakeCurlBin(script);
    const adapter = createInstallOidcFetchAdapter({ env: shimEnv(binDir, { ORBIT_ARGV_LOG: logPath }), maxBytes: 2048 });
    adapter.fetch("https://idp.example/.well-known/openid-configuration", join(sandbox, "discovery.json"));
    const argv = readArgvLog(logPath);
    expect(argv[argv.indexOf("--max-filesize") + 1]).toBe("2048");
  });
});
