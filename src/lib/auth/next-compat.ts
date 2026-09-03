/* INTERIM. Deleted with `src/app/` in the final commit of #735.
 *
 * The engine's HTTP seam now speaks `CookieReader`/`CookieSink` and `Headers`
 * (see `@/lib/http`), which is what SvelteKit's `event.cookies` already is.
 * Next's request and response cookie jars have a different shape — reads
 * answer `{ value }` rather than a string, and writes live on the response
 * rather than on one jar — so these two adapters carry the surviving Next
 * routes until they are deleted.
 *
 * Nothing new should import this. If a SvelteKit route needs an adapter,
 * something is wrong: `event.cookies` satisfies both interfaces as it stands.
 */
import type { NextRequest, NextResponse } from "next/server";
import type { CookieReader, CookieSink } from "@/lib/http";

/** A Next request's cookies, read as the engine expects them. */
export function nextCookies(request: NextRequest): CookieReader {
  return { get: (name) => request.cookies.get(name)?.value };
}

/** Reads from the request, writes to the response — one jar, as SvelteKit has. */
export function nextCookieSink(request: NextRequest, response: NextResponse): CookieSink {
  return {
    get: (name) => request.cookies.get(name)?.value,
    set: (name, value, options) => {
      response.cookies.set(name, value, options);
    },
  };
}
