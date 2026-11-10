import { mkdtempSync, readdirSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { archiveForm, encodeForm, fileContentOffset, readStream } from "../integration/support/portable-archive-upload.ts";

/*
 * #1792 (A-S1/W-S3; spec-security-fixes.md Part 1): an archive upload is
 * taken in whole (spooled to a file under the document storage root) before
 * the one process-wide archive slot is claimed. The slot covers only the
 * processing, so a slow upload from one household no longer makes every
 * other household's export, preview and import a 429. One preview or import
 * upload is in flight per account at a time (the lane), and a request that
 * has spooled waits in a first-come queue for the slot, up to the slot wait.
 *
 * Same harness as archive-slot-role-check.test.mjs: the real hooks `handle`
 * and the real routes run; the session and the repository's engine functions
 * are mocked. The spool itself is the repository's real
 * `spoolPortableArchiveUpload`, writing under a temporary DOCUMENTS_ROOT, so
 * the spool directory can be listed. Fake timers (setTimeout, setInterval,
 * Date) stand in for the slow link and the waits; setImmediate stays real so
 * the real file system's work can complete between steps.
 */
const COLD_IMPORT_TIMEOUT_MS = 60_000;
const MIB = 1_048_576;
const KIB = 1024;
const PASSPHRASE = "a-long-enough-passphrase";
const FILE = Buffer.alloc(6 * KIB, "archive-bytes-1792 ");

const HOUSEHOLD_A = "11111111-1111-4111-8111-111111111111";
const HOUSEHOLD_A2 = "11111111-1111-4111-8111-222222222222";
const HOUSEHOLD_B = "22222222-2222-4222-8222-222222222222";
const HOUSEHOLD_C = "33333333-3333-4333-8333-333333333333";
const HOUSEHOLD_D = "44444444-4444-4444-8444-444444444444";

const realImmediate = globalThis.setImmediate;
const realNow = () => performance.now();

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
  spoolPortableArchiveUpload: vi.fn(),
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
    spoolPortableArchiveUpload: mocks.spoolPortableArchiveUpload,
  };
});

const PREVIEW = "/api/portable-archives/preview";
const IMPORT = "/api/portable-archives/import";
const EXPORT = "/api/households/[householdId]/portable-archives";

/** Who is signed in, by the session cookie's value, and the households each owns. */
const people = {
  "owner-1": { id: "owner-1", email: "owner-1@example.com", owns: [HOUSEHOLD_A, HOUSEHOLD_A2] },
  "owner-2": { id: "owner-2", email: "owner-2@example.com", owns: [HOUSEHOLD_B] },
  "owner-3": { id: "owner-3", email: "owner-3@example.com", owns: [HOUSEHOLD_C] },
  "owner-4": { id: "owner-4", email: "owner-4@example.com", owns: [HOUSEHOLD_D] },
};

let documentsRoot;
let quarantineRoot;
const savedEnvironment = {};
const ENVIRONMENT = ["DOCUMENTS_ROOT", "DOCUMENTS_QUARANTINE_ROOT", "DOCUMENT_KEK", "ORBIT_ARCHIVE_SLOT_WAIT_MS", "ORBIT_FIXTURES"];

/** @type {import("@sveltejs/kit").Handle} */
let handle;
/** @type {any} */
let slot;
/** @type {Record<string, (event: unknown) => Promise<Response>>} */
let posts;
/** @type {typeof import("orbit/lib/app-error").AppError} */
let AppError;
/** @type {() => number} */
let archiveBodyLimit;

/** Bodies to end and requests to wait for once a test is over, so no test leaves the slot or a lane taken. */
let cleanups = [];
let pending = [];

/** What each engine call was handed: who, and the bytes of the archive stream. */
let engineCalls = [];
/** Engines held open by a test, opened again when it ends. */
let blockers = [];
/** Spools that have finished (resolved or failed). The slot wait's timer starts only after a request's spool finishes, so a test moving the clock waits for this first. */
let spoolsFinished = 0;

