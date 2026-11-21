import { describe, expect, it } from "vitest";

/*
 * #1727 W-S1 (owner answer 116a, note 53804): the sender check row for a
 * verified sender whose last forward was unsigned reads
 *   checked · your last forward wasn't signed, so it wasn't kept · see why
 * and "see why" is a link to the inbox failure row for `sender_unsigned`.
 *
 * The inbox offers nothing to point at one row (no id, anchor or query it
 * reads: web/src/routes/inbox/+page.svelte), so per the note the link goes
 * to /inbox and that is recorded as a gap. A row that has expired or been
 * removed therefore needs no special case: /inbox always opens.
 *
 * The spec does not fix how checkRow carries the link, so these checks do not
 * assume a field name: the words before the link are `says`, and the link's
 * text and target are found anywhere else in what checkRow returns.
 */

const ADDRESS = "ned.harlow@example.test";
const verified = (/** @type {boolean | null} */ lastForwardSigned) =>
  ({ address: ADDRESS, verified: true, verificationPending: false, expiresAt: null, lastForwardSigned });

/** Every string reachable in a value, with the key path it sits under.
 * @param {unknown} value @param {string} [path] @returns {{ path: string, text: string }[]} */
function strings(value, path = "") {
  if (typeof value === "string") return [{ path, text: value }];
  if (value && typeof value === "object") {
    return Object.entries(value).flatMap(([key, one]) => strings(one, `${path}.${key}`));
  }
  return [];
}

describe("#1727 W-S1: the unsigned-forward row's words and link", () => {
  it("says the new words, then names the link", async () => {
    const { checkRow } = await import("../../web/src/routes/settings/mail/sender.js");
    const row = checkRow(verified(false));
    expect(row.says.startsWith("checked · your last forward wasn't signed, so it wasn't kept")).toBe(true);
    expect(row.says).not.toContain("but your last forward");
    expect(row.tone).toBe("warm");
    expect(row.button).toBeNull();
    /* The whole row, words then link text, reads as the owner's line. */
    const whole = strings(row).filter((one) => !one.path.endsWith(".tone")).map((one) => one.text);
    expect(whole.join(" · ").replace(/ · · /gu, " · ")).toContain("so it wasn't kept · see why");
  });

  it("the link is `see why` and it leads to /inbox", async () => {
    const { checkRow } = await import("../../web/src/routes/settings/mail/sender.js");
    const found = strings(checkRow(verified(false)));
    expect(found.some((one) => one.text === "see why"), "a `see why` link text").toBe(true);
    expect(found.some((one) => one.text === "/inbox"), "a link target of exactly /inbox").toBe(true);
  });

  it.each([
    ["signed", true],
    ["never checked", null],
  ])("when the last forward was %s the row is `checked` with no link", async (_name, lastForwardSigned) => {
    const { checkRow } = await import("../../web/src/routes/settings/mail/sender.js");
    const row = checkRow(verified(lastForwardSigned));
    expect(row).toEqual({ says: "checked", tone: "ok", button: null });
  });

  it("an address that is not checked never shows the link", async () => {
    const { checkRow } = await import("../../web/src/routes/settings/mail/sender.js");
    const row = checkRow({ address: ADDRESS, verified: false, verificationPending: false, expiresAt: null, lastForwardSigned: false });
    expect(strings(row).some((one) => one.text === "see why" || one.text === "/inbox")).toBe(false);
  });
});
