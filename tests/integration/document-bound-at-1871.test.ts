import { randomUUID } from "node:crypto";
import { and, eq, sql } from "drizzle-orm";
import { afterAll, afterEach, describe, expect, it, vi } from "vitest";
import { getDb } from "@/db";
import { documentJobs, documents, items } from "@/db/schema";
import { AppError } from "@/lib/app-error";
import { requestDocumentDeletion } from "@/server/document-repository";
import { reconcileDocumentStorage } from "@/server/document-worker";
import { scanFileWithClamAv } from "@/server/documents/scanner";
import { cleanupIntegrationEnvironment, createIntegrationFixture } from "./support/fixtures";
import { callRouteForSession, loadRoute } from "./support/request-event";
import { syntheticPdf } from "../support/synthetic-documents";

/* #1871: `documents.bound_at` (nullable timestamptz) records when an item
   claimed a document. Null = a staged upload no item has claimed. Written
   from the decision note alone. The column is read with raw SQL so a missing
   column fails here as a plain error. */

const { DELETE: deleteDocument } = await loadRoute("documents/[documentId]");
const { POST: restoreRoute } = await loadRoute("documents/[documentId]/restore");
const { POST: stageRoute } = await loadRoute("households/[householdId]/documents");
const { POST: uploadRoute } = await loadRoute("households/[householdId]/items/[itemId]/documents");
const { POST: workspaceCommand } = await loadRoute("workspace/commands");

vi.mock("@/server/documents/scanner", async (importOriginal) => ({
  ...await importOriginal<typeof import("@/server/documents/scanner")>(),
  scanFileWithClamAv: vi.fn(),
}));

afterAll(async () => {
  await cleanupIntegrationEnvironment();
});

afterEach(() => {
  vi.mocked(scanFileWithClamAv).mockReset();
  vi.mocked(scanFileWithClamAv).mockResolvedValue({ status: "clean" });
});

type Fixture = Awaited<ReturnType<typeof createIntegrationFixture>>;
type Session = Awaited<ReturnType<Fixture["session"]>>;

async function stage(fixture: Fixture, session: Session, label: string) {
  const body = Buffer.from(syntheticPdf(label));
  const documentId = randomUUID();
  const response = await callRouteForSession(stageRoute, session, {
    url: `http://127.0.0.1:3000/api/households/${fixture.household.id}/documents`,
    method: "POST",
    headers: {
      "content-length": String(body.length),
      "content-type": "application/pdf",
      "x-orbit-filename": encodeURIComponent(`${label}.pdf`),
      "x-orbit-document-id": documentId,
      "x-orbit-item-id": randomUUID(),
    },
    body: new Uint8Array(body),
    params: { householdId: fixture.household.id },
  });
  expect(response.status).toBe(201);
  return documentId;
}

async function uploadToItem(fixture: Fixture, session: Session, label: string) {
  const body = Buffer.from(syntheticPdf(label));
  const response = await callRouteForSession(uploadRoute, session, {
    url: `http://127.0.0.1:3000/api/households/${fixture.household.id}/items/${fixture.item.id}/documents`,
    method: "POST",
    headers: {
      "content-length": String(body.length),
      "content-type": "application/pdf",
      "x-orbit-filename": encodeURIComponent(`${label}.pdf`),
    },
    body: new Uint8Array(body),
    params: { householdId: fixture.household.id, itemId: fixture.item.id },
  });
  expect(response.status).toBe(201);
  return ((await response.json()) as { document: { id: string } }).document.id;
}

async function row(id: string) {
  const rows = await getDb().execute(sql`
    select bound_at, delete_after, item_id, lifecycle from documents where id = ${id}`);
  return rows[0] as { bound_at: Date | null; delete_after: Date | null; item_id: string | null; lifecycle: string };
}

async function stagedHoldMs(documentId: string, sinceBefore: number, sinceAfter: number) {
  const { delete_after } = await row(documentId);
  expect(delete_after).not.toBeNull();
  return { low: new Date(delete_after!).getTime() - sinceAfter, high: new Date(delete_after!).getTime() - sinceBefore };
}

const del = (session: Session, id: string) => callRouteForSession(deleteDocument, session, {
  url: `http://127.0.0.1:3000/api/documents/${id}`, method: "DELETE", params: { documentId: id },
});
const restore = (session: Session, id: string) => callRouteForSession(restoreRoute, session, {
  url: `http://127.0.0.1:3000/api/documents/${id}/restore`, method: "POST", params: { documentId: id },
});

