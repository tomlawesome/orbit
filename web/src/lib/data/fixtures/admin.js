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

export const adminFixture = {
  /* per-user membership summaries — #453's admin surface will make these real */
  peopleMeta: {
    "u-fixture": "in 5 systems",
    "u-emma": "owns 2 systems",
    "u-rob": "in 2 systems",
    "u-sue": "owns 1 system",
    "u-gran": "in 1 system",
  },
  owners: {
    "hh-lawson-1": "Tom Lawson",
    "hh-seaside-4551": "Emma Lawson",
    "hh-mumdad-2480": "Sue Lawson",
    "hh-narrow-15033": "Rob Lawson",
    "hh-grans-1307": "Emma Lawson",
  },
  relay: [
    ["collection domain", "in.lawson-home.orbit", null],
    ["ingest", "enabled · polling every 30s", "on"],
    ["address generation", "1 · current", "rotate every address"],
    ["unreviewed arrivals", "burn up after 45 days", null],
    ["outbound reminders", "configured", "on"],
  ],
  services: [
    ["ok", "orbit-app", "healthy · 40s ago"],
    ["ok", "orbit-postgres", "healthy · 40s ago"],
    ["ok", "orbit-clamav", "healthy · scanning required"],
    ["ok", "orbit-tika", "running"],
    ["ok", "scheduler", "running · 12s ago"],
  ],
  instance: "ORBIT v1.3.0 · CHANNEL preview · REVISION fd6a7e6 · self-hosted — nothing leaves this machine",
};
