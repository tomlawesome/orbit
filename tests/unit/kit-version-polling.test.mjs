import { beforeAll, describe, expect, it, vi } from "vitest";

/*
 * Audit Lows group 4, #1738 A-F1 (spec 118c): a tab left open across an
 * update must find out that the app changed, so SvelteKit's version polling
 * is switched on in web/vite.config.js (`version.pollInterval`, in
 * milliseconds; kit's default of 0 never checks). Read the same way
 * page-csp-config.test.mjs reads the config: the options handed to
 * sveltekit() are recorded.
 */

const COLD_IMPORT_TIMEOUT_MS = 60_000;

/** @type {Array<Record<string, any>>} */
const recorded = vi.hoisted(() => []);

vi.mock("../../web/node_modules/@sveltejs/kit/src/exports/vite/index.js", () => ({
  sveltekit: (/** @type {Record<string, any>} */ options) => {
    recorded.push(options);
    return [];
  },
}));

describe("kit version polling in web/vite.config.js (#1738 A-F1)", () => {
  /** @type {Record<string, any>} */
  let options;

  beforeAll(async () => {
    await import("../../web/vite.config.js");
    expect(recorded, "vite.config.js calls sveltekit() once").toHaveLength(1);
    options = recorded[0];
  }, COLD_IMPORT_TIMEOUT_MS);

  it("polls for a new version: a positive interval is configured", () => {
    expect(options.version?.pollInterval, "version.pollInterval is not set, so kit never checks").toBeGreaterThan(0);
  });
});
