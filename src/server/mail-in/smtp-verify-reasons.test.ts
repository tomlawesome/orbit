import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { log } from "@/lib/logger";

/*
 * #1670 A-F2 / A-F4: the shipped SMTP check (no stubbed verifier) logs a
 * reason from the error nodemailer raises. Only an authentication refusal is
 * auth_rejected; a refused connection, a certificate or a hostname problem is
 * named from the code nodemailer kept in `originalCode`.
 */
const transport = vi.hoisted(() => ({ error: undefined as unknown }));
vi.mock("nodemailer", () => {
  const createTransport = () => ({
    verify: async () => { throw transport.error; },
    close: () => undefined,
  });
  return { default: { createTransport }, createTransport };
});

import { verifyImapIngestionProviders } from "./imap-ingestion";
import { getNotificationWorkerConfig } from "../notification-worker";
import { testImapConfig } from "../../../tests/support/imap-config";

const smtpEnvironment = { NODE_ENV: "test", SMTP_HOST: "smtp.example.test", SMTP_USER: "orbit", SMTP_PASSWORD: "fake-password" } as NodeJS.ProcessEnv;
let warn: ReturnType<typeof vi.spyOn>;
let counter = 0;

beforeEach(() => {
  warn = vi.spyOn(log, "warn").mockImplementation(() => undefined);
  vi.spyOn(log, "info").mockImplementation(() => undefined);
  vi.spyOn(log, "error").mockImplementation(() => undefined);
});
afterEach(() => vi.restoreAllMocks());

async function reasonFor(error: unknown): Promise<unknown> {
  transport.error = error;
  await verifyImapIngestionProviders(
    testImapConfig({ password: "fake-password", host: `imap-${(counter += 1)}.example.test` }),
    getNotificationWorkerConfig(smtpEnvironment),
    { verifyImap: async () => "ready" },
  );
  const lines = warn.mock.calls.map((call: unknown[]) => call[0] as Record<string, unknown>).filter((line: Record<string, unknown>) => line.event === "mail.smtp.verify");
  expect(lines).toHaveLength(1);
  return lines[0]?.reason;
}

const smtpError = (code: string, extra: Record<string, unknown>) => Object.assign(new Error("x"), { code, ...extra });

describe("the real SMTP check classes the error it is given", () => {
  it.each([
    ["EAUTH, 535", smtpError("EAUTH", { responseCode: 535 })],
    ["534", smtpError("EPROTOCOL", { responseCode: 534 })],
    ["530", smtpError("EPROTOCOL", { responseCode: 530 })],
  ])("an authentication refusal (%s) is auth_rejected", async (_name, error) => {
    expect(await reasonFor(error)).toBe("auth_rejected");
  });

  it.each([
    ["EENVELOPE 550", smtpError("EENVELOPE", { responseCode: 550 })],
    ["EMESSAGE 554", smtpError("EMESSAGE", { responseCode: 554 })],
    ["a bare 5xx", smtpError("EPROTOCOL", { responseCode: 553 })],
  ])("a refusal that is not about sign-in (%s) is not auth_rejected", async (_name, error) => {
    expect(await reasonFor(error)).toBe("other");
  });

  it.each([
    ["connection_refused", smtpError("ECONNECTION", { originalCode: "ECONNREFUSED" })],
    ["tls_certificate", smtpError("ESOCKET", { originalCode: "DEPTH_ZERO_SELF_SIGNED_CERT" })],
    ["tls_hostname", smtpError("ESOCKET", { originalCode: "ERR_TLS_CERT_ALTNAME_INVALID" })],
    ["dns_failed", smtpError("ESOCKET", { originalCode: "ENOTFOUND" })],
  ])("a connection failure is %s, not other", async (reason, error) => {
    expect(await reasonFor(error)).toBe(reason);
  });
});
