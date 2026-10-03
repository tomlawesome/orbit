import { describe, expect, it } from "vitest";

import { WorkspaceError, json } from "../../web/src/lib/data/workspace.js";

/*
 * #1151 W2-R3: `json()` is the one place every caller in workspace.js decodes
 * a fetch response. A non-2xx with an unparseable body already fell back to
 * a generic "could not be reached" WorkspaceError — but a 2xx with an
 * unparseable body (a proxy restart, a cached offline page a service worker
 * answered with status 200, anything that isn't the real route) used to
 * return `null` straight through, and every caller dereferences that
 * immediately, so the reader saw their own bare TypeError instead of a
 * message naming the real problem.
 *
 * Fakes rather than a real Response: only `ok`, `status` and `json()` are
 * ever read.
 */

/** @param {{ ok: boolean, status: number, body: unknown, parseFails?: boolean }} shape */
function fakeResponse({ ok, status, body, parseFails = false }) {
  return {
    ok,
    status,
    json: async () => {
      if (parseFails) throw new SyntaxError("Unexpected end of JSON input");
      return body;
    },
  };
}

describe("json() on a 2xx response", () => {
  it("returns the decoded body when it parses", async () => {
    const response = fakeResponse({ ok: true, status: 200, body: { hello: "world" } });
    await expect(json(response)).resolves.toEqual({ hello: "world" });
  });

  it("raises the same 'could not be reached' error a non-2xx with no body raises, rather than returning null", async () => {
    const response = fakeResponse({ ok: true, status: 200, parseFails: true });
    await expect(json(response)).rejects.toBeInstanceOf(WorkspaceError);
    await expect(json(response)).rejects.toMatchObject({
      message: "Orbit could not be reached (200)",
      status: 200,
    });
  });
});

describe("json() on a non-2xx response", () => {
  it("throws a WorkspaceError carrying the server's own message and code", async () => {
    const response = fakeResponse({
      ok: false,
      status: 422,
      body: { error: { message: "That name is taken", code: "name_taken" } },
    });
    await expect(json(response)).rejects.toMatchObject({
      message: "That name is taken",
      status: 422,
      code: "name_taken",
    });
  });

  it("falls back to a generic message when the body cannot be read at all", async () => {
    const response = fakeResponse({ ok: false, status: 502, parseFails: true });
    await expect(json(response)).rejects.toMatchObject({
      message: "Orbit could not be reached (502)",
      status: 502,
    });
  });
});