vi.setConfig({ testTimeout: 30_000 });

beforeAll(async () => {
  for (const name of ENVIRONMENT) savedEnvironment[name] = process.env[name];
  documentsRoot = mkdtempSync(join(tmpdir(), "orbit-1792-documents-"));
  quarantineRoot = mkdtempSync(join(tmpdir(), "orbit-1792-quarantine-"));
  process.env.DOCUMENTS_ROOT = documentsRoot;
  process.env.DOCUMENTS_QUARANTINE_ROOT = quarantineRoot;
  // A test-only key of zeroes, as the integration fixtures use.
  process.env.DOCUMENT_KEK = "00".repeat(32);
  (await import("orbit/server/documents/config")).resetDocumentConfigForTests();
  ({ handle } = await import("../../web/src/hooks.server.js"));
  slot = await import("../../web/src/lib/server/archive-slot.js");
  ({ archiveBodyLimit } = await import("../../web/src/lib/server/body-limit.js"));
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
  pending = [];
  engineCalls = [];
  blockers = [];
  spoolsFinished = 0;
  delete process.env.ORBIT_FIXTURES;
  delete process.env.ORBIT_ARCHIVE_SLOT_WAIT_MS;
  rmSync(join(documentsRoot, "portable-archives"), { recursive: true, force: true });
  for (const [name, mock] of Object.entries(mocks)) if (name !== "realSpool") mock.mockReset();
  mocks.getKeyState.mockReturnValue({ verdict: "usable", heldKeyId: "a".repeat(24) });
  mocks.readEffectiveMaintenance.mockResolvedValue({ effectivelyActive: false, expectedEndAt: null });
  mocks.assertOutsideMaintenance.mockResolvedValue(undefined);
  mocks.getAuthConfig.mockReturnValue({ secureCookies: false });
  const sessionOf = async (cookies) => {
    const person = people[cookies.get("orbit-session")];
    return person ? { id: `session-${person.id}`, user: { id: person.id, email: person.email, isInstanceAdmin: false }, activeHouseholdId: person.owns[0] } : null;
  };
  mocks.readSession.mockImplementation(sessionOf);
  mocks.requireSession.mockImplementation(async (cookies) => (await sessionOf(cookies)) ?? Promise.reject(new AppError("unauthorized", "Sign in", 401)));
  mocks.requireRecentAuthentication.mockResolvedValue({});
  mocks.requirePortableArchiveAccess.mockImplementation(async (userId, householdId) => {
    if (!people[userId]?.owns.includes(householdId)) throw new AppError("household_not_found", "That household is not available", 404);
  });
  mocks.createPortableArchive.mockResolvedValue({ id: "archive-1", expiresAt: "2026-11-10T00:00:00.000Z", includesDocuments: false });
  mocks.importPortableArchive.mockImplementation(async (input) => {
    engineCalls.push({ userId: input.userId, bytes: await readStream(input.archive) });
    return { importedItems: 1, documentsExcluded: 0 };
  });
  mocks.previewPortableImport.mockImplementation(async (userId, _household, archive) => {
    engineCalls.push({ userId, bytes: await readStream(archive) });
    return { householdName: "Home", items: 1 };
  });
  // The repository's real spool (absent before the fix, when nothing calls it).
  mocks.spoolPortableArchiveUpload.mockImplementation((file, declaredBytes) => {
    if (typeof mocks.realSpool !== "function") throw new Error("spoolPortableArchiveUpload does not exist yet");
    const spooled = mocks.realSpool(file, declaredBytes);
    spooled.then(() => { spoolsFinished += 1; }, () => { spoolsFinished += 1; });
    return spooled;
  });
});

afterEach(async () => {
  vi.useRealTimers();
  for (const blocker of blockers) blocker.open();
  for (const clean of cleanups) clean();
  await Promise.race([Promise.allSettled(pending), new Promise((resolve) => setTimeout(resolve, 3_000))]);
  // Whatever a failed test left behind, the next starts with the slot free.
  const deadline = realNow() + 3_000;
  while (slot.archiveSlotHeld() && realNow() < deadline) await new Promise((resolve) => setTimeout(resolve, 10));
  delete process.env.ORBIT_ARCHIVE_SLOT_WAIT_MS;
});

