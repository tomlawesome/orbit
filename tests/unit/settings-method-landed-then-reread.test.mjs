import { beforeEach, describe, expect, it, vi } from "vitest";

/*
 * #1584 W-F3: a sign-in method change that landed is never read back as not
 * changed. changeMethod (settings/sign-in-methods.svelte.js) sends the
 * change, says and wakes its outcome, and reads the methods again. When only
 * that last read fails the change is still made: the desk's `say` and the
 * phone's `wake` each get the outcome and then a `done — ... reload ...`
 * line, the card carries no problem (least of all "not changed"), the
 * methods are not kept from a failed read, and the card is no longer busy.
 * A refused change keeps its own words and says nothing landed.
 *
 * changeMethod is imported for real; workspace.js and the alerts module are
 * stood in.
 */
const ws = vi.hoisted(() => ({
  readSignInMethods: vi.fn(), removeLocalPassword: vi.fn(), startProviderLink: vi.fn(), startStepUp: vi.fn(),
  unlinkProviderIdentity: vi.fn(), writeLocalPassword: vi.fn(), writeReminders: vi.fn(),
  revokeSession: vi.fn(), signOutEverywhere: vi.fn(),
  wordsOf: (/** @type {unknown} */ error, fallback = "failed") => (error instanceof Error ? error.message : fallback),
}));
vi.mock("$lib/data/workspace.js", () => ws);
vi.mock("$lib/push/alerts.js", () => ({ disableAlerts: vi.fn(), enableAlerts: vi.fn(), syncAlerts: vi.fn() }));
const { changeMethod } = await import("../../web/src/routes/settings/sign-in-methods.svelte.js");

const DONE = /^done —.*reload/i;

beforeEach(() => {
  for (const fn of Object.values(ws)) if (typeof fn.mockReset === "function") fn.mockReset();
});

const make = () => {
  const card = { busy: false, problem: /** @type {string | null} */ (null) };
  const on = { card, landed: vi.fn(), say: vi.fn(), wake: vi.fn(), keep: vi.fn() };
  return { card, on };
};
const typed = { hasPassword: true, currentPassword: "not-a-real-password", newPassword: "another-not-real-one" };

describe("a sign-in method change that landed is not read back as not changed (#1584 W-F3)", () => {
  /** @type {[string, string, () => void, Partial<typeof typed>][]} */
  const cases = [
    ["password_remove", "password removed", () => ws.removeLocalPassword.mockResolvedValue(undefined), {}],
    ["unlink:idp-1", "identity provider unlinked", () => ws.unlinkProviderIdentity.mockResolvedValue(undefined), {}],
    ["password_set", "password set", () => ws.writeLocalPassword.mockResolvedValue({ changed: false }), { hasPassword: false }],
  ];
  for (const [action, outcome, command, how] of cases) {
    it(`${action}: the outcome is said and woken, then the done line; no problem; not busy; nothing kept`, async () => {
      command();
      ws.readSignInMethods.mockRejectedValue(new Error("the screen would not load"));
      const { card, on } = make();
      await changeMethod(action, { ...typed, ...how }, on);

      expect(on.say).toHaveBeenCalledTimes(2);
      expect(on.say.mock.calls[0][0]).toBe(outcome);
      expect(on.say.mock.calls[1][0]).toMatch(DONE);
      expect(on.landed).toHaveBeenCalledTimes(1);
      expect(on.wake).toHaveBeenCalledTimes(2);
      expect(on.wake.mock.calls[0][0]).toBe(outcome);
      expect(on.wake.mock.calls[1][0]).toBe(on.say.mock.calls[1][0]);
      expect(card.problem).toBeNull();
      expect(card.busy).toBe(false);
      expect(on.keep).not.toHaveBeenCalled();
    });
  }
});

describe("guards: a refused change and a good read keep their shape (pass today)", () => {
  it("a refused change says its own words; nothing landed and the methods are not read", async () => {
    ws.removeLocalPassword.mockRejectedValue({ code: "recent_authentication_required" });
    const { card, on } = make();
    await changeMethod("password_remove", typed, on);

    expect(card.problem).toBe("that isn't your current password — nothing was changed");
    expect(on.say).not.toHaveBeenCalled();
    expect(on.landed).not.toHaveBeenCalled();
    expect(on.wake).not.toHaveBeenCalled();
    expect(ws.readSignInMethods).not.toHaveBeenCalled();
    expect(card.busy).toBe(false);
  });

  it("a good read is kept, and the outcome is said and woken once each", async () => {
    ws.removeLocalPassword.mockResolvedValue(undefined);
    ws.readSignInMethods.mockResolvedValue({ methods: [] });
    const { card, on } = make();
    await changeMethod("password_remove", typed, on);

    expect(on.keep).toHaveBeenCalledWith({ methods: [] });
    expect(on.say).toHaveBeenCalledTimes(1);
    expect(on.wake).toHaveBeenCalledTimes(1);
    expect(card.problem).toBeNull();
    expect(card.busy).toBe(false);
  });
});
