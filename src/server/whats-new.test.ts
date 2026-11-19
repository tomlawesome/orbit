import { beforeEach, describe, expect, it, vi } from "vitest";
import { PgDialect } from "drizzle-orm/pg-core";
import type { SQL } from "drizzle-orm";
import { releaseNotes, type ReleaseNotes } from "@/release-notes";
import { selectReleaseNotes, selectWhatsNew } from "@/lib/whats-new";

/**
 * The what's-new record (#1618). The database is a recording fake: selects
 * answer from a queue, writes are captured.
 */
const mocks = vi.hoisted(() => ({ getDb: vi.fn(), isAdmin: vi.fn() }));

vi.mock("@/db", () => ({ getDb: mocks.getDb }));
vi.mock("@/server/authorization", () => ({ isInstanceAdministrator: mocks.isAdmin }));

interface Writes { inserts: Array<{ values: Record<string, unknown>; conflict: string; config?: Record<string, unknown> }>; updates: Array<Record<string, unknown>>; locked: number }

function fakeDb(selects: Array<Array<{ seen: string | null }>>) {
  const writes: Writes = { inserts: [], updates: [], locked: 0 };
  const queue = [...selects];
  const executor = {
    select: () => {
      const self: Record<string, unknown> = {};
      for (const name of ["from", "where", "limit"]) self[name] = () => self;
      self.for = () => { writes.locked += 1; return Promise.resolve(queue.shift() ?? []); };
      self.then = (resolve: (value: unknown) => unknown) => Promise.resolve(queue.shift() ?? []).then(resolve);
      return self;
    },
    insert: () => ({
      values: (values: Record<string, unknown>) => {
        const entry = { values, conflict: "none" } as Writes["inserts"][number];
        writes.inserts.push(entry);
        const done = Promise.resolve();
        return Object.assign(done, {
          onConflictDoUpdate: (config: Record<string, unknown>) => { entry.conflict = "update"; entry.config = config; return done; },
          onConflictDoNothing: () => { entry.conflict = "nothing"; return done; },
        });
      },
    }),
    update: () => ({ set: (values: Record<string, unknown>) => ({ where: async () => { writes.updates.push(values); } }) }),
    transaction: async (fn: (tx: unknown) => Promise<void>) => fn(executor),
  };
  mocks.getDb.mockReturnValue(executor);
  return { writes, executor };
}

const notes: ReleaseNotes[] = [
  { version: "v1.0.0", forEveryone: [{ text: "one" }], forAdministrators: [] },
  { version: "v1.1.0", forEveryone: [{ text: "two" }], forAdministrators: [{ text: "two-admin" }] },
  { version: "v1.2.0", forEveryone: [], forAdministrators: [{ text: "three-admin" }] },
] as unknown as ReleaseNotes[];

beforeEach(() => {
  vi.clearAllMocks();
  mocks.isAdmin.mockResolvedValue(false);
});

describe("recordNewAccountSeenVersion", () => {
  it.each([null, undefined, "", "dev", "1.2.3", "v1.2"])("writes nothing for the unparsable version %j", async (version) => {
    const { writes } = fakeDb([]);
    const { recordNewAccountSeenVersion } = await import("@/server/whats-new");
    await recordNewAccountSeenVersion("u1", version);
    expect(writes.inserts).toEqual([]);
  });

  it("records the running version for the user, replacing only a null value", async () => {
    const { writes } = fakeDb([]);
    const { recordNewAccountSeenVersion } = await import("@/server/whats-new");
    await recordNewAccountSeenVersion("u1", "v1.2.0");
    expect(writes.inserts).toHaveLength(1);
    expect(writes.inserts[0].values).toEqual({ userId: "u1", whatsNewSeenVersion: "v1.2.0" });
    expect(writes.inserts[0].conflict).toBe("update");
    expect(writes.inserts[0].config?.set).toEqual({ whatsNewSeenVersion: "v1.2.0" });
    const guard = new PgDialect().sqlToQuery(writes.inserts[0].config?.setWhere as SQL);
    expect(guard.sql).toBe('"user_preferences"."whats_new_seen_version" IS NULL');
    expect(guard.params).toEqual([]);
  });

  it("uses the executor it is given (the account creation's transaction) rather than the database", async () => {
    const own = fakeDb([]);
    // Built last, so getDb() answers with this one: a write that ignored the
    // given executor would land here, not on `own`.
    const database = fakeDb([]);
    const { recordNewAccountSeenVersion } = await import("@/server/whats-new");
    // @ts-expect-error the recording fake stands in for a transaction
    await recordNewAccountSeenVersion("u2", "v1.0.0", own.executor);
    expect(own.writes.inserts).toHaveLength(1);
    expect(database.writes.inserts).toHaveLength(0);
  });
});

