import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

/*
 * #1151 SQ2-Q4: `GET /api/settings/mail-relay/senders`'s fixture branch
 * answered `{ addresses: [] }` always, but the real route never is empty —
 * it calls `seedSenderAddress` before listing, which seeds the account's own
 * (unverified) address the first time anyone reads the page. A fixture-mode
 * screen therefore could never show the "you have an address, it isn't
 * verified yet" state the real product always starts a reader in.
 *
 * `fixture` runs before any session or engine call (see `api()` in
 * $lib/server/api.js), so this needs no session or engine mocking at all.
 */

beforeEach(() => {
  vi.resetModules();
});

afterEach(() => {
  vi.unstubAllEnvs();
});

describe("GET /api/settings/mail-relay/senders fixture", () => {
  it("answers a seeded, unverified address instead of an empty list", async () => {
    vi.stubEnv("ORBIT_FIXTURES", "1");
    const { GET } = await import(
      "../../web/src/routes/api/settings/mail-relay/senders/+server.js"
    );
    const response = await GET(/** @type {any} */ ({}));
    const body = await response.json();

    expect(body.addresses).not.toHaveLength(0);
    expect(body.addresses[0]).toMatchObject({ verified: false });
  });
});
