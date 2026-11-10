/**
 * #1797 (an over-limit archive upload is refused early; spec: GitLab note
 * 56654, section 7 tests 9-11): the real import route, database, document
 * store and a real v2 export. A source gated after P bytes (header plus the
 * manifest's segments) stands in for the slow link: the early refusal must be
 * answered while the gate is closed, with the same code and message the final
 * check gives for the same archive, and must leave no start record, no staged
 * document and no .upload.tmp. Written from the specification alone, before
 * the build; it asserts on observable effects only, so it compiles today.
 */
import { readdirSync } from "node:fs";
import { join } from "node:path";
import { and, eq, isNull } from "drizzle-orm";
import { afterAll, afterEach, describe, expect, it } from "vitest";
import { getDb } from "@/db";
import { documents, portableArchiveImports } from "@/db/schema";
import { getDocumentConfig, resetDocumentConfigForTests } from "@/server/documents/config";
import * as repository from "@/server/portable-archive-repository";
import { cleanupIntegrationEnvironment, createIntegrationFixture, type IntegrationFixture } from "./support/fixtures";
import { archiveForm, encodeForm, fileContentOffset, trackedBody } from "./support/portable-archive-upload";
import { errorOf, postUpload, proofCookie } from "./support/portable-archive-routes";
import { loadRoute } from "./support/request-event";
import { seedStoredDocuments } from "./support/stored-documents";
import { syntheticPdf } from "../support/synthetic-documents";
import { v2HeadSliceBytes } from "../support/portable-archive-v2";

const MIB = 1_048_576;
const KIB = 1024;
const passphrase = "correct-horse-battery-staple";
const IMPORT_PATH = "/api/portable-archives/import";
const { POST: importRoute } = await loadRoute("portable-archives/import");

afterAll(async () => {
  await cleanupIntegrationEnvironment();
});

const savedQuota = process.env.DOCUMENT_HOUSEHOLD_QUOTA_BYTES;
const opened: Array<() => void> = [];
afterEach(() => {
  for (const open of opened.splice(0)) open();
  if (savedQuota === undefined) delete process.env.DOCUMENT_HOUSEHOLD_QUOTA_BYTES;
  else process.env.DOCUMENT_HOUSEHOLD_QUOTA_BYTES = savedQuota;
  resetDocumentConfigForTests();
});

/** A real, openable PDF of exactly `size` bytes (copied from portable-archive-v2.test.ts). */
function pdfOfSize(size: number, label: string): Buffer {
  let padding = Math.max(0, size - 800);
  for (let attempt = 0; attempt < 4; attempt += 1) {
    const pdf = syntheticPdf(`${label} ${"x".repeat(padding)}`);
    if (pdf.length === size) return pdf;
    padding += size - pdf.length;
    if (padding < 0) throw new Error(`no PDF of ${size} bytes`);
  }
  throw new Error(`no PDF of ${size} bytes`);
}

/** A v2 export of a household holding 14 MiB and 13 MiB documents (27 MiB), as a file. */
async function exportedArchive(label: string): Promise<Buffer> {
  const source = await createIntegrationFixture(label);
  await seedStoredDocuments(source, [pdfOfSize(14 * MIB, `${label} a`), pdfOfSize(13 * MIB, `${label} b`)]);
  const archive = await repository.createPortableArchive({ userId: source.users.owner.id, householdId: source.household.id, passphrase, includeDocuments: true });
  const { bytes } = await repository.readPortableArchive(source.users.owner.id, archive.id);
  return Buffer.from(bytes);
}

/** The smallest quota the configuration accepts, 25 MiB, or `bytes`: under the 27 MiB the archive carries. */
function setQuota(bytes: number): void {
  process.env.DOCUMENT_HOUSEHOLD_QUOTA_BYTES = String(bytes);
  resetDocumentConfigForTests();
}

const uploadTemporaryFiles = () =>
  readdirSync(join(getDocumentConfig().storageRoot, "portable-archives")).filter((name) => name.endsWith(".upload.tmp"));

const stagedRows = (householdId: string) =>
  getDb().select({ id: documents.id }).from(documents).where(and(eq(documents.householdId, householdId), isNull(documents.itemId)));
const importRows = (householdId: string) =>
  getDb().select({ id: portableArchiveImports.id }).from(portableArchiveImports).where(eq(portableArchiveImports.householdId, householdId));

/**
 * The request body in 64 KiB chunks, held after `gateAt` bytes until the test
 * opens the gate (or the test ends). `stats.pulledBytes` is what the server
 * has taken so far.
 */
function gatedBody(bytes: Uint8Array, gateAt: number) {
  const stats = { pulledBytes: 0, done: false };
  let release!: () => void;
  const gate = new Promise<void>((resolve) => { release = resolve; });
  opened.push(release);
  let offset = 0;
  const body = new ReadableStream<Uint8Array>({
    async pull(controller) {
      if (offset >= bytes.length) { stats.done = true; controller.close(); return; }
      if (offset >= gateAt) await gate;
      const limit = offset < gateAt ? gateAt : bytes.length;
      const end = Math.min(offset + 64 * KIB, limit);
      controller.enqueue(bytes.slice(offset, end));
      offset = end;
      stats.pulledBytes = offset;
    },
  }, { highWaterMark: 0 });
  return { body, stats, open: release };
}

