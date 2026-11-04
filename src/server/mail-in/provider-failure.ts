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

function codeOf(value: unknown): string {
  if (value === null || typeof value !== "object") return "";
  const code = (value as Record<string, unknown>).code;
  return typeof code === "string" ? code.toUpperCase() : "";
}

/**
 * @returns the reason word for a thrown provider error; `other` when it has no usable code.
 * nodemailer overwrites a system error's `code` with its own (ECONNECTION,
 * ESOCKET) and keeps the original in `originalCode`, and a wrapped error may
 * carry it in `cause` (#1670), so all three are read. Only a sign-in refusal
 * (EAUTH, SMTP 535/534/530) is auth_rejected.
 */
export function classifyProviderFailure(error: unknown): ProviderFailureReason {
  const fields = error !== null && typeof error === "object" ? error as Record<string, unknown> : {};
  const codes = [
    codeOf(fields),
    typeof fields.originalCode === "string" ? fields.originalCode.toUpperCase() : "",
    codeOf(fields.cause),
  ].filter((code) => code !== "");
  const responseCode = typeof fields.responseCode === "number" ? fields.responseCode : undefined;
  const any = (test: (code: string) => boolean) => codes.some(test);
  if (any((code) => HOSTNAME_CODES.has(code))) return "tls_hostname";
  if (any((code) => code.includes("CERT") || code === "UNABLE_TO_VERIFY_LEAF_SIGNATURE")) return "tls_certificate";
  if (any((code) => STARTTLS_CODES.has(code))) return "starttls_unavailable";
  if (any((code) => AUTH_CODES.has(code)) || fields.authenticationFailed === true
    || responseCode === 535 || responseCode === 534 || responseCode === 530) return "auth_rejected";
  if (any((code) => DNS_CODES.has(code))) return "dns_failed";
  if (any((code) => REFUSED_CODES.has(code))) return "connection_refused";
  if (any((code) => TIMEOUT_CODES.has(code))) return "timeout";
  return "other";
}

/** One bounded warning for one failed check, in the event/state/reason/action shape. */
export function logProviderCheckFailed(event: "mail.smtp.verify" | "imap.verify", reason: ProviderFailureReason, impact: OperationalImpact): void {
  log.warn({ event, state: "degraded", reason, action: "check_provider", impact });
}
