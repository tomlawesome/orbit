/* SvelteKit's `$app/environment`, for tests that run outside SvelteKit.
 *
 * hooks.server.js reads `building` to skip its init hook while the adapter
 * prerenders (#735) -- see the alias in `vitest.config.ts` (#717); the
 * flight's world (web/src/lib/flight/voyage.js) reads `version`, the build,
 * to key its remembered fitness verdict (#1310). A test that needs another
 * value overrides with `vi.mock("$app/environment", () => ({ building: true }))`.
 */
export const building = false;
export const version = "test";
