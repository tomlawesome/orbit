import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
  now: 1_000,
  verify: vi.fn(),
  requireAdmin: vi.fn(async () => undefined),
}));

vi.mock("@/server/authorization", () => ({ requireInstanceAdministrator: mocks.requireAdmin }));
vi.mock("@/server/notification-worker", () => ({
  getNotificationWorkerConfig: vi.fn(() => ({})),
  getNotificationWorkerHealth: vi.fn(() => ({ started: false, running: false, lastSuccessAt: null, lastErrorAt: null, lastErrorCategory: null })),
  notificationFailureCategories: [],
  verifySmtpProviderConnection: vi.fn(),
}));
vi.mock("@/server/imap-ingestion", () => ({
  getImapIngestionConfig: vi.fn(() => ({})),
  getImapIngestionWorkerHealth: vi.fn(() => ({ started: false, running: false, lastSuccessAt: null, lastErrorAt: null, lastErrorCode: null, preflightStatus: "not_configured" })),
  getImapProviderPreflightState: vi.fn(() => ({ status: "not_configured", smtp: "not_configured", imap: "not_configured", checkedAt: null })),
  // Real class, not a mock: admin-operations.ts uses `instanceof` on it to
  // tell a locked mail-in credential (ADR-0017 slice 1) from any other
  // configuration error.
  MailInCredentialLockedError: class MailInCredentialLockedError extends Error {},
  verifyImapIngestionProviders: mocks.verify,
}));

import { MailInCredentialLockedError } from "@/server/imap-ingestion";
import { verifySmtpProviderConnection } from "@/server/notification-worker";
import {
  safeAdministratorAuditLabel, setImapProviderVerificationDependenciesForTests, verifyImapIngestionProvider,
  verifySmtpProvider,
} from "./admin-operations";

describe("administrator mailbox provider verification bounds", () => {
  beforeEach(() => {
    mocks.now = 1_000;
    mocks.verify.mockReset();
    mocks.requireAdmin.mockClear();
    setImapProviderVerificationDependenciesForTests({ now: () => mocks.now, verify: mocks.verify });
  });

  afterEach(() => setImapProviderVerificationDependenciesForTests(undefined));

  it("deduplicates in-flight checks, throttles completed failures, and later recovers", async () => {
    let resolveFirst: ((value: string) => void) | undefined;
    mocks.verify.mockReturnValueOnce(new Promise<string>((resolve) => { resolveFirst = resolve; }));

    const first = verifyImapIngestionProvider("admin-user");
    await vi.waitFor(() => expect(mocks.verify).toHaveBeenCalledTimes(1));
    await expect(verifyImapIngestionProvider("admin-user")).resolves.toEqual({ result: "verification_pending" });
    resolveFirst?.("available");
    await expect(first).resolves.toEqual({ result: "available" });
    await expect(verifyImapIngestionProvider("admin-user")).resolves.toEqual({ result: "retrying" });
    expect(mocks.verify).toHaveBeenCalledTimes(1);

    mocks.now += 1_001;
    mocks.verify.mockResolvedValueOnce("provider_unavailable");
    await expect(verifyImapIngestionProvider("admin-user")).resolves.toEqual({ result: "provider_unavailable" });
    await expect(verifyImapIngestionProvider("admin-user")).resolves.toEqual({ result: "retrying" });
    expect(mocks.verify).toHaveBeenCalledTimes(2);

    mocks.now += 1_001;
    mocks.verify.mockResolvedValueOnce("available");
    await expect(verifyImapIngestionProvider("admin-user")).resolves.toEqual({ result: "available" });
    expect(mocks.verify).toHaveBeenCalledTimes(3);
  });

  it("surfaces a locked mail-in credential as credential_locked, not unsafe_input (#1067)", async () => {
    mocks.verify.mockRejectedValueOnce(new MailInCredentialLockedError("test-key-id"));
    await expect(verifyImapIngestionProvider("admin-user")).resolves.toEqual({ result: "credential_locked" });
  });

  /* #1071: the server now remembers each test's last answer, via a small
     `recordMailProbeResult` write this suite never mocks `@/db` for — so it
     always throws here (no DATABASE_URL in this process) and is swallowed.
     The point of this test is exactly that swallow: the live answer the
     caller paid for must still come back whole. */
  it("still answers with the live result when the mail-probe store write fails", async () => {
    mocks.verify.mockResolvedValueOnce("available");
    await expect(verifyImapIngestionProvider("admin-user")).resolves.toEqual({ result: "available" });
  });
});

describe("administrator SMTP relay verification", () => {
  /* One test only: `verifySmtpProvider` throttles a second call within 1s of
     the first (its own dedup, unrelated to #1071) on real wall-clock time
     with no injectable clock, so a second case here would collide with the
     first rather than proving anything new.

     #1151 A1-Q8: this test's own name used to claim it "still stores the
     answer", but the suite never mocks `@/db` (same as the IMAP test above),
     so `recordMailProbeResult`'s write always throws here and is swallowed --
     nothing a test running in this file can observe. Renamed to the one
     thing it actually proves, matching the IMAP test's own honest phrasing:
     the live answer still comes back whole even though the store write
     failed. Whether the write itself lands is #1067's integration coverage. */
  it("still answers unsafe_input with the live result when the SMTP connection check throws, even though the mail-probe store write fails", async () => {
    vi.mocked(verifySmtpProviderConnection).mockRejectedValueOnce(new Error("connection refused"));
    await expect(verifySmtpProvider("admin-user")).resolves.toEqual({ result: "unsafe_input" });
  });
});

describe("administrator audit labels", () => {
  it("uses explicit safe labels for critical actions and a generic label for unknown values", () => {
    expect(safeAdministratorAuditLabel("ownership_transferred")).toBe("Household ownership transferred");
    expect(safeAdministratorAuditLabel("document_draft_approved")).toBe("Document review updated");
    expect(safeAdministratorAuditLabel("raw recipient=recipient@example.invalid secret=not-real")).toBe("Orbit administration activity");
  });
});
