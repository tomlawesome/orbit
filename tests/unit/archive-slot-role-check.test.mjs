import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { archiveForm, encodeForm } from "../integration/support/portable-archive-upload.ts";

/*
 * #1390 review round, ruling 4: the slot is taken only after the role check.
 *
 * Today hooks.server.js claims the process-wide archive slot for any
 * signed-in user, before the route has checked that the user may export or
 * import in that household. So a signed-in member of another household (or of
 * none) who opens an archive request and sends nothing holds the slot, and
 * the owner's real import is refused as busy. Only a person allowed to export
 * or import that household may take the slot. The 30 KiB per 30 s rule is
 * untouched.
 *
 * The real hooks `handle` and the real routes run; the session and the
 * household role check (requirePortableArchiveAccess) are mocked, as in
 * hooks-server-archive-slot.test.mjs and portable-archive-routes.test.mjs.
 * Whatever the fix does (the route claiming the slot after its check, or the
 * hook checking first), the observable is the same: a refused person's
 * unfinished request never makes an allowed person's request a 429.
 *
 * #1792: the upload is spooled to disk before the slot is claimed, so the
 * repository's real `spoolPortableArchiveUpload` runs here, under a temporary
 * DOCUMENTS_ROOT. While an upload is still arriving, a second one from the
 * same account is refused by the per-account lane rather than the slot.
 */
const COLD_IMPORT_TIMEOUT_MS = 30_000;
const MIB = 1_048_576;
const HOUSEHOLD = "22222222-2222-4222-8222-222222222222";
const PASSPHRASE = "a-long-enough-passphrase";
const FILE = Buffer.from("not read by the stubbed engine");

const mocks = vi.hoisted(() => ({
  readSession: vi.fn(),
  requireSession: vi.fn(),
  assertCsrf: vi.fn(),
  getAuthConfig: vi.fn(),
  hasOnwardHousehold: vi.fn(),
  readEffectiveMaintenance: vi.fn(),
  assertOutsideMaintenance: vi.fn(),
  getKeyState: vi.fn(),
  requireRecentAuthentication: vi.fn(),
  requirePortableArchiveAccess: vi.fn(),
  createPortableArchive: vi.fn(),
  importPortableArchive: vi.fn(),
  previewPortableImport: vi.fn(),
  realSpool: /** @type {undefined | ((file: ReadableStream<Uint8Array>, declaredBytes: number) => Promise<unknown>)} */ (undefined),
}));

vi.mock("orbit/lib/auth/session", () => ({
  readSession: mocks.readSession,
  requireSession: mocks.requireSession,
  assertCsrf: mocks.assertCsrf,
}));
vi.mock("orbit/lib/env", () => ({ getAuthConfig: mocks.getAuthConfig }));
vi.mock("orbit/server/workspace-repository", () => ({ hasOnwardHousehold: mocks.hasOnwardHousehold }));
vi.mock("orbit/server/maintenance", () => ({
  readEffectiveMaintenance: mocks.readEffectiveMaintenance,
  assertOutsideMaintenance: mocks.assertOutsideMaintenance,
}));
vi.mock("orbit/server/key-state", async (importOriginal) => ({ ...(await importOriginal()), getKeyState: mocks.getKeyState }));
vi.mock("orbit/server/upload-limit", () => ({ readEffectiveUploadLimit: async () => 50 * MIB }));
vi.mock("orbit/lib/auth/recent-auth", () => ({ requireRecentAuthentication: mocks.requireRecentAuthentication }));
vi.mock("orbit/server/portable-archive-repository", async (importOriginal) => {
  const real = await importOriginal();
  mocks.realSpool = real.spoolPortableArchiveUpload;
  return {
    requirePortableArchiveAccess: mocks.requirePortableArchiveAccess,
    createPortableArchive: mocks.createPortableArchive,
    importPortableArchive: mocks.importPortableArchive,
    previewPortableImport: mocks.previewPortableImport,
    spoolPortableArchiveUpload: (...args) => mocks.spool(...args),
  };
});
// The real spool, called through a spy so a test can see that it ran.
mocks.spool = vi.fn((...args) => {
  if (typeof mocks.realSpool !== "function") throw new Error("spoolPortableArchiveUpload does not exist yet");
  return mocks.realSpool(...args);
});

const PREVIEW = "/api/portable-archives/preview";
const IMPORT = "/api/portable-archives/import";
const EXPORT = "/api/households/[householdId]/portable-archives";

/** Who is signed in, by the session cookie's value. */
const people = {
  owner: { id: "owner-1", email: "owner@example.com" },
  outsider: { id: "outsider-1", email: "outsider@example.com" },
};

