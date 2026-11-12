import { describe, expect, it } from "vitest";

import { extraRow } from "../../web/src/routes/settings/mail/sender.js";

/*
 * #1810 W-F10: the server clamps an unchecked row's days left to 0 in the gap
 * before the sweep removes it, so the Settings row must never promise
 * "removed in 0 days" (the inbox's held line says 1 at the least).
 */
const row = (daysLeft) => ({
  id: "r1", address: "a@post.example", source: "manual", verified: false,
  verificationPending: false, expiresAt: null, lastForwardSigned: null, daysLeft,
});

describe("W-F10: the extra row's days left", () => {
  it.each([0, -1])("never says 0 or fewer days when the server answers %i", (daysLeft) => {
    const { says } = extraRow(/** @type {any} */ (row(daysLeft)));
    expect(says).toBe("unchecked · removed in 1 day");
  });

  it("still counts honest days above the floor", () => {
    expect(extraRow(/** @type {any} */ (row(1))).says).toBe("unchecked · removed in 1 day");
    expect(extraRow(/** @type {any} */ (row(9))).says).toBe("unchecked · removed in 9 days");
  });
});
