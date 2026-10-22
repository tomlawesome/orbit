// @vitest-environment happy-dom
import { resolve } from "node:path";
import { pathToFileURL } from "node:url";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

/*
 * #1180 review: serialised saves with merged picks (M2), first-load sync that
 * keeps an existing reader's cached choice (M3), a stale session read (M3),
 * and a text size observer (M4).
 */
const WEB = resolve(import.meta.dirname, "../../web/src");
const url = (p) => pathToFileURL(resolve(WEB, p)).href;

describe("decideSync", () => {
  const load = () => import(/* @vite-ignore */ url("lib/preferences-sync.js"));
  const server = (themeId, textSize) => ({ themeId, textSize });

  it("keeps and sends up a cached non-default choice when the server holds the defaults", async () => {
    const { decideSync } = await load();
    const r = decideSync(server("afterdark", "comfortable"), { theme: "dawn", textSize: "large", synced: false });
    expect(r).toEqual({ theme: "dawn", textSize: "large", push: { theme: "dawn", textSize: "large" } });
  });

  it("lets a non-default server value win", async () => {
    const { decideSync } = await load();
    const r = decideSync(server("clouds", "large"), { theme: "dawn", textSize: "standard", synced: false });
    expect(r).toEqual({ theme: "clouds", textSize: "large", push: null });
  });

  it("lets the server win once this browser has synced", async () => {
    const { decideSync } = await load();
    const r = decideSync(server("afterdark", "comfortable"), { theme: "dawn", textSize: "large", synced: true });
    expect(r).toEqual({ theme: "afterdark", textSize: "comfortable", push: null });
  });

  it("ignores an unknown cached value and sends nothing for an empty cache", async () => {
    const { decideSync } = await load();
    expect(decideSync(server("afterdark", "comfortable"), { theme: "atlas", textSize: "huge", synced: false }).push).toBeNull();
    expect(decideSync(server("afterdark", "comfortable"), { theme: null, textSize: null, synced: false }).push).toBeNull();
  });
});

describe("savePreferences, quick picks", () => {
  let puts, release;
  let session;
  beforeEach(() => {
    session = { csrfToken: "c", user: { themeId: "afterdark", textSize: "comfortable", emailNotifications: true, pushNotifications: true } };
    vi.resetModules();
    puts = [];
    release = null;
    vi.stubGlobal("fetch", vi.fn(async (u, init = {}) => {
      if (String(u) === "/api/auth/session") return new Response(JSON.stringify(session), { status: 200 });
      const body = JSON.parse(init.body);
      puts.push(body);
      if (puts.length === 1) await new Promise((r) => { release = r; });
      /* the server keeps what it was sent */
      session.user = { ...session.user, themeId: body.theme, textSize: body.textSize };
      return new Response("{}", { status: 200 });
    }));
  });
  afterEach(() => vi.unstubAllGlobals());

  it("runs one save at a time and the last PUT carries both picks", async () => {
    const { savePreferences } = await import(/* @vite-ignore */ url("lib/data/workspace.js"));
    const a = savePreferences({ theme: "dawn" });
    const b = savePreferences({ textSize: "large" });
    await vi.waitFor(() => expect(puts).toHaveLength(1));
    await new Promise((r) => setTimeout(r, 20));
    expect(puts).toHaveLength(1);
    release();
    await Promise.all([a, b]);
    expect(puts.length).toBeGreaterThanOrEqual(1);
    expect(puts.at(-1)).toMatchObject({ theme: "dawn", textSize: "large" });
  });

  it("a failed save does not stop the next one", async () => {
    const { savePreferences } = await import(/* @vite-ignore */ url("lib/data/workspace.js"));
    fetch.mockImplementation(async (u, init = {}) => {
      if (String(u) === "/api/auth/session") return new Response(JSON.stringify(session), { status: 200 });
      puts.push(JSON.parse(init.body));
      return new Response("{}", { status: puts.length === 1 ? 500 : 200 });
    });
    await expect(savePreferences({ theme: "dawn" })).rejects.toBeTruthy();
    await savePreferences({ textSize: "large" });
    expect(puts).toHaveLength(2);
  });
});

describe("picks and stale session reads", () => {
  it("picksMade counts theme and size picks", async () => {
    vi.resetModules();
    vi.stubGlobal("fetch", vi.fn(async () => new Response(JSON.stringify({ csrfToken: "c", user: {} }), { status: 200 })));
    const pick = await import(/* @vite-ignore */ url("lib/pick.js"));
    const before = pick.picksMade();
    pick.chooseTheme("dawn");
    pick.chooseTextSize("large");
    expect(pick.picksMade()).toBe(before + 2);
    vi.unstubAllGlobals();
  });
});

describe("observeTextSize", () => {
  it("reports the applied value and later changes, and stops when disposed", async () => {
    const { observeTextSize, applyTextSize } = await import(/* @vite-ignore */ url("lib/text-size.js"));
    const seen = [];
    applyTextSize("large");
    const stop = observeTextSize((v) => seen.push(v));
    expect(seen).toEqual(["large"]);
    applyTextSize("standard");
    await new Promise((r) => setTimeout(r, 10));
    expect(seen).toEqual(["large", "standard"]);
    stop();
    applyTextSize("extra-large");
    await new Promise((r) => setTimeout(r, 10));
    expect(seen).toEqual(["large", "standard"]);
  });
});
