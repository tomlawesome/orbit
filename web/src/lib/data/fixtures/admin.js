/**
 * What administration shows until the server can tell it (#465) — the
 * relay.js/#410 precedent, values the #452 mockup drew.
 *
 * ADMIN_USERS_FIXTURE is API-shaped (`GET /api/admin/users`). Everything in
 * `adminFixture` is NOT knowable from any route yet: per-user membership
 * counts, household ownership, the instance relay's levers and the service
 * rows. Live data renders what exists and omits the rest. (Join requests are
 * not part of this screen at all — §15-2g put them in household management;
 * GET /api/join-requests stays live for that screen to consume.)
 */
import { daysWords } from "../engine-limits.js";
import { SESSION_FIXTURE } from "./workspace.js";

export const ADMIN_USERS_FIXTURE = {
  users: [
    { id: "u-fixture", displayName: "Ned Harlow", email: "ned@harlow.example", isInstanceAdmin: true },
    { id: "u-emma", displayName: "Emma Harlow", email: "emma@harlow.example", isInstanceAdmin: false },
    { id: "u-rob", displayName: "Rob Harlow", email: "rob@harlow.example", isInstanceAdmin: false },
    { id: "u-sue", displayName: "Sue Harlow", email: "sue@harlow.example", isInstanceAdmin: false },
    { id: "u-gran", displayName: "Gran", email: "gran@harlow.example", isInstanceAdmin: false },
  ],
};

/**
 * The other four administration reads (#1697), API-shaped like the users
 * answer above, so /administration loads without the database. Dates are
 * literals for the same reason as the blocks below: the fidelity gate
 * photographs these screens.
 */
export const ADMIN_HEALTH_FIXTURE = {
  health: {
    build: { version: "1.3.0", channel: "preview", revision: "fd6a7e6" },
    services: [
      { id: "database", state: "ok", checkedAt: "2026-09-08T08:00:00.000Z" },
      {
        id: "notification-worker",
        state: "ok",
        checkedAt: "2026-09-08T08:00:00.000Z",
        lastSuccessAt: "2026-09-08T07:59:48.000Z",
        lastErrorAt: null,
      },
      {
        id: "mailbox-ingestion",
        state: "ok",
        checkedAt: "2026-09-08T08:00:00.000Z",
        lastSuccessAt: "2026-09-08T07:59:30.000Z",
        lastErrorAt: null,
      },
      {
        id: "virus-scanner",
        state: "ok",
        checkedAt: "2026-09-08T08:00:00.000Z",
        signaturesAt: "2026-09-08T03:00:00.000Z",
      },
      { id: "document-parser", state: "ok", checkedAt: "2026-09-08T08:00:00.000Z" },
    ],
  },
};

export const ADMIN_DOCUMENT_HEALTH_FIXTURE = {
  health: {
    overall: "healthy",
    encryption: { status: "ready" },
    storage: { status: "ready" },
    scanner: { status: "ready", mode: "required" },
    modelExtraction: {
      status: "not_configured",
      reason: "no_profile",
      recent: { samples: 0, failures: 0, timeouts: 0 },
    },
    quota: { usedBytes: 52428800, limitBytes: 1073741824 },
    worker: {
      started: true,
      running: false,
      lastSuccessAt: "2026-09-08T07:59:48.000Z",
      lastErrorAt: null,
      lastErrorCode: null,
      lastReconciliationAt: "2026-09-08T07:00:00.000Z",
    },
    scanRecovery: { retrying: 0, failed: 0, purgePending: 0, nextExpiryAt: null },
    metadata: {
      locked: false,
      lockedItems: 0,
      lockedReceipts: 0,
      damagedValues: 0,
      damagedItems: 0,
      damagedReceipts: 0,
    },
  },
};

/** No rotation is open. */
export const ADMIN_ROTATION_FIXTURE = { rotation: { inProgress: false, startedAt: null, secondKeyLoaded: false } };

/** A bundle is on record, so the "no recovery bundle exported" card is not drawn. */
export const ADMIN_RECOVERY_BUNDLE_FIXTURE = {
  recoveryBundle: { exported: true, exportedAt: "2026-08-30T10:15:00.000Z" },
};

