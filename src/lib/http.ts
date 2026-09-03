/* The engine's HTTP seam, expressed so it names no framework.
 *
 * Everything the engine needs from a request is a cookie jar or a set of
 * headers, so those are what it asks for. `CookieSink` is deliberately
 * structural rather than a class: SvelteKit's `event.cookies` satisfies it as
 * it stands, so a route handler passes `event.cookies` straight through with
 * no adapter object in between, and a test passes a plain literal. Nothing
 * here imports from `@sveltejs/kit`, which is what keeps the engine linkable
 * by the CLI and the operator tooling (ADR-0015 decision 1).
 */

/** Reads request cookies by name; `undefined` when absent. */
export interface CookieReader {
  get(name: string): string | undefined;
}

/** Reads request cookies and writes response ones. */
export interface CookieSink extends CookieReader {
  set(
    name: string,
    value: string,
    options: {
      /* Required, not optional: SvelteKit rejects a cookie without an explicit
         path, and the transaction cookie's narrow scope is load-bearing. */
      path: string;
      httpOnly?: boolean;
      secure?: boolean;
      sameSite?: "lax" | "strict" | "none";
      maxAge?: number;
      priority?: "low" | "medium" | "high";
    },
  ): void;
}
