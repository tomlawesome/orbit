import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

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
let exited = false;
const originalArgv = process.argv;
const originalContext = process.env.ORBIT_ENGINE_CONTEXT;

beforeEach(() => {
  stdout = "";
  stderr = "";
  exitStatus = undefined;
  exited = false;
  database.source = null;
  database.imported = false;
  database.failure = null;
  database.closed = 0;
  vi.resetModules();
  vi.spyOn(process, "exit").mockImplementation(((status?: number) => {
    exited = true;
    exitStatus = status;
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

afterEach(() => {
  vi.restoreAllMocks();
  process.argv = originalArgv;
  process.exitCode = undefined;
  if (originalContext === undefined) delete process.env.ORBIT_ENGINE_CONTEXT;
  else process.env.ORBIT_ENGINE_CONTEXT = originalContext;
});

/** Runs the CLI with `args`, waits for it to finish (it answers asynchronously) and returns what it did. */
async function runCli(args: string[]): Promise<{ status: number; stdout: string; stderr: string }> {
  process.argv = ["node", "orbit", ...args];
  await import("./orbit");
  const deadline = Date.now() + 3000;
  while (Date.now() < deadline && !exited && stdout === "" && database.closed === 0) {
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
  // Let a trailing exit or database close settle.
  await new Promise((resolve) => setTimeout(resolve, 50));
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
