/**
 * #1792 (spec-security-fixes.md 1.2 point 6, 1.4 L5): before the first byte
 * of an uploaded archive file is written to its spool file, the free space of
 * the document storage root is checked as the export's preflight does: the
 * upload is refused with 507 archive_storage_full when
 * free < declaredBytes * 1.01 + 256 MiB, declaredBytes being the request's
 * Content-Length. A disk that fills while the file is spooled (ENOSPC) is the
 * same 507. Either way no spool file is left.
 *
 * node:fs/promises is wrapped as in portable-archive-v2-export-disk.test.ts:
 * statfs reports a nearly full disk when asked to, and a write to a temp file
 * under the archive store fails with ENOSPC after its first chunk when asked
 * to. Everything else is the real file system.
 */
import { readdir } from "node:fs/promises";
import { join } from "node:path";
import { beforeEach, afterAll, describe, expect, it, vi } from "vitest";
import { cleanupIntegrationEnvironment, createIntegrationFixture } from "./support/fixtures";
import { archiveForm, encodeForm, fileContentOffset, trackedBody } from "./support/portable-archive-upload";
import { ARCHIVE_ORIGIN, errorOf } from "./support/portable-archive-routes";
import { callRouteForSession, loadRoute } from "./support/request-event";

const disk = vi.hoisted(() => ({ nearlyFull: false, failWrites: false, statfsCalls: 0, failedWrites: 0 }));

vi.mock("node:fs/promises", async (importOriginal) => {
  const original = await importOriginal<typeof import("node:fs/promises")>();
  const enospc = () => Object.assign(new Error("ENOSPC: no space left on device, write"), { code: "ENOSPC", errno: -28, syscall: "write" });
  const wrapped = {
    ...original,
    statfs: (async (path: Parameters<typeof original.statfs>[0], options?: Parameters<typeof original.statfs>[1]) => {
      disk.statfsCalls += 1;
      const real = await original.statfs(path, options as never);
      // 4 KiB free: below any archive plus margin.
      return disk.nearlyFull ? Object.assign(Object.create(Object.getPrototypeOf(real)), real, { bavail: 1, bfree: 1, bsize: 4096 }) : real;
    }) as typeof original.statfs,
    open: (async (path: Parameters<typeof original.open>[0], ...rest: unknown[]) => {
      const handle = await (original.open as (...args: unknown[]) => ReturnType<typeof original.open>)(path, ...rest);
      if (!disk.failWrites || !String(path).includes("portable-archives") || !String(path).endsWith(".tmp")) return handle;
      let written = 0;
      return new Proxy(handle, {
        get(target, property, receiver) {
          const value = Reflect.get(target, property, receiver);
          if (property !== "write" && property !== "writev" && property !== "appendFile" && property !== "writeFile") {
            return typeof value === "function" ? value.bind(target) : value;
          }
          return async (...args: unknown[]) => {
            // Let the first chunk land, so a spool file exists when the disk fills.
            if (written > 0) { disk.failedWrites += 1; throw enospc(); }
            written += 1;
            return (value as (...a: unknown[]) => unknown).apply(target, args);
          };
        },
      });
    }) as typeof original.open,
  };
  return { ...wrapped, default: wrapped };
});

const { POST: previewRoute } = await loadRoute("portable-archives/preview");

const PREVIEW = "/api/portable-archives/preview";
const PASSPHRASE = "integration-passphrase";
const KIB = 1024;

beforeEach(() => {
  disk.nearlyFull = false;
  disk.failWrites = false;
  disk.statfsCalls = 0;
  disk.failedWrites = 0;
});

afterAll(async () => {
  await cleanupIntegrationEnvironment();
});

/** Everything under the archive store that is a temporary file (a spool or a half-written export). */
async function temporaryFiles(): Promise<string[]> {
  const root = join(process.env.DOCUMENTS_ROOT!, "portable-archives");
  return (await readdir(root, { recursive: true }).catch(() => [] as string[])).map(String).filter((name) => name.endsWith(".tmp")).sort();
}

/** A preview upload whose file is `fileBytes` long (never processed: both cases refuse it first), and where its file part starts. */
async function previewUpload(householdId: string, fileBytes: number) {
  const upload = await encodeForm(archiveForm({ householdId, passphrase: PASSPHRASE }, Buffer.alloc(fileBytes, "spool-disk ")));
  return { ...upload, fileStart: fileContentOffset(upload.bytes) };
}

const FULL_MESSAGE = /^Orbit's disk has no room to take in an archive of this size \(about \d+\.\d GiB\)$/u;

/** Posts the upload with its Content-Length declared, as a browser's request carries one. */
function postDeclared(session: Awaited<ReturnType<Awaited<ReturnType<typeof createIntegrationFixture>>["session"]>>, body: BodyInit, contentType: string, contentLength: number) {
  return callRouteForSession(previewRoute, session, {
    url: `${ARCHIVE_ORIGIN}${PREVIEW}`,
    method: "POST",
    headers: { "content-type": contentType, "content-length": String(contentLength) },
    body,
  });
}

describe("#1792 L5: the spool's preflight and a full disk", () => {
  it("refuses a preview with 507 archive_storage_full before a byte of the file part is pulled when statfs shows too little room, and writes no spool file", async () => {
    // Catches a spool that only finds out by filling the disk every household's documents share.
    const fixture = await createIntegrationFixture("arch1792-spool-statfs");
    const owner = await fixture.session("owner");
    const upload = await previewUpload(fixture.household.id, 256 * KIB);
    const { body, stats } = trackedBody(upload.bytes, { cuts: [upload.fileStart] });
    disk.nearlyFull = true;

    const response = await postDeclared(owner, body, upload.contentType, upload.bytes.length);
    const pulledAtResponse = stats.pulledBytes;

    expect(response.status, JSON.stringify(await errorOf(response).catch(() => ({})))).toBe(507);
    expect(disk.statfsCalls, "the spool asked the file system how much room there is").toBeGreaterThan(0);
    // About 0.26 MiB declared: the floor of 0.1 GiB, one decimal.
    expect(await errorOf(response)).toEqual({ code: "archive_storage_full", message: "Orbit's disk has no room to take in an archive of this size (about 0.1 GiB)" });
    expect(pulledAtResponse, "no byte of the file part was pulled before the refusal").toBeLessThanOrEqual(upload.fileStart);
    expect(await temporaryFiles(), "no spool file").toEqual([]);
  }, 60_000);

  it("answers the same 507 when the disk fills while the file is spooled (ENOSPC after the first chunk), and removes the spool file", async () => {
    // Catches ENOSPC surfacing as a bare 500, or the half-written spool left to fill the disk further.
    const fixture = await createIntegrationFixture("arch1792-spool-enospc");
    const owner = await fixture.session("owner");
    const upload = await previewUpload(fixture.household.id, 512 * KIB);
    const { body } = trackedBody(upload.bytes, { chunkSize: 16 * KIB });
    disk.failWrites = true;

    const response = await postDeclared(owner, body, upload.contentType, upload.bytes.length);

    expect(disk.failedWrites, "a write to the spool hit ENOSPC").toBeGreaterThan(0);
    expect(response.status, JSON.stringify(await errorOf(response).catch(() => ({})))).toBe(507);
    const error = await errorOf(response);
    expect(error.code).toBe("archive_storage_full");
    expect(error.message).toMatch(FULL_MESSAGE);
    expect(await temporaryFiles(), "no spool file left").toEqual([]);
  }, 60_000);
});