/** @type {import("@sveltejs/kit").Handle} */
let handle;
/** @type {typeof import("../../web/src/lib/server/archive-slot.js")} */
let slot;
/** @type {Record<string, (event: unknown) => Promise<Response>>} */
let posts;
/** @type {typeof import("orbit/lib/app-error").AppError} */
let AppError;

/** @type {Array<() => void>} */
let cleanups = [];

let documentsRoot;
let quarantineRoot;
const savedEnvironment = {};
const ENVIRONMENT = ["DOCUMENTS_ROOT", "DOCUMENTS_QUARANTINE_ROOT", "DOCUMENT_KEK"];

beforeAll(async () => {
  for (const name of ENVIRONMENT) savedEnvironment[name] = process.env[name];
  documentsRoot = mkdtempSync(join(tmpdir(), "orbit-role-check-documents-"));
  quarantineRoot = mkdtempSync(join(tmpdir(), "orbit-role-check-quarantine-"));
  process.env.DOCUMENTS_ROOT = documentsRoot;
  process.env.DOCUMENTS_QUARANTINE_ROOT = quarantineRoot;
  // A test-only key of zeroes, as the integration fixtures use.
  process.env.DOCUMENT_KEK = "00".repeat(32);
  (await import("orbit/server/documents/config")).resetDocumentConfigForTests();
  ({ handle } = await import("../../web/src/hooks.server.js"));
  slot = await import("../../web/src/lib/server/archive-slot.js");
  ({ AppError } = await import("orbit/lib/app-error"));
  posts = {
    [PREVIEW]: (await import("../../web/src/routes/api/portable-archives/preview/+server.js")).POST,
    [IMPORT]: (await import("../../web/src/routes/api/portable-archives/import/+server.js")).POST,
    [EXPORT]: (await import("../../web/src/routes/api/households/[householdId]/portable-archives/+server.js")).POST,
  };
}, COLD_IMPORT_TIMEOUT_MS);

afterAll(async () => {
  for (const name of ENVIRONMENT) {
    if (savedEnvironment[name] === undefined) delete process.env[name];
    else process.env[name] = savedEnvironment[name];
  }
  (await import("orbit/server/documents/config")).resetDocumentConfigForTests();
  rmSync(documentsRoot, { recursive: true, force: true });
  rmSync(quarantineRoot, { recursive: true, force: true });
});

beforeEach(() => {
  cleanups = [];
  delete process.env.ORBIT_FIXTURES;
  for (const [name, mock] of Object.entries(mocks)) if (name !== "realSpool" && name !== "spool") mock.mockReset();
  mocks.spool.mockClear();
  mocks.getKeyState.mockReturnValue({ verdict: "usable", heldKeyId: "a".repeat(24) });
  mocks.readEffectiveMaintenance.mockResolvedValue({ effectivelyActive: false, expectedEndAt: null });
  mocks.assertOutsideMaintenance.mockResolvedValue(undefined);
  mocks.getAuthConfig.mockReturnValue({ secureCookies: false });
  const sessionOf = async (cookies) => {
    const user = people[cookies.get("orbit-session")];
    return user ? { id: `session-${user.id}`, user: { ...user, isInstanceAdmin: false }, activeHouseholdId: HOUSEHOLD } : null;
  };
  mocks.readSession.mockImplementation(sessionOf);
  mocks.requireSession.mockImplementation(async (cookies) => (await sessionOf(cookies)) ?? Promise.reject(new AppError("unauthorized", "Sign in", 401)));
  mocks.requireRecentAuthentication.mockResolvedValue({});
  // Only the owner may export or import; the outsider is told the household is not available.
  mocks.requirePortableArchiveAccess.mockImplementation(async (userId) => {
    if (userId !== "owner-1") throw new AppError("household_not_found", "That household is not available", 404);
  });
  mocks.createPortableArchive.mockResolvedValue({ id: "archive-1", expiresAt: "2026-09-27T00:00:00.000Z", includesDocuments: false });
  mocks.importPortableArchive.mockImplementation(async (input) => { await new Response(input.archive).arrayBuffer(); return { importedItems: 1, documentsExcluded: 0 }; });
  mocks.previewPortableImport.mockImplementation(async (_user, _household, archive) => { await new Response(archive).arrayBuffer(); return { householdName: "Home", items: 1 }; });
});

afterEach(() => {
  for (const clean of cleanups) clean();
});

/**
 * A request event for `route` from `who`, carrying `body`. The path matches
 * the route id; the export's household is a path parameter.
 */
