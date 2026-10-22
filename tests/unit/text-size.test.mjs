// @vitest-environment happy-dom
import { readFileSync, readdirSync } from "node:fs";
import { resolve } from "node:path";
import { pathToFileURL } from "node:url";

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { themePreferenceSchema, textSizes } from "../../src/lib/preferences";

/*
 * #1180: text size is chosen in Settings, applied at first paint from a cache
 * and stored on the server beside the theme. Mirrors the theme tests
 * (v19-theme-roster.test.mjs): the pure helper, app.html's literal copy of the
 * list, the DOM apply, the server write and the session-load sync.
 */

const WEB_SRC = resolve(import.meta.dirname, "../../web/src");
const APP_HTML = readFileSync(resolve(WEB_SRC, "app.html"), "utf8");
const STEPS = ["standard", "comfortable", "large", "extra-large"];

/* A computed specifier, so a missing module fails each test rather than the
   whole file at transform time. */
const TEXT_SIZE_MODULE = pathToFileURL(resolve(WEB_SRC, "lib/text-size.js")).href;
const load = () => import(/* @vite-ignore */ TEXT_SIZE_MODULE);

describe("the text size list", () => {
  it("is the four steps, in order, defaulting to comfortable", async () => {
    const { TEXT_SIZES, DEFAULT_TEXT_SIZE } = await load();
    expect([...TEXT_SIZES]).toEqual(STEPS);
    expect(DEFAULT_TEXT_SIZE).toBe("comfortable");
  });

  it("is the list the server schema accepts", async () => {
    const { TEXT_SIZES } = await load();
    expect([...TEXT_SIZES]).toEqual([...textSizes]);
  });
});

describe("textSizeOrDefault", () => {
  it("honours every step on the list", async () => {
    const { textSizeOrDefault } = await load();
    for (const step of STEPS) expect(textSizeOrDefault(step)).toBe(step);
  });

  it("falls back to comfortable for unknown, empty or missing input", async () => {
    const { textSizeOrDefault } = await load();
    for (const bad of ["huge", "extra large", "LARGE", "", " ", null, undefined, 3])
      expect(textSizeOrDefault(bad)).toBe("comfortable");
  });
});

describe("app.html", () => {
  it("pre-paint script reads orbit-text-size against exactly TEXT_SIZES", async () => {
    const { TEXT_SIZES } = await load();
    const match = /localStorage\.getItem\("orbit-text-size"\)[\s\S]{0,200}?\[([^\]]+)\]/.exec(APP_HTML);
    expect(match, "app.html's pre-paint script text-size list").toBeTruthy();
    const list = match[1].split(",").map((entry) => entry.trim().replace(/^"|"$/g, ""));
    expect(list).toEqual([...TEXT_SIZES]);
  });

  it("<html> starts on data-text-size=comfortable", () => {
    const tag = /<html\b[^>]*>/.exec(APP_HTML);
    expect(tag, "app.html's <html> tag").toBeTruthy();
    expect(/\sdata-text-size="comfortable"/.test(tag[0])).toBe(true);
  });

  it("applies the cached value to data-text-size", () => {
    expect(APP_HTML).toMatch(/dataset\.textSize\s*=|setAttribute\("data-text-size"/);
  });
});

describe("applyTextSize", () => {
  beforeEach(() => {
    document.documentElement.removeAttribute("data-text-size");
    localStorage.clear();
  });

  it("sets data-text-size on <html> and orbit-text-size in the cache, for each step", async () => {
    const { applyTextSize } = await load();
    for (const step of STEPS) {
      applyTextSize(step);
      expect(document.documentElement.getAttribute("data-text-size")).toBe(step);
      expect(localStorage.getItem("orbit-text-size")).toBe(step);
    }
  });

  it("still sets the page when storage is blocked", async () => {
    const { applyTextSize } = await load();
    const spy = vi.spyOn(Storage.prototype, "setItem").mockImplementation(() => { throw new Error("blocked"); });
    expect(() => applyTextSize("large")).not.toThrow();
    expect(document.documentElement.getAttribute("data-text-size")).toBe("large");
    spy.mockRestore();
  });
});

describe("savePreferences", () => {
  /** @type {Array<{ url: string, init: any }>} */
  let calls;
  const session = {
    csrfToken: "csrf-fresh",
    user: { themeId: "dawn", textSize: "standard", emailNotifications: false, pushNotifications: true },
  };

  beforeEach(() => {
    vi.resetModules();
    calls = [];
    vi.stubGlobal("fetch", vi.fn(async (url, init = {}) => {
      calls.push({ url: String(url), init });
      if (String(url) === "/api/auth/session") return new Response(JSON.stringify(session), { status: 200 });
      return new Response(JSON.stringify({ ok: true }), { status: 200 });
    }));
  });
  afterEach(() => { vi.unstubAllGlobals(); });

  const puts = () => calls.filter((c) => c.url === "/api/preferences");

  it("PUTs the full body: the picked text size, the current theme and both notification flags", async () => {
    const { savePreferences } = await import("../../web/src/lib/data/workspace.js");
    /* Assumed call shape: an object naming what changed; the rest is read
       from the session. The theme key is `theme`, as in the schema. */
    await savePreferences({ textSize: "extra-large" });
    expect(puts()).toHaveLength(1);
    const { init } = puts()[0];
    expect(init.method).toBe("PUT");
    expect(init.headers["x-csrf-token"]).toBe("csrf-fresh");
    const body = JSON.parse(init.body);
    expect(body).toEqual({ theme: "dawn", textSize: "extra-large", emailNotifications: false, pushNotifications: true });
    expect(themePreferenceSchema.safeParse(body).success).toBe(true);
  });

  it("sends a picked theme with the stored text size", async () => {
    const { savePreferences } = await import("../../web/src/lib/data/workspace.js");
    await savePreferences({ theme: "clouds" });
    const body = JSON.parse(puts()[0].init.body);
    expect(body).toEqual({ theme: "clouds", textSize: "standard", emailNotifications: false, pushNotifications: true });
  });

  it("takes the flags fresh from the server, not from a cached read", async () => {
    const { savePreferences, readSession } = await import("../../web/src/lib/data/workspace.js");
    await readSession();
    session.user = { ...session.user, emailNotifications: true, pushNotifications: false };
    await savePreferences({ textSize: "large" });
    const body = JSON.parse(puts()[0].init.body);
    expect(body.emailNotifications).toBe(true);
    expect(body.pushNotifications).toBe(false);
  });
});

describe("session load", () => {
  /** @param {string} dir @returns {string[]} */
  const sources = (dir) => readdirSync(dir, { withFileTypes: true }).flatMap((e) => {
    const p = resolve(dir, e.name);
    if (e.isDirectory()) return e.name === "node_modules" ? [] : sources(p);
    return /\.(svelte|js)$/.test(e.name) ? [p] : [];
  });

  it("the shell applies the server's themeId and textSize once the session is read", () => {
    const shells = sources(WEB_SRC).filter((p) => {
      if (p.endsWith("/lib/text-size.js")) return false;
      const text = readFileSync(p, "utf8");
      return /applyTextSize\(/.test(text) && /readSession\(/.test(text)
        && /user\??\.textSize/.test(text) && /user\??\.themeId/.test(text) && /applyTheme\(/.test(text);
    });
    expect(shells, "a shell file that reads the session and applies both").not.toEqual([]);
  });
});
