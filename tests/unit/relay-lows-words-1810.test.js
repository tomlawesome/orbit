import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

/*
 * #1810 W-R1 and W-S1/S2/S3 (note 57316), the parts that need no browser.
 *
 * W-R1: a relay read that failed is a state of its own (`unavailable`), not
 * "no address yet". The settings read stays additive: it still answers, with
 * the unavailable relay, when the relay endpoint is down.
 * W-S: removing a sending address is arm-then-tap, and the armed line says
 * what is lost (held mail) and how to come back.
 */
const WORKSPACE_BODY = { workspace: { households: [], activeHouseholdId: null, fixtureToday: "2026-10-03" } };

/** @param {Response} relayAnswer */
function stubFetch(relayAnswer) {
  vi.stubGlobal("fetch", vi.fn(async (url) => {
    const href = String(url);
    if (href.includes("/api/auth/session")) return new Response("", { status: 503 });
    if (href.includes("/api/workspace")) return new Response(JSON.stringify(WORKSPACE_BODY), { status: 200 });
    if (href.includes("/api/imap-inbox")) return new Response(JSON.stringify({ receipts: [] }), { status: 200 });
    if (href.includes("/api/settings/mail-relay")) return relayAnswer;
    return new Response("{}", { status: 404 });
  }));
}

beforeEach(() => vi.resetModules());
afterEach(() => vi.unstubAllGlobals());

describe("W-R1: relayShape knows a relay that could not be read", () => {
  it("the unavailable relay (a failed read) is unavailable, and is not 'unset'", async () => {
    stubFetch(new Response("{}", { status: 503 }));
    const { readSettingsScreen } = await import("../../web/src/lib/data/workspace.js");
    const { relayShape } = await import("../../web/src/routes/settings/relay-shape.js");
    const { relay } = await readSettingsScreen();
    const shape = relayShape(relay);
    expect(shape.unavailable).toBe(true);
    expect(shape.unset).toBe(false);
    expect(shape.mailbox).toBe(false);
    expect(shape.usable).toBe(false);
  });

  it.each([
    ["a usable relay", { address: "orbit+k7q2@harlow.example", status: "connected · listening", ingest: "enabled" }],
    ["a paused relay", { address: "orbit+k7q2@harlow.example", status: "connected · listening", ingest: "paused" }],
    ["no mailbox set up", { address: "no address yet", status: "not listening", ingest: "enabled" }],
  ])("%s is not unavailable", async (_name, relay) => {
    const { relayShape } = await import("../../web/src/routes/settings/relay-shape.js");
    expect(relayShape(/** @type {any} */ (relay)).unavailable).toBe(false);
  });

  it("holds the one line both layouts say", async () => {
    const mod = await import("../../web/src/routes/settings/relay-shape.js");
    expect(mod.RELAY_NOT_READ).toBe("not shown — Orbit could not reach your relay");
  });
});

describe("W-S1/S2: the remove words", () => {
  it("the armed label is 'tap again to remove'", async () => {
    const { REMOVE_ARMED } = await import("../../web/src/routes/settings/mail/sender.js");
    expect(REMOVE_ARMED).toBe("tap again to remove");
  });

  it("with no held mail it says only how to come back", async () => {
    const { removeArmedWords } = await import("../../web/src/routes/settings/mail/sender.js");
    expect(removeArmedWords(/** @type {any} */ ({ heldMail: 0 }))).toBe("to use it again, add it back and open a new check email");
  });

  it("one held arrival is 'is lost for good'", async () => {
    const { removeArmedWords } = await import("../../web/src/routes/settings/mail/sender.js");
    expect(removeArmedWords(/** @type {any} */ ({ heldMail: 1 }))).toBe(
      "1 arrival held for this address is lost for good · to use it again, add it back and open a new check email",
    );
  });

  it("three held arrivals are 'are lost for good'", async () => {
    const { removeArmedWords } = await import("../../web/src/routes/settings/mail/sender.js");
    expect(removeArmedWords(/** @type {any} */ ({ heldMail: 3 }))).toBe(
      "3 arrivals held for this address are lost for good · to use it again, add it back and open a new check email",
    );
  });
});
