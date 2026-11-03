import { readFileSync } from "node:fs";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { testMetaOf, testVerdict, tellsOf } from "../../web/src/routes/administration/words.js";

/*
 * #1627: "relay" means the INBOUND plus-addresses members forward to. Outbound
 * SMTP is "outgoing mail", everywhere an administrator reads it.
 */
const DIR = path.resolve(import.meta.dirname, "../../web/src/routes/administration");
const source = (file) => readFileSync(path.join(DIR, file), "utf8");

describe("outbound SMTP is called outgoing mail (#1627)", () => {
  it("the smtp_* reasons say outgoing mail", () => {
    expect(testVerdict("smtp_rejected").reason).toBe("the outgoing mail server refused the sign-in");
    expect(testVerdict("smtp_unavailable").reason).toBe("the outgoing mail server couldn’t be reached");
    expect(testVerdict("smtp_unconfigured").reason).toBe("no outgoing mail is configured");
  });

  it("no smtp_* reason, test line or page-head tell uses the word relay", () => {
    for (const result of ["smtp_rejected", "smtp_unavailable", "smtp_unconfigured"]) {
      expect(testVerdict(result).reason, result).not.toMatch(/relay/iu);
      const probes = { mailbox: null, relay: { result, at: "2026-11-01T10:00:00.000Z" } };
      expect(testMetaOf("relay", null, probes), result).not.toMatch(/relay/iu);
    }
    const view = { operations: { mailProbes: { mailbox: null, relay: { result: "smtp_unavailable", at: "2026-11-01T10:00:00.000Z" } } }, mailbox: null };
    const tells = tellsOf(/** @type {any} */ (view), []).map((tell) => tell.text);
    expect(tells.length).toBeGreaterThan(0);
    expect(tells.join(" | ")).toMatch(/outgoing mail/u);
    expect(tells.join(" | ")).not.toMatch(/relay/iu);
  });

  it("the screens no longer call the SMTP test or its failure a relay", () => {
    for (const file of ["+page.svelte", "pocket.svelte", "words.js"]) {
      const text = source(file);
      expect(text, file).not.toMatch(/relay test/u);
      expect(text, file).not.toMatch(/test the relay/u);
      expect(text, file).not.toMatch(/the relay (?:refused|couldn’t|couldn't)/u);
      expect(text, file).not.toMatch(/relay failed/u);
    }
    expect(source("+page.svelte")).toMatch(/outgoing mail test/u);
  });
});
