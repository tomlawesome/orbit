/*
 * SvelteKit 3 stopped shipping types for the deprecated `$env/dynamic/private`
 * module, though it still resolves to the variables declared in `src/env.js`.
 * This keeps the existing imports type-checking until they move to
 * `$app/env/private`.
 */
declare module "$env/dynamic/private" {
  export const env: Record<string, string | undefined>;
}
