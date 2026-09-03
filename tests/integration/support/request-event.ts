/* The minimal SvelteKit `RequestEvent` the integration suite needs (#735).
 *
 * The ruling on #735 keeps `tests/integration/` where it is and replaces the
 * `NextRequest` construction with this. The suites call the real ported route
 * modules under `web/src/routes/api/`, so what they need is the event those
 * handlers read — and they read very little of it: `request`, `params`,
 * `cookies` and `url`, and nothing else. Building only those four is
 * deliberate: a fuller fake would invite a test to lean on a property no
 * route actually uses, and then agree with itself.
 *
 * The cookie jar is the part that has to be right. SvelteKit hands the handler
 * one jar for both directions — reads come off the request, writes are
 * collected and attached to the response by the framework, not by the handler
 * — so `callRoute` does that attaching here. Without it a route could set a
 * session cookie and every assertion about it would pass vacuously against a
 * response that never carried one. `readSetCookie` in `./set-cookie` then
 * reads it back off the header a browser would actually receive.
 */
import type { CookieSink } from "@/lib/http";
import { sessionHeaders, type IntegrationSession } from "./fixtures";

type CookieOptions = Parameters<CookieSink["set"]>[2];

/** Exactly what the ported routes touch. Nothing else is provided. */
export interface MinimalRequestEvent {
  request: Request;
  cookies: CookieSink;
  params: Record<string, string>;
  url: URL;
}

/**
 * A route handler as the suite calls it.
 *
 * The route modules are JavaScript typed by JSDoc against SvelteKit's own
 * `RequestEvent`, and the root tsconfig is `allowJs: false`, so they are
 * reached through `loadRoute` below rather than imported directly. That makes
 * this the typed side of a deliberately untyped door.
 */
export type RouteHandler = (event: MinimalRequestEvent) => Promise<Response> | Response;

export interface RouteCall {
  /** Absolute URL; the routes read `event.url` for query parameters. */
  url: string;
  /** Route parameters SvelteKit would have parsed out of the path. */
  params?: Record<string, string>;
  method?: string;
  headers?: Record<string, string>;
  body?: BodyInit | null;
}

/* SvelteKit spells its attributes this way, and assertions read them back out
   of the header as text, so the casing is part of the contract. */
function serializeCookie(name: string, value: string, options: CookieOptions): string {
  const parts = [`${name}=${encodeURIComponent(value)}`];
  if (options.maxAge !== undefined) parts.push(`Max-Age=${options.maxAge}`);
  parts.push(`Path=${options.path}`);
  if (options.httpOnly) parts.push("HttpOnly");
  if (options.secure) parts.push("Secure");
  if (options.sameSite) {
    parts.push(`SameSite=${options.sameSite.charAt(0).toUpperCase()}${options.sameSite.slice(1)}`);
  }
  if (options.priority) {
    parts.push(`Priority=${options.priority.charAt(0).toUpperCase()}${options.priority.slice(1)}`);
  }
  return parts.join("; ");
}

function parseCookieHeader(header: string | null): Map<string, string> {
  const jar = new Map<string, string>();
  if (!header) return jar;
  for (const pair of header.split(";")) {
    const index = pair.indexOf("=");
    if (index < 0) continue;
    jar.set(pair.slice(0, index).trim(), decodeURIComponent(pair.slice(index + 1).trim()));
  }
  return jar;
}

interface CookieJar {
  cookies: CookieSink;
  /** Attaches what the handler set, as SvelteKit does before responding. */
  applyTo(response: Response): Response;
}

function createCookieJar(header: string | null): CookieJar {
  const incoming = parseCookieHeader(header);
  const written: string[] = [];

  const cookies: CookieSink = {
    get: (name) => incoming.get(name),
    set: (name, value, options) => {
      /* SvelteKit's jar reads back what this request already set, so a route
         that sets a cookie and then reads it sees the new value. */
      incoming.set(name, value);
      written.push(serializeCookie(name, value, options));
    },
  };

  return {
    cookies,
    applyTo(response) {
      if (written.length === 0) return response;
      /* A new Response, because a returned one may have immutable headers. */
      const headers = new Headers(response.headers);
      for (const cookie of written) headers.append("set-cookie", cookie);
      return new Response(response.body, {
        status: response.status,
        statusText: response.statusText,
        headers,
      });
    },
  };
}

/** Builds the event without invoking anything, for the rare direct assertion. */
export function createRequestEvent(call: RouteCall): { event: MinimalRequestEvent; applyTo: (response: Response) => Response } {
  const request = new Request(call.url, {
    method: call.method ?? "GET",
    headers: call.headers,
    body: call.body ?? null,
  });
  const jar = createCookieJar(request.headers.get("cookie"));
  return {
    event: { request, cookies: jar.cookies, params: call.params ?? {}, url: new URL(call.url) },
    applyTo: jar.applyTo,
  };
}

/** Invokes a route handler and returns the response a browser would get. */
export async function callRoute(handler: RouteHandler, call: RouteCall): Promise<Response> {
  const { event, applyTo } = createRequestEvent(call);
  return applyTo(await handler(event));
}

/** `callRoute` with a fixture session's cookie and CSRF headers applied. */
export async function callRouteForSession(
  handler: RouteHandler,
  session: IntegrationSession,
  call: RouteCall,
): Promise<Response> {
  return callRoute(handler, { ...call, headers: sessionHeaders(session, call.headers) });
}

/**
 * Loads a ported route family's handlers by its `/api/...` path.
 *
 * The specifier is computed rather than literal on purpose: that is what keeps
 * `tsc` out of `web/`'s JavaScript, which the ruling on #735 requires — the
 * engine's strict config and the front end's JSDoc `checkJs` config cannot be
 * merged, so the boundary is crossed once, here, instead of in 18 suites.
 */
export async function loadRoute(family: string): Promise<Record<string, RouteHandler>> {
  const specifier = new URL(
    `../../../web/src/routes/api/${family}/+server.js`,
    import.meta.url,
  ).href;
  return (await import(/* @vite-ignore */ specifier)) as Record<string, RouteHandler>;
}
