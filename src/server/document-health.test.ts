import { describe, expect, it } from "vitest";
import { toPublicDocumentHealth, type DocumentHealth } from "./document-health";

describe("administrator document-health redaction", () => {
  it("does not expose encryption key identifiers", () => {
    const unsafe = {
      overall: "healthy",
      encryption: { status: "ready", keyId: "synthetic-key-id" },
      storage: { status: "ready" },
      scanner: { status: "disabled", mode: "disabled" },
      quota: { usedBytes: 128, limitBytes: 1024 },
      worker: { started: true, running: false, lastSuccessAt: null, lastErrorAt: null, lastErrorCode: "synthetic-worker-secret", lastReconciliationAt: null, rawWorkerSecret: "synthetic-worker-secret" },
      rawTopLevelSecret: "synthetic-top-level-secret",
    } as unknown as DocumentHealth;

    const publicHealth = toPublicDocumentHealth(unsafe);
    expect(publicHealth.encryption).toEqual({ status: "ready" });
    expect(publicHealth.worker.lastErrorCode).toBe("unknown");
    expect(JSON.stringify(publicHealth)).not.toContain("synthetic-key-id");
    expect(JSON.stringify(publicHealth)).not.toContain("synthetic-worker-secret");
    expect(JSON.stringify(publicHealth)).not.toContain("synthetic-top-level-secret");
    expect(publicHealth.scanRecovery).toEqual({ retrying: 0, failed: 0, purgePending: 0, nextExpiryAt: null });

    expect(toPublicDocumentHealth({ ...unsafe, worker: { ...unsafe.worker, lastErrorCode: "maintenance_cycle_failed" } }).worker.lastErrorCode).toBe("maintenance_cycle_failed");
    expect(toPublicDocumentHealth({ ...unsafe, worker: { ...unsafe.worker, lastErrorCode: null } }).worker.lastErrorCode).toBeNull();
  });

  /* #941: the Tier 1 counts join the same bounded projection. They are the
     aggregate an administrator needs -- "a key is missing and this much is
     waiting" -- and nothing that would say WHOSE note or WHICH row, because
     per-occurrence detail belongs in the administrator diagnostics. */
  it("projects the Tier 1 metadata counts and nothing that identifies a value", () => {
    const unsafe = {
      overall: "degraded",
      encryption: { status: "unavailable" },
      storage: { status: "ready" },
      scanner: { status: "disabled", mode: "disabled" },
      quota: { usedBytes: 0, limitBytes: 0 },
      worker: { started: true, running: false, lastSuccessAt: null, lastErrorAt: null, lastErrorCode: null, lastReconciliationAt: null },
      scanRecovery: { retrying: 0, failed: 0, purgePending: 0, nextExpiryAt: null },
      metadata: {
        locked: true,
        lockedItems: 12,
        lockedReceipts: 3,
        damagedValues: 2,
        damagedItems: 1,
        damagedReceipts: 1,
        damagedRows: [{ table: "items", column: "notes", rowId: "synthetic-row-id", householdId: "synthetic-household-id" }],
      },
    } as unknown as DocumentHealth;

    const publicHealth = toPublicDocumentHealth(unsafe);
    expect(publicHealth.metadata).toEqual({
      locked: true,
      lockedItems: 12,
      lockedReceipts: 3,
      damagedValues: 2,
      damagedItems: 1,
      damagedReceipts: 1,
    });
    expect(JSON.stringify(publicHealth)).not.toContain("synthetic-row-id");
    expect(JSON.stringify(publicHealth)).not.toContain("synthetic-household-id");
  });

  it("answers zeroes rather than undefined when a health read could not reach the section", () => {
    const partial = {
      overall: "degraded",
      encryption: { status: "unavailable" },
      storage: { status: "unavailable" },
      scanner: { status: "unavailable", mode: "unknown" },
      quota: { usedBytes: 0, limitBytes: 0 },
      worker: { started: false, running: false, lastSuccessAt: null, lastErrorAt: null, lastErrorCode: null, lastReconciliationAt: null },
    } as unknown as DocumentHealth;
    expect(toPublicDocumentHealth(partial).metadata).toEqual({
      locked: false,
      lockedItems: 0,
      lockedReceipts: 0,
      damagedValues: 0,
      damagedItems: 0,
      damagedReceipts: 0,
    });
  });
});