function eventFor(route, who, body, contentType) {
  const path = route.replace("[householdId]", HOUSEHOLD);
  const cookies = { "orbit-session": who };
  return {
    route: { id: route },
    url: new URL(`http://orbit.invalid${path}`),
    params: { householdId: HOUSEHOLD },
    request: new Request(`http://orbit.invalid${path}`, { method: "POST", headers: { "content-type": contentType }, body, duplex: "half" }),
    isDataRequest: false,
    locals: {},
    fetch: vi.fn(),
    cookies: { get: (name) => cookies[name], set: vi.fn(), delete: vi.fn() },
  };
}

/** The pipeline as production runs it: hooks `handle`, then the route as `resolve`. */
function run(route, who, body, contentType) {
  const event = eventFor(route, who, body, contentType);
  return handle({ event, resolve: (resolved) => posts[route](resolved) });
}

/** Whole, valid request bytes for `route`. */
async function completeRequest(route) {
  if (route === EXPORT) return { body: JSON.stringify({ passphrase: PASSPHRASE, includeDocuments: false }), contentType: "application/json" };
  const fields = route === IMPORT
    ? { householdId: HOUSEHOLD, passphrase: PASSPHRASE, conflictItemIds: [] }
    : { householdId: HOUSEHOLD, passphrase: PASSPHRASE };
  const upload = await encodeForm(archiveForm(fields, FILE));
  return { body: new Uint8Array(upload.bytes), contentType: upload.contentType };
}

/**
 * A request that has begun and then stops: `prefix` is sent, and the body
 * stays open until the test lets go.
 */
function stalledAfter(prefix) {
  let controller;
  const body = new ReadableStream({
    start(c) {
      controller = c;
      if (prefix.length > 0) c.enqueue(prefix);
    },
  });
  cleanups.push(() => { try { controller.close(); } catch { /* already closed */ } });
  return body;
}

describe("ruling 4: a signed-in person with no right to the household cannot take the archive slot", () => {
  it.each([PREVIEW, IMPORT, EXPORT])("%s: an outsider who opens a request and sends nothing does not make the owner's request busy", async (route) => {
    // Catches the slot taken in hooks.server.js on a session alone: the outsider's silent request holds it and the owner gets a 429.
    const { contentType } = await completeRequest(route);
    const outsider = run(route, "outsider", stalledAfter(new Uint8Array(0)), contentType).catch(() => null);
    await new Promise((resolve) => setTimeout(resolve, 50));

    const request = await completeRequest(route);
    const owner = await run(route, "owner", request.body, request.contentType);

    expect(owner.status, "the owner is allowed and nobody allowed is using the slot").not.toBe(429);
    expect(owner.status).toBe(200);
    cleanups.forEach((clean) => clean());
    await outsider;
  });

  it.each([PREVIEW, IMPORT])("%s: an outsider who sends the form fields and then stops is refused 404 at once, and the slot is free for the owner", async (route) => {
    // The fields come first, so the role check can run before the file: the outsider is answered without the body finishing.
    const full = await completeRequest(route);
    const bytes = Buffer.from(full.body);
    const marker = bytes.indexOf('name="archive"');
    const fieldsEnd = bytes.indexOf("\r\n\r\n", marker) + 4;
    const outsider = run(route, "outsider", stalledAfter(new Uint8Array(bytes.subarray(0, fieldsEnd + 4))), full.contentType);
    const answered = await Promise.race([outsider, new Promise((resolve) => setTimeout(() => resolve("still waiting"), 2_000))]);
    expect(answered, "the outsider is answered before the file arrives").not.toBe("still waiting");
    expect(answered.status).toBe(404);

    expect(slot.archiveSlotHeld(), "a refused outsider leaves the slot free").toBe(false);
    const owner = await run(route, "owner", full.body, full.contentType);
    expect(owner.status).toBe(200);
  });

  it("the owner's own request still holds their upload lane: a second request from the owner is refused as busy while the first is uploading", async () => {
    // Pins that the rule is narrowed, not removed: one archive upload at a time per account (#1792: the lane, not the slot, while it uploads).
    const route = IMPORT;
    const first = await completeRequest(route);
    const bytes = Buffer.from(first.body);
    const marker = bytes.indexOf('name="archive"');
    const fieldsEnd = bytes.indexOf("\r\n\r\n", marker) + 4;
    const running = run(route, "owner", stalledAfter(new Uint8Array(bytes.subarray(0, fieldsEnd + 4))), first.contentType).catch(() => null);
    await vi.waitFor(() => expect(slot.uploadLaneHeld("owner-1")).toBe(true));

    const second = await completeRequest(route);
    const refused = await run(route, "owner", second.body, second.contentType);
    expect(refused.status).toBe(429);
    expect((await refused.json()).error.code).toBe("archive_busy");
    cleanups.forEach((clean) => clean());
    await running;
  });
});

