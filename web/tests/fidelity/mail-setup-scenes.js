/*
 * THE MAIL CARD'S SCENES (#1629, design/v19/mail-setup/round-1, direction J).
 * The data story of that round: Ned Harlow's instance, every host invented.
 * The fixture server answers "no mailbox" and "sending not set up", so the
 * harness (pocket-states.js, `stageAdministration`) hands a scene's answers
 * to the three reads by request interception, the way the configured-mailbox
 * states already do. Kept beside the harness, not in src/lib/data/fixtures:
 * those are fixture mode's own answers, checked against the engine's schemas
 * (workspace.contract.test.ts), and these are only the harness's.
 * API-shaped: the mailbox is `GET /api/admin/mailbox`'s, the sending
 * `GET /api/admin/sending`'s, and `mailSending` the operations snapshot's.
 */
export const MAIL_SETUP_MAILBOX = {
  configured: true, enabled: true, host: "mail.harlow.example", port: 993, accountUser: "orbit@harlow.example",
  mailbox: "INBOX", tlsServerName: "mail.harlow.example", providerProfile: "mailcow", authMethod: "password",
  trustedRecipientHeader: "Delivered-To",
  pollSeconds: 300, verificationState: "verified", verifiedAt: "2026-08-13T11:58:00.000Z",
  aliasPattern: "<name>-<code>@harlow.example", credentialSetAt: "2026-08-03T09:00:00.000Z", credentialSetBy: "Ned Harlow",
  hasPassword: true, hasAliasKey: true, version: 3,
  health: { status: "ok", smtp: "ok", imap: "ok", checkedAt: "2026-08-13T11:58:00.000Z", credentialLocked: false },
};

/** `GET /api/admin/mailbox` on a fresh install: the server's own "not set up"
    shape (mailbox-settings.ts), not the fixture server's "no mailbox". */
export const MAIL_SETUP_NO_MAILBOX = {
  configured: false, enabled: false, host: "", port: 993, accountUser: "", mailbox: "INBOX",
  tlsServerName: "", providerProfile: "other", authMethod: "password", trustedRecipientHeader: "",
  pollSeconds: 300, verificationState: "unverified", verifiedAt: null, aliasPattern: null,
  credentialSetAt: null, credentialSetBy: null, hasPassword: false, hasAliasKey: false, version: null,
  health: { status: "not_configured", smtp: "not_configured", imap: "not_configured", checkedAt: null, credentialLocked: false },
};

/** `GET /api/admin/sending` with nothing set (the server's own "not set up"). */
const SENDING_NOT_SET_UP = {
  configured: false, via: null, host: null, port: null, security: null, user: null,
  senderName: null, senderAddress: null, sendsAs: null, password: null,
  credentialSetBy: null, credentialSetAt: null, source: null, setBy: null, setAt: null,
  lastSent: null, version: null,
};

const VIA_MAILBOX = {
  configured: true, via: "mailbox", host: "mail.harlow.example", port: 587, security: "starttls", user: "orbit@harlow.example",
  senderName: "Orbit", senderAddress: "orbit@harlow.example", sendsAs: "Orbit <orbit@harlow.example>", password: "mailbox",
  credentialSetBy: null, credentialSetAt: null, source: "ui", setBy: "Ned Harlow", setAt: "2026-08-07T10:00:00.000Z",
  lastSent: { what: "a reminder", at: "2026-08-13T11:19:00.000Z" }, version: 2,
};

const VIA_ANOTHER_ACCOUNT = {
  configured: true, via: "account", host: "smtp.sendgrid.example", port: 465, security: "implicit_tls", user: "apikey",
  senderName: "Orbit", senderAddress: "orbit@harlow.example", sendsAs: "Orbit <orbit@harlow.example>", password: "set",
  credentialSetBy: "Ned Harlow", credentialSetAt: "2026-08-07T10:00:00.000Z", source: "ui", setBy: "Ned Harlow", setAt: "2026-08-07T10:00:00.000Z",
  lastSent: { what: "a reminder", at: "2026-08-13T11:19:00.000Z" }, version: 4,
};

/** The operations snapshot's `mailSending` for a row set from the screen, or none. */
const FROM_SCREEN = { source: "ui", importSkipped: null, importedFromEnvironment: false };
const NOTHING = { source: null, importSkipped: null, importedFromEnvironment: false };

/**
 * Each scene of the round, by its name there: whether the mailbox is set (the
 * MAIL_SETUP_MAILBOX answer, else MAIL_SETUP_NO_MAILBOX), the Sending
 * answer and the snapshot's `mailSending`. The two editor scenes are
 * `set-up` and `mailbox-only` with the editor opened; `not-copied` is the
 * review's could-not-copy line (#1629), drawn on a fresh instance.
 * @type {Record<"set-up" | "another-account" | "fresh" | "mailbox-only" | "imported" | "not-copied", { mailbox: boolean, sending: object, mailSending: object }>}
 */
export const MAIL_SETUP_SCENES = {
  "set-up": { mailbox: true, sending: VIA_MAILBOX, mailSending: FROM_SCREEN },
  "another-account": { mailbox: true, sending: VIA_ANOTHER_ACCOUNT, mailSending: FROM_SCREEN },
  fresh: { mailbox: false, sending: SENDING_NOT_SET_UP, mailSending: NOTHING },
  "mailbox-only": { mailbox: true, sending: SENDING_NOT_SET_UP, mailSending: NOTHING },
  imported: {
    mailbox: true,
    sending: {
      ...VIA_ANOTHER_ACCOUNT, host: "smtp.harlow.example", port: 587, security: "starttls", user: "orbit@harlow.example",
      credentialSetBy: null, credentialSetAt: "2026-08-12T06:00:00.000Z", source: "imported", setBy: null, setAt: "2026-08-12T06:00:00.000Z",
      lastSent: { what: "a reminder", at: "2026-08-13T11:19:00.000Z" }, version: 1,
    },
    mailSending: { source: "imported", importSkipped: null, importedFromEnvironment: true },
  },
  "not-copied": { mailbox: false, sending: SENDING_NOT_SET_UP, mailSending: { source: null, importSkipped: { reason: "key_unavailable" }, importedFromEnvironment: false } },
};
