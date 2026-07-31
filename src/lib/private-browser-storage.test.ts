import { afterEach, describe, expect, it, vi } from "vitest";
import {
  LEGACY_WORKSPACE_DATABASE,
  purgeLegacyWorkspaceCache,
} from "@/lib/private-browser-storage";

function deletionRequest(outcome: "success" | "error" | "blocked"): IDBOpenDBRequest {
  const request = {
    error: outcome === "error" ? new Error("raw browser storage failure") : null,
    onblocked: null,
    onerror: null,
    onsuccess: null,
  } as unknown as IDBOpenDBRequest;
  queueMicrotask(() => {
    if (outcome === "success") request.onsuccess?.(new Event("success"));
    if (outcome === "error") request.onerror?.(new Event("error"));
    if (outcome === "blocked") request.onblocked?.(new Event("blocked") as IDBVersionChangeEvent);
  });
  return request;
}

describe("legacy private browser storage", () => {
  afterEach(() => vi.unstubAllGlobals());

  it("deletes the exact preview-build workspace database", async () => {
    const deleteDatabase = vi.fn(() => deletionRequest("success"));
    vi.stubGlobal("indexedDB", { deleteDatabase } as unknown as IDBFactory);

    await expect(purgeLegacyWorkspaceCache()).resolves.toBeUndefined();
    expect(deleteDatabase).toHaveBeenCalledWith(LEGACY_WORKSPACE_DATABASE);
  });

  it("is a no-op where IndexedDB is unavailable", async () => {
    vi.stubGlobal("indexedDB", undefined);
    await expect(purgeLegacyWorkspaceCache()).resolves.toBeUndefined();
  });

  it.each(["error", "blocked"] as const)("fails closed on a %s deletion", async (outcome) => {
    vi.stubGlobal("indexedDB", {
      deleteDatabase: () => deletionRequest(outcome),
    } as unknown as IDBFactory);

    await expect(purgeLegacyWorkspaceCache()).rejects.toThrow("Private browser data could not be cleared");
  });
});
