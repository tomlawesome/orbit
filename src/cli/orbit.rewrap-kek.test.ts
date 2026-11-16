import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { deriveDocumentKeyId, resetDocumentConfigForTests } from "@/server/documents/config";
import type { RotationKeys, RotationProgress, SkippedOnOlderKey } from "@/server/documents/rewrap-worker";

/*
 * #1635: `orbit rewrap-kek --next-key-file <path>` (src/cli/orbit.ts) and
 * `pnpm rewrap-kek` (src/db/rewrap-kek.ts) call one shared function, so on the
 * same inputs they print the same lines, make the same audit calls (the
 * worker's recordRotationStarted / recordRotationCompleted) and exit with the
 * same code. Same mocks as src/db/rewrap-kek.test.ts. Written from the spec,
 * before the change; it names no function the change adds.
 */
const FAKE_CURRENT_KEK_HEX = "c0".repeat(32);
const FAKE_NEXT_KEK_HEX = "e1".repeat(32);
const CURRENT_KEY_ID = deriveDocumentKeyId(Buffer.from(FAKE_CURRENT_KEK_HEX, "hex"));
const NEXT_KEY_ID = deriveDocumentKeyId(Buffer.from(FAKE_NEXT_KEK_HEX, "hex"));

const state = vi.hoisted(() => ({
  calls: [] as unknown[],
  failRun: false,
  heldSkipped: { heldAttachmentIds: [] as string[], stagingObjectIds: [] as string[] },
}));

vi.mock("@/db", () => ({
  closeDatabase: vi.fn(async () => { state.calls.push("closeDatabase"); }),
  getDb: () => { throw new Error("no database in this suite"); },
}));

vi.mock("@/server/documents/rewrap-worker", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@/server/documents/rewrap-worker")>();
  const progress = (): RotationProgress => ({
    documentsRemaining: 0,
    metadataKeysRemaining: 3,
    mailInSecretsRemaining: 0,
    heldAttachmentsRemaining: 0,
    stagingObjectsRemaining: 0,
    previewsRemaining: 0,
    heldAttachmentsSkipped: state.heldSkipped.heldAttachmentIds.length,
    stagingObjectsSkipped: state.heldSkipped.stagingObjectIds.length,
  });
  const ids = (keys: RotationKeys) => ({ previousKeyId: keys.currentKeyId, nextKeyId: keys.nextKeyId });
  return {
    ...actual,
    recordRotationStarted: vi.fn(async (pair: { previousKeyId: string; nextKeyId: string }) => {
      state.calls.push(["recordRotationStarted", pair]);
      return { ...pair, startedAt: new Date(0) };
    }),
    rotationRemaining: vi.fn(async (keys: RotationKeys) => { state.calls.push(["rotationRemaining", ids(keys)]); return progress(); }),
    runKekRotationToCompletion: vi.fn(async (keys: RotationKeys) => {
      state.calls.push(["runKekRotationToCompletion", ids(keys), keys.currentKek.toString("hex"), keys.nextKek.toString("hex")]);
      if (state.failRun) throw new Error("simulated crash part way through the rewrap");
      return { ...progress(), metadataKeysRemaining: 0 };
    }),
    heldObjectsOnOlderKey: vi.fn(async (): Promise<SkippedOnOlderKey> => {
      state.calls.push("heldObjectsOnOlderKey");
      return { heldAttachmentIds: [...state.heldSkipped.heldAttachmentIds], stagingObjectIds: [...state.heldSkipped.stagingObjectIds] };
    }),
    recordRotationCompleted: vi.fn(async (keys: RotationKeys) => { state.calls.push(["recordRotationCompleted", ids(keys)]); }),
  };
});

class ExitCalled extends Error {}

const keyDir = mkdtempSync(join(tmpdir(), "orbit-cli-rewrap-kek-test-"));
afterAll(() => rmSync(keyDir, { recursive: true, force: true }));
function keyFile(name: string, contents: string): string {
  const path = join(keyDir, name);
  writeFileSync(path, contents, { mode: 0o600 });
  return path;
}

beforeAll(async () => {
  await import("@/lib/recovery-bundle");
  await import("@/server/documents/rewrap-worker");
}, 30_000);

const savedArgv = process.argv;
const savedEnv = { ...process.env };

interface RunResult { exitCode: number; stdout: string; stderr: string; calls: unknown[] }

/** Runs one entry point fresh with the same arguments; both run on import. */
async function run(entry: "pnpm" | "orbit", args: string[]): Promise<RunResult> {
  let stdout = "";
  let stderr = "";
  let exitCode: number | undefined;
  state.calls.length = 0;
  vi.spyOn(process.stdout, "write").mockImplementation((chunk: string | Uint8Array) => { stdout += String(chunk); return true; });
  vi.spyOn(process.stderr, "write").mockImplementation((chunk: string | Uint8Array) => { stderr += String(chunk); return true; });
  vi.spyOn(process, "exit").mockImplementation(((code?: number) => {
    exitCode ??= code ?? 0;
    throw new ExitCalled();
  }) as typeof process.exit);
  process.exitCode = undefined;
  process.env.ORBIT_ENGINE_CONTEXT = "container";
  process.argv = entry === "pnpm" ? ["node", "src/db/rewrap-kek.ts", ...args] : ["node", "orbit", "rewrap-kek", ...args];
  resetDocumentConfigForTests();
  vi.resetModules();
  await import(entry === "pnpm" ? "../db/rewrap-kek" : "./orbit");
  await vi.waitFor(() => {
    if (exitCode === undefined && process.exitCode === undefined && !state.calls.includes("closeDatabase")) throw new Error("still running");
  }, { timeout: 4_000, interval: 5 });
  for (let turn = 0; turn < 5; turn += 1) await new Promise((resolve) => setImmediate(resolve));
  const code = exitCode ?? Number(process.exitCode ?? 0);
  process.exitCode = undefined;
  vi.restoreAllMocks();
  return { exitCode: code, stdout, stderr, calls: [...state.calls] };
}

