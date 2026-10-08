/* SvelteKit's `$app/navigation`, for tests that run outside SvelteKit.
 *
 * home.behaviour.js imports `goto` to hand the quick add's document to the
 * create form (#1243), so every unit test that mounts home needs it to
 * resolve -- see the alias in `vitest.config.ts`. No unit test navigates; a
 * test that must see the call overrides with
 * `vi.mock("$app/navigation", () => ({ goto: vi.fn() }))`.
 */
export async function goto(_url: string): Promise<void> {}
