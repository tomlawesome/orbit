import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

/*
 * #1284: a document refused as too large (HTTP 413) used to read "Orbit could
 * not be reached (413)" on the create form's reading card. Orbit was reachable;
 * a proxy in front of it (nginx's 1 MB default) or Orbit's own
 * DOCUMENT_MAX_BYTES refused the bytes. Both forms share readPickedDocument,
 * so it is driven here with a stubbed fetch for both refusals.
 */

const file = () => new File([new Uint8Array([37, 80, 68, 70])], "big policy.pdf", { type: "application/pdf" });

/** @param {() => Response} answer */
function stubFetch(answer) {
  vi.stubGlobal("fetch", vi.fn(async (url, init) => {
    if (String(url).includes("/api/auth/session")) {
      return new Response(JSON.stringify({ user: { id: "u1" }, csrfToken: "t" }), { status: 200 });
    }
    if (init?.method === "POST") return answer();
    throw new Error(`unexpected fetch: ${String(url)}`);
  }));
}

const proxyRefusal = () => new Response("<html><body>413 Request Entity Too Large</body></html>", {
  status: 413, headers: { "content-type": "text/html" },
});
const orbitRefusal = () => new Response(
  JSON.stringify({ error: { code: "document_too_large", message: "That document exceeds the configured size limit" } }),
  { status: 413, headers: { "content-type": "application/json" } },
);
const quotaRefusal = () => new Response(
  JSON.stringify({ error: { code: "document_household_quota", message: "This household has reached its document storage limit" } }),
  { status: 413, headers: { "content-type": "application/json" } },
);

beforeEach(() => vi.resetModules());
afterEach(() => vi.unstubAllGlobals());

describe.each([
  ["a proxy's bare 413", proxyRefusal],
  ["Orbit's own document_too_large refusal", orbitRefusal],
])("#1284: %s", (_name, answer) => {
  it("says the file is too large to send, on the page and on the read, never 'could not be reached'", async () => {
    stubFetch(answer);
    const { readPickedDocument, whyLines } = await import("../../web/src/lib/data/document-read.js");
    const { page, read } = readPickedDocument("h1", file());
    const drawn = await page;
    const inspected = await read;

    expect(drawn.kind).toBe("undrawable");
    const said = whyLines(/** @type {{ why: string }} */ (drawn).why).join(" ");
    expect(said).toMatch(/too large to send/u);
    expect(said).toMatch(/larger than this orbit accepts/u);
    expect(said).not.toMatch(/could not be reached|413/u);

    expect(inspected.kind).toBe("unread");
    const message = /** @type {{ message: string }} */ (inspected).message;
    expect(message).toMatch(/too large to send/u);
    expect(message).not.toMatch(/could not be reached|413/u);
  });
});

describe("#1284: other refusals keep their wording", () => {
  it("leaves a 413 that is a storage quota, not the file's size, in the server's own words", async () => {
    stubFetch(quotaRefusal);
    const { readPickedDocument } = await import("../../web/src/lib/data/document-read.js");
    const { page } = readPickedDocument("h1", file());
    expect(await page).toEqual({ kind: "undrawable", why: "This household has reached its document storage limit" });
  });

  it("still says Orbit could not be reached for a bare 502", async () => {
    stubFetch(() => new Response("bad gateway", { status: 502 }));
    const { readPickedDocument } = await import("../../web/src/lib/data/document-read.js");
    const { page } = readPickedDocument("h1", file());
    expect(await page).toEqual({ kind: "undrawable", why: "Orbit could not be reached (502)" });
  });
});