/**
 * THE M7 SIGN-IN SURFACES UNDER FIXTURES (#915, ADR-0023).
 *
 * Two blocks arrived with local accounts, and neither has a route the fixture
 * harness can answer: `GET /api/auth/methods` reads the caller's own rows and
 * the administration routes need a real challenge. So the screens read these
 * when `data.fixtures` is set, exactly as the relay rows above stand in for a
 * mailbox nobody configured.
 *
 * Every date is a LITERAL, and deliberately so: the fidelity gate photographs
 * these screens, and a date derived from `now` would move the pixels under it
 * every day. They are the same 2026 the rest of this fixture lives in.
 */

/**
 * The helm's "Sign-in methods" block. Both states of the password row are
 * here, keyed the way the front door's `?arrival=` states are: `/settings`
 * shows a reader who has both methods, `/settings?signin=nopassword` the
 * OIDC-only reader whose password row reads "not set".
 */
export const SIGN_IN_METHODS_FIXTURES = {
  both: {
    local: { set: true, changedAt: "2026-08-24T09:12:00.000Z" },
    oidc: [
      {
        id: "id-fixture-1",
        issuer: "https://id.harlow-home.example/",
        linkedAt: "2026-06-02T18:40:00.000Z",
        lastLoginAt: "2026-09-08T07:55:00.000Z",
      },
    ],
  },
  nopassword: {
    local: { set: false, changedAt: null },
    oidc: [
      {
        id: "id-fixture-1",
        issuer: "https://id.harlow-home.example/",
        linkedAt: "2026-06-02T18:40:00.000Z",
        lastLoginAt: "2026-09-08T07:55:00.000Z",
      },
    ],
  },
  /* No identity at all: the state that earns the "link your identity
     provider" offer, which is drawn only when the instance HAS a provider. */
  passwordonly: {
    local: { set: true, changedAt: "2026-08-24T09:12:00.000Z" },
    oidc: [],
  },
};

/**
 * Administration's "add a local user" row, after Create. `sent` is the happy
 * answer the row reports; `failed` is a send the mailer refused, which leaves
 * the account created and the row offering Retry (ADR-0023 §3) —
 * `/administration?localuser=failed` renders it.
 */
export const SETUP_LINK_FIXTURES = {
  sent: {
    sentTo: "newcomer@harlow.example",
    expiresAt: "2026-09-16T11:00:00.000Z",
    sendError: null,
  },
  failed: {
    sentTo: "newcomer@harlow.example",
    expiresAt: "2026-09-16T11:00:00.000Z",
    sendError: "smtp_unavailable",
  },
};

export const adminFixture = {
  /* per-user membership summaries — #453's admin surface will make these real */
  peopleMeta: /** @type {Record<string, string>} */ ({
    "u-fixture": "in 5 systems",
    "u-emma": "owns 2 systems",
    "u-rob": "in 2 systems",
    "u-sue": "owns 1 system",
    "u-gran": "in 1 system",
  }),
  owners: /** @type {Record<string, string>} */ ({
    "hh-harlow-1": "Ned Harlow",
    "hh-seaside-4551": "Emma Harlow",
    "hh-mumdad-2480": "Sue Harlow",
    "hh-narrow-15033": "Rob Harlow",
    "hh-grans-1307": "Emma Harlow",
  }),
  relay: /** @type {[string, string, string | null][]} */ ([
    ["collection domain", "in.harlow-home.orbit", null],
    ["ingest", "enabled · polling every 30s", "on"],
    ["address generation", "1 · current", "rotate every address"],
    ["unreviewed arrivals", `burn up after ${daysWords(SESSION_FIXTURE.retention.receiptDays)}`, null],
    ["outbound reminders", "configured", "on"],
  ]),
  services: /** @type {[string, string, string][]} */ ([
    ["ok", "orbit-app", "healthy · 40s ago"],
    ["ok", "orbit-postgres", "healthy · 40s ago"],
    ["ok", "orbit-clamav", "healthy · scanning required"],
    ["ok", "orbit-tika", "running"],
    ["ok", "scheduler", "running · 12s ago"],
  ]),
  instance: "ORBIT v1.3.0 · CHANNEL preview · REVISION fd6a7e6 · self-hosted — nothing leaves this machine",
};
