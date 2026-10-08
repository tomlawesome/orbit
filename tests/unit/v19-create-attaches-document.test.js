import { readFileSync } from "node:fs";
import { resolve } from "node:path";

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

/*
 * #1245: a document picked on the desk's /create was never attached — the
 * save said "Saved. <file> was not attached — documents are not wired up
 * yet." and the item reached the belt without it. The save now uploads the
 * file to the item it has just created, through the item's own documents
 * route.
 *
 * `attachItemDocument` is driven here with a stubbed fetch, the way
 * workspace-session-guard.test.js drives workspace.js (re-imported fresh per
 * test: the session is cached at module level). The form itself has no
 * import surface a plain test can drive without a browser, so — as
 * v19-create-draft-id.test.mjs does — its submit handler is pinned against
 * the file's own text; tests/e2e/v19-create.spec.ts proves the journey.
 */

/** @type {{ url: string, init: RequestInit }[]} */
let posts = [];

/** @param {number[]} statuses  one per document POST, in order */
function stubFetch(statuses) {
  posts = [];
  const queue = [...statuses];
  vi.stubGlobal("fetch", vi.fn(async (url, init) => {
    const href = String(url);
    if (href.includes("/api/auth/session")) {
      return new Response(JSON.stringify({ user: { id: "u1" }, csrfToken: `t${posts.length}` }), { status: 200 });
    }
    if (href.includes("/documents") && init?.method === "POST") {
      posts.push({ url: href, init });
      const status = queue.shift() ?? 201;
      if (status >= 400) return new Response(JSON.stringify({ error: { code: "x", message: "refused" } }), { status });
      return new Response(JSON.stringify({ document: { id: "d1", displayName: "policy.pdf" } }), { status });
    }
    throw new Error(`unexpected fetch: ${href}`);
  }));
}

beforeEach(() => {
  vi.resetModules();
});

afterEach(() => {
  vi.unstubAllGlobals();
});

const file = () => new File([new Uint8Array([37, 80, 68, 70])], "my policy.pdf", { type: "application/pdf" });

describe("#1245: attachItemDocument uploads the picked file onto the saved item", () => {
  it("posts the file's bytes to the item's documents route, named and with its own id", async () => {
    stubFetch([201]);
    const { attachItemDocument } = await import("../../web/src/lib/data/workspace.js");
    const picked = file();
    const document = await attachItemDocument("h 1", "i1", picked, "doc-1");

    expect(document).toEqual({ id: "d1", displayName: "policy.pdf" });
    expect(posts).toHaveLength(1);
    expect(posts[0].url).toBe("/api/households/h%201/items/i1/documents");
    expect(posts[0].init.body).toBe(picked);
    expect(posts[0].init.headers).toMatchObject({
      "content-type": "application/pdf",
      "x-csrf-token": "t0",
      "x-orbit-filename": "my%20policy.pdf",
      "x-orbit-document-id": "doc-1",
    });
  });

  it("treats a 202 (held for a scan retry) as attached", async () => {
    stubFetch([202]);
    const { attachItemDocument } = await import("../../web/src/lib/data/workspace.js");
    await expect(attachItemDocument("h1", "i1", file(), "doc-1")).resolves.toMatchObject({ id: "d1" });
  });

  it("retries a stale CSRF token once, under the same document id", async () => {
    stubFetch([403, 201]);
    const { attachItemDocument } = await import("../../web/src/lib/data/workspace.js");
    await attachItemDocument("h1", "i1", file(), "doc-1");
    expect(posts.map((one) => /** @type {Record<string, string>} */ (one.init.headers)["x-orbit-document-id"]))
      .toEqual(["doc-1", "doc-1"]);
  });

  it("throws a refusal, so the form can say so", async () => {
    stubFetch([422]);
    const { attachItemDocument } = await import("../../web/src/lib/data/workspace.js");
    await expect(attachItemDocument("h1", "i1", file(), "doc-1")).rejects.toThrow("refused");
  });
});

describe("#1245: the desk form's save attaches the picked document", () => {
  const behaviour = readFileSync(resolve(import.meta.dirname, "../../web/src/routes/create/create.behaviour.js"), "utf8");
  const submitHandler = behaviour.slice(behaviour.indexOf('on(card, "submit"'));

  it("uploads the attachment onto the draft's item, and no longer says documents are unwired", () => {
    expect(behaviour).not.toMatch(/not wired up yet/u);
    expect(submitHandler).toMatch(/attachItemDocument\(active\.id, draftId, attachment, attachmentId\)/u);
  });

  it("mints the document id per file picked, not per save attempt", () => {
    expect(submitHandler).not.toMatch(/crypto\.randomUUID/u);
    const takeFile = behaviour.slice(behaviour.indexOf("function takeFile"), behaviour.indexOf('on(dropzone, "click"'));
    expect(takeFile).toMatch(/attachmentId = crypto\.randomUUID\(\);/u);
  });
});
