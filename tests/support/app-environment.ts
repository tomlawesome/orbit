/* SvelteKit's `$app/environment`, for tests that run outside SvelteKit.
 *
 * hooks.server.js reads `building` to skip its init hook while the adapter
 * prerenders (#735) -- see the alias in `vitest.config.ts` (#717). Only
 * `building` is stubbed because it is the only export hooks.server.js reads;
 * a test that needs it `true` overrides with
 * `vi.mock("$app/environment", () => ({ building: true }))`.
 */
export const building = false;
