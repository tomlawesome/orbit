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

export function isV19Path(pathname) {
  const bare = pathname.length > 1 && pathname.endsWith("/")
    ? pathname.slice(0, -1)
    : pathname;
  if (V19_PAGES.has(bare)) return true;
  return V19_PREFIXES.some((prefix) => pathname.startsWith(prefix));
}
