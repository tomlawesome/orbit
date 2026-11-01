import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { pathToFileURL } from "node:url";

import { describe, expect, it, vi } from "vitest";

/*
 * #1316 W1-R2: both home screens (the desk's `onattach` in +page.svelte and
 * the phone's `attachTo` in pocket.svelte) minted the document id inline,
 * `attachItemDocument(..., crypto.randomUUID())`, on every attempt. A retry
 * after a dropped answer (the upload landed, the browser never saw it) sent
 * the same bytes under a second id, and the documents route stored a second
 * copy. The create forms already mint one id per picked file (#1245); the
 * drawer needs the same, as a plain helper both screens share:
 * `attachIdFor(itemId, file)` in web/src/routes/home/attach-id.js.
 *
 * The same item and an equal file (same name, size and lastModified, even as
 * a new File object, because a retry may re-pick) give the same id; another
 * item or another file gives another; the first call gives a fresh random
 * UUID. The two screens cannot be driven without a browser, so their wiring
 * is pinned against the files' own text, as v19-create-draft-id does.
 */

const root = resolve(import.meta.dirname, "../..");
const read = (p) => readFileSync(resolve(root, p), "utf8");
const HELPER = pathToFileURL(resolve(root, "web/src/routes/home/attach-id.js")).href;
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/u;

const load = async () => {
  const mod = await import(/* @vite-ignore */ HELPER);
  expect(typeof mod.attachIdFor).toBe("function");
  return mod.attachIdFor;
};
/* The shared acts, driven for real with the workspace calls and the wake
   stood in (runes as plain values). */
const ws = vi.hoisted(() => ({
  applyCommand: vi.fn(), attachItemDocument: vi.fn(), askCommand: vi.fn(), checkCommand: vi.fn(), dueDateIn: vi.fn(),
  readItemDocuments: vi.fn(), readReminders: vi.fn(), removeDocument: vi.fn(), restoreDocument: vi.fn(),
  wordsOf: (e, fallback = "failed") => (e instanceof Error ? e.message : fallback),
}));
vi.hoisted(() => {
  const state = Object.assign((v) => v, { raw: (v) => v, snapshot: (v) => v });
  Object.assign(globalThis, { $state: state, $effect: () => {}, $derived: (v) => v });
});
vi.mock("$lib/data/workspace.js", () => ws);
vi.mock("$lib/pocket/wake.js", () => ({ wake: vi.fn() }));
const { attachIdFor: attachIdOf } = await import("../../web/src/routes/home/attach-id.js");
const driveAttach = async ({ reread }) => {
  ws.attachItemDocument.mockReset();
  ws.attachItemDocument.mockResolvedValue({});
  const drawer = await import("../../web/src/routes/home/drawer-acts.svelte.js");
  const acts = drawer.createDrawerActs({
    view: () => null, reread, say: () => {}, focus: () => {}, open: () => "open",
    itemOf: (id) => ({ id, householdId: "h1", title: "Boiler", status: "active", kind: "task", version: 1, currency: "GBP" }),
    amend: () => null, leave: () => {}, wakeFirst: false,
  });
  return { acts, sent: () => ws.attachItemDocument.mock.calls.map((c) => c[3]) };
};

const file = (name = "bill.pdf", body = "abc", lastModified = 1_700_000_000_000) =>
  new File([body], name, { type: "application/pdf", lastModified });

describe("#1316 W1-R2: the drawer's attach id is stable per item and file", () => {
  it("gives a fresh random UUID the first time", async () => {
    const attachIdFor = await load();
    const a = attachIdFor("item-first-a", file("first.pdf"));
    const b = attachIdFor("item-first-b", file("first.pdf"));
    expect(a).toMatch(UUID);
    expect(b).toMatch(UUID);
    expect(a).not.toBe(b);
  });

  it("gives the same id for the same File object again", async () => {
    const attachIdFor = await load();
    const f = file("again.pdf");
    expect(attachIdFor("item-1", f)).toBe(attachIdFor("item-1", f));
  });

  it("gives the same id for two File objects with equal name, size and lastModified on the same item", async () => {
    const attachIdFor = await load();
    const first = attachIdFor("item-2", file("same.pdf", "abc", 1_700_000_000_000));
    const again = attachIdFor("item-2", file("same.pdf", "xyz", 1_700_000_000_000));
    expect(again).toBe(first);
  });

  it("gives a different id for a different item", async () => {
    const attachIdFor = await load();
    expect(attachIdFor("item-3a", file("one.pdf"))).not.toBe(attachIdFor("item-3b", file("one.pdf")));
  });

  it("gives a different id when the name, size or lastModified differs", async () => {
    const attachIdFor = await load();
    const base = attachIdFor("item-4", file("base.pdf", "abc", 1_700_000_000_000));
    expect(attachIdFor("item-4", file("other.pdf", "abc", 1_700_000_000_000))).not.toBe(base);
    expect(attachIdFor("item-4", file("base.pdf", "abcd", 1_700_000_000_000))).not.toBe(base);
    expect(attachIdFor("item-4", file("base.pdf", "abc", 1_700_000_999_000))).not.toBe(base);
  });
});

