import { beforeEach, describe, expect, it, vi } from "vitest";
import { PgDialect } from "drizzle-orm/pg-core";
import type { SQL } from "drizzle-orm";
import { auditLog, pushSubscriptions } from "@/db/schema";
import { log } from "@/lib/logger";

/**
 * #1929 part 2 (ruling, note 67125) items 6, 7 and 10 for the approval notice,
 * the second caller of `providers.sendPush`. Fixtures copied from
 * approval-notice.test.ts.
 */

const render = (node: unknown) => new PgDialect().sqlToQuery(node as SQL);

const webPushMock = vi.hoisted(() => ({
  setVapidDetails: vi.fn(),
  sendNotification: vi.fn(async () => ({ statusCode: 201, body: "", headers: {} })),
}));
vi.mock("web-push", () => ({ default: webPushMock }));

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

const { deliverApprovalNotices } = await import("./approval-notice");
const { BlockedPushEndpointError } = await import("../notification-worker");

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

const BLOCKED_HOST = "blocked-host.push.example.test";
const BLOCKED_ADDRESS = "127.0.0.1";
const subA = { id: "sub-a", endpoint: `https://${BLOCKED_HOST}/abc`, p256dh: "k", auth: "a" };
const subB = { id: "sub-b", endpoint: "https://push.example.test/def", p256dh: "k", auth: "a" };

function providers() {
  return { sendEmail: vi.fn(async () => undefined), sendPush: vi.fn(async () => undefined) } as never as {
    sendEmail: ReturnType<typeof vi.fn>; sendPush: ReturnType<typeof vi.fn>;
  };
}

const noticeUpdates = (ops: Op[]) => ops.filter((op) => op.kind === "update" && op.table === auditLog)
  .map((op) => (op.args.set![0] as { changes: Record<string, unknown> }).changes);

function notice(overrides: { row?: Record<string, unknown>; subs?: unknown[] } = {}) {
  const row = { ...baseRow, ...overrides.row };
  const steps: Step[] = [[{ id: "n1" }], [row]];
  if (overrides.subs) steps.push(overrides.subs);
  steps.push((_op: Op, ops: Op[]) => {
    const written = noticeUpdates(ops).at(-1) ?? (row.changes as Record<string, unknown>);
    return [{ changes: written, householdId: "h1", receiptStatus: "pending_review", receiptHouseholdId: "h1" }];
  });
  steps.push([]);
  return scriptedDb(steps, { execute: () => [{ id: "n1" }] });
}

const revocations = (ops: Op[]) => ops.filter((op) => op.kind === "update" && op.table === pushSubscriptions);

let logged: unknown[][];

beforeEach(() => {
  meta.household = { state: "ok", value: "Receipt title" };
  meta.address = { state: "ok", value: "member@example.test" };
  meta.keyed = true;
  vi.restoreAllMocks();
  logged = [];
  for (const level of ["error", "warn", "info", "debug"] as const) {
    vi.spyOn(log, level).mockImplementation(((...args: unknown[]) => { logged.push([level, ...args]); }) as never);
  }
});

/*
 * #1943 A-R4 (ruling note 68569) reverses item 6: a blocked resolver answer
 * reflects the network, not the push service (RFC 8030 section 7.3), so the
 * approval notice's revoked list leaves it out and it counts as transient
 * under the existing bounded retry. Only a 404/410 (or 401/403) revokes.
 */
describe("#1929 part 2: a blocked push address in the approval notice", () => {
  it("item 6 (flipped by #1943 A-R4): revokes nothing, delivers the next subscription and marks sent", async () => {
    const p = providers();
    p.sendPush.mockRejectedValueOnce(new BlockedPushEndpointError());
    const { db, ops } = notice({ row: { userEmailEnabled: false }, subs: [subA, subB] });
    await deliverApprovalNotices(db, config, NOW, p as never, retryDelay);

    expect(p.sendPush).toHaveBeenCalledTimes(2);
    expect((p.sendPush.mock.calls[1]![0] as { target: { endpoint: string } }).target.endpoint).toBe(subB.endpoint);
    expect(revocations(ops)).toHaveLength(0);

    const recorded = noticeUpdates(ops)[1]!;
    expect(recorded).toMatchObject({ push: "sent", pushAttempts: 0, nextAttemptAt: null });
  });

  it("item 6 (flipped by #1943 A-R4): a blocked address on the only subscription is a transient failure: no revocation, a retry with pushAttempts + 1", async () => {
    const p = providers();
    p.sendPush.mockRejectedValue(new BlockedPushEndpointError());
    const { db, ops } = notice({ row: { userEmailEnabled: false }, subs: [subA] });
    await deliverApprovalNotices(db, config, NOW, p as never, retryDelay);
    expect(revocations(ops)).toHaveLength(0);
    const recorded = noticeUpdates(ops)[1]!;
    expect(recorded.push).toBe("pending");
    expect(recorded.pushAttempts).toBe(1);
    expect(recorded.nextAttemptAt).not.toBeNull();
  });

  it("#1943 A-R4: the push service's 410 still revokes the subscription", async () => {
    const p = providers();
    p.sendPush.mockRejectedValue(Object.assign(new Error("push subscription gone"), { statusCode: 410 }));
    const { db, ops } = notice({ row: { userEmailEnabled: false }, subs: [subA] });
    await deliverApprovalNotices(db, config, NOW, p as never, retryDelay);
    const revoked = revocations(ops);
    expect(revoked).toHaveLength(1);
    expect(render(revoked[0]!.args.where![0]).params).toContain(subA.id);
  });

  it("item 7: logs one warn line with the subscription id and push_endpoint_blocked, never the host or address", async () => {
    const p = providers();
    p.sendPush.mockRejectedValueOnce(new BlockedPushEndpointError());
    const { db, ops } = notice({ row: { userEmailEnabled: false }, subs: [subA, subB] });
    await deliverApprovalNotices(db, config, NOW, p as never, retryDelay);

    const warns = (log.warn as unknown as { mock: { calls: unknown[][] } }).mock.calls
      .filter((call) => JSON.stringify(call).includes("push_endpoint_blocked"));
    expect(warns).toHaveLength(1);
    expect(warns[0]![0]).toMatchObject({ reason: "push_endpoint_blocked" });
    expect(JSON.stringify(warns[0])).toContain(subA.id);

    const everything = JSON.stringify([logged, noticeUpdates(ops), revocations(ops).map((op) => op.args.set)]);
    expect(everything).not.toContain(BLOCKED_HOST);
    expect(everything).not.toContain("blocked-host");
    expect(everything).not.toContain(BLOCKED_ADDRESS);
    expect(everything).not.toContain(subA.endpoint);
  });

  it("item 10: an IP-literal endpoint never reaches providers.sendPush, and is revoked", async () => {
    const p = providers();
    const literal = { ...subA, id: "sub-literal", endpoint: "https://[::1]/abc" };
    const { db, ops } = notice({ row: { userEmailEnabled: false }, subs: [literal, subB] });
    await deliverApprovalNotices(db, config, NOW, p as never, retryDelay);
    expect(p.sendPush).toHaveBeenCalledTimes(1);
    expect((p.sendPush.mock.calls[0]![0] as { target: { endpoint: string } }).target.endpoint).toBe(subB.endpoint);
    expect(revocations(ops)).toHaveLength(1);
  });
});
