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
export const ADMIN_USERS_FIXTURE = {
  users: [
    { id: "u-fixture", displayName: "Tom Lawson", email: "tom@lawson.example", isInstanceAdmin: true },
    { id: "u-emma", displayName: "Emma Lawson", email: "emma@lawson.example", isInstanceAdmin: false },
    { id: "u-rob", displayName: "Rob Lawson", email: "rob@lawson.example", isInstanceAdmin: false },
    { id: "u-sue", displayName: "Sue Lawson", email: "sue@lawson.example", isInstanceAdmin: false },
    { id: "u-gran", displayName: "Gran", email: "gran@lawson.example", isInstanceAdmin: false },
  ],
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
        issuer: "https://id.lawson-home.example/",
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
        issuer: "https://id.lawson-home.example/",
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
    sentTo: "newcomer@lawson.example",
    expiresAt: "2026-09-16T11:00:00.000Z",
    sendError: null,
  },
  failed: {
    sentTo: "newcomer@lawson.example",
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
    "hh-lawson-1": "Tom Lawson",
    "hh-seaside-4551": "Emma Lawson",
    "hh-mumdad-2480": "Sue Lawson",
    "hh-narrow-15033": "Rob Lawson",
    "hh-grans-1307": "Emma Lawson",
  }),
  relay: /** @type {[string, string, string | null][]} */ ([
    ["collection domain", "in.lawson-home.orbit", null],
    ["ingest", "enabled · polling every 30s", "on"],
    ["address generation", "1 · current", "rotate every address"],
    ["unreviewed arrivals", "burn up after 45 days", null],
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
