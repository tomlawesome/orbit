import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

/*
 * #1151 W2-R7: `notificationclick` finds the matching tab via
 * `clients.matchAll()`, then calls `.focus()` on it. If that tab closes in
 * the window between `matchAll()` resolving and `.focus()` running, the
 * client is gone and `.focus()` rejects -- with no `.catch()`, the whole
 * `waitUntil` promise rejects and the tap is simply dropped: no window opens
 * at all, and the reader who tapped the notification sees nothing happen.
 *
 * The service worker is a plain script that registers its listeners on
 * `self` at import time, so each test stubs a fake `self` before importing
 * it fresh and drives the captured `notificationclick` listener directly.
 */

const TARGET = "https://orbit.example/home";

function stubSelf({ matchAll }) {
  const listeners = {};
  const openWindow = vi.fn(async () => ({ url: TARGET, focused: true }));
  const fakeSelf = {
    location: { origin: "https://orbit.example" },
    addEventListener: (type, handler) => { listeners[type] = handler; },
    clients: { matchAll, openWindow },
    registration: { showNotification: vi.fn() },
  };
  vi.stubGlobal("self", fakeSelf);
  return { listeners, openWindow };
}

/** @param {string} url */
function clickEvent(url) {
  let waited = Promise.resolve();
  const notification = { close: vi.fn(), data: { url } };
  const event = {
    notification,
    waitUntil: (promise) => { waited = promise; },
  };
  return { event, notification, result: () => waited };
}

beforeEach(() => {
  vi.resetModules();
});

afterEach(() => {
  vi.unstubAllGlobals();
});

describe("notificationclick", () => {
  it("opens a new window when no tab already has that address", async () => {
    const { listeners, openWindow } = stubSelf({ matchAll: vi.fn(async () => []) });
    await import("../../web/src/service-worker.js");
    const { event, result } = clickEvent("/home");

    listeners.notificationclick(event);
    await result();

    expect(openWindow).toHaveBeenCalledWith(TARGET);
  });

  it("focuses the matching tab when it is still open", async () => {
    const focus = vi.fn(async () => ({ url: TARGET, focused: true }));
    const { listeners, openWindow } = stubSelf({
      matchAll: vi.fn(async () => [{ url: TARGET, focus }]),
    });
    await import("../../web/src/service-worker.js");
    const { event, result } = clickEvent("/home");

    listeners.notificationclick(event);
    await result();

    expect(focus).toHaveBeenCalled();
    expect(openWindow).not.toHaveBeenCalled();
  });

  it(
    "falls back to opening a window when the matching tab closes between matchAll and focus",
    async () => {
      const focus = vi.fn(async () => { throw new DOMException("client gone", "InvalidStateError"); });
      const { listeners, openWindow } = stubSelf({
        matchAll: vi.fn(async () => [{ url: TARGET, focus }]),
      });
      await import("../../web/src/service-worker.js");
      const { event, result } = clickEvent("/home");

      listeners.notificationclick(event);
      await result();

      expect(focus).toHaveBeenCalled();
      expect(openWindow).toHaveBeenCalledWith(TARGET);
    },
  );
});
