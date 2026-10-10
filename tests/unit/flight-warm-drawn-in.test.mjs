import { afterEach, describe, expect, it, vi } from "vitest";

/*
 * #1344: SignIn.svelte's `drawnIn` is replaced by warm.js's, the SSR-safe
 * one (it guards `typeof SVGElement === "function"`). That needs warm.js to
 * export it. Behaviour is pinned here against a stubbed page: drawnIn waits
 * for the animations that are painted on the main thread (not the
 * compositor-only ones) and never throws, with or without a page.
 */

afterEach(() => {
  vi.unstubAllGlobals();
  vi.resetModules();
});

/** an Animation whose effect animates `props` and whose end is `finished` */
function animation(props, finished) {
  return {
    effect: {
      target: {},
      getComputedTiming: () => ({ endTime: 500 }),
      getKeyframes: () => [Object.fromEntries(props.map((p) => [p, "x"]))],
    },
    finished,
  };
}

describe("warm.js exports drawnIn (#1344)", () => {
  it("is an exported function", async () => {
    const warm = await import("$lib/flight/warm.js");
    expect(typeof warm.drawnIn).toBe("function");
  });

  it("settles, without throwing, where there is no page to ask (server-side render)", async () => {
    vi.stubGlobal("document", undefined);
    const { drawnIn } = await import("$lib/flight/warm.js");
    await expect(drawnIn()).resolves.toBeDefined();
  });

  it("does not wait for animations the compositor carries (opacity, transform)", async () => {
    const never = new Promise(() => {});
    vi.stubGlobal("document", { getAnimations: () => [animation(["opacity", "transform"], never)] });
    const { drawnIn } = await import("$lib/flight/warm.js");
    await expect(Promise.race([drawnIn().then(() => "done"), new Promise((r) => setTimeout(() => r("hung"), 50))])).resolves.toBe("done");
  });

  it("waits for a painted animation (colour) to finish, and survives one that was cancelled", async () => {
    let finish = () => {};
    const slow = new Promise((resolve) => { finish = resolve; });
    const cancelled = Promise.reject(new Error("cancelled"));
    cancelled.catch(() => {}); // handled here; drawnIn must cope with the rejection too
    vi.stubGlobal("document", { getAnimations: () => [animation(["color"], slow), animation(["color"], cancelled)] });
    const { drawnIn } = await import("$lib/flight/warm.js");
    let done = false;
    const waiting = drawnIn().then(() => { done = true; });
    await new Promise((r) => setTimeout(r, 20));
    expect(done).toBe(false);
    finish();
    await waiting;
    expect(done).toBe(true);
  });
});
