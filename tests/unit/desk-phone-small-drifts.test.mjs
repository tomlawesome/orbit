import { readFileSync, readdirSync, statSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";

/*
 * #1344 (desk and phone agree: the small drifts), from #1328 WI-14: the
 * phone's behaviour is the reference (M3), except the archive card's step-up
 * return notice, which the phone gains from the desk.
 *
 * Most of these drifts live inside .svelte files with no logic module to
 * import and no component-mounting harness in this suite, so they are
 * precise source-level checks (the shape of tests/unit/v19-household.test.mjs
 * and administration-pocket-tells-scope.test.mjs): each pulls out the one
 * function or block the issue names and checks it for the behaviour the
 * reference layout already has. The two with a plain module behind them
 * (burnsInOf, drawnIn) also have behaviour tests (this file; the drawnIn
 * one in flight-warm-drawn-in.test.mjs).
 *
 * Out of scope here: the sent-list time format (#1339, another lane owns
 * format.js) and phone settings' compact words (no change).
 */

const ROUTES = new URL("../../web/src/routes/", import.meta.url);
const LIB = new URL("../../web/src/lib/", import.meta.url);
/** @param {string} path under web/src/routes/ */
const route = (path) => readFileSync(new URL(path, ROUTES), "utf8");
/** @param {string} path under web/src/lib/ */
const lib = (path) => readFileSync(new URL(path, LIB), "utf8");

/**
 * The braced block that opens at the first `{` after `marker` (function or
 * arrow body), found by matching braces. Fails the test if the marker is gone.
 * @param {string} src @param {string} marker
 */
function blockAfter(src, marker) {
  const at = src.indexOf(marker);
  expect(at, `source no longer contains: ${marker}`).toBeGreaterThanOrEqual(0);
  const open = src.indexOf("{", at + marker.length - 1);
  let depth = 0;
  for (let i = open; i < src.length; i++) {
    if (src[i] === "{") depth++;
    else if (src[i] === "}" && --depth === 0) return src.slice(open, i + 1);
  }
  throw new Error(`unbalanced block after: ${marker}`);
}

describe("administration: the tells (#1344, web-8)", () => {
  const desk = () => blockAfter(route("administration/+page.svelte"), "const tells = $derived.by(");

  it("the desk falls back to the mailbox's own verificationState when there is no probe, as the phone does", () => {
    // phone: pocket.svelte -- mailProbes.mailbox ? probe verdict : view.mailbox?.verificationState === "failed"
    expect(desk()).toMatch(/verificationState\s*===\s*["']failed["']/);
  });

  it("the desk still says 'mailbox failed' and still reads the probe first", () => {
    expect(desk()).toMatch(/mailProbes\.mailbox/);
    expect(desk()).toMatch(/mailbox failed/);
  });
});

describe("administration: contactAction's re-entry guard (#1344, web-9)", () => {
  it("the desk refuses a second contact write while one is in flight, as the phone does", () => {
    const body = blockAfter(route("administration/+page.svelte"), "async function contactAction(partial)");
    // phone: `if (!current || contactBusy) return;`
    expect(body).toMatch(/if\s*\([^)]*\bcontactBusy\b[^)]*\)\s*return/);
  });

  it("the guard comes before the busy flag is raised", () => {
    const body = blockAfter(route("administration/+page.svelte"), "async function contactAction(partial)");
    const guard = body.search(/if\s*\([^)]*\bcontactBusy\b[^)]*\)\s*return/);
    const raise = body.indexOf("contactBusy = true");
    expect(guard).toBeGreaterThanOrEqual(0);
    expect(raise).toBeGreaterThan(guard);
  });
});

