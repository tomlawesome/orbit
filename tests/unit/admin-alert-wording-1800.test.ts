/**
 * #1800: the `import_undo_failed` administrator alert tells the truth about the
 * undo. Orbit retries it every fifteen minutes, and until it succeeds the
 * household stays closed to other members. No restart, no claim about what the
 * household's owner was told. Rendered through the real `raiseAdminAlert` with
 * the database, the key reader and the mail wire stood in.
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
    delete: () => ({ where: async () => undefined }),
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

const LEDE = "Importing an archive into the Harlow household failed at 7 Nov 2026 at 14:05 UTC, and undoing it failed too. Orbit tries the undo again every fifteen minutes; until it succeeds, meanwhile the household is still closed to other members.";
const FACT = "kept the household closed to other members until the undo finishes";

async function rendered(): Promise<{ subject: string; html: string; text: string }> {
  process.env.APP_URL = "https://orbit.harlow.example";
  mocks.sendBoundedMail.mockReset();
  mocks.sendBoundedMail.mockResolvedValue({ sentAt: new Date(), sendError: null });
  // Imported with the stand-ins above in place.
  const { raiseAdminAlert } = await import("@/server/admin-alert");
  await raiseAdminAlert({ kind: "import_undo_failed", faultKey: "f1", householdName: "Harlow", occurredAt: new Date("2026-11-07T14:05:00Z") });
  expect(mocks.sendBoundedMail).toHaveBeenCalledTimes(1);
  return mocks.sendBoundedMail.mock.calls[0][1];
}

describe("the undo-failed alert wording (#1800)", () => {
  beforeEach(() => vi.resetModules());

  it("html: carries the lede verbatim and nothing after it", async () => {
    const { html } = await rendered();
    expect(html).toContain(LEDE);
    expect(html).not.toContain("The household’s owner has been told an administrator has been notified.");
  });

  it("html: carries the new Orbit did fact and not the old one", async () => {
    const { html } = await rendered();
    expect(html).toContain(FACT);
    expect(html).not.toContain("read-only");
  });

  it("html: never says restart or that the owner has been told", async () => {
    const { html } = await rendered();
    expect(html).not.toMatch(/restart/iu);
    expect(html).not.toContain("has been told an administrator");
  });

  it("text: carries the same lede and the same fact", async () => {
    const { text } = await rendered();
    expect(text).toContain(LEDE);
    expect(text).toContain(`Orbit did: ${FACT}`);
    expect(text).not.toContain("The household’s owner has been told");
  });

  it("text: never says restart or that the owner has been told", async () => {
    const { text } = await rendered();
    expect(text).not.toMatch(/restart/iu);
    expect(text).not.toContain("has been told an administrator");
  });

  it("leaves subject, preheader, headline, other facts, button and footer unchanged", async () => {
    const { subject, html, text } = await rendered();
    expect(subject).toBe("Orbit needs you: an import could not be undone");
    expect(html).toContain("An import failed and undoing it failed too.");
    expect(html).toContain("Orbit needs an administrator");
    expect(html).toContain("import undo failed");
    expect(html).toContain("open Administration");
    expect(html).toContain("href=\"https://orbit.harlow.example/admin\"");
    expect(html).toContain("Sent to every administrator. Orbit won’t repeat this for the same fault within 24 hours.");
    expect(text).toContain("what: import undo failed");
    expect(text).toContain("household: Harlow");
    expect(text).toContain("when: 7 Nov 2026 at 14:05 UTC");
    expect(text).toContain("Open Administration: https://orbit.harlow.example/admin");
  });
});
