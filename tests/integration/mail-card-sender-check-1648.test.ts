/**
 * The sending-address check mail wears the ratified card (#1648 mail 1).
 *
 * Driven through `requestSenderCheck` with the injected `sendMail`, as the
 * other sender-check tests do. The verification token appears only in the
 * button's href and the text part. The token is random, so the text part is
 * pinned as today's template around the link read back from the captured text.
 */
import { afterAll, afterEach, beforeEach, describe, expect, it } from "vitest";
import { getDb } from "@/db";
import { auditLog, imapRecipientAliases, mailInMailbox, mailInRelays, mailInSecrets, mailInSenderAddresses } from "@/db/schema";
import { setMailboxSettings, type MailboxSettingsDependencies, type MailboxSettingsInput } from "@/server/mail-in/mailbox-settings";
import { requestSenderCheck } from "@/server/mail-in/sender-addresses";
import { cleanupIntegrationEnvironment, createIntegrationFixture, type IntegrationFixture } from "./support/fixtures";
import { visibleText } from "../support/mail-card";

const settings: MailboxSettingsInput = {
  host: "imap.example.test",
  port: 993,
  accountUser: "intake@example.test",
  mailbox: "INBOX",
  tlsServerName: "imap.example.test",
  providerProfile: "mailcow",
  trustedRecipientHeader: "X-Original-To",
  pollSeconds: 300,
  password: "fake-sender-check-card-password",
};
const providerReady: MailboxSettingsDependencies = { verifyImap: async () => "ready" };
const smtpConfig = () => ({
  smtpUrl: "smtps://fake:fake@smtp.example.test:465",
  smtpSecurity: "implicit_tls" as const,
  smtpFrom: "orbit@example.test",
  vapidSubject: "",
  vapidPublicKey: "",
  vapidPrivateKey: "",
  pollMilliseconds: 60_000,
  maxAttempts: 5,
});

let fixture: IntegrationFixture;

beforeEach(async () => {
  fixture = await createIntegrationFixture("mail-card-sender-check");
});

afterEach(async () => {
  const db = getDb();
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

async function check() {
  await setMailboxSettings(fixture.users.admin.id, null, settings, providerReady);
  const sent: Array<{ from: string; to: string; subject: string; text: string; html?: string }> = [];
  const result = await requestSenderCheck(fixture.users.member.id, {
    smtpConfig,
    appUrl: () => "https://orbit.harlow.example",
    now: () => new Date("2026-11-07T16:20:00.000Z"),
    sendMail: async (message) => { sent.push(message as never); },
  });
  expect(sent).toHaveLength(1);
  return { mail: sent[0], address: result.address };
}

describe("sending-address check mail (#1648 mail 1)", () => {
  it("carries the ratified card: headline, button and link, address and expiry facts", async () => {
    const { mail, address } = await check();
    expect(mail.subject).toBe("Check your Orbit sending address");
    const html = mail.html ?? "";
    expect(html).toContain("1px solid #4f4118");
    expect(html).not.toMatch(/<img|<svg|<link/iu);
    const seen = visibleText(html);
    expect(seen).toContain("Is this address yours?");
    expect(seen).toContain(`Orbit is checking that you send mail from ${address}.`);
    expect(seen).toContain("yes, it’s mine");
    expect(seen).toContain("address");
    expect(seen).toContain("good until");
    expect(seen).toContain("8 Nov 2026 at 16:20 UTC");
    expect(seen).toContain("Didn’t ask for this? Ignore it — nothing changes.");
    expect(html.match(/<a\s/giu)).toHaveLength(1);
  });

  it("keeps the token to the button link and the text part", async () => {
    const { mail } = await check();
    const link = /https:\/\/orbit\.harlow\.example\S*/u.exec(mail.text)![0];
    const token = new URL(link).searchParams.get("token")!;
    expect(token.length).toBeGreaterThan(20);
    const html = mail.html ?? "";
    expect(html).toMatch(new RegExp(`<a [^>]*href="[^"]*${token}[^"]*"`, "u"));
    expect(visibleText(html)).not.toContain(token);
    expect(mail.subject).not.toContain(token);
  });

  it("keeps the text part as it is today, byte for byte", async () => {
    const { mail } = await check();
    const link = /https:\/\/orbit\.harlow\.example\S*/u.exec(mail.text)![0];
    expect(mail.text).toBe([
      "Orbit is checking that you send mail from this address.",
      "",
      `Open this link while signed in to Orbit, within 24 hours: ${link}`,
      "",
      "Until you do, mail you forward to Orbit from this address is not matched to you.",
      "If you did not ask for this, ignore it — nothing changes.",
    ].join("\n"));
    expect(link).toMatch(/^https:\/\/orbit\.harlow\.example\/\S+$/u);
  });
});
