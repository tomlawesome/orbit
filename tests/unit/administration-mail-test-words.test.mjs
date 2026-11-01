import { describe, expect, it } from "vitest";
import { testMetaOf, testVerdict } from "../../web/src/routes/administration/words.js";

/*
 * The administration screen's mail-test pill and reason (#1071), moved from the
 * browser half of tests/e2e/v19-administration.spec.ts (#1612, ADR-0039). The
 * server keeps the last answer (tests/integration/admin-operations-evidence.test.ts);
 * what the screen says about that answer is these two pure functions.
 */
describe("testVerdict: the pill word and reason for a mail test's bounded answer", () => {
  it("says passed, with no reason, for the answers that mean it worked", () => {
    for (const result of ["available", "ready"]) {
      expect(testVerdict(result)).toEqual({ word: "passed", tone: "ok", reason: "" });
    }
  });

  it("says checking while a test is already out", () => {
    for (const result of ["verification_pending", "retrying"]) {
      expect(testVerdict(result)).toMatchObject({ word: "checking", tone: "up" });
    }
  });

  it("says failed with the reason in words, for the relay's unconfigured answer too", () => {
    expect(testVerdict("smtp_unconfigured")).toEqual({
      word: "failed", tone: "over", reason: "no outgoing mail is configured",
    });
  });

  it("says an unknown answer plainly rather than hiding it", () => {
    expect(testVerdict("some_new_answer")).toEqual({ word: "failed", tone: "over", reason: "some new answer" });
  });
});

describe("testMetaOf: the line beside a mail test", () => {
  const probes = { mailbox: null, relay: { result: "smtp_unconfigured", at: "2026-11-01T10:00:00.000Z" } };

  it("is the last answer's reason after a reload, and 'not tested yet' for a test never run", () => {
    expect(testMetaOf("relay", null, probes)).toBe("no outgoing mail is configured");
    expect(testMetaOf("mailbox", null, probes)).toBe("not tested yet");
  });

  it("says checking now for the test that is out, whatever the last answer was", () => {
    expect(testMetaOf("relay", "relay", probes)).toBe("checking now");
    expect(testMetaOf("mailbox", "relay", probes)).toBe("not tested yet");
  });
});
