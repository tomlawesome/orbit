import { readFileSync } from "node:fs";
import { resolve } from "node:path";

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

/*
 * #1245, the other half: a document picked on the desk's /create is read
 * the moment it is picked, the way design/v19/create-v3.html's `doc` → `snap`
 * walk and design/owner-decisions.md §14 ratified — the lanes split, "Focusing
 * on the anomaly" breathes, and page one lands on the top sheet as soon as it
 * is drawn, while the inspection (scan + extraction) runs alongside. The sheet
 * used to be a sketched British Gas placeholder that nothing ever reached.
 *
 * The two client helpers are driven here with a stubbed fetch, the way
 * v19-create-attaches-document.test.js drives `attachItemDocument`; the form
 * has no import surface a plain test can mount, so its behaviour is pinned
 * against the file's own text and tests/e2e/v19-create.spec.ts proves the
 * journey.
 */

const here = (/** @type {string} */ rel) => readFileSync(resolve(import.meta.dirname, rel), "utf8");

/** @type {{ url: string, init: RequestInit }[]} */
let posts = [];

/** @param {(href: string) => Response} answer */
function stubFetch(answer) {
  posts = [];
  vi.stubGlobal("fetch", vi.fn(async (url, init) => {
    const href = String(url);
    if (href.includes("/api/auth/session")) {
      return new Response(JSON.stringify({ user: { id: "u1" }, csrfToken: `t${posts.length}` }), { status: 200 });
    }
    if (init?.method === "POST") {
      posts.push({ url: href, init });
      return answer(href);
    }
    throw new Error(`unexpected fetch: ${href}`);
  }));
}

const file = () => new File([new Uint8Array([37, 80, 68, 70])], "my policy.pdf", { type: "application/pdf" });

beforeEach(() => {
  vi.resetModules();
  vi.stubGlobal("URL", Object.assign(URL, { createObjectURL: vi.fn(() => "blob:page-one"), revokeObjectURL: vi.fn() }));
});

afterEach(() => {
  vi.unstubAllGlobals();
});

describe("#1245: previewPickedDocument draws page one of a picked file before any item exists", () => {
  it("posts the bytes to the household's pre-attachment preview route and hands back a picture", async () => {
    stubFetch(() => new Response(new Uint8Array([0xff, 0xd8, 0xff]), {
      status: 200, headers: { "content-type": "image/jpeg", "x-orbit-scan": "clean" },
    }));
    const { previewPickedDocument } = await import("../../web/src/lib/data/workspace.js");
    const picked = file();
    const preview = await previewPickedDocument("h 1", picked);

    expect(preview).toEqual({ url: "blob:page-one", scanned: true });
    expect(posts).toHaveLength(1);
    expect(posts[0].url).toBe("/api/households/h%201/item-document-preview");
    expect(posts[0].init.body).toBe(picked);
    expect(posts[0].init.headers).toMatchObject({
      "content-type": "application/pdf",
      "x-csrf-token": "t0",
      "x-orbit-filename": "my%20policy.pdf",
      "x-orbit-declared-bytes": "4",
    });
  });

  it("says when the page was drawn without a scan", async () => {
    stubFetch(() => new Response(new Uint8Array([1]), { status: 200, headers: { "content-type": "image/png", "x-orbit-scan": "skipped" } }));
    const { previewPickedDocument } = await import("../../web/src/lib/data/workspace.js");
    await expect(previewPickedDocument("h1", file())).resolves.toMatchObject({ scanned: false });
  });

  it("throws the server's own refusal, so the lane can say so", async () => {
    stubFetch(() => new Response(JSON.stringify({ error: { code: "document_preview_unsupported", message: "Orbit cannot show a picture of this document" } }), { status: 415 }));
    const { previewPickedDocument } = await import("../../web/src/lib/data/workspace.js");
    await expect(previewPickedDocument("h1", file())).rejects.toMatchObject({ code: "document_preview_unsupported" });
  });
});

describe("#1245: inspectPickedDocument starts the read alongside the picture", () => {
  it("posts the same bytes to the household's inspection route and returns its suggestions", async () => {
    stubFetch(() => new Response(JSON.stringify({
      extracted: true, suggestions: [{ field: "provider", value: "Safe Cover", source: "document_text", confidence: "medium" }],
      attachmentDisposition: "attachable", reason: "supported_structure",
    }), { status: 200 }));
    const { inspectPickedDocument } = await import("../../web/src/lib/data/workspace.js");
    const result = await inspectPickedDocument("h1", file());
    expect(result.suggestions).toEqual([{ field: "provider", value: "Safe Cover", source: "document_text", confidence: "medium" }]);
    expect(posts[0].url).toBe("/api/households/h1/item-document-inspection");
    expect(posts[0].init.headers).toMatchObject({ "x-orbit-filename": "my%20policy.pdf", "x-orbit-declared-bytes": "4" });
  });

  it("retries a stale CSRF token once", async () => {
    let first = true;
    stubFetch(() => {
      if (first) { first = false; return new Response("{}", { status: 403 }); }
      return new Response(JSON.stringify({ extracted: false, suggestions: [], attachmentDisposition: "attachable", reason: "supported_structure" }), { status: 200 });
    });
    const { inspectPickedDocument } = await import("../../web/src/lib/data/workspace.js");
    await inspectPickedDocument("h1", file());
    expect(posts).toHaveLength(2);
  });
});

describe("#1245: the desk form reads the document the moment it is picked", () => {
  const behaviour = here("../../web/src/routes/create/create.behaviour.js");
  const page = here("../../web/src/routes/create/+page.svelte");
  const css = here("../../web/src/routes/create/create.css");
  const takeFile = behaviour.slice(behaviour.indexOf("function takeFile"), behaviour.indexOf('on(dropzone, "click"'));

  it("starts the picture and the inspection together from the pick, not from the save", () => {
    expect(takeFile).toMatch(/previewPickedDocument\(/u);
    expect(takeFile).toMatch(/inspectPickedDocument\(/u);
    const submitHandler = behaviour.slice(behaviour.indexOf('on(card, "submit"'));
    expect(submitHandler).not.toMatch(/previewPickedDocument|inspectPickedDocument/u);
  });

  it("lands the top sheet (body.snap, create-v3's own state) when the picture arrives", () => {
    expect(behaviour).toMatch(/classList\.add\("snap"\)/u);
    expect(behaviour).not.toMatch(/`body\.snap` is never\s+added/u);
  });

  it("draws the real page on the sheet, where the sketched placeholder used to sit", () => {
    expect(page).not.toMatch(/sketched placeholder/u);
    expect(page).not.toMatch(/viewBox="0 0 300 424"/u);
    expect(page).toMatch(/<img id="sheet-page"/u);
    expect(css).toMatch(/\.create-page \.sheet img\{/u);
  });

  it("keeps the ratified copy: the lane reads 'Reading your document' until the page is up, then 'Page one'", () => {
    expect(page).toMatch(/>Reading your document</u);
    expect(page).toMatch(/Focusing on the anomaly/u);
    expect(behaviour).toMatch(/"Page one"/u);
    expect(page).toMatch(/Page one of the file you added/u);
  });

  it("offers 'not this one', which drops the file and what it suggested", () => {
    expect(page).toMatch(/id="rc-drop"[^>]*>not this one</u);
    expect(behaviour).toMatch(/on\(dropFile, "click"/u);
  });
});
