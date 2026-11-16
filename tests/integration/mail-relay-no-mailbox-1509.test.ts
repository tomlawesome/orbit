import { afterAll, afterEach, beforeEach, describe, expect, it } from "vitest";
import { getDb } from "@/db";
import { auditLog, imapIngestionMessages, imapRecipientAliases, mailInMailbox, mailInRelays, mailInSecrets, mailInSenderAddresses } from "@/db/schema";
import { cleanupIntegrationEnvironment, createIntegrationFixture, type IntegrationFixture, type IntegrationSession } from "./support/fixtures";
import { callRouteForSession, loadRoute } from "./support/request-event";

/*
 * #1509: Settings' `your relay` tab draws "no household mailbox" from the
 * answer to `GET /api/settings/mail-relay`, in web/src/routes/settings/
 * relay-shape.js (`relayShape`): the mailbox is not set up when the address
 * is not a usable one and the status says `not listening`. The tab's
 * explanation ("your administrator hasn't set up the household mailbox yet")
 * and its hidden rows hang on exactly that pair, so the real server's answer
 * for a household with no mailbox is held to it here, for a member and for
 * an administrator, rather than trusting the browser tests' stubs.
 */
const RELAY_URL = "http://127.0.0.1:3000/api/settings/mail-relay";
const relayRead = async () => (await loadRoute("settings/mail-relay")).GET;

let fixture: IntegrationFixture;

beforeEach(async () => {
  fixture = await createIntegrationFixture("relay-no-mailbox");
});

afterEach(async () => {
  const db = getDb();
  await db.delete(imapIngestionMessages);
  await db.delete(imapRecipientAliases);
  await db.delete(mailInSenderAddresses);
  await db.delete(mailInRelays);
  await db.update(mailInMailbox).set({ passwordSecretId: null, aliasKeySecretId: null });
  await db.delete(mailInMailbox);
  await db.delete(mailInSecrets);
  await db.delete(auditLog);
  await fixture.cleanup();
});

afterAll(async () => {
  await cleanupIntegrationEnvironment();
});

async function readOverHttp(session: IntegrationSession) {
  const response = await callRouteForSession(await relayRead(), session, { url: RELAY_URL, method: "GET" });
  expect(response.status).toBe(200);
  return (await response.json() as { relay: { address?: string | null; listening?: string; ingest?: string; adminPaused?: boolean } }).relay;
}

describe("GET /api/settings/mail-relay with no household mailbox (#1509)", () => {
  for (const who of ["member", "admin"] as const) {
    it(`answers a ${who} with no address and the status \`not listening\`, which relayShape reads as no mailbox`, async () => {
      const relay = await readOverHttp(await fixture.session(who));
      expect(relay.address ?? null, "no address").toBeNull();
      expect(relay.listening, "the bounded status word relayShape matches with /not listening/").toBe("not listening");
      expect(relay.adminPaused ?? false, "not an administrator's pause").toBe(false);
    });
  }
});
