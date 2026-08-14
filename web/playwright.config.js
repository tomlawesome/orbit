import { defineConfig } from "@playwright/test";

/**
 * The visual gate. Deliberately separate from the repo-root Playwright config,
 * which drives the Next application's behavioural suite.
 */
export default defineConfig({
  testDir: "./tests/fidelity",
  fullyParallel: false,
  workers: 1,
  reporter: [["list"]],
  use: {
    /*
     * 1600x1000 is the design's own SVG viewBox, so the artwork is judged at
     * its authored aspect ratio and nothing is being seen through a scale.
     */
    viewport: { width: 1600, height: 1000 },
    deviceScaleFactor: 1,
    /* Motion is the design's, not the machine's — see capture() in screens.spec.js. */
    reducedMotion: "no-preference",
  },
  webServer: [
    {
      /*
       * The adapter-node output, not `vite preview` — the gate should judge
       * what actually ships, including its server rendering. Rebuilt each run
       * so a stale build can never pass for a current one.
       */
      command: "pnpm build && node build/index.js",
      env: { PORT: "4173" },
      url: "http://127.0.0.1:4173/login",
      timeout: 120_000,
      reuseExistingServer: !process.env.CI,
      stdout: "ignore",
    },
    {
      /* Serves the ratified mockups so a screen being ported can be compared
         against its design before it earns a baseline. */
      command: "node tests/fidelity/serve.mjs 5174",
      url: "http://127.0.0.1:5174/design/family/family.css",
      reuseExistingServer: !process.env.CI,
      stdout: "ignore",
    },
  ],
});
