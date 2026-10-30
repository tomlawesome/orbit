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
import { cleanupIntegrationEnvironment, createIntegrationFixture, type IntegrationFixture } from "./support/fixtures";
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
import { loadRoute, type RouteHandler } from "./support/request-event";

const { POST: previewRoute } = await loadRoute("portable-archives/preview");
const { POST: importRoute } = await loadRoute("portable-archives/import");

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
      ["a text field after the file part", multipart, rawMultipart(BOUNDARY, [...fields.slice(0, 1), filePart, ...fields.slice(1)])],
      ["two file parts", multipart, rawMultipart(BOUNDARY, [...fields, filePart, filePart])],
      ["no file part", multipart, rawMultipart(BOUNDARY, fields)],
      ["a broken delimiter", multipart, rawMultipart(BOUNDARY, [...fields, filePart], { opening: "--not-the-boundary" })],
      ["no closing delimiter", multipart, rawMultipart(BOUNDARY, [...fields, filePart], { closing: false })],
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
