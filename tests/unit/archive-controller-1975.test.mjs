import { readFileSync, rmSync, writeFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { pathToFileURL } from "node:url";
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";

/*
 * #1975 / #1354: the archive card's one state machine, shared by the desk's
 * DeskArchive and the phone's PocketArchive. These tests drive the real
 * controller; the workspace calls are stood in, and nothing touches the network.
 */
const ws = vi.hoisted(() => ({
  importPortableArchive: vi.fn(), previewPortableArchive: vi.fn(), readSignInMethods: vi.fn(),
  startStepUp: vi.fn(), writePortableArchive: vi.fn(),
  wordsOf: (/** @type {unknown} */ e, fallback = "failed") => (e instanceof Error ? e.message : fallback),
}));
const mounts = vi.hoisted(() => ({ fns: /** @type {Array<() => void>} */ ([]) }));
vi.mock("$lib/data/workspace.js", () => ws);

/* The suite has no Svelte plugin, so the runes module is compiled here with
   Svelte's own compiler (compileModule). The copy carries a source map back to
   the real file, so coverage is counted against web/src and not the copy. The
   copy's `svelte` import is a recorder: onMount needs a component, so the test
   calls the hooks by hand, as mounting the card would. */
const SOURCE = resolve(import.meta.dirname, "../../web/src/routes/household/[id]/archive-controller.svelte.js");
const RUNTIME = resolve(import.meta.dirname, "../../web/node_modules/svelte/src/internal/client/index.js");
/* The copy sits beside its source so the coverage include (web/src) matches it and the map reports it as the real file. */
const COPY_DIR = dirname(SOURCE);
/** @type {string} */
let outDir = "";
/** @type {(opts: any) => any} */
let createArchiveController = () => null;
beforeAll(async () => {
  const { compileModule } = await import(/* @vite-ignore */ pathToFileURL(resolve(import.meta.dirname, "../../web/node_modules/svelte/src/compiler/index.js")).href);
  const source = readFileSync(SOURCE, "utf8");
  /* JSDoc on an arrow's parameter prints as invalid JS; blank those comments but keep their lines. */
  const blanked = source.replace(/\/\*\*(?:(?!\*\/)[^])*\*\//g, (m) => m.replace(/[^\n]/g, " "));
  const out = compileModule(blanked, { filename: SOURCE, generate: "client", dev: false });
  const map = { ...out.js.map, sources: [SOURCE], sourcesContent: [source] };
  const code = out.js.code
    .replace(/import\s*\{\s*onMount\s*\}\s*from\s*"svelte";?/, "const onMount = (fn) => globalThis.__archiveMounts.push(fn);")
    .replace(/(["'])svelte\/internal\/client\1/g, JSON.stringify(RUNTIME))
    .replace(/import\s+["']svelte\/internal\/disclose-version["'];?/, "")
    .replace(/(["'])\.\/archive\.js\1/g, JSON.stringify(resolve(dirname(SOURCE), "archive.js")));
  outDir = join(COPY_DIR, `archive-controller-1975-${process.pid}-${Date.now()}.compiled.js`);
  const path = outDir;
  writeFileSync(path, `${code}\n//# sourceMappingURL=data:application/json;base64,${Buffer.from(JSON.stringify(map)).toString("base64")}\n`);
  /** @type {any} */ (globalThis).__archiveMounts = mounts.fns;
  ({ createArchiveController } = await import(/* @vite-ignore */ path));
});
afterAll(() => { if (outDir) rmSync(outDir, { force: true }); });

/* The unit environment is Node: a tiny sessionStorage and document stand in for the browser's. */
const store = new Map();
vi.stubGlobal("sessionStorage", {
  getItem: (/** @type {string} */ k) => store.get(k) ?? null,
  setItem: (/** @type {string} */ k, /** @type {string} */ v) => { store.set(k, v); },
  removeItem: (/** @type {string} */ k) => { store.delete(k); },
});
vi.stubGlobal("document", { getElementById: () => null });

const LIMITS = { passphraseMin: 8, passphraseMax: 64, archiveFileBytes: 1000 };
/** @param {string} code */
const coded = (code) => Object.assign(new Error(code), { code });
const PROOF = coded("recent_authentication_required");
const WRITTEN = { id: "a1", expiresAt: "2026-11-26T12:00:00.000Z" };
const PREVIEW = { items: 5, conflicts: [{ id: "c1" }, { id: "c2" }] };

/** @param {Record<string, unknown>} [over] */
function make(over = {}) {
  const wake = vi.fn();
  const ctl = createArchiveController({ householdId: () => "h1", limits: () => /** @type {any} */ (LIMITS), tabIdPrefix: "tab-", wake, ...over });
  return { ctl, wake };
}
/** @param {string} [content] @param {string} [name] */
const aFile = (content = "{}", name = "x.orbit") => new File([content], name);
/** Picks a file the way the input's change event does. @param {any} ctl @param {File | undefined} f */
async function pick(ctl, f) {
  const input = { files: f ? [f] : [], value: "x" };
  await ctl.chose({ currentTarget: input });
  return input;
}
/** Writes an archive with a good passphrase. @param {any} ctl */
function fillOut(ctl, pass = "correct horse") { ctl.passOut = pass; ctl.passAgain = pass; }
const settle = () => new Promise((r) => setTimeout(r, 0));

beforeEach(() => {
  for (const fn of Object.values(ws)) if (typeof fn.mockReset === "function") fn.mockReset();
  mounts.fns.length = 0;
  store.clear();
});

describe("archive card: take it with you (#1354)", () => {
  it("starts at rest on the 'out' tab and opens the form, then cancel wipes the passphrases", () => {
    const { ctl } = make();
    expect(ctl.tab).toBe("out");
    expect(ctl.outPhase).toBe("rest");
    ctl.startExport();
    expect(ctl.outPhase).toBe("form");
    fillOut(ctl);
    ctl.cancelExport();
    expect(ctl.outPhase).toBe("rest");
    expect([ctl.passOut, ctl.passAgain, ctl.outProblem]).toEqual(["", "", null]);
  });

  it("passphrase gate (#1336): says why until the pair is long enough and the same, and refuses to write", () => {
    const { ctl } = make();
    ctl.startExport();
    expect(ctl.passphraseMin).toBe(8);
    ctl.passOut = "short";
    expect(ctl.outRefusal).toBe("at least 8 characters");
    ctl.passOut = "long enough";
    ctl.passAgain = "different";
    expect(ctl.outRefusal).toMatch(/not the same/);
    ctl.writeArchive();
    expect(ws.writePortableArchive).not.toHaveBeenCalled();
    expect(ctl.outPhase).toBe("form");
  });

  it("passphrase gate stays shut while the engine's limits are unknown (#1605 O-R9)", () => {
    const { ctl } = make({ limits: () => null });
    expect(ctl.passphraseMin).toBe(Number.POSITIVE_INFINITY);
    expect(ctl.outRefusal).toMatch(/reload the page/);
  });

  it("writes the archive, sends the passphrase with no proof, clears the fields, and wakes with the deadline", async () => {
    ws.writePortableArchive.mockResolvedValue(WRITTEN);
    const { ctl, wake } = make();
    ctl.startExport();
    fillOut(ctl);
    ctl.writeArchive();
    expect(ctl.outPhase).toBe("writing");
    await settle();
    expect(ws.writePortableArchive).toHaveBeenCalledWith("h1", { passphrase: "correct horse", currentPassword: undefined });
    expect(ctl.outPhase).toBe("written");
    expect(ctl.written).toEqual(WRITTEN);
    expect([ctl.passOut, ctl.passAgain]).toEqual(["", ""]);
    expect(ctl.readyUntil).not.toBe("");
    expect(wake).toHaveBeenCalledWith(expect.stringContaining("the archive is written · download it before"));
  });

  it("a refusal returns to the form in the server's words, 'not written — ...'", async () => {
    ws.writePortableArchive.mockRejectedValue(new Error("storage is full"));
    const { ctl } = make();
    ctl.startExport();
    fillOut(ctl);
    ctl.writeArchive();
    await settle();
    expect(ctl.outPhase).toBe("form");
    expect(ctl.outProblem).toBe("not written — storage is full");
    expect(ctl.passOut).toBe("correct horse");
  });

  it("a changed-on-disk or non-archive file gets the card's own words (#1566, #1605 W-R12)", async () => {
    const { ctl } = make();
    ws.previewPortableArchive.mockRejectedValueOnce(coded("archive_invalid"));
    await pick(ctl, aFile());
    ctl.passIn = "correct horse";
    await ctl.lookInside();
    expect(ctl.inProblem).toBe("this file is not an Orbit archive");
    ws.previewPortableArchive.mockRejectedValueOnce(Object.assign(new Error("x"), { name: "NotReadableError" }));
    await ctl.lookInside();
    expect(ctl.inProblem).toBe("the file changed after it was chosen — choose it again");
  });
});

describe("archive card: recent-authentication challenge (#1132)", () => {
  /** An export held by the challenge. */
  async function held(methods = { local: { set: true } }) {
    ws.readSignInMethods.mockResolvedValue(methods);
    ws.writePortableArchive.mockRejectedValueOnce(PROOF);
    const m = make();
    m.ctl.startExport();
    fillOut(m.ctl);
    m.ctl.writeArchive();
    await settle();
    return m;
  }

  it("opens the challenge once, back on the form, after asking how the reader proves it (pipeline 2382)", async () => {
    const { ctl } = await held();
    expect(ctl.challengeOpen).toBe(true);
    expect(ctl.hasPassword).toBe(true);
    expect(ctl.retryIntent).toBe("archive_export");
    expect(ctl.outPhase).toBe("form");
    expect(ws.readSignInMethods).toHaveBeenCalledTimes(1);
  });

  it("a reader with no local password is told so; an unreadable answer assumes a password", async () => {
    expect((await held({ local: { set: false } })).ctl.hasPassword).toBe(false);
    ws.readSignInMethods.mockRejectedValue(new Error("down"));
    ws.writePortableArchive.mockRejectedValueOnce(PROOF);
    const { ctl } = make();
    fillOut(ctl);
    ctl.writeArchive();
    await settle();
    expect(ctl.hasPassword).toBe(true);
  });

  it("the proof is asked only once: a second held act does not re-read sign-in methods", async () => {
    const { ctl } = await held();
    ctl.cancelChallenge();
    ws.writePortableArchive.mockRejectedValueOnce(PROOF);
    ctl.writeArchive();
    await settle();
    expect(ws.readSignInMethods).toHaveBeenCalledTimes(1);
    expect(ctl.challengeOpen).toBe(true);
  });

  it("proving runs the held act again carrying the typed password, then closes the challenge", async () => {
    const { ctl } = await held();
    ws.writePortableArchive.mockResolvedValue(WRITTEN);
    ctl.currentPassword = "my password";
    await ctl.prove();
    expect(ws.writePortableArchive).toHaveBeenLastCalledWith("h1", { passphrase: "correct horse", currentPassword: "my password" });
    expect(ctl.challengeOpen).toBe(false);
    expect(ctl.outPhase).toBe("written");
    expect(ctl.proving).toBe(false);
  });

  it("a wrong password keeps the challenge open with 'try again'; another failure uses the server's words", async () => {
    const { ctl } = await held();
    ws.writePortableArchive.mockRejectedValueOnce(PROOF);
    await ctl.prove();
    expect(ctl.challengeProblem).toBe("that password did not match · try again");
    expect(ctl.challengeOpen).toBe(true);
    ws.writePortableArchive.mockRejectedValueOnce(new Error("too many tries"));
    await ctl.prove();
    expect(ctl.challengeProblem).toBe("too many tries");
    expect(ctl.proving).toBe(false);
  });

  it("prove does nothing with no held act", async () => {
    const { ctl } = make();
    await ctl.prove();
    expect(ws.writePortableArchive).not.toHaveBeenCalled();
  });

  it("a second prove while one is in flight is ignored", async () => {
    const { ctl } = await held();
    /** @type {(v: unknown) => void} */
    let release = () => {};
    ws.writePortableArchive.mockReturnValueOnce(new Promise((r) => { release = r; }));
    const first = ctl.prove();
    expect(ctl.proving).toBe(true);
    await ctl.prove();
    expect(ws.writePortableArchive).toHaveBeenCalledTimes(2);
    release(WRITTEN);
    await first;
  });

  it("cancelling forgets the proof and the held act", async () => {
    const { ctl } = await held();
    ctl.currentPassword = "typed";
    ctl.cancelChallenge();
    expect([ctl.challengeOpen, ctl.currentPassword, ctl.challengeProblem]).toEqual([false, "", null]);
    await ctl.prove();
    expect(ws.writePortableArchive).toHaveBeenCalledTimes(1);
  });

  it("the phone's sheet drops the held act without touching the proof field", async () => {
    const { ctl } = await held();
    ctl.dropRetry();
    await ctl.prove();
    expect(ws.writePortableArchive).toHaveBeenCalledTimes(1);
  });

  it("sends the reader to their provider with the intent of the held act, flagging the return (#1151 W2-R1)", async () => {
    const { ctl } = await held();
    ws.startStepUp.mockResolvedValue(undefined);
    vi.stubGlobal("location", { pathname: "/household/h1" });
    await ctl.toProvider();
    expect(ws.startStepUp).toHaveBeenCalledWith({ intent: "archive_export", returnTo: "/household/h1" });
    expect(sessionStorage.getItem("orbit-archive-stepup-return")).toBe("1");
  });

  it("a provider that cannot be reached clears the return flag and says why", async () => {
    const { ctl } = await held();
    ws.startStepUp.mockRejectedValue(new Error("provider down"));
    vi.stubGlobal("location", { pathname: "/household/h1" });
    await ctl.toProvider();
    expect(ctl.challengeProblem).toBe("provider down");
    expect(sessionStorage.getItem("orbit-archive-stepup-return")).toBeNull();
  });

  it("coming back from the provider shows the notice, and the flag is cleared a tick later so both cards can read it (#1151)", async () => {
    sessionStorage.setItem("orbit-archive-stepup-return", "1");
    const a = make();
    const b = make();
    for (const fn of mounts.fns) fn();
    expect(a.ctl.stepUpNotice).toMatch(/back from signing in again/);
    expect(b.ctl.stepUpNotice).toMatch(/back from signing in again/);
    expect(sessionStorage.getItem("orbit-archive-stepup-return")).toBe("1");
    await settle();
    expect(sessionStorage.getItem("orbit-archive-stepup-return")).toBeNull();
  });

  it("with no return flag there is no notice", () => {
    const { ctl } = make();
    for (const fn of mounts.fns) fn();
    expect(ctl.stepUpNotice).toBeNull();
  });
});

describe("archive card: bring one in (#1354)", () => {
  it("choosing a file empties the picker so the same file can be chosen again, and moves to 'chosen'", async () => {
    const { ctl } = make();
    const input = await pick(ctl, aFile());
    expect(input.value).toBe("");
    expect(ctl.inPhase).toBe("chosen");
    expect(ctl.file?.name).toBe("x.orbit");
  });

  it("cancelling the picker changes nothing", async () => {
    const { ctl } = make();
    await pick(ctl, undefined);
    expect(ctl.inPhase).toBe("rest");
    expect(ctl.file).toBeNull();
  });

  it("an empty file or one over the engine's ceiling is refused before anything is read", async () => {
    const { ctl } = make();
    await pick(ctl, aFile(""));
    expect(ctl.inProblem).toBe("this file is empty");
    expect(ctl.inPhase).toBe("rest");
    await pick(ctl, aFile("x".repeat(2000)));
    expect(ctl.inProblem).toMatch(/larger than/);
    expect(ctl.inPhase).toBe("rest");
  });

  it("choosing is ignored while a bring-in is under way", async () => {
    ws.previewPortableArchive.mockResolvedValue(PREVIEW);
    const { ctl } = make();
    await pick(ctl, aFile());
    ctl.passIn = "correct horse";
    await ctl.lookInside();
    /** @type {(v: unknown) => void} */
    let release = () => {};
    ws.importPortableArchive.mockReturnValue(new Promise((r) => { release = r; }));
    ctl.bringIn();
    expect(ctl.inPhase).toBe("bringing");
    await pick(ctl, aFile("{}", "other.orbit"));
    expect(ctl.file?.name).toBe("x.orbit");
    release({ importedItems: 1 });
    await settle();
  });

  it("passphrase gate (#1792 family): looking inside waits for the engine's floor and a chosen file", async () => {
    const { ctl } = make();
    ctl.passIn = "correct horse";
    await ctl.lookInside();
    expect(ctl.inPhase).toBe("rest");
    await pick(ctl, aFile());
    ctl.passIn = "short";
    await ctl.lookInside();
    expect(ws.previewPortableArchive).not.toHaveBeenCalled();
    expect(ctl.inPhase).toBe("chosen");
  });

  it("looking inside sends the file and passphrase, then shows the preview and what would be brought", async () => {
    ws.previewPortableArchive.mockResolvedValue(PREVIEW);
    const { ctl } = make();
    await pick(ctl, aFile());
    ctl.passIn = "correct horse";
    await ctl.lookInside();
    expect(ws.previewPortableArchive).toHaveBeenCalledWith("h1", expect.objectContaining({ passphrase: "correct horse", currentPassword: undefined }));
    expect(ctl.inPhase).toBe("preview");
    expect(ctl.preview).toEqual(PREVIEW);
    expect(ctl.bringCount).toBe(3);
  });

  it("a refused preview goes back to 'chosen' with the server's words", async () => {
    ws.previewPortableArchive.mockRejectedValue(new Error("wrong passphrase"));
    const { ctl } = make();
    await pick(ctl, aFile());
    ctl.passIn = "correct horse";
    await ctl.lookInside();
    expect(ctl.inPhase).toBe("chosen");
    expect(ctl.inProblem).toBe("wrong passphrase");
  });

  it("a held preview asks for proof with the import intent, then resumes at the preview", async () => {
    ws.readSignInMethods.mockResolvedValue({ local: { set: true } });
    ws.previewPortableArchive.mockRejectedValueOnce(PROOF);
    const { ctl } = make();
    await pick(ctl, aFile());
    ctl.passIn = "correct horse";
    await ctl.lookInside();
    expect(ctl.challengeOpen).toBe(true);
    expect(ctl.retryIntent).toBe("archive_import");
    expect(ctl.inPhase).toBe("chosen");
    ws.previewPortableArchive.mockResolvedValue(PREVIEW);
    ctl.currentPassword = "pw";
    await ctl.prove();
    expect(ws.previewPortableArchive).toHaveBeenLastCalledWith("h1", expect.objectContaining({ currentPassword: "pw" }));
    expect(ctl.inPhase).toBe("preview");
  });

  /** A card at the preview screen. */
  async function atPreview() {
    ws.previewPortableArchive.mockResolvedValue(PREVIEW);
    const m = make();
    await pick(m.ctl, aFile());
    m.ctl.passIn = "correct horse";
    await m.ctl.lookInside();
    return m;
  }

  it("bringing in skips the conflicting entries, reports the count, clears the passphrase and wakes", async () => {
    const { ctl, wake } = await atPreview();
    ws.importPortableArchive.mockResolvedValue({ importedItems: 3 });
    ctl.bringIn();
    expect(ctl.inPhase).toBe("bringing");
    await settle();
    expect(ws.importPortableArchive).toHaveBeenCalledWith("h1", expect.objectContaining({ passphrase: "correct horse", skip: ["c1", "c2"], currentPassword: undefined }));
    expect(ctl.inPhase).toBe("done");
    expect(ctl.brought).toBe(3);
    expect(ctl.passIn).toBe("");
    expect(wake).toHaveBeenCalledWith("brought in 3 entries");
  });

  it("a refused import returns to the preview with 'not brought in — ...' (#1797)", async () => {
    const { ctl } = await atPreview();
    ws.importPortableArchive.mockRejectedValue(new Error("household is full"));
    ctl.bringIn();
    await settle();
    expect(ctl.inPhase).toBe("preview");
    expect(ctl.inProblem).toBe("not brought in — household is full");
  });

  it("a file that changed after it was picked stops before the upload, in the card's words (#1605 W-R12)", async () => {
    const { ctl } = await atPreview();
    const err = Object.assign(new Error("x"), { name: "NotReadableError" });
    /** @type {any} */ (ctl.file).slice = () => ({ arrayBuffer: () => Promise.reject(err) });
    ctl.bringIn();
    await settle();
    expect(ws.importPortableArchive).not.toHaveBeenCalled();
    expect(ctl.inProblem).toBe("not brought in — the file changed after it was chosen — choose it again");
  });

  it("a held import opens the challenge once and proving carries the proof to the upload", async () => {
    const { ctl } = await atPreview();
    ws.readSignInMethods.mockResolvedValue({ local: { set: true } });
    ws.importPortableArchive.mockRejectedValueOnce(PROOF);
    ctl.bringIn();
    await settle();
    expect(ctl.challengeOpen).toBe(true);
    expect(ctl.retryIntent).toBe("archive_import");
    expect(ctl.inPhase).toBe("preview");
    ws.importPortableArchive.mockResolvedValue({ importedItems: 1 });
    ctl.currentPassword = "pw";
    await ctl.prove();
    expect(ws.importPortableArchive).toHaveBeenLastCalledWith("h1", expect.objectContaining({ currentPassword: "pw" }));
    expect(ctl.inPhase).toBe("done");
  });

  it("bringIn does nothing without a preview", () => {
    const { ctl } = make();
    ctl.bringIn();
    expect(ctl.inPhase).toBe("rest");
  });

  it("start over forgets the file, preview, passphrase and problem", async () => {
    const { ctl } = await atPreview();
    ctl.startOver();
    expect([ctl.file, ctl.preview, ctl.passIn, ctl.inProblem, ctl.inPhase]).toEqual([null, null, "", null, "rest"]);
  });
});

describe("archive card: tabs and accessors (#1354, section 22)", () => {
  it("arrow keys move between the two tabs and wrap, and other keys are left alone", () => {
    const { ctl } = make();
    const ev = (/** @type {string} */ key) => ({ key, preventDefault: vi.fn() });
    ctl.tabKey(ev("ArrowRight"));
    expect(ctl.tab).toBe("in");
    ctl.tabKey(ev("ArrowRight"));
    expect(ctl.tab).toBe("out");
    ctl.tabKey(ev("ArrowLeft"));
    expect(ctl.tab).toBe("in");
    const other = ev("a");
    ctl.tabKey(other);
    expect(other.preventDefault).not.toHaveBeenCalled();
    expect(ctl.tab).toBe("in");
  });

  it("the shared fields can be set from the card's inputs", () => {
    const { ctl } = make();
    ctl.tab = "in";
    ctl.challengeOpen = true;
    ctl.currentPassword = "p";
    const picker = /** @type {any} */ ({});
    ctl.picker = picker;
    expect([ctl.tab, ctl.challengeOpen, ctl.currentPassword, ctl.picker]).toEqual(["in", true, "p", picker]);
  });
});