// --- helpers ----------------------------------------------------------------

/** Fake the clock the slow link, the stall watchdog and the slot wait run on; leave setImmediate real for the file system. */
function fakeClock() {
  vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout", "setInterval", "clearInterval", "Date"] });
}

/** One real turn of the event loop, so file-system work in flight can complete. */
const turn = () => new Promise((resolve) => realImmediate(resolve));

async function settle(turns = 20) {
  for (let index = 0; index < turns; index += 1) await turn();
}

/** Advances the fake clock in steps, letting real I/O finish between them. */
async function advance(totalMs, stepMs = 1_000) {
  for (let elapsed = 0; elapsed < totalMs; elapsed += stepMs) {
    await vi.advanceTimersByTimeAsync(Math.min(stepMs, totalMs - elapsed));
    await settle();
  }
}

/** Waits, in real time and without moving the fake clock, for `predicate`. */
async function until(predicate, label, timeoutMs = 4_000) {
  const deadline = realNow() + timeoutMs;
  for (;;) {
    if (await predicate()) return;
    if (realNow() > deadline) throw new Error(`timed out waiting for: ${label}`);
    await turn();
  }
}

/** Settles a promise into an object so a pending one can be told from a settled one. */
function track(promise) {
  const state = { settled: false, value: undefined, error: undefined };
  const settled = promise.then((value) => { state.settled = true; state.value = value; }, (error) => { state.settled = true; state.error = error; });
  pending.push(settled);
  return state;
}

/** The spool directory's entries: `<storageRoot>/portable-archives`. */
function spoolDirectory() {
  try {
    return readdirSync(join(documentsRoot, "portable-archives")).sort();
  } catch (error) {
    if (error.code === "ENOENT") return [];
    throw error;
  }
}
const spoolFiles = () => spoolDirectory().filter((name) => name.endsWith(".upload.tmp"));

function eventFor(route, who, household, body, contentType, headers = {}) {
  const path = route.replace("[householdId]", household);
  const cookies = { "orbit-session": who };
  return {
    route: { id: route },
    url: new URL(`http://orbit.invalid${path}`),
    params: { householdId: household },
    request: new Request(`http://orbit.invalid${path}`, { method: "POST", headers: { "content-type": contentType, ...headers }, body, duplex: "half" }),
    isDataRequest: false,
    locals: {},
    fetch: vi.fn(),
    cookies: { get: (name) => cookies[name], set: vi.fn(), delete: vi.fn() },
  };
}

/** The pipeline as production runs it: hooks `handle`, then the route as `resolve`. */
function run(route, who, household, body, contentType, headers) {
  const event = eventFor(route, who, household, body, contentType, headers);
  return handle({ event, resolve: (resolved) => posts[route](resolved) });
}

/** Whole, valid request bytes for `route` in `household`, and where the file part's content starts. */
async function requestBytes(route, household, file = FILE) {
  if (route === EXPORT) {
    return { bytes: Buffer.from(JSON.stringify({ passphrase: PASSPHRASE, includeDocuments: false })), contentType: "application/json", fileStart: -1 };
  }
  const fields = route === IMPORT
    ? { householdId: household, passphrase: PASSPHRASE, conflictItemIds: [] }
    : { householdId: household, passphrase: PASSPHRASE };
  const upload = await encodeForm(archiveForm(fields, file));
  return { bytes: upload.bytes, contentType: upload.contentType, fileStart: fileContentOffset(upload.bytes) };
}

/** A whole request, answered: the response. */
async function whole(route, who, household) {
  const request = await requestBytes(route, household);
  return run(route, who, household, new Uint8Array(request.bytes), request.contentType);
}

const END = Symbol("end");

