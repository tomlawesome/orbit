import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { deriveDocumentKeyId, resetDocumentConfigForTests } from "@/server/documents/config";
import { createWrappedMetadataKey, unwrapMetadataKey, type MetadataKeyContext } from "@/server/metadata/crypto";
import type { RotationKeys, RotationProgress, SkippedOnOlderKey } from "@/server/documents/rewrap-worker";
import { completionReport } from "./rewrap-kek-report";

/*
 * #1066: the operator command `pnpm rewrap-kek --next-key-file <path>`
 * (src/db/rewrap-kek.ts), tested from its contract: its doc comment, the
 * worker it drives, and docs/administrator-operations.md, "Rotating the
 * document key-encryption key", step 3.
 *
 * The script runs on import, so each case imports it afresh with its own argv.
 * This suite needs no database (it runs in the `default` project): `@/db` and
 * the worker's database-bound functions are replaced by an in-memory set of
 * wrapped data keys. The replacement rewraps with the REAL key primitive
 * (rewrapMetadataKey), keeps each batch all-or-nothing as the docs promise,
 * and uses the worker's own fail-closed check (requireCurrentKey), so what is
 * asserted here is the command's part: which keys it hands the worker, what it
 * refuses before touching anything, the order it records things in, and what
 * it reports. The worker's own SQL is covered against PostgreSQL by
 * tests/integration/document-kek-rotation.test.ts.
 *
 * Every key below is a FAKE test value made of a repeated byte pattern.
 */
const FAKE_CURRENT_KEK_HEX = "c0".repeat(32);
const FAKE_NEXT_KEK_HEX = "e1".repeat(32);
const FAKE_UNRELATED_KEK_HEX = "5a".repeat(32);

const CURRENT_KEY_ID = deriveDocumentKeyId(Buffer.from(FAKE_CURRENT_KEK_HEX, "hex"));
const NEXT_KEY_ID = deriveDocumentKeyId(Buffer.from(FAKE_NEXT_KEK_HEX, "hex"));

interface StoredKey {
  id: string;
  context: MetadataKeyContext;
  wrapped: ReturnType<typeof createWrappedMetadataKey>["wrapped"];
  dataKey: Buffer;
}

const state = vi.hoisted(() => ({
  rows: [] as unknown[],
  heldSkipped: { heldAttachmentIds: [] as string[], stagingObjectIds: [] as string[] },
  /** Throw (a crash, a reboot) after this many batches commit; null never. */
  crashAfterBatches: null as number | null,
  calls: [] as string[],
  /** What the stand-in worker was asked to move, per row: which key it was told to move from and to. */
  handOffs: [] as Array<{ id: string; fromKeyId: string; toKeyId: string }>,
  keysSeen: [] as unknown[],
  /** The very buffers the command handed over, to check it wipes them. */
  handedNextKeks: [] as Buffer[],
  startRows: [] as Array<{ previousKeyId: string; nextKeyId: string }>,
  completedRows: [] as Array<{ previousKeyId: string; nextKeyId: string }>,
  fileReads: [] as string[],
}));

vi.mock("@/db", () => ({
  closeDatabase: vi.fn(async () => { state.calls.push("closeDatabase"); }),
  getDb: () => { throw new Error("no database in this suite"); },
}));

vi.mock("node:fs", async (importOriginal) => {
  const actual = await importOriginal<typeof import("node:fs")>();
  const readFileSync = ((path: unknown, ...rest: unknown[]) => {
    state.fileReads.push(String(path));
    return (actual.readFileSync as (...args: unknown[]) => unknown)(path, ...rest);
  }) as typeof actual.readFileSync;
  return { ...actual, default: { ...actual, readFileSync }, readFileSync };
});

