// The composite container entry's routing table (#450). Path is the ONLY
// input: dispatch must never consult headers (no X-Forwarded-* trust), so the
// one-origin security properties — __Host- session cookies and
// assertSameOrigin's 403 on foreign writes — hold unchanged.
//
// `/` MOVED TO v19 (#410, §15). The owner ratified the login/logout flight
// verbatim on 2026-08-16 and ruled it is not first-run dressing: it ships as
// THE login screen for every user, every time. A login screen that is not the
// front door is not the login screen, so "/" is now the v19 sign-in — which
// hands a signed-in reader on to /home in the browser, as the v19 root always
// did. The retiring engine's workspace keeps an address of its own at
// /workspace so its acceptance suite still has something to sign in to; it is
// Next by default, like everything not listed here.
// /admin and bare /settings are live Next routes and move at the cutover.
// /settings/mail shadows nothing: Next's settings has no subroutes.

const V19_PAGES = new Set([
  "/",
  "/home",
  /* /due-next and /documents are mothballed (§14): the manifest IS the
     corridor now, and the belt (#458) is the document surface. */
  "/inbox",
  "/administration",
  "/create",
  "/login",
  "/logout",
  "/maintenance",
  "/settings/mail",
]);

const V19_PREFIXES = [
  /* One system, from inside (#410, §15). A dynamic path like /item/, and the
     door to it is the helm's memberships card — which is why bare /settings
     staying on Next is a cutover line and not a contradiction: the v19 helm
     at /settings is what links here, and both move together. */
  "/household/",
  "/item/",
  "/_app/",
  "/licenses/",
  "/screens/",
];

/* SvelteKit's client router fetches a page's server `load` over
   "<route>/__data.json" on every client-side navigation (goto(), not a full
   page load) to a route that has one — a request to the route itself, never
   a page render. Untrimmed, that suffix matches nothing below and falls
   through to the retiring engine, which 404s: the destination route was
   fine, only its own data companion request was invisible here (#456, first
   caught on /home, the one v19 route with a +page.server.js today, reached
   by the create form's post-save goto("/home")). */
const DATA_SUFFIX = "/__data.json";

export function isV19Path(pathname) {
  const routePath = pathname.endsWith(DATA_SUFFIX)
    ? pathname.slice(0, -DATA_SUFFIX.length) || "/"
    : pathname;
  const bare = routePath.length > 1 && routePath.endsWith("/")
    ? routePath.slice(0, -1)
    : routePath;
  if (V19_PAGES.has(bare)) return true;
  return V19_PREFIXES.some((prefix) => routePath.startsWith(prefix));
}
