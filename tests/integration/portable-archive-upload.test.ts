/*
 * The archive reaches preview and import as a streamed file upload (#1566,
 * plan in note 46292): `multipart/form-data` with the small fields first and
 * the archive file last, the part named `archive`. The route reads the fields,
 * validates them with today's schemas, runs the access check and (import) the
 * step-up check, and only then lets the file part flow. Anything but the
 * client's own shape is refused with 400 `request_malformed`, and a refused
 * body is still read to its end so the connection can answer the next
 * request.
 *
 * Each case below is one of the plan's given/when/then cases. The body is the
 * platform's own multipart serialisation of the client's form, except where a
 * case needs a body the client never sends.
 */
import { randomUUID } from "node:crypto";
import { mkdtemp, readdir, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { eq } from "drizzle-orm";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import { getDb } from "@/db";
import { items } from "@/db/schema";
import { encryptPortableArchive } from "@/server/portable-archive";
import { cleanupIntegrationEnvironment, createIntegrationFixture, sessionHeaders, type IntegrationFixture } from "./support/fixtures";
import {
  archiveFileBytes,
  archiveForm,
  encodeForm,
  fileContentOffset,
  rawMultipart,
  trackedBody,
  type ArchiveUploadFields,
} from "./support/portable-archive-upload";
import { errorOf, postForm, postUpload, proofCookie } from "./support/portable-archive-routes";
import { createRequestEvent, loadRoute, type RouteHandler } from "./support/request-event";

const { POST: previewRoute } = await loadRoute("portable-archives/preview");
const { POST: importRoute } = await loadRoute("portable-archives/import");

/** The archive slot hooks.server.js puts in front of both routes: the body under its 408 watchdog. */
const slot = (await import(/* @vite-ignore */ new URL("../../web/src/lib/server/archive-slot.js", import.meta.url).href)) as {
  holdArchiveSlot(routeId: string, request: Request, options?: { stallMs?: number; deadlineMs?: number }): null | Response | { request: Request; release(): void };
};

const PREVIEW = "/api/portable-archives/preview";
const IMPORT = "/api/portable-archives/import";
const PASSPHRASE = "integration-passphrase";
const MIB = 1_048_576;

let scratchDirectory: string;
const savedScratchDirectory = process.env.ORBIT_ARCHIVE_SCRATCH_DIR;

beforeAll(async () => {
  scratchDirectory = await mkdtemp(join(tmpdir(), "orbit-1566-scratch-"));
  process.env.ORBIT_ARCHIVE_SCRATCH_DIR = scratchDirectory;
});

afterAll(async () => {
  if (savedScratchDirectory === undefined) delete process.env.ORBIT_ARCHIVE_SCRATCH_DIR;
  else process.env.ORBIT_ARCHIVE_SCRATCH_DIR = savedScratchDirectory;
  await rm(scratchDirectory, { recursive: true, force: true });
  await cleanupIntegrationEnvironment();
});

/** A one-section, one-item archive file for `fixture`, sealed under PASSPHRASE. */
function archiveFor(fixture: IntegrationFixture, title = `Imported ${randomUUID()}`): Buffer {
  const payload = {
    format: "orbit-portable-archive",
    version: 1,
    household: { name: fixture.household.name },
    sections: [{ id: fixture.section.id, slug: "imported", name: "Imported", icon: "home", accent: "sage", position: 1, visible: true }],
    items: [{ id: randomUUID(), sectionId: fixture.section.id, title, currency: "GBP", status: "active" as const }],
    dueEvents: [],
    reminderRules: [],
    documents: [],
  };
  return archiveFileBytes(encryptPortableArchive(Buffer.from(JSON.stringify(payload)), PASSPHRASE));
}

async function itemCount(householdId: string): Promise<number> {
  return (await getDb().select({ id: items.id }).from(items).where(eq(items.householdId, householdId))).length;
}

async function scratchFiles(): Promise<string[]> {
  return (await readdir(scratchDirectory)).filter((name) => name.startsWith("orbit-archive-import-"));
}

/**
 * Posts `bytes` with the file part's content held back in its own chunks, and
 * reports how much of the body had been pulled when the response came.
 */
async function postTracked(handler: RouteHandler, path: string, session: Awaited<ReturnType<IntegrationFixture["session"]>>, bytes: Buffer, contentType: string, cookie?: string) {
  const start = fileContentOffset(bytes);
  const { body, stats } = trackedBody(bytes, { cuts: [start] });
  const response = await postUpload(handler, { path, session, body, contentType, cookie });
  return { response, pulledAtResponse: stats.pulledBytes, fileStart: start, stats, total: bytes.length };
}

async function expectReadToEnd(stats: { pulledBytes: number; done: boolean }, total: number) {
  await vi.waitFor(() => {
    expect(stats.pulledBytes, "the rest of the body was read away").toBe(total);
    expect(stats.done).toBe(true);
  }, { timeout: 5_000, interval: 10 });
}

describe("the wire and its order (#1566)", () => {
  it("previews an archive posted as multipart, file last: 200 with today's preview object", async () => {
    // Catches: a route still reading the body as JSON.
    const fixture = await createIntegrationFixture("arch1566-preview-200");
    const owner = await fixture.session("owner");

    const response = await postForm(previewRoute, PREVIEW, owner, archiveForm({ householdId: fixture.household.id, passphrase: PASSPHRASE }, archiveFor(fixture)));

    expect(response.status, JSON.stringify(await errorOf(response).catch(() => ({})))).toBe(200);
    expect(await response.json()).toEqual({
      preview: { householdName: fixture.household.name, sections: 1, items: 1, documents: 0, conflicts: [], documentsExcluded: false },
    });
    expect(await scratchFiles(), "no scratch file left").toEqual([]);
  });

  it("imports an archive posted with householdId, passphrase, conflictItemIds and the file: 200 and the household holds the item", async () => {
    // Catches: a route that drops or misreads conflictItemIds (a JSON array in one field).
    const fixture = await createIntegrationFixture("arch1566-import-200");
    const owner = await fixture.session("owner");
    const before = await itemCount(fixture.household.id);
    const title = `Imported ${randomUUID()}`;

    const response = await postForm(
      importRoute,
      IMPORT,
      owner,
      archiveForm({ householdId: fixture.household.id, passphrase: PASSPHRASE, conflictItemIds: [] }, archiveFor(fixture, title)),
      await proofCookie(owner, "archive_import"),
    );

    expect(response.status, JSON.stringify(await errorOf(response).catch(() => ({})))).toBe(200);
    expect(await response.json()).toEqual({ importedItems: 1, documentsExcluded: 0 });
    expect(await itemCount(fixture.household.id)).toBe(before + 1);
    expect(await scratchFiles(), "no scratch file left").toEqual([]);
  });
});

describe("a body that is not the client's shape is refused with 400 request_malformed (#1566)", () => {
  const BOUNDARY = "----orbit-1566-integration-boundary";
  const multipart = `multipart/form-data; boundary=${BOUNDARY}`;

  function bodies(fixture: IntegrationFixture, withConflicts: boolean): Array<[string, string, Buffer]> {
    const file = archiveFor(fixture);
    const fields = [
      { name: "householdId", value: fixture.household.id },
      { name: "passphrase", value: PASSPHRASE },
      ...(withConflicts ? [{ name: "conflictItemIds", value: "[]" }] : []),
    ];
    const filePart = { name: "archive", filename: "household.orbit-archive.json", value: file };
    return [
      // Every required field comes first: a required field sent after the file is, until the
      // file has been read, a missing field, and that is 422 validation_failed before any of it is.
      ["a text field after the file part", multipart, rawMultipart(BOUNDARY, [...fields, filePart, { name: "trailing", value: "x" }])],
      ["two file parts", multipart, rawMultipart(BOUNDARY, [...fields, filePart, filePart])],
      ["no file part", multipart, rawMultipart(BOUNDARY, fields)],
      ["a broken delimiter", multipart, rawMultipart(BOUNDARY, [...fields, filePart], { opening: "--not-the-boundary" })],
      ["no closing delimiter", multipart, rawMultipart(BOUNDARY, [...fields, filePart], { closing: false })],
      ["a field named twice", multipart, rawMultipart(BOUNDARY, [fields[0], fields[0], ...fields.slice(1), filePart])],
      ["bytes after the closing delimiter", multipart, Buffer.concat([rawMultipart(BOUNDARY, [...fields, filePart]), Buffer.from("trailing junk")])],
      ["two bytes that are not a CRLF in place of the final CRLF", multipart, Buffer.concat([rawMultipart(BOUNDARY, [...fields, filePart]).subarray(0, -2), Buffer.from("XY")])],
      ["more than one CRLF after the closing delimiter", multipart, Buffer.concat([rawMultipart(BOUNDARY, [...fields, filePart]), Buffer.from("\r\n")])],
      ["a file part's header block over 16 KiB", multipart, rawMultipart(BOUNDARY, [...fields, { ...filePart, filename: "a".repeat(17 * 1024) }])],
      ["a text field's header block over 16 KiB", multipart, rawMultipart(BOUNDARY, [{ name: "n".repeat(17 * 1024), value: "x" }, ...fields, filePart])],
      ["a file part with the wrong name", multipart, rawMultipart(BOUNDARY, [...fields, { ...filePart, name: "upload" }])],
      ["today's JSON body (not multipart)", "application/json", Buffer.from(JSON.stringify({
        householdId: fixture.household.id, archive: JSON.parse(file.toString("utf8")), passphrase: PASSPHRASE, ...(withConflicts ? { conflictItemIds: [] } : {}),
      }))],
    ];
  }

  for (const [route, path, handler] of [["preview", PREVIEW, previewRoute], ["import", IMPORT, importRoute]] as const) {
    it(`${route}: refuses each, decrypts and keeps nothing, leaves no scratch file, and reads the body away`, async () => {
      // Catches: a lenient reader; a refusal that leaves scratch behind or the body unread (the next request on the connection would hang).
      const fixture = await createIntegrationFixture(`arch1566-malformed-${route}`);
      const owner = await fixture.session("owner");
      const before = await itemCount(fixture.household.id);

      for (const [label, contentType, bytes] of bodies(fixture, route === "import")) {
        // A fresh proof per body: a body that gets past the fields spends its proof (ADR-0023 section 5).
        const cookie = route === "import" ? await proofCookie(owner, "archive_import") : undefined;
        const { body, stats } = trackedBody(bytes, { chunkSize: 16 * 1024 });
        const response = await postUpload(handler, { path, session: owner, body, contentType, cookie });
        expect(response.status, label).toBe(400);
        expect(await errorOf(response), label).toMatchObject({ code: "request_malformed", message: "That request is not well-formed" });
        await expectReadToEnd(stats, bytes.length);
        expect(await scratchFiles(), `${label}: no scratch file left`).toEqual([]);
      }
      expect(await itemCount(fixture.household.id), "nothing was imported").toBe(before);
    }, 60_000);
  }

  it("refuses fields over 1 MiB together before the file part is read", async () => {
    // Catches: no cap on the fields, or a cap applied after the file is read.
    const fixture = await createIntegrationFixture("arch1566-fields-cap");
    const owner = await fixture.session("owner");
    const bytes = rawMultipart(BOUNDARY, [
      { name: "householdId", value: fixture.household.id },
      { name: "passphrase", value: PASSPHRASE },
      { name: "currentPassword", value: "p".repeat(MIB + 1) },
      { name: "archive", filename: "household.orbit-archive.json", value: Buffer.concat([archiveFor(fixture), Buffer.alloc(4 * MIB, " ")]) },
    ]);

    const sent = await postTracked(previewRoute, PREVIEW, owner, bytes, multipart);

    expect(sent.response.status).toBe(400);
    expect((await errorOf(sent.response)).code).toBe("request_malformed");
    expect(sent.pulledAtResponse, "bytes pulled before the refusal").toBeLessThanOrEqual(sent.fileStart);
    await expectReadToEnd(sent.stats, sent.total);
  }, 60_000);
});

describe("bad fields are 422 validation_failed with today's issues (#1566)", () => {
  const cases: Array<[string, "preview" | "import", Partial<ArchiveUploadFields>, Array<string | number>]> = [
    ["a householdId that is not a uuid", "preview", { householdId: "not-a-uuid" }, ["householdId"]],
    ["a householdId that is not a uuid", "import", { householdId: "not-a-uuid" }, ["householdId"]],
    ["a passphrase under the floor", "preview", { passphrase: "short" }, ["passphrase"]],
    ["a passphrase over 256 characters", "import", { passphrase: "p".repeat(257) }, ["passphrase"]],
    ["a conflictItemIds entry that is not a uuid", "import", { conflictItemIds: ["not-a-uuid"] }, ["conflictItemIds", 0]],
  ];

  it.each(cases)("refuses %s on %s", async (_label, route, override, path) => {
    // Catches: field validation lost or reshaped when the fields stopped being one JSON body.
    const fixture = await createIntegrationFixture(`arch1566-invalid-${route}`);
    const owner = await fixture.session("owner");
    const fields: ArchiveUploadFields = {
      householdId: fixture.household.id,
      passphrase: PASSPHRASE,
      ...(route === "import" ? { conflictItemIds: [] } : {}),
      ...override,
    };
    const response = await postForm(
      route === "preview" ? previewRoute : importRoute,
      route === "preview" ? PREVIEW : IMPORT,
      owner,
      archiveForm(fields, archiveFor(fixture)),
      route === "import" ? await proofCookie(owner, "archive_import") : undefined,
    );

    expect(response.status).toBe(422);
    const error = await errorOf(response);
    expect(error.code).toBe("validation_failed");
    expect(error.issues).toEqual(expect.arrayContaining([expect.objectContaining({ path })]));
  });
});

describe("refusals before the file is read (#1566)", () => {
  async function uploadFor(fixture: IntegrationFixture, route: "preview" | "import") {
    const fields: ArchiveUploadFields = { householdId: fixture.household.id, passphrase: PASSPHRASE, ...(route === "import" ? { conflictItemIds: [] } : {}) };
    // Large enough that reading it is not one chunk.
    return encodeForm(archiveForm(fields, Buffer.concat([archiveFor(fixture), Buffer.alloc(2 * MIB, " ")])));
  }

  const people: Array<["member" | "outsider", number, string]> = [
    ["member", 403, "owner_required"],
    ["outsider", 404, "household_not_found"],
  ];

  for (const [role, status, code] of people) {
    for (const route of ["preview", "import"] as const) {
      it(`${route}: a ${role} gets today's ${code}, sent before any byte of the file part is pulled, and the body is read away`, async () => {
        // Catches: an access check that runs only after the whole body was read (today's request.json()).
        const fixture = await createIntegrationFixture(`arch1566-${role}-${route}`);
        const session = await fixture.session(role);
        const upload = await uploadFor(fixture, route);
        const cookie = route === "import" ? await proofCookie(session, "archive_import") : undefined;

        const sent = await postTracked(route === "preview" ? previewRoute : importRoute, route === "preview" ? PREVIEW : IMPORT, session, upload.bytes, upload.contentType, cookie);

        expect(sent.response.status).toBe(status);
        expect((await errorOf(sent.response)).code).toBe(code);
        expect(sent.pulledAtResponse, "bytes pulled when the refusal was sent").toBeLessThanOrEqual(sent.fileStart);
        await expectReadToEnd(sent.stats, sent.total);
      }, 60_000);
    }
  }

  it("import without a recent authentication gets today's step-up refusal before the file is read, and brings nothing in", async () => {
    // Catches: the step-up check moved after the file is read.
    const fixture = await createIntegrationFixture("arch1566-import-step-up");
    const owner = await fixture.session("owner");
    const before = await itemCount(fixture.household.id);
    const upload = await uploadFor(fixture, "import");

    const sent = await postTracked(importRoute, IMPORT, owner, upload.bytes, upload.contentType);

    expect(sent.response.status).toBe(403);
    expect((await errorOf(sent.response)).code).toBe("recent_authentication_required");
    expect(sent.pulledAtResponse, "bytes pulled when the refusal was sent").toBeLessThanOrEqual(sent.fileStart);
    await expectReadToEnd(sent.stats, sent.total);
    expect(await itemCount(fixture.household.id)).toBe(before);
  }, 60_000);

  it("preview is still not re-challenged: an owner with no proof gets the preview", async () => {
    // Catches: the step-up check spread to the preview when the routes were reworked.
    const fixture = await createIntegrationFixture("arch1566-preview-no-step-up");
    const owner = await fixture.session("owner");

    const response = await postForm(previewRoute, PREVIEW, owner, archiveForm({ householdId: fixture.household.id, passphrase: PASSPHRASE }, archiveFor(fixture)));

    expect(response.status, JSON.stringify(await errorOf(response).catch(() => ({})))).toBe(200);
    expect(((await response.json()) as { preview: { items: number } }).preview.items).toBe(1);
  });
});

describe("a missing field is 422 validation_failed, as before the upload was multipart (#1566)", () => {
  const BOUNDARY = "----orbit-1566-missing-boundary";
  const multipart = `multipart/form-data; boundary=${BOUNDARY}`;
  type Field = "householdId" | "passphrase" | "conflictItemIds";
  const cases: Array<["preview" | "import", Field]> = [
    ["preview", "passphrase"],
    ["preview", "householdId"],
    ["import", "passphrase"],
    ["import", "householdId"],
    ["import", "conflictItemIds"],
  ];

  it.each(cases)("%s: a body with no %s answers 422 with that field in the issues, not 400", async (route, missing) => {
    // Catches: "a bad field is still validation_failed 422" (plan, note 46292) lost to a malformed-body check on absent fields.
    const fixture = await createIntegrationFixture(`arch1566-missing-${route}-${missing}`);
    const owner = await fixture.session("owner");
    const before = await itemCount(fixture.household.id);
    const fields = [
      { name: "householdId", value: fixture.household.id },
      { name: "passphrase", value: PASSPHRASE },
      ...(route === "import" ? [{ name: "conflictItemIds", value: "[]" }] : []),
    ].filter((field) => field.name !== missing);
    const bytes = rawMultipart(BOUNDARY, [...fields, { name: "archive", filename: "household.orbit-archive.json", value: archiveFor(fixture) }]);

    const response = await postUpload(route === "preview" ? previewRoute : importRoute, {
      path: route === "preview" ? PREVIEW : IMPORT,
      session: owner,
      body: new Uint8Array(bytes),
      contentType: multipart,
      cookie: route === "import" ? await proofCookie(owner, "archive_import") : undefined,
    });

    expect(response.status, JSON.stringify(await errorOf(response).catch(() => ({})))).toBe(422);
    const error = await errorOf(response);
    expect(error.code).toBe("validation_failed");
    expect(error.issues).toEqual(expect.arrayContaining([expect.objectContaining({ path: [missing] })]));
    expect(await itemCount(fixture.household.id), "nothing was imported").toBe(before);
    expect(await scratchFiles(), "no scratch file left").toEqual([]);
  });
});

describe("a wrong name on the file part is refused before the step-up proof is spent (#1566)", () => {
  const BOUNDARY = "----orbit-1566-name-boundary";
  const multipart = `multipart/form-data; boundary=${BOUNDARY}`;

  it("import: the proof that met a mis-named file part still works for a good body", async () => {
    // Catches: the part's name checked only once the file is taken, after the proof was spent (the person would be asked to prove themselves again for a request the client never makes).
    const fixture = await createIntegrationFixture("arch1566-name-before-proof");
    const owner = await fixture.session("owner");
    const before = await itemCount(fixture.household.id);
    const cookie = await proofCookie(owner, "archive_import");
    const file = archiveFor(fixture);
    const fields = [
      { name: "householdId", value: fixture.household.id },
      { name: "passphrase", value: PASSPHRASE },
      { name: "conflictItemIds", value: "[]" },
    ];

    const refused = await postUpload(importRoute, {
      path: IMPORT,
      session: owner,
      body: new Uint8Array(rawMultipart(BOUNDARY, [...fields, { name: "upload", filename: "household.orbit-archive.json", value: file }])),
      contentType: multipart,
      cookie,
    });
    expect(refused.status).toBe(400);
    expect(await errorOf(refused)).toMatchObject({ code: "request_malformed" });
    expect(await itemCount(fixture.household.id), "nothing was imported").toBe(before);

    // The same proof, on a body the client would really send.
    const accepted = await postForm(importRoute, IMPORT, owner, archiveForm({ householdId: fixture.household.id, passphrase: PASSPHRASE, conflictItemIds: [] }, file), cookie);
    expect(accepted.status, JSON.stringify(await errorOf(accepted).catch(() => ({})))).toBe(200);
    expect(await itemCount(fixture.household.id)).toBe(before + 1);
  });
});

describe("a body that stops in the middle of the file leaves no scratch file (#1566)", () => {
  /**
   * The upload's bytes in pieces up to a point inside the archive's
   * ciphertext, by which time the scratch file exists; then either the source
   * fails ("abort": a client that went away) or it goes quiet until `resume`
   * ("stall": a client that stopped sending).
   */
  function stoppingBody(bytes: Buffer, stopAt: number, how: "abort" | "stall") {
    let offset = 0;
    let stopped = false;
    let resume!: () => void;
    const resumed = new Promise<void>((done) => { resume = done; });
    const seen = { scratchAtStop: [] as string[] };
    const body = new ReadableStream<Uint8Array>({
      async pull(controller) {
        if (offset < stopAt || stopped) {
          const end = Math.min(offset + 16 * 1024, stopped ? bytes.length : stopAt);
          if (end <= offset) { controller.close(); return; }
          controller.enqueue(bytes.slice(offset, end));
          offset = end;
          return;
        }
        stopped = true;
        await vi.waitFor(async () => {
          seen.scratchAtStop = await scratchFiles();
          expect(seen.scratchAtStop, "the scratch file exists when the body stops: the stop is mid-file").toHaveLength(1);
        }, { timeout: 5_000, interval: 10 });
        if (how === "abort") controller.error(new Error("aborted"));
        else await resumed;
      },
    }, { highWaterMark: 0 });
    return { body, seen, resume };
  }

  for (const route of ["preview", "import"] as const) {
    for (const how of ["abort", "stall"] as const) {
      it(`${route}: ${how === "abort" ? "the client going away" : "the 408 watchdog cutting a stalled body"} mid-file removes the scratch file`, async () => {
        // Catches: a scratch file left in the 320m tmpfs by a body that stops after the file part began.
        const fixture = await createIntegrationFixture(`arch1566-stop-${route}-${how}`);
        const owner = await fixture.session("owner");
        const before = await itemCount(fixture.household.id);
        const file = archiveFor(fixture);
        const fields = { householdId: fixture.household.id, passphrase: PASSPHRASE, ...(route === "import" ? { conflictItemIds: [] } : {}) };
        const upload = await encodeForm(archiveForm(fields, file));
        const stopAt = fileContentOffset(upload.bytes) + file.indexOf('"ciphertext":"') + '"ciphertext":"'.length + 40;
        const { body, seen, resume } = stoppingBody(upload.bytes, stopAt, how);
        const cookie = route === "import" ? await proofCookie(owner, "archive_import") : undefined;
        const { event, applyTo } = createRequestEvent({
          url: `http://127.0.0.1:3000${route === "preview" ? PREVIEW : IMPORT}`,
          method: "POST",
          headers: sessionHeaders(owner, { "content-type": upload.contentType, ...(cookie ? { cookie } : {}) }),
          body,
        });
        // As hooks.server.js does for the archive routes: the slot, and the body under the watchdog.
        const held = slot.holdArchiveSlot(route === "preview" ? PREVIEW : IMPORT, event.request, { stallMs: 300, deadlineMs: 60_000 });
        if (held === null || held instanceof Response) throw new Error("the archive slot should have been free");
        event.request = held.request;

        try {
          const outcome = await Promise.resolve((route === "preview" ? previewRoute : importRoute)(event)).then((response) => applyTo(response), (error: unknown) => error);

          expect(seen.scratchAtStop, "the scratch file existed when the body stopped").toHaveLength(1);
          if (how === "stall") {
            expect(outcome).toBeInstanceOf(Response);
            expect((outcome as Response).status).toBe(408);
            expect(await errorOf(outcome as Response)).toMatchObject({ code: "request_timeout" });
          }
          expect(await scratchFiles(), "no scratch file left").toEqual([]);
          expect(await itemCount(fixture.household.id), "nothing was imported").toBe(before);
        } finally {
          held.release();
          resume();
        }
      }, 60_000);
    }
  }
});
