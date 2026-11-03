import { log, type OperationalImpact, type OperationalReason } from "@/lib/logger";

/**
 * Failed provider checks (#1626): the thrown error's `code` (and a few typed
 * flags) is classed into one word from a fixed list. The message, host and
 * credentials of the error are never read, so none can reach a log line.
 */
export type ProviderFailureReason = Extract<OperationalReason,
  "dns_failed" | "connection_refused" | "timeout" | "tls_certificate" | "tls_hostname" | "auth_rejected" | "starttls_unavailable" | "other">;

const DNS_CODES = new Set(["ENOTFOUND", "EAI_AGAIN", "EDNS", "ENODATA", "ESERVFAIL"]);
const REFUSED_CODES = new Set(["ECONNREFUSED"]);
const TIMEOUT_CODES = new Set(["ETIMEDOUT", "ESOCKETTIMEDOUT", "TIMEOUT", "ECONNTIMEOUT", "ETIMEOUT"]);
const HOSTNAME_CODES = new Set(["ERR_TLS_CERT_ALTNAME_INVALID", "HOSTNAME_MISMATCH"]);
const AUTH_CODES = new Set(["EAUTH", "AUTHENTICATIONFAILED", "AUTH"]);
const STARTTLS_CODES = new Set(["ETLS", "ESTARTTLS"]);

/** @returns the reason word for a thrown provider error; `other` when it has no usable code. */
export function classifyProviderFailure(error: unknown): ProviderFailureReason {
  const fields = error !== null && typeof error === "object" ? error as Record<string, unknown> : {};
  const code = typeof fields.code === "string" ? fields.code.toUpperCase() : "";
  const responseCode = typeof fields.responseCode === "number" ? fields.responseCode : undefined;
  if (HOSTNAME_CODES.has(code)) return "tls_hostname";
  if (code.includes("CERT") || code === "UNABLE_TO_VERIFY_LEAF_SIGNATURE" || code === "SELF_SIGNED_CERT_IN_CHAIN") return "tls_certificate";
  if (STARTTLS_CODES.has(code)) return "starttls_unavailable";
  if (AUTH_CODES.has(code) || fields.authenticationFailed === true || responseCode === 535 || responseCode === 534) return "auth_rejected";
  if (DNS_CODES.has(code)) return "dns_failed";
  if (REFUSED_CODES.has(code)) return "connection_refused";
  if (TIMEOUT_CODES.has(code)) return "timeout";
  return "other";
}

/** One bounded warning for one failed check, in the event/state/reason/action shape. */
export function logProviderCheckFailed(event: "mail.smtp.verify" | "imap.verify", reason: ProviderFailureReason, impact: OperationalImpact): void {
  log.warn({ event, state: "degraded", reason, action: "check_provider", impact });
}
