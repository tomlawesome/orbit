import { describe, expect, it } from "vitest";
import { toPublicDocumentHealth, type DocumentHealth } from "./document-health";

describe("administrator document-health redaction", () => {
  it("does not expose encryption key identifiers", () => {
    const unsafe = {
      overall: "healthy",
      encryption: { status: "ready", keyId: "synthetic-key-id" },
      storage: { status: "ready" },
      scanner: { status: "disabled", mode: "disabled" },
      modelExtraction: { status: "ready", reason: "answering", recent: { samples: 4, failures: 1, timeouts: 1 }, rawModelSecret: "synthetic-model-secret" },
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
    expect(publicHealth.modelExtraction).toEqual({ status: "ready", reason: "answering", recent: { samples: 4, failures: 1, timeouts: 1 } });
    expect(JSON.stringify(publicHealth)).not.toContain("synthetic-model-secret");

    // An entry with nothing recognisable in it reports an honest unknown
    // rather than inventing a state for the administrator.
    const unknownModel = toPublicDocumentHealth({ ...unsafe, modelExtraction: { status: "invented", reason: "synthetic-model-reason" } } as unknown as DocumentHealth);
    expect(unknownModel.modelExtraction).toEqual({ status: "unavailable", reason: "unknown", recent: { samples: 0, failures: 0, timeouts: 0 } });
    expect(JSON.stringify(unknownModel)).not.toContain("synthetic-model-reason");

    expect(toPublicDocumentHealth({ ...unsafe, worker: { ...unsafe.worker, lastErrorCode: "maintenance_cycle_failed" } }).worker.lastErrorCode).toBe("maintenance_cycle_failed");
    expect(toPublicDocumentHealth({ ...unsafe, worker: { ...unsafe.worker, lastErrorCode: null } }).worker.lastErrorCode).toBeNull();
  });
});
