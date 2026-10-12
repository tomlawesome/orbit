import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

// #1316 (backup-busy): the CLI's exit status for a refused backup. Exit 75
// means "another backup or restore owns the app: leave it alone" and the
// shells then skip restarting orbit-app. A backup that meets a running
// export (which never stops the app) is refused with its own code,
// `backup-busy`, and must NOT exit 75, or the shells would leave orbit-app
// stopped. Contrast: scripts/backup-restore-shell.test.mjs, "leaves the app
// to the run that holds the backup/restore lock (engine exit 75)".
//
// The engine is replaced by one that refuses with a chosen code, and the CLI's
// entry point is run in process with process.exit captured.

const refusal = vi.hoisted(() => ({ code: "restore-locked", message: "" }));

vi.mock("../lib/in-container-adapter", () => ({
  createInContainerAdapter: () => ({}),
  preflightPostgresClient: () => undefined,
}));

vi.mock("../lib/backup-restore-cli", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../lib/backup-restore-cli")>();
  return {
    ...actual,
    runBackup: () => {
      throw new actual.BackupRestoreCliRefusal(refusal.message, refusal.code as never);
    },
  };
});

class ExitCalled extends Error {
  constructor(readonly status: number | undefined) {
    super(`process.exit(${String(status)})`);
  }
}

let stderr = "";
const originalArgv = process.argv;
const originalContext = process.env.ORBIT_ENGINE_CONTEXT;

beforeEach(() => {
  stderr = "";
  vi.resetModules();
  vi.spyOn(process, "exit").mockImplementation(((status?: number) => {
    throw new ExitCalled(status);
  }) as never);
  vi.spyOn(process.stderr, "write").mockImplementation(((chunk: string | Uint8Array) => {
    stderr += String(chunk);
    return true;
  }) as never);
  process.env.ORBIT_ENGINE_CONTEXT = "container";
});

afterEach(() => {
  vi.restoreAllMocks();
  process.argv = originalArgv;
  if (originalContext === undefined) delete process.env.ORBIT_ENGINE_CONTEXT;
  else process.env.ORBIT_ENGINE_CONTEXT = originalContext;
});

async function exitStatusOf(code: string, message: string): Promise<number | undefined> {
  refusal.code = code;
  refusal.message = message;
  process.argv = ["node", "orbit", "backup", "--dir", "/nonexistent-orbit-deployment"];
  try {
    await import("./orbit");
  } catch (error) {
    if (error instanceof ExitCalled) return error.status;
    throw error;
  }
  throw new Error("the CLI returned without exiting");
}

describe("the exit status of a refused backup (#1316 backup-busy)", () => {
  it("a restore-locked refusal exits 75, so the shell leaves orbit-app to the run that holds the lock (unchanged)", async () => {
    expect(await exitStatusOf("restore-locked", "Another orbit backup or restore is already running.")).toBe(75);
  });

  it("a backup-busy refusal does not exit 75, so the shell restarts orbit-app", async () => {
    const status = await exitStatusOf("backup-busy", "An orbit export is in progress against this backup directory. Retry when it finishes.");
    expect(status).not.toBe(75);
    expect(status).toBe(1);
    expect(stderr).toContain("An orbit export is in progress");
  });
});
