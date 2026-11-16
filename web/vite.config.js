import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import adapter from "@sveltejs/adapter-node";
import { sveltekit } from "@sveltejs/kit/vite";
import { defineConfig } from "vite";

/* The sha256 source of src/app.html's pre-paint script, computed from the file
   itself so an edit to the script can never leave a stale hash behind. The
   hash covers both page kinds: kit refuses to prerender a template holding
   %sveltekit.nonce%, so the script carries no nonce and the header's and the
   meta tag's script-src both allow it by hash. app.html must hold exactly one
   inline script, and the hash is of the exact text between its tags. Kit adds
   the quotes. */
/** @returns {`sha256-${string}`} */
function prePaintScriptHash() {
  const html = readFileSync(fileURLToPath(new URL("./src/app.html", import.meta.url)), "utf8");
  const scripts = [...html.matchAll(/<script\b([^>]*)>([\s\S]*?)<\/script>/gu)].filter(
    (match) => !/\bsrc\s*=/u.test(match[1]),
  );
  if (scripts.length !== 1) {
    throw new Error(`web/src/app.html must hold exactly one inline script, found ${scripts.length} (#1411)`);
  }
  return /** @type {`sha256-${string}`} */ (`sha256-${createHash("sha256").update(scripts[0][2], "utf8").digest("base64")}`);
}

/* The pages' Content-Security-Policy (#1411, owner answer 5a): kit's own
   `csp`, the OWASP CSP Cheat Sheet's strict policy. Styles keep
   'unsafe-inline' (style= attributes and markup built in JS); scripts get
   neither 'unsafe-inline' nor 'unsafe-eval'. Kit applies it to pages only, so
   the `default-src 'none'; sandbox` on previews and downloads is untouched.
   The door (orbit-site assets/door/README.md) needs img data: blob:, connect
   and script self, no eval; this covers it. */
/** @type {import("@sveltejs/kit/vite").Config["csp"]} */
const csp = {
  mode: "auto",
  directives: {
    "default-src": ["self"],
    "script-src": ["self", prePaintScriptHash()],
    "style-src": ["self", "unsafe-inline"],
    "img-src": ["self", "data:", "blob:"],
    "font-src": ["self", "data:"],
    "connect-src": ["self"],
    "worker-src": ["self"],
    "manifest-src": ["self"],
    "frame-src": ["none"],
    "object-src": ["none"],
    "base-uri": ["self"],
    "form-action": ["self"],
    "frame-ancestors": ["none"],
  },
};

export default defineConfig({
  plugins: [
    sveltekit({
      adapter: adapter(),
      csp,
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
       dependencies stay external: `@napi-rs/canvas` is native and does not
       survive bundling. */
    noExternal: ["orbit"],
  },
});
