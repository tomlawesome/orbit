/**
 * Orbit's service worker (#763, #1329), built by SvelteKit and served at
 * /service-worker.js.
 *
 * It does four things: keep Orbit's own app shell so the installed app
 * opens as Orbit, show Orbit's own offline page when there is no network,
 * show push notifications, and take a click on one to the right place.
 *
 * The app shell is what SvelteKit lists for it: `build` (the compiled JS and
 * CSS) and `files` (everything in static/: icons, fonts, the manifest). That
 * is code and pictures, the same for every reader. Nothing a member owns is
 * ever stored here (ADR-0006): no `/api/` response, no document, no page, no
 * upload. Every response Orbit serves is cookie-scoped to the signed-in
 * reader, so a worker that cached one could hand it to the wrong reader or
 * to a reader who has since signed out. Only the exact shell URLs are ever
 * answered from the cache; every other request goes straight to the network.
 *
 * Offline page: `/offline.html` is a static page with no household data, kept
 * with the shell. A navigation goes to the network and its response is
 * returned untouched and never stored; only if the network fetch rejects
 * (no connection) is the cached offline page shown in its place.
 *
 * Updates: a new version installs in the background beside the old one and
 * takes over on the next launch. There is deliberately no skip-waiting and no
 * clients claim, so an open window never runs a mix of old and new code.
 */
import { build, files, version } from "$service-worker";

const CACHE_PREFIX = "orbit-shell-";
const CACHE = `${CACHE_PREFIX}${version}`;
const OFFLINE_PAGE = new URL("/offline.html", self.location.origin).href;

/** Absolute URLs of the shell assets, so a request can be matched exactly. */
const SHELL = new Set([...build, ...files].map((path) => new URL(path, self.location.origin).href));

self.addEventListener("install", (event) => {
  event.waitUntil(caches.open(CACHE).then((cache) => cache.addAll([...build, ...files])));
});

/** Drop the shell caches of other versions. */
self.addEventListener("activate", (event) => {
  event.waitUntil(
    caches
      .keys()
      .then((names) =>
        Promise.all(
          names.filter((name) => name.startsWith(CACHE_PREFIX) && name !== CACHE).map((name) => caches.delete(name)),
        ),
      ),
  );
});

/**
 * A navigation: the network's answer untouched, or, only when the fetch
 * rejects, the precached offline page. Nothing is stored here.
 */
function navigate(request) {
  return fetch(request).catch(async () => {
    const cache = await caches.open(CACHE);
    return (await cache.match(OFFLINE_PAGE)) || Response.error();
  });
}

/**
 * Serve a precached shell asset cache-first, and a navigation from the
 * network with the offline page as its only fallback. Anything else --
 * non-GET, cross-origin, `/api/`, documents -- is not answered here.
 */
self.addEventListener("fetch", (event) => {
  const { request } = event;
  if (request.method !== "GET") return;
  if (request.mode === "navigate") {
    event.respondWith(navigate(request));
    return;
  }
  const url = new URL(request.url);
  if (url.origin !== self.location.origin) return;
  const key = url.origin + url.pathname;
  if (!SHELL.has(key)) return;
  event.respondWith(
    caches
      .open(CACHE)
      .then((cache) => cache.match(key))
      .then((hit) => hit || fetch(request)),
  );
});

/**
 * A push message arrived. Delivery is best-effort and the payload crosses a
 * network the push service controls, not Orbit, so a malformed or empty
 * payload must still show something rather than throw and drop the event.
 * The server's shape is `{ title, body, url }`
 * (src/server/notification-worker.ts).
 */
self.addEventListener("push", (event) => {
  let payload = {};
  try {
    payload = event.data ? event.data.json() : {};
  } catch {
    payload = {};
  }
  const title = payload.title || "Orbit";
  const body = payload.body || "Something in your orbit needs attention.";
  const url = payload.url || "/";
  event.waitUntil(self.registration.showNotification(title, { body, data: { url } }));
});

/**
 * A reader tapped the notification. Reuse an Orbit tab already open on that
 * address rather than piling up duplicates; open a new one only when none
 * exists.
 *
 * #1151 W2-R7: the matching tab found by `matchAll()` can still close in the
 * window before `.focus()` runs on it -- a real race, not a hypothetical
 * one, since both happen across task boundaries this worker does not
 * control. `.focus()` on a client that is already gone rejects, and with no
 * `.catch()` that sank the whole `waitUntil` promise: the tap was simply
 * dropped, no window opened at all. Falling back to `openWindow` on that
 * rejection is the same answer `matchAll` finding nothing already gives.
 */
self.addEventListener("notificationclick", (event) => {
  event.notification.close();
  const target = new URL(event.notification.data?.url || "/", self.location.origin).href;
  event.waitUntil(
    self.clients.matchAll({ type: "window", includeUncontrolled: true }).then((clientList) => {
      const existing = clientList.find((client) => client.url === target);
      if (!existing) return self.clients.openWindow(target);
      return existing.focus().catch(() => self.clients.openWindow(target));
    }),
  );
});