vi.mock("@/server/documents/rewrap-worker", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@/server/documents/rewrap-worker")>();
  const { rewrapMetadataKey: rewrap } = await import("@/server/metadata/crypto");
  const rows = () => state.rows as StoredKey[];
  const BATCH = 2;
  const progress = (keys: RotationKeys): RotationProgress => ({
    documentsRemaining: 0,
    metadataKeysRemaining: rows().filter((row) => row.context.keyId !== keys.nextKeyId).length,
    mailInSecretsRemaining: 0,
    heldAttachmentsRemaining: 0,
    stagingObjectsRemaining: 0,
    previewsRemaining: 0,
    heldAttachmentsSkipped: state.heldSkipped.heldAttachmentIds.length,
    stagingObjectsSkipped: state.heldSkipped.stagingObjectIds.length,
  });
  return {
    ...actual,
    recordRotationStarted: vi.fn(async (ids: { previousKeyId: string; nextKeyId: string }) => {
      state.calls.push("recordRotationStarted");
      // One row per rotation, not per invocation (#956).
      const open = state.startRows.find((row) => row.previousKeyId === ids.previousKeyId && row.nextKeyId === ids.nextKeyId);
      if (!open) state.startRows.push({ ...ids });
      return { ...ids, startedAt: new Date(0) };
    }),
    rotationRemaining: vi.fn(async (keys: RotationKeys) => {
      state.calls.push("rotationRemaining");
      return progress(keys);
    }),
    runKekRotationToCompletion: vi.fn(async (keys: RotationKeys) => {
      state.calls.push("runKekRotationToCompletion");
      state.handedNextKeks.push(keys.nextKek);
      state.keysSeen.push({ ...keys, currentKek: Buffer.from(keys.currentKek), nextKek: Buffer.from(keys.nextKek) });
      let batches = 0;
      for (;;) {
        const pending = rows().filter((row) => row.context.keyId !== keys.nextKeyId).slice(0, BATCH);
        if (pending.length === 0) return progress(keys);
        if (state.crashAfterBatches !== null && batches >= state.crashAfterBatches) {
          throw new Error("simulated crash part way through the rewrap");
        }
        // One transaction per batch: compute every new wrap first, then commit.
        const rewrapped = pending.map((row) => {
          actual.requireCurrentKey("metadata_keys", row.context.keyId, keys);
          state.handOffs.push({ id: row.id, fromKeyId: keys.currentKeyId, toKeyId: keys.nextKeyId });
          return rewrap(row.wrapped, keys.currentKek, keys.nextKek, row.context, keys.nextKeyId);
        });
        pending.forEach((row, index) => {
          row.wrapped = rewrapped[index];
          row.context = { ...row.context, keyId: keys.nextKeyId };
        });
        batches += 1;
      }
    }),
    heldObjectsOnOlderKey: vi.fn(async (): Promise<SkippedOnOlderKey> => {
      state.calls.push("heldObjectsOnOlderKey");
      return { heldAttachmentIds: [...state.heldSkipped.heldAttachmentIds], stagingObjectIds: [...state.heldSkipped.stagingObjectIds] };
    }),
    recordRotationCompleted: vi.fn(async (keys: RotationKeys) => {
      state.calls.push("recordRotationCompleted");
      state.completedRows.push({ previousKeyId: keys.currentKeyId, nextKeyId: keys.nextKeyId });
    }),
  };
});

class ExitCalled extends Error {
  constructor(readonly code: number | undefined) {
    super(`process.exit(${code})`);
  }
}

// The first fresh import transforms the script's whole import graph; do that
// once here, under a hook's budget, rather than inside the first test's 5s.
beforeAll(async () => {
  await import("@/lib/recovery-bundle");
  await import("@/server/documents/rewrap-worker");
}, 30_000);

const keyDir = mkdtempSync(join(tmpdir(), "orbit-rewrap-kek-test-"));
afterAll(() => rmSync(keyDir, { recursive: true, force: true }));

function keyFile(name: string, contents: string): string {
  const path = join(keyDir, name);
  writeFileSync(path, contents, { mode: 0o600 });
  return path;
}

