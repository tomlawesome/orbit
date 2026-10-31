import { mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

/*
 * #1575: the About page's library list is built with the image
 * (scripts/about-sbom.mjs writes `libraries.json` beside the SBOM) and the
 * page's server load reads that ready list. At request time it never groups
 * the SBOM and never fetches from itself.
 *
 * Seam assumed: web/src/lib/server/about-libraries.js exports
 *   readLibrariesFile(path)  reads and parses the file, returns the list, or
 *                            null when the file is absent (ENOENT);
 *   prebuiltLibraries()      memoised; reads the built client's
 *                            about/libraries.json once (path resolved by the
 *                            builder) through readLibrariesFile.
 * The page load calls prebuiltLibraries(); the ORBIT_FIXTURES=1 path is
 * unchanged. No environment variable sets the path.
 */
const mocks = vi.hoisted(() => ({ prebuilt: vi.fn(), grouped: 0 }));

vi.mock("../../web/src/lib/server/about-libraries.js", async (importOriginal) => {
  const actual = /** @type {any} */ (await importOriginal());
  return { ...actual, prebuiltLibraries: mocks.prebuilt };
});

vi.mock("../../web/src/lib/about/group.js", async (importOriginal) => {
  const actual = /** @type {any} */ (await importOriginal());
  return {
    ...actual,
    librariesOf: (/** @type {unknown} */ document) => {
      mocks.grouped += 1;
      return actual.librariesOf(document);
    },
  };
});

const READY = [
  { name: "@napi-rs/canvas", version: "1.0.9", licence: "MIT", author: "", source: "https://www.npmjs.com/package/@napi-rs/canvas" },
  { name: "zod", version: "4.6.5", licence: "MIT", author: "Colin McDonnell", source: "https://zod.dev/" },
];

function event() {
  const fetch = vi.fn(async (/** @type {unknown} */ url) => {
    throw new Error(`the About load fetched ${String(url)} at request time`);
  });
  return {
    fetch,
    url: new URL("http://localhost/about"),
    params: {},
    route: { id: "/about" },
    locals: {},
    cookies: { get: () => undefined },
    request: new Request("http://localhost/about"),
    depends: () => {},
    setHeaders: () => {},
    parent: async () => ({}),
    isDataRequest: false,
  };
}

async function visit() {
  const { load } = await import("../../web/src/routes/about/+page.server.js");
  const e = event();
  const result = await /** @type {any} */ (load)(e);
  return { result, fetch: e.fetch };
}

describe("readLibrariesFile (#1575)", () => {
  it("returns exactly the list in the file", async () => {
    const dir = mkdtempSync(path.join(tmpdir(), "orbit-about-libs-"));
    const file = path.join(dir, "libraries.json");
    writeFileSync(file, `${JSON.stringify(READY, null, 2)}\n`);
    const { readLibrariesFile } = await import("../../web/src/lib/server/about-libraries.js");

    expect(await readLibrariesFile(file)).toEqual(READY);
  });

  it("returns null when the file is absent", async () => {
    const dir = mkdtempSync(path.join(tmpdir(), "orbit-about-libs-"));
    const { readLibrariesFile } = await import("../../web/src/lib/server/about-libraries.js");

    expect(await readLibrariesFile(path.join(dir, "libraries.json"))).toBeNull();
  });
});

describe("the About page load reads the list built with the image (#1575)", () => {
  beforeEach(() => {
    vi.resetModules();
    mocks.grouped = 0;
    mocks.prebuilt.mockReset();
    vi.stubEnv("ORBIT_FIXTURES", "");
  });

  afterEach(() => {
    vi.unstubAllEnvs();
  });

  it("returns exactly the prebuilt list, with no fetch and no grouping", async () => {
    mocks.prebuilt.mockResolvedValue(READY);

    const { result, fetch } = await visit();

    expect(result).toEqual({ libraries: READY });
    expect(mocks.prebuilt).toHaveBeenCalled();
    expect(fetch).not.toHaveBeenCalled();
    expect(mocks.grouped).toBe(0);
  });

  it("answers { libraries: null } when the build carries no list, still without fetching", async () => {
    mocks.prebuilt.mockResolvedValue(null);

    const { result, fetch } = await visit();

    expect(result).toEqual({ libraries: null });
    expect(fetch).not.toHaveBeenCalled();
    expect(mocks.grouped).toBe(0);
  });

  it("serves the fixture list under ORBIT_FIXTURES=1", async () => {
    vi.stubEnv("ORBIT_FIXTURES", "1");
    mocks.prebuilt.mockResolvedValue(READY);
    const { LIBRARIES_FIXTURE } = await import("../../web/src/lib/data/fixtures/about.js");

    const { result, fetch } = await visit();

    expect(result).toEqual({ libraries: LIBRARIES_FIXTURE });
    expect(fetch).not.toHaveBeenCalled();
  });
});

describe("the page's server load no longer touches the SBOM (#1575)", () => {
  /** Code only: the comments may still say where the list comes from. */
  const code = readFileSync(path.resolve(import.meta.dirname, "../../web/src/routes/about/+page.server.js"), "utf8")
    .replace(/\/\*[\s\S]*?\*\//g, "")
    .replace(/^\s*\/\/.*$/gm, "");

  it("does not name sbom.spdx.json", () => {
    expect(code).not.toContain("sbom.spdx.json");
  });

  it("does not group at request time or fetch from itself", () => {
    expect(code).not.toMatch(/librariesOf/);
    expect(code).not.toMatch(/\bfetch\s*\(/);
  });
});