/**
 * A body the test feeds: `send` hands the next chunk over, `end` closes it,
 * `fail` errors it (a client that went away). Pulled on demand, so `state`
 * records what the consumer actually took and whether it read to the end.
 */
function scriptedBody() {
  const queue = [];
  let wake = null;
  const state = { pulledBytes: 0, done: false };
  const push = (item) => {
    if (wake) { const resolve = wake; wake = null; resolve(item); } else queue.push(item);
  };
  const next = () => (queue.length > 0 ? Promise.resolve(queue.shift()) : new Promise((resolve) => { wake = resolve; }));
  const body = new ReadableStream({
    async pull(controller) {
      const item = await next();
      if (item === END) { state.done = true; controller.close(); return; }
      if (item instanceof Error) { controller.error(item); return; }
      state.pulledBytes += item.length;
      controller.enqueue(item);
    },
  }, { highWaterMark: 0 });
  let ended = false;
  const end = () => { if (!ended) { ended = true; push(END); } };
  cleanups.push(end);
  return { body, state, send: (bytes) => push(new Uint8Array(bytes)), end, fail: (error) => { ended = true; push(error); } };
}

/** A request whose fields and the first `fileBytes` of its file are sent, and whose rest waits for `finish()`. */
async function heldAfterFields(route, who, household, fileBytes = 4) {
  const request = await requestBytes(route, household);
  const script = scriptedBody();
  script.send(request.bytes.subarray(0, request.fileStart + fileBytes));
  const response = track(run(route, who, household, script.body, request.contentType));
  return {
    response,
    state: script.state,
    finish() { script.send(request.bytes.subarray(request.fileStart + fileBytes)); script.end(); },
    fail(error = new Error("aborted")) { script.fail(error); },
  };
}

/** A deferred the test resolves. */
function gate() {
  let open;
  const promise = new Promise((resolve) => { open = resolve; });
  return { promise, open };
}

/** The import engine for `userId` blocks on the returned gate after reading its stream: that import is processing. */
function blockImportOf(userId) {
  const blocker = gate();
  blockers.push(blocker);
  const fallback = mocks.importPortableArchive.getMockImplementation();
  mocks.importPortableArchive.mockImplementation(async (input) => {
    if (input.userId !== userId) return fallback(input);
    engineCalls.push({ userId: input.userId, bytes: await readStream(input.archive) });
    await blocker.promise;
    return { importedItems: 1, documentsExcluded: 0 };
  });
  return blocker;
}

async function errorOf(response) {
  return (await response.clone().json()).error ?? {};
}

async function expectBusy(response) {
  expect(response.status).toBe(429);
  expect(response.headers.get("retry-after")).toBe("60");
  expect(await errorOf(response)).toEqual({ code: "archive_busy", message: slot.ARCHIVE_BUSY_MESSAGE });
}

// --- R1 -----------------------------------------------------------------------

