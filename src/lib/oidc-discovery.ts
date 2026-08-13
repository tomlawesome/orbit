import { closeSync, constants, fchmodSync, fstatSync, openSync } from "node:fs";

import { readEnvironmentValue } from "./target-identity";

// OIDC discovery validation (issue #295 slice 3), ported from
// scripts/install.sh's `verify_oidc_discovery` (install.sh:887-945).
// Guarantee numbers below cite docs/installer-guarantees.md, Part 1 /
// install.sh, and are re-asserted by name in src/lib/oidc-discovery.test.ts.
//
// This is a two-boundary port, not a pure-filesystem one like slice 1/2:
// fetching the discovery document is a network call (curl), and — unlike
// every other guarantee ported so far — the document's own JSON is
// deliberately *never* parsed by install.sh's own host process at all; it
// is parsed only inside a throwaway, network-isolated, capability-dropped
// Docker container (guarantee #27), specifically because it is untrusted
// content from a remote OIDC provider. Both the curl call and the
// sandboxed-container call are therefore injected adapters with no
// production implementation shipped in this slice — the same "handoff, not
// port" non-goal src/lib/database-volume-safety.ts's docker adapters
// established for slice 2; see docs/adr-notes/295-install-port-plan.md.
//
// validateDiscoveryDocument below is a faithful TypeScript port of the
// exact JS install.sh runs inside that sandboxed container
// (`oidc_discovery_parser`, install.sh:23-47). It exists to prove semantic
// parity against the real, unmodified script (oidc-discovery.parity.test.ts
// awk-extracts the live source) and to give a real, adapter-independent
// implementation ready for the sandboxed adapter slice 5 eventually ships —
// but verifyOidcDiscovery itself never calls it directly against live
// network content; it only ever trusts the injected sandbox adapter's own
// decision, exactly as install.sh only trusts the container's exit code.

/** oidc_discovery_max_bytes (install.sh:21) — the curl --max-filesize cap and the on-disk size recheck bound. */
export const OIDC_DISCOVERY_MAX_BYTES = 1_048_576;

/** maximumInputBytes inside oidc_discovery_parser (install.sh:24): the discovery bound plus room for the issuer line. */
const PARSER_MAX_INPUT_BYTES = OIDC_DISCOVERY_MAX_BYTES + 8192;

/**
 * The discovery URL install.sh builds from OIDC_ISSUER (install.sh:893-897):
 * append `.well-known/openid-configuration`, being careful not to
 * double/drop the separating slash depending on whether the issuer itself
 * already ends in one.
 */
export function buildDiscoveryUrl(issuer: string): string {
  return issuer.endsWith("/")
    ? `${issuer}.well-known/openid-configuration`
    : `${issuer}/.well-known/openid-configuration`;
}

/**
 * oidc_discovery_parser (install.sh:23-47, guarantee #27): validates that
 * `documentContent` is a JSON object whose `issuer` matches exactly, and
 * whose `authorization_endpoint`, `token_endpoint`, and `jwks_uri` are each
 * `https://` URLs with no embedded credentials and no fragment. `input` is
 * reconstructed exactly as the sandboxed container receives it on stdin
 * (`printf '%s\n' "$issuer"; cat -- "$discovery_file"`) so this function's
 * decision is byte-for-byte comparable to the real script's for identical
 * raw input — see the parity test for why the issuer is re-derived from
 * `input` rather than trusted from the `issuer` parameter directly.
 *
 * Not called from verifyOidcDiscovery's own shipped path — see the module
 * comment above for why.
 */