describe("readWhatsNew", () => {
  it.each([undefined, null, "dev", "garbage"])("is a null version and no releases, touching nothing, when the running version is %j", async (runningVersion) => {
    const { writes } = fakeDb([]);
    const { readWhatsNew } = await import("@/server/whats-new");
    await expect(readWhatsNew("u1", { runningVersion })).resolves.toEqual({ version: null, releases: [] });
    expect(writes.inserts).toEqual([]);
    expect(mocks.getDb).not.toHaveBeenCalled();
  });

  it("records the running version for a new account and shows nothing", async () => {
    const { writes } = fakeDb([[]]);
    const { readWhatsNew } = await import("@/server/whats-new");
    const answer = await readWhatsNew("u1", { runningVersion: "v1.2.0", notes });
    expect(answer).toEqual({ version: "v1.2.0", releases: [] });
    expect(writes.inserts[0].values).toEqual({ userId: "u1", whatsNewSeenVersion: "v1.2.0" });
  });

  it("treats a stored null the same as no row", async () => {
    const { writes } = fakeDb([[{ seen: null }]]);
    const { readWhatsNew } = await import("@/server/whats-new");
    const answer = await readWhatsNew("u1", { runningVersion: "v1.1.0", notes });
    expect(answer.releases).toEqual([]);
    expect(writes.inserts).toHaveLength(1);
  });

  it("shows a member the for-everyone notes of releases after the seen one, newest first, recording nothing", async () => {
    const { writes } = fakeDb([[{ seen: "v0.0.0" }]]);
    const { readWhatsNew } = await import("@/server/whats-new");
    const answer = await readWhatsNew("u1", { runningVersion: "v1.2.0", notes });
    expect(answer.version).toBe("v1.2.0");
    expect(answer.releases.map((release) => release.version)).toEqual(["v1.1.0", "v1.0.0"]);
    expect(answer.releases[0]).not.toHaveProperty("forAdministrators");
    expect(writes.inserts).toEqual([]);
    expect(mocks.isAdmin).toHaveBeenCalledWith("u1", expect.anything());
  });

  it("shows an administrator the administrator notes too", async () => {
    mocks.isAdmin.mockResolvedValue(true);
    fakeDb([[{ seen: "v1.0.0" }]]);
    const { readWhatsNew } = await import("@/server/whats-new");
    const answer = await readWhatsNew("u1", { runningVersion: "v1.2.0", notes });
    expect(answer.releases.map((release) => release.version)).toEqual(["v1.2.0", "v1.1.0"]);
    expect(answer.releases[0].forAdministrators).toEqual([{ text: "three-admin" }]);
  });

  it("shows nothing once the user has seen the running version", async () => {
    fakeDb([[{ seen: "v1.2.0" }]]);
    const { readWhatsNew } = await import("@/server/whats-new");
    expect((await readWhatsNew("u1", { runningVersion: "v1.2.0", notes })).releases).toEqual([]);
  });

  it("defaults to the notes the repo carries", async () => {
    fakeDb([[{ seen: "v0.0.0" }]]);
    const { readWhatsNew } = await import("@/server/whats-new");
    const answer = await readWhatsNew("u1", { runningVersion: "v0.0.1" });
    expect(answer).toEqual(selectWhatsNew({ seen: "v0.0.0", running: "v0.0.1", isAdmin: false, notes: releaseNotes }));
    expect(answer.version).toBe("v0.0.1");
  });
});