describe("R1: a slow upload does not hold the archive slot", () => {
  it("an import trickling 1 KiB every 20 s leaves the slot free: another household's export and preview answer 200 while it arrives, and the import is processed once it ends", async () => {
    // Catches the slot claimed before the file is read: for as long as the trickle lasts, every other household's archive request is 429 archive_busy.
    fakeClock();
    const request = await requestBytes(IMPORT, HOUSEHOLD_A);
    let offset = 0;
    const trickle = new ReadableStream({
      async pull(controller) {
        if (offset >= request.bytes.length) { controller.close(); return; }
        if (offset > 0) await new Promise((resolve) => setTimeout(resolve, 20_000));
        const end = offset === 0 ? request.fileStart : Math.min(offset + KIB, request.bytes.length);
        controller.enqueue(new Uint8Array(request.bytes.subarray(offset, end)));
        offset = end;
      },
    }, { highWaterMark: 0 });
    const importing = track(run(IMPORT, "owner-1", HOUSEHOLD_A, trickle, request.contentType));

    // Two chunks of the file are in; the rest is still on its way.
    await advance(41_000);
    expect(offset, "the file part has begun and has not ended").toBeGreaterThan(request.fileStart);
    expect(offset).toBeLessThan(request.bytes.length);
    expect(importing.settled).toBe(false);

    expect.soft(slot.archiveSlotHeld(), "nothing is processing: the slot is free while the file arrives").toBe(false);
    const exported = await whole(EXPORT, "owner-2", HOUSEHOLD_B);
    expect.soft(exported.status, "another household's export is not refused as busy").toBe(200);
    const previewed = await whole(PREVIEW, "owner-2", HOUSEHOLD_B);
    expect.soft(previewed.status, "another household's preview is not refused as busy").toBe(200);

    // The rest of the trickle: 6 KiB of file plus the closing delimiter, 1 KiB per 20 s.
    await advance(200_000);
    await until(() => importing.settled, "the import's answer");
    expect(importing.error).toBeUndefined();
    expect(importing.value.status).toBe(200);
    const imported = engineCalls.find((call) => call.userId === "owner-1");
    expect(imported, "the import was processed").toBeDefined();
    expect(imported.bytes.equals(FILE), "the engine read exactly the uploaded file part").toBe(true);
  }, 60_000);
});

// --- L2 -----------------------------------------------------------------------

describe("L2: the spool file is gone after every ending", () => {
  it("(a) 200: the file was spooled while the request ran and is gone after", async () => {
    // Catches a spool that is never removed on success (every archive would leave its size on the disk).
    const held = await heldAfterFields(PREVIEW, "owner-1", HOUSEHOLD_A, FILE.length - 10);
    await until(() => spoolFiles().length === 1, "the spool file exists while the file part arrives");
    held.finish();
    await until(() => held.response.settled, "the preview's answer");
    expect(held.response.value.status).toBe(200);
    expect(mocks.spoolPortableArchiveUpload).toHaveBeenCalledTimes(1);
    expect(spoolDirectory()).toEqual([]);
  });

  it("(b) a body that stalls 31 s in the file part is cut with 408 request_timeout, and the spool file is gone", async () => {
    // Catches a spool left behind when the watchdog cuts the body (the stall rule now bounds the spool phase).
    fakeClock();
    const held = await heldAfterFields(PREVIEW, "owner-1", HOUSEHOLD_A, 512);
    await until(() => spoolFiles().length === 1, "the spool file exists when the body stalls");
    await advance(31_000);
    await until(() => held.response.settled, "the preview's answer");
    expect(held.response.value.status).toBe(408);
    expect(await errorOf(held.response.value)).toMatchObject({ code: "request_timeout", message: slot.ARCHIVE_BODY_TIMED_OUT_MESSAGE });
    await until(() => spoolDirectory().length === 0, "the spool directory is empty");
  }, 30_000);

  it("(c) an import without a recent authentication is refused before any spool file exists", async () => {
    // Catches the spool (or the lane) taken before the step-up check: a refused request would write the file to disk first.
    mocks.requireRecentAuthentication.mockRejectedValue(new AppError("recent_authentication_required", "Confirm it is you", 403));
    const request = await requestBytes(IMPORT, HOUSEHOLD_A);
    const response = await run(IMPORT, "owner-1", HOUSEHOLD_A, new Uint8Array(request.bytes), request.contentType);
    expect(response.status).toBe(403);
    expect(mocks.spoolPortableArchiveUpload, "nothing was spooled").not.toHaveBeenCalled();
    expect(spoolDirectory()).toEqual([]);
    mocks.requireRecentAuthentication.mockResolvedValue({});
    expect((await whole(PREVIEW, "owner-1", HOUSEHOLD_A)).status, "the refusal took no lane: the owner's next upload is admitted").toBe(200);
  });

  it("(d) the engine refusing with 422 archive_passphrase_invalid: the spool file existed while it ran and is gone after", async () => {
    // Catches a spool removed only on success.
    let spooledWhileProcessing = null;
    mocks.previewPortableImport.mockImplementation(async (_user, _household, archive) => {
      await readStream(archive);
      spooledWhileProcessing = spoolFiles();
      throw new AppError("archive_passphrase_invalid", "That passphrase does not open this archive", 422);
    });
    const response = await whole(PREVIEW, "owner-1", HOUSEHOLD_A);
    expect(response.status).toBe(422);
    expect((await errorOf(response)).code).toBe("archive_passphrase_invalid");
    expect(spooledWhileProcessing, "the engine read from a spooled file").toHaveLength(1);
    expect(spoolDirectory()).toEqual([]);
  });

  it("(e) the body erroring mid-file (the client went away): the spool file is gone and nothing is processed", async () => {
    // Catches a half-written spool left on the disk by a client that disconnects.
    const held = await heldAfterFields(IMPORT, "owner-1", HOUSEHOLD_A, 512);
    await until(() => spoolFiles().length === 1, "the spool file exists when the client goes");
    held.fail();
    await until(() => held.response.settled, "the import's answer");
    expect(held.response.value?.status ?? 0).not.toBe(200);
    expect(mocks.importPortableArchive, "an unfinished upload is not processed").not.toHaveBeenCalled();
    await until(() => spoolDirectory().length === 0, "the spool directory is empty");
  });
});

