import { building } from "$app/environment";

/**
 * Orbit's boot sequence, moved off Next's instrumentation hook (#735).
 *
 * `registerNode` validates startup configuration, reports authentication and
 * scanner readiness, runs migrate-on-boot and starts the five workers — in
 * that strict order, because each step's failure has to fail closed before the
 * next one is reachable. `src/server/boot.test.ts` holds that ordering.
 *
 * SvelteKit calls `init` once per server process before the first request, so
 * the engine and the HTTP surface now come up in one process at one instant.
 * Nothing about the sequence changed; only what calls it.
 *
 * The `building` guard matters because `init` also runs while the adapter
 * prerenders: a build machine has no database and no reason to start a worker,
 * so booting there would either fail the build or, worse, migrate whatever
 * database happened to be configured at build time.
 *
 * @type {import("@sveltejs/kit").ServerInit}
 */
export async function init() {
  if (building) return;

  const { registerNode } = await import("orbit/server/boot");
  await registerNode();
}