function plantRows(count: number, kekHex: string): StoredKey[] {
  const kek = Buffer.from(kekHex, "hex");
  const keyId = deriveDocumentKeyId(kek);
  const planted = Array.from({ length: count }, (_unused, index) => {
    const context: MetadataKeyContext = { scope: "household", householdId: `household-${index}`, keyId };
    const { wrapped, dataKey } = createWrappedMetadataKey(kek, context);
    return { id: `metadata-key-${index}`, context, wrapped, dataKey: Buffer.from(dataKey) };
  });
  state.rows.push(...planted);
  return planted;
}

function snapshotRows(): string {
  return JSON.stringify((state.rows as StoredKey[]).map((row) => ({ id: row.id, context: row.context, wrapped: row.wrapped })));
}

function opensUnder(row: StoredKey, kekHex: string): boolean {
  const kek = Buffer.from(kekHex, "hex");
  try {
    const dataKey = unwrapMetadataKey(row.wrapped, kek, { ...row.context, keyId: deriveDocumentKeyId(kek) });
    return dataKey.equals(row.dataKey);
  } catch {
    return false;
  }
}

interface RunResult {
  exitCode: number;
  stdout: string;
  stderr: string;
}

const savedArgv = process.argv;
const savedEnv = { ...process.env };

/** Imports the script fresh with `args`, and waits for its `main()` to settle. */
async function runCommand(args: string[]): Promise<RunResult> {
  let stdout = "";
  let stderr = "";
  let exitCode: number | undefined;
  vi.spyOn(process.stdout, "write").mockImplementation((chunk: string | Uint8Array) => { stdout += String(chunk); return true; });
  vi.spyOn(process.stderr, "write").mockImplementation((chunk: string | Uint8Array) => { stderr += String(chunk); return true; });
  vi.spyOn(process, "exit").mockImplementation(((code?: number) => {
    exitCode ??= code ?? 0;
    throw new ExitCalled(code);
  }) as typeof process.exit);
  process.exitCode = undefined;
  process.argv = ["node", "src/db/rewrap-kek.ts", ...args];
  vi.resetModules();
  await import("./rewrap-kek");
  await vi.waitFor(() => {
    if (exitCode === undefined && process.exitCode === undefined && !state.calls.includes("closeDatabase")) {
      throw new Error("still running");
    }
  }, { timeout: 4_000, interval: 5 });
  // Let main()'s own catch (it runs after `finally`) set its exit code.
  for (let turn = 0; turn < 5; turn += 1) await new Promise((resolve) => setImmediate(resolve));
  const code = exitCode ?? Number(process.exitCode ?? 0);
  process.exitCode = undefined;
  vi.mocked(process.stdout.write).mockRestore();
  vi.mocked(process.stderr.write).mockRestore();
  vi.mocked(process.exit).mockRestore();
  return { exitCode: code, stdout, stderr };
}

beforeEach(() => {
  state.rows.length = 0;
  state.heldSkipped = { heldAttachmentIds: [], stagingObjectIds: [] };
  state.crashAfterBatches = null;
  state.calls.length = 0;
  state.handOffs.length = 0;
  state.keysSeen.length = 0;
  state.handedNextKeks.length = 0;
  state.startRows.length = 0;
  state.completedRows.length = 0;
  state.fileReads.length = 0;
  for (const name of ["DOCUMENT_KEK", "DOCUMENT_KEK_FILE", "DOCUMENT_KEK_NEXT", "DOCUMENT_KEK_NEXT_FILE"]) delete process.env[name];
  process.env.DOCUMENT_KEK = FAKE_CURRENT_KEK_HEX;
  resetDocumentConfigForTests();
});

afterEach(() => {
  process.argv = savedArgv;
  for (const name of Object.keys(process.env)) if (!(name in savedEnv)) delete process.env[name];
  Object.assign(process.env, savedEnv);
  resetDocumentConfigForTests();
  vi.restoreAllMocks();
});

