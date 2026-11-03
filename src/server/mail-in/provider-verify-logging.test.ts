import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { log } from "@/lib/logger";
import { verifyImapIngestionProviders } from "./imap-ingestion";
import { testImapConfig } from "../../../tests/support/imap-config";
import { getNotificationWorkerConfig } from "../notification-worker";

/*
 * #1626: a failed provider check names its half on the screen and logs one
 * bounded warning in the event/state/reason/action shape. SMTP is
 * `mail.smtp.verify`, IMAP is `imap.verify`; the reason is one word from a
 * fixed list. The verifiers below are stubs that fail the way the providers'
 * libraries do (an error carrying a `code`), with a message that holds a
 * credential and a hostname that must never reach a log line or a response.
 */
const SECRET = "hunter2-fake-credential";
const RAW = `connect failed for intake@secret-host.example.test password=${SECRET}`;
const smtpEnvironment = { NODE_ENV: "test", SMTP_HOST: "smtp.example.test", SMTP_USER: "orbit", SMTP_PASSWORD: SECRET } as NodeJS.ProcessEnv;

const failure = (code: string, extra: Record<string, unknown> = {}) => Object.assign(new Error(RAW), { code, ...extra });

/** [reason word, the error a provider library raises for that class] */
const CLASSES: Array<[string, () => Error]> = [
  ["dns_failed", () => failure("ENOTFOUND")],
  ["connection_refused", () => failure("ECONNREFUSED")],
  ["timeout", () => failure("ETIMEDOUT")],
  ["tls_certificate", () => failure("DEPTH_ZERO_SELF_SIGNED_CERT")],
  ["tls_hostname", () => failure("ERR_TLS_CERT_ALTNAME_INVALID")],
  ["auth_rejected", () => failure("EAUTH", { authenticationFailed: true })],
  ["starttls_unavailable", () => failure("ETLS")],
  ["other", () => failure("EWHATEVER")],
];

let warn: ReturnType<typeof vi.spyOn>;
let counter = 0;
const freshConfig = () => testImapConfig({ password: SECRET, host: `imap-${(counter += 1)}.example.test` });

beforeEach(() => {
  warn = vi.spyOn(log, "warn").mockImplementation(() => undefined);
  vi.spyOn(log, "info").mockImplementation(() => undefined);
  vi.spyOn(log, "error").mockImplementation(() => undefined);
});
afterEach(() => vi.restoreAllMocks());

const lines = () => warn.mock.calls.map(([line]) => line as Record<string, unknown>);
const lineFor = (event: string) => lines().filter((line) => line.event === event);

describe.each(CLASSES)("a failed check of class %s", (reason, makeError) => {
  it("outgoing mail: one mail.smtp.verify warning with the reason, the incoming half unaffected", async () => {
    const state = await verifyImapIngestionProviders(freshConfig(), getNotificationWorkerConfig(smtpEnvironment), {
      verifySmtp: async () => { throw makeError(); },
      verifyImap: async () => "ready",
    });
    expect(state).toMatchObject({ status: "provider_unavailable", smtp: "provider_unavailable", imap: "available" });
    const smtp = lineFor("mail.smtp.verify");
    expect(smtp).toHaveLength(1);
    expect(smtp[0]).toMatchObject({ event: "mail.smtp.verify", reason });
    expect(smtp[0]).toHaveProperty("state");
    expect(smtp[0]).toHaveProperty("action");
    expect(lineFor("imap.verify")).toHaveLength(0);
    const text = JSON.stringify({ lines: lines(), state });
    expect(text).not.toContain(SECRET);
    expect(text).not.toContain("secret-host");
  });

  it("incoming mail: one imap.verify warning with the reason, the outgoing half unaffected", async () => {
    const state = await verifyImapIngestionProviders(freshConfig(), getNotificationWorkerConfig(smtpEnvironment), {
      verifySmtp: async () => "ready",
      verifyImap: async () => { throw makeError(); },
    });
    expect(state).toMatchObject({ status: "provider_unavailable", smtp: "available", imap: "provider_unavailable" });
    const imap = lineFor("imap.verify");
    expect(imap).toHaveLength(1);
    expect(imap[0]).toMatchObject({ event: "imap.verify", reason });
    expect(imap[0]).toHaveProperty("state");
    expect(imap[0]).toHaveProperty("action");
    expect(lineFor("mail.smtp.verify")).toHaveLength(0);
    const text = JSON.stringify({ lines: lines(), state });
    expect(text).not.toContain(SECRET);
    expect(text).not.toContain("secret-host");
  });
});

describe("the log line shape and the cases that are not a thrown error", () => {
  it("carries only the event/state/reason/action protocol fields, with a reason from the fixed list", async () => {
    await verifyImapIngestionProviders(freshConfig(), getNotificationWorkerConfig(smtpEnvironment), {
      verifySmtp: async () => { throw failure("ECONNREFUSED"); },
      verifyImap: async () => { throw failure("ENOTFOUND"); },
    });
    const own = lines().filter((line) => line.event === "mail.smtp.verify" || line.event === "imap.verify");
    expect(own.map((line) => line.event).sort()).toEqual(["imap.verify", "mail.smtp.verify"]);
    const allowed = new Set(["event", "state", "reason", "action", "impact"]);
    for (const line of own) {
      expect(Object.keys(line).filter((key) => !allowed.has(key))).toEqual([]);
      expect(["dns_failed", "connection_refused", "timeout", "tls_certificate", "tls_hostname", "auth_rejected", "starttls_unavailable", "other"]).toContain(line.reason);
    }
  });

  it("a sign-in the outgoing server refused is auth_rejected", async () => {
    await verifyImapIngestionProviders(freshConfig(), getNotificationWorkerConfig(smtpEnvironment), {
      verifySmtp: async () => "smtp_rejected",
      verifyImap: async () => "ready",
    });
    expect(lineFor("mail.smtp.verify")).toMatchObject([{ reason: "auth_rejected" }]);
  });

  it("a verifier that fails with no detail is logged as other, and a passing check logs nothing", async () => {
    await verifyImapIngestionProviders(freshConfig(), getNotificationWorkerConfig(smtpEnvironment), {
      verifySmtp: async () => "ready",
      verifyImap: async () => "imap_unavailable",
    });
    expect(lineFor("imap.verify")).toMatchObject([{ reason: "other" }]);
    expect(lineFor("mail.smtp.verify")).toHaveLength(0);
    warn.mockClear();
    await verifyImapIngestionProviders(freshConfig(), getNotificationWorkerConfig(smtpEnvironment), {
      verifySmtp: async () => "ready",
      verifyImap: async () => "ready",
    });
    expect(lineFor("imap.verify")).toHaveLength(0);
    expect(lineFor("mail.smtp.verify")).toHaveLength(0);
  });
});