// --- L3 -----------------------------------------------------------------------

describe("L3: one upload in flight per account", () => {
  it("a second preview from the same account (another household) is 429 archive_busy with its body read away; another account spools alongside; the lane frees when the first ends", async () => {
    // Catches no per-account bound (one account could spool many uploads at once) or a lane that is per household, or never released.
    const first = await heldAfterFields(PREVIEW, "owner-1", HOUSEHOLD_A);
    await until(() => mocks.spoolPortableArchiveUpload.mock.calls.length === 1, "owner-1's preview is spooling");

    const second = await requestBytes(PREVIEW, HOUSEHOLD_A2);
    const secondBody = scriptedBody();
    secondBody.send(second.bytes);
    secondBody.end();
    const refused = await run(PREVIEW, "owner-1", HOUSEHOLD_A2, secondBody.body, second.contentType);
    await expectBusy(refused);
    await until(() => secondBody.state.done, "the refused body is read away to its end");

    const other = await heldAfterFields(PREVIEW, "owner-2", HOUSEHOLD_B);
    await until(() => mocks.spoolPortableArchiveUpload.mock.calls.length === 2, "owner-2's preview is spooling");
    await settle();
    expect(other.response.settled, "owner-2 is not refused: lanes are per account").toBe(false);
    expect(slot.uploadLaneHeld("owner-2")).toBe(true);
    expect(slot.uploadLaneHeld("owner-1")).toBe(true);

    first.finish();
    await until(() => first.response.settled, "owner-1's first preview's answer");
    expect(first.response.value.status).toBe(200);
    expect(slot.uploadLaneHeld("owner-1")).toBe(false);
    expect((await whole(PREVIEW, "owner-1", HOUSEHOLD_A2)).status, "owner-1's next preview is admitted").toBe(200);

    other.finish();
    await until(() => other.response.settled, "owner-2's preview's answer");
    expect(other.response.value.status).toBe(200);
    expect(slot.uploadLaneHeld("owner-2")).toBe(false);
  });
});

// --- L4 -----------------------------------------------------------------------

