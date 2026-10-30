import { mkdtempSync, openAsBlob, readFileSync, rmSync, truncateSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { afterAll, afterEach, beforeEach, describe, expect, it, vi } from "vitest";

/*
 * The browser sends the chosen archive file as it sits on disk (#1566, plan
 * in note 46292, mechanism 5):
 *  - `previewPortableArchive` and `importPortableArchive` (workspace.js) take
 *    `{ file, passphrase, skip, currentPassword }` and post a FormData built
 *    in the wire order -- householdId, passphrase, currentPassword (when
 *    given), conflictItemIds (import only, the JSON text of `skip`) -- with
 *    the File appended last as `archive`;
 *  - nothing reads the file: not `text()`, not `arrayBuffer()`; the browser
 *    streams a File body from disk;
 *  - `csrfFetch` sends a FormData as it is, so the browser sets the
 *    multipart content type with its boundary; `content-type:
 *    application/json` is only for an object body; the x-csrf-token header
 *    is unchanged;
 *  - DeskArchive.svelte and PocketArchive.svelte stop parsing the file, and
 *    map the server's `archive_invalid` to "this file is not an Orbit
 *    archive".
 *
 * The file is a 300 MiB file on disk, opened as a Blob without being read
 * (fs.openAsBlob on a sparse file), so a client that read it would be both
 * caught by the spies and slow. Svelte components are not mounted in this
 * suite, so the two layouts are pinned on their source, as
 * archive-challenge-opens-once.test.mjs does.
 */

const MIB = 1_048_576;
const HOUSEHOLD = "22222222-2222-4222-8222-222222222222";
const PASSPHRASE = "a-long-enough-passphrase";
const SKIP = ["33333333-3333-4333-8333-333333333333", "44444444-4444-4444-8444-444444444444"];

const scratch = mkdtempSync(join(tmpdir(), "orbit-1566-client-"));
const sparse = join(scratch, "household.orbit-archive.json");
writeFileSync(sparse, "");
truncateSync(sparse, 300 * MIB);

afterAll(() => rmSync(scratch, { recursive: true, force: true }));

/** @type {Array<{ url: string, init: RequestInit }>} */
let calls = [];

beforeEach(() => {
  calls = [];
  vi.stubGlobal("fetch", vi.fn(async (url, init = {}) => {
    calls.push({ url: String(url), init });
    if (String(url) === "/api/auth/session") return Response.json({ csrfToken: "csrf-token-1566" });
    if (String(url).endsWith("/preview")) return Response.json({ preview: { householdName: "Home", items: 1 } });
    if (String(url).endsWith("/import")) return Response.json({ importedItems: 1, documentsExcluded: 0 });
    return Response.json({ archive: { id: "archive-1" } });
  }));
});

afterEach(() => {
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});

/** A 300 MiB File whose every reading method is spied on. */
async function chosenFile() {
  const file = new File([await openAsBlob(sparse)], "household.orbit-archive.json", { type: "application/json" });
  const reads = ["text", "arrayBuffer", "bytes", "stream"].filter((name) => typeof file[name] === "function").map((name) => vi.spyOn(file, name));
  return { file, reads };
}

async function workspace() {
  return import("../../web/src/lib/data/workspace.js");
}

/** The archive route's call, and its body's entries in order. */
function archiveCall(path) {
  const call = calls.find((candidate) => candidate.url === path);
  expect(call, `${path} was called`).toBeDefined();
  expect(call.init.body, "the body is a FormData").toBeInstanceOf(FormData);
  return { call, entries: [...call.init.body.entries()] };
}

function headersOf(call) {
  return new Headers(call.init.headers);
}

describe("previewPortableArchive sends the chosen file, unread, as the last part (#1566)", () => {
  it("posts a FormData of householdId, passphrase, then the File, and never reads the file", async () => {
    // Catches: the client still reading and parsing a 300 MiB file in the tab (note 46292).
    const { previewPortableArchive } = await workspace();
    const { file, reads } = await chosenFile();

    const preview = await previewPortableArchive(HOUSEHOLD, { file, passphrase: PASSPHRASE });

    expect(preview).toEqual({ householdName: "Home", items: 1 });
    const { call, entries } = archiveCall("/api/portable-archives/preview");
    expect(entries.map(([name]) => name)).toEqual(["householdId", "passphrase", "archive"]);
    expect(entries[0][1]).toBe(HOUSEHOLD);
    expect(entries[1][1]).toBe(PASSPHRASE);
    const last = entries.at(-1)[1];
    expect(last).toBeInstanceOf(File);
    expect(last.size).toBe(300 * MIB);
    expect(last.name).toBe("household.orbit-archive.json");
    for (const read of reads) expect(read, "the client read the file").not.toHaveBeenCalled();
    // The browser sets the multipart type and boundary itself; a JSON type would break the upload.
    expect(headersOf(call).get("content-type")).toBeNull();
    expect(headersOf(call).get("x-csrf-token")).toBe("csrf-token-1566");
  });

  it("puts currentPassword after passphrase and before the file when it is given", async () => {
    const { previewPortableArchive } = await workspace();
    const { file } = await chosenFile();

    await previewPortableArchive(HOUSEHOLD, { file, passphrase: PASSPHRASE, currentPassword: "s3cret" });

    const { entries } = archiveCall("/api/portable-archives/preview");
    expect(entries.map(([name]) => name)).toEqual(["householdId", "passphrase", "currentPassword", "archive"]);
    expect(entries[2][1]).toBe("s3cret");
  });
});

describe("importPortableArchive sends the chosen file, unread, as the last part (#1566)", () => {
  it("posts householdId, passphrase, currentPassword, conflictItemIds as JSON text, then the File, and never reads the file", async () => {
    // Catches: skip sent as repeated fields or not at all, or the file read before sending.
    const { importPortableArchive } = await workspace();
    const { file, reads } = await chosenFile();

    const outcome = await importPortableArchive(HOUSEHOLD, { file, passphrase: PASSPHRASE, skip: SKIP, currentPassword: "s3cret" });

    expect(outcome).toEqual({ importedItems: 1, documentsExcluded: 0 });
    const { call, entries } = archiveCall("/api/portable-archives/import");
    expect(entries.map(([name]) => name)).toEqual(["householdId", "passphrase", "currentPassword", "conflictItemIds", "archive"]);
    expect(JSON.parse(String(entries[3][1]))).toEqual(SKIP);
    expect(entries.at(-1)[1]).toBeInstanceOf(File);
    expect(entries.at(-1)[1].size).toBe(300 * MIB);
    for (const read of reads) expect(read, "the client read the file").not.toHaveBeenCalled();
    expect(headersOf(call).get("content-type")).toBeNull();
    expect(headersOf(call).get("x-csrf-token")).toBe("csrf-token-1566");
  });

  it("sends an empty skip as an empty JSON array and leaves out a missing currentPassword", async () => {
    const { importPortableArchive } = await workspace();
    const { file } = await chosenFile();

    await importPortableArchive(HOUSEHOLD, { file, passphrase: PASSPHRASE, skip: [] });

    const { entries } = archiveCall("/api/portable-archives/import");
    expect(entries.map(([name]) => name)).toEqual(["householdId", "passphrase", "conflictItemIds", "archive"]);
    expect(entries[2][1]).toBe("[]");
  });
});

describe("csrfFetch still sends an object body as JSON (#1566)", () => {
  it("writePortableArchive keeps content-type application/json and a JSON body", async () => {
    // Catches: the FormData change spilling into every other mutating call.
    const { writePortableArchive } = await workspace();
    await writePortableArchive(HOUSEHOLD, { passphrase: PASSPHRASE });

    const call = calls.find((candidate) => candidate.url === `/api/households/${HOUSEHOLD}/portable-archives`);
    expect(headersOf(call).get("content-type")).toBe("application/json");
    expect(JSON.parse(String(call.init.body))).toMatchObject({ passphrase: PASSPHRASE });
  });
});

describe.each([
  "web/src/routes/household/[id]/DeskArchive.svelte",
  "web/src/routes/household/[id]/PocketArchive.svelte",
])("%s hands over the file and does not read it (#1566)", (path) => {
  const source = readFileSync(resolve(import.meta.dirname, "../..", path), "utf8");

  it("never reads the chosen file in the page", () => {
    // Catches: JSON.parse(await file.text()) left in a layout.
    expect(source).not.toMatch(/\bfile\.(text|arrayBuffer|bytes|stream)\(/u);
    expect(source).not.toMatch(/JSON\.parse\(\s*await\b/u);
  });

  it("passes the file itself to preview and import", () => {
    expect(source).toMatch(/previewPortableArchive\(\s*householdId,\s*\{\s*file\b/u);
    expect(source).toMatch(/importPortableArchive\(\s*householdId,\s*\{\s*file\b/u);
  });

  it("maps the server's archive_invalid to the card's sentence for a file that is not an archive", () => {
    expect(source).toContain('"archive_invalid"');
    expect(source).toContain("this file is not an Orbit archive");
  });
});
