// Start-up shim in front of adapter-node 6 (#1565, ADR-0018 amendment).
// In the image it sits beside the adapter's output as web/server.mjs.
//
// SvelteKit 3 fixed the origin at build time and dropped ORIGIN, so kit's CSRF
// check cannot tell which origin is this install's own. The shim reads ORIGIN
// (the entrypoint derives it from APP_URL), points the adapter's PROTOCOL_HEADER
// and HOST_HEADER at two private header names, and overwrites those two headers
// from ORIGIN on every request. It never routes, serves, reads a body or looks
// at a path.

const PROTOCOL_HEADER = "x-orbit-forwarded-proto";
const HOST_HEADER = "x-orbit-forwarded-host";
// scheme://host[:port], IPv6 in brackets, no path, query or fragment.
const PLAIN_ORIGIN = /^(https?):\/\/(\[[0-9A-Fa-f:.]+\]|[A-Za-z0-9._-]+)(?::[0-9]{1,5})?$/u;

const origin = process.env.ORIGIN;
const match = origin === undefined ? null : PLAIN_ORIGIN.exec(origin);
let scheme;
let authority;

if (match) {
  scheme = match[1].toLowerCase();
  authority = origin.slice(match[1].length + 3);
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

if (match) {
  server.prependListener("request", (request) => {
    request.headers[PROTOCOL_HEADER] = scheme;
    request.headers[HOST_HEADER] = authority;
  });
}
