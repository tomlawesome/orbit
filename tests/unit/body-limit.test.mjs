import { readFileSync } from "node:fs";
import { beforeAll, beforeEach, describe, expect, it, vi } from "vitest";

/*
 * Per-route request body limits (#1285): adapter-node's BODY_SIZE_LIMIT is
 * one number for every route, and its 512 KB default refused every document
 * over 512 KB with a 500. The image now sets it to the largest body any route
 * may take, and the request pipeline (web/src/hooks.server.js, through
 * web/src/lib/server/body-limit.js) holds each route to its own: the document
 * upload routes to the administrator's upload limit, everything else to a
 * small one. An over-limit body is a 413, never a 500.
 */
const COLD_IMPORT_TIMEOUT_MS = 30_000;
const MIB = 1_048_576;

const mocks = vi.hoisted(() => ({ uploadLimit: 50 * 1_048_576, uploadLimitFails: false }));
vi.mock("orbit/server/upload-limit", () => ({
  readEffectiveUploadLimit: async () => {
    if (mocks.uploadLimitFails) throw new Error("database unavailable");
    return mocks.uploadLimit;
  },
}));

import { appErrorResponse } from "orbit/lib/app-error";
import {
  SERVER_BODY_LIMIT,
  SMALL_BODY_LIMIT,
  bodyLimitFor,
  limitRequestBody,
} from "../../web/src/lib/server/body-limit.js";

const PREVIEW = "/api/households/[householdId]/item-document-preview";
const INSPECTION = "/api/households/[householdId]/item-document-inspection";
const ITEM_DOCUMENTS = "/api/households/[householdId]/items/[itemId]/documents";
const readLimit = async () => mocks.uploadLimit;

/** @param {number} size @param {{ declare?: boolean }} [options] */
function post(size, { declare = true } = {}) {
  const bytes = new Uint8Array(size);
  const body = declare ? bytes : new ReadableStream({
    start(controller) {
      for (let at = 0; at < size; at += 64 * 1024) controller.enqueue(bytes.subarray(at, at + 64 * 1024));
      controller.close();
    },
  });
  return new Request("http://127.0.0.1:3000/api/anything", {
    method: "POST",
    headers: declare ? { "content-length": String(size), "content-type": "application/octet-stream" } : { "content-type": "application/octet-stream" },
    body,
    duplex: "half",
  });
}

beforeEach(() => {
  mocks.uploadLimit = 50 * MIB;
  mocks.uploadLimitFails = false;
});

describe("which limit a route gets", () => {
  it("holds every document upload route to the administrator's upload limit", async () => {
    mocks.uploadLimit = 3 * MIB;
    for (const route of [PREVIEW, INSPECTION, ITEM_DOCUMENTS]) {
      await expect(bodyLimitFor(route, readLimit)).resolves.toMatchObject({ limit: 3 * MIB, code: "document_too_large" });
    }
  });

  it("lets an upload route through to its own check when the limit cannot be read", async () => {
    await expect(bodyLimitFor(PREVIEW, async () => { throw new Error("no database"); }))
      .resolves.toMatchObject({ limit: 100 * MIB, code: "document_too_large" });
  });

  it("gives the portable-archive routes the server-wide ceiling, and every other route the small limit", async () => {
    await expect(bodyLimitFor("/api/portable-archives/import", readLimit)).resolves.toMatchObject({ limit: SERVER_BODY_LIMIT });
    await expect(bodyLimitFor("/api/admin/contact", readLimit)).resolves.toMatchObject({ limit: SMALL_BODY_LIMIT, code: "request_too_large" });
    await expect(bodyLimitFor(null, readLimit)).resolves.toMatchObject({ limit: SMALL_BODY_LIMIT });
  });

  it("keeps the small limit above the 512 KB every route has run under until now", () => {
    expect(SMALL_BODY_LIMIT).toBeGreaterThan(512 * 1024);
  });

  it("matches the image's server-wide BODY_SIZE_LIMIT exactly", () => {
    const dockerfile = readFileSync(new URL("../../Dockerfile", import.meta.url), "utf8");
    const [, value] = /^ENV BODY_SIZE_LIMIT=(\d+)M$/m.exec(dockerfile) ?? [];
    expect(Number(value) * MIB).toBe(SERVER_BODY_LIMIT);
  });
});

