import { describe, expect, it } from "vitest";
import { relaySendersOf } from "@/server/mail-in/relay-settings";
import type { SenderAddressView } from "@/server/mail-in/sender-addresses";

/*
 * #1810 R1 and its review: the Settings read carries an extra row whose
 * stored address is damaged (`metadata_integrity_failed`), so the member can
 * see and remove it. A row that is only locked for now (the key is away) is
 * not shown: its check could only answer 503.
 */
const base: SenderAddressView = {
  id: "00000000-0000-4000-8000-000000000001",
  address: null,
  source: "manual",
  verified: false,
  verificationPending: false,
  expiresAt: null,
  lastForwardSigned: null,
  daysLeft: 9,
  heldMail: 0,
};

describe("1810 R1: relaySendersOf and unreadable extra rows", () => {
  it("passes a damaged extra row through with its id and metadataStatus", () => {
    const damaged = { ...base, metadataStatus: { address: "metadata_integrity_failed" as const } };

    expect(relaySendersOf([damaged])).toEqual([expect.objectContaining({
      id: damaged.id, address: null, metadataStatus: { address: "metadata_integrity_failed" },
    })]);
  });

  it("leaves out an extra row that is only metadata_locked", () => {
    expect(relaySendersOf([{ ...base, metadataStatus: { address: "metadata_locked" } }])).toEqual([]);
  });

  it("leaves out a damaged seeded row, which the registered address rebuilds", () => {
    expect(relaySendersOf([{ ...base, source: "account", metadataStatus: { address: "metadata_integrity_failed" } }])).toEqual([]);
  });
});
