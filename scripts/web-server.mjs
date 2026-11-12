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
// sits in a <meta> tag browsers ignore (#1411). It turns Node's request
// deadline off and holds every body to a minimum rate instead (#1390). It
// never routes, serves, reads a body or looks at a path.

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

// No whole-request deadline (#1390). Node's default requestTimeout (300 s)
// cut any request still arriving at five minutes, body included, so a
// household archive of a few GiB on a slow link could never finish. The
// archive routes and every drained body are bounded by a 30 s stall instead
// (web/src/lib/server/archive-slot.js, body-limit.js), as nginx's
// client_body_timeout does. adapter-node 6 exports the http.Server itself as
// `server`; without the property this cannot be set, so refuse to start.
if (typeof server.requestTimeout !== "number") {
  console.error("orbit web server: the adapter's server has no requestTimeout; refusing to start with Node's 300 s request deadline");
  process.exit(1);
}
server.requestTimeout = 0;

// A minimum body rate for every request (#1390), Apache mod_reqtimeout's
// MinRate: while a request's body is still arriving, the socket's byte count
// is sampled every 30 s, and a window in which under 30 KiB arrived (1 KiB/s)
// destroys the socket. With no request deadline this is the floor for every
// route, kit's own drain of a refused body included (its CSRF 403 runs before
// the hooks' 30 s stall cuts). Reading socket.bytesRead consumes nothing and
// attaches no data listener, so the shim still never reads a body.
//
// It measures the client only over time the server spends waiting for its
// bytes (#1390 second review, F1; Kestrel's MinRequestBodyDataRate): while
// the server has paused the request (the route is scanning, checking or
// encrypting rather than reading, so adapter-node stopped taking bytes off
// the socket) the clock stops. Waiting time is added up across pauses, and
// each time 30 s or more of it has gathered since the last check the client
// must have brought 1 KiB for every second of it. Listening for `pause` and
// `resume` reads no body either.
const MIN_RATE_WINDOW_MS = 30_000;
const MIN_RATE_WINDOW_BYTES = 30 * 1024;
server.prependListener("request", (request) => {
  const socket = request.socket;
  if (request.complete || !socket) return;
  let seen = socket.bytesRead;
  /** Waiting time gathered since the last check, not counting the wait now open. */
  let waitedMs = 0;
  /** When the open wait began, or null while the request is paused. */
  let waitingSince = Date.now();
  const onPause = () => {
    if (waitingSince === null) return;
    waitedMs += Date.now() - waitingSince;
    waitingSince = null;
  };
  const onResume = () => {
    if (waitingSince === null) waitingSince = Date.now();
  };
  request.on("pause", onPause);
  request.on("resume", onResume);
  const timer = setInterval(() => {
    if (request.complete || socket.destroyed) {
      stop();
      return;
    }
    const at = Date.now();
    const waited = waitedMs + (waitingSince === null ? 0 : at - waitingSince);
    if (waited < MIN_RATE_WINDOW_MS) return;
    const now = socket.bytesRead;
    if (now - seen < (waited / MIN_RATE_WINDOW_MS) * MIN_RATE_WINDOW_BYTES) {
      stop();
      socket.destroy();
      return;
    }
    seen = now;
    waitedMs = 0;
    if (waitingSince !== null) waitingSince = at;
  }, MIN_RATE_WINDOW_MS);
  timer.unref?.();
  // Cleared with the request; the keep-alive socket's own listener goes with it.
  function stop() {
    clearInterval(timer);
    request.removeListener("pause", onPause);
    request.removeListener("resume", onResume);
    socket.removeListener("close", stop);
  }
  request.once("close", stop);
  socket.once("close", stop);
});

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
