import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

// #1354 part 2: the household page's member acts (ownerLeave, act, handOver,
// decide, offer, nameOk) live once in web/src/routes/household/[id]/acts.js and
// both shapes (desk +page.svelte, pocket pocket.svelte) use it. The behaviour
// must not change: same requests, same words, same results on success, refusal
// and failure.
//
// The module's contract as these tests fix it (the desk and the pocket keep the
// parts that differ -- which state or wake shows the words -- as callbacks):
//   createActs({ householdId: () => string, clear(), fail(words), refresh() })
//     .act(run, done?)            clear; await run(); await done?.(); await refresh();
//                                 any throw -> fail(wordsOf(error)), no refresh
//     .handOver(taker, done?)     no taker: nothing at all; else act(transfer, done)
//     .decide(request, action, done?)   act(decideJoinRequest, done)
//     .offer(email)               trimmed; empty -> null with no request;
//                                 else sendInvitation and resolves its invitation
//                                 (a throw reaches the caller: the desk wraps it
//                                 in act, the pocket in its own catch)
//   createOwnerLeave(setRefused, ms = 6000)  -> function: set(true), then set(false)
//                                 after ms; a second press restarts the clock
//   nameOk(typed, householdName)  the server's own check, trimmed on both sides

const api = vi.hoisted(() => ({
  removeMember: vi.fn(),
  transferOwnership: vi.fn(),
  decideJoinRequest: vi.fn(),
  sendInvitation: vi.fn(),
}));
vi.mock("$lib/data/workspace.js", async (importActual) => ({ ...(await importActual()), ...api }));

import { WorkspaceError } from "$lib/data/workspace.js";
import { createActs, createOwnerLeave, nameOk } from "../../web/src/routes/household/[id]/acts.js";

const refusal = () => new WorkspaceError("Only the owner can do that.", 403, "forbidden");

/** @param {string} id */
function setup(id = "h-1") {
  const ui = { clear: vi.fn(), fail: vi.fn(), refresh: vi.fn(async () => {}) };
  return { ui, acts: createActs({ householdId: () => id, ...ui }) };
}

beforeEach(() => { for (const fn of Object.values(api)) fn.mockReset().mockResolvedValue({}); });

describe("act", () => {
  it("clears the old problem, runs, then calls done, then refreshes, in that order", async () => {
    const { acts, ui } = setup();
    const order = [];
    ui.clear.mockImplementation(() => order.push("clear"));
    ui.refresh.mockImplementation(async () => { order.push("refresh"); });
    await acts.act(async () => { order.push("run"); }, () => { order.push("done"); });
    expect(order).toEqual(["clear", "run", "done", "refresh"]);
    expect(ui.fail).not.toHaveBeenCalled();
  });

  it("works without a done callback", async () => {
    const { acts, ui } = setup();
    await acts.act(async () => {});
    expect(ui.refresh).toHaveBeenCalledOnce();
  });

  it("on a server refusal says the server's words and neither runs done nor refreshes", async () => {
    const { acts, ui } = setup();
    const done = vi.fn();
    await acts.act(async () => { throw refusal(); }, done);
    expect(ui.fail).toHaveBeenCalledWith("Only the owner can do that.");
    expect(done).not.toHaveBeenCalled();
    expect(ui.refresh).not.toHaveBeenCalled();
  });

  it("on a network failure says the error's message, or the screen's fallback when it has none", async () => {
    const { acts, ui } = setup();
    await acts.act(async () => { throw new TypeError("Failed to fetch"); });
    expect(ui.fail).toHaveBeenLastCalledWith("Failed to fetch");
    await acts.act(async () => { throw undefined; });
    expect(ui.fail).toHaveBeenLastCalledWith("Something went wrong.");
  });

  it("does not reject: a failure is told, not thrown", async () => {
    const { acts } = setup();
    await expect(acts.act(async () => { throw new Error("x"); })).resolves.toBeUndefined();
  });

  it("a failing refresh is told like any other failure", async () => {
    const { acts, ui } = setup();
    ui.refresh.mockRejectedValue(new Error("reload failed"));
    await acts.act(async () => {});
    expect(ui.fail).toHaveBeenCalledWith("reload failed");
  });
});

describe("handOver", () => {
  it("asks the server to transfer this household to the taker, then done and refresh", async () => {
    const { acts, ui } = setup("h-9");
    const done = vi.fn();
    await acts.handOver({ id: "u-2", name: "Sam" }, done);
    expect(api.transferOwnership).toHaveBeenCalledWith("h-9", "u-2");
    expect(done).toHaveBeenCalledOnce();
    expect(ui.refresh).toHaveBeenCalledOnce();
  });

  it("does nothing at all when nobody was chosen", async () => {
    const { acts, ui } = setup();
    for (const none of [null, undefined]) await acts.handOver(none, vi.fn());
    expect(api.transferOwnership).not.toHaveBeenCalled();
    expect(ui.clear).not.toHaveBeenCalled();
    expect(ui.refresh).not.toHaveBeenCalled();
  });

  it("on a refusal tells it and does not say it was handed over", async () => {
    const { acts, ui } = setup();
    const done = vi.fn();
    api.transferOwnership.mockRejectedValue(refusal());
    await acts.handOver({ id: "u-2", name: "Sam" }, done);
    expect(ui.fail).toHaveBeenCalledWith("Only the owner can do that.");
    expect(done).not.toHaveBeenCalled();
  });

  it("on a network failure tells it", async () => {
    const { acts, ui } = setup();
    api.transferOwnership.mockRejectedValue(new TypeError("Failed to fetch"));
    await acts.handOver({ id: "u-2", name: "Sam" });
    expect(ui.fail).toHaveBeenCalledWith("Failed to fetch");
  });
});