const PENDING = Symbol("pending");
const within = <T>(promise: Promise<T>, ms: number) => Promise.race([promise, new Promise<typeof PENDING>((resolve) => setTimeout(() => resolve(PENDING), ms))]);
const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

/** Posts the import as a gated upload, and says where P is in the request body. */
async function gatedImport(target: IntegrationFixture, file: Buffer) {
  const owner = await target.session("owner");
  const upload = await encodeForm(archiveForm({ householdId: target.household.id, passphrase, conflictItemIds: [] }, file));
  const fileStart = fileContentOffset(upload.bytes);
  const gateAt = fileStart + v2HeadSliceBytes(file);
  const gated = gatedBody(upload.bytes, gateAt);
  const response = postUpload(importRoute, { path: IMPORT_PATH, session: owner, body: gated.body, contentType: upload.contentType, cookie: await proofCookie(owner, "archive_import") });
  return { ...gated, gateAt, response, upload };
}

/** The same archive, ungated, as one whole body. */
async function wholeImport(target: IntegrationFixture, file: Buffer) {
  const owner = await target.session("owner");
  const upload = await encodeForm(archiveForm({ householdId: target.household.id, passphrase, conflictItemIds: [] }, file));
  const tracked = trackedBody(upload.bytes);
  return postUpload(importRoute, { path: IMPORT_PATH, session: owner, body: tracked.body, contentType: upload.contentType, cookie: await proofCookie(owner, "archive_import") });
}

describe("#1797 test 9: the early refusal and the final refusal are the same refusal", () => {
  it("answers 413 archive_over_quota while the source is gated at P, with the code and message the whole-body import gets for the same archive", async () => {
    // Fails today: the 413 comes only after the full body, so the gated request is never answered.
    const file = await exportedArchive("arch1797-same-source");
    const early = await createIntegrationFixture("arch1797-same-early");
    const final = await createIntegrationFixture("arch1797-same-final");
    setQuota(25 * MIB);

    const gated = await gatedImport(early, file);
    const answered = await within(gated.response, 60_000);
    expect(answered, "the refusal was answered while the rest of the body was unsent").not.toBe(PENDING);
    const earlyResponse = answered as Response;
    const pulledAtAnswer = gated.stats.pulledBytes;
    const earlyError = await errorOf(earlyResponse);
    gated.open();

    expect(earlyResponse.status).toBe(413);
    expect(earlyError.code).toBe("archive_over_quota");
    expect(gated.stats.done || pulledAtAnswer < gated.upload.bytes.length, "the body was not read to its end before the answer").toBe(true);
    expect(pulledAtAnswer, "no more than the prefix (plus one read) was pulled before the answer").toBeLessThanOrEqual(gated.gateAt + 128 * KIB);

    const finalResponse = await wholeImport(final, file);
    expect(finalResponse.status).toBe(earlyResponse.status);
    expect(await errorOf(finalResponse), "same code and same message").toEqual(earlyError);
  }, 300_000);
});

describe("#1797 test 10: usage changes between the early check and phase 0", () => {
  it("an inspection that passes does not admit the import: a document stored in the household meanwhile makes phase 0 refuse archive_over_quota", async () => {
    // Passes before and after: the final check under the lock stays. It is the clause the issue requires.
    const file = await exportedArchive("arch1797-race-source");
    const target = await createIntegrationFixture("arch1797-race-target");
    // 27 MiB fits a 30 MiB quota on its own; 10 MiB stored later does not.
    setQuota(30 * MIB);

    const gated = await gatedImport(target, file);
    // Time for the early check to run on the prefix (one key derivation) and pass.
    await within(gated.response, 6_000);
    expect(await within(gated.response, 0), "the early check does not refuse an archive that fits").toBe(PENDING);
    await seedStoredDocuments(target, [pdfOfSize(10 * MIB, "arch1797 race")]);
    gated.open();

    const response = await gated.response;
    expect(response.status, JSON.stringify(await errorOf(response).catch(() => ({})))).toBe(413);
    const refusal = await errorOf(response);
    expect(refusal.code).toBe("archive_over_quota");
    expect(refusal.message).toMatch(/storage limit/iu);
    expect(await stagedRows(target.household.id).then((rows) => rows.length), "nothing of the archive was staged").toBe(0);
  }, 300_000);
});

describe("#1797 test 11: an early refusal leaves nothing behind", () => {
  it("no start record, no staged document and no .upload.tmp once the refusal is answered, with the rest of the body still unsent", async () => {
    // Fails today for the .upload.tmp timing (the answer, and the file's removal, come only after the full body); the record and staging parts pass before and after.
    const file = await exportedArchive("arch1797-clean-source");
    const target = await createIntegrationFixture("arch1797-clean-target");
    await getDb().delete(documents).where(eq(documents.id, target.document.id));
    setQuota(25 * MIB);

    const gated = await gatedImport(target, file);
    const answered = await within(gated.response, 60_000);
    expect(answered, "the refusal was answered while the rest of the body was unsent").not.toBe(PENDING);
    expect((answered as Response).status).toBe(413);

    expect(uploadTemporaryFiles(), "the partly stored upload is removed").toEqual([]);
    expect(await importRows(target.household.id), "no start record").toEqual([]);
    expect(await stagedRows(target.household.id), "no staged document").toEqual([]);
    gated.open();
  }, 300_000);
});
