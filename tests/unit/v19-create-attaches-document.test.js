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
 * #1316 (owner, 2026-10-13): creating an item with a document is
 * all-or-nothing. The save no longer uploads onto an item it has just
 * created; it STAGES the file first (`stageDocument`, POST
 * /api/households/:id/documents, a document with no item) and then sends one
 * item.upsert carrying `documentIds`. `attachItemDocument` stays for the home
 * drawer, which attaches to an item that already exists.
 *
 * `stageDocument` and `attachItemDocument` are driven here with a stubbed fetch, the way
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

describe("#1316: stageDocument stores the picked file before any item exists", () => {
  it("posts the file's bytes to the household's documents route, named and with its own id", async () => {
    stubFetch([201]);
    const { stageDocument } = await import("../../web/src/lib/data/workspace.js");
    const picked = file();
    const document = await stageDocument("h 1", picked, "doc-1", "draft-1");

    expect(document).toEqual({ id: "d1", displayName: "policy.pdf" });
    expect(posts).toHaveLength(1);
    expect(posts[0].url).toBe("/api/households/h%201/documents");
    expect(posts[0].init.body).toBe(picked);
    expect(posts[0].init.headers).toMatchObject({
      "content-type": "application/pdf",
      "x-csrf-token": "t0",
      "x-orbit-filename": "my%20policy.pdf",
      "x-orbit-document-id": "doc-1",
      // The ciphertext is sealed under the draft item's id, so the stage says which.
      "x-orbit-item-id": "draft-1",
    });
  });

  it("treats a 202 (held for a scan retry) as staged", async () => {
    stubFetch([202]);
    const { stageDocument } = await import("../../web/src/lib/data/workspace.js");
    await expect(stageDocument("h1", file(), "doc-1", "draft-1")).resolves.toMatchObject({ id: "d1" });
  });

  it("retries a stale CSRF token once, under the same document id", async () => {
    stubFetch([403, 201]);
    const { stageDocument } = await import("../../web/src/lib/data/workspace.js");
    await stageDocument("h1", file(), "doc-1", "draft-1");
    expect(posts.map((one) => /** @type {Record<string, string>} */ (one.init.headers)["x-orbit-document-id"]))
      .toEqual(["doc-1", "doc-1"]);
    expect(posts.map((one) => /** @type {Record<string, string>} */ (one.init.headers)["x-orbit-item-id"]))
      .toEqual(["draft-1", "draft-1"]);
  });

  it("throws a refusal with the server's words and its status, so the form can tell a refused file from a failed send", async () => {
    stubFetch([422]);
    const { stageDocument } = await import("../../web/src/lib/data/workspace.js");
    await expect(stageDocument("h1", file(), "doc-1", "draft-1")).rejects.toMatchObject({
      name: "WorkspaceError", status: 422, message: "refused",
    });
  });

  it("throws a server error with its status, which is not a verdict on the file", async () => {
    stubFetch([500]);
    const { stageDocument } = await import("../../web/src/lib/data/workspace.js");
    await expect(stageDocument("h1", file(), "doc-1", "draft-1")).rejects.toMatchObject({ name: "WorkspaceError", status: 500 });
  });
});

describe("#1316: the desk form's save stages the picked document, then sends one command", () => {
  const behaviour = readFileSync(resolve(import.meta.dirname, "../../web/src/routes/create/create.behaviour.js"), "utf8");
  const submitHandler = behaviour.slice(behaviour.indexOf('on(card, "submit"'));

  it("stages the held attachment under its own id, before the command, and no longer attaches onto the saved item", () => {
    expect(behaviour).not.toMatch(/not wired up yet/u);
    expect(behaviour).not.toMatch(/attachItemDocument/u);
    expect(submitHandler).toMatch(/const file = held\.attachment;/u);
    expect(submitHandler).toMatch(/stageDocument\(active\.id, file, held\.attachmentId, draftId\)/u);
    expect(submitHandler.indexOf("stageDocument(")).toBeLessThan(submitHandler.indexOf("applyCommand("));
    expect(submitHandler).toMatch(/documentIds/u);
  });

  it("mints the document id per file picked, not per save attempt", () => {
    expect(submitHandler).not.toMatch(/crypto\.randomUUID/u);
    const takeFile = behaviour.slice(behaviour.indexOf("function takeFile"), behaviour.indexOf('on(dropzone, "click"'));
    expect(takeFile).toMatch(/attachmentId = crypto\.randomUUID\(\);/u);
  });
});
