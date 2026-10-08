import { readFileSync } from "node:fs";
import { resolve } from "node:path";

import { describe, expect, it } from "vitest";

/*
 * #1151 W1-R2/W1-R3: both create forms used to mint a new item id inside the
 * submit handler, so a retry after a dropped response (the request actually
 * landed, but the browser never saw the answer) sent a second, different id
 * and created a duplicate item. The fix mints the id once for the draft —
 * module scope in the desktop form (`mountCreate()` runs once per page), and
 * component-top scope in the pocket form — and reuses it on every attempt,
 * so the server's own upsert-by-id idempotency
 * (`workspace-repository.ts`'s `item.upsert`: an existing row is updated,
 * not duplicated) absorbs the retry.
 *
 * Neither file has an import surface a plain submit-flow test can drive
 * without a browser, so — the way `v19-flight-mark-ride.test.mjs` pins a
 * `.svelte` fix — this pins the id's scope against the files' own text: it
 * fails if `crypto.randomUUID()` ever moves back inside the save/submit
 * function.
 */

const root = resolve(import.meta.dirname, "../..");
const read = (p) => readFileSync(resolve(root, p), "utf8");

describe("#1151 W1-R2: the desktop create form mints one id per draft", () => {
  const behaviour = read("web/src/routes/create/create.behaviour.js");

  it("mints the id once, outside the submit handler", () => {
    const submitHandler = behaviour.slice(behaviour.indexOf('on(card, "submit"'));
    expect(submitHandler).not.toMatch(/crypto\.randomUUID/u);
    /* The command the save sends (and the dry run asks about, #1325) is
       built in one place, under the draft's own id. */
    expect(submitHandler).toMatch(/applyCommand\(commandFromForm\(\)\)/u);
    const commandFn = behaviour.slice(behaviour.indexOf("function commandFromForm()"), behaviour.indexOf("function commandFromForm()") + 250);
    expect(commandFn).toMatch(/id: draftId,/u);
    expect(behaviour.indexOf("const draftId = crypto.randomUUID();"))
      .toBeLessThan(behaviour.indexOf('on(card, "submit"'));
  });
});

describe("#1151 W1-R3: the pocket create form mints one id per draft", () => {
  const pocket = read("web/src/routes/create/pocket.svelte");

  it("mints the id once, outside the save function", () => {
    const saveFn = pocket.slice(pocket.indexOf("async function save()"), pocket.indexOf("/* ---- leaving"));
    expect(saveFn).not.toMatch(/crypto\.randomUUID/u);
    expect(saveFn).toMatch(/id: draftId/u);
    expect(pocket.indexOf("const draftId = crypto.randomUUID();"))
      .toBeLessThan(pocket.indexOf("async function save()"));
  });
});