describe("storing a document sets bound_at by where it went (#1871)", () => {
  it("a staged upload has bound_at null and a staged hold in delete_after", async () => {
    // Catches a store path that marks every upload bound (the sweep would never retire an abandoned staged pick).
    const fixture = await createIntegrationFixture("b1871-stage");
    const member = await fixture.session("member");
    const id = await stage(fixture, member, "b1871 stage");
    const state = await row(id);
    expect(state.bound_at).toBeNull();
    expect(state.item_id).toBeNull();
    expect(new Date(state.delete_after!).getTime()).toBeGreaterThan(Date.now());
  });

  it("a direct upload to an item has bound_at about now and delete_after null", async () => {
    // Catches a direct upload left unbound: a later item deletion plus restore would then give it a staged hold.
    const fixture = await createIntegrationFixture("b1871-direct");
    const member = await fixture.session("member");
    const before = Date.now() - 2_000;
    const id = await uploadToItem(fixture, member, "b1871 direct");
    const state = await row(id);
    expect(state.item_id).toBe(fixture.item.id);
    expect(state.delete_after).toBeNull();
    expect(state.bound_at, "bound_at set at insert").not.toBeNull();
    expect(new Date(state.bound_at!).getTime()).toBeGreaterThanOrEqual(before);
    expect(new Date(state.bound_at!).getTime()).toBeLessThanOrEqual(Date.now() + 2_000);
  });
});

describe("binding sets bound_at in the same update that clears the hold (#1871)", () => {
  it("saving an item with documentIds binds a staged upload: bound_at about now, delete_after null", async () => {
    // Catches the item-save bind that clears delete_after but leaves bound_at null.
    const fixture = await createIntegrationFixture("b1871-bind-save");
    const owner = await fixture.session("owner");
    const id = await stage(fixture, owner, "b1871 bind save");
    expect((await row(id)).bound_at).toBeNull();
    const itemId = randomUUID();
    // The staged copy was sealed under a draft item id; reuse the id it was staged with.
    const sealed = (await getDb().execute(sql`select sealed_item_id from documents where id = ${id}`))[0] as { sealed_item_id: string };
    const before = Date.now() - 2_000;
    const response = await callRouteForSession(workspaceCommand, owner, {
      url: "http://127.0.0.1:3000/api/workspace/commands",
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        type: "item.upsert",
        householdId: fixture.household.id,
        item: { id: sealed.sealed_item_id ?? itemId, sectionId: fixture.section.id, title: "Boiler cover", currency: "GBP", dueDate: "2026-11-02", recurrenceMonths: 12, importance: "normal" },
        documentIds: [id],
      }),
    });
    expect(response.status).toBe(200);
    const state = await row(id);
    expect(state.item_id).not.toBeNull();
    expect(state.delete_after).toBeNull();
    expect(state.bound_at).not.toBeNull();
    expect(new Date(state.bound_at!).getTime()).toBeGreaterThanOrEqual(before);
    expect(new Date(state.bound_at!).getTime()).toBeLessThanOrEqual(Date.now() + 2_000);
  });
});

describe("a later item save does not move bound_at on a document that is already bound (#1871 review)", () => {
  it("keeps the original bound_at when the item is saved again with the same documentIds", async () => {
    // Catches the item-save bind overwriting bound_at with now() on every save.
    const fixture = await createIntegrationFixture("b1871-bind-keep");
    const owner = await fixture.session("owner");
    const id = await stage(fixture, owner, "b1871 bind keep");
    const sealed = (await getDb().execute(sql`select sealed_item_id from documents where id = ${id}`))[0] as { sealed_item_id: string };
    const save = (version?: number) => callRouteForSession(workspaceCommand, owner, {
      url: "http://127.0.0.1:3000/api/workspace/commands",
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        type: "item.upsert",
        householdId: fixture.household.id,
        item: { id: sealed.sealed_item_id, sectionId: fixture.section.id, title: "Boiler cover", currency: "GBP", dueDate: "2026-11-02", recurrenceMonths: 12, importance: "normal", ...(version ? { version } : {}) },
        documentIds: [id],
      }),
    });
    expect((await save()).status).toBe(200);
    const original = new Date(new Date().getTime() - 7 * 86_400_000);
    await getDb().execute(sql`update documents set bound_at = ${original.toISOString()}::timestamptz where id = ${id}`);
    expect((await save(2)).status).toBe(200);
    const state = await row(id);
    expect(new Date(state.bound_at!).getTime()).toBe(original.getTime());
  });
});

