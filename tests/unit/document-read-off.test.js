import { readFileSync } from "node:fs";
import { resolve } from "node:path";

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

/*
 * #1459: Orbit knows when document reading is off (no TIKA_URL). The browser
 * is told by a capability flag, `documentReading`, and passes it to
 * readPickedDocument as `{ documentReading }`. Off: the inspection route is
 * never called, the page-one preview and its virus scan still are, and the
 * read settles as "attached, nothing read" rather than "could not read".
 * On (or not stated): nothing changes.
 */

const file = () => new File([new Uint8Array([37, 80, 68, 70])], "policy.pdf", { type: "application/pdf" });

/** @type {string[]} */
let posted = [];

function stubFetch() {
  posted = [];
  vi.stubGlobal("fetch", vi.fn(async (url, init) => {
    const href = String(url);
    if (href.includes("/api/auth/session")) {
      return new Response(JSON.stringify({ user: { id: "u1" }, csrfToken: "t" }), { status: 200 });
    }
    if (init?.method === "POST") {
      posted.push(href);
      if (href.includes("item-document-inspection")) {
        return new Response(JSON.stringify({ extracted: true, suggestions: [], attachmentDisposition: "attachable" }), {
          status: 200, headers: { "content-type": "application/json" },
        });
      }
      return new Response("nope", { status: 500 });
    }
    throw new Error(`unexpected fetch: ${href}`);
  }));
}

beforeEach(() => { vi.resetModules(); stubFetch(); });
afterEach(() => vi.unstubAllGlobals());

const inspections = () => posted.filter((href) => href.includes("item-document-inspection"));

describe("#1459: readPickedDocument and the documentReading flag", () => {
  it("sends no read request when document reading is off, and the outcome is not a failed read", async () => {
    const { readPickedDocument, CAP_UNREAD } = await import("../../web/src/lib/data/document-read.js");
    const { read } = readPickedDocument("h1", file(), { documentReading: false });
    const outcome = await read;

    expect(inspections()).toHaveLength(0);
    expect(outcome.kind).not.toBe("unread");
    expect(outcome.kind).not.toBe("refused");
    expect(JSON.stringify(outcome)).not.toContain(CAP_UNREAD);
  });

  it("still asks for page one (which carries the virus scan) when document reading is off", async () => {
    const { readPickedDocument } = await import("../../web/src/lib/data/document-read.js");
    const { page, read } = readPickedDocument("h1", file(), { documentReading: false });
    await Promise.all([page, read]);
    expect(posted.some((href) => !href.includes("item-document-inspection"))).toBe(true);
  });

  it("sends the read request when document reading is on", async () => {
    const { readPickedDocument } = await import("../../web/src/lib/data/document-read.js");
    const { read } = readPickedDocument("h1", file(), { documentReading: true });
    const outcome = await read;
    expect(inspections()).toHaveLength(1);
    expect(outcome.kind).toBe("read");
  });

  it("sends the read request when the flag is not stated, as before", async () => {
    const { readPickedDocument } = await import("../../web/src/lib/data/document-read.js");
    const { read } = readPickedDocument("h1", file());
    await read;
    expect(inspections()).toHaveLength(1);
  });
});

describe("#1459: the drop zone copy", () => {
  const page = readFileSync(resolve(import.meta.dirname, "../../web/src/routes/create/+page.svelte"), "utf8");

  it("says the file is attached as it is, for an install with reading off", () => {
    expect(page).toContain("The file is attached to the item as it is.");
  });

  it("keeps the extraction promise for reading-on installs, but never promises it for photos (OCR stays off)", () => {
    const promise = page.split("\n").find((line) => line.includes("extracted automatically"));
    expect(promise).toBeDefined();
    expect(promise).not.toMatch(/photo|image/iu);
  });
});

describe("#1459: the home page drop zone copy", () => {
  const home = readFileSync(resolve(import.meta.dirname, "../../web/src/routes/home/+page.svelte"), "utf8");
  const line = home.split("\n").find((one) => one.includes('id="cdrop"')) ?? "";

  it("says the file is attached as it is when reading is off", () => {
    expect(line).toContain("documentReading === false");
    expect(line).toContain("it is attached as it is");
  });

  it("keeps the reading promise when reading is on", () => {
    expect(line).toContain("we'll read what we can");
  });
});
