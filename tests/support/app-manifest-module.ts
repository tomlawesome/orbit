// Stand-in for SvelteKit's virtual `$app/manifest` module, which only exists
// inside the SvelteKit build. Tests that import web/src/service-worker.js
// resolve it here; tests that care about the lists mock it themselves.
export const immutable: { path: string }[] = [];
export const assets: { path: string }[] = [];
export const prerendered: { path: string }[] = [];