describe("a successful rotation", () => {
  it("runs the steps in order and has the worker move every row from the current key to the next", async () => {
    // The stand-in worker rewraps for itself, so rows that end up under the next
    // key prove only that it ran. What proves the COMMAND is what it did around
    // the worker: that it called it, in what order, and which way it pointed it.
    const rows = plantRows(5, FAKE_CURRENT_KEK_HEX);
    const result = await runCommand(["--next-key-file", keyFile("next", `${FAKE_NEXT_KEK_HEX}\n`)]);

    expect(result.exitCode).toBe(0);
    expect(state.calls, "the command's steps, in order").toEqual([
      "recordRotationStarted",
      "rotationRemaining",
      "runKekRotationToCompletion",
      "heldObjectsOnOlderKey",
      "recordRotationCompleted",
      "closeDatabase",
    ]);
    // The keys as the worker received them, checked first: on a swap the worker
    // finds nothing to move, so the row checks below could not say what went wrong.
    expect(state.keysSeen, "the worker ran once").toHaveLength(1);
    const handed = state.keysSeen[0] as RotationKeys;
    expect(handed.currentKeyId, "the worker's current key is the configured one").toBe(CURRENT_KEY_ID);
    expect(handed.nextKeyId, "the worker's next key is the one from the file").toBe(NEXT_KEY_ID);
    expect(
      state.handOffs.map((handOff) => handOff.id).sort(),
      "the worker was asked to move every row, once",
    ).toEqual(rows.map((row) => row.id).sort());
    for (const handOff of state.handOffs) {
      expect(handOff.fromKeyId, `${handOff.id} moves from the current key`).toBe(CURRENT_KEY_ID);
      expect(handOff.toKeyId, `${handOff.id} moves to the next key`).toBe(NEXT_KEY_ID);
    }
    for (const row of rows) {
      expect(row.context.keyId, `${row.id} records the next key`).toBe(NEXT_KEY_ID);
      expect(opensUnder(row, FAKE_NEXT_KEK_HEX), `${row.id} opens under the next key`).toBe(true);
      expect(opensUnder(row, FAKE_CURRENT_KEK_HEX), `${row.id} no longer opens under the current key`).toBe(false);
    }
  });

  it("hands the worker the configured current key and the key from the file, with the ids a running instance derives", async () => {
    await runCommand(["--next-key-file", keyFile("next", FAKE_NEXT_KEK_HEX)]);

    expect(state.keysSeen).toHaveLength(1);
    const keys = state.keysSeen[0] as RotationKeys;
    expect(keys.currentKek.toString("hex")).toBe(FAKE_CURRENT_KEK_HEX);
    expect(keys.currentKeyId).toBe(CURRENT_KEY_ID);
    expect(keys.nextKek.toString("hex")).toBe(FAKE_NEXT_KEK_HEX);
    expect(keys.nextKeyId).toBe(NEXT_KEY_ID);
  });

  it("records the start before rewrapping, names the skipped objects before recording completion, and closes the database", async () => {
    plantRows(1, FAKE_CURRENT_KEK_HEX);
    await runCommand(["--next-key-file", keyFile("next", FAKE_NEXT_KEK_HEX)]);

    const at = (name: string) => state.calls.indexOf(name);
    expect(at("recordRotationStarted")).toBeGreaterThanOrEqual(0);
    expect(at("recordRotationStarted")).toBeLessThan(at("runKekRotationToCompletion"));
    expect(at("runKekRotationToCompletion")).toBeLessThan(at("heldObjectsOnOlderKey"));
    expect(at("heldObjectsOnOlderKey")).toBeLessThan(at("recordRotationCompleted"));
    expect(state.calls.at(-1)).toBe("closeDatabase");
    expect(state.startRows).toEqual([{ previousKeyId: CURRENT_KEY_ID, nextKeyId: NEXT_KEY_ID }]);
    expect(state.completedRows).toEqual([{ previousKeyId: CURRENT_KEY_ID, nextKeyId: NEXT_KEY_ID }]);
  });

  it("reads the next key from its file exactly once, never puts it in the environment, and wipes it afterwards", async () => {
    const path = keyFile("next", FAKE_NEXT_KEK_HEX);
    const envBefore = { ...process.env };
    const result = await runCommand(["--next-key-file", path]);

    expect(result.exitCode).toBe(0);
    expect(state.fileReads.filter((read) => read === path)).toHaveLength(1);
    expect(process.env).toEqual(envBefore);
    expect(Object.values(process.env).some((value) => value?.toLowerCase().includes(FAKE_NEXT_KEK_HEX))).toBe(false);
    expect(state.handedNextKeks, "the worker was handed the next key").toHaveLength(1);
    const handed = state.handedNextKeks[0];
    expect(handed.equals(Buffer.alloc(32)), "the next key's bytes are zeroed once the command is done").toBe(true);
    expect(result.stdout + result.stderr).not.toContain(FAKE_NEXT_KEK_HEX);
    expect(result.stdout + result.stderr).not.toContain(FAKE_CURRENT_KEK_HEX);
  });
});

