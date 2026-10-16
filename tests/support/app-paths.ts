/* SvelteKit's `$app/paths`, for tests that run outside SvelteKit.
 *
 * Imported beside `$app/navigation` by home.behaviour.js (#1243). The app is
 * served from the root, so `resolve` returns the route unchanged.
 */
export function resolve(route: string): string {
  return route;
}