describe("holding a request to its limit", () => {
  const upload = { limit: 50 * MIB, code: "document_too_large", message: "That document exceeds the configured size limit" };
  const small = { limit: SMALL_BODY_LIMIT, code: "request_too_large", message: "That request is too large" };

  it("passes a 1.5 MB document untouched under the default limit", async () => {
    const request = post(1.5 * MIB);
    expect(limitRequestBody(request, upload)).toBe(request);
  });

  it("refuses a declared upload over the limit with a 413 before reading it", async () => {
    const answer = limitRequestBody(post(2 * MIB), { ...upload, limit: MIB });
    expect(answer).toBeInstanceOf(Response);
    expect(answer.status).toBe(413);
    // Refused unread: the client must not queue its next request behind it.
    expect(answer.headers.get("connection")).toBe("close");
    await expect(answer.json()).resolves.toMatchObject({ error: { code: "document_too_large" } });
  });

  it("refuses a large declared body to an ordinary route with a 413", async () => {
    const answer = limitRequestBody(post(2 * MIB), small);
    expect(answer.status).toBe(413);
    await expect(answer.json()).resolves.toMatchObject({ error: { code: "request_too_large" } });
  });

  it("counts a body with no declared length as it streams, and refuses it at the limit with a 413", async () => {
    const held = limitRequestBody(post(2 * MIB, { declare: false }), small);
    expect(held).toBeInstanceOf(Request);
    const failure = await held.arrayBuffer().then(() => null, (error) => error);
    expect(failure).toMatchObject({ code: "request_too_large", status: 413 });
    expect(appErrorResponse(failure).status).toBe(413);
  });

  it("delivers an undeclared body under the limit in full", async () => {
    const held = limitRequestBody(post(700 * 1024, { declare: false }), small);
    expect((await held.arrayBuffer()).byteLength).toBe(700 * 1024);
  });
});

describe("the request pipeline (hooks.server.js)", () => {
  /** @type {import("@sveltejs/kit").Handle} */
  let handle;
  beforeAll(async () => {
    ({ handle } = await import("../../web/src/hooks.server.js"));
  }, COLD_IMPORT_TIMEOUT_MS);

  /** @param {string} routeId @param {Request} request */
  async function through(routeId, request) {
    const resolve = vi.fn(async (event) => new Response(String((await event.request.arrayBuffer()).byteLength)));
    const response = await handle({ event: { request, route: { id: routeId }, url: new URL(request.url) }, resolve });
    return { response, resolved: resolve.mock.calls.length > 0 };
  }

  it("lets a 1.5 MB document reach the upload route", async () => {
    const { response, resolved } = await through(ITEM_DOCUMENTS, post(1.5 * MIB));
    expect(resolved).toBe(true);
    expect(await response.text()).toBe(String(1.5 * MIB));
  });

  it("answers 413 document_too_large for an upload over the administrator's limit, without resolving", async () => {
    mocks.uploadLimit = MIB;
    const { response, resolved } = await through(PREVIEW, post(1.5 * MIB));
    expect(resolved).toBe(false);
    expect(response.status).toBe(413);
    await expect(response.json()).resolves.toMatchObject({ error: { code: "document_too_large" } });
  });

  it("answers 413 for a large body to a route that is not an upload", async () => {
    const { response, resolved } = await through("/api/admin/contact", post(2 * MIB));
    expect(resolved).toBe(false);
    expect(response.status).toBe(413);
    await expect(response.json()).resolves.toMatchObject({ error: { code: "request_too_large" } });
  });
});
