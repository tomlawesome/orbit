import { readEnvironmentValue } from "./target-identity";

// OIDC discovery validation, ported from scripts/install.sh's
// `verify_oidc_discovery` (issue #295 slice 3) and, since #1212 (build note
// F5), fetched and parsed in the engine process itself. Guarantee numbers
// below cite docs/installer-guarantees.md, Part 1 / install.sh, and are
// re-asserted by name in src/lib/oidc-discovery.test.ts.
//
// install.sh fetched the document with curl and parsed it only inside a
// throwaway `docker run --network none --read-only` container, because bash
// had to borrow the image's Node to parse untrusted JSON. The engine already
// is a container from that image, with no Docker socket, so the sandbox has
// nothing left to add. What keeps an untrusted provider bounded now is what
// curl enforced -- https only, on every redirect too, a time limit and a byte
// cap -- plus the shape rules of validateDiscoveryDocument (#27). The
// document is held in memory and never written to disk.

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

/** curl's own --max-redirs default is 50; a discovery document needs far fewer. */
const MAXIMUM_REDIRECTS = 10;

/** curl --max-time 10 (install.sh). */
const DISCOVERY_TIMEOUT_MS = 10_000;

export interface VerifyOidcDiscoveryOptions {
  /** The transport; the global fetch in production. Tests carry the request to a local fixture server. */
  fetchImpl?: typeof fetch;
  timeoutMs?: number;
}

class BodyTooLarge extends Error {}

/** Reads the body up to the cap and stops there (curl --max-filesize). */
async function readCappedBody(response: Response): Promise<string> {
  const declared = Number(response.headers.get("content-length"));
  if (Number.isFinite(declared) && declared > OIDC_DISCOVERY_MAX_BYTES) throw new BodyTooLarge();
  if (!response.body) return "";
  const reader = response.body.getReader();
  const chunks: Uint8Array[] = [];
  let total = 0;
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    total += value.byteLength;
    if (total > OIDC_DISCOVERY_MAX_BYTES) {
      await reader.cancel().catch(() => {});
      throw new BodyTooLarge();
    }
    chunks.push(value);
  }
  return Buffer.concat(chunks).toString("utf8");
}

/**
 * The curl request install.sh made (guarantee #25), as an in-process fetch:
 * `--proto '=https' --proto-redir '=https'` (an http URL, first or after a
 * redirect, is never requested: curl's exit 1), `--location` (redirects
 * followed by hand so each target is checked first), `--max-time 10` (exit
 * 28), `--max-filesize` (exit 63). TLS 1.2 is Node's own minimum. Outcomes
 * map onto curl's exit codes and `%{http_code}` so classifyOidcFetchResult
 * decides exactly as install.sh did; the body comes back for a 2xx only.
 */
async function fetchDiscovery(discoveryUrl: string, options: VerifyOidcDiscoveryOptions): Promise<OidcFetchResult & { body?: string }> {
  const fetchImpl = options.fetchImpl ?? fetch;
  let current: URL;
  try {
    current = new URL(discoveryUrl);
  } catch {
    return { curlExitCode: 3, httpStatus: "000" };
  }
  const signal = AbortSignal.timeout(options.timeoutMs ?? DISCOVERY_TIMEOUT_MS);
  try {
    for (let redirects = 0; ; redirects += 1) {
      if (current.protocol !== "https:") return { curlExitCode: 1, httpStatus: "000" };
      const response = await fetchImpl(current.href, { redirect: "manual", headers: { Accept: "application/json" }, signal });
      const location = response.headers.get("location");
      if (response.status >= 300 && response.status < 400 && location !== null) {
        await response.body?.cancel().catch(() => {});
        // curl --max-redirs: exit 47.
        if (redirects >= MAXIMUM_REDIRECTS) return { curlExitCode: 47, httpStatus: String(response.status) };
        try {
          current = new URL(location, current);
        } catch {
          return { curlExitCode: 3, httpStatus: String(response.status) };
        }
        continue;
      }
      const body = await readCappedBody(response);
      return { curlExitCode: 0, httpStatus: String(response.status), body };
    }
  } catch (error) {
    if (error instanceof BodyTooLarge) return { curlExitCode: 63, httpStatus: "000" };
    // A timeout (curl 28), a refused or reset connection (7, 56), a TLS
    // failure (35, 60): every one of them is the provider being unavailable.
    return { curlExitCode: signal.aborted ? 28 : 7, httpStatus: "000" };
  }
}

/**
 * verify_oidc_discovery (guarantees #25-27): reads OIDC_ISSUER from the
 * deployment's `.env-orbit`, fetches the provider's discovery document under
 * curl's old rules and checks its shape. Failures carry install.sh's own
 * reason (`configuration-failure` or `provider-unavailable`), action and
 * message.
 */
export async function verifyOidcDiscovery(targetDir: string, options: VerifyOidcDiscoveryOptions = {}): Promise<OidcDiscoveryOutcome> {
  const issuer = readEnvironmentValue(targetDir, "OIDC_ISSUER");
  if (issuer === undefined) return configurationFailure(ISSUER_MISSING_MESSAGE);

  const result = await fetchDiscovery(buildDiscoveryUrl(issuer), options);
  const fetchFailure = classifyOidcFetchResult(result);
  if (fetchFailure) return fetchFailure;
  if (result.body === undefined || !validateDiscoveryDocument(issuer, result.body)) return configurationFailure();
  return { status: "ok" };
}
