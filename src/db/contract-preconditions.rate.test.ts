import { describe, expect, it } from "vitest";

import * as backfill from "@/server/document-maintenance/content-index-backfill";
import * as worker from "@/server/document-worker";

import { CONTRACT_PRECONDITIONS } from "./contract-preconditions";

// #1874 A-F4: the update-preflight remedy names how fast the running version
// seals documents. That rate must come from the backfill's own settings: the
// rows it takes a cycle (CONTENT_INDEX_BACKFILL_BATCH_SIZE) and the wait
// between cycles (DOCUMENT_WORKER_POLL_MS), both exported by their modules so
// the remedy text can be derived from them rather than typed in.
describe("#1874 A-F4 the preflight remedy's backfill rate", () => {
  it("states the rate the batch size and tick interval give", () => {
    const batch = (backfill as Record<string, unknown>).CONTENT_INDEX_BACKFILL_BATCH_SIZE;
    const tickMs = (worker as Record<string, unknown>).DOCUMENT_WORKER_POLL_MS;
    expect(batch).toEqual(expect.any(Number));
    expect(tickMs).toEqual(expect.any(Number));
    const perMinute = Math.round((batch as number) * (60_000 / (tickMs as number)));
    const entry = CONTRACT_PRECONDITIONS.find((p) => p.column === "documents.content_sha256");
    expect(entry).toBeDefined();
    expect(entry!.remedy.join("\n")).toContain(`about ${perMinute} documents a minute`);
  });
});
