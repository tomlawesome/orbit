// Stand-in for SvelteKit's virtual `$service-worker` module, which only exists
// inside the SvelteKit build. Tests that import web/src/service-worker.js
// resolve it here; tests that care about the lists mock it themselves.
export const build: string[] = [];
export const files: string[] = [];
export const prerendered: string[] = [];
export const base = "";
export const version = "test";
