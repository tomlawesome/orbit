import { mkdtempSync, readdirSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { archiveForm, encodeForm, fileContentOffset, readStream } from "../integration/support/portable-archive-upload.ts";

/*
 * #1797 (an over-limit archive upload is refused early; spec: GitLab note
 * 56654, section 7 tests 2-6 and 8): the import route checks the upload as it
 * arrives. Once the first P bytes (header and manifest, here FAKE_P) are on
 * disk, the engine's dry run can refuse, and the route answers while the rest
 * of the body is still unsent, the spool file removed and the lane and slot
 * free. A source gated after P bytes stands in for the slow link; "the gate is
 * never opened" is the test not calling `finish()`.
 *
 * Same harness as archive-slot-upload-spool-1792.test.mjs: the real hooks and
 * routes and the repository's real spool; the session and the engine are
 * mocked. The engine is a small fake of the archive: the first bytes say
 * whether it is v2 ("ORBITARC") or v1 ("{"), and the text after them is the
 * verdict the dry run and the final check both reach ("over" quota,
 * "wrongpass"). `inspectPortableArchiveUpload` is the function the fix adds to
 * the repository, mocked with the spec's steps (bytes written, prefix read,
 * archive slot taken under `until`); the real one is exercised by
 * tests/integration/portable-archive-early-refusal-1797.test.ts. What is
 * under test here is the route and helper wiring: the inspection runs beside
 * the spool, its refusal is the answer, the spool dies with it, and the slot
 * and lane are released.
 */
const COLD_IMPORT_TIMEOUT_MS = 60_000;
const MIB = 1_048_576;
const KIB = 1024;
const PASSPHRASE = "a-long-enough-passphrase";
const FILE = Buffer.alloc(6 * KIB, "archive-bytes-1797 ");

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
  inspectPortableArchiveUpload: vi.fn(),
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
    inspectPortableArchiveUpload: mocks.inspectPortableArchiveUpload,
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

/** P: the bytes of header and manifest the dry run needs, in this fake. */
const FAKE_P = 4096;
/** Dry runs that reached their verdict (took the slot, read the prefix). */
let inspections = [];

/** A fake archive: `kind` ("v2" | "v1"), the verdict text, padded to `size` bytes. */
function fakeArchive(kind, verdict, size) {
  const text = `${kind === "v1" ? "{" : "ORBITARC"};verdict=${verdict};`;
  return Buffer.concat([Buffer.from(text), Buffer.alloc(Math.max(0, size - text.length), "x")]);
}

/** What the dry run and the final check both say about these bytes (null: it fits), as the engine's own errors. */
function verdictOf(bytes, conflictItemIds) {
  const text = bytes.subarray(0, 64).toString("latin1");
  if (text.startsWith("ORBITARC") && bytes.length < FAKE_P) throw new AppError("archive_invalid", "That archive is not valid", 422);
  if (text.includes("verdict=wrongpass;")) throw new AppError("archive_passphrase_invalid", "The passphrase or archive is invalid", 422);
  // Every over-quota document a skipped duplicate: it fits.
  if (text.includes("verdict=over;") && conflictItemIds.length === 0) throw new AppError("archive_over_quota", "Not brought in: it is over the household's storage limit", 413);
}

/** The spec's inspection, step by step; a refusal aborts the spool, as the real one does. */
async function fakeInspect(spool, input, until) {
  if ((await spool.whenWritten(1)) < 1) return;
  const first = Buffer.from(await readStream(spool.prefix(1)));
  if (first[0] === 0x7b) return; // v1: never inspected
  if ((await spool.whenWritten(FAKE_P)) < FAKE_P) return; // the source ended first: the final path judges
  const claim = await slot.awaitArchiveSlot(undefined, { until });
  if (claim === null) return;
  try {
    const prefix = await readStream(spool.prefix(FAKE_P));
    inspections.push(input);
    verdictOf(prefix, input.conflictItemIds);
  } catch (error) {
    spool.abort(error);
  } finally {
    claim.release();
  }
}

vi.setConfig({ testTimeout: 30_000 });

beforeAll(async () => {
  for (const name of ENVIRONMENT) savedEnvironment[name] = process.env[name];
  documentsRoot = mkdtempSync(join(tmpdir(), "orbit-1797-documents-"));
  quarantineRoot = mkdtempSync(join(tmpdir(), "orbit-1797-quarantine-"));
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
  inspections = [];
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
    const bytes = await readStream(input.archive);
    engineCalls.push({ userId: input.userId, bytes, slotHeld: slot.archiveSlotHeld() });
    verdictOf(bytes, input.conflictItemIds); // the final check: the same refusal the dry run gives
    return { importedItems: 1, documentsExcluded: 0 };
  });
  mocks.previewPortableImport.mockImplementation(async (userId, _household, archive) => {
    engineCalls.push({ userId, bytes: await readStream(archive) });
    return { householdName: "Home", items: 1 };
  });
  mocks.inspectPortableArchiveUpload.mockImplementation(fakeInspect);
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
async function requestBytes(route, household, file = FILE, conflictItemIds = []) {
  if (route === EXPORT) {
    return { bytes: Buffer.from(JSON.stringify({ passphrase: PASSPHRASE, includeDocuments: false })), contentType: "application/json", fileStart: -1 };
  }
  const fields = route === IMPORT
    ? { householdId: household, passphrase: PASSPHRASE, conflictItemIds }
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

/** An import whose fields and the first `fileBytes` of `file` are sent, and whose rest waits for `finish()`. */
async function heldAfterFields(route, who, household, fileBytes, file, conflictItemIds = []) {
  const request = await requestBytes(route, household, file, conflictItemIds);
  const script = scriptedBody();
  script.send(request.bytes.subarray(0, request.fileStart + fileBytes));
  const response = track(run(route, who, household, script.body, request.contentType));
  return {
    response,
    state: script.state,
    finish() { script.send(request.bytes.subarray(request.fileStart + fileBytes)); script.end(); },
  };
}

/** A deferred the test resolves. */
function gate() {
  let open;
  const promise = new Promise((resolve) => { open = resolve; });
  return { promise, open };
}

/** The export engine blocks on the returned gate: an export is processing, holding the archive slot. */
function blockExport() {
  const blocker = gate();
  blockers.push(blocker);
  mocks.createPortableArchive.mockImplementation(async () => {
    await blocker.promise;
    return { id: "archive-1", expiresAt: "2026-11-10T00:00:00.000Z", includesDocuments: false };
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


const CONFLICT = "55555555-5555-4555-8555-555555555555";
const wait = () => settle(30);
/** The bytes of a fake archive as the engine was handed them, per import call. */
const importCalls = () => engineCalls.filter((call) => call.slotHeld !== undefined);

describe("#1797 test 2: an over-quota import is answered 413 as soon as the manifest is on disk", () => {
  it("answers 413 archive_over_quota while the source is gated after P bytes, with the spool file gone, the lane and slot free, and the gate never opened", async () => {
    // Catches a refusal that comes only after the whole body: today the answer waits for the gate.
    const file = fakeArchive("v2", "over", 3 * FAKE_P);
    const held = await heldAfterFields(IMPORT, "owner-1", HOUSEHOLD_A, FAKE_P, file);
    await until(() => held.response.settled, "the import's answer, with the rest of the body still unsent");
    expect(held.response.value.status).toBe(413);
    const refusal = await errorOf(held.response.value);
    expect(refusal.code).toBe("archive_over_quota");
    expect(refusal.message).toBe("Not brought in: it is over the household's storage limit");
    expect(held.state.done, "the body was not read to its end").toBe(false);
    await until(() => spoolFiles().length === 0, "the .upload.tmp is gone");
    await until(() => !slot.uploadLaneHeld("owner-1") && !slot.archiveSlotHeld(), "the lane and the slot are free");
    expect(inspections, "the dry run was handed who, what household, which passphrase, which choices").toMatchObject([
      { userId: "owner-1", householdId: HOUSEHOLD_A, passphrase: PASSPHRASE, conflictItemIds: [] },
    ]);
    expect(mocks.importPortableArchive, "the import itself never started").not.toHaveBeenCalled();
    expect(spoolDirectory()).toEqual([]);
  });
});

describe("#1797 test 3: an honest import is not refused early", () => {
  it("every over-quota document a skipped duplicate: no early refusal, the gate is opened, the import proceeds", async () => {
    // Guards the "can refuse, never admit" clause. Passes before and after.
    const file = fakeArchive("v2", "over", 3 * FAKE_P);
    const held = await heldAfterFields(IMPORT, "owner-1", HOUSEHOLD_A, FAKE_P, file, [CONFLICT]);
    await wait();
    expect(held.response.settled, "not refused at P bytes").toBe(false);
    expect(spoolFiles(), "still spooling").toHaveLength(1);
    held.finish();
    await until(() => held.response.settled, "the import's answer");
    expect(held.response.value.status).toBe(200);
    expect(importCalls()).toHaveLength(1);
    expect(importCalls()[0].bytes.equals(file)).toBe(true);
    expect(spoolDirectory()).toEqual([]);
  });
});

describe("#1797 test 4: a wrong passphrase is refused at P bytes", () => {
  it("answers 422 archive_passphrase_invalid with the gate never opened and the spool file gone", async () => {
    // Fails today: the answer comes only after the whole body.
    const file = fakeArchive("v2", "wrongpass", 3 * FAKE_P);
    const held = await heldAfterFields(IMPORT, "owner-1", HOUSEHOLD_A, FAKE_P, file);
    await until(() => held.response.settled, "the import's answer, with the rest of the body still unsent");
    expect(held.response.value.status).toBe(422);
    expect((await errorOf(held.response.value)).code).toBe("archive_passphrase_invalid");
    expect(held.state.done).toBe(false);
    await until(() => spoolFiles().length === 0, "the .upload.tmp is gone");
    await until(() => !slot.uploadLaneHeld("owner-1") && !slot.archiveSlotHeld(), "the lane and the slot are free");
    expect(mocks.importPortableArchive).not.toHaveBeenCalled();
  });
});

describe("#1797 test 5: a v1 archive is never inspected", () => {
  it("takes the slot once, after the whole body, and the final check gives the refusal", async () => {
    // Passes before and after: a v1 file's contents list is not a prefix.
    const file = fakeArchive("v1", "over", 3 * FAKE_P);
    const samples = [];
    const held = await heldAfterFields(IMPORT, "owner-1", HOUSEHOLD_A, 2 * FAKE_P, file);
    for (let turns = 0; turns < 40; turns += 1) { samples.push(slot.archiveSlotHeld()); await turn(); }
    expect(held.response.settled, "no early answer").toBe(false);
    expect(samples.some(Boolean), "the slot is not taken while the body arrives").toBe(false);
    expect(inspections, "no dry run reached its verdict").toEqual([]);
    held.finish();
    await until(() => held.response.settled, "the import's answer");
    expect(held.response.value.status).toBe(413);
    expect((await errorOf(held.response.value)).code).toBe("archive_over_quota");
    expect(importCalls(), "the slot was taken once, for the final check").toHaveLength(1);
    expect(importCalls()[0].slotHeld).toBe(true);
    expect(importCalls()[0].bytes.equals(file)).toBe(true);
  });
});

describe("#1797 test 6: a v2 file that ends before P", () => {
  it("gets no early refusal; the final path answers archive_invalid", async () => {
    // Passes before and after.
    const file = fakeArchive("v2", "over", FAKE_P - 500);
    const request = await requestBytes(IMPORT, HOUSEHOLD_A, file);
    const response = await run(IMPORT, "owner-1", HOUSEHOLD_A, new Uint8Array(request.bytes), request.contentType);
    expect(response.status).toBe(422);
    expect((await errorOf(response)).code).toBe("archive_invalid");
    expect(inspections, "no dry run reached its verdict").toEqual([]);
    expect(importCalls(), "the final path ran once").toHaveLength(1);
    expect(spoolDirectory()).toEqual([]);
  });
});

describe("#1797 test 8: the inspection gives up when the slot is held until the spool ends", () => {
  it("an export holds the slot past the end of the body: the import then takes the slot once and is refused archive_over_quota by the final check", async () => {
    // Regression guard for the give-up path. Passes before and after.
    const blocker = blockExport();
    const exporting = track(whole(EXPORT, "owner-3", HOUSEHOLD_C));
    await until(() => slot.archiveSlotHeld() && mocks.createPortableArchive.mock.calls.length === 1, "the export is processing");

    const file = fakeArchive("v2", "over", 3 * FAKE_P);
    const request = await requestBytes(IMPORT, HOUSEHOLD_A, file);
    const script = scriptedBody();
    script.send(request.bytes);
    script.end();
    const importing = track(run(IMPORT, "owner-1", HOUSEHOLD_A, script.body, request.contentType));
    await until(() => script.state.done, "the whole body has been taken");
    await wait();
    expect(importing.settled, "the import waits for the slot: it is not answered, and the engine has not run").toBe(false);
    expect(importCalls()).toEqual([]);
    expect(inspections, "the inspection never had the slot").toEqual([]);

    blocker.open();
    await until(() => exporting.settled && importing.settled, "both answers", 10_000);
    expect(importing.value.status).toBe(413);
    expect((await errorOf(importing.value)).code).toBe("archive_over_quota");
    expect(importCalls(), "the import took the slot once").toHaveLength(1);
    expect(inspections, "the inspection did not run after it gave up").toEqual([]);
    expect(spoolDirectory()).toEqual([]);
  }, 30_000);
});