describe("L4: the slot is exclusive during processing, and spooled requests wait for it", () => {
  it("a spooled preview waits (not 200, not 429) while another import processes, an export is still refused at once, and the waiters are served first come first served", async () => {
    // Catches a spooled request refused at once (the person would have to upload it all again), two processing at once, or a queue served out of order.
    fakeClock();
    const blocker = blockImportOf("owner-1");
    const processing = track(whole(IMPORT, "owner-1", HOUSEHOLD_A));
    await until(() => engineCalls.length === 1 && slot.archiveSlotHeld(), "owner-1's import is processing");

    const waiting = track(whole(PREVIEW, "owner-2", HOUSEHOLD_B));
    await until(() => mocks.spoolPortableArchiveUpload.mock.calls.length === 2, "owner-2's preview is spooling");
    await settle();
    const later = track(whole(PREVIEW, "owner-4", HOUSEHOLD_D));
    await until(() => mocks.spoolPortableArchiveUpload.mock.calls.length === 3, "owner-4's preview is spooling");

    await advance(5 * 60_000, 10_000);
    expect(waiting.settled, "after 5 minutes owner-2's preview is still waiting").toBe(false);
    expect(later.settled, "and owner-4's").toBe(false);
    expect(engineCalls.map((call) => call.userId), "only the holder is processing").toEqual(["owner-1"]);

    const exported = track(whole(EXPORT, "owner-3", HOUSEHOLD_C));
    await until(() => exported.settled, "the export is answered without the clock moving");
    await expectBusy(exported.value);

    blocker.open();
    await until(() => processing.settled && waiting.settled && later.settled, "all three answers", 10_000);
    expect(processing.value.status).toBe(200);
    expect(waiting.value.status).toBe(200);
    expect(later.value.status).toBe(200);
    expect(engineCalls.map((call) => call.userId), "the slot went to the one that waited longest first").toEqual(["owner-1", "owner-2", "owner-4"]);
    expect(spoolDirectory()).toEqual([]);
  }, 60_000);

  it("a spooled preview whose wait runs out at 10 minutes is 429 archive_busy, its spool file is removed, and it is never processed", async () => {
    // Catches a wait with no end (a stuck import would pile up spool files) or one that ends without removing its file.
    fakeClock();
    const blocker = blockImportOf("owner-1");
    track(whole(IMPORT, "owner-1", HOUSEHOLD_A));
    await until(() => engineCalls.length === 1 && slot.archiveSlotHeld(), "owner-1's import is processing");
    const holderSpool = spoolFiles();

    const waiting = track(whole(PREVIEW, "owner-2", HOUSEHOLD_B));
    await until(() => spoolFiles().length === 2 && mocks.spoolPortableArchiveUpload.mock.calls.length === 2, "owner-2's preview is spooled");
    // The wait's 10 minutes start when the spool finishes, not when its file appears: wait for that in real time before moving the clock.
    await until(() => spoolsFinished === 2, "owner-2's spool resolved", 20_000);
    await settle();

    await advance(9 * 60_000 + 50_000, 10_000);
    expect(waiting.settled, "at 9:50 owner-2 is still waiting").toBe(false);
    await advance(20_000);
    await until(() => waiting.settled, "owner-2's answer");
    await expectBusy(waiting.value);
    expect(spoolFiles(), "the waiter's spool file is removed; the holder's stays until its import ends").toEqual(holderSpool);

    await advance(60_000, 10_000);
    blocker.open();
    await until(() => spoolDirectory().length === 0, "nothing is left once the holder ends");
    await settle();
    expect(engineCalls.map((call) => call.userId), "owner-2's preview was never processed").toEqual(["owner-1"]);
  }, 60_000);

  it("ORBIT_ARCHIVE_SLOT_WAIT_MS=1000 shortens the wait to 1 s", async () => {
    // Catches the setting not read.
    process.env.ORBIT_ARCHIVE_SLOT_WAIT_MS = "1000";
    fakeClock();
    const blocker = blockImportOf("owner-1");
    track(whole(IMPORT, "owner-1", HOUSEHOLD_A));
    await until(() => engineCalls.length === 1 && slot.archiveSlotHeld(), "owner-1's import is processing");

    const waiting = track(whole(PREVIEW, "owner-2", HOUSEHOLD_B));
    await until(() => spoolFiles().length === 1, "owner-2's preview is spooled");
    // The 1 s starts when the spool finishes, not when its file appears.
    await until(() => spoolsFinished === 2, "owner-2's spool resolved", 20_000);
    await settle();
    await advance(500, 100);
    expect(waiting.settled, "at 0.5 s it is still waiting").toBe(false);
    await advance(1_000, 100);
    await until(() => waiting.settled, "owner-2's answer");
    await expectBusy(waiting.value);
    blocker.open();
  }, 30_000);
});

