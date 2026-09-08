import { readFileSync, readdirSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";

import { afterEach, describe, expect, it, vi } from "vitest";

import {
  AlertsError,
  alertsSupported,
  currentSubscription,
  disableAlerts,
  enableAlerts,
} from "../../web/src/lib/push/alerts.js";
import { showUrgentCount } from "../../web/src/lib/urgent-badge.js";

/*
 * #763: browser push notifications, front-end side. alerts.js takes every
 * browser API through an injected `deps` object, so these tests drive the
 * five states the issue names with fakes — never a mocked global — and
 * assert on what the module DID (permission asked or not, what went over
 * the wire, in what order) rather than on which fake happened to be called.
 */

const SUPPORTED_SCOPE = { navigator: { serviceWorker: {} }, PushManager: class {}, Notification: class {} };

/** A fake ServiceWorkerRegistration whose pushManager answers `subscription`. */
function fakeRegistration(subscription, { subscribe } = {}) {
  return {
    pushManager: {
      getSubscription: vi.fn(async () => subscription),
      subscribe: subscribe ?? vi.fn(async () => {
        throw new Error("subscribe() was not expected to be called");
      }),
    },
  };
}

describe("alertsSupported", () => {
  it("is true only when serviceWorker, PushManager and Notification are all present", () => {
    expect(alertsSupported(SUPPORTED_SCOPE)).toBe(true);
    expect(alertsSupported({ navigator: {}, PushManager: class {}, Notification: class {} })).toBe(false);
    expect(alertsSupported({ navigator: { serviceWorker: {} }, Notification: class {} })).toBe(false);
    expect(alertsSupported({ navigator: { serviceWorker: {} }, PushManager: class {} })).toBe(false);
    expect(alertsSupported({})).toBe(false);
  });
});

describe("currentSubscription", () => {
  it("is null on an unsupported browser, without touching serviceWorker", async () => {
    const getRegistration = vi.fn();
    const scope = { navigator: { serviceWorker: { getRegistration } } }; // no PushManager/Notification
    expect(await currentSubscription(scope)).toBeNull();
    expect(getRegistration).not.toHaveBeenCalled();
  });

  it("is null when there is no registration or no live subscription", async () => {
    const scope = {
      ...SUPPORTED_SCOPE,
      navigator: { serviceWorker: { getRegistration: vi.fn(async () => null) } },
    };
    expect(await currentSubscription(scope)).toBeNull();
  });

  it("is the live PushSubscription when one exists", async () => {
    const subscription = { endpoint: "https://push.example/abc" };
    const registration = fakeRegistration(subscription);
    const scope = {
      ...SUPPORTED_SCOPE,
      navigator: { serviceWorker: { getRegistration: vi.fn(async () => registration) } },
    };
    expect(await currentSubscription(scope)).toBe(subscription);
  });
});

describe("enableAlerts — unsupported browser", () => {
  it("throws code unsupported and never asks for permission", async () => {
    const requestPermission = vi.fn();
    await expect(
      enableAlerts({ scope: {}, requestPermission }),
    ).rejects.toMatchObject({ code: "unsupported" });
    expect(requestPermission).not.toHaveBeenCalled();
  });

  it("is an AlertsError, distinguishable by code rather than message text", async () => {
    try {
      await enableAlerts({ scope: {} });
      expect.unreachable();
    } catch (error) {
      expect(error).toBeInstanceOf(AlertsError);
      expect(error.code).toBe("unsupported");
    }
  });
});

describe("enableAlerts — permission refused", () => {
  it("throws code permission_denied and never subscribes or POSTs", async () => {
    const registration = fakeRegistration(null);
    const writePushSubscription = vi.fn();
    const readPushConfig = vi.fn();

    await expect(
      enableAlerts({
        scope: SUPPORTED_SCOPE,
        getRegistration: vi.fn(async () => registration),
        register: vi.fn(),
        requestPermission: vi.fn(async () => "denied"),
        readPushConfig,
        writePushSubscription,
      }),
    ).rejects.toMatchObject({ code: "permission_denied" });

    expect(readPushConfig).not.toHaveBeenCalled();
    expect(writePushSubscription).not.toHaveBeenCalled();
  });
});

describe("enableAlerts — permission granted, not yet subscribed", () => {
  it("subscribes and POSTs the exact PushSubscription#toJSON() shape", async () => {
    const subscriptionJson = {
      endpoint: "https://push.example/xyz",
      expirationTime: null,
      keys: { p256dh: "p256dh-value", auth: "auth-value" },
    };
    const subscribed = { toJSON: () => subscriptionJson };
    const subscribe = vi.fn(async (options) => {
      // userVisibleOnly and a decoded key are load-bearing on the real API.
      expect(options.userVisibleOnly).toBe(true);
      expect(options.applicationServerKey).toBeInstanceOf(Uint8Array);
      return subscribed;
    });
    const registration = fakeRegistration(null, { subscribe });
    const writePushSubscription = vi.fn(async () => ({ subscribed: true }));

    const result = await enableAlerts({
      scope: SUPPORTED_SCOPE,
      getRegistration: vi.fn(async () => registration),
      register: vi.fn(),
      requestPermission: vi.fn(async () => "granted"),
      readPushConfig: vi.fn(async () => ({ publicKey: "AAAA" })),
      writePushSubscription,
    });

    expect(result).toBe(subscribed);
    expect(subscribe).toHaveBeenCalledTimes(1);
    expect(writePushSubscription).toHaveBeenCalledExactlyOnceWith(subscriptionJson);
  });

  it("registers the worker only when nothing is registered yet", async () => {
    const subscribed = { toJSON: () => ({ endpoint: "e", expirationTime: null, keys: { p256dh: "a", auth: "b" } }) };
    const registration = fakeRegistration(null, { subscribe: vi.fn(async () => subscribed) });
    const register = vi.fn(async () => registration);

    await enableAlerts({
      scope: SUPPORTED_SCOPE,
      getRegistration: vi.fn(async () => null), // nothing registered yet
      register,
      requestPermission: vi.fn(async () => "granted"),
      readPushConfig: vi.fn(async () => ({ publicKey: "AAAA" })),
      writePushSubscription: vi.fn(async () => ({ subscribed: true })),
    });

    expect(register).toHaveBeenCalledTimes(1);
  });
});

describe("enableAlerts — already subscribed", () => {
  it("returns the live subscription without a permission prompt or a second POST", async () => {
    const existing = { endpoint: "https://push.example/already-on" };
    const registration = fakeRegistration(existing);
    const requestPermission = vi.fn();
    const writePushSubscription = vi.fn();

    const result = await enableAlerts({
      scope: SUPPORTED_SCOPE,
      getRegistration: vi.fn(async () => registration),
      register: vi.fn(),
      requestPermission,
      readPushConfig: vi.fn(),
      writePushSubscription,
    });

    expect(result).toBe(existing);
    expect(requestPermission).not.toHaveBeenCalled();
    expect(writePushSubscription).not.toHaveBeenCalled();
  });
});

describe("disableAlerts — unsubscribing", () => {
  it("unsubscribes first, then DELETEs carrying that endpoint", async () => {
    const order = [];
    const endpoint = "https://push.example/turning-off";
    const subscription = {
      endpoint,
      unsubscribe: vi.fn(async () => { order.push("unsubscribe"); return true; }),
    };
    const registration = fakeRegistration(subscription);
    const deletePushSubscription = vi.fn(async (sentEndpoint) => {
      order.push(`delete:${sentEndpoint}`);
      return { subscribed: false };
    });

    await disableAlerts({
      getRegistration: vi.fn(async () => registration),
      deletePushSubscription,
    });

    expect(subscription.unsubscribe).toHaveBeenCalledTimes(1);
    expect(deletePushSubscription).toHaveBeenCalledExactlyOnceWith(endpoint);
    expect(order).toEqual(["unsubscribe", `delete:${endpoint}`]);
  });

  it("is a silent no-op when this device holds no subscription", async () => {
    const registration = fakeRegistration(null);
    const deletePushSubscription = vi.fn();

    await disableAlerts({
      getRegistration: vi.fn(async () => registration),
      deletePushSubscription,
    });

    expect(deletePushSubscription).not.toHaveBeenCalled();
  });
});

describe("the service worker's push handler", () => {
  afterEach(() => {
    vi.unstubAllGlobals();
    vi.resetModules();
  });

  /** Loads service-worker.js against a fake `self`, returning its handlers. */
  async function loadServiceWorker() {
    const handlers = {};
    const showNotification = vi.fn();
    const selfStub = {
      addEventListener: (type, handler) => { handlers[type] = handler; },
      registration: { showNotification },
      clients: { matchAll: vi.fn(async () => []), openWindow: vi.fn(async () => {}) },
      location: { origin: "https://orbit.example" },
    };
    vi.stubGlobal("self", selfStub);
    await import("../../web/src/service-worker.js");
    return { handlers, showNotification, selfStub };
  }

  it("shows a fallback notification rather than throwing on a malformed payload", async () => {
    const { handlers, showNotification } = await loadServiceWorker();
    const event = {
      data: { json: () => { throw new SyntaxError("not json"); } },
      waitUntil: (promise) => promise,
    };

    await handlers.push(event);
    expect(showNotification).toHaveBeenCalledExactlyOnceWith(
      "Orbit",
      { body: "Something in your orbit needs attention.", data: { url: "/" } },
    );
  });

  it("also tolerates an entirely empty payload (no event.data at all)", async () => {
    const { handlers, showNotification } = await loadServiceWorker();
    const event = { data: null, waitUntil: (promise) => promise };

    await handlers.push(event);
    expect(showNotification).toHaveBeenCalledExactlyOnceWith(
      "Orbit",
      { body: "Something in your orbit needs attention.", data: { url: "/" } },
    );
  });
});

describe("showUrgentCount", () => {
  it("never throws when the Badging API is absent", () => {
    expect(() => showUrgentCount(3, { navigator: {} })).not.toThrow();
    expect(() => showUrgentCount(0, { navigator: {} })).not.toThrow();
  });

  it("sets the badge when the count is above zero", () => {
    const setAppBadge = vi.fn(() => Promise.resolve());
    showUrgentCount(4, { navigator: { setAppBadge } });
    expect(setAppBadge).toHaveBeenCalledExactlyOnceWith(4);
  });

  it("clears the badge when the count is zero", () => {
    const clearAppBadge = vi.fn(() => Promise.resolve());
    showUrgentCount(0, { navigator: { clearAppBadge } });
    expect(clearAppBadge).toHaveBeenCalledTimes(1);
  });
});

/*
 * Criterion 6 of #763: the signed-out surface registers no service worker and
 * asks for no permission. That is currently true by construction — the only
 * caller of alerts.js is the settings screen, which is behind a session — and
 * this is the check that notices if a later change makes it untrue. A
 * structural assertion rather than a browser one, because the thing being
 * promised is "no code path exists", which no single page visit can prove.
 */
describe("the signed-out surface", () => {
  const routes = join(fileURLToPath(new URL("../../web/src/routes/", import.meta.url)));

  /** Every .svelte and .js file under web/src/routes, recursively. */
  function screensUnder(directory) {
    return readdirSync(directory, { withFileTypes: true }).flatMap((entry) => {
      const path = join(directory, entry.name);
      if (entry.isDirectory()) return screensUnder(path);
      return /\.(?:svelte|js)$/u.test(entry.name) ? [path] : [];
    });
  }

  const screens = screensUnder(routes)
    .map((path) => [path.slice(routes.length), readFileSync(path, "utf8")]);

  it("has exactly one screen that can turn browser alerts on, and it is the helm", () => {
    const callers = screens
      .filter(([, source]) => source.includes("$lib/push/alerts.js"))
      .map(([name]) => name);

    expect(callers).toEqual(["settings/+page.svelte"]);
  });

  it("registers a service worker nowhere else, and never on the sign-in surface", () => {
    const registrars = screens
      .filter(([, source]) => source.includes("serviceWorker.register"))
      .map(([name]) => name);

    expect(registrars).toEqual([]);
    const signedOut = screens.filter(([name]) => /^(?:\+page|login|flight)/u.test(name));
    for (const [name, source] of signedOut) {
      expect(source, `${name} must not ask for notification permission`)
        .not.toMatch(/requestPermission|PushManager|setAppBadge/u);
    }
  });
});
