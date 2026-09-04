/* Reading cookies back off a plain `Response`.
 *
 * The engine's HTTP seam returns Web-standard `Response` objects (#735), which
 * have no cookie jar — only a `set-cookie` header. These assertions used to go
 * through `NextResponse.cookies`; this is the same read against the header the
 * browser actually receives, which is the more honest check anyway.
 */

export interface SetCookie {
  value: string;
  maxAge?: number;
  attributes: string;
}

/** The last `set-cookie` for `name`, or undefined if the response sets none. */
export function readSetCookie(response: Response, name: string): SetCookie | undefined {
  /* getSetCookie keeps the individual cookies separate; a plain get() would
     join them with commas, which is ambiguous because Expires contains one. */
  const headers = typeof response.headers.getSetCookie === "function"
    ? response.headers.getSetCookie()
    : [response.headers.get("set-cookie")].filter((value): value is string => value !== null);

  const match = headers.filter((header) => header.startsWith(`${name}=`)).pop();
  if (!match) return undefined;

  const [pair, ...rest] = match.split("; ");
  const maxAge = rest.find((part) => part.toLowerCase().startsWith("max-age="));
  return {
    value: decodeURIComponent(pair.slice(name.length + 1)),
    maxAge: maxAge ? Number(maxAge.slice("max-age=".length)) : undefined,
    attributes: rest.join("; "),
  };
}
