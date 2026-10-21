import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

/*
 * The administration screen's reads have a time limit. A live read that is
 * refused, breaks or never arrives gives its panel null and a true `failed`
 * flag; "never arrives" must end by itself, or the screen never finishes
 * loading and never offers "try again".
 *
 * Contract under test:
 *   - one admin read that never answers: readAdminScreen() still resolves,
 *     with that panel null and its failed flag true, the others unaffected;
 *   - the limit is the staged-page one (STAGED_PAGE_TIMEOUT_MS), applied as
 *     AbortSignal.timeout on every fetch the screen makes, the per-household
 *     member reads included.
 */

const HOUSEHOLDS = [
  { id: "hh-1", name: "First", today: "2026-10-15" },
  { id: "hh-2", name: "Second", today: "2026-10-15" },
];

/** Panels reached through one route each: [route fragment, view field, failed flag]. */
const STALLS = /** @type {const} */ ([
  ["/api/admin/health", "services", "services"],
  ["/api/admin/documents/health", "metadata", "metadata"],
  ["/api/admin/mailbox", "mailbox", "relay"],
  ["/api/admin/contact", "contact", "contact"],
  ["/api/admin/users", "users", "users"],
  ["/api/admin/operations", "operations", "operations"],
  ["/api/admin/upload-limit", "uploadLimit", "uploadLimit"],
  ["/api/admin/documents/rotation", "rotation", "rotation"],
  ["/api/admin/recovery-bundle", "recoveryBundle", "recoveryBundle"],
]);

/** @type {{ href: string, signal: AbortSignal | undefined }[]} */
let calls;
/** @type {number[]} */
let limits;

/**
 * @param {string | null} stalled A route fragment whose fetch never resolves on its own.
 * @param {{ stallOnce?: boolean }} [options] stallOnce: only the first fetch of that route stalls; later ones answer.
 */
function stubFetch(stalled, { stallOnce = false } = {}) {
  calls = [];
  let stalls = 0;
  vi.stubGlobal("fetch", vi.fn((url, init) => {
    const href = String(url);
    const signal = init?.signal;
    calls.push({ href, signal });
    if (stalled && href.includes(stalled) && (!stallOnce || stalls++ === 0)) {
      // Never answers; only an abort ends it, as a real fetch behaves.
      return new Promise((_resolve, reject) => {
        if (!signal) return;
        const fail = () => reject(signal.reason ?? new DOMException("aborted", "AbortError"));
        if (signal.aborted) fail();
        else signal.addEventListener("abort", fail, { once: true });
      });
    }
    const reply = (/** @type {unknown} */ body) => Promise.resolve(new Response(JSON.stringify(body), { status: 200 }));
    if (href.includes("/api/auth/session")) return reply({ user: { id: "u1" }, csrfToken: "t" });
    if (href.includes("/api/workspace")) return reply({ workspace: { households: HOUSEHOLDS, activeHouseholdId: "hh-1" } });
    if (href.includes("/api/admin/upload-limit")) return reply({ uploadLimit: { effectiveMegabytes: 50, version: 2 } });
    if (href.includes("/api/admin/documents/rotation")) return reply({ rotation: { inProgress: false } });
    if (href.includes("/api/admin/documents/health")) return reply({ health: { metadata: { locked: 0, damaged: 0 } } });
    if (href.includes("/api/admin/recovery-bundle")) return reply({ recoveryBundle: { exported: true, exportedAt: "2026-10-10T09:00:00.000Z" } });
    if (href.includes("/api/admin/operations")) return reply({ operations: { jobs: [], generatedAt: "2026-10-15T12:00:00.000Z" } });
    if (href.includes("/api/admin/users")) return reply({ users: [] });
    if (href.includes("/api/admin/mailbox")) return reply({ mailbox: null });
    if (href.includes("/api/admin/contact")) return reply({ contact: null });
    if (href.includes("/members")) return reply({ members: [] });
    return Promise.resolve(new Response("{}", { status: 404 }));
  }));
}

/** Makes every AbortSignal.timeout fire after 50 ms, and records the limit asked for. */
function shortenTimeouts() {
  limits = [];
  const real = AbortSignal.timeout.bind(AbortSignal);
  vi.spyOn(AbortSignal, "timeout").mockImplementation((ms) => {
    limits.push(ms);
    return real(50);
  });
}

