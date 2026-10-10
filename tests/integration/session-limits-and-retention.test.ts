import { afterAll, afterEach, describe, expect, it } from "vitest";
import { getDocumentConfig, resetDocumentConfigForTests } from "@/server/documents/config";
import { RECEIPT_RETENTION_MS } from "@/server/mail-in/imap-ingestion";
import { MAX_ARCHIVE_CIPHERTEXT_CHARACTERS } from "@/server/portable-archive-limits";
import {
  cleanupIntegrationEnvironment,
  createIntegrationFixture,
  type IntegrationSession,
} from "./support/fixtures";
import { callRoute, callRouteForSession, loadRoute } from "./support/request-event";

/*
 * #1336 (the archive card's numbers come from the engine): the browser used
 * to hold its own copies of the archive size ceiling, the passphrase bounds
 * and the retention windows. The session payload (`GET /api/auth/session`)
 * now carries them, read from the engine, so the browser has nothing to copy.
 *
 * Passphrase bounds and the household recovery window are not exported by any
 * engine module (the routes spell `min(12).max(256)` inline and
 * RECOVERY_WINDOW_MS is private to household-lifecycle), so those three are
 * pinned at their M1 values and, for the passphrase, also against what the
 * archive routes actually accept.
 */

const { GET: sessionStatus } = await loadRoute("auth/session");
// The same one-constant crossing auth-session-contracts.test.ts uses: the
// import route's whole body limit, i.e. the ciphertext cap plus a small
// allowance for the envelope around it.
const ARCHIVE_BODY_LIMIT = (await import(
  /* @vite-ignore */ new URL("../../web/src/lib/server/body-limit.js", import.meta.url).href
) as { ARCHIVE_BODY_LIMIT: number }).ARCHIVE_BODY_LIMIT;

const DAY_MS = 86_400_000;
/** What an archive Orbit wrote from 130 MB of plaintext weighs as a file, to the byte of ciphertext (unpadded base64url). */
const CIPHERTEXT_FOR_130_MB = Math.ceil((130_000_000 * 4) / 3);

afterAll(async () => {
  await cleanupIntegrationEnvironment();
});

let restoreRetentionEnv: (() => void) | undefined;
afterEach(() => {
  restoreRetentionEnv?.();
  restoreRetentionEnv = undefined;
  resetDocumentConfigForTests();
});

async function readPayload(session: IntegrationSession) {
  const response = await callRouteForSession(sessionStatus, session, {
    url: "http://127.0.0.1:3000/api/auth/session",
  });
  expect(response.status).toBe(200);
  return response.json();
}

describe("the session payload carries the engine's limits and retention (#1336)", () => {
  it("carries limits.archiveFileBytes at the engine's own file cap, and a 130 MB archive Orbit wrote fits under it", async () => {
    const fixture = await createIntegrationFixture("session-limits-archive");
    const payload = await readPayload(await fixture.session("member"));

    expect(payload.limits).toBeDefined();
    expect(Number.isInteger(payload.limits.archiveFileBytes)).toBe(true);
    // Not the 128 MiB the browser used to hold: the engine accepts ciphertext
    // up to MAX_ARCHIVE_CIPHERTEXT_CHARACTERS, and an archive file is that
    // ciphertext plus its envelope, so the number may not sit below the cap.
    expect(payload.limits.archiveFileBytes).toBeGreaterThanOrEqual(MAX_ARCHIVE_CIPHERTEXT_CHARACTERS);
    // ...and no higher than what the import route's body limit lets through.
    expect(payload.limits.archiveFileBytes).toBeLessThanOrEqual(ARCHIVE_BODY_LIMIT);
    // The issue's own case: a ~130 MB archive written by Orbit is not refused.
    expect(payload.limits.archiveFileBytes).toBeGreaterThanOrEqual(CIPHERTEXT_FOR_130_MB);
  });

  it("carries limits.passphraseMin and passphraseMax at the archive routes' bounds (12 and 256)", async () => {
    const fixture = await createIntegrationFixture("session-limits-passphrase");
    const payload = await readPayload(await fixture.session("member"));

    expect(payload.limits.passphraseMin).toBe(12);
    expect(payload.limits.passphraseMax).toBe(256);
  });

  it("carries retention.documentDays equal to the document configuration", async () => {
    const fixture = await createIntegrationFixture("session-retention-documents");
    const payload = await readPayload(await fixture.session("member"));

    expect(payload.retention).toBeDefined();
    expect(payload.retention.documentDays).toBe(getDocumentConfig().retentionDays);
  });

  it("follows DOCUMENT_RETENTION_DAYS when the operator changes it", async () => {
    const fixture = await createIntegrationFixture("session-retention-operator");
    const session = await fixture.session("member");
    const previous = process.env.DOCUMENT_RETENTION_DAYS;
    restoreRetentionEnv = () => {
      if (previous === undefined) delete process.env.DOCUMENT_RETENTION_DAYS;
      else process.env.DOCUMENT_RETENTION_DAYS = previous;
    };
    process.env.DOCUMENT_RETENTION_DAYS = "90";
    resetDocumentConfigForTests();

    const payload = await readPayload(session);
    expect(payload.retention.documentDays).toBe(90);
  });

  it("carries retention.receiptDays equal to the mail-in receipt window and recoveryDays equal to the household recovery window", async () => {
    const fixture = await createIntegrationFixture("session-retention-windows");
    const payload = await readPayload(await fixture.session("member"));

    expect(payload.retention.receiptDays).toBe(RECEIPT_RETENTION_MS / DAY_MS);
    // household-lifecycle's RECOVERY_WINDOW_MS (30 days) is module-private,
    // so the M1 value is pinned here rather than imported.
    expect(payload.retention.recoveryDays).toBe(30);
  });

  it("still answers a signed-out caller with 401 and no limits", async () => {
    const response = await callRoute(sessionStatus, { url: "http://127.0.0.1:3000/api/auth/session" });
    expect(response.status).toBe(401);
    const body = await response.json();
    expect(body.authenticated).toBe(false);
    expect(body.limits).toBeUndefined();
  });
});
