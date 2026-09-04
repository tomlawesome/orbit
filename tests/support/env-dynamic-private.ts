/* SvelteKit's `$env/dynamic/private`, for tests that run outside SvelteKit.
 *
 * The ported API routes read `env.ORBIT_FIXTURES` through this module (#735).
 * It is a SvelteKit virtual module, so it does not exist under the root Vitest
 * config that the integration suite runs in — hence the alias in
 * `vitest.config.ts` pointing here.
 *
 * The real module exposes the process environment at runtime rather than at
 * build time, which is exactly `process.env`, so that is what this returns.
 * It is a live getter rather than a snapshot because `vi.stubEnv` and the
 * fixtures both change the environment after import.
 */
export const env: NodeJS.ProcessEnv = new Proxy(
  {},
  {
    get: (_target, name: string) => process.env[name],
    has: (_target, name: string) => name in process.env,
    ownKeys: () => Reflect.ownKeys(process.env),
    getOwnPropertyDescriptor: (_target, name: string) => ({
      value: process.env[name],
      enumerable: true,
      configurable: true,
    }),
  },
) as NodeJS.ProcessEnv;
