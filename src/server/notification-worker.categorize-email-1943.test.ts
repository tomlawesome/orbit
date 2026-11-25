import { describe, expect, it } from "vitest";

import { categorizeProviderError } from "./notification-worker";

/*
 * #1943 A-F7: nodemailer 10 (smtp-connection _formatError) sets `code` to a
 * wrapper (ESOCKET, ECONNECTION, EDNS) and keeps the system code in
 * `originalCode`. src/server/invitations/send.ts reads through the wrapper;
 * categorizeProviderError must class a wrapped system error the same way as the
 * bare one, so an invitation's sendError does not differ by wrapping.
 */
const wrapped = (code: string, originalCode: string): Error =>
  Object.assign(new Error(`connect ${originalCode}`), { code, originalCode, command: "CONN" });

const SYSTEM_CODES = ["ECONNREFUSED", "ECONNRESET", "ENETUNREACH", "ENOTFOUND", "ETIMEDOUT", "EHOSTUNREACH"] as const;

describe("categorizeProviderError, email, reads nodemailer's originalCode (#1943 A-F7)", () => {
  it.each(SYSTEM_CODES)("a bare %s is smtp_unavailable (unchanged)", (code) => {
    expect(categorizeProviderError("email", Object.assign(new Error("x"), { code }))).toBe("smtp_unavailable");
  });

  it.each(SYSTEM_CODES.flatMap((original) =>
    (["ESOCKET", "ECONNECTION", "EDNS"] as const).map((code) => [code, original] as const),
  ))("%s carrying %s is smtp_unavailable, as the bare code is", (code, original) => {
    expect(categorizeProviderError("email", wrapped(code, original))).toBe("smtp_unavailable");
  });

  it("a wrapper carrying a code that is not a system failure stays unknown", () => {
    expect(categorizeProviderError("email", wrapped("ESOCKET", "EPIPE"))).toBe("unknown");
    expect(categorizeProviderError("email", wrapped("ECONNECTION", "EOTHER"))).toBe("unknown");
  });

  it("a wrapper with no originalCode stays unknown", () => {
    expect(categorizeProviderError("email", Object.assign(new Error("x"), { code: "ESOCKET" }))).toBe("unknown");
  });

  it("originalCode is read only under a wrapper code, so it cannot override a bare rejection code", () => {
    expect(categorizeProviderError("email", Object.assign(new Error("x"), { code: "EAUTH", originalCode: "ECONNREFUSED" }))).toBe("smtp_rejected");
  });
});