export function validateDiscoveryDocument(issuer: string, documentContent: string): boolean {
  const input = `${issuer}\n${documentContent}`;
  if (Buffer.byteLength(input, "utf8") > PARSER_MAX_INPUT_BYTES) return false;

  const separator = input.indexOf("\n");
  if (separator <= 0) return false;
  const parsedIssuer = input.slice(0, separator);

  let document: unknown;
  try {
    document = JSON.parse(input.slice(separator + 1));
  } catch {
    return false;
  }
  if (document === null || typeof document !== "object" || Array.isArray(document)) return false;
  const record = document as Record<string, unknown>;
  if (record.issuer !== parsedIssuer) return false;

  for (const field of ["authorization_endpoint", "token_endpoint", "jwks_uri"] as const) {
    const value = record[field];
    if (typeof value !== "string") return false;
    let endpoint: URL;
    try {
      endpoint = new URL(value);
    } catch {
      return false;
    }
    if (endpoint.protocol !== "https:" || endpoint.username || endpoint.password || endpoint.hash) return false;
  }

  return true;
}

export interface OidcFetchResult {
  /** curl's own process exit code — 0 means a response was obtained, regardless of HTTP status. */
  curlExitCode: number;
  /** The HTTP status text curl wrote via --write-out (e.g. "200", "404", "000" if no status line was ever read). */
  httpStatus: string;
}

export interface OidcDiscoveryFetchAdapter {
  /**
   * curl --silent --show-error --location --connect-timeout 5 --max-time 10
   *   --max-filesize <OIDC_DISCOVERY_MAX_BYTES> --header 'Accept: application/json'
   *   --proto '=https' --proto-redir '=https' --tlsv1.2
   *   --output <destinationPath> --write-out '%{http_code}' <discoveryUrl>
   * (install.sh:899-905, guarantee #25 — plaintext HTTP and
   * protocol-downgrade-on-redirect are structurally impossible, and both
   * time and response size are bounded).
   */
  fetch(discoveryUrl: string, destinationPath: string): OidcFetchResult;
}

export interface OidcDiscoverySandboxAdapter {
  /**
   * docker run --rm --interactive --entrypoint node --network none --read-only
   *   --cap-drop ALL --security-opt no-new-privileges --user 1001:1001
   *   --pids-limit 64 --memory 64m --cpus 0.5 <resolvedReference>
   *   --input-type=commonjs -e <oidc_discovery_parser>, fed `${issuer}\n`
   *   followed by the discovery document's own bytes on stdin
   * (install.sh:927-944, guarantee #27). Returns whether the sandboxed
   * process exited 0 (validated) or not.
   *
   * No production implementation ships in this slice — the real docker
   * invocation belongs to the slice-5 orchestration work, exactly as
   * src/lib/database-volume-safety.ts's docker adapters. `documentPath` is
   * handed to the adapter (not pre-read content) so a real implementation
   * can `cat` it fresh into the container, matching install.sh's own
   * two-open sequence exactly.
   */
  validate(issuer: string, documentPath: string): boolean;
}

export interface OidcDiscoveryAdapters {
  fetch: OidcDiscoveryFetchAdapter;
  sandbox: OidcDiscoverySandboxAdapter;
}

export type OidcDiscoveryFailureReason = "configuration-failure" | "provider-unavailable";

export interface OidcDiscoveryFailure {
  status: "failed";
  reason: OidcDiscoveryFailureReason;
  /** install.sh's fail_with action — always "retry" for every failure verify_oidc_discovery itself raises. */
  action: "retry";
  message: string;
}

export type OidcDiscoveryOutcome = { status: "ok" } | OidcDiscoveryFailure;

const ISSUER_MISSING_MESSAGE =
  "OIDC_ISSUER requires attention; run the guided configuration and rerun the installer.";
const CONFIGURATION_FAILURE_MESSAGE =
  "OIDC provider configuration could not be validated; review the OIDC discovery response.";
const PROVIDER_UNAVAILABLE_MESSAGE = "OIDC provider is unavailable; retry without changing the configuration.";

function configurationFailure(message: string = CONFIGURATION_FAILURE_MESSAGE): OidcDiscoveryFailure {
  return { status: "failed", reason: "configuration-failure", action: "retry", message };
}

function providerUnavailable(): OidcDiscoveryFailure {
  return { status: "failed", reason: "provider-unavailable", action: "retry", message: PROVIDER_UNAVAILABLE_MESSAGE };
}

