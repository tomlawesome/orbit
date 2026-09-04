import adapter from "@sveltejs/adapter-node";

/** @type {import('@sveltejs/kit').Config} */
export default {
  kit: {
    adapter: adapter(),
    alias: {
      /* The engine's modules import each other as `@/lib/...`, a path alias in
         the root tsconfig that means nothing here. Declaring it to SvelteKit
         rather than to Vite alone is what makes `svelte-check` resolve it too:
         without it the engine's imports fail, every type derived from them
         collapses to `unknown`, and the v19 type ledger fills with cascading
         errors that are not the front end's (#735). */
      "@": "../src",
    },
  },
};