describe("what it reports", () => {
  it("says how many rows it will move and between which key ids, then prints the completion report", async () => {
    plantRows(3, FAKE_CURRENT_KEK_HEX);
    const result = await runCommand(["--next-key-file", keyFile("next", FAKE_NEXT_KEK_HEX)]);

    expect(result.exitCode).toBe(0);
    expect(result.stdout).toContain("Starting rewrap:");
    expect(result.stdout).toContain("3 metadata key(s)");
    expect(result.stdout).toContain(`from ${CURRENT_KEY_ID} to ${NEXT_KEY_ID}`);
    expect(result.stdout).toContain(completionReport({ heldAttachmentIds: [], stagingObjectIds: [] }).join("\n"));
    expect(result.stdout).not.toMatch(/Skipping/);
    expect(result.stderr).toBe("");
  });

  it("names held objects left on an older key, at the start and in the completion report", async () => {
    plantRows(1, FAKE_CURRENT_KEK_HEX);
    state.heldSkipped = { heldAttachmentIds: ["att-old-1"], stagingObjectIds: ["stg-old-1", "stg-old-2"] };
    const result = await runCommand(["--next-key-file", keyFile("next", FAKE_NEXT_KEK_HEX)]);

    expect(result.exitCode).toBe(0);
    expect(result.stdout).toMatch(/Skipping 1 held mail attachment\(s\) and 2 scanner-recovery object\(s\)/);
    for (const id of ["att-old-1", "stg-old-1", "stg-old-2"]) expect(result.stdout).toContain(id);
    expect(result.stdout).toContain("Keep the older document key");
    expect(state.completedRows).toHaveLength(1);
  });
});

describe("resuming", () => {
  it("an interrupted run records no completion, leaves every row readable by its own key id, and a second run finishes it", async () => {
    const rows = plantRows(5, FAKE_CURRENT_KEK_HEX);
    const path = keyFile("next", FAKE_NEXT_KEK_HEX);
    state.crashAfterBatches = 1;

    const first = await runCommand(["--next-key-file", path]);
    expect(first.exitCode).toBe(1);
    expect(first.stderr).toContain("simulated crash");
    expect(first.stdout).not.toContain("Rewrap complete");
    expect(state.completedRows).toHaveLength(0);
    expect(state.calls).toContain("closeDatabase");
    const moved = rows.filter((row) => row.context.keyId === NEXT_KEY_ID);
    expect(moved.length).toBeGreaterThan(0);
    expect(moved.length).toBeLessThan(rows.length);
    for (const row of rows) {
      const own = row.context.keyId === NEXT_KEY_ID ? FAKE_NEXT_KEK_HEX : FAKE_CURRENT_KEK_HEX;
      expect(opensUnder(row, own), `${row.id} readable under the key it records`).toBe(true);
    }

    state.crashAfterBatches = null;
    state.calls.length = 0;
    resetDocumentConfigForTests();
    const second = await runCommand(["--next-key-file", path]);
    expect(second.exitCode).toBe(0);
    expect(second.stdout).toContain(`${rows.length - moved.length} metadata key(s)`);
    for (const row of rows) {
      expect(opensUnder(row, FAKE_NEXT_KEK_HEX)).toBe(true);
      expect(opensUnder(row, FAKE_CURRENT_KEK_HEX)).toBe(false);
    }
    expect(state.startRows, "one start row per rotation, not per invocation").toHaveLength(1);
    expect(state.completedRows).toHaveLength(1);
  });

  it("running it again after it finished changes nothing and reports nothing left to move", async () => {
    const rows = plantRows(3, FAKE_CURRENT_KEK_HEX);
    const path = keyFile("next", FAKE_NEXT_KEK_HEX);
    await runCommand(["--next-key-file", path]);
    const afterFirst = snapshotRows();

    state.calls.length = 0;
    resetDocumentConfigForTests();
    const again = await runCommand(["--next-key-file", path]);

    expect(again.exitCode).toBe(0);
    expect(snapshotRows()).toBe(afterFirst);
    expect(again.stdout).toContain("0 metadata key(s)");
    for (const row of rows) expect(opensUnder(row, FAKE_NEXT_KEK_HEX)).toBe(true);
    expect(state.startRows).toHaveLength(1);
  });
});

