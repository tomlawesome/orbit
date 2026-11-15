import { beforeEach, describe, expect, it, vi } from "vitest";
import { auditLog, pushSubscriptions } from "@/db/schema";

/**
 * The approval notice (#1398): the pure parts (its id, its words, its mail),
 * the queue and end writes, and the worker cycle against a scripted stand-in
 * for the database. The stand-in hands each awaited select the next scripted
 * answer and records every write, so what the notice's row says afterwards is
 * read off the `set(...)` the code issued.
 */

const meta = vi.hoisted(() => ({
  household: { state: "ok", value: "Receipt title" } as { state: string; value?: string },
  address: { state: "ok", value: "member@example.test" } as { state: string; value?: string },
  keyed: true,
}));

vi.mock("@/server/metadata/fields", () => ({
  openMetadataReader: async () => ({ text: () => meta.household }),
  openInstanceMetadataReader: async () => ({ text: () => meta.address }),
}));
vi.mock("@/server/metadata/keys", () => ({ metadataCryptoAvailable: () => meta.keyed }));

const {
  APPROVAL_NOTICE_BODY,
  APPROVAL_NOTICE_ENTITY,
  APPROVAL_NOTICE_HEADLINE,
  approvalNoticeId,
  approvalNoticeMail,
  approvalNoticePush,
  deliverApprovalNotices,
  dueNoticesQuery,
  endApprovalNotices,
  endHouseholdApprovalNotices,
  queueApprovalNotice,
} = await import("./approval-notice");

interface Op { kind: string; table?: unknown; args: Record<string, unknown[]>; returning: boolean }
type Step = unknown | Error | ((op: Op, ops: Op[]) => unknown);

function scriptedDb(steps: Step[], options: { execute?: () => unknown } = {}) {
  const ops: Op[] = [];
  const queue = [...steps];
  const take = (op: Op) => {
    if (!queue.length) return [];
    const step = queue.shift();
    const value = typeof step === "function" ? (step as (o: Op, all: Op[]) => unknown)(op, ops) : step;
    if (value instanceof Error) throw value;
    return value;
  };
  const chain = (kind: string, table?: unknown, consumes = true) => {
    const op: Op = { kind, table, args: {}, returning: false };
    ops.push(op);
    const proxy: unknown = new Proxy({}, {
      get(_target, property: string) {
        if (property === "then") {
          return (resolve: (value: unknown) => unknown, reject: (reason: unknown) => unknown) =>
            Promise.resolve().then(() => (consumes || op.returning ? take(op) : [])).then(resolve, reject);
        }
        return (...args: unknown[]) => {
          op.args[property] = args;
          if (property === "returning") op.returning = true;
          if (property === "from" && !op.table) op.table = args[0];
          return proxy;
        };
      },
    });
    return proxy;
  };
  const db: Record<string, unknown> = {
    select: () => chain("select"),
    selectDistinct: () => chain("select"),
    insert: (table: unknown) => chain("insert", table, false),
    update: (table: unknown) => chain("update", table, false),
    delete: (table: unknown) => chain("delete", table, false),
    execute: () => Promise.resolve().then(() => (options.execute ? options.execute() : [])),
    transaction: async (body: (executor: unknown) => unknown) => body(db),
  };
  return { db: db as never, ops, remaining: () => queue.length };
}

const NOW = new Date("2026-11-01T12:00:00.000Z");
const retryDelay = (attempts: number) => attempts * 1000;
const config = {
  smtpUrl: "smtp://mail.example.test", smtpSecurity: "starttls" as const, smtpFrom: "Orbit <orbit@example.test>",
  vapidSubject: "mailto:admin@example.test", vapidPublicKey: "pub", vapidPrivateKey: "priv",
  pollMilliseconds: 1000, maxAttempts: 3,
};
const baseChanges = {
  operationId: "op-1", titleEnc: "enc", email: "pending", push: "pending", emailAttempts: 0, pushAttempts: 0,
  nextAttemptAt: null, emailClaimedAt: null, pushClaimedAt: null,
} as Record<string, unknown>;
const baseRow = {
  householdId: "h1", userId: "u1", changes: baseChanges, receiptStatus: "pending_review", receiptHouseholdId: "h1",
  emailEnc: "emailenc", disabledAt: null, isMember: true, userEmailEnabled: true, userPushEnabled: true,
};
const subscription = { id: "s1", endpoint: "https://push.example.test/abc", p256dh: "k", auth: "a" };

