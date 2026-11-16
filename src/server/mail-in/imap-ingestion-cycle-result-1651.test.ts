import { describe, expect, it } from "vitest";

import * as ingestion from "./imap-ingestion";
import { testImapConfig } from "../../../tests/support/imap-config";

/*
 * #1651: "fetch now" needs the cycle to say what it did. Names are the
 * tests' choice: `runImapIngestionCycle` answers
 * `{ messagesRead, receiptsRecorded, reasons }` (reasons: sender_unverified,
 * unattributed, held, provider_unavailable, the words the `imap.ingestion`
 * log event already carries), and the worker exports the two seams the
 * handler uses: `isImapIngestionCycleRunning()` and `runImapIngestionNow()`.
 */
describe("the ingestion cycle's result (#1651)", () => {
  it("answers zero counts, and touches nothing, when ingest is off", async () => {
    const result = await ingestion.runImapIngestionCycle(testImapConfig({ enabled: false }));
    expect(result).toMatchObject({
      messagesRead: 0,
      receiptsRecorded: 0,
      reasons: { sender_unverified: 0, unattributed: 0, held: 0, provider_unavailable: 0 },
    });
  });

  it("exposes whether a check is running, and the worker's own run-now path (#1651 review 1)", () => {
    expect(typeof (ingestion as Record<string, unknown>).isImapIngestionCycleRunning).toBe("function");
    expect(typeof (ingestion as Record<string, unknown>).runImapIngestionNow).toBe("function");
    expect((ingestion as unknown as { isImapIngestionCycleRunning: () => boolean }).isImapIngestionCycleRunning()).toBe(false);
  });
});
