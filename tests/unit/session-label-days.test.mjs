import { beforeEach, describe, expect, it, vi } from "vitest";

/*
 * #1461: the session the front end loads carries `user.labelDays`. A user with
 * no user_preferences row (the left join gives null) gets 30; a stored value,
 * 0 included, comes through as it is. The database is stood in for.
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
  disabledAt: null, themeId: null, textSize: null, emailNotifications: null, pushNotifications: null, labelDays: null, ...extra,
});

beforeEach(() => { mocks.record = row({}); });

describe("readSession labelDays", () => {
  it("is 30 for a user with no preferences row", async () => {
    const session = await readSession(cookies, config);
    expect(session?.user.labelDays).toBe(30);
  });

  it.each([0, 45, 365])("reads a stored %i back", async (labelDays) => {
    mocks.record = row({ labelDays });
    expect((await readSession(cookies, config))?.user.labelDays).toBe(labelDays);
  });
});