function providers() {
  return { sendEmail: vi.fn(async () => undefined), sendPush: vi.fn(async () => undefined) } as never as {
    sendEmail: ReturnType<typeof vi.fn>; sendPush: ReturnType<typeof vi.fn>;
  };
}

const noticeUpdates = (ops: Op[]) => ops.filter((op) => op.kind === "update" && op.table === auditLog)
  .map((op) => (op.args.set![0] as { changes: Record<string, unknown> }).changes);


/** Steps: due list, claim row, optional subscriptions, record row, then an empty due list. */
function notice(overrides: { row?: Record<string, unknown>; subs?: unknown[]; record?: (ops: Op[]) => unknown; end?: boolean } = {}) {
  const row = { ...baseRow, ...overrides.row };
  const steps: Step[] = [[{ id: "n1" }], [row]];
  if (overrides.subs) steps.push(overrides.subs);
  steps.push((_op, ops) => {
    const written = noticeUpdates(ops).at(-1) ?? (row.changes as Record<string, unknown>);
    return overrides.record ? overrides.record(ops) : [{ changes: written, householdId: "h1", receiptStatus: "pending_review", receiptHouseholdId: "h1" }];
  });
  steps.push([]);
  return scriptedDb(steps, { execute: () => [{ id: "n1" }] });
}

beforeEach(() => {
  meta.household = { state: "ok", value: "Receipt title" };
  meta.address = { state: "ok", value: "member@example.test" };
  meta.keyed = true;
  vi.restoreAllMocks();
});

describe("approvalNoticeId", () => {
  it("derives one stable v4-shaped id per operation id, never the operation id itself", () => {
    const id = approvalNoticeId("op-1");
    expect(id).toMatch(/^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/u);
    expect(approvalNoticeId("op-1")).toBe(id);
    expect(approvalNoticeId("op-2")).not.toBe(id);
    expect(id).not.toBe("op-1");
  });
});

describe("the notice's words", () => {
  it("push carries the headline, the body and the root url", () => {
    expect(approvalNoticePush()).toEqual({ title: APPROVAL_NOTICE_HEADLINE, body: APPROVAL_NOTICE_BODY, url: "/" });
  });

  it("mail uses the headline as subject and links to the inbox of the instance's own address", () => {
    const mail = approvalNoticeMail({ APP_URL: "https://orbit.example.test/some/path" } as NodeJS.ProcessEnv);
    expect(mail.subject).toBe(APPROVAL_NOTICE_HEADLINE);
    expect(mail.text).toContain(APPROVAL_NOTICE_BODY);
    expect(mail.text).toContain("Open your inbox: https://orbit.example.test/?open=inbox");
    expect(mail.html).toContain("https://orbit.example.test/?open=inbox");
    expect(mail.html).toContain("Open your inbox");
  });

  it.each([
    ["no APP_URL", {}],
    ["an unparseable APP_URL", { APP_URL: "not a url" }],
    ["a non-web APP_URL", { APP_URL: "ftp://orbit.example.test" }],
  ])("mail carries no link rather than an invented one with %s", (_name, environment) => {
    const mail = approvalNoticeMail(environment as NodeJS.ProcessEnv);
    expect(mail.text).toBe(`${APPROVAL_NOTICE_HEADLINE}\n\n${APPROVAL_NOTICE_BODY}`);
    expect(mail.html).not.toContain("Open your inbox");
  });
});