/**
 * Classifies a completed fetch attempt exactly like install.sh:906-917:
 * curl exit codes 3 (malformed URL) and 63 (--max-filesize exceeded) are
 * treated as a configuration problem; any other non-zero curl exit is
 * treated as provider unavailability; on curl success, an HTTP 2xx passes,
 * "000" (no status line ever read) is provider-unavailable, and anything
 * else is a configuration problem. Returns null when the fetch passed.
 */
export function classifyOidcFetchResult(result: OidcFetchResult): OidcDiscoveryFailure | null {
  if (result.curlExitCode !== 0) {
    if (result.curlExitCode === 3 || result.curlExitCode === 63) return configurationFailure();
    return providerUnavailable();
  }
  if (/^2\d\d$/.test(result.httpStatus)) return null;
  if (result.httpStatus === "000") return providerUnavailable();
  return configurationFailure();
}

/**
 * is_regular_non_symlink_file + chmod 600 + on-disk size recheck
 * (install.sh:919-925, guarantee #26): the downloaded discovery document is
 * only trusted after independently confirming it landed as a regular,
 * non-symlink file, forcing its permissions to 600, and re-checking its
 * on-disk size against the same byte cap curl itself already enforced.
 *
 * Ported through a single file descriptor (open with O_NOFOLLOW, then
 * fstat/fchmod/fstat on that descriptor) rather than install.sh's own three
 * separate path-based operations, so no step here can be raced by a symlink
 * swap between checks (no stat-then-use pattern) — a strict tightening of
 * install.sh's own literal sequence, not a behavioral difference for any
 * fixture where nothing races the installer. See docs/adr-notes/
 * 295-install-port-plan.md's Flags section.
 */
function verifyDiscoveryFileSafety(discoveryFilePath: string): boolean {
  let descriptor: number;
  try {
    descriptor = openSync(discoveryFilePath, constants.O_RDONLY | constants.O_NOFOLLOW);
  } catch {
    return false;
  }
  try {
    const stat = fstatSync(descriptor);
    if (!stat.isFile()) return false;
    try {
      fchmodSync(descriptor, 0o600);
    } catch {
      return false;
    }
    const rechecked = fstatSync(descriptor);
    return rechecked.size <= OIDC_DISCOVERY_MAX_BYTES;
  } finally {
    closeSync(descriptor);
  }
}

/**
 * verify_oidc_discovery (install.sh:887-945): reads OIDC_ISSUER from the
 * deployment's `.env-orbit` (src/lib/target-identity.ts's
 * readEnvironmentValue — this is how this module "wires onto slice 2's
 * validated identity"), fetches the discovery document to
 * `discoveryFilePath` via the injected fetch adapter, verifies the on-disk
 * file's safety, and only trusts the document after the injected sandbox
 * adapter validates it. `discoveryFilePath` is the caller's responsibility
 * to place under a transaction's own staging area (src/lib/
 * install-transaction.ts's `stagingPathFor`) — this module wires onto
 * slice 1's transaction the same way, by accepting a caller-supplied path
 * rather than managing its own staging directory.
 */
export function verifyOidcDiscovery(
  targetDir: string,
  discoveryFilePath: string,
  adapters: OidcDiscoveryAdapters,
): OidcDiscoveryOutcome {
  const issuer = readEnvironmentValue(targetDir, "OIDC_ISSUER");
  if (issuer === undefined) return configurationFailure(ISSUER_MISSING_MESSAGE);

  const discoveryUrl = buildDiscoveryUrl(issuer);
  const fetchFailure = classifyOidcFetchResult(adapters.fetch.fetch(discoveryUrl, discoveryFilePath));
  if (fetchFailure) return fetchFailure;

  if (!verifyDiscoveryFileSafety(discoveryFilePath)) return configurationFailure();

  if (!adapters.sandbox.validate(issuer, discoveryFilePath)) return configurationFailure();

  return { status: "ok" };
}
