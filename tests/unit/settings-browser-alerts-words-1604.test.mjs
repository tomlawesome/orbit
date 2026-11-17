import { beforeEach, describe, expect, it, vi } from "vitest";

/*
 * #1604 b1 W-S1, owner ruling BUILD (lows-g2-rulings.md): the browser-alerts
 * card's words never contradict where its switch landed when the server could
 * not be reached. The catch path of toggleBrowserAlerts words the problem from
 * which way the person tapped and where the switch settled (what syncAlerts
 * reports afterwards):
 *
 *   tapped to | switch now | words
 *   off       | off        | switched off on this device — Orbit could not reach your alert settings to say so
 *   off       | on         | still on — Orbit could not switch alerts off on this device. try again
 *   on        | on         | switched on here, but Orbit could not reach your alert settings — it will try again next time you open settings
 *   on        | off        | unchanged: the reason's own words (permission_denied, unconfigured, or the unreachable fallback)
 *
 * toggleBrowserAlerts is imported for real; workspace.js and the alerts module
 * are stood in, as in settings-method-landed-then-reread.test.mjs.
 */
const ws = vi.hoisted(() => ({
  readSignInMethods: vi.fn(), removeLocalPassword: vi.fn(), startProviderLink: vi.fn(), startStepUp: vi.fn(),
  unlinkProviderIdentity: vi.fn(), writeLocalPassword: vi.fn(), writeReminders: vi.fn(),
  revokeSession: vi.fn(), signOutEverywhere: vi.fn(),
  wordsOf: (/** @type {unknown} */ error, fallback = "failed") => (error instanceof Error ? error.message : fallback),
}));
const alerts = vi.hoisted(() => ({ disableAlerts: vi.fn(), enableAlerts: vi.fn(), syncAlerts: vi.fn() }));
vi.mock("$lib/data/workspace.js", () => ws);
vi.mock("$lib/push/alerts.js", () => alerts);
const { toggleBrowserAlerts } = await import("../../web/src/routes/settings/sign-in-methods.svelte.js");

const unreachable = () => new Error("fetch failed");
/** @param {string} code */
const coded = (code) => Object.assign(new Error(code), { code });
const SUBSCRIPTION = { endpoint: "https://push.example.invalid/not-a-real-endpoint" };

beforeEach(() => {
  for (const fn of Object.values(alerts)) fn.mockReset();
});

/** Taps the switch and returns what the card says and where the switch landed. @param {boolean} isOn */
async function tap(isOn, { curly = false } = {}) {
  const card = { busy: false, problem: /** @type {string | null} */ (null) };
  const set = vi.fn();
  const wake = vi.fn();
  await toggleBrowserAlerts(isOn, { card, set, wake, curly });
  return { card, landed: set.mock.calls.at(-1)?.[0], wake };
}

describe("the alerts switch and its words agree when the server is unreachable (#1604 b1 W-S1)", () => {
  it("turning off, switch lands off: says it is off here and that Orbit could not say so", async () => {
    alerts.disableAlerts.mockRejectedValue(unreachable());
    alerts.syncAlerts.mockResolvedValue(null);
    const { card, landed, wake } = await tap(true);
    expect(landed).toBe(false);
    expect(card.problem).toBe("switched off on this device — Orbit could not reach your alert settings to say so");
    expect(wake).not.toHaveBeenCalled();
  });

  it("turning off, switch stays on: says it is still on and to try again", async () => {
    alerts.disableAlerts.mockRejectedValue(unreachable());
    alerts.syncAlerts.mockResolvedValue(SUBSCRIPTION);
    const { card, landed } = await tap(true);
    expect(landed).toBe(true);
    expect(card.problem).toBe("still on — Orbit could not switch alerts off on this device. try again");
  });

  it("turning on, switch lands on: says it is on here and will be retried next time settings opens", async () => {
    alerts.enableAlerts.mockRejectedValue(unreachable());
    alerts.syncAlerts.mockResolvedValue(SUBSCRIPTION);
    const { card, landed } = await tap(false);
    expect(landed).toBe(true);
    expect(card.problem).toBe("switched on here, but Orbit could not reach your alert settings — it will try again next time you open settings");
  });

  it("the phone's card (curly apostrophes) gets the same lines", async () => {
    alerts.disableAlerts.mockRejectedValue(unreachable());
    alerts.syncAlerts.mockResolvedValue(null);
    const { card } = await tap(true, { curly: true });
    expect(card.problem).toBe("switched off on this device — Orbit could not reach your alert settings to say so");
  });

  it("turning on, switch stays off: the existing words, whatever the reason", async () => {
    alerts.syncAlerts.mockResolvedValue(null);
    alerts.enableAlerts.mockRejectedValue(unreachable());
    expect((await tap(false)).card.problem).toBe("not switched on — Orbit could not reach your alert settings");
    alerts.enableAlerts.mockRejectedValue(coded("permission_denied"));
    expect((await tap(false)).card.problem).toBe("your browser is refusing alerts. allow notifications for Orbit, then try again");
    alerts.enableAlerts.mockRejectedValue(coded("unconfigured"));
    expect((await tap(false)).card.problem).toBe("not switched on — this Orbit has no push keys yet, which is your administrator's to set");
  });
});