describe("home: startAmend's section fallback (#1344, web-11)", () => {
  it("the desk falls back to the view's own household sections, as the phone does", () => {
    const body = blockAfter(route("home/+page.svelte"), "function startAmend()");
    // phone: (view.households ?? []).find(...)?.sections ?? view.household?.sections ?? []
    expect(body).toMatch(/\bhousehold\?\.sections/);
  });

  it("the households lookup still comes first, so a named household wins", () => {
    const body = blockAfter(route("home/+page.svelte"), "function startAmend()");
    const lookup = body.search(/households\b[^;]*\.find\([^;]*\?\.sections/);
    const fallback = body.search(/\bhousehold\?\.sections/);
    expect(lookup).toBeGreaterThanOrEqual(0);
    expect(fallback).toBeGreaterThan(lookup);
  });
});

describe("archive card: the step-up return notice (#1344, web-12)", () => {
  const NOTICE = "back from signing in again · choose the file once more to carry on";
  const phone = () => route("household/[id]/PocketArchive.svelte");
  const deskSrc = () => route("household/[id]/DeskArchive.svelte");

  it("control: the desk has the notice this one is copied from", () => {
    expect(deskSrc()).toContain(NOTICE);
    expect(deskSrc()).toContain("STEPUP_RETURN_FLAG");
  });

  it("the phone says the same words on its return", () => {
    expect(phone()).toContain(NOTICE);
  });

  it("the phone names its return flag STEPUP_RETURN_FLAG and keeps it in sessionStorage", () => {
    const src = phone();
    expect(src).toMatch(/const\s+STEPUP_RETURN_FLAG\s*=\s*["'][^"']+["']/);
    expect(src).toMatch(/sessionStorage\.setItem\(\s*STEPUP_RETURN_FLAG/);
    expect(src).toMatch(/sessionStorage\.getItem\(\s*STEPUP_RETURN_FLAG/);
  });

  it("the phone sets the flag before it leaves for the provider, and clears it if the redirect fails", () => {
    const body = blockAfter(phone(), "async function toProvider()");
    const set = body.indexOf("setItem");
    const start = body.indexOf("startStepUp(");
    expect(set, "flag is never set in toProvider").toBeGreaterThanOrEqual(0);
    expect(start).toBeGreaterThan(set);
    expect(body).toMatch(/catch[\s\S]*sessionStorage\.removeItem\(\s*STEPUP_RETURN_FLAG/);
  });

  it("the phone reads the flag on arrival, consumes it, and shows the notice in the card", () => {
    const src = phone();
    expect(src).toMatch(/onMount/);
    expect(src).toMatch(/sessionStorage\.removeItem\(\s*STEPUP_RETURN_FLAG/);
    // shown as a note in the markup, not only assigned
    expect(src).toMatch(/\{#if\s+stepUpNotice\}/);
  });
});

describe("settings: toggleEmailReminders' saving guard (#1344, web-13)", () => {
  const body = () => blockAfter(route("settings/+page.svelte"), "async function toggleEmailReminders()");

  it("the desk has an emailSaving flag, as the phone does", () => {
    expect(route("settings/+page.svelte")).toMatch(/let\s+emailSaving\s*=\s*\$state\(/);
  });

  it("the desk ignores a second toggle while the first is being saved", () => {
    // phone: `if (!view || emailSaving) return;`
    expect(body()).toMatch(/if\s*\([^)]*\bemailSaving\b[^)]*\)\s*return/);
  });

  it("the flag is raised for the write and lowered afterwards whether it worked or not", () => {
    const text = body();
    expect(text).toMatch(/emailSaving\s*=\s*true/);
    expect(text).toMatch(/finally\s*\{[^}]*emailSaving\s*=\s*false/);
  });
});

describe("settings: the password-changed words (#1344, web-13)", () => {
  const PHONE_WORDS = "password changed · every other device was signed out";

  it("the phone's words are the reference", () => {
    expect(route("settings/pocket.svelte")).toContain(PHONE_WORDS);
  });

  it("the desk says them too, not the dashed variant", () => {
    const src = route("settings/+page.svelte");
    expect(src).toContain(PHONE_WORDS);
    expect(src).not.toContain("password changed — every other device was signed out");
  });
});

describe("inbox: burnsIn is null-safe on the desk (#1344, web-14)", () => {
  it("burnsInOf, the phone's, gives null for mail with no expiry and a day count otherwise", async () => {
    const { burnsInOf } = await import("../../web/src/lib/pocket/review.js");
    expect(burnsInOf({ expiresAt: null }, "2026-08-13")).toBeNull();
    expect(burnsInOf({}, "2026-08-13")).toBeNull();
    expect(burnsInOf({ expiresAt: "2026-08-20T09:00:00Z" }, "2026-08-13")).toBe(7);
  });

  const desk = () => route("inbox/+page.svelte");

  it("the desk imports burnsInOf from $lib/pocket/review.js", () => {
    expect(desk()).toMatch(/import\s*\{[^}]*\bburnsInOf\b[^}]*\}\s*from\s*["']\$lib\/pocket\/review\.js["']/);
  });

  it("the desk no longer forces expiresAt to a string and slices it", () => {
    expect(desk()).not.toMatch(/\(receipt\.expiresAt\)\s*\.slice/);
    expect(desk()).not.toMatch(/\(\s*\/\*\*\s*@type\s*\{string\}\s*\*\/\s*\(receipt\.expiresAt\)\s*\)/);
  });

  it("the desk's 'burns up in' words are not shown for a receipt with no expiry", () => {
    // the span with the words must sit under a null check on the day count
    const src = desk();
    const at = src.indexOf("burns up in");
    expect(at).toBeGreaterThanOrEqual(0);
    const before = src.slice(Math.max(0, at - 400), at);
    expect(before).toMatch(/burnsIn\(receipt\)\s*(!==|!=)\s*null|\{#if[^}]*burnsIn|\{#if[^}]*expiresAt/);
  });
});

describe("Chrome's 'household · role' line (#1344, web-21)", () => {
  const chrome = () => lib("Chrome.svelte");

  /** every route file that mounts the shared Chrome */
  function chromeCallers() {
    /** @type {string[]} */
    const found = [];
    const walk = (/** @type {URL} */ dir) => {
      for (const name of readdirSync(dir)) {
        const child = new URL(name + (statSync(new URL(name, dir)).isDirectory() ? "/" : ""), dir);
        if (statSync(child).isDirectory()) walk(child);
        else if (name.endsWith(".svelte") && /<Chrome\b/.test(readFileSync(child, "utf8"))) {
          found.push(child.pathname.slice(ROUTES.pathname.length));
        }
      }
    };
    walk(ROUTES);
    return found.sort();
  }

  /** the `<Chrome ... />` tags in a source @param {string} src */
  const chromeTags = (src) => src.match(/<Chrome\b[\s\S]*?\/>/g) ?? [];

  it("Chrome takes a `household` prop", () => {
    const props = chrome().match(/let\s*\{([\s\S]*?)\}\s*=\s*\$props\(\)/)?.[1] ?? "";
    expect(props).toMatch(/\bhousehold\b/);
  });

  it("Chrome no longer takes a ready-made `role` line", () => {
    const props = chrome().match(/let\s*\{([\s\S]*?)\}\s*=\s*\$props\(\)/)?.[1] ?? "";
    expect(props).not.toMatch(/\brole\b/);
  });

  it("Chrome builds the 'name · owner|member' line itself and hands it to the account card and the hatch", () => {
    const src = chrome();
    expect(src).toMatch(/·/);
    expect(src).toMatch(/["']owner["']/);
    expect(src).toMatch(/["']member["']/);
    expect(src).toMatch(/canManage/);
    // the hatch's roleLine and the card's second line both come from the built line
    expect(src).toMatch(/roleLine=\{(?!role\})/);
  });

  it("a member with no household name never shows ' · member': the line needs the name", () => {
    const src = chrome();
    // the bug pattern: `${household?.name ?? ""} · ...`
    expect(src).not.toMatch(/\.name\s*\?\?\s*(""|'')\s*\}\s*·/);
    // the name itself decides whether there is a line at all
    expect(src).toMatch(
      /household\??\.name\s*(\?[^.?]|&&)|!\s*household\??\.name|if\s*\(\s*household\??\.name|household\??\.name\s*\)\s*(\?|&&)|\(\s*household\??\.name\s*\)\s*(\?|&&)/,
    );
  });

  it("all eight callers are found", () => {
    expect(chromeCallers()).toEqual([
      "about/+page.svelte",
      "administration/+page.svelte",
      "create/+page.svelte",
      "household/[id]/+page.svelte",
      "inbox/+page.svelte",
      "kit/+page.svelte",
      "settings/+page.svelte",
      "settings/mail/+page.svelte",
    ]);
  });

  it("no caller builds the line any more: none passes `role=`, each passes `household`", () => {
    for (const file of chromeCallers()) {
      const tags = chromeTags(route(file));
      expect(tags.length, `${file} has no <Chrome ... /> tag`).toBeGreaterThan(0);
      for (const tag of tags) {
        expect(tag, `${file} still passes role to Chrome`).not.toMatch(/\brole\s*=/);
        expect(tag, `${file} does not pass household to Chrome`).toMatch(/\bhousehold\b/);
      }
    }
  });

  it("no caller still glues a name and an owner/member word together for Chrome", () => {
    for (const file of chromeCallers()) {
      for (const tag of chromeTags(route(file))) {
        expect(tag, file).not.toMatch(/"owner"\s*:\s*"member"/);
        expect(tag, file).not.toMatch(/·/);
      }
    }
  });
});

describe("SignIn.svelte's drawnIn (#1344, web-14 sibling: SSR-safe copy)", () => {
  const signin = () => lib("flight/SignIn.svelte");

  it("imports drawnIn from warm.js, with the other warm.js imports", () => {
    expect(signin()).toMatch(/import\s*\{[^}]*\bdrawnIn\b[^}]*\}\s*from\s*["']\.\/warm\.js["']/);
  });

  it("no longer keeps its own copy of drawnIn or the painted/COMPOSITED helpers", () => {
    const src = signin();
    expect(src).not.toMatch(/const\s+drawnIn\s*=/);
    expect(src).not.toMatch(/const\s+painted\s*=/);
    expect(src).not.toMatch(/const\s+COMPOSITED\s*=/);
  });
});
