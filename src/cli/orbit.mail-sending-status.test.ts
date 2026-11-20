import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";

// `orbit mail-sending-status` (#1817), written from the issue's specification
// alone, before the change. Run inside the app container by install.sh --update
// and repair.sh (`compose exec -T orbit-app node /opt/orbit/cli/orbit.js
// mail-sending-status`), it reads the existing done-marker (the mail_sending row,
// sendingSource(), and the mail_sending_imported audit record,
// sendingImportedFromEnvironment()) and prints exactly one line from a closed
// vocabulary:
//   mail-sending source=<imported|ui|none> imported-from-environment=<true|false>
// Exit 0 on an answer, 2 on usage, 1 when the database could not be asked. No
// host, user, address or provider error text on either stream.
//
// The database layer is replaced; the CLI's entry point is run in process with
// process.exit and the output streams captured (the shape of
// orbit.backup-busy-exit.test.ts).

const database = vi.hoisted(() => ({
  source: null as "ui" | "imported" | null,
  imported: false,
  failure: null as Error | null,
  closed: 0,
}));

vi.mock("../server/mail-in/sending-settings", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../server/mail-in/sending-settings")>();
  return {
    ...actual,
    sendingSource: async () => {
      if (database.failure) throw database.failure;
      return database.source;
    },
    sendingImportedFromEnvironment: async () => {
      if (database.failure) throw database.failure;
      return database.imported;
    },
  };
});

vi.mock("../db", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../db")>();
  return {
    ...actual,
    closeDatabase: async () => {
      database.closed += 1;
    },
  };
});

let stdout = "";
let stderr = "";
let exitStatus: number | undefined;
/** Resolves when the current case's CLI calls process.exit, its last act on every path (#1937). */
let finished: Promise<void> = Promise.resolve();
let finish: () => void = () => {};
/** The current case's CLI run, if it started one; afterEach waits for it so its output can never reach the next case. */
let running: Promise<unknown> | undefined;
const originalArgv = process.argv;
const originalContext = process.env.ORBIT_ENGINE_CONTEXT;

// #1937: the first, cold import transforms the CLI's whole module graph, which
// took over 5 s on a loaded runner and timed the first case out. Pay it once
// here: load the CLI with no command (it prints its usage and calls
// process.exit, both stubbed) and the two modules mail-sending-status loads,
// so each case's import after vi.resetModules only re-evaluates them.
beforeAll(async () => {
  const exit = vi.spyOn(process, "exit").mockImplementation((() => undefined as never) as never);
  const out = vi.spyOn(process.stdout, "write").mockImplementation((() => true) as never);
  const err = vi.spyOn(process.stderr, "write").mockImplementation((() => true) as never);
  process.argv = ["node", "orbit"];
  try {
    await Promise.all([import("./orbit"), import("../server/mail-in/sending-settings"), import("../db")]);
  } finally {
    exit.mockRestore();
    out.mockRestore();
    err.mockRestore();
    process.argv = originalArgv;
    process.exitCode = undefined;
  }
});

beforeEach(() => {
  stdout = "";
  stderr = "";
  exitStatus = undefined;
  running = undefined;
  finished = new Promise((resolve) => {
    finish = resolve;
  });
  database.source = null;
  database.imported = false;
  database.failure = null;
  database.closed = 0;
  vi.resetModules();
  vi.spyOn(process, "exit").mockImplementation(((status?: number) => {
    exitStatus = status;
    finish();
    return undefined as never;
  }) as never);
  vi.spyOn(process.stdout, "write").mockImplementation(((chunk: string | Uint8Array) => {
    stdout += String(chunk);
    return true;
  }) as never);
  vi.spyOn(process.stderr, "write").mockImplementation(((chunk: string | Uint8Array) => {
    stderr += String(chunk);
    return true;
  }) as never);
  process.env.ORBIT_ENGINE_CONTEXT = "container";
  process.exitCode = undefined;
});

