/**
 * mail-in/core boundary: pure option building only, no `imapflow` import.
 * Split from `config.ts` so that file holds the config shape and its pure
 * helpers.
 */
import { IMAP_ATTACHMENT_LIMITS } from "./imap-attachment-validation";
import type { ImapIngestionConfig } from "./config";

/** TLS-only provider options shared by polling and bounded verification. */
export function imapProviderConnectionOptions(config: ImapIngestionConfig) {
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
    maxLiteralSize: IMAP_ATTACHMENT_LIMITS.rawMessageBytes,
  };
}
