/**
 * Browser push, front-end side (#763).
 *
 * Every browser API this module touches — Notification, ServiceWorker,
 * PushManager — arrives through an injected `deps` object with real
 * defaults, exactly like createTour and relaunchTour (tour/engine.js,
 * tour/relaunch.js). That is what lets enableAlerts/disableAlerts be driven
 * by tests/unit/push-alerts.test.js with fakes, never with a mocked global.
 *
 * `currentSubscription` is the truth for whether THIS device is on: the
 * server only knows an endpoint was once registered, not whether this
 * browser still holds it (a cleared site data, a different browser, an
 * uninstalled PWA all leave the server's record stale). Every screen that
 * wants to know "is push on here" reads through it, not through a workspace
 * field.
 */

import { readPushConfig, writePushSubscription, deletePushSubscription } from "$lib/data/workspace.js";

const SERVICE_WORKER_URL = "/service-worker.js";

/** Thrown with a `code`, not a message, so callers branch on the reason. */
export class AlertsError extends Error {
  /**
   * @param {string} message
   * @param {{ code: string }} details
   */
  constructor(message, { code }) {
    super(message);
    this.name = "AlertsError";
    this.code = code;
  }
}

/**
 * True only when this scope carries every API the sequence below needs.
 * A scope object, not a bare boolean, so tests can hand in a stub window
 * instead of monkey-patching the real one.
 *
 * @param {*} [scope]  loosely typed on purpose — tests hand in a stub window
 * @returns {boolean}
 */
export function alertsSupported(scope = globalThis) {
  return Boolean(
    scope?.navigator?.serviceWorker && scope?.PushManager && scope?.Notification,
  );
}

/**
 * The live PushSubscription for this browser, or null. Never guessed from
 * server state — this asks the browser itself, via the same two-step lookup
 * enableAlerts/disableAlerts use internally.
 *
 * @param {*} [scope]
 * @returns {Promise<?PushSubscription>}
 */
export async function currentSubscription(scope = globalThis) {
  if (!alertsSupported(scope)) return null;
  const registration = await scope.navigator.serviceWorker.getRegistration();
  if (!registration) return null;
  return (await registration.pushManager.getSubscription()) ?? null;
}

/**
 * The VAPID public key, base64url as the server hands it out, decoded into
 * the raw bytes `PushManager#subscribe` wants as `applicationServerKey`.
 * Copied from the retiring src/components/push-notification-control.tsx —
 * same padding-then-decode, without the TypeScript-only buffer rewrap.
 *
 * @param {string} value
 * @returns {Uint8Array}
 */
function applicationServerKeyOf(value) {
  const padding = "=".repeat((4 - (value.length % 4)) % 4);
  const base64 = (value + padding).replace(/-/g, "+").replace(/_/g, "/");
  const decoded = atob(base64);
  return Uint8Array.from(decoded, (character) => character.charCodeAt(0));
}

/**
 * @param {object} [deps]
 * @param {*} [deps.scope]
 * @param {() => Promise<NotificationPermission>} [deps.requestPermission]
 * @param {() => Promise<?ServiceWorkerRegistration>} [deps.getRegistration]
 * @param {() => Promise<ServiceWorkerRegistration>} [deps.register]
 * @param {typeof readPushConfig} [deps.readPushConfig]
 * @param {typeof writePushSubscription} [deps.writePushSubscription]
 * @param {typeof deletePushSubscription} [deps.deletePushSubscription]
 */
function resolvedDeps(deps = {}) {
  const scope = deps.scope ?? globalThis;
  return {
    scope,
    requestPermission: deps.requestPermission ?? (() => scope.Notification.requestPermission()),
    getRegistration: deps.getRegistration ?? (() => scope.navigator.serviceWorker.getRegistration()),
    register: deps.register ?? (() => scope.navigator.serviceWorker.register(SERVICE_WORKER_URL)),
    readPushConfig: deps.readPushConfig ?? readPushConfig,
    writePushSubscription: deps.writePushSubscription ?? writePushSubscription,
    deletePushSubscription: deps.deletePushSubscription ?? deletePushSubscription,
  };
}

/**
 * Turns browser alerts on for this device. Idempotent by design — a device
 * already subscribed returns its live subscription straight away, before
 * anything that would prompt for permission or write anything, so calling
 * this on a device that is already on is silent and safe.
 *
 * The sequence, in order: register the worker if the browser has not
 * already (this browser's own registration may still be in flight);
 * check for a live subscription; permission; the server's VAPID key;
 * `pushManager.subscribe`; hand the result to the server.
 *
 * @param {object} [deps] see resolvedDeps
 * @returns {Promise<PushSubscription>}
 */
export async function enableAlerts(deps = {}) {
  const d = resolvedDeps(deps);
  if (!alertsSupported(d.scope)) {
    throw new AlertsError("Browser push is not supported here", { code: "unsupported" });
  }

  const registration = (await d.getRegistration()) ?? (await d.register());

  const existing = await registration.pushManager.getSubscription();
  if (existing) return existing;

  const permission = await d.requestPermission();
  if (permission !== "granted") {
    throw new AlertsError("Notification permission was not granted", { code: "permission_denied" });
  }

  const config = await d.readPushConfig();
  if (!config?.publicKey) {
    throw new AlertsError("Web Push is not configured on this Orbit server", { code: "unconfigured" });
  }

  const subscription = await registration.pushManager.subscribe({
    userVisibleOnly: true,
    applicationServerKey: applicationServerKeyOf(config.publicKey),
  });
  await d.writePushSubscription(subscription.toJSON());
  return subscription;
}

/**
 * Turns browser alerts off for this device. Capture the endpoint, THEN
 * unsubscribe browser-side, THEN tell the server — in that order, so a
 * server that cannot be reached still leaves the browser unsubscribed
 * rather than claiming to be on when it no longer is. Nothing to do (no
 * live subscription) is silent, not an error: turning off what is already
 * off is a no-op, the same idempotence enableAlerts gives the other way.
 *
 * @param {object} [deps] see resolvedDeps
 * @returns {Promise<void>}
 */
export async function disableAlerts(deps = {}) {
  const d = resolvedDeps(deps);
  const registration = await d.getRegistration();
  const subscription = await registration?.pushManager.getSubscription();
  if (!subscription) return;

  const endpoint = subscription.endpoint;
  await subscription.unsubscribe();
  await d.deletePushSubscription(endpoint);
}