describe("readReleaseNotes", () => {
  it("lists every release for a member, ignoring what has been seen, and records nothing", async () => {
    const { writes } = fakeDb([]);
    const { readReleaseNotes } = await import("@/server/whats-new");
    const answer = await readReleaseNotes("u1", { runningVersion: "v1.1.0", notes });
    expect(answer.version).toBe("v1.1.0");
    expect(answer.releases.map((release) => release.version)).toEqual(["v1.1.0", "v1.0.0"]);
    expect(writes.inserts).toEqual([]);
    expect(mocks.getDb).not.toHaveBeenCalled();
  });

  it("includes administrator-only releases for an administrator", async () => {
    mocks.isAdmin.mockResolvedValue(true);
    const { readReleaseNotes } = await import("@/server/whats-new");
    const answer = await readReleaseNotes("u1", { runningVersion: "v1.2.0", notes });
    expect(answer.releases.map((release) => release.version)).toEqual(["v1.2.0", "v1.1.0", "v1.0.0"]);
  });

  it("marks no running version on a dev build but still lists the notes", async () => {
    const { readReleaseNotes } = await import("@/server/whats-new");
    const answer = await readReleaseNotes("u1", { notes });
    expect(answer.version).toBeNull();
    expect(answer.releases.length).toBe(2);
  });

  it("works with no options, from the notes the repo carries", async () => {
    const { readReleaseNotes } = await import("@/server/whats-new");
    const answer = await readReleaseNotes("u1");
    expect(answer).toEqual(selectReleaseNotes({ running: null, isAdmin: false, notes: releaseNotes }));
    expect(answer.version).toBeNull();
    expect(answer.releases.map((release) => release.version)).toEqual(
      selectReleaseNotes({ running: null, isAdmin: false, notes: releaseNotes }).releases.map((release) => release.version),
    );
  });
});

describe("dismissWhatsNew", () => {
  it.each(["", "dev", "1.0.0", "v1"])("refuses a malformed shown version %j with a 422 and writes nothing", async (shown) => {
    const { writes } = fakeDb([]);
    const { dismissWhatsNew } = await import("@/server/whats-new");
    await expect(dismissWhatsNew("u1", shown, { runningVersion: "v1.2.0" })).rejects.toMatchObject({ status: 422, code: "validation_failed" });
    expect(writes.inserts).toEqual([]);
  });

  it("is a no-op when the running version is not a release", async () => {
    fakeDb([]);
    const { dismissWhatsNew } = await import("@/server/whats-new");
    await expect(dismissWhatsNew("u1", "v1.0.0", { runningVersion: "dev" })).resolves.toBeUndefined();
    await expect(dismissWhatsNew("u1", "v1.0.0")).resolves.toBeUndefined();
    expect(mocks.getDb).not.toHaveBeenCalled();
  });

  it("stores the shown version when it is ahead of the seen one", async () => {
    const { writes } = fakeDb([[{ seen: "v1.0.0" }]]);
    const { dismissWhatsNew } = await import("@/server/whats-new");
    await dismissWhatsNew("u1", "v1.1.0", { runningVersion: "v1.2.0" });
    expect(writes.updates).toEqual([{ whatsNewSeenVersion: "v1.1.0" }]);
    expect(writes.inserts[0]).toMatchObject({ values: { userId: "u1" }, conflict: "nothing" });
    expect(writes.locked).toBe(1);
  });

  it("caps at the running version: a dismissal from a newer server cannot mark an unshown release", async () => {
    const { writes } = fakeDb([[{ seen: "v1.0.0" }]]);
    const { dismissWhatsNew } = await import("@/server/whats-new");
    await dismissWhatsNew("u1", "v9.0.0", { runningVersion: "v1.2.0" });
    expect(writes.updates).toEqual([{ whatsNewSeenVersion: "v1.2.0" }]);
  });

  it.each(["v1.1.0", "v1.5.0"])("never goes backwards: seen %s stays when dismissing v1.1.0", async (seen) => {
    const { writes } = fakeDb([[{ seen }]]);
    const { dismissWhatsNew } = await import("@/server/whats-new");
    await dismissWhatsNew("u1", "v1.1.0", { runningVersion: "v1.6.0" });
    expect(writes.updates).toEqual([]);
  });

  it("writes the target for a row whose seen value is null", async () => {
    const { writes } = fakeDb([[{ seen: null }]]);
    const { dismissWhatsNew } = await import("@/server/whats-new");
    await dismissWhatsNew("u1", "v1.0.0", { runningVersion: "v1.2.0" });
    expect(writes.updates).toEqual([{ whatsNewSeenVersion: "v1.0.0" }]);
  });

  it("replaces a stored seen value that is not a release version", async () => {
    const { writes } = fakeDb([[{ seen: "garbage" }]]);
    const { dismissWhatsNew } = await import("@/server/whats-new");
    await dismissWhatsNew("u1", "v1.0.0", { runningVersion: "v1.2.0" });
    expect(writes.updates).toEqual([{ whatsNewSeenVersion: "v1.0.0" }]);
  });

  it("writes the target when the row is missing from the select", async () => {
    const { writes } = fakeDb([[]]);
    const { dismissWhatsNew } = await import("@/server/whats-new");
    await dismissWhatsNew("u1", "v1.2.0", { runningVersion: "v1.2.0" });
    expect(writes.updates).toEqual([{ whatsNewSeenVersion: "v1.2.0" }]);
  });
});
