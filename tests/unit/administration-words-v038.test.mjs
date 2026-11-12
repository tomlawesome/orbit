import { describe, expect, it } from "vitest";
import {
  blankSendDraft,
  documentsOwed,
  exportsKeptShort,
  failedHalvesOf,
  fetchNowRefusal,
  fetchNowWords,
  gigabytes,
  importSkippedWords,
  mailboxSubmissionHost,
  megabytes,
  namesOf,
  notMailedWords,
  probeWords,
  providerHost,
  removalWords,
  securityWord,
  sendDraftOf,
  sendingOutcomeWords,
  sendingRowsOf,
  SENDING_NOT_SET,
} from "../../web/src/routes/administration/words.js";

/*
 * What the administration screen says for the v0.3.8 cards, from the pure
 * word helpers the desk and the pocket share (#1123): the Mail card's Sending
 * half (#1629), fetch now (#1651), the setup probe (#1631), the drawn-pages
 * owed count (#1433 D20), Exports kept (#1792) and the provider check
 * (#1626). The screen suites render these through the page; here each word
 * is pinned against what its doc comment promises.
 */

const GIB = 1073741824;
const MIB = 1048576;

describe("the Sending half's words (#1629)", () => {
  it("names the two securities as the screen does, STARTTLS unless implicit TLS", () => {
    expect(securityWord("implicit_tls")).toBe("TLS");
    expect(securityWord("starttls")).toBe("STARTTLS");
    expect(securityWord(null)).toBe("STARTTLS");
  });

  it("works out the mailbox account's submission server as the server does", () => {
    expect(mailboxSubmissionHost({ host: "imap.gmail.com", providerProfile: "gmail" })).toBe("smtp.gmail.com");
    expect(mailboxSubmissionHost({ host: "outlook.office365.com", providerProfile: "outlook" })).toBe("smtp.office365.com");
    expect(mailboxSubmissionHost({ host: "mail.example.test", providerProfile: "mailcow" })).toBe("mail.example.test");
    expect(mailboxSubmissionHost(null)).toBe("");
  });

  it("says the sending rows for the mailbox account, never a password", () => {
    const rows = sendingRowsOf({
      via: "mailbox", sendsAs: "Orbit <orbit@example.test>", host: "smtp.gmail.com", port: 587, security: "starttls",
      lastSent: { what: "an invitation", at: "2026-11-11T09:00:00Z" },
    }, "2026-11-11T12:00:00Z");
    expect(rows).toEqual({
      sendsAs: "Orbit <orbit@example.test>",
      viaWho: "the mailbox account",
      viaWhere: "smtp.gmail.com, port 587, STARTTLS",
      viaPort: "587 · STARTTLS",
      lastSent: { what: "an invitation", when: "3 hours ago" },
    });
    expect(JSON.stringify(rows)).not.toMatch(/password/i);
  });

  it("says another account with no host and nothing sent yet", () => {
    expect(sendingRowsOf({ via: "account", port: 465, security: "implicit_tls", lastSent: null }, "2026-11-11T12:00:00Z")).toEqual({
      sendsAs: "", viaWho: "another account", viaWhere: "no mailbox set", viaPort: "465 · TLS", lastSent: null,
    });
  });

  it("starts the editor on the mailbox account when the mailbox has an account, else another account", () => {
    expect(blankSendDraft({ accountUser: "relay@example.test" })).toEqual({
      via: "mailbox", host: "", port: 587, security: "starttls", user: "", senderName: "Orbit", senderAddress: "relay@example.test",
    });
    expect(blankSendDraft(null)).toMatchObject({ via: "account", senderAddress: "" });
  });

  it("fills the editor from the server, keeping the account fields only for another account", () => {
    expect(sendDraftOf({ via: "account", host: "smtp.example.test", port: 465, security: "implicit_tls", user: "me", senderName: "Home", senderAddress: "home@example.test" }))
      .toEqual({ via: "account", host: "smtp.example.test", port: 465, security: "implicit_tls", user: "me", senderName: "Home", senderAddress: "home@example.test" });
    expect(sendDraftOf({ via: "mailbox", host: "ignored", port: 25, security: "implicit_tls", user: "ignored" }))
      .toEqual({ via: "mailbox", host: "", port: 587, security: "starttls", user: "", senderName: "Orbit", senderAddress: "" });
    expect(sendDraftOf({ via: "account" })).toEqual({ via: "account", host: "", port: 587, security: "starttls", user: "", senderName: "Orbit", senderAddress: "" });
    expect(sendDraftOf({}).via).toBe("mailbox");
  });

  it("words a save's answer, and says nothing before there is one", () => {
    expect(sendingOutcomeWords("verified")).toBe("signed in and saved");
    expect(sendingOutcomeWords("smtp_rejected")).toBe("the server refused the sign-in · nothing was saved");
    expect(sendingOutcomeWords("smtp_unavailable")).toBe("the server could not be reached · nothing was saved");
    expect(sendingOutcomeWords("key_unavailable")).toBe("key unavailable");
    expect(sendingOutcomeWords(null)).toBe("");
  });

  it("says why the old SMTP lines were not copied", () => {
    expect(importSkippedWords("key_unavailable")).toBe("the encryption key could not be read");
    expect(importSkippedWords("lines_unusable")).toBe("they are incomplete or unusable");
    expect(SENDING_NOT_SET).toMatch(/until sending is set up/);
  });

  it("says why a member was not mailed", () => {
    expect(notMailedWords("smtp_rejected")).toBe("the outgoing mail server refused the message");
    expect(notMailedWords("smtp_unavailable")).toBe("the outgoing mail server couldn’t be reached");
    expect(notMailedWords("smtp_unconfigured")).toBe("outgoing mail isn’t set up");
    expect(notMailedWords("stranded_after_check")).toBe("no way in after the check");
    expect(notMailedWords(null)).toBe("the message could not be sent");
  });
});

