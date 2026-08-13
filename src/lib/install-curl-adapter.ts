import { spawnSync } from "node:child_process";

import type { OidcDiscoveryFetchAdapter } from "./oidc-discovery";

// The real `curl` adapter (issue #295 slice 5) — the shipped production
// implementation the plan deferred from slice 3 (OidcDiscoveryFetchAdapter)
// plus this slice's own deployment-asset fetch (install.sh:1400-1404,
// guarantee #45's fetch half). Both factories below spawn a fixed `curl`
// argv array via `spawnSync` — never a shell string — mirroring
// install-docker-adapter.ts's own convention. Kept as two separate
// factories (rather than one object implementing both interfaces) because
// OidcDiscoveryFetchAdapter and AssetFetchAdapter each declare their own
// `fetch` method with a different return shape — install.sh's own two curl
// call sites (OIDC discovery vs. deployment-asset download) use different
// flag sets for good reason (guarantee #25's HTTPS-pinning/timeout/size-cap
// only applies to the untrusted-provider discovery fetch), so keeping them
// as textually distinct methods avoids conflating two different curl
// invocations behind one shared name.

export interface InstallCurlAdapterOptions {
  cwd?: string;
  /** Overrides the `curl` executable name/path. Defaults to `"curl"`. */
  curlBinary?: string;
  /** Environment for the `curl` subprocess (defaults to `process.env`) — the PATH-shim test seam. */
  env?: NodeJS.ProcessEnv;
}

export interface AssetFetchResult {
  ok: boolean;
}

export interface AssetFetchAdapter {
  /** curl --fail --silent --show-error --location --output <destinationPath> <url> (install.sh:1400-1404). */
  fetchAsset(url: string, destinationPath: string): AssetFetchResult;
}

/** command -v curl (install.sh:1262, guarantee #40's curl half). Shared by both factories below. */
export function checkCurlAvailable(options: InstallCurlAdapterOptions = {}): boolean {
  const result = spawnSync(options.curlBinary ?? "curl", ["--version"], {
    cwd: options.cwd,
    env: options.env ?? process.env,
    stdio: ["ignore", "ignore", "ignore"],
  });
  return result.status === 0;
}

/**
 * The real AssetFetchAdapter: install.sh's plain deployment-asset fetch
 * (install.sh:1400-1404) — no HTTPS pinning of its own beyond what
 * `asset_base`'s fixed `https://raw.githubusercontent.com/...` prefix
 * already guarantees, no explicit timeout, no size cap (the fixed,
 * source-controlled asset allowlist is not untrusted third-party content the
 * way an OIDC provider's discovery document is).
 */
export function createInstallAssetFetchAdapter(options: InstallCurlAdapterOptions = {}): AssetFetchAdapter {
  const curlBinary = options.curlBinary ?? "curl";
  const cwd = options.cwd;
  const env = options.env ?? process.env;

  return {
    fetchAsset(url, destinationPath) {
      const result = spawnSync(curlBinary, ["--fail", "--silent", "--show-error", "--location", "--output", destinationPath, url], {
        cwd,
        env,
        stdio: ["ignore", "ignore", "ignore"],
      });
      return { ok: result.status === 0 };
    },
  };
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
