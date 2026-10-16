import { readFileSync } from "node:fs";
import { resolve } from "node:path";

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

/*
 * #1316 W1-F1/F2: a create that half-landed (the item saved, its document did
 * not) must be retryable. The retry keeps the draft id, so the dry run the
 * forms ask on every edit answers "version_required" ("this item changed on
 * another device") -- the item is already there -- and the forms held Add on
 * that text for ever. The forms' own save already reads version_required on a
 * draft id as "the earlier send landed" and carries on, so the live check must
 * read it the same way: version_required means the entry can be saved.
 *
 * The check is whatever both forms hand their dryRunner as `check`. Its name is
 * not fixed by the specification, so this file finds it from the two forms'
 * text (as v19-create-attaches-document.test.js pins the submit handlers
 * against the file's own text) and drives that export with a stubbed fetch.
 * tests/e2e/v19-create.spec.ts proves the journey in a browser, both dialects.
 */

const read = (path) => readFileSync(resolve(__dirname, "../..", path), "utf8");
const FORMS = {
  "create.behaviour.js": read("web/src/routes/create/create.behaviour.js"),
  "pocket.svelte": read("web/src/routes/create/pocket.svelte"),
};

/** The text of the `dryRunner({ ... })` call, parentheses balanced. */
function dryRunnerCall(source) {
  const start = source.indexOf("dryRunner(");
  if (start < 0) return "";
  let depth = 0;
  for (let i = start + "dryRunner".length; i < source.length; i++) {
    if (source[i] === "(") depth++;
    else if (source[i] === ")" && --depth === 0) return source.slice(start, i + 1);
  }
  return "";
}

/** The identifier a form passes as `check`, or null when it passes none. */
function checkOf(source) {
  const call = dryRunnerCall(source);
  const match = call.match(/[\s,{]check\s*:\s*([A-Za-z_$][\w$]*)/) ?? call.match(/[\s,{](check)\s*[,}]/);
  return match ? match[1] : null;
}

/** @type {{ body: unknown }} */
let answer = { body: {} };

beforeEach(() => {
  vi.resetModules();
  vi.stubGlobal("fetch", vi.fn(async (url, init) => {
    const href = String(url);
    if (href.includes("/api/auth/session")) {
      return new Response(JSON.stringify({ user: { id: "u1" }, csrfToken: "t1" }), { status: 200 });
    }
    if (href.includes("/api/workspace/commands") && init?.method === "POST") {
      return new Response(JSON.stringify(answer.body), { status: 200 });
    }
    throw new Error(`unexpected fetch: ${href}`);
  }));
});

afterEach(() => {
  vi.unstubAllGlobals();
});

/** The shared check, found through the forms' text and the data modules' (and entry.js's) exports. */
async function sharedCheck() {
  const names = new Set(Object.values(FORMS).map(checkOf));
  const [name] = [...names];
  expect(names.size, "both forms hand their dryRunner the same check").toBe(1);
  expect(name, "the forms pass a `check` to dryRunner").toBeTruthy();
  for (const module of ["lib/data/workspace.js", "lib/data/dry-run.js", "lib/data/commands.js", "routes/create/entry.js"]) {
    const exports = await import(`../../web/src/${module}`);
    if (typeof exports[name] === "function") return exports[name];
  }
  throw new Error(`${name} is not exported by the data modules or entry.js`);
}

const command = { type: "item.upsert", householdId: "h1", item: { id: "i1", title: "Boiler cover" } };

describe("#1316 W1-F1: the create forms' live check lets a half-landed create be retried", () => {
  it("both forms hand their dryRunner a check other than the plain checkCommand", () => {
    for (const [file, source] of Object.entries(FORMS)) {
      const check = checkOf(source);
      expect(check, `${file} passes a check to dryRunner`).toBeTruthy();
      expect(check, `${file} must not use the plain checkCommand`).not.toBe("checkCommand");
    }
  });

  it("both forms hand their dryRunner the same check", () => {
    const desk = checkOf(FORMS["create.behaviour.js"]);
    expect(desk, "the desk form passes a check to dryRunner").toBeTruthy();
    expect(checkOf(FORMS["pocket.svelte"])).toBe(desk);
  });

  it("resolves null when the engine answers version_required (the item already landed)", async () => {
    answer = { body: { refusal: { code: "version_required", message: "This item changed on another device; refresh and try again" } } };
    const check = await sharedCheck();
    expect(await check(command)).toBeNull();
  });

  it("resolves the refusal's words for any other refusal", async () => {
    answer = { body: { refusal: { code: "invalid_item", message: "Give this a name" } } };
    const check = await sharedCheck();
    expect(await check(command)).toBe("Give this a name");
  });

  it("resolves null when the engine refuses nothing", async () => {
    answer = { body: {} };
    const check = await sharedCheck();
    expect(await check(command)).toBeNull();
  });
});