describe("fetch now (#1651)", () => {
  it("is out of reach, in words, until a mailbox is set up, enabled and idle", () => {
    expect(fetchNowRefusal(null)).toBe("no mailbox is set up yet");
    expect(fetchNowRefusal({ configured: false, enabled: true })).toBe("no mailbox is set up yet");
    expect(fetchNowRefusal({ configured: true, enabled: false })).toBe("ingest is paused");
    expect(fetchNowRefusal({ configured: true, enabled: true, checkRunning: true })).toBe("a check is already running");
    expect(fetchNowRefusal({ configured: true, enabled: true, checkRunning: false })).toBe("");
  });

  it("words each refusal the server answers", () => {
    expect(fetchNowWords("already_running", null)).toBe("a check is already running");
    expect(fetchNowWords("paused", null)).toBe("ingest is paused");
    expect(fetchNowWords("not_configured", null)).toBe("no mailbox is set up yet");
    expect(fetchNowWords("credential_locked", null)).toBe("the mailbox password can't be opened");
    expect(fetchNowWords("provider_unavailable", null)).toBe("provider unavailable · the mailbox could not be checked");
  });

  it("says why a check read nothing although ingest is on", () => {
    expect(fetchNowWords("not_checked", { reason: "key_unavailable" })).toBe("not checked · the key isn't available");
    expect(fetchNowWords("not_checked", { reason: "dkim_dns_malformed" })).toBe("not checked · the DKIM DNS servers setting is malformed");
    expect(fetchNowWords("not_checked", null)).toBe("not checked · the check was skipped");
  });

  it("gives the counts and the four reasons, a missing reason counting as 0", () => {
    expect(fetchNowWords("checked", null)).toBe("checked");
    expect(fetchNowWords("checked", { messagesRead: 5, receiptsRecorded: 2, reasons: { held: 1, unattributed: 2 } }))
      .toBe("messages read: 5 · receipts recorded: 2 · sender unverified 0 · unattributed 2 · held 1 · provider unavailable 0");
  });
});

describe("the setup probe and provider check (#1631, #1626)", () => {
  it("names Mailcow's tagged-mail setting first when a probe is not delivered there", () => {
    expect(probeWords("not_delivered", "mailcow")).toMatch(/^not delivered · in Mailcow, .*"Do nothing"/);
    expect(probeWords("not_delivered", "gmail")).toBe("not delivered");
    expect(probeWords("delivered", "mailcow")).toBe("delivered");
  });

  it("names which half of the provider check failed", () => {
    expect(failedHalvesOf({ smtp: "provider_unavailable", imap: "provider_unavailable" })).toEqual(["outgoing mail failed", "incoming mail failed"]);
    expect(failedHalvesOf({ smtp: "ok", imap: "provider_unavailable" })).toEqual(["incoming mail failed"]);
    expect(failedHalvesOf(null)).toEqual([]);
  });

  it("names a provider by its host, or as given when it is no URL", () => {
    expect(providerHost("https://id.example.test/realms/home")).toBe("id.example.test");
    expect(providerHost("not a url")).toBe("not a url");
    expect(namesOf(["Ada", "Ned"])).toBe("Ada and Ned");
    expect(namesOf(["Ada", "Ned", "Priya"])).toBe("Ada, Ned, Priya");
  });

  it("words a refused removal from its bounded code, else the error's own words", () => {
    expect(removalWords({ code: "recent_authentication_required" })).toBe("that isn't your current password — nothing was removed");
    expect(removalWords({ code: "too_many_attempts" })).toBe("too many attempts at once; try again shortly");
    expect(removalWords({ code: "other", message: "the member is the last administrator" })).toBe("the member is the last administrator");
    expect(removalWords(undefined)).toBe("Something went wrong.");
  });
});

describe("sizes and counts (#1285, #1433 D20, #1792)", () => {
  it("says a limit in whole MB where it is whole", () => {
    expect(megabytes(25 * MIB)).toBe("25 MB");
    expect(megabytes(1.5 * MIB)).toBe("1.5 MB");
  });

  it("says the documents whose pages are not yet drawn, none at zero", () => {
    expect(documentsOwed(0)).toBe("none");
    expect(documentsOwed(1)).toBe("1 document");
    expect(documentsOwed(12)).toBe("12 documents");
  });

  it("says export space in whole GB where it is whole, and the settings in short", () => {
    expect(gigabytes(4 * GIB)).toBe("4 GB");
    expect(gigabytes(2.5 * GIB)).toBe("2.5 GB");
    expect(exportsKeptShort({ retentionHours: 6, keepPerHousehold: 2, maxTotalBytes: 20 * GIB })).toBe("6 h · 2 · 20 GB");
    expect(exportsKeptShort({ retentionHours: 24, keepPerHousehold: 3, maxTotalBytes: 10 * GIB }, " per household")).toBe("24 h · 3 per household · 10 GB");
  });
});
