// Start-up shim in front of adapter-node 6 (#1565, ADR-0018 amendment).
// In the image it sits beside the adapter's output as web/server.mjs.
//
// SvelteKit 3 fixed the origin at build time and dropped ORIGIN, so kit's CSRF
// check cannot tell which origin is this install's own. The shim reads ORIGIN
// (the entrypoint derives it from APP_URL), points the adapter's PROTOCOL_HEADER
// and HOST_HEADER at two private header names, and overwrites those two headers
// from ORIGIN on every request. It also sets one constant response header,
// X-Frame-Options: DENY, on every response: the adapter serves the prerendered
// pages (/login, /logout, /auth/error) ahead of kit, so their frame-ancestors
// sits in a <meta> tag browsers ignore (#1411). It never routes, serves, reads
// a body or looks at a path.

const PROTOCOL_HEADER = "x-orbit-forwarded-proto";
const HOST_HEADER = "x-orbit-forwarded-host";
// An http(s) origin and nothing else: no credentials, path, query or
// fragment. It is read with the URL parser, and the parser's own host is what
// gets injected, because the browser's Origin and kit's own origin both come
// from that same normalisation: `:08443` is `:8443`, a default port is
// dropped, the scheme and host are lower case (#1565 review, note 48989).
function plainOrigin(value) {
  if (value === undefined) return null;
  let url;
  try {
    url = new URL(value);
  } catch {
    return null;
  }
  if (url.protocol !== "http:" && url.protocol !== "https:") return null;
  if (url.username || url.password || url.search || url.hash) return null;
  if (url.pathname !== "/" && url.pathname !== "") return null;
  if (value.includes("?") || value.includes("#")) return null;
  if (url.port === "0") return null;
  return { scheme: url.protocol.slice(0, -1), authority: url.host };
}

const origin = process.env.ORIGIN;
const match = plainOrigin(origin);
let scheme;
let authority;

if (match) {
  ({ scheme, authority } = match);
  process.env.PROTOCOL_HEADER = PROTOCOL_HEADER;
  process.env.HOST_HEADER = HOST_HEADER;
} else {
  console.warn(
    `orbit web server: ORIGIN is ${origin ? `not a plain http(s) origin (${JSON.stringify(origin)})` : "unset"}; ` +
      "the origin headers are not set and the adapter uses its own defaults",
  );
}

const { server } = await import("./index.js");
if (!server || typeof server.prependListener !== "function") {
  console.error("orbit web server: the adapter's index.js exports no `server`; refusing to start without the origin headers");
  process.exit(1);
}

// Whatever ORIGIN says: framing is refused even when the origin headers are not set.
server.prependListener("request", (_request, response) => {
  response.setHeader("X-Frame-Options", "DENY");
});

if (match) {
  server.prependListener("request", (request) => {
    request.headers[PROTOCOL_HEADER] = scheme;
    request.headers[HOST_HEADER] = authority;
  });
}
