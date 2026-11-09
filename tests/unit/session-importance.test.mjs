import { beforeEach, describe, expect, it, vi } from "vitest";

/*
 * #1463: the session carries `user.planetSize` ("cost" default) and
 * `user.importanceOfferDismissed` (false default). A user with
 * no user_preferences row (the left join gives null) gets "due"; a stored
 * value comes through as it is. The database is stood in for.
 */
const mocks = vi.hoisted(() => ({ record: /** @type {Record<string, any>} */ ({}) }));

vi.mock("@/db", () => {
  const chain = {
    from: () => chain, innerJoin: () => chain, leftJoin: () => chain, where: () => chain,
    limit: async () => [mocks.record],
  };
  return { getDb: () => ({ select: () => chain, update: () => ({ set: () => ({ where: async () => undefined }) }), delete: () => ({ where: async () => undefined }) }) };
});
vi.mock("@/server/metadata/fields", () => ({
  openInstanceMetadataReader: async () => ({ text: () => ({ value: "ned@harlow.example" }) }),
  requireInstanceMetadataWriter: vi.fn(),
}));

const { readSession } = await import("../../src/lib/auth/session");
const { sessionCookieName } = await import("../../src/lib/auth/cookies");

const config = { appUrl: new URL("https://orbit.example"), sessionSecret: "s".repeat(48) };
const cookies = { get: (/** @type {string} */ name) => (name === sessionCookieName(config) ? "token" : undefined) };
const row = (/** @type {Record<string, any>} */ extra) => ({
  id: "s-1", activeHouseholdId: null, expiresAt: new Date(Date.now() + 1e6), lastSeenAt: new Date(),
  userId: "u-1", emailEnc: "x", emailVerified: true, displayName: "Ned", avatarUrl: null, isInstanceAdmin: false,
  disabledAt: null, themeId: null, textSize: null, emailNotifications: null, pushNotifications: null, labelDays: null,
  skyDriver: null, planetSize: null, importanceOfferDismissed: null, ...extra,
});

beforeEach(() => { mocks.record = row({}); });

describe("readSession planetSize and importanceOfferDismissed", () => {
  it("defaults to cost and false for a user with no preferences row", async () => {
    const session = await readSession(cookies, config);
    expect(session?.user.planetSize).toBe("cost");
    expect(session?.user.importanceOfferDismissed).toBe(false);
  });

  it.each(["cost", "importance"])("reads a stored %s back", async (planetSize) => {
    mocks.record = row({ planetSize });
    expect((await readSession(cookies, config))?.user.planetSize).toBe(planetSize);
  });

  it.each([true, false])("reads a stored dismissal of %s back", async (importanceOfferDismissed) => {
    mocks.record = row({ importanceOfferDismissed });
    expect((await readSession(cookies, config))?.user.importanceOfferDismissed).toBe(importanceOfferDismissed);
  });
});