/** @returns {Promise<any>} */
async function readAdmin() {
  const { readAdminScreen } = await import("../../web/src/lib/data/workspace.js");
  return readAdminScreen();
}

beforeEach(() => {
  vi.resetModules();
});

afterEach(() => {
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
});

describe("a stalled admin read", () => {
  it.each(STALLS)("%s that never answers gives a failed panel and the screen still resolves", async (route, field, flag) => {
    shortenTimeouts();
    stubFetch(route);
    const view = await readAdmin();
    expect(view[field]).toBeNull();
    expect(view.failed[flag]).toBe(true);
  }, 3000);

  it("leaves the panels whose reads answered unflagged", async () => {
    shortenTimeouts();
    stubFetch("/api/admin/operations");
    const view = await readAdmin();
    expect(view.failed.operations).toBe(true);
    expect(view.failed.uploadLimit).toBe(false);
    expect(view.failed.rotation).toBe(false);
    expect(view.failed.recoveryBundle).toBe(false);
  }, 3000);

  it("a stalled per-household members read does not hold the screen", async () => {
    shortenTimeouts();
    stubFetch("/members");
    const view = await readAdmin();
    expect(view).toBeTruthy();
    expect(view.failed).toBeTypeOf("object");
  }, 3000);
});

describe("the limit", () => {
  it("every admin fetch carries an AbortSignal, the member reads included", async () => {
    stubFetch(null);
    await readAdmin();
    const admin = calls.filter((c) => c.href.includes("/api/admin/") || c.href.includes("/members"));
    expect(admin.some((c) => c.href.includes("/members"))).toBe(true);
    for (const c of admin) expect(c.signal, `${c.href} has no signal`).toBeInstanceOf(AbortSignal);
  });

  it("uses the staged-page limit for each of them", async () => {
    shortenTimeouts();
    stubFetch(null);
    await readAdmin();
    const { STAGED_PAGE_TIMEOUT_MS } = await import("../../web/src/lib/data/staged-page.js");
    const admin = calls.filter((c) => c.href.includes("/api/admin/") || c.href.includes("/members"));
    expect(limits.length).toBeGreaterThanOrEqual(admin.length);
    for (const ms of limits) expect(ms).toBe(STAGED_PAGE_TIMEOUT_MS);
  });
});

/*
 * R4 (G4-FR1): the two reads the screen starts with, the workspace and the
 * sign-in session, are shared with other screens but must not leave the admin
 * screen loading forever either.
 *   - a workspace read that never answers: readAdminScreen() REJECTS at the
 *     limit (the desk's loadScreen turns that into "could not load
 *     administration" and a "try again");
 *   - a session read that never answers: the screen still resolves (user
 *     null, as a failed session already gives), and the stalled promise is
 *     not cached, so the next readAdminScreen() asks again and gets the user.
 */
describe("the reads the screen starts with", () => {
  it("a workspace read that never answers rejects the screen at the limit", async () => {
    shortenTimeouts();
    stubFetch("/api/workspace");
    await expect(readAdmin()).rejects.toBeTruthy();
  }, 3000);

  it("the workspace read carries an AbortSignal with the staged-page limit", async () => {
    shortenTimeouts();
    stubFetch(null);
    await readAdmin();
    const { STAGED_PAGE_TIMEOUT_MS } = await import("../../web/src/lib/data/staged-page.js");
    const read = calls.find((c) => c.href.includes("/api/workspace"));
    expect(read?.signal).toBeInstanceOf(AbortSignal);
    expect(limits).toContain(STAGED_PAGE_TIMEOUT_MS);
  });

  it("a session read that never answers still resolves, with no user", async () => {
    shortenTimeouts();
    stubFetch("/api/auth/session");
    const view = await readAdmin();
    expect(view.user).toBeNull();
  }, 3000);

  it("a stalled session read is not cached: the retry asks again and gets the user", async () => {
    shortenTimeouts();
    stubFetch("/api/auth/session", { stallOnce: true });
    const { readAdminScreen } = await import("../../web/src/lib/data/workspace.js");
    const first = await readAdminScreen();
    expect(first.user).toBeNull();
    const second = await readAdminScreen();
    expect(second.user).toEqual({ id: "u1" });
  }, 3000);
});
