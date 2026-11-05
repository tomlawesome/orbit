import { beforeEach, describe, expect, it, vi } from "vitest";

/*
 * `POST /api/auth/approve` (#1033, ADR-0027 §4): the one press that decides a
 * pending sign-in. Signed out by design (the token in the body is the whole
 * authorisation) but same-origin only. It is a POST so a mail scanner opening
 * the link approves nothing. Any decision other than "denied" is "approved";
 * the answer is a no-store JSON body; one generic refusal for any bad token.
 */
const mocks = vi.hoisted(() => ({
  getAuthConfig: vi.fn(),
  decideSignInApproval: vi.fn(),
  assertKeyUsable: vi.fn(),
}));

vi.mock("orbit/lib/env", () => ({ getAuthConfig: mocks.getAuthConfig }));
vi.mock("orbit/server/sign-in-approvals", () => ({ decideSignInApproval: mocks.decideSignInApproval }));
vi.mock("orbit/server/key-state", () => ({ assertKeyUsable: mocks.assertKeyUsable, noteRefusedSignIn: vi.fn() }));

const { POST } = await import("../../web/src/routes/api/auth/approve/+server.js");
const { AuthError } = await import("orbit/lib/auth/errors");

const config = { appUrl: new URL("https://orbit.example") };

function event(body, headers = { origin: "https://orbit.example" }) {
  return {
    cookies: { get: vi.fn() },
    request: new Request("https://orbit.example/api/auth/approve", {
      method: "POST",
      headers,
      body: typeof body === "string" ? body : JSON.stringify(body),
    }),
  };
}

beforeEach(() => {
  for (const m of Object.values(mocks)) m.mockReset();
  mocks.getAuthConfig.mockReturnValue(config);
  mocks.decideSignInApproval.mockResolvedValue({ recorded: true });
});

describe("POST /api/auth/approve", () => {
  it("records an approval for a signed-out, same-origin caller; JSON and no-store", async () => {
    const response = await POST(event({ token: "tok", decision: "approved" }));
    expect(response.status).toBe(200);
    expect(response.headers.get("content-type")).toContain("application/json");
    expect(response.headers.get("cache-control")).toBe("no-store");
    expect(await response.json()).toEqual({ recorded: true, decision: "approved" });
    expect(mocks.decideSignInApproval).toHaveBeenCalledWith("tok", "approved");
  });

  it("records a denial only for the exact decision 'denied'", async () => {
    const response = await POST(event({ token: "tok", decision: "denied" }));
    expect(await response.json()).toEqual({ recorded: true, decision: "denied" });
    expect(mocks.decideSignInApproval).toHaveBeenCalledWith("tok", "denied");

    // Anything else, however close, is an approval: no case folding, no
    // trimming, no pass-through of the raw value, no truthiness.
    for (const decision of ["DENIED", "Denied", " denied", "deny", "junk", true, 1, ["denied"], undefined]) {
      mocks.decideSignInApproval.mockClear();
      const other = await POST(event({ token: "tok", decision }));
      expect(await other.json(), String(decision)).toEqual({ recorded: true, decision: "approved" });
      expect(mocks.decideSignInApproval).toHaveBeenCalledWith("tok", "approved");
    }
  });

  it("answers recorded:false as the engine says, still 200 (one generic answer for a spent token)", async () => {
    mocks.decideSignInApproval.mockResolvedValue({ recorded: false });
    const response = await POST(event({ token: "spent", decision: "approved" }));
    expect(response.status).toBe(200);
    expect((await response.json()).recorded).toBe(false);
  });

  it("passes an empty token for a missing, non-string or malformed body, never a coerced value", async () => {
    await POST(event({ decision: "approved" }));
    await POST(event({ token: 42 }));
    await POST(event("not json"));
    await POST(event("null"));
    expect(mocks.decideSignInApproval.mock.calls.map((c) => c[0])).toEqual(["", "", "", ""]);
  });

  it("surfaces the engine's refusal in the auth envelope", async () => {
    mocks.decideSignInApproval.mockRejectedValue(new AuthError("invalid_request", "bad", 400));
    const response = await POST(event({ token: "", decision: "approved" }));
    expect(response.status).toBe(400);
    expect((await response.json()).error.code).toBe("invalid_request");
  });

  it("refuses a cross-origin post with 403 csrf_failed and decides nothing", async () => {
    const response = await POST(event({ token: "tok" }, { origin: "https://evil.example" }));
    expect(response.status).toBe(403);
    expect((await response.json()).error.code).toBe("csrf_failed");
    expect(mocks.decideSignInApproval).not.toHaveBeenCalled();
  });

  it("refuses a post with no Origin header", async () => {
    const response = await POST(event({ token: "tok" }, {}));
    expect(response.status).toBe(403);
    expect(mocks.decideSignInApproval).not.toHaveBeenCalled();
  });

  it("refuses a cross-site fetch even when the Origin looks right", async () => {
    const response = await POST(event({ token: "tok" }, { origin: "https://orbit.example", "sec-fetch-site": "cross-site" }));
    expect(response.status).toBe(403);
    expect(mocks.decideSignInApproval).not.toHaveBeenCalled();
  });
});
