import { chmodSync, existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";

import { checkCurlAvailable, createInstallOidcFetchAdapter } from "./install-curl-adapter";

// PATH-shim coverage for issue #295 slice 5's shipped `curl` adapter — the
// production implementation the plan deferred from slice 3
// (OidcDiscoveryFetchAdapter), and the host-tool check. There is no
// asset-fetch adapter to cover any more: ADR-0019 moved the deployment
// assets inside the image. A fake `curl` bash script logs its exact argv
// (mirroring recovery-bundle.docker-adapter.test.ts's fakeDockerScript
// technique) so
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

// Real curl's refusals, spliced into every fake below so none of them can be
// more permissive than the tool the adapter really drives. Verified against
// curl 8.14.1 on 2026-09-08 and re-asserted against the real binary by
// scripts/tool-parity.test.mjs: an option curl does not know exits 2 with
// "curl: option --x: is unknown", and an option given no value exits 2 too.
// The adapter's own argv is asserted call-by-call below; this is the other
// half — that no argv it could grow would be silently swallowed.
const CURL_REFUSAL_PREAMBLE = [
  "refuse_option() {",
  "  printf 'curl: option %s: is unknown\\n' \"$1\" >&2",
  "  exit 2",
  "}",
  "require_parameter() {",
  "  printf 'curl: option %s: requires parameter\\n' \"$1\" >&2",
  "  exit 2",
  "}",
  'curl_args=("$@")',
  "for (( curl_i = 0; curl_i < ${#curl_args[@]}; curl_i++ )); do",
  '  case "${curl_args[curl_i]}" in',
  "    --output|-o|--write-out|-w|--header|-H|--connect-timeout|--max-time|-m|--max-filesize|--proto|--proto-redir|--retry|--resolve)",
  '      (( curl_i + 1 < ${#curl_args[@]} )) || require_parameter "${curl_args[curl_i]}"',
  "      (( curl_i++ ))",
  "      ;;",
  "    --fail|-f|--silent|-s|--show-error|-S|--location|-L|--tlsv1.2|--tlsv1.3|--version|-V) ;;",
  '    -*) refuse_option "${curl_args[curl_i]}" ;;',
  "  esac",
  "done",
].join("\n");

function makeFakeCurlBin(script: string): string {
  const binDir = mkdtempSync(join(tmpdir(), "orbit-curl-adapter-fakebin-"));
  const [shebang, ...body] = script.split("\n");
  writeFileSync(join(binDir, "curl"), [shebang, CURL_REFUSAL_PREAMBLE, ...body].join("\n"));
  chmodSync(join(binDir, "curl"), 0o755);
  return binDir;
}

function shimEnv(binDir: string, extra: Record<string, string> = {}): NodeJS.ProcessEnv {
  return { ...process.env, PATH: `${binDir}:${process.env.PATH}`, ...extra };
}

describe("checkCurlAvailable (install.sh:1305, guarantee #40)", () => {
  it("returns true when curl --version succeeds", () => {
    const binDir = makeFakeCurlBin(["#!/usr/bin/env bash", "exit 0", ""].join("\n"));
    expect(checkCurlAvailable({ env: shimEnv(binDir) })).toBe(true);
  });

  it("returns false when curl is not on PATH", () => {
    expect(checkCurlAvailable({ curlBinary: "orbit-definitely-not-a-real-binary" })).toBe(false);
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
