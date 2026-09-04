import { sveltekit } from "@sveltejs/kit/vite";
import { defineConfig } from "vite";

export default defineConfig({
  plugins: [sveltekit()],
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
