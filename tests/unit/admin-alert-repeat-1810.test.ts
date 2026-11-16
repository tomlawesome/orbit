/**
 * #1810 A-F8: the administrator alert's footer says the rule the code enforces,
 * per alert kind. The scanner alert is mailed once per 24 hours while one
 * outage stays open, and at most once an hour across recoveries (#1419); the
 * import-undo alert is 24 hours per fault. Both sentences appear in the HTML
 * footer and the text body. Same stand-ins as admin-alert-wording-1800.
 */
import { beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({ sendBoundedMail: vi.fn() }));

/* The administrator query is awaited at `.where()`; the claim's lookups
   (#1419 claim-before-send, inside a transaction under an advisory lock)
   continue to `.limit()` or `.orderBy().limit()` and find nothing. */
vi.mock("@/db", () => {
  const db = {
    select: () => ({
      from: () => ({
        where: () => ({
          limit: async () => [],
          orderBy: () => ({ limit: async () => [] }),
          then: (resolve: (rows: unknown[]) => void) => resolve([{ id: "admin-1", emailEnc: "x" }]),
        }),
      }),
    }),
    insert: () => ({ values: async () => undefined }),
    /* The claim takes over expired claims with delete ... returning (#1810 A-R2): none here. */
    delete: () => ({ where: () => Object.assign(Promise.resolve(undefined), { returning: async () => [] }) }),
    execute: async () => undefined,
    transaction: async (work: (transaction: unknown) => Promise<unknown>) => work(db),
  };
  return { getDb: () => db };
});
vi.mock("@/server/metadata/fields", () => ({
  openInstanceMetadataReader: async () => ({ locked: false, text: () => ({ value: "admin@harlow.example" }) }),
}));
vi.mock("@/server/invitations/send", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@/server/invitations/send")>()),
  sendBoundedMail: mocks.sendBoundedMail,
}));


const SCANNER_REPEAT = "Sent to every administrator. Orbit won’t repeat this within 24 hours while the scanner stays down, and never more than once an hour if it keeps dropping out.";
const IMPORT_REPEAT = "Sent to every administrator. Orbit won’t repeat this for the same fault within 24 hours.";

async function rendered(kind: "scanner_unavailable" | "import_undo_failed"): Promise<{ html: string; text: string }> {
  process.env.APP_URL = "https://orbit.harlow.example";
  mocks.sendBoundedMail.mockReset();
  mocks.sendBoundedMail.mockResolvedValue({ sentAt: new Date(), sendError: null });
  const { raiseAdminAlert } = await import("@/server/admin-alert");
  await raiseAdminAlert({ kind, faultKey: "f1", householdName: "Harlow", occurredAt: new Date("2026-11-07T14:05:00Z") });
  expect(mocks.sendBoundedMail).toHaveBeenCalledTimes(1);
  return mocks.sendBoundedMail.mock.calls[0][1];
}

describe("the alert footer says the rule for its kind (#1810 A-F8)", () => {
  beforeEach(() => vi.resetModules());

  it("scanner_unavailable html: the scanner sentence, not the per-fault one", async () => {
    const { html } = await rendered("scanner_unavailable");
    expect(html).toContain(SCANNER_REPEAT);
    expect(html).not.toContain("for the same fault within 24 hours");
  });

  it("scanner_unavailable text: the scanner sentence, not the per-fault one", async () => {
    const { text } = await rendered("scanner_unavailable");
    expect(text).toContain(SCANNER_REPEAT);
    expect(text).not.toContain("for the same fault within 24 hours");
  });

  it("import_undo_failed html: the import sentence, never 'once an hour'", async () => {
    const { html } = await rendered("import_undo_failed");
    expect(html).toContain(IMPORT_REPEAT);
    expect(html).not.toContain("once an hour");
  });

  it("import_undo_failed text: the import sentence, never 'once an hour'", async () => {
    const { text } = await rendered("import_undo_failed");
    expect(text).toContain(IMPORT_REPEAT);
    expect(text).not.toContain("once an hour");
  });
});
