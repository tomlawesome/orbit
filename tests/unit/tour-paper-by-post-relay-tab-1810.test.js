import { describe, expect, it, vi } from "vitest";

/*
 * #1810 W-F1: the "Paper by post" chapter says "Forward a bill to your relay
 * address" against the Mail card, so the card must be on its `your relay` tab
 * (Settings opens on `reminders` unless the arrival names the relay) before
 * that line plays. Desk and phone. The chapter is played against a recording
 * stand-in for the film's vocabulary; what is asserted is that the relay tab
 * has been asked for (by landing on `#mail`, or by pressing the tab) by the
 * time the callout is said.
 */

/** Plays the chapter and answers what it had done when the first callout began. */
async function playUntilCallout(pocket) {
  const { default: chapter } = await import("../../web/src/lib/tour/chapters/06-paper-by-post.js");
  /** @type {string[]} */
  const done = [];
  let atCallout = null;
  const ctx = {
    pocket,
    setScreen: vi.fn(async (route) => { done.push(`screen ${route}`); }),
    veil: vi.fn(),
    ctl: vi.fn((target) => { done.push(`ctl ${JSON.stringify(target)}`); return target; }),
    goto: vi.fn(async (target) => { done.push(`goto ${JSON.stringify(target)}`); }),
    unlight: vi.fn(),
    callout: vi.fn(async () => { atCallout ??= [...done]; }),
    dropCallout: vi.fn(),
  };
  await chapter.play(/** @type {any} */ (ctx));
  return atCallout ?? done;
}

const reachedRelayTab = (/** @type {string[]} */ done) =>
  done.some((step) => /^screen \/settings.*#mail/u.test(step) || /tab-relay/u.test(step));

describe("W-F1: the relay-address callout plays on the relay tab", () => {
  it.each([["desk", false], ["phone", true]])("%s: the relay tab is asked for before the callout", async (_name, pocket) => {
    const done = await playUntilCallout(pocket);
    expect(reachedRelayTab(done), `before the callout the film did only: ${done.join(" | ")}`).toBe(true);
  });
});
