import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from "vitest";

/*
 * #1797 review: a disk that is full when the spool file is CREATED (the
 * directory or the file, before any byte is written) is the same refusal as a
 * disk that fills while writing or fails the preflight: 507
 * `archive_storage_full`, never a bare 500, and the request body that was
 * never read is cancelled or drained rather than left dangling. The file
 * system is mocked at `node:fs/promises` so the repository's real spool()
 * runs; only `mkdir` and `open` of the `.upload.tmp` can be made to fail.
 */
const fail = vi.hoisted(() => ({ mkdir: /** @type {null | string} */ (null), open: /** @type {null | string} */ (null) }));

vi.mock("node:fs/promises", async (importOriginal) => {
  const real = await importOriginal();
  const refuse = (code) => Object.assign(new Error(`${code}: simulated`), { code });
  return {
    ...real,
    mkdir: async (...args) => {
      if (fail.mkdir && String(args[0]).endsWith("portable-archives")) throw refuse(fail.mkdir);
      return real.mkdir(...args);
    },
    open: async (...args) => {
      if (fail.open && String(args[0]).endsWith(".upload.tmp")) throw refuse(fail.open);
      return real.open(...args);
    },
  };
});

let root;
const saved = {};
const ENVIRONMENT = ["DOCUMENTS_ROOT", "DOCUMENTS_QUARANTINE_ROOT", "DOCUMENT_KEK"];
let repository;

beforeAll(async () => {
  for (const name of ENVIRONMENT) saved[name] = process.env[name];
  root = mkdtempSync(join(tmpdir(), "orbit-1797-full-disk-"));
  process.env.DOCUMENTS_ROOT = root;
  process.env.DOCUMENTS_QUARANTINE_ROOT = join(root, "quarantine");
  process.env.DOCUMENT_KEK = "00".repeat(32);
  (await import("orbit/server/documents/config")).resetDocumentConfigForTests();
  repository = await import("orbit/server/portable-archive-repository");
});

afterEach(() => {
  fail.mkdir = null;
  fail.open = null;
});

afterAll(async () => {
  for (const name of ENVIRONMENT) {
    if (saved[name] === undefined) delete process.env[name];
    else process.env[name] = saved[name];
  }
  (await import("orbit/server/documents/config")).resetDocumentConfigForTests();
  rmSync(root, { recursive: true, force: true });
});

/** A body that has not been read: `state` says whether it was cancelled or read to its end. */
function unreadBody() {
  const state = { cancelled: false, drained: false, pulls: 0 };
  const body = new ReadableStream({
    pull(controller) {
      state.pulls += 1;
      if (state.pulls > 3) { state.drained = true; controller.close(); return; }
      controller.enqueue(new Uint8Array(1024));
    },
    cancel() { state.cancelled = true; },
  }, { highWaterMark: 0 });
  return { body, state };
}

async function settled(promise) {
  try { return { value: await promise }; } catch (error) { return { error }; }
}

const CASES = [
  ["mkdir", "ENOSPC"],
  ["mkdir", "EDQUOT"],
  ["open", "ENOSPC"],
  ["open", "EDQUOT"],
];

describe("#1797: a full disk when the spool file is created is the 507 refusal", () => {
  for (const [step, code] of CASES) {
    it(`${code} from ${step} answers 507 archive_storage_full and the unread body is cancelled or drained`, async () => {
      // Fails today: the raw errno escapes (a 500) and the body is left unread.
      fail[step] = code;
      const { body, state } = unreadBody();
      const { value, error } = await settled(repository.spoolPortableArchiveUpload(body, 1024));
      expect(value, "no spool was started").toBeUndefined();
      expect(error?.code, `the answer, not ${error?.code}`).toBe("archive_storage_full");
      expect(error.status).toBe(507);
      expect(error.message).toMatch(/^Orbit's disk has no room to take in an archive of this size \(about \d+\.\d GiB\)$/u);
      // Cancel or drain may finish a turn after the rejection.
      for (let turn = 0; turn < 50 && !state.cancelled && !state.drained; turn += 1) await new Promise((resolve) => setTimeout(resolve, 10));
      expect(state.cancelled || state.drained, "the request body was cancelled or drained").toBe(true);
    });
  }

  it("any other failure creating the file is not turned into a 507", async () => {
    // Guard: only a full disk is the 507; passes before and after.
    fail.open = "EACCES";
    const { body } = unreadBody();
    const { error } = await settled(repository.spoolPortableArchiveUpload(body, 1024));
    expect(error?.code).toBe("EACCES");
  });
});