describe("decide", () => {
  it.each(["approve", "decline"])("sends %s for the request's own id (not the household's)", async (action) => {
    const { acts, ui } = setup();
    const done = vi.fn();
    await acts.decide({ id: "jr-4", name: "Ada" }, action, done);
    expect(api.decideJoinRequest).toHaveBeenCalledWith("jr-4", action);
    expect(done).toHaveBeenCalledOnce();
    expect(ui.refresh).toHaveBeenCalledOnce();
  });

  it("on a refusal tells it and does not call done", async () => {
    const { acts, ui } = setup();
    const done = vi.fn();
    api.decideJoinRequest.mockRejectedValue(refusal());
    await acts.decide({ id: "jr-4", name: "Ada" }, "approve", done);
    expect(ui.fail).toHaveBeenCalledWith("Only the owner can do that.");
    expect(done).not.toHaveBeenCalled();
    expect(ui.refresh).not.toHaveBeenCalled();
  });

  it("on a network failure tells it", async () => {
    const { acts, ui } = setup();
    api.decideJoinRequest.mockRejectedValue(new TypeError("Failed to fetch"));
    await acts.decide({ id: "jr-4", name: "Ada" }, "decline");
    expect(ui.fail).toHaveBeenCalledWith("Failed to fetch");
  });
});

describe("offer", () => {
  const sent = { invitation: { email: "ada@example.com", sentAt: "2026-11-24T10:00:00Z" } };

  it("sends to the trimmed address for this household and resolves the invitation the server made", async () => {
    const { acts } = setup("h-3");
    api.sendInvitation.mockResolvedValue(sent);
    await expect(acts.offer("  ada@example.com \n")).resolves.toEqual(sent.invitation);
    expect(api.sendInvitation).toHaveBeenCalledWith("h-3", "ada@example.com");
  });

  it("resolves the invitation even when the mail could not be sent (sentAt empty): the caller words it", async () => {
    const { acts } = setup();
    const unsent = { invitation: { email: "ada@example.com", sentAt: null } };
    api.sendInvitation.mockResolvedValue(unsent);
    await expect(acts.offer("ada@example.com")).resolves.toEqual(unsent.invitation);
  });

  it.each(["", "   ", "\t\n"])("sends nothing for an empty address %j", async (blank) => {
    const { acts, ui } = setup();
    await expect(acts.offer(blank)).resolves.toBeNull();
    expect(api.sendInvitation).not.toHaveBeenCalled();
    expect(ui.clear).not.toHaveBeenCalled();
    expect(ui.refresh).not.toHaveBeenCalled();
  });

  it("lets a refusal and a network failure reach the caller, who owns how they are told", async () => {
    const { acts, ui } = setup();
    api.sendInvitation.mockRejectedValueOnce(refusal());
    await expect(acts.offer("ada@example.com")).rejects.toThrow("Only the owner can do that.");
    api.sendInvitation.mockRejectedValueOnce(new TypeError("Failed to fetch"));
    await expect(acts.offer("ada@example.com")).rejects.toThrow("Failed to fetch");
    expect(ui.fail).not.toHaveBeenCalled();
  });
});

describe("ownerLeave", () => {
  beforeEach(() => vi.useFakeTimers());
  afterEach(() => vi.useRealTimers());

  it("refuses at once and lets go after six seconds", () => {
    const set = vi.fn();
    createOwnerLeave(set)();
    expect(set).toHaveBeenCalledTimes(1);
    expect(set).toHaveBeenLastCalledWith(true);
    vi.advanceTimersByTime(5999);
    expect(set).toHaveBeenCalledTimes(1);
    vi.advanceTimersByTime(1);
    expect(set).toHaveBeenLastCalledWith(false);
  });

  it("a second press restarts the clock instead of letting the first one clear it early", () => {
    const set = vi.fn();
    const press = createOwnerLeave(set);
    press();
    vi.advanceTimersByTime(4000);
    press();
    vi.advanceTimersByTime(4000);
    expect(set).not.toHaveBeenCalledWith(false);
    vi.advanceTimersByTime(2000);
    expect(set.mock.calls.filter(([on]) => on === false)).toHaveLength(1);
  });

  it("makes no request of any kind", () => {
    createOwnerLeave(vi.fn())();
    for (const fn of Object.values(api)) expect(fn).not.toHaveBeenCalled();
  });
});

describe("nameOk", () => {
  it("accepts the exact name, and edge spaces on either side", () => {
    expect(nameOk("Harlow Home", "Harlow Home")).toBe(true);
    expect(nameOk("  Harlow Home ", "Harlow Home")).toBe(true);
    expect(nameOk("Harlow Home", " Harlow Home  ")).toBe(true);
  });

  it("rejects a different case, a partial name, and inner spacing", () => {
    expect(nameOk("harlow home", "Harlow Home")).toBe(false);
    expect(nameOk("Harlow", "Harlow Home")).toBe(false);
    expect(nameOk("Harlow  Home", "Harlow Home")).toBe(false);
  });

  it("rejects an empty or missing typed name, and never matches a household with no name", () => {
    expect(nameOk("", "Harlow Home")).toBe(false);
    expect(nameOk(null, "Harlow Home")).toBe(false);
    expect(nameOk(undefined, "Harlow Home")).toBe(false);
    expect(nameOk("", "")).toBe(false);
    expect(nameOk("  ", "  ")).toBe(false);
    expect(nameOk("x", null)).toBe(false);
    expect(nameOk("", undefined)).toBe(false);
  });
});