describe("queueApprovalNotice", () => {
  const cipher = { encryptText: vi.fn((column: string, id: string, text: string) => `${column}|${id}|${text}`) };

  it("writes one outbox row keyed by the derived id, with the trimmed, bounded title encrypted", async () => {
    const { db, ops } = scriptedDb([]);
    await queueApprovalNotice(db, cipher as never, {
      operationId: "op-9", userId: "u1", householdId: "h1", receiptId: "r1", title: `  ${"x".repeat(200)}  `, reason: "server_error",
    });
    const insert = ops.find((op) => op.kind === "insert")!;
    expect(insert.table).toBe(auditLog);
    const values = insert.args.values![0] as Record<string, unknown>;
    const id = approvalNoticeId("op-9");
    expect(values).toMatchObject({
      id, householdId: "h1", actorUserId: "u1", entityType: APPROVAL_NOTICE_ENTITY, entityId: "r1", action: "reviewed_intake_not_added",
    });
    const changes = values.changes as Record<string, unknown>;
    expect(changes).toMatchObject({ operationId: "op-9", email: "pending", push: "pending", emailAttempts: 0, pushAttempts: 0, reason: "server_error" });
    expect(changes.titleEnc).toBe(`audit_log.approval_notice|${id}|${"x".repeat(160)}`);
    expect(insert.args.onConflictDoNothing![0]).toEqual({ target: auditLog.id });
  });
});

describe("ending notices", () => {
  it("does nothing for a receipt with no household", async () => {
    const { db, ops } = scriptedDb([]);
    await endApprovalNotices(db, { id: "r1", householdId: null });
    expect(ops).toHaveLength(0);
  });

  it("issues one update on the audit log for a receipt's notices and one for a purged household's", async () => {
    const one = scriptedDb([]);
    await endApprovalNotices(one.db, { id: "r1", householdId: "h1" });
    expect(one.ops.filter((op) => op.kind === "update" && op.table === auditLog)).toHaveLength(1);
    const two = scriptedDb([]);
    await endHouseholdApprovalNotices(two.db, "h1");
    expect(two.ops.filter((op) => op.kind === "update" && op.table === auditLog)).toHaveLength(1);
  });
});

describe("dueNoticesQuery", () => {
  it("passes its limit on and excludes already-seen ids only when there are some", async () => {
    const unseen = scriptedDb([[{ id: "a" }]]);
    expect(await dueNoticesQuery(unseen.db, NOW, [], 5)).toEqual([{ id: "a" }]);
    expect(unseen.ops[0]!.args.limit).toEqual([5]);
    const leaves = (node: unknown): number => {
      const chunks = (node as { queryChunks?: unknown[] }).queryChunks;
      return Array.isArray(node) ? node.reduce<number>((sum, item) => sum + leaves(item), 0) : chunks ? chunks.reduce<number>((sum, item) => sum + leaves(item), 0) : 1;
    };
    const whereWithout = leaves(unseen.ops[0]!.args.where![0]);
    const seen = scriptedDb([[]]);
    await dueNoticesQuery(seen.db, NOW, ["a"], 5);
    const whereWith = leaves(seen.ops[0]!.args.where![0]);
    expect(whereWith).toBeGreaterThan(whereWithout);
  });
});