describe("#1316 W1-R2: the drawer's attach id is dropped once the attach is acknowledged", () => {
  const loadBoth = async () => {
    const mod = await import(/* @vite-ignore */ HELPER);
    expect(typeof mod.attachIdFor).toBe("function");
    expect(typeof mod.forget).toBe("function");
    return mod;
  };

  it("keeps giving the same id until forget is called (retry after a failed attach reuses it)", async () => {
    const { attachIdFor } = await loadBoth();
    const f = file("retry.pdf");
    const first = attachIdFor("item-5", f);
    expect(attachIdFor("item-5", f)).toBe(first);
    expect(attachIdFor("item-5", f)).toBe(first);
  });

  it("gives a different id after forget(item, file) for the same item and file", async () => {
    const { attachIdFor, forget } = await loadBoth();
    const f = file("done.pdf");
    const first = attachIdFor("item-6", f);
    forget("item-6", f);
    const second = attachIdFor("item-6", f);
    expect(second).toMatch(UUID);
    expect(second).not.toBe(first);
  });

  it("forget leaves other items and other files alone", async () => {
    const { attachIdFor, forget } = await loadBoth();
    const f = file("keep.pdf");
    const otherFile = file("other-keep.pdf");
    const kept = attachIdFor("item-7a", f);
    const keptFile = attachIdFor("item-7b", otherFile);
    forget("item-7b", f);
    forget("item-7a", otherFile);
    expect(attachIdFor("item-7a", f)).toBe(kept);
    expect(attachIdFor("item-7b", otherFile)).toBe(keptFile);
  });
});

/* #1352: both screens attach through the shared drawer acts
   (home/drawer-acts.svelte.js `attach`), so the attach call, its id and the
   forget are pinned there, and each screen is pinned to call it. */
const ACTS = "web/src/routes/home/drawer-acts.svelte.js";

describe("#1316 W1-R2: both home screens attach through the shared acts", () => {
  it.each([
    ["the desk (+page.svelte onattach)", "web/src/routes/home/+page.svelte"],
    ["the phone (pocket.svelte onattach)", "web/src/routes/home/pocket.svelte"],
  ])("%s calls acts.attach and no attachItemDocument of its own", (_name, path) => {
    const src = read(path);
    expect(src).toMatch(/\bacts\.attach\(/u);
    expect(src).not.toMatch(/attachItemDocument\(/u);
  });
});

describe("#1316 W1-R2: the shared attach does not pass crypto.randomUUID() straight to the attach", () => {
  it("takes its id from the shared helper", () => {
    const src = read(ACTS);
    const calls = src.split("\n").filter((line) => line.includes("attachItemDocument(") && !line.includes("import "));
    expect(calls.length).toBeGreaterThan(0);
    for (const line of calls) expect(line).not.toMatch(/crypto\.randomUUID\(\)/u);
    expect(src).toMatch(/attachIdFor\(/u);
    expect(src).toMatch(/from\s+["'][^"']*attach-id\.js["']/u);
  });
});

describe("#1316 W1-R2, #1584 X-R1: the shared attach forgets the attach id only once the follow-up read lands", () => {
  /* forget() is proven above. Here the shared attach is driven: the id is
     dropped when the attach has landed AND the papers have been read back, so
     a later attach of the same file mints a new id; when the attach landed but
     the read failed, the id is kept, so a re-pick sends it again and the
     server does not store a second copy. */
  it("keeps the id when the attach landed but the read failed, and sends it again on a re-pick", async () => {
    const { acts, sent } = await driveAttach({ reread: vi.fn().mockRejectedValueOnce(new Error("home would not load")) });
    await acts.attach("item-reread-fails", file("reread.pdf"));
    const first = sent()[0];
    expect(first).toMatch(UUID);
    expect(attachIdOf("item-reread-fails", file("reread.pdf"))).toBe(first);
    await acts.attach("item-reread-fails", file("reread.pdf"));
    expect(sent()).toEqual([first, first]);
  });

  it("forgets the id once the read has landed, so the next attach of the same file mints a new one", async () => {
    const { acts, sent } = await driveAttach({ reread: vi.fn().mockResolvedValue(undefined) });
    await acts.attach("item-reread-lands", file("lands.pdf"));
    const first = sent()[0];
    expect(attachIdOf("item-reread-lands", file("lands.pdf"))).not.toBe(first);
  });
});
