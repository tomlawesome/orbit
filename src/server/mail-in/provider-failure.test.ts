import { describe, expect, it } from "vitest";
import { classifyProviderFailure } from "./provider-failure";

/*
 * #1670 A-F4 and A-F2. nodemailer overwrites the system error's `code` with
 * its own (ECONNECTION, ESOCKET) and keeps the original in `originalCode`
 * (nodemailer 10.x `_formatError`); a wrapped error may also carry it in
 * `cause`. Only an authentication refusal (535/534/530 or EAUTH) is
 * auth_rejected; no message text, host or credential is read.
 */
const nodemailerError = (code: string, originalCode: string, extra: Record<string, unknown> = {}) =>
  Object.assign(new Error("connect failed for intake@secret-host.example.test"), { code, originalCode, ...extra });

describe("a nodemailer error whose code was overwritten is classed from the code it kept (A-F4)", () => {
  it.each([
    ["connection_refused", nodemailerError("ECONNECTION", "ECONNREFUSED")],
    ["connection_refused", nodemailerError("ESOCKET", "ECONNREFUSED")],
    ["dns_failed", nodemailerError("ESOCKET", "ENOTFOUND")],
    ["dns_failed", nodemailerError("ECONNECTION", "EAI_AGAIN")],
    ["timeout", nodemailerError("ECONNECTION", "ETIMEDOUT")],
    ["tls_certificate", nodemailerError("ESOCKET", "DEPTH_ZERO_SELF_SIGNED_CERT")],
    ["tls_certificate", nodemailerError("ESOCKET", "CERT_HAS_EXPIRED")],
    ["tls_certificate", nodemailerError("ESOCKET", "UNABLE_TO_VERIFY_LEAF_SIGNATURE")],
    ["tls_hostname", nodemailerError("ESOCKET", "ERR_TLS_CERT_ALTNAME_INVALID")],
  ])("%s", (reason, error) => {
    expect(classifyProviderFailure(error)).toBe(reason);
  });

  it("reads the same code from a wrapped cause", () => {
    expect(classifyProviderFailure(Object.assign(new Error("x"), { code: "ESOCKET", cause: { code: "ECONNREFUSED" } }))).toBe("connection_refused");
    expect(classifyProviderFailure(Object.assign(new Error("x"), { code: "ECONNECTION", cause: { code: "ENOTFOUND" } }))).toBe("dns_failed");
    expect(classifyProviderFailure(Object.assign(new Error("x"), { code: "ESOCKET", cause: { code: "ERR_TLS_CERT_ALTNAME_INVALID" } }))).toBe("tls_hostname");
  });

  it("still says other when neither the code nor what it kept is known", () => {
    expect(classifyProviderFailure(nodemailerError("ESOCKET", "EWHATEVER"))).toBe("other");
  });
});

describe("only an authentication refusal is auth_rejected (A-F2)", () => {
  it.each([535, 534, 530])("SMTP %i is auth_rejected", (responseCode) => {
    expect(classifyProviderFailure(Object.assign(new Error("x"), { code: "EPROTOCOL", responseCode }))).toBe("auth_rejected");
  });

  it("EAUTH is auth_rejected", () => {
    expect(classifyProviderFailure(Object.assign(new Error("x"), { code: "EAUTH" }))).toBe("auth_rejected");
  });

  it.each([
    ["EENVELOPE", 550],
    ["EMESSAGE", 554],
    ["EPROTOCOL", 550],
  ])("%s with SMTP %i is not auth_rejected", (code, responseCode) => {
    expect(classifyProviderFailure(Object.assign(new Error("x"), { code, responseCode }))).not.toBe("auth_rejected");
  });
});

describe("an SMTP 530 is told apart by what it asks for (review follow-up, #1670)", () => {
  it("530 asking for STARTTLS is starttls_unavailable, not auth_rejected", () => {
    const error = Object.assign(new Error("x"), { code: "EPROTOCOL", responseCode: 530, response: "530 5.7.0 Must issue a STARTTLS command first" });
    expect(classifyProviderFailure(error)).toBe("starttls_unavailable");
  });

  it("530 asking for sign-in stays auth_rejected", () => {
    const error = Object.assign(new Error("x"), { code: "EPROTOCOL", responseCode: 530, response: "530 5.7.0 Authentication required" });
    expect(classifyProviderFailure(error)).toBe("auth_rejected");
  });
});
