import { readFileSync } from "node:fs";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { ARM_MS } from "../../web/src/lib/arm.js";
import { createDiscardGuard, rowsChanged } from "../../web/src/routes/home/discard-guard.js";

/*
 * #1319 stage 3b (the coordinator's ruling, 2026-10-08): rows holding changes
 * are guarded. Cancel, Escape, or anything that would close the row or the
 * drawer arms "discard changes?" first; a second press inside the arm's hold
 * discards; otherwise the rows stay open. Unchanged rows go at once. The
 * shape is retire's own two-press arm, never a browser confirm().
 *
 * DrawerModes (drawer-modes.svelte.js) uses runes, which this suite does not
 * compile, so its decision is the plain guard pinned below, and the wiring
 * is read from source.
 */

const read = (path) => readFileSync(new URL(`../../web/src/${path}`, import.meta.url), "utf8");

describe("the discard guard", () => {
  beforeEach(() => { vi.useFakeTimers(); });
  afterEach(() => { vi.useRealTimers(); });

  it("lets unchanged rows go at the first press, and never arms for them", () => {
    const seen = [];
    const guard = createDiscardGuard({ onchange: (armed) => seen.push(armed) });
    expect(guard.ask(false)).toBe(true);
    expect(guard.armed).toBe(false);
    expect(seen).toEqual([]);
  });

  it("arms on the first press over changed rows and discards on the second", () => {
    const seen = [];
    const guard = createDiscardGuard({ onchange: (armed) => seen.push(armed) });
    expect(guard.ask(true)).toBe(false);
    expect(guard.armed).toBe(true);
    expect(guard.ask(true)).toBe(true);
    expect(guard.armed).toBe(false);
    expect(seen).toEqual([true, false]);
  });

  it("keeps the rows when the second press comes after the hold", () => {
    const guard = createDiscardGuard();
    expect(guard.ask(true)).toBe(false);
    vi.advanceTimersByTime(ARM_MS + 1);
    expect(guard.armed).toBe(false);
    expect(guard.ask(true)).toBe(false);
  });

  it("tells changed rows from the rows as opened", () => {
    const opened = { title: "MOT", dueDate: "2026-10-20", notes: "" };
    expect(rowsChanged(opened, { ...opened })).toBe(false);
    expect(rowsChanged(opened, { ...opened, notes: "book early" })).toBe(true);
  });
});

describe("the drawer's modes and both screens go through it", () => {
  const modes = read("routes/home/drawer-modes.svelte.js");
  const desk = read("routes/home/+page.svelte");
  const pocket = read("routes/home/pocket.svelte");
  const foot = read("routes/home/FootRow.svelte");

  it("DrawerModes guards cancel and routes Escape through it", () => {
    expect(modes).toMatch(/createDiscardGuard\(/u);
    expect(modes).toMatch(/cancel\(\) \{[\s\S]*?this\.#guard\.ask\(this\.changed\)/u);
    expect(modes).toMatch(/escape\(\) \{[\s\S]*?this\.cancel\(\)/u);
  });

  /* #1316 W1-R6: a save in flight is not a way out. The second Escape (or the
     cancel pill, or closing the row) must not discard rows whose save or
     record is on its way; they stay, with the typing, so a refusal has rows
     to read under. */
  it("cancel() keeps the rows while an edit's save is in flight, before the guard is asked", () => {
    expect(modes).toMatch(/cancel\(\) \{[\s\S]*?this\.edit\.busy[\s\S]*?return false;[\s\S]*?this\.#guard\.ask\(/u);
  });

  it("cancel() keeps a completion's rows while it is being recorded, before the guard is asked", () => {
    expect(modes).toMatch(
      /cancel\(\) \{[\s\S]*?(?:this\.recording|this\.completeBusy|this\.saving|this\.busy)[\s\S]*?return false;[\s\S]*?this\.#guard\.ask\(/u,
    );
  });

  /* #1316 W1-S2 (owner, 2026-10-11, option a): the pencil over a completion
     holding changes asks the guard first; it no longer drops the typing. */
  it("startEdit asks the guard when a completion is open, before it ends the completion", () => {
    /* the method's own body, so a later method cannot satisfy the pattern */
    const body = /startEdit\(item\) \{([\s\S]*?)\n  \}\n/u.exec(modes)?.[1] ?? "";
    expect(body).not.toBe("");
    expect(body).toMatch(/this\.completing[\s\S]*?this\.#guard\.ask\(this\.changed\)[\s\S]*?return;/u);
    expect(body.indexOf("#guard.ask(")).toBeGreaterThan(-1);
    expect(body.indexOf("#guard.ask(")).toBeLessThan(body.indexOf("this.cancelComplete()"));
    expect(body.indexOf("#guard.ask(")).toBeLessThan(body.indexOf("this.edit.start("));
  });

  it("the desk asks before closing the drawer or switching rows, and on the cancel pill", () => {
    expect(desk).toMatch(/function collapseRow\(\) \{[\s\S]*?modes\.cancel\(\)/u);
    expect(desk).toMatch(/function onRowClick[\s\S]*?modes\.cancel\(\)/u);
    expect(desk).toMatch(/oncancel: \(\) => \{[\s\S]*?if \(!modes\.cancel\(\)\) return;/u);
  });

  it("the phone asks on the cancel pill and when an edited row closes", () => {
    expect(pocket.match(/if \(!modes\.cancel\(\)\) return;/gu)?.length).toBeGreaterThanOrEqual(2);
    expect(pocket).toMatch(/untrack\(\(\) => modes\.cancel\(\)\)/u);
  });

  it("says so on the pill, and never with a browser dialog", () => {
    expect(foot).toMatch(/discarding \? "discard changes\?" : "cancel"/u);
    for (const source of [modes, desk, pocket, foot]) expect(source).not.toMatch(/\bconfirm\(/u);
  });
});
