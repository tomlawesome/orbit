import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

// `orbit mail-sending-status` decrypt gate (#1817, inline review of b342ca61):
// when the mail_sending row exists but Orbit cannot decrypt its password (the
// document key is missing, or the decrypt throws), deleting the SMTP password
// file would destroy the last usable copy, so the command prints source=none.
// The sending-settings module runs for real over a fake database; only the
// key lookup and the decrypt are replaced (the shape of
// orbit.mail-sending-status.test.ts for everything else).

const world = vi.hoisted(() => ({
  hasKey: true,
  decryptThrows: false,
  closed: 0,
}));

const fakeDatabase = vi.hoisted(() => async () => {
  const { getTableName } = await import("drizzle-orm");
  const rowsFor = (table: unknown): unknown[] => {
    if (getTableName(table as never) === "mail_sending") {
      return [{ id: "row-1", source: "imported", via: "account", host: "smtp.example.test", port: 587, security: "starttls", accountUser: "orbit@example.test", passwordSecretId: "secret-1", senderName: "Orbit", senderAddress: "orbit@example.test" }];
    }
    if (getTableName(table as never) === "mail_in_secrets") return [{ id: "secret-1", keyId: "key-1", ciphertext: "x" }];
    return [];
  };
  const query = (rows: unknown[]) => {
    const q: Record<string, unknown> = {};
    q.where = () => q;
    q.limit = () => q;
    q.then = (resolve: (value: unknown[]) => unknown, reject: (reason: unknown) => unknown) => Promise.resolve(rows).then(resolve, reject);
    return q;
  };
  return {
    getDb: () => ({ select: () => ({ from: (table: unknown) => query(rowsFor(table)) }) }),
    closeDatabase: async () => {
      world.closed += 1;
    },
  };
});
// The CLI imports "../db", the sending settings "@/db": the same file, mocked under both names.
vi.mock("../db", async (importOriginal) => ({ ...(await importOriginal<typeof import("../db")>()), ...(await fakeDatabase()) }));
vi.mock("@/db", async (importOriginal) => ({ ...(await importOriginal<typeof import("../db")>()), ...(await fakeDatabase()) }));

vi.mock("../server/documents/config", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../server/documents/config")>();
  return {
    ...actual,
    getDocumentConfig: () => ({}) as never,
    keyEncryptionKeyFor: () => (world.hasKey ? Buffer.alloc(32, 1) : null),
  };
});

vi.mock("../server/documents/crypto", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../server/documents/crypto")>();
  return { ...actual, envelopeOf: () => ({}) as never };
});

vi.mock("../server/mail-in/core/secret-crypto", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../server/mail-in/core/secret-crypto")>();
  return {
    ...actual,
    decryptMailInSecret: () => {
      if (world.decryptThrows) throw new Error("bad tag TEST-NOT-A-REAL-PASSWORD");
      return Buffer.from("TEST-NOT-A-REAL-PASSWORD");
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
  world.hasKey = true;
  world.decryptThrows = false;
  world.closed = 0;
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

async function runCli(): Promise<{ status: number; stdout: string; stderr: string }> {
  process.argv = ["node", "orbit", "mail-sending-status"];
  // Loaded first so the CLI's own dynamic import reuses this instance, which sits over the fake database
  // (the CLI's import by itself is resolved past the "@/db" mock).
  await import("../server/mail-in/sending-settings");
  await import("./orbit");
  const deadline = Date.now() + 3000;
  while (Date.now() < deadline && !exited && stdout === "") {
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
  await new Promise((resolve) => setTimeout(resolve, 50));
  return { status: exitStatus ?? (typeof process.exitCode === "number" ? process.exitCode : 0), stdout, stderr };
}

describe("orbit mail-sending-status decrypt gate (#1817)", () => {
  it("control: the row exists and its password decrypts: source=imported", async () => {
    const result = await runCli();
    expect(result.stderr).toBe("");
    expect(result.stdout).toBe("mail-sending source=imported imported-from-environment=false\n");
    expect(result.status).toBe(0);
  });

  it("the document key is missing: source=none, exit 0, nothing on stderr", async () => {
    world.hasKey = false;
    const result = await runCli();
    expect(result.stdout).toBe("mail-sending source=none imported-from-environment=false\n");
    expect(result.stderr).toBe("");
    expect(result.status).toBe(0);
  });

  it("the decrypt throws: source=none, exit 0, and no error text on either stream", async () => {
    world.decryptThrows = true;
    const result = await runCli();
    expect(result.stdout).toBe("mail-sending source=none imported-from-environment=false\n");
    expect(`${result.stdout}${result.stderr}`).not.toMatch(/bad tag|TEST-NOT-A-REAL-PASSWORD/u);
    expect(result.status).toBe(0);
  });
});
