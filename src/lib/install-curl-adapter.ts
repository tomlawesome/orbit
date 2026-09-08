import { spawnSync } from "node:child_process";

import type { OidcDiscoveryFetchAdapter } from "./oidc-discovery";

// The real `curl` adapter (issue #295 slice 5) — the shipped production
// implementation the plan deferred from slice 3 (OidcDiscoveryFetchAdapter),
// plus the host-tool check that requires `curl` to be present at all
// (install.sh:1305, guarantee #40). Both spawn a fixed `curl` argv array via
// `spawnSync` — never a shell string — mirroring install-docker-adapter.ts's
// own convention.
//
// ADR-0019 removed this module's other half. Deployment assets used to be
// downloaded from GitHub's raw-content host, keyed by the commit id stamped
// into the image; they now come out of the resolved image itself, via
// install-docker-adapter.ts's create/cp/rm methods, with no download left as
// a fallback. `curl` is still required on the host, but only for the OIDC
// discovery request below (install.sh's own comment at :1303-1305 says the
// same).

export interface InstallCurlAdapterOptions {
  cwd?: string;
  /** Overrides the `curl` executable name/path. Defaults to `"curl"`. */
  curlBinary?: string;
  /** Environment for the `curl` subprocess (defaults to `process.env`) — the PATH-shim test seam. */
  env?: NodeJS.ProcessEnv;
}

/** command -v curl (install.sh:1305, guarantee #40's curl half). */
export function checkCurlAvailable(options: InstallCurlAdapterOptions = {}): boolean {
  const result = spawnSync(options.curlBinary ?? "curl", ["--version"], {
    cwd: options.cwd,
    env: options.env ?? process.env,
    stdio: ["ignore", "ignore", "ignore"],
  });
  return result.status === 0;
}

/**
 * The real OidcDiscoveryFetchAdapter (slice 3 deferral): install.sh:899-905,
 * guarantee #25 — `--proto '=https' --proto-redir '=https' --tlsv1.2` (both
 * plaintext HTTP and protocol-downgrade-on-redirect are structurally
 * impossible), 5s connect / 10s total timeout, and `--max-filesize` bounding
 * response size. `--write-out '%{http_code}'` reports the HTTP status text
 * even on a non-2xx response (curl's own exit code is still read from
 * `spawnSync`'s `status`).
 */
export function createInstallOidcFetchAdapter(
  options: InstallCurlAdapterOptions & { maxBytes?: number } = {},
): OidcDiscoveryFetchAdapter {
  const curlBinary = options.curlBinary ?? "curl";
  const cwd = options.cwd;
  const env = options.env ?? process.env;
  const maxBytes = options.maxBytes ?? 1_048_576;

  return {
    fetch(discoveryUrl, destinationPath) {
      const result = spawnSync(
        curlBinary,
        [
          "--silent",
          "--show-error",
          "--location",
          "--connect-timeout",
          "5",
          "--max-time",
          "10",
          "--max-filesize",
          String(maxBytes),
          "--header",
          "Accept: application/json",
          "--proto",
          "=https",
          "--proto-redir",
          "=https",
          "--tlsv1.2",
          "--output",
          destinationPath,
          "--write-out",
          "%{http_code}",
          discoveryUrl,
        ],
        { cwd, env, encoding: "utf8" },
      );
      return {
        curlExitCode: result.status ?? -1,
        httpStatus: (result.stdout || "000").trim() || "000",
      };
    },
  };
}
