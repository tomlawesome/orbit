import { describe, expect, it, vi } from "vitest";

/* #1688: a body that is not JSON gets 400 invalid_json from every wrapped
   route, in the shared envelope and in the auth routes' own, and is not
   logged as Orbit failing. */
const logged = vi.hoisted(() => []);
vi.mock("$env/dynamic/private", () => ({ env: {} }));
vi.mock("orbit/server/key-state", () => ({ assertKeyUsable: () => {}, noteRefusedSignIn: () => {} }));
vi.mock("orbit/lib/logger", async (importOriginal) => {
  const actual = await importOriginal();
  return { ...actual, log: { ...actual.log, error: (entry) => logged.push(entry), warn: () => {}, info: () => {} } };
});

const { api } = await import("../../web/src/lib/server/api.js");
const { authErrorResponse } = await import("orbit/lib/auth/http");

const event = (body) => ({
  request: new Request("http://orbit.test/api/x", { method: "POST", headers: { "content-type": "application/json" }, body }),
  route: { id: "/api/x" },
});
const reads = api(async (e) => Response.json({ got: await e.request.json() }));

describe("a malformed JSON body (#1688)", () => {
  it("gets 400 invalid_json, no-store, and logs no application error", async () => {
    logged.length = 0;
    const response = await reads(event("{nope"));
    expect(response.status).toBe(400);
    expect(response.headers.get("cache-control")).toBe("no-store");
    expect((await response.json()).error.code).toBe("invalid_json");
    expect(logged.filter((entry) => entry.event === "application.error")).toEqual([]);
  });

  it("gets the same 400 through the auth routes' envelope", async () => {
    const response = await api(async (e) => Response.json(await e.request.json()), { errorResponse: authErrorResponse })(event("{nope"));
    expect(response.status).toBe(400);
    expect((await response.json()).error.code).toBe("invalid_json");
  });

  it("leaves a good body alone", async () => {
    const response = await reads(event('{"a":1}'));
    expect(await response.json()).toEqual({ got: { a: 1 } });
  });

  it("leaves a route's own error after parsing as Orbit's 500", async () => {
    const response = await api(async (e) => { await e.request.json(); throw new SyntaxError("Orbit's own bug"); })(event("{}"));
    expect(response.status).toBe(500);
  });

  it("still lets a route catch it itself", async () => {
    const response = await api(async (e) => Response.json({ body: await e.request.json().catch(() => null) }))(event("{nope"));
    expect(await response.json()).toEqual({ body: null });
  });
});
