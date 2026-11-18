import { beforeEach, describe, expect, it, vi } from "vitest";

/**
 * A setup link is tied to the address it was mailed to (#1869): the blind
 * index read before the send is handed to `persistSetupToken`, which refuses
 * the write if an administrator set a new address meanwhile. Both senders
 * (a resend, and creating an account) must read the account back as stored
 * and pass that index, and a vanished account is a 404, not a send.
 */

const state = vi.hoisted(() => ({
  selectRows: [] as unknown[],
  persist: vi.fn(),
  create: vi.fn(),
  send: vi.fn(),
  audit: [] as Array<Record<string, unknown>>,
}));

vi.mock("@/db", () => {
  const select = () => {
    const self: Record<string, unknown> = {};
    for (const name of ["from", "leftJoin", "where", "limit"]) self[name] = () => self;
    self.then = (resolve: (value: unknown) => unknown, reject: (reason: unknown) => unknown) =>
      Promise.resolve(state.selectRows).then(resolve, reject);
    return self;
  };
  const insert = () => ({ values: async (values: Record<string, unknown>) => { state.audit.push(values); } });
  return { getDb: () => ({ select, insert }) };
});

vi.mock("@/server/metadata/fields", () => ({
  openInstanceMetadataReader: async () => ({
    text: (_field: string, _id: string, input: { encrypted: string | null }) =>
      input.encrypted === null
        ? { value: null, state: "metadata_unreadable" }
        : { value: `${input.encrypted}@example.invalid`, state: undefined },
  }),
}));

vi.mock("@/server/invitations/send", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@/server/invitations/send")>()),
  sendBoundedMail: state.send,
}));

vi.mock("@/server/local-credentials", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@/server/local-credentials")>()),
  createLocalUser: state.create,
  mintSetupToken: (purpose: string) => ({
    token: "tok",
    tokenHash: "hash",
    purpose,
    expiresAt: new Date("2026-11-25T00:00:00.000Z"),
  }),
  persistSetupToken: state.persist,
}));

import { createLocalUserAndSendSetupLink, sendSetupLink } from "./setup-mail";

const ADMIN = "11111111-1111-4111-8111-111111111111";
const USER = "22222222-2222-4222-8222-222222222222";
const stored = (over: Record<string, unknown> = {}) => ({
  id: USER, emailEnc: "ada", emailIndex: "idx-1", displayName: "Ada Lovelace", credential: null, ...over,
});

beforeEach(() => {
  state.selectRows = [];
  state.audit = [];
  state.persist.mockReset();
  state.persist.mockResolvedValue(true);
  state.create.mockReset();
  state.create.mockResolvedValue({ id: USER, email: "ada@example.invalid", displayName: "Ada Lovelace" });
  state.send.mockReset();
  state.send.mockResolvedValue({ sentAt: new Date(), sendError: null });
  process.env.APP_URL = "https://orbit.example";
});

describe("sendSetupLink ties the link to the address it was mailed to", () => {
  it("mails the stored address and writes the link only against the index it read", async () => {
    state.selectRows = [stored()];
    const delivery = await sendSetupLink(ADMIN, USER, { mailer: null });
    expect(state.send.mock.calls[0][0]).toBe("ada@example.invalid");
    expect(state.persist).toHaveBeenCalledWith(USER, expect.anything(), ADMIN, {
      onlyIfNoLiveLink: false,
      sentToAddressIndex: "idx-1",
    });
    expect(delivery.sentTo).toBe("ada@example.invalid");
    expect(delivery.sendError).toBeNull();
    expect(state.audit.map((row) => row.action)).toEqual(["setup_link_sent"]);
  });

  it("passes a null index through as null, which is a condition and not an absent one", async () => {
    state.selectRows = [stored({ emailIndex: null })];
    await sendSetupLink(ADMIN, USER);
    expect(state.persist.mock.calls[0][3].sentToAddressIndex).toBeNull();
  });

  it("sends a recovery link to an account that already has a password, and a setup link to one that has none", async () => {
    state.selectRows = [stored({ credential: USER })];
    await sendSetupLink(ADMIN, USER);
    expect(state.send.mock.calls[0][1].subject).toBe("Reset your Orbit password");
    state.selectRows = [stored()];
    await sendSetupLink(ADMIN, USER);
    expect(state.send.mock.calls[1][1].subject).toBe("Set your Orbit password");
  });

  it("answers 404 for an account that is gone, mailing and writing nothing", async () => {
    await expect(sendSetupLink(ADMIN, USER)).rejects.toMatchObject({ code: "user_not_found", status: 404 });
    expect(state.send).not.toHaveBeenCalled();
    expect(state.persist).not.toHaveBeenCalled();
  });

  it("refuses an unreadable address before minting or mailing anything", async () => {
    state.selectRows = [stored({ emailEnc: null })];
    await expect(sendSetupLink(ADMIN, USER)).rejects.toMatchObject({ code: "recipient_address_unreadable", status: 409 });
    expect(state.send).not.toHaveBeenCalled();
    expect(state.persist).not.toHaveBeenCalled();
  });

  it("surfaces an address that changed during the send as the refusal, after the mail has been recorded", async () => {
    state.selectRows = [stored()];
    const { AppError } = await import("@/lib/errors");
    state.persist.mockRejectedValue(new AppError("address_changed", "changed", 409));
    await expect(sendSetupLink(ADMIN, USER)).rejects.toMatchObject({ code: "address_changed", status: 409 });
    expect(state.audit.map((row) => row.action)).toEqual(["setup_link_sent"]);
  });
});

describe("createLocalUserAndSendSetupLink", () => {
  it("reads the new account back as stored and mails it a setup link tied to its index", async () => {
    state.selectRows = [stored()];
    const created = await createLocalUserAndSendSetupLink(ADMIN, { email: "ada@example.invalid", displayName: "Ada Lovelace" });
    expect(state.create).toHaveBeenCalledWith(
      { email: "ada@example.invalid", displayName: "Ada Lovelace" },
      { createdByUserId: ADMIN },
    );
    expect(created.user.id).toBe(USER);
    expect(created.sentTo).toBe("ada@example.invalid");
    expect(state.persist.mock.calls[0][3]).toMatchObject({ sentToAddressIndex: "idx-1" });
  });

  it("refuses a mistyped lifetime before an account is created", async () => {
    await expect(
      createLocalUserAndSendSetupLink(ADMIN, { email: "a@example.invalid", displayName: "A" }, { expiresInDays: 99 }),
    ).rejects.toBeDefined();
    expect(state.create).not.toHaveBeenCalled();
  });
});
