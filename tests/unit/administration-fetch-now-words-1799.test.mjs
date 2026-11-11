import { describe, expect, it } from "vitest";
import { fetchNowWords } from "../../web/src/routes/administration/words.js";

/*
 * #1799 L3: after "fetch now" the screen says only whether the check
 * succeeded or failed. No counts, no reason labels.
 */
const busy = { messagesRead: 7, receiptsRecorded: 3, reasons: { sender_unverified: 2, unattributed: 1, held: 4, provider_unavailable: 5 } };
const quiet = { messagesRead: 0, receiptsRecorded: 0, reasons: {} };

describe("fetchNowWords (#1799 L3)", () => {
  for (const [name, fetched] of [["busy counts", busy], ["zero counts", quiet], ["no counts", null], ["undefined counts", undefined]]) {
    it(`on success says checked and points to the inbox, with ${name}`, () => {
      const words = fetchNowWords("fetched", fetched);
      expect(words).toMatch(/checked/u);
      expect(words).toMatch(/inbox/iu);
    });
    it(`on success never shows counts or reason labels, with ${name}`, () => {
      const words = fetchNowWords("fetched", fetched);
      for (const banned of ["messages read", "receipts recorded", "sender unverified", "unattributed", "held", "provider unavailable"]) {
        expect(words).not.toContain(banned);
      }
      expect(words).not.toMatch(/\d/u);
    });
  }

  // Pins: failure outcomes keep their existing words.
  it("keeps the failure words (pin, unchanged behaviour)", () => {
    expect(fetchNowWords("already_running", null)).toBe("a check is already running");
    expect(fetchNowWords("paused", null)).toBe("ingest is paused");
    expect(fetchNowWords("not_configured", null)).toBe("no mailbox is set up yet");
    expect(fetchNowWords("credential_locked", null)).toBe("the mailbox password can't be opened");
    expect(fetchNowWords("provider_unavailable", busy)).toBe("provider unavailable · the mailbox could not be checked");
  });
  it("keeps not_checked with its reason (pin)", () => {
    expect(fetchNowWords("not_checked", { ...quiet, reason: "key_unavailable" })).toBe("not checked · the key isn't available");
    expect(fetchNowWords("not_checked", { ...quiet, reason: "dkim_dns_malformed" })).toBe("not checked · the DKIM DNS servers setting is malformed");
    expect(fetchNowWords("not_checked", { ...quiet, reason: "other" })).toBe("not checked · the check was skipped");
  });
});
