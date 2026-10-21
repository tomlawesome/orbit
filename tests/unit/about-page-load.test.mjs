import path from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

/*
 * The About page's library list is read once per build (#1465): the open-
 * source credits list cannot change inside a build, so the page's server
 * load works it out on first use and holds it in memory. A second visit must
 * not read or parse the file again.
 *
 * (Parse counting was tried and dropped: it passed on the unfixed code, so
 * it proved nothing; the read count is the guard.)
 *
 * The test does not know (or care) which file or which fs call the load
 * uses: every file read made through node:fs or node:fs/promises, other than
 * of source code, is counted. The first visit may read; the second must not.
 */
const reads = vi.hoisted(() => /** @type {string[]} */ ([]));

/* The SPDX document the page's list is drawn from, as a tiny stand-in, so the
   parse is exercised whatever the checkout has built. Named after the file
   the first run of this test was seen reading. */
const LIST = JSON.stringify({
  packages: [{ name: "zod", versionInfo: "4.0.0", licenseDeclared: "MIT", supplier: "Person: Colin McDonnell", homepage: "https://zod.dev/" }],
});
const isList = (/** @type {unknown} */ file) =>
  (typeof file === "string" || file instanceof URL) && path.basename(file instanceof URL ? file.pathname : file) === "sbom.spdx.json";
const standIn = (/** @type {any[]} */ args) => (typeof args[1] === "string" || args[1]?.encoding ? LIST : Buffer.from(LIST));

const wrapOf = (/** @type {any} */ target, /** @type {string} */ key) => (/** @type {any[]} */ ...args) => {
  note(args[0]);
  if (key === "readFile" && isList(args[0])) return Promise.resolve(standIn(args));
  return target[key](...args);
};

const SOURCE = /\.(m?[jt]s|svelte|node)$|node_modules/;
const note = (/** @type {unknown} */ file) => {
  if (typeof file === "string" || file instanceof URL) {
    const name = String(file instanceof URL ? file.pathname : file);
    if (!SOURCE.test(name)) reads.push(name);
  }
};

vi.mock("node:fs", async (importOriginal) => {
  const actual = /** @type {typeof import("node:fs")} */ (await importOriginal());
  const wrap = (/** @type {string} */ key) => (/** @type {any[]} */ ...args) => {
    note(args[0]);
    if (key === "readFileSync" && isList(args[0])) return standIn(args);
    return /** @type {any} */ (actual)[key](...args);
  };
  const promises = { ...actual.promises, readFile: wrapOf(actual.promises, "readFile"), open: wrapOf(actual.promises, "open") };
  return {
    ...actual,
    default: { ...actual, promises, readFileSync: wrap("readFileSync"), readFile: wrap("readFile"), createReadStream: wrap("createReadStream") },
    promises,
    readFileSync: wrap("readFileSync"),
    readFile: wrap("readFile"),
    createReadStream: wrap("createReadStream"),
  };
});

vi.mock("node:fs/promises", async (importOriginal) => {
  const actual = /** @type {typeof import("node:fs/promises")} */ (await importOriginal());
  const wrap = (/** @type {string} */ key) => (/** @type {any[]} */ ...args) => {
    note(args[0]);
    if (key === "readFile" && isList(args[0])) return Promise.resolve(standIn(args));
    return /** @type {any} */ (actual)[key](...args);
  };
  return {
    ...actual,
    default: { ...actual, readFile: wrap("readFile"), open: wrap("open") },
    readFile: wrap("readFile"),
    open: wrap("open"),
  };
});

const ABOUT = {
  build: { version: "0.3.0", channel: "preview", revision: "fd6a7e6", image: null },
  node: "v24.11.0",
  sidecars: [{ id: "postgres", state: "running", version: "18.0" }],
};

/** A SvelteKit server-load event with only what a load may use. */
function event() {
  return {
    fetch: async (/** @type {unknown} */ url) => {
      if (!String(url).includes("/api/about")) reads.push(`fetch:${String(url)}`);
      return new Response(JSON.stringify({ about: ABOUT }), { status: 200, headers: { "content-type": "application/json" } });
    },
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

/** Runs the load and waits for anything it hands back to be a promise (streamed data). */
async function visit(/** @type {(e: any) => unknown} */ load) {
  const result = await load(event());
  if (result && typeof result === "object") {
    await Promise.all(Object.values(result).filter((value) => value && typeof /** @type {any} */ (value).then === "function"));
  }
  return result;
}

describe("the About page load reads the library list once per build (#1465)", () => {
  beforeEach(() => {
    vi.resetModules();
    reads.length = 0;
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  it("does not read the library list again on a second visit", async () => {
    const { load } = await import("../../web/src/routes/about/+page.server.js");

    await visit(load);
    const afterFirst = reads.length;
    await visit(load);
    await visit(load);

    expect(
      reads.slice(afterFirst).map((file) => path.basename(file)),
      "files read again on later visits",
    ).toEqual([]);
  });
});
