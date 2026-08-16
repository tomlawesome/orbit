// The composite container entry's routing table (#450). Path is the ONLY
// input: dispatch must never consult headers (no X-Forwarded-* trust), so the
// one-origin security properties — __Host- session cookies and
// assertSameOrigin's 403 on foreign writes — hold unchanged.
//
// `/` stays on Next while the nine root e2e specs start at goto("/"); /admin
// and bare /settings are live Next routes and move to v19 at the cutover.
// /settings/mail shadows nothing: Next's settings has no subroutes.

const V19_PAGES = new Set([
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
