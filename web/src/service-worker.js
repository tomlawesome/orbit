/**
 * Orbit's service worker (#763), built by SvelteKit and served at
 * /service-worker.js.
 *
 * Deliberately no `fetch` handler and no caching of any kind — that is the
 * security position, not an oversight. Every response Orbit serves is
 * same-origin and cookie-scoped to the signed-in reader; a worker that never
 * intercepts a request can never hand a cached, authenticated response to
 * the wrong reader or to a reader who has since signed out. PWA
 * installability comes from manifest.webmanifest alone and needs nothing
 * here to support it.
 *
 * The two handlers below are the whole of this worker's job: show a push
 * notification, and take a click on one to the right place.
 */

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
 */
self.addEventListener("notificationclick", (event) => {
  event.notification.close();
  const target = new URL(event.notification.data?.url || "/", self.location.origin).href;
  event.waitUntil(
    self.clients.matchAll({ type: "window", includeUncontrolled: true }).then((clientList) => {
      const existing = clientList.find((client) => client.url === target);
      return existing ? existing.focus() : self.clients.openWindow(target);
    }),
  );
});