describe("refusing without changing anything", () => {
  function expectUntouched(before: string): void {
    expect(snapshotRows()).toBe(before);
    for (const name of ["recordRotationStarted", "runKekRotationToCompletion", "recordRotationCompleted"]) {
      expect(state.calls, `${name} was not reached`).not.toContain(name);
    }
    expect(state.startRows).toHaveLength(0);
    expect(state.completedRows).toHaveLength(0);
  }

  it.each([
    ["no --next-key-file flag", () => [] as string[], /usage: pnpm rewrap-kek --next-key-file <path>/],
    ["the flag with no path", () => ["--next-key-file"], /usage: pnpm rewrap-kek --next-key-file <path>/],
    ["a key file that does not exist", () => ["--next-key-file", join(keyDir, "missing")], /could not read the next key file/],
    ["an empty key file", () => ["--next-key-file", keyFile("empty", "")], /does not contain a 32-byte hexadecimal document key/],
    ["a key file that is too short", () => ["--next-key-file", keyFile("short", "e1".repeat(16))], /does not contain a 32-byte hexadecimal document key/],
    ["a key file that is not hex", () => ["--next-key-file", keyFile("nothex", "zz".repeat(32))], /does not contain a 32-byte hexadecimal document key/],
    ["a next key identical to the current key", () => ["--next-key-file", keyFile("same", FAKE_CURRENT_KEK_HEX)], /identical to the current key/],
  ])("exits 1 for %s", async (_label, args, message) => {
    plantRows(2, FAKE_CURRENT_KEK_HEX);
    const before = snapshotRows();
    const result = await runCommand(args());

    expect(result.exitCode).toBe(1);
    expect(result.stderr).toMatch(message);
    expect(result.stderr).toMatch(/^orbit rewrap-kek: /);
    expectUntouched(before);
  });

  it("exits 1 when no current key is configured", async () => {
    plantRows(2, FAKE_CURRENT_KEK_HEX);
    const before = snapshotRows();
    delete process.env.DOCUMENT_KEK;
    resetDocumentConfigForTests();
    const result = await runCommand(["--next-key-file", keyFile("next", FAKE_NEXT_KEK_HEX)]);

    expect(result.exitCode).toBe(1);
    expect(result.stderr).toMatch(/^orbit rewrap-kek: /);
    expectUntouched(before);
  });

  it("fails closed when the configured current key is not the one the rows are wrapped under", async () => {
    const rows = plantRows(4, FAKE_UNRELATED_KEK_HEX);
    const before = snapshotRows();
    const result = await runCommand(["--next-key-file", keyFile("next", FAKE_NEXT_KEK_HEX)]);

    expect(result.exitCode).toBe(1);
    expect(result.stderr).toContain("wrapped under neither the current nor the next key");
    expect(result.stdout).not.toContain("Rewrap complete");
    expect(snapshotRows()).toBe(before);
    for (const row of rows) expect(opensUnder(row, FAKE_UNRELATED_KEK_HEX)).toBe(true);
    expect(state.completedRows).toHaveLength(0);
    expect(state.calls).toContain("closeDatabase");
  });
});
