import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

/*
 * `checkCommand` (ADR-0034 decision 3 as amended 2026-10-09, #1325): the
 * browser's side of the dry run. The engine answers 200 either way, with the
 * verdict in the body, and this returns null for `{}` and the refusal's words
 * for `{ refusal }`; a dry run that could not be heard refuses nothing, so the
 * real save says what went wrong. A fake fetch rather than a server: only the
 * URL, the body and the answer are read.
 */

/** @type {Array<{ status: number, body: unknown }>} */
let commandAnswers = [];
/** @type {Array<{ url: string, body: unknown }>} */
let sent = [];

beforeEach(() => {
  commandAnswers = [];
  sent = [];
  vi.stubGlobal("fetch", vi.fn(async (/** @type {string} */ url, /** @type {RequestInit} */ init) => {
    if (url === "/api/auth/session") {
      return new Response(JSON.stringify({ csrfToken: "token" }), { status: 200, headers: { "content-type": "application/json" } });
    }
    const next = commandAnswers.shift();
    if (!next) throw new Error(`no answer queued for ${url}`);
    sent.push({ url, body: JSON.parse(String(init.body)) });
    return new Response(JSON.stringify(next.body), { status: next.status, headers: { "content-type": "application/json" } });
  }));
});

afterEach(() => {
  vi.unstubAllGlobals();
  vi.resetModules();
});

async function checkCommand() {
  return (await import("../../web/src/lib/data/workspace.js")).checkCommand;
}

const command = { type: "item.upsert", householdId: "h-1", kind: "inspection", item: { title: "" } };

describe("checkCommand, the browser's dry run", () => {
  it("sends the command with dryRun beside it and answers null for an empty success", async () => {
    commandAnswers.push({ status: 200, body: {} });
    await expect((await checkCommand())(command)).resolves.toBeNull();
    expect(sent).toEqual([{ url: "/api/workspace/commands", body: { ...command, dryRun: true } }]);
  });

  it("answers the refusal's words, untouched, from a 200 verdict", async () => {
    commandAnswers.push({ status: 200, body: { refusal: { code: "item_name_missing", message: "not yet — give it a name" } } });
    await expect((await checkCommand())(command)).resolves.toBe("not yet — give it a name");
  });

  it("refuses nothing when the dry run could not be heard", async () => {
    commandAnswers.push({ status: 503, body: { error: "maintenance_active" } });
    await expect((await checkCommand())(command)).resolves.toBeNull();
  });

  it("retries once on a stale CSRF token and answers the retry's verdict", async () => {
    commandAnswers.push({ status: 403, body: { error: { code: "csrf_mismatch", message: "The request could not be verified" } } });
    commandAnswers.push({ status: 200, body: { refusal: { code: "cost_format", message: "not yet — use a dot for pence, for example 12.50" } } });
    await expect((await checkCommand())(command)).resolves.toBe("not yet — use a dot for pence, for example 12.50");
    expect(sent).toHaveLength(2);
  });
});