describe("deliverApprovalNotices", () => {
  it("sends both channels, then records them sent and clears the title", async () => {
    const p = providers();
    const { db, ops } = notice({ subs: [subscription] });
    await deliverApprovalNotices(db, config, NOW, p as never, retryDelay);
    expect(p.sendEmail).toHaveBeenCalledWith(expect.objectContaining({
      from: config.smtpFrom, to: "member@example.test", subject: APPROVAL_NOTICE_HEADLINE, tlsMode: "starttls",
    }));
    expect(p.sendPush).toHaveBeenCalledWith({
      target: { endpoint: subscription.endpoint, keys: { p256dh: "k", auth: "a" } },
      payload: approvalNoticePush(),
    });
    const [claimed, recorded] = noticeUpdates(ops);
    expect(claimed).toMatchObject({ email: "sending", push: "sending", emailClaimedAt: NOW.toISOString() });
    expect(claimed!.nextAttemptAt).toBe(new Date(NOW.getTime() + 10 * 60_000).toISOString());
    expect(recorded).toMatchObject({ email: "sent", push: "sent", titleEnc: null, nextAttemptAt: null, emailClaimedAt: null, pushClaimedAt: null });
  });

  it("retries a failed mail after the delay, and fails it once the attempts are spent", async () => {
    const p = providers();
    p.sendEmail.mockRejectedValue(new Error("smtp down"));
    const first = notice({ row: { userPushEnabled: false } });
    await deliverApprovalNotices(first.db, config, NOW, p as never, retryDelay);
    const [, recorded] = noticeUpdates(first.ops);
    expect(recorded).toMatchObject({ email: "pending", emailAttempts: 1, push: "off", titleEnc: "enc" });
    expect(recorded!.nextAttemptAt).toBe(new Date(NOW.getTime() + 1000).toISOString());

    const last = notice({ row: { userPushEnabled: false, changes: { ...baseChanges, emailAttempts: 2 } } });
    await deliverApprovalNotices(last.db, config, NOW, p as never, retryDelay);
    expect(noticeUpdates(last.ops)[1]).toMatchObject({ email: "failed", emailAttempts: 3, titleEnc: null, nextAttemptAt: null });
  });

  it("revokes a gone device (410, 404) and an endpoint it will not call, and fails nothing", async () => {
    const p = providers();
    p.sendPush.mockRejectedValueOnce(Object.assign(new Error("gone"), { statusCode: 410 }))
      .mockRejectedValueOnce(Object.assign(new Error("missing"), { statusCode: 404 }));
    const subs = [
      { ...subscription, id: "gone" },
      { ...subscription, id: "missing" },
      { ...subscription, id: "plain-http", endpoint: "http://push.example.test/x" },
    ];
    const { db, ops } = notice({ row: { userEmailEnabled: false }, subs });
    await deliverApprovalNotices(db, config, NOW, p as never, retryDelay);
    expect(p.sendPush).toHaveBeenCalledTimes(2);
    const revoke = ops.find((op) => op.kind === "update" && op.table === pushSubscriptions)!;
    expect(revoke.args.set![0]).toEqual({ revokedAt: NOW });
    expect(noticeUpdates(ops)[1]).toMatchObject({ push: "skipped", email: "off", titleEnc: null });
  });

  it("counts an unexplained push error as transient and retries it", async () => {
    const p = providers();
    p.sendPush.mockRejectedValue(new Error("timeout"));
    const { db, ops } = notice({ row: { userEmailEnabled: false }, subs: [subscription] });
    await deliverApprovalNotices(db, config, NOW, p as never, retryDelay);
    expect(noticeUpdates(ops)[1]).toMatchObject({ push: "pending", pushAttempts: 1 });
  });

  it("is sent once one device has it, even when another fails", async () => {
    const p = providers();
    p.sendPush.mockRejectedValueOnce(new Error("flaky"));
    const { db, ops } = notice({ row: { userEmailEnabled: false }, subs: [subscription, { ...subscription, id: "s2" }] });
    await deliverApprovalNotices(db, config, NOW, p as never, retryDelay);
    expect(noticeUpdates(ops)[1]).toMatchObject({ push: "sent" });
  });

  it("fails a push when its attempts are spent", async () => {
    const p = providers();
    p.sendPush.mockRejectedValue(new Error("timeout"));
    const { db, ops } = notice({ row: { userEmailEnabled: false, changes: { ...baseChanges, pushAttempts: 2 } }, subs: [subscription] });
    await deliverApprovalNotices(db, config, NOW, p as never, retryDelay);
    expect(noticeUpdates(ops)[1]).toMatchObject({ push: "failed", pushAttempts: 3 });
  });

  it("ends the channels unsent when the member switched them off or sending is not set up", async () => {
    const off = notice({ row: { userEmailEnabled: false, userPushEnabled: false } });
    const p = providers();
    await deliverApprovalNotices(off.db, config, NOW, p as never, retryDelay);
    expect(noticeUpdates(off.ops)[0]).toMatchObject({ email: "off", push: "off", titleEnc: null, nextAttemptAt: null });

    const unset = notice();
    await deliverApprovalNotices(unset.db, { ...config, smtpUrl: "", vapidPublicKey: "" }, NOW, p as never, retryDelay);
    expect(noticeUpdates(unset.ops)[0]).toMatchObject({ email: "skipped", push: "skipped", titleEnc: null });
    expect(p.sendEmail).not.toHaveBeenCalled();
    expect(p.sendPush).not.toHaveBeenCalled();
  });

  it("skips push when the member has no live subscription", async () => {
    const { db, ops } = notice({ row: { userEmailEnabled: false }, subs: [] });
    await deliverApprovalNotices(db, config, NOW, providers() as never, retryDelay);
    expect(noticeUpdates(ops)[0]).toMatchObject({ push: "skipped", titleEnc: null });
  });

  it.each([
    ["the receipt was added", { receiptStatus: "added" }],
    ["the receipt moved household", { receiptHouseholdId: "h2" }],
    ["the receipt is gone", { receiptStatus: null }],
    ["the member is disabled", { disabledAt: new Date() }],
    ["the member left", { isMember: false }],
    ["the notice has no household", { householdId: null }],
    ["the notice has no member", { userId: null }],
  ])("ends the notice unsent when %s", async (_name, row) => {
    const p = providers();
    const { db, ops } = notice({ row });
    await deliverApprovalNotices(db, config, NOW, p as never, retryDelay);
    expect(p.sendEmail).not.toHaveBeenCalled();
    expect(noticeUpdates(ops)[0]).toMatchObject({ email: "skipped", push: "skipped", titleEnc: null });
  });

  it.each(["approving", "recoverable"])("waits on a receipt that is %s, spending no attempt", async (receiptStatus) => {
    const p = providers();
    const { db, ops } = notice({ row: { receiptStatus } });
    await deliverApprovalNotices(db, config, NOW, p as never, retryDelay);
    expect(p.sendEmail).not.toHaveBeenCalled();
    expect(noticeUpdates(ops)[0]).toMatchObject({ waitingOn: "receipt", deferrals: 1, email: "pending", push: "pending", emailAttempts: 0 });
    expect(noticeUpdates(ops)[0]!.nextAttemptAt).toBe(new Date(NOW.getTime() + 1000).toISOString());
  });

  it("drops the wait and its backoff once the receipt is back in review, then sends", async () => {
    const p = providers();
    const { db, ops } = notice({
      row: { userPushEnabled: false, changes: { ...baseChanges, waitingOn: "receipt", deferrals: 4 } },
    });
    await deliverApprovalNotices(db, config, NOW, p as never, retryDelay);
    expect(p.sendEmail).toHaveBeenCalledTimes(1);
    const claimed = noticeUpdates(ops)[0]!;
    expect(claimed.waitingOn).toBeUndefined();
    expect(claimed.deferrals).toBe(0);
  });

  it("defers while one household's key is locked, but leaves it plainly pending when the whole instance is locked", async () => {
    meta.household = { state: "metadata_locked" };
    const keyed = notice();
    const p = providers();
    await deliverApprovalNotices(keyed.db, config, NOW, p as never, retryDelay);
    expect(noticeUpdates(keyed.ops)[0]).toMatchObject({ deferrals: 1, email: "pending", push: "pending", emailAttempts: 0 });

    meta.keyed = false;
    const unkeyed = notice();
    await deliverApprovalNotices(unkeyed.db, config, NOW, p as never, retryDelay);
    expect(noticeUpdates(unkeyed.ops)).toHaveLength(0);
    expect(p.sendEmail).not.toHaveBeenCalled();
  });

  it("spends an attempt per channel on a damaged title and fails them after the maximum", async () => {
    meta.household = { state: "unreadable", value: "   " };
    const first = notice();
    await deliverApprovalNotices(first.db, config, NOW, providers() as never, retryDelay);
    expect(noticeUpdates(first.ops)[0]).toMatchObject({ emailAttempts: 1, pushAttempts: 1, email: "pending", push: "pending" });

    const last = notice({ row: { changes: { ...baseChanges, emailAttempts: 2, pushAttempts: 2 } } });
    await deliverApprovalNotices(last.db, config, NOW, providers() as never, retryDelay);
    expect(noticeUpdates(last.ops)[0]).toMatchObject({ email: "failed", push: "failed", titleEnc: null });
  });

  it("defers on a locked address and spends an attempt on an unreadable one", async () => {
    meta.address = { state: "metadata_locked" };
    const locked = notice({ row: { userPushEnabled: false } });
    await deliverApprovalNotices(locked.db, config, NOW, providers() as never, retryDelay);
    expect(noticeUpdates(locked.ops)[0]).toMatchObject({ deferrals: 1, emailAttempts: 0 });

    meta.address = { state: "unreadable" };
    const unreadable = notice({ row: { userPushEnabled: false } });
    await deliverApprovalNotices(unreadable.db, config, NOW, providers() as never, retryDelay);
    expect(noticeUpdates(unreadable.ops)[0]).toMatchObject({ emailAttempts: 1, email: "pending" });
  });

  it("ends a channel left sending by a cut-off claim, and leaves a recent claim to its send", async () => {
    const stale = notice({ row: { changes: { ...baseChanges, email: "sending", push: "sent", emailClaimedAt: new Date(NOW.getTime() - 11 * 60_000).toISOString() } } });
    const p = providers();
    await deliverApprovalNotices(stale.db, config, NOW, p as never, retryDelay);
    expect(noticeUpdates(stale.ops)[0]).toMatchObject({ email: "failed", push: "sent", titleEnc: null });
    expect(p.sendEmail).not.toHaveBeenCalled();

    const unclaimed = notice({ row: { changes: { ...baseChanges, email: "sending", push: "sent", emailClaimedAt: null } } });
    await deliverApprovalNotices(unclaimed.db, config, NOW, p as never, retryDelay);
    expect(noticeUpdates(unclaimed.ops)[0]).toMatchObject({ email: "failed" });

    const fresh = notice({ row: { changes: { ...baseChanges, email: "sending", push: "sent", emailClaimedAt: new Date(NOW.getTime() - 60_000).toISOString() } } });
    await deliverApprovalNotices(fresh.db, config, NOW, p as never, retryDelay);
    expect(noticeUpdates(fresh.ops)).toHaveLength(0);
  });

  it("writes nothing for a notice whose channels have all ended already", async () => {
    const done = notice({ row: { changes: { ...baseChanges, email: "sent", push: "off", titleEnc: null } } });
    await deliverApprovalNotices(done.db, config, NOW, providers() as never, retryDelay);
    expect(noticeUpdates(done.ops)).toHaveLength(0);
  });

  it("sends nothing when another worker holds the row or it has vanished", async () => {
    const p = providers();
    const locked = scriptedDb([[{ id: "n1" }], []], { execute: () => [] });
    await deliverApprovalNotices(locked.db, config, NOW, p as never, retryDelay);
    const vanished = scriptedDb([[{ id: "n1" }], []], { execute: () => [{ id: "n1" }] });
    await deliverApprovalNotices(vanished.db, config, NOW, p as never, retryDelay);
    expect(p.sendEmail).not.toHaveBeenCalled();
    expect(vanished.ops.filter((op) => op.kind === "update")).toHaveLength(0);
  });

  it("ends what a send leaves pending when the receipt left review while it was on the wire", async () => {
    const p = providers();
    p.sendEmail.mockRejectedValue(new Error("down"));
    const { db, ops } = notice({
      row: { userPushEnabled: false },
      record: (all) => [{ changes: noticeUpdates(all).at(-1), householdId: "h1", receiptStatus: "added", receiptHouseholdId: "h1" }],
    });
    await deliverApprovalNotices(db, config, NOW, p as never, retryDelay);
    expect(noticeUpdates(ops)[1]).toMatchObject({ email: "skipped", titleEnc: null, nextAttemptAt: null });
  });

  it("ignores a result whose claim is no longer the row's, and one for a vanished row", async () => {
    const p = providers();
    const stolen = notice({
      row: { userPushEnabled: false },
      record: (all) => [{ changes: { ...noticeUpdates(all).at(-1), emailClaimedAt: "another-claim" }, householdId: "h1", receiptStatus: "pending_review", receiptHouseholdId: "h1" }],
    });
    await deliverApprovalNotices(stolen.db, config, NOW, p as never, retryDelay);
    expect(noticeUpdates(stolen.ops)).toHaveLength(1);

    const gone = notice({ row: { userPushEnabled: false }, record: () => [] });
    await deliverApprovalNotices(gone.db, config, NOW, p as never, retryDelay);
    expect(noticeUpdates(gone.ops)).toHaveLength(1);
  });

  it("defers a notice whose claim threw, dropping any wait on the receipt", async () => {
    const steps: Step[] = [
      [{ id: "n1" }],
      new Error("database fault"),
      [{ changes: { ...baseChanges, waitingOn: "receipt", deferrals: 1 } }],
      [],
    ];
    const { db, ops } = scriptedDb(steps, { execute: () => [{ id: "n1" }] });
    await deliverApprovalNotices(db, config, NOW, providers() as never, retryDelay);
    const [deferred] = noticeUpdates(ops);
    expect(deferred!.waitingOn).toBeUndefined();
    expect(deferred).toMatchObject({ deferrals: 2, nextAttemptAt: new Date(NOW.getTime() + 2000).toISOString() });
  });

  it("survives a deferral that cannot be written either, and a row already gone", async () => {
    const failing = scriptedDb([[{ id: "n1" }], new Error("fault"), new Error("fault again"), []], { execute: () => [{ id: "n1" }] });
    await expect(deliverApprovalNotices(failing.db, config, NOW, providers() as never, retryDelay)).resolves.toBeUndefined();
    const gone = scriptedDb([[{ id: "n1" }], new Error("fault"), [], []], { execute: () => [{ id: "n1" }] });
    await deliverApprovalNotices(gone.db, config, NOW, providers() as never, retryDelay);
    expect(noticeUpdates(gone.ops)).toHaveLength(0);
  });

  it("looks at no more than four times its limit of rows in a cycle, however many are blocked", async () => {
    let next = 0;
    const sequence = () => [{ id: `n${next += 1}` }];
    const steps = Array.from({ length: 10 }, () => sequence);
    const run = scriptedDb(steps as Step[], { execute: () => [] });
    await deliverApprovalNotices(run.db, config, NOW, providers() as never, retryDelay, 1);
    expect(run.ops.filter((op) => op.kind === "select" && op.args.limit?.[0] === 1)).toHaveLength(4);
  });

  it("stops at its limit once that many have gone out", async () => {
    const p = providers();
    const first = notice({ row: { userPushEnabled: false } });
    await deliverApprovalNotices(first.db, config, NOW, p as never, retryDelay, 1);
    expect(p.sendEmail).toHaveBeenCalledTimes(1);
    expect(first.remaining()).toBe(1);
  });
});
