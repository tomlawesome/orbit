/* Guards the integration suite's request-event helper (#735).
 *
 * The helper stands in for SvelteKit, so if its cookie jar silently dropped
 * writes, every integration assertion about a session cookie would still pass
 * — against a response that never carried one. That failure mode is invisible
 * in a diff, so it gets its own test: each case proves the thing can be
 * present before anything relies on its absence.
 */
import { describe, expect, it } from "vitest";

import { callRoute, createRequestEvent, loadRoute, type RouteHandler } from "../integration/support/request-event";
import { readSetCookie } from "../integration/support/set-cookie";

describe("the minimal request event", () => {
  it("gives the handler the four properties the ported routes read", async () => {
    let seen: { method: string; params: Record<string, string>; search: string; cookie: string | undefined } | undefined;
    const handler: RouteHandler = (event) => {
      seen = {
        method: event.request.method,
        params: event.params,
        search: event.url.searchParams.get("page") ?? "",
        cookie: event.cookies.get("__Host-orbit_session"),
      };
      return new Response(null, { status: 204 });
    };

    await callRoute(handler, {
      url: "http://127.0.0.1:3000/api/imap-inbox?page=2",
      method: "POST",
      params: { receiptId: "r-1" },
      headers: { cookie: "__Host-orbit_session=abc123" },
    });

    expect(seen).toEqual({ method: "POST", params: { receiptId: "r-1" }, search: "2", cookie: "abc123" });
  });

  it("attaches a cookie the handler set to the response, as SvelteKit does", async () => {
    const handler: RouteHandler = (event) => {
      event.cookies.set("__Host-orbit_session", "fresh value", {
        path: "/",
        httpOnly: true,
        secure: true,
        sameSite: "lax",
        maxAge: 600,
        priority: "high",
      });
      return new Response(null, { status: 204 });
    };

    const response = await callRoute(handler, { url: "http://127.0.0.1:3000/api/auth/login" });
    const cookie = readSetCookie(response, "__Host-orbit_session");

    expect(cookie?.value).toBe("fresh value");
    expect(cookie?.maxAge).toBe(600);
    expect(cookie?.attributes).toBe("Max-Age=600; Path=/; HttpOnly; Secure; SameSite=Lax; Priority=High");
  });

  it("reports no cookie when the handler sets none, and the assertion can tell", async () => {
    const setting: RouteHandler = (event) => {
      event.cookies.set("__Host-orbit_session", "x", { path: "/" });
      return new Response(null, { status: 204 });
    };
    const silent: RouteHandler = () => new Response(null, { status: 204 });

    /* The pair is the point: the same assertion finds it when it is there. */
    expect(readSetCookie(await callRoute(setting, { url: "http://127.0.0.1:3000/x" }), "__Host-orbit_session")).toBeDefined();
    expect(readSetCookie(await callRoute(silent, { url: "http://127.0.0.1:3000/x" }), "__Host-orbit_session")).toBeUndefined();
  });

  it("lets the handler read back a cookie it set in the same request", async () => {
    const handler: RouteHandler = (event) => {
      event.cookies.set("__Host-orbit_txn", "in flight", { path: "/api/auth/callback" });
      return new Response(event.cookies.get("__Host-orbit_txn") ?? "missing", { status: 200 });
    };

    const response = await callRoute(handler, { url: "http://127.0.0.1:3000/api/auth/login" });

    expect(await response.text()).toBe("in flight");
  });

  it("keeps the handler's own headers and status when it also sets a cookie", async () => {
    const handler: RouteHandler = (event) => {
      event.cookies.set("__Host-orbit_session", "x", { path: "/" });
      return new Response("{}", { status: 201, headers: { "cache-control": "no-store" } });
    };

    const response = await callRoute(handler, { url: "http://127.0.0.1:3000/x" });

    expect(response.status).toBe(201);
    expect(response.headers.get("cache-control")).toBe("no-store");
    expect(await response.text()).toBe("{}");
  });

  it("does not invoke anything when only the event is wanted", () => {
    const { event } = createRequestEvent({ url: "http://127.0.0.1:3000/api/health" });

    expect(event.request.method).toBe("GET");
    expect(event.params).toEqual({});
  });
});

describe("loading a ported route family", () => {
  it("resolves a real route module through SvelteKit's aliases", async () => {
    const module = await loadRoute("settings/tour");

    expect(typeof module.GET).toBe("function");
    expect(typeof module.PUT).toBe("function");
  });

  it("rejects a family that does not exist rather than answering undefined", async () => {
    await expect(loadRoute("settings/not-a-family")).rejects.toThrow();
  });
});
