/**
 * mail-in/core boundary: pure option building only, no `imapflow` import.
 * Split from `config.ts` so that file holds the config shape and its pure
 * helpers.
 */
import { IMAP_ATTACHMENT_LIMITS } from "./imap-attachment-validation";
import type { ImapIngestionConfig } from "./config";

/**
 * TLS-only provider options shared by polling and bounded verification.
 * `maxLiteralSize` is the mail limit the cycle read (#1388); a verification
 * connection fetches no message, so the default limit serves it.
 */
export function imapProviderConnectionOptions(config: ImapIngestionConfig, maxLiteralSize: number = IMAP_ATTACHMENT_LIMITS.rawMessageBytes) {
  return {
    host: config.host,
    port: config.port,
    secure: true,
    auth: { user: config.user, pass: config.password },
    tls: { rejectUnauthorized: true, servername: config.tlsServerName || config.host },
    logger: false as const,
    connectionTimeout: 10_000,
    greetingTimeout: 10_000,
    socketTimeout: 30_000,
    maxLiteralSize,
  };
}