beforeEach(() => {
  state.failRun = false;
  state.heldSkipped = { heldAttachmentIds: [], stagingObjectIds: [] };
  for (const name of ["DOCUMENT_KEK", "DOCUMENT_KEK_FILE", "DOCUMENT_KEK_NEXT", "DOCUMENT_KEK_NEXT_FILE"]) delete process.env[name];
  process.env.DOCUMENT_KEK = FAKE_CURRENT_KEK_HEX;
});

afterEach(() => {
  process.argv = savedArgv;
  for (const name of Object.keys(process.env)) if (!(name in savedEnv)) delete process.env[name];
  Object.assign(process.env, savedEnv);
  resetDocumentConfigForTests();
  vi.restoreAllMocks();
});

describe("orbit rewrap-kek is the same code as pnpm rewrap-kek (#1635)", () => {
  it("on a successful rotation: same output, same audit calls, exit 0", async () => {
    const path = keyFile("next", `${FAKE_NEXT_KEK_HEX}\n`);
    const viaPnpm = await run("pnpm", ["--next-key-file", path]);
    const viaOrbit = await run("orbit", ["--next-key-file", path]);

    expect(viaPnpm.exitCode).toBe(0);
    expect(viaOrbit.exitCode).toBe(0);
    expect(viaOrbit.stdout).toBe(viaPnpm.stdout);
    expect(viaOrbit.stdout).toContain(`from ${CURRENT_KEY_ID} to ${NEXT_KEY_ID}`);
    expect(viaOrbit.stderr).toBe(viaPnpm.stderr);
    expect(viaOrbit.calls).toEqual(viaPnpm.calls);
    expect(viaOrbit.calls.map((call) => (Array.isArray(call) ? call[0] : call))).toEqual([
      "recordRotationStarted", "rotationRemaining", "runKekRotationToCompletion", "heldObjectsOnOlderKey", "recordRotationCompleted", "closeDatabase",
    ]);
  });

  it("with held objects left on an older key: same report", async () => {
    state.heldSkipped = { heldAttachmentIds: ["att-old-1"], stagingObjectIds: ["stg-old-1"] };
    const path = keyFile("next", FAKE_NEXT_KEK_HEX);
    const viaPnpm = await run("pnpm", ["--next-key-file", path]);
    const viaOrbit = await run("orbit", ["--next-key-file", path]);

    expect(viaOrbit.exitCode).toBe(viaPnpm.exitCode);
    expect(viaOrbit.stdout).toBe(viaPnpm.stdout);
    expect(viaOrbit.stdout).toContain("att-old-1");
    expect(viaOrbit.calls).toEqual(viaPnpm.calls);
  });

  it("when the worker fails: same error line, exit 1, no completion audit entry, database closed", async () => {
    state.failRun = true;
    const path = keyFile("next", FAKE_NEXT_KEK_HEX);
    const viaPnpm = await run("pnpm", ["--next-key-file", path]);
    const viaOrbit = await run("orbit", ["--next-key-file", path]);

    expect(viaPnpm.exitCode).toBe(1);
    expect(viaOrbit.exitCode).toBe(1);
    expect(viaOrbit.stderr).toBe(viaPnpm.stderr);
    expect(viaOrbit.stderr).toContain("simulated crash");
    expect(viaOrbit.calls).toEqual(viaPnpm.calls);
    expect(JSON.stringify(viaOrbit.calls)).not.toContain("recordRotationCompleted");
    expect(viaOrbit.calls).toContain("closeDatabase");
  });

  it.each([
    ["no --next-key-file", () => [] as string[], /--next-key-file/],
    ["a key file that does not exist", () => ["--next-key-file", join(keyDir, "missing")], /could not read the next key file/],
    ["a malformed key file", () => ["--next-key-file", keyFile("bad", "zz".repeat(32))], /does not contain a 32-byte hexadecimal document key/],
    ["a next key identical to the current key", () => ["--next-key-file", keyFile("same", FAKE_CURRENT_KEK_HEX)], /identical to the current key/],
  ])("for %s: same message, exit 1, nothing audited", async (_label, args, message) => {
    const viaPnpm = await run("pnpm", args());
    const viaOrbit = await run("orbit", args());

    expect(viaPnpm.exitCode).toBe(1);
    expect(viaOrbit.exitCode).toBe(1);
    expect(viaOrbit.stderr).toMatch(message);
    expect(viaOrbit.stderr).toBe(viaPnpm.stderr);
    expect(viaOrbit.stdout).toBe(viaPnpm.stdout);
    expect(JSON.stringify(viaOrbit.calls)).not.toContain("recordRotationStarted");
  });
});