// --- L6 -----------------------------------------------------------------------

describe("L6: the spool preflight is asked for the declared length", () => {
  it("no Content-Length: the preflight is asked for archiveBodyLimit() bytes", async () => {
    // Catches a preflight that assumes a small file when the client did not say how big it is.
    const request = await requestBytes(PREVIEW, HOUSEHOLD_A);
    const script = scriptedBody();
    script.send(request.bytes);
    script.end();
    const event = eventFor(PREVIEW, "owner-1", HOUSEHOLD_A, script.body, request.contentType);
    expect(event.request.headers.get("content-length"), "the request declares no length").toBeNull();
    const response = await handle({ event, resolve: (resolved) => posts[PREVIEW](resolved) });
    expect(response.status).toBe(200);
    expect(mocks.spoolPortableArchiveUpload).toHaveBeenCalledTimes(1);
    expect(mocks.spoolPortableArchiveUpload.mock.calls[0][1]).toBe(archiveBodyLimit());
  });

  it("Content-Length: 4096: the preflight is asked for 4096 bytes", async () => {
    // Catches the declared length ignored.
    const overhead = (await requestBytes(PREVIEW, HOUSEHOLD_A, Buffer.alloc(0))).bytes.length;
    const request = await requestBytes(PREVIEW, HOUSEHOLD_A, Buffer.alloc(4096 - overhead, "x"));
    expect(request.bytes.length).toBe(4096);
    const script = scriptedBody();
    script.send(request.bytes);
    script.end();
    const response = await run(PREVIEW, "owner-1", HOUSEHOLD_A, script.body, request.contentType, { "content-length": "4096" });
    expect(response.status).toBe(200);
    expect(mocks.spoolPortableArchiveUpload).toHaveBeenCalledTimes(1);
    expect(mocks.spoolPortableArchiveUpload.mock.calls[0][1]).toBe(4096);
  });
});

// --- L7 -----------------------------------------------------------------------

describe("L7: the export route is unchanged", () => {
  it("an export while the slot is held is 429 archive_busy at once, without waiting", async () => {
    // Pins today's fail-fast export: only bodies already on disk wait.
    fakeClock();
    const blocker = blockImportOf("owner-1");
    track(whole(IMPORT, "owner-1", HOUSEHOLD_A));
    await until(() => engineCalls.length === 1 && slot.archiveSlotHeld(), "owner-1's import is processing");
    const exported = track(whole(EXPORT, "owner-3", HOUSEHOLD_C));
    vi.advanceTimersByTime(0);
    await until(() => exported.settled, "the export's answer, with the clock still");
    await expectBusy(exported.value);
    expect(mocks.createPortableArchive).not.toHaveBeenCalled();
    blocker.open();
  });
});

// --- L8 -----------------------------------------------------------------------

describe("L8: the hooks' stall watch covers the spool", () => {
  it("a signed-in preview whose body stops for 31 s in the file part answers 408, and the slot was never held", async () => {
    // Catches the slot taken while the body is still arriving (the watchdog would be all that frees it).
    fakeClock();
    const samples = [];
    const held = await heldAfterFields(PREVIEW, "owner-1", HOUSEHOLD_A, 256);
    for (let elapsed = 0; elapsed < 31_000; elapsed += 500) {
      samples.push(slot.archiveSlotHeld());
      await vi.advanceTimersByTimeAsync(500);
      await settle();
    }
    await until(() => held.response.settled, "the preview's answer");
    samples.push(slot.archiveSlotHeld());
    expect(held.response.value.status).toBe(408);
    expect((await errorOf(held.response.value)).code).toBe("request_timeout");
    expect(samples.some(Boolean), "the slot was held at some point while the body was arriving").toBe(false);
  }, 30_000);
});