describe("the stagedDiscard guard reads 'still a staged upload' as item_id null and bound_at null (#1871)", () => {
  it("refuses a kept document whose item is gone even while it carries a delete_after, and leaves it available", async () => {
    // Catches the old guard (item_id null and delete_after set): it would discard a kept paper straight to the purge.
    const fixture = await createIntegrationFixture("b1871-guard-kept");
    const member = await fixture.session("member");
    const id = await uploadToItem(fixture, member, "b1871 guard kept");
    await getDb().delete(items).where(eq(items.id, fixture.item.id));
    await getDb().execute(sql`update documents set delete_after = now() + interval '1 day' where id = ${id}`);
    const before = await row(id);
    expect(before).toMatchObject({ item_id: null, lifecycle: "available" });
    expect(before.bound_at).not.toBeNull();

    const error = await requestDocumentDeletion(fixture.users.member.id, id, { stagedDiscard: true }).catch((e: unknown) => e);
    expect(error).toBeInstanceOf(AppError);
    expect((error as AppError).status).toBe(409);
    expect((await row(id)).lifecycle).toBe("available");
  });

  it("still discards a real staged upload with stagedDiscard (the guard's other side)", async () => {
    // Pairs with the refusal above: shows the guard lets the Add form's own discard through.
    const fixture = await createIntegrationFixture("b1871-guard-staged");
    const member = await fixture.session("member");
    const id = await stage(fixture, member, "b1871 guard staged");
    await requestDocumentDeletion(fixture.users.member.id, id, { stagedDiscard: true });
    expect((await row(id)).lifecycle).toBe("pending_deletion");
  });
});

describe("restoreDocument decides the hold from bound_at (#1871)", () => {
  it("a staged upload (bound_at null) comes back with a fresh staged hold counted from the restore, still unbound", async () => {
    // Catches a restore that keeps the retention-window date or none: the sweep could not retire an upload no item claims.
    const fixture = await createIntegrationFixture("b1871-restore-staged");
    const member = await fixture.session("member");
    const stagedAt = Date.now();
    const id = await stage(fixture, member, "b1871 restore staged");
    const hold = await stagedHoldMs(id, stagedAt - 5_000, Date.now() + 5_000);
    expect((await del(member, id)).status).toBe(200);

    const t0 = Date.now();
    expect((await restore(member, id)).status).toBe(200);
    const t1 = Date.now();
    const state = await row(id);
    expect(state).toMatchObject({ lifecycle: "available", item_id: null, bound_at: null });
    // Fresh hold: restore time + the same hold the stage gave (stage-time measurement band), with 5 s slack.
    expect(new Date(state.delete_after!).getTime()).toBeGreaterThanOrEqual(t0 + hold.low - 5_000);
    expect(new Date(state.delete_after!).getTime()).toBeLessThanOrEqual(t1 + hold.high + 5_000);
  });

  it("a kept orphan (item_id null, bound_at set) comes back available with delete_after null, and the sweep leaves it", async () => {
    // Catches a restore that gives an orphaned kept paper a staged hold, which the staged sweep then purges.
    const fixture = await createIntegrationFixture("b1871-restore-kept");
    const member = await fixture.session("member");
    const id = await uploadToItem(fixture, member, "b1871 restore kept");
    // No user path deletes an item today; the orphan is made by hand (item_id set null by the foreign key).
    await getDb().delete(items).where(eq(items.id, fixture.item.id));
    const before = await row(id);
    expect(before.item_id).toBeNull();
    expect(before.bound_at).not.toBeNull();

    expect((await del(member, id)).status).toBe(200);
    expect((await restore(member, id)).status).toBe(200);
    const state = await row(id);
    expect(state).toMatchObject({ lifecycle: "available", item_id: null, delete_after: null });
    expect(state.bound_at).not.toBeNull();

    await reconcileDocumentStorage();
    expect((await row(id)).lifecycle).toBe("available");
  });
});

describe("the staged sweep retires only unclaimed uploads (bound_at is null) (#1871)", () => {
  it("retires an expired unbound upload but never a bound document of the same shape", async () => {
    // Catches a sweep without `bound_at is null`: a kept document with an expired delete_after would be purged.
    const fixture = await createIntegrationFixture("b1871-sweep");
    const member = await fixture.session("member");
    const staged = await stage(fixture, member, "b1871 sweep staged");
    const kept = await stage(fixture, member, "b1871 sweep kept");
    // Same shape in both rows: item_id null, available, delete_after in the past. Only bound_at differs.
    await getDb().execute(sql`update documents set delete_after = now() - interval '1 minute' where id in (${staged}, ${kept})`);
    await getDb().execute(sql`update documents set bound_at = now() - interval '1 day' where id = ${kept}`);

    await reconcileDocumentStorage();

    const purgeJobs = async (id: string) =>
      (await getDb().select({ id: documentJobs.id }).from(documentJobs).where(and(eq(documentJobs.documentId, id), eq(documentJobs.kind, "purge")))).length;
    // The control: the unclaimed upload is retired, so the sweep demonstrably ran and can act on this shape.
    expect((await row(staged)).lifecycle).toBe("pending_deletion");
    expect(await purgeJobs(staged)).toBe(1);
    expect((await row(kept)).lifecycle).toBe("available");
    expect(await purgeJobs(kept)).toBe(0);
  });
});
