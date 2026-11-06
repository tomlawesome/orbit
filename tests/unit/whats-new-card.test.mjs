// @vitest-environment happy-dom
import { readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";

import { afterAll, afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { createPageLoader, settle, web } from "../support/svelte-page.mjs";
import { SESSION_FIXTURE } from "../../web/src/lib/data/fixtures/workspace.js";

/*
 * #1618, the card half: the what's-new notice shown once after an upgrade,
 * ported from design/v19/home-sun/round-5/j-whats-new.html (owner decision
 * 42). The server half (GET /api/whats-new, POST /api/whats-new/dismiss) is
 * tested in whats-new-routes and whats-new-select; this file drives the card
 * against a fake of those two routes, through the global fetch, so it holds
 * whichever data-layer function the card reads them with.
 *
 * The card's interface, as this file fixes it:
 *  - web/src/lib/whats-new/WhatsNew.svelte, no props, mounted once in the
 *    root layout beside <Tour /> (it outlives no page, but one mount covers
 *    the desk and the pocket); it acts only on /home.
 *  - the running version and the reader's role both come from the GET answer:
 *    `version` names the running version, and `forAdministrators` is present
 *    for an instance administrator only, so the card needs no isAdmin.
 *  - the first-run film is "showing" while its transport pill
 *    (#orbit-tour-transport, transport.js) is in the document, from the
 *    film's start to its teardown; the card waits for it to go.
 *  - RELEASE_NOTES_HREF ("/about#release-notes", #1618 note 52485) is a
 *    named export of the component's module script.
 *
 * Rendered as drawn: role="dialog" aria-modal="true" labelled by the
 * heading; the heading takes focus on open; Escape, "Got it" and "All release
 * notes" each dismiss. Fixed strings as drawn, compared case-blind because
 * the mock-up sets them in caps with CSS.
 */

const CARD = "lib/whats-new/WhatsNew.svelte";
const HOME = "http://localhost/home";
const page = createPageLoader("whats-new-card", {
  stubs: { "$app/paths": "export const resolve = (p) => p; export const base = \"\";\n" },
});

const json = (/** @type {unknown} */ body, status = 200) =>
  new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json" } });

/* The mock-up's draft copy, as bullets. */
const EVERYONE_37 = [
  { lead: "Planets wear your section’s colour.", text: "Each section has a colour you choose; its items show it on the sky." },
  { lead: "Size is cost or importance.", text: "Pick which one planet size shows, in Settings." },
];
const EVERYONE_36 = [
  { lead: "Names up close.", text: "Planets due within 30 days show their name. Change the days in Settings." },
];
const ADMINS_37 = [
  { lead: "The first-run tour is off.", text: "New members land straight on the sky." },
];
const ADMINS_36 = [
  { lead: "Notes like this one.", text: "Every release can carry a note for members and one for administrators; people see each once." },
];

/* The running version is v0.3.8, which carried nothing for this reader, so
   "the version from the GET" and "the newest release shown" differ: the
   eyebrow and the dismissal must use the former. */
const MEMBER = {
  version: "v0.3.8",
  releases: [{ version: "v0.3.7", forEveryone: EVERYONE_37 }],
};
const ADMIN = {
  version: "v0.3.8",
  releases: [{ version: "v0.3.7", forEveryone: EVERYONE_37, forAdministrators: ADMINS_37 }],
};
const SKIPPED_ADMIN = {
  version: "v0.3.8",
  releases: [
    { version: "v0.3.7", forEveryone: EVERYONE_37, forAdministrators: ADMINS_37 },
    { version: "v0.3.6", forEveryone: EVERYONE_36, forAdministrators: ADMINS_36 },
  ],
};

/** What the fake server saw, and what it answers. */
const seen = /** @type {{ answer: unknown, failGet: "status" | "network" | null, gets: number, dismissals: unknown[] }} */ ({
  answer: MEMBER, failGet: null, gets: 0, dismissals: [],
});

async function server(/** @type {string} */ href, /** @type {RequestInit | undefined} */ init) {
  const url = new URL(href, "http://localhost");
  const method = (init?.method ?? "GET").toUpperCase();
  if (url.pathname === "/api/auth/session") return json(SESSION_FIXTURE);
  if (url.pathname === "/api/whats-new" && method === "GET") {
    seen.gets += 1;
    if (seen.failGet === "network") throw new TypeError("Failed to fetch");
    if (seen.failGet === "status") return json({ error: "internal" }, 500);
    return json(seen.answer);
  }
  if (url.pathname === "/api/whats-new/dismiss" && method === "POST") {
    seen.dismissals.push(JSON.parse(String(init?.body)));
    return json({ ok: true });
  }
  return json({}, 404);
}

beforeEach(() => {
  Object.assign(seen, { answer: MEMBER, failGet: null, gets: 0, dismissals: [] });
  vi.stubGlobal("fetch", vi.fn(server));
});
afterEach(() => {
  page.unmount();
  vi.unstubAllGlobals();
});
afterAll(() => page.teardown());

/** Mounts the card where it acts, home, and lets its read land. */
async function open(/** @type {string} */ url = HOME) {
  const { target, flushSync } = await page.mount(CARD, {}, { url });
  await settle();
  flushSync();
  const dialog = () => /** @type {HTMLElement | null} */ (document.querySelector('[role="dialog"]'));
  const heading = () => {
    const id = dialog()?.getAttribute("aria-labelledby");
    return id ? document.getElementById(id) : null;
  };
  /** The bullets, in document order, with the part they sit in. */
  const bullets = () => [...(dialog()?.querySelectorAll("li") ?? [])].map((li) => ({
    lead: li.querySelector("b")?.textContent?.trim() ?? null,
    text: (li.textContent ?? "").replace(/\s+/g, " ").trim(),
  }));
  const button = (/** @type {RegExp} */ name) => [...(dialog()?.querySelectorAll("button") ?? [])]
    .find((one) => name.test((one.getAttribute("aria-label") ?? one.textContent ?? "").trim()));
  const link = () => [...(dialog()?.querySelectorAll("a") ?? [])]
    .find((one) => /^all release notes$/i.test((one.textContent ?? "").trim()));
  const after = async () => { flushSync(); await settle(); flushSync(); };
  return { target, flushSync, dialog, heading, bullets, button, link, after };
}

const leadsOf = (/** @type {{ lead: string }[]} */ list) => list.map((one) => one.lead);

describe("nothing shows when there is nothing to tell (#1618)", () => {
  it("shows no card when releases is empty", async () => {
    seen.answer = { version: "v0.3.8", releases: [] };
    const { dialog } = await open();
    expect(seen.gets, "the card asked").toBe(1);
    expect(dialog()).toBeNull();
    expect(seen.dismissals).toHaveLength(0);
  });

  it("shows no card under fixtures or a dev build (version null, releases empty)", async () => {
    seen.answer = { version: null, releases: [] };
    const { dialog } = await open();
    expect(seen.gets).toBe(1);
    expect(dialog()).toBeNull();
  });

  it("shows no card, and says nothing, when the GET answers an error", async () => {
    seen.failGet = "status";
    const { dialog } = await open();
    expect(seen.gets).toBe(1);
    expect(dialog()).toBeNull();
    expect(seen.dismissals).toHaveLength(0);
  });

  it("shows no card when the GET never reaches the server", async () => {
    seen.failGet = "network";
    const { dialog } = await open();
    expect(seen.gets).toBe(1);
    expect(dialog()).toBeNull();
  });

  it("acts only on home: elsewhere it neither asks nor shows", async () => {
    const { dialog } = await open("http://localhost/settings");
    expect(seen.gets).toBe(0);
    expect(dialog()).toBeNull();
  });
});

describe("what a member and an administrator see (#1618)", () => {
  it("a member sees the for-everyone bullets only, lead in bold, then the sentence", async () => {
    const { dialog, heading, bullets } = await open();
    expect(dialog(), "the card is up").not.toBeNull();
    expect(heading()?.textContent?.trim()).toBe("New in this release");
    expect(leadsOf(bullets())).toEqual(leadsOf(EVERYONE_37));
    for (const [i, one] of EVERYONE_37.entries()) {
      expect(bullets()[i].text).toBe(`${one.lead} ${one.text}`);
    }
    expect(dialog()?.textContent).not.toMatch(/for administrators/i);
    expect(dialog()?.querySelector("hr")).toBeNull();
  });

  it("an administrator also gets the divider and FOR ADMINISTRATORS with their bullets, in the same card", async () => {
    seen.answer = ADMIN;
    const { dialog, bullets } = await open();
    expect(document.querySelectorAll('[role="dialog"]'), "one card, not a second pop-up").toHaveLength(1);
    const card = /** @type {HTMLElement} */ (dialog());
    const divider = card.querySelector("hr");
    expect(divider, "a divider").not.toBeNull();
    const eyebrow = [...card.querySelectorAll("h3, p, div, span")]
      .find((el) => /^for administrators$/i.test((el.textContent ?? "").trim()));
    expect(eyebrow, "the FOR ADMINISTRATORS eyebrow").toBeDefined();
    expect(leadsOf(bullets())).toEqual([...leadsOf(EVERYONE_37), ...leadsOf(ADMINS_37)]);
    /* The admin bullets come after the divider and the eyebrow. */
    const adminBullet = [...card.querySelectorAll("li")].find((li) => li.textContent?.includes(ADMINS_37[0].lead));
    const follows = (/** @type {Node} */ a, /** @type {Node} */ b) =>
      Boolean(a.compareDocumentPosition(b) & Node.DOCUMENT_POSITION_FOLLOWING);
    expect(follows(/** @type {Node} */ (divider), /** @type {Node} */ (eyebrow))).toBe(true);
    expect(follows(/** @type {Node} */ (eyebrow), /** @type {Node} */ (adminBullet))).toBe(true);
  });

  it("an administrator whose releases carry no admin bullets gets no empty admin part", async () => {
    seen.answer = { version: "v0.3.8", releases: [{ version: "v0.3.7", forEveryone: EVERYONE_37, forAdministrators: [] }] };
    const { dialog, bullets } = await open();
    expect(dialog()).not.toBeNull();
    expect(dialog()?.textContent).not.toMatch(/for administrators/i);
    expect(dialog()?.querySelector("hr")).toBeNull();
    expect(leadsOf(bullets())).toEqual(leadsOf(EVERYONE_37));
  });

  it("several releases come together, newest first, in each part", async () => {
    seen.answer = SKIPPED_ADMIN;
    const { bullets } = await open();
    expect(leadsOf(bullets())).toEqual([
      ...leadsOf(EVERYONE_37), ...leadsOf(EVERYONE_36),
      ...leadsOf(ADMINS_37), ...leadsOf(ADMINS_36),
    ]);
  });

  it("the eyebrow names the running version from the GET, not the newest release shown", async () => {
    const { dialog } = await open();
    const text = (dialog()?.textContent ?? "").replace(/\s+/g, " ");
    expect(text).toMatch(/what['’]s new · orbit 0\.3\.8/i);
    expect(text).not.toMatch(/orbit v?0\.3\.7/i);
  });
});

describe("dismissing, three ways, each writes the version once (#1618)", () => {
  it("Got it posts the GET's version once and closes the card", async () => {
    const { dialog, button, after } = await open();
    const gotIt = button(/^got it$/i);
    expect(gotIt, "a Got it button").toBeDefined();
    gotIt?.click();
    await after();
    expect(seen.dismissals).toEqual([{ version: "v0.3.8" }]);
    expect(dialog()).toBeNull();
  });

  it("Escape posts the GET's version once and closes the card", async () => {
    const { dialog, heading, after } = await open();
    const from = heading() ?? document.body;
    from.dispatchEvent(new KeyboardEvent("keydown", { key: "Escape", bubbles: true, cancelable: true }));
    await after();
    expect(seen.dismissals).toEqual([{ version: "v0.3.8" }]);
    expect(dialog()).toBeNull();
    /* A second Escape, the card gone, writes nothing more. */
    document.body.dispatchEvent(new KeyboardEvent("keydown", { key: "Escape", bubbles: true, cancelable: true }));
    await after();
    expect(seen.dismissals).toHaveLength(1);
  });

  it("All release notes posts the GET's version once and closes the card", async () => {
    const { dialog, link, after } = await open();
    const notes = link();
    expect(notes, "an All release notes link").toBeDefined();
    /* happy-dom cannot load /about; the browser's own navigation is the rig's.
       Cancelled last, at the window, so the card's own handler has run. */
    const stay = (/** @type {Event} */ event) => event.preventDefault();
    window.addEventListener("click", stay);
    notes?.click();
    window.removeEventListener("click", stay);
    await after();
    expect(seen.dismissals).toEqual([{ version: "v0.3.8" }]);
    expect(dialog()).toBeNull();
  });
});

describe("dialog semantics, as drawn (#1618)", () => {
  it("is a modal dialog labelled by its heading, and the heading has focus on open", async () => {
    const { dialog, heading } = await open();
    expect(dialog()?.getAttribute("aria-modal")).toBe("true");
    const title = heading();
    expect(title, "aria-labelledby names an element").not.toBeNull();
    expect(title?.textContent?.trim()).toBe("New in this release");
    expect(document.activeElement).toBe(title);
  });

  it("has no close cross, no remind-later and no checkbox: one button and one link", async () => {
    const { dialog } = await open();
    const card = /** @type {HTMLElement} */ (dialog());
    expect([...card.querySelectorAll("button")].map((one) => (one.textContent ?? "").trim())).toEqual(["Got it"]);
    expect([...card.querySelectorAll("a")].map((one) => (one.textContent ?? "").trim())).toEqual(["All release notes"]);
    expect(card.querySelectorAll("input")).toHaveLength(0);
    expect(card.querySelector('[aria-label*="close" i]')).toBeNull();
    expect(card.textContent).not.toMatch(/[×✕✖]|remind me/i);
  });

  it("uses no timers: nothing in the card's module schedules itself", () => {
    const dir = join(web, "src/lib/whats-new");
    const files = readdirSync(dir).filter((name) => /\.(svelte|js)$/.test(name));
    expect(files.length, "the card's module has files").toBeGreaterThan(0);
    for (const name of files) {
      const source = readFileSync(join(dir, name), "utf8");
      expect(source, `${name} sets no timer`).not.toMatch(/\bset(?:Timeout|Interval)\s*\(/);
    }
  });
});

describe("the card waits while the first-run film is showing (#1618)", () => {
  it("stays down while the film's transport is up, and comes up once it has gone", async () => {
    const pill = document.createElement("div");
    pill.id = "orbit-tour-transport";
    document.body.appendChild(pill);
    const { dialog, after } = await open();
    expect(dialog(), "no card over the film").toBeNull();
    expect(seen.dismissals).toHaveLength(0);
    pill.remove();
    await after();
    expect(dialog(), "the card once the film has gone").not.toBeNull();
  });
});

describe("the All release notes destination is one constant (#1618, #1713)", () => {
  it("exports RELEASE_NOTES_HREF as About's release-notes section, and the link uses it", async () => {
    const compiled = await page.build(join(web, "src", CARD));
    const module = await import(/* @vite-ignore */ compiled);
    /* Decided in #1618 note 52485: the About page's release-notes section (#1713). */
    expect(module.RELEASE_NOTES_HREF).toBe("/about#release-notes");
    const { link } = await open();
    expect(link()?.getAttribute("href")).toBe(module.RELEASE_NOTES_HREF);
  });
});

describe("Escape belongs to the card while it is open (#1618 review)", () => {
  it("dismisses the card and nothing else on the page hears that key press", async () => {
    /* Home's own window handler collapses an expanded row on Escape
       (home/+page.svelte onWindowKeydown). One listener is registered before
       the card mounts and one after, so the card cannot rely on its place in
       the listener order. */
    const heard = /** @type {string[]} */ ([]);
    const early = (/** @type {KeyboardEvent} */ event) => { if (event.key === "Escape") heard.push("early"); };
    const late = (/** @type {KeyboardEvent} */ event) => { if (event.key === "Escape") heard.push("late"); };
    window.addEventListener("keydown", early);
    try {
      const { dialog, heading, after } = await open();
      window.addEventListener("keydown", late);
      const press = new KeyboardEvent("keydown", { key: "Escape", bubbles: true, cancelable: true });
      (heading() ?? document.body).dispatchEvent(press);
      await after();
      expect(seen.dismissals, "the card dismissed").toEqual([{ version: "v0.3.8" }]);
      expect(dialog()).toBeNull();
      expect(heard, "no other handler reacted to the key press").toEqual([]);
    } finally {
      window.removeEventListener("keydown", early);
      window.removeEventListener("keydown", late);
    }
  });
});

describe("focus returns when the card leaves (#1618 review, APG Dialog (Modal))", () => {
  const paths = /** @type {const} */ ([
    ["Got it", async (/** @type {Awaited<ReturnType<typeof open>>} */ o) => { o.button(/^got it$/i)?.click(); }],
    ["Escape", async (/** @type {Awaited<ReturnType<typeof open>>} */ o) => {
      (o.heading() ?? document.body).dispatchEvent(new KeyboardEvent("keydown", { key: "Escape", bubbles: true, cancelable: true }));
    }],
    ["All release notes", async (/** @type {Awaited<ReturnType<typeof open>>} */ o) => {
      const stay = (/** @type {Event} */ event) => event.preventDefault();
      window.addEventListener("click", stay);
      o.link()?.click();
      window.removeEventListener("click", stay);
    }],
  ]);

  for (const [name, dismissWith] of paths) {
    it(`${name}: focus goes back to the element that had it before the card opened`, async () => {
      const before = document.createElement("button");
      before.textContent = "before";
      document.body.appendChild(before);
      before.focus();
      expect(document.activeElement, "the setup focus took").toBe(before);
      try {
        const o = await open();
        expect(document.activeElement, "the heading took focus on open").toBe(o.heading());
        await dismissWith(o);
        await o.after();
        expect(o.dialog()).toBeNull();
        expect(document.activeElement).toBe(before);
      } finally {
        before.remove();
      }
    });
  }

  it("Got it: if that element has gone, focus is not dropped to the page body", async () => {
    const before = document.createElement("button");
    document.body.appendChild(before);
    before.focus();
    const o = await open();
    before.remove();
    o.button(/^got it$/i)?.click();
    await o.after();
    expect(o.dialog()).toBeNull();
    expect(document.activeElement).not.toBe(document.body);
    expect(document.activeElement).not.toBeNull();
  });
});

describe("the read gives up on a stalled server (#1618 review)", () => {
  it("passes an AbortSignal.timeout signal to the GET", async () => {
    const timeout = vi.spyOn(AbortSignal, "timeout");
    await open();
    const call = /** @type {import("vitest").Mock} */ (fetch).mock.calls
      .find(([href]) => String(href).includes("/api/whats-new") && !String(href).includes("dismiss"));
    expect(call, "the card asked").toBeDefined();
    expect(call?.[1]?.signal, "the GET carries a signal").toBeInstanceOf(AbortSignal);
    expect(timeout, "that signal comes from AbortSignal.timeout").toHaveBeenCalled();
    timeout.mockRestore();
  });

  it("a GET that is aborted by its timeout shows no card and throws nothing", async () => {
    vi.spyOn(AbortSignal, "timeout").mockImplementation(() => AbortSignal.abort());
    vi.stubGlobal("fetch", vi.fn(async (/** @type {string} */ href, /** @type {RequestInit | undefined} */ init) => {
      if (String(href).includes("/api/whats-new") && !String(href).includes("dismiss") && init?.signal?.aborted) {
        throw new DOMException("The operation timed out.", "TimeoutError");
      }
      return server(href, init);
    }));
    try {
      const { dialog } = await open();
      expect(dialog()).toBeNull();
      expect(seen.dismissals).toHaveLength(0);
    } finally {
      vi.mocked(AbortSignal.timeout).mockRestore();
    }
  });
});
