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

    expect(toPublicDocumentHealth({ ...unsafe, worker: { ...unsafe.worker, lastErrorCode: "maintenance_cycle_failed" } }).worker.lastErrorCode).toBe("maintenance_cycle_failed");
    expect(toPublicDocumentHealth({ ...unsafe, worker: { ...unsafe.worker, lastErrorCode: null } }).worker.lastErrorCode).toBeNull();
  });
});
