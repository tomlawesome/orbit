import adapter from "@sveltejs/adapter-node";
import { sveltekit } from "@sveltejs/kit/vite";
import { defineConfig } from "vite";

export default defineConfig({
  plugins: [
    sveltekit({
      adapter: adapter(),
      alias: {
        /* The engine's modules import each other as `@/lib/...`, a path alias in
           the root tsconfig that means nothing here. Declaring it to SvelteKit
           rather than to Vite alone is what makes `svelte-check` resolve it too:
           without it the engine's imports fail, every type derived from them
           collapses to `unknown`, and the v19 type ledger fills with cascading
           errors that are not the front end's (#735). */
        "@": "../src",
        /* SvelteKit 3 no longer generates `$lib` (it wants `#lib` with
           extensions); declaring it keeps the existing imports working. */
        $lib: "src/lib",
      },
    }),
  ],
  server: { port: 5173 },
  ssr: {
    /* The engine is a linked workspace package of TypeScript source, not a
       built artifact (#735). Vite has to transform it rather than hand it to
       Node, in dev and in the adapter-node build alike. Its own runtime
       dependencies stay external: `pdfjs-dist` resolves worker and cmap
       assets by on-disk path and `@napi-rs/canvas` is native, so neither
       survives bundling. */
    noExternal: ["orbit"],
  },
});