afterEach(async () => {
  // A case that failed early still waits here for its CLI to finish, under
  // the hook limit, before the captures are released.
  if (running) await running.catch(() => {});
  vi.restoreAllMocks();
  process.argv = originalArgv;
  process.exitCode = undefined;
  if (originalContext === undefined) delete process.env.ORBIT_ENGINE_CONTEXT;
  else process.env.ORBIT_ENGINE_CONTEXT = originalContext;
});

/**
 * Runs the CLI with `args` and waits for its answer: process.exit, which every
 * path of mail-sending-status and the usage refusal ends with. No clock of its
 * own; the test limit caps a CLI that never answers (#1937).
 */
async function runCli(args: string[]): Promise<{ status: number; stdout: string; stderr: string }> {
  process.argv = ["node", "orbit", ...args];
  running = import("./orbit").then(() => finished);
  await running;
  const status = exitStatus ?? (typeof process.exitCode === "number" ? process.exitCode : 0);
  return { status, stdout, stderr };
}

describe("orbit mail-sending-status (#1817)", () => {
  it("source=imported, imported from the environment: one line, exit 0", async () => {
    database.source = "imported";
    database.imported = true;
    const result = await runCli(["mail-sending-status"]);
    expect(result.stdout).toBe("mail-sending source=imported imported-from-environment=true\n");
    expect(result.stderr).toBe("");
    expect(result.status).toBe(0);
  });

  it("source=ui after an import (an administrator then set mail on the screen): imported-from-environment stays true", async () => {
    database.source = "ui";
    database.imported = true;
    const result = await runCli(["mail-sending-status"]);
    expect(result.stdout).toBe("mail-sending source=ui imported-from-environment=true\n");
    expect(result.status).toBe(0);
  });

  it("source=ui set on the screen from the start: imported-from-environment=false", async () => {
    database.source = "ui";
    database.imported = false;
    const result = await runCli(["mail-sending-status"]);
    expect(result.stdout).toBe("mail-sending source=ui imported-from-environment=false\n");
    expect(result.status).toBe(0);
  });

  it("no sending row: source=none, exit 0", async () => {
    database.source = null;
    database.imported = false;
    const result = await runCli(["mail-sending-status"]);
    expect(result.stdout).toBe("mail-sending source=none imported-from-environment=false\n");
    expect(result.stderr).toBe("");
    expect(result.status).toBe(0);
  });

  it("closes the database connection it opened", async () => {
    database.source = "imported";
    database.imported = true;
    await runCli(["mail-sending-status"]);
    expect(database.closed).toBeGreaterThan(0);
  });

  it("an extra argument is a usage error: exit 2, nothing on stdout", async () => {
    database.source = "imported";
    const result = await runCli(["mail-sending-status", "extra"]);
    expect(result.status).toBe(2);
    expect(result.stdout).toBe("");
    expect(result.stderr).toContain("usage");
  });

  it("the database cannot be asked: exit 1, nothing on stdout, and no host, user, address or driver text on stderr", async () => {
    database.failure = new Error("connect ECONNREFUSED db-host.example.test:5432 user=orbit-user password=TEST-NOT-A-REAL-PASSWORD");
    const result = await runCli(["mail-sending-status"]);
    expect(result.status).toBe(1);
    expect(result.stdout).toBe("");
    expect(result.stderr).not.toMatch(/ECONNREFUSED|db-host|orbit-user|TEST-NOT-A-REAL-PASSWORD|5432/u);
    expect(result.stderr.trim().split("\n")).toHaveLength(1);
    expect(result.stderr).toMatch(/^orbit: /u);
    expect(result.stderr).not.toContain("supported commands");
  });

  it("is a listed command: the unknown-command usage names it", async () => {
    const result = await runCli(["totally-not-a-command"]);
    expect(result.stderr).toContain("mail-sending-status");
  });
});
