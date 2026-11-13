// @vitest-environment happy-dom
import { afterAll, afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { createPageLoader, settle } from "../support/svelte-page.mjs";
import { ABOUT_FIXTURE } from "../../web/src/lib/data/fixtures/about.js";

/*
 * #1713: the About page's "Release notes" section, drawn from the page's own
 * server load (`data.releaseNotes`, the { version, releases } shape GET
 * /api/whats-new answers, already filtered by role and sorted newest first by
 * the engine). See about-release-notes-load and release-notes-select.
 *
 * The section, as this file fixes it (#1713, #1618 note 52485):
 *  - a card in the page's existing style (`section.card`) with id
 *    "release-notes", headed by an h2 "Release notes", after "This Orbit";
 *  - each release an h3 subheading reading its version; the running
 *    version's subheading carries aria-current="true", no other does;
 *  - bullets as <li><b>lead</b> sentence</li>, the card's form;
 *  - an administrator's part under a "For administrators" label inside that
 *    version, before the next version's subheading;
 *  - one line, "No release notes yet", when the list is empty.
 * Reading the page records nothing: no dismiss, no write of any kind.
 */

const page = createPageLoader("about-release-notes", {
  stub: (file) => /\/(Chrome|PageSky)\.svelte$/.test(file),
});
const PAGE = "routes/about/+page.svelte";

const json = (/** @type {unknown} */ body, status = 200) =>
  new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json" } });

/** Every request the page made, with its method. */
const requests = /** @type {{ path: string, method: string }[]} */ ([]);

async function server(/** @type {string} */ href, /** @type {RequestInit | undefined} */ init) {
  const url = new URL(href, "http://localhost");
  requests.push({ path: url.pathname, method: (init?.method ?? "GET").toUpperCase() });
  if (url.pathname === "/api/about") return json({ about: ABOUT_FIXTURE });
  return json({ error: { code: "not_found" } }, 404);
}

const EVERYONE_38 = [
  { lead: "Planets wear your section’s colour.", text: "Each section has a colour you choose; its items show it on the sky." },
  { lead: "Size is cost or importance.", text: "Pick which one planet size shows, in Settings." },
];
const EVERYONE_37 = [{ lead: "Names up close.", text: "Planets due within 30 days show their name." }];
const ADMINS_38 = [{ lead: "The first-run tour is off.", text: "New members land straight on the sky." }];
const ADMINS_36 = [{ lead: "Notes like this one.", text: "Every release can carry a note for members and one for administrators." }];

const MEMBER = {
  version: "v0.3.7",
  releases: [
    { version: "v0.3.8", forEveryone: EVERYONE_38 },
    { version: "v0.3.7", forEveryone: EVERYONE_37 },
  ],
};
const ADMIN = {
  version: "v0.3.7",
  releases: [
    { version: "v0.3.8", forEveryone: EVERYONE_38, forAdministrators: ADMINS_38 },
    { version: "v0.3.7", forEveryone: EVERYONE_37, forAdministrators: [] },
    { version: "v0.3.6", forEveryone: [], forAdministrators: ADMINS_36 },
  ],
};

beforeEach(() => {
  requests.length = 0;
  vi.stubGlobal("fetch", vi.fn(server));
});
afterEach(() => {
  page.unmount();
  vi.unstubAllGlobals();
});
afterAll(() => page.teardown());

/** Mounts About with these release notes and lets its reads land. */
async function open(/** @type {unknown} */ releaseNotes) {
  const { target, flushSync } = await page.mount(PAGE, { data: { libraries: null, releaseNotes } }, { url: "http://localhost/about" });
  await settle();
  flushSync();
  const section = () => /** @type {HTMLElement | null} */ (document.getElementById("release-notes"));
  const versions = () => [...(section()?.querySelectorAll("h3") ?? [])];
  const text = (/** @type {Element | null | undefined} */ el) => (el?.textContent ?? "").replace(/\s+/g, " ").trim();
  /** The <li>s between one version's subheading and the next. */
  const itemsOf = (/** @type {string} */ version) => {
    const heads = versions();
    const index = heads.findIndex((h) => text(h).includes(version));
    if (index < 0) return [];
    const start = heads[index];
    const end = heads[index + 1] ?? null;
    return [...(section()?.querySelectorAll("li") ?? [])].filter((li) =>
      (start.compareDocumentPosition(li) & Node.DOCUMENT_POSITION_FOLLOWING)
      && (!end || (end.compareDocumentPosition(li) & Node.DOCUMENT_POSITION_PRECEDING)));
  };
  /** The "For administrators" labels inside the section (not the bullets themselves). */
  const adminLabels = () => [...(section()?.querySelectorAll("*") ?? [])]
    .filter((el) => /^for administrators$/i.test(text(el)) && ![...el.children].some((c) => /^for administrators$/i.test(text(c))));
  return { target, flushSync, section, versions, itemsOf, adminLabels, text };
}

const bulletOf = (/** @type {HTMLElement} */ li) => ({
  lead: li.querySelector("b, strong")?.textContent?.trim() ?? null,
  text: (li.textContent ?? "").replace(/\s+/g, " ").trim(),
});

describe("the Release notes card on About (#1713)", () => {
  it("is a card headed \"Release notes\", anchored #release-notes, in the page's card style", async () => {
    const { section, text } = await open(MEMBER);
    const card = section();
    expect(card, "an element with id release-notes").not.toBeNull();
    const box = /** @type {HTMLElement} */ (card?.closest(".card") ?? card);
    expect(box.classList.contains("card"), "the page's .card style").toBe(true);
    expect(box.tagName).toBe("SECTION");
    const heading = box.querySelector("h2");
    expect(text(heading)).toBe("Release notes");
    /* Labelled the way the other cards are, so it reads as a region. */
    const labelledBy = box.getAttribute("aria-labelledby");
    if (labelledBy) expect(document.getElementById(labelledBy)).toBe(heading);
  });

  it("comes below \"This Orbit\"", async () => {
    const { section } = await open(MEMBER);
    const orbit = document.getElementById("about-orbit")?.closest("section");
    expect(orbit, "This Orbit").toBeTruthy();
    const card = /** @type {HTMLElement} */ (section()?.closest(".card") ?? section());
    expect(orbit?.compareDocumentPosition(card) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy();
    expect(orbit?.contains(card)).toBe(false);
  });

  it("lists every release it was given as a subheading, newest first, in the order given", async () => {
    const { versions, text } = await open(ADMIN);
    expect(versions().map((h) => text(h).match(/v\d+\.\d+\.\d+/)?.[0])).toEqual(["v0.3.8", "v0.3.7", "v0.3.6"]);
  });

  it("marks the running version, and only that one", async () => {
    const { versions, text } = await open(ADMIN);
    const marked = versions().filter((h) => h.getAttribute("aria-current") === "true");
    expect(marked.map((h) => text(h).match(/v\d+\.\d+\.\d+/)?.[0])).toEqual(["v0.3.7"]);
  });

  it("marks nothing when the running version is not known (a dev build)", async () => {
    const { versions } = await open({ ...MEMBER, version: null });
    expect(versions()).toHaveLength(2);
    expect(versions().filter((h) => h.hasAttribute("aria-current"))).toEqual([]);
  });

  it("draws each for-everyone bullet as a bold lead then its sentence, under its own version", async () => {
    const { itemsOf } = await open(MEMBER);
    expect(itemsOf("v0.3.8").map(bulletOf)).toEqual(EVERYONE_38.map((one) => ({ lead: one.lead, text: `${one.lead} ${one.text}` })));
    expect(itemsOf("v0.3.7").map(bulletOf)).toEqual(EVERYONE_37.map((one) => ({ lead: one.lead, text: `${one.lead} ${one.text}` })));
  });

  it("shows a member no \"For administrators\" part", async () => {
    const { section, adminLabels } = await open(MEMBER);
    expect(adminLabels()).toEqual([]);
    expect(section()?.textContent).not.toMatch(/for administrators/i);
  });

  it("shows an administrator a \"For administrators\" sub-list under the same version, after its everyone bullets", async () => {
    const { itemsOf, adminLabels, versions, text } = await open(ADMIN);
    const items = itemsOf("v0.3.8");
    expect(items.map((li) => bulletOf(li).lead)).toEqual([...EVERYONE_38, ...ADMINS_38].map((one) => one.lead));
    expect(bulletOf(items[2]).text).toBe(`${ADMINS_38[0].lead} ${ADMINS_38[0].text}`);

    /* One label per version that has an administrators part: v0.3.8 and v0.3.6, not v0.3.7. */
    expect(adminLabels()).toHaveLength(2);
    const [label] = adminLabels();
    const head38 = versions().find((h) => text(h).includes("v0.3.8"));
    const head37 = versions().find((h) => text(h).includes("v0.3.7"));
    expect(head38?.compareDocumentPosition(label) & Node.DOCUMENT_POSITION_FOLLOWING, "label after v0.3.8").toBeTruthy();
    expect(head37?.compareDocumentPosition(label) & Node.DOCUMENT_POSITION_PRECEDING, "label before v0.3.7").toBeTruthy();
    expect(label.compareDocumentPosition(items[2]) & Node.DOCUMENT_POSITION_FOLLOWING, "admin bullet after the label").toBeTruthy();
    expect(label.compareDocumentPosition(items[1]) & Node.DOCUMENT_POSITION_PRECEDING, "everyone bullets before the label").toBeTruthy();
    /* A sub-list: the administrators' bullets are not in the same list as everyone's. */
    expect(items[2].parentElement).not.toBe(items[0].parentElement);
  });

  it("shows a release that has only an administrators part as that part alone", async () => {
    const { itemsOf } = await open(ADMIN);
    expect(itemsOf("v0.3.6").map(bulletOf)).toEqual(ADMINS_36.map((one) => ({ lead: one.lead, text: `${one.lead} ${one.text}` })));
  });

  it("draws no empty administrators label for a release whose administrators part is empty", async () => {
    const { adminLabels, versions, text } = await open(ADMIN);
    const head37 = versions().find((h) => text(h).includes("v0.3.7"));
    const head36 = versions().find((h) => text(h).includes("v0.3.6"));
    const between = adminLabels().filter((label) =>
      (head37?.compareDocumentPosition(label) ?? 0) & Node.DOCUMENT_POSITION_FOLLOWING
      && (head36?.compareDocumentPosition(label) ?? 0) & Node.DOCUMENT_POSITION_PRECEDING);
    expect(between).toEqual([]);
  });

  it("shows one line, \"No release notes yet\", when the list is empty", async () => {
    const { section, versions, text } = await open({ version: "v0.3.7", releases: [] });
    expect(versions()).toEqual([]);
    expect(section()?.querySelectorAll("li")).toHaveLength(0);
    const card = /** @type {HTMLElement} */ (section()?.closest(".card") ?? section());
    expect(text(card).replace(/^Release notes\s*/, "")).toBe("No release notes yet");
  });

  it("shows the same empty line under fixtures (version null, releases empty)", async () => {
    const { section } = await open({ version: null, releases: [] });
    expect(section()?.textContent).toMatch(/No release notes yet/);
  });

  it("draws the notes as plain text: no HTML or Markdown is interpreted", async () => {
    const { section, itemsOf } = await open({
      version: "v0.3.7",
      releases: [{ version: "v0.3.7", forEveryone: [{ lead: "**Bold?**", text: "<img src=x onerror=alert(1)> stays text." }] }],
    });
    expect(section()?.querySelector("img")).toBeNull();
    expect(bulletOf(itemsOf("v0.3.7")[0])).toEqual({ lead: "**Bold?**", text: "**Bold?** <img src=x onerror=alert(1)> stays text." });
  });

  it("records nothing: no dismiss, no write, no what's-new request of its own", async () => {
    await open(ADMIN);
    await settle();
    expect(requests.filter((r) => r.method !== "GET"), "writes").toEqual([]);
    expect(requests.filter((r) => r.path.startsWith("/api/whats-new")), "what's-new requests").toEqual([]);
  });

  it("leaves the rest of the page as it was: This Orbit still reads its facts", async () => {
    await open(MEMBER);
    expect(requests.some((r) => r.path === "/api/about")).toBe(true);
    expect(document.getElementById("about-credits")).not.toBeNull();
    expect(document.getElementById("about-licences")).not.toBeNull();
  });
});

/*
 * #1713, owner decision 100 (note 52991): each version heading links to that
 * version's GitHub release. The URL is exactly
 * https://github.com/tomlawesome/orbit/releases/tag/v<version>, with one "v":
 * versions are written "vX.Y.Z" (release-version.ts), so a written "v" is not
 * doubled; a bare "0.3.9" gains one. The link text is the version; the
 * " · this Orbit" marker stays outside it. Same link for every role, no role
 * check, an ordinary same-tab link with rel="noreferrer".
 */
describe("each release heading links to its GitHub release (#1713, decision 100)", () => {
  const RELEASE = "https://github.com/tomlawesome/orbit/releases/tag/";
  const anchorsIn = (/** @type {Element | null | undefined} */ el) => [...(el?.querySelectorAll("a") ?? [])];
  const headOf = (/** @type {Element[]} */ heads, /** @type {string} */ version) =>
    heads.find((h) => (h.textContent ?? "").includes(version));

  it("links a version written with its leading v to exactly one v in the URL", async () => {
    const { versions } = await open(MEMBER);
    const [anchor] = anchorsIn(headOf(versions(), "v0.3.8"));
    expect(anchor?.getAttribute("href")).toBe(`${RELEASE}v0.3.8`);
    expect(anchor?.getAttribute("href")).not.toMatch(/vv/);
  });

  it("links a version written without a leading v, adding the one v", async () => {
    const { versions } = await open({ version: null, releases: [{ version: "0.3.9", forEveryone: EVERYONE_37 }] });
    const [anchor] = anchorsIn(versions()[0]);
    expect(anchor?.getAttribute("href")).toBe(`${RELEASE}v0.3.9`);
    expect(anchor?.textContent).toBe("0.3.9");
  });

  it("uses the version as the link text", async () => {
    const { versions } = await open(ADMIN);
    expect(versions().map((h) => anchorsIn(h)[0]?.textContent)).toEqual(["v0.3.8", "v0.3.7", "v0.3.6"]);
  });

  it("is an ordinary same-tab link with rel=\"noreferrer\"", async () => {
    const { versions } = await open(MEMBER);
    for (const head of versions()) {
      const [anchor] = anchorsIn(head);
      expect(anchor, "an anchor in the heading").toBeTruthy();
      expect(anchor.getAttribute("rel")).toBe("noreferrer");
      expect(anchor.hasAttribute("target"), "no target: same tab").toBe(false);
      expect(anchor.hasAttribute("download")).toBe(false);
    }
  });

  it("keeps the \" · this Orbit\" marker outside the anchor, on the running version only", async () => {
    const { versions, text } = await open(MEMBER);
    const running = headOf(versions(), "v0.3.7");
    const [anchor] = anchorsIn(running);
    expect(anchor?.textContent).toBe("v0.3.7");
    expect(text(running)).toMatch(/v0\.3\.7\s*·\s*this Orbit$/);
    expect(text(anchor)).not.toMatch(/this Orbit/);
    expect(text(headOf(versions(), "v0.3.8"))).not.toMatch(/this Orbit/);
  });

  it("draws one link per release, and no other link in the card", async () => {
    const { section, versions } = await open(ADMIN);
    expect(versions().map((h) => anchorsIn(h).length)).toEqual([1, 1, 1]);
    expect(anchorsIn(section())).toHaveLength(3);
  });

  it("draws the same links for a member and an administrator", async () => {
    const hrefs = async (/** @type {unknown} */ notes) => {
      const { versions } = await open(notes);
      const out = versions().map((h) => ({ href: anchorsIn(h)[0]?.getAttribute("href"), rel: anchorsIn(h)[0]?.getAttribute("rel") }));
      page.unmount();
      return out;
    };
    const member = await hrefs(MEMBER);
    const admin = await hrefs(ADMIN);
    expect(member.length).toBeGreaterThan(0);
    expect(admin.filter((a) => member.some((m) => m.href === a.href))).toEqual(member);
    expect(admin.map((a) => a.href)).toEqual(["v0.3.8", "v0.3.7", "v0.3.6"].map((v) => RELEASE + v));
    expect(member.map((a) => a.rel)).toEqual(["noreferrer", "noreferrer"]);
  });

  it("has no role check around the link in the page source", async () => {
    const { readFileSync } = await import("node:fs");
    const source = readFileSync(`${process.cwd()}/web/src/${PAGE}`, "utf8");
    const heading = source.match(/<h3 class="group"[\s\S]*?<\/h3>/)?.[0] ?? "";
    expect(heading).toContain("github.com/tomlawesome/orbit/releases/tag/");
    expect(heading).not.toMatch(/admin|role/i);
  });
});

describe("#1781 system packages (About page)", () => {
  const lib = (/** @type {string} */ name, /** @type {"npm" | "apk"} */ kind) => ({
    name, version: "1.0.0", licence: "MIT", author: "", kind,
    source: kind === "apk" ? `https://pkgs.alpinelinux.org/package/v3.22/main/x86_64/${name}` : `https://www.npmjs.com/package/${name}`,
  });
  const LIBS = [lib("zod", "npm"), lib("busybox", "apk"), lib("zlib", "apk")];
  const text = (/** @type {Element | null | undefined} */ el) => (el?.textContent ?? "").replace(/\s+/g, " ").trim();

  async function openWith(/** @type {unknown} */ libraries) {
    const { flushSync } = await page.mount(PAGE, { data: { libraries, releaseNotes: null } }, { url: "http://localhost/about" });
    await settle();
    flushSync();
  }

  it("#1781 system packages: the index line reads \"System packages · <count>\" and links the group", async () => {
    await openWith(LIBS);
    const link = document.querySelector('nav[aria-label="Credits index"] a[href="#credits-system-packages"]');
    expect(text(link)).toBe("System packages · 2");
  });

  it("#1781 system packages: the group sits between Libraries and Sidecar images and lists its entries without a letter index", async () => {
    await openWith(LIBS);
    const heading = document.getElementById("credits-system-packages");
    expect(heading?.tagName).toBe("H3");
    expect(text(heading)).toBe("System packages");
    const pos = (/** @type {string} */ id) => /** @type {Element} */ (document.getElementById(id));
    expect(pos("credits-libraries").compareDocumentPosition(pos("credits-system-packages")) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy();
    expect(pos("credits-system-packages").compareDocumentPosition(pos("credits-sidecars")) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy();
    const html = document.body.innerHTML;
    const start = html.indexOf('id="credits-system-packages"');
    const end = html.indexOf('id="credits-sidecars"');
    const between = html.slice(start, end);
    expect(between).toContain("busybox");
    expect(between).toContain("zlib");
    expect(between).not.toContain("zod");
    expect(between).not.toContain('class="letters"');
  });

  it("#1781 system packages: with no bill of materials it shows \"—\" and the same not-shown note as Libraries", async () => {
    await openWith(null);
    const link = document.querySelector('nav[aria-label="Credits index"] a[href="#credits-system-packages"]');
    expect(text(link)).toBe("System packages · —");
    const html = document.body.innerHTML;
    const notes = (/** @type {string} */ from, /** @type {string} */ to) =>
      html.slice(html.indexOf(`id="${from}"`), html.indexOf(`id="${to}"`)).match(/not shown — this build carries no bill of materials[^<]*/g) ?? [];
    expect(notes("credits-libraries", "credits-system-packages")).toHaveLength(1);
    expect(notes("credits-system-packages", "credits-sidecars")).toEqual(notes("credits-libraries", "credits-system-packages"));
  });
});