/*
 * #1792 (T-F10): the slot is claimed by the route and released in its
 * `finally` (ruling 4), so these run the real routes. They moved here from
 * hooks-server-archive-slot.test.mjs, whose stand-in routes never claimed the
 * slot and so passed whatever the routes did.
 */

/** A request that sends its form fields and the start of the file, then drops, as a client that goes away does. */
async function droppedAfterFields(route) {
  const full = await completeRequest(route);
  const bytes = Buffer.from(full.body);
  const marker = bytes.indexOf('name="archive"');
  const fieldsEnd = bytes.indexOf("\r\n\r\n", marker) + 4;
  const prefix = new Uint8Array(bytes.subarray(0, fieldsEnd + 4));
  const body = new ReadableStream({
    start(controller) { controller.enqueue(prefix); },
    pull(controller) { controller.error(new Error("aborted")); },
  });
  return { body, contentType: full.contentType };
}

/** The slot is free: the owner's next whole request to `route` runs and answers 200. */
async function expectFreeFor(route) {
  expect(slot.archiveSlotHeld(), "nothing holds the slot").toBe(false);
  const request = await completeRequest(route);
  const next = await run(route, "owner", request.body, request.contentType);
  expect(next.status, "the next request is not refused as busy").toBe(200);
}

/** Each route's engine, by route. */
const engine = () => ({ [PREVIEW]: mocks.previewPortableImport, [IMPORT]: mocks.importPortableArchive, [EXPORT]: mocks.createPortableArchive });

describe("the route frees the slot however its request ends", () => {
  it.each([PREVIEW, IMPORT, EXPORT])("%s: when its work fails with an error it answers (422)", async (route) => {
    // Catches a route that releases only on success: one failed import would leave every later archive request a 429.
    engine()[route].mockImplementationOnce(async () => { throw new AppError("archive_import_failed", "Nothing was imported", 422); });
    const request = await completeRequest(route);
    const response = await run(route, "owner", request.body, request.contentType);
    expect(response.status).toBe(422);
    await expectFreeFor(route);
  });

  it.each([PREVIEW, IMPORT, EXPORT])("%s: when its work throws unexpectedly (500)", async (route) => {
    engine()[route].mockImplementationOnce(async () => { throw new Error("the engine fell over"); });
    const request = await completeRequest(route);
    const response = await run(route, "owner", request.body, request.contentType);
    expect(response.status).toBe(500);
    await expectFreeFor(route);
  });

  it.each([PREVIEW, IMPORT])("%s: when the client drops while the archive file is being read", async (route) => {
    // #1792: the drop ends the spool; nothing is processed, and the lane and the slot are both free after.
    const { body, contentType } = await droppedAfterFields(route);
    const response = await run(route, "owner", body, contentType).catch(() => null);
    expect(mocks.spool, "the file was being taken in").toHaveBeenCalledTimes(1);
    expect(engine()[route], "an unfinished upload is not processed").not.toHaveBeenCalled();
    expect(response?.status ?? 0).not.toBe(200);
    await expectFreeFor(route);
  });
});

describe("a caller who is not signed in", () => {
  it.each([PREVIEW, IMPORT, EXPORT])("%s: is answered 401, not 429, while the owner's request holds the slot", async (route) => {
    // #1792: the slot is held while the owner's import is processing (its engine is held open), no longer while it uploads.
    let open;
    const processing = new Promise((resolve) => { open = resolve; });
    cleanups.push(() => open());
    mocks.importPortableArchive.mockImplementationOnce(async (input) => { await new Response(input.archive).arrayBuffer(); await processing; return { importedItems: 1, documentsExcluded: 0 }; });
    const first = await completeRequest(IMPORT);
    const holder = run(IMPORT, "owner", first.body, first.contentType).catch(() => null);
    await vi.waitFor(() => expect(slot.archiveSlotHeld()).toBe(true));

    const request = await completeRequest(route);
    const response = await run(route, "nobody", request.body, request.contentType);
    expect(response.status).toBe(401);
    cleanups.forEach((clean) => clean());
    await holder;
  });

  it.each([PREVIEW, IMPORT, EXPORT])("%s: never claims the slot: while its request is open, the owner's is not refused", async (route) => {
    // Catches the slot claimed before the sign-in check: a signed-out request that sends nothing would hold it.
    const { contentType } = await completeRequest(route);
    const signedOut = run(route, "nobody", stalledAfter(new Uint8Array(0)), contentType).catch(() => null);
    await new Promise((resolve) => setTimeout(resolve, 50));
    expect(slot.archiveSlotHeld()).toBe(false);

    const request = await completeRequest(route);
    const owner = await run(route, "owner", request.body, request.contentType);
    expect(owner.status).toBe(200);
    cleanups.forEach((clean) => clean());
    await signedOut;
  });
});
