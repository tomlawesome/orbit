import { describe, expect, it } from "vitest";

import {
  DOOR, FAILED, STARTING, UNCONFIGURED,
  availabilityOf, doorMessageFor, failedMessage, nextDoorState, readinessOf,
} from "$lib/flight/door-state.js";

/*
 * The three states the sign-in door can be in (#788), pinned without a
 * browser: the ratified wording (design/v19/signin-states/round-1/
 * README.md, direction C, owner-ratified 2026-09-06), the unset-address
 * fallback #860 makes possible, and the precedence that decides which state
 * wins when more than one check has an opinion.
 */

describe("reading /api/health's public body", () => {
  it("recognises all three readiness words", () => {
    expect(readinessOf({ status: "ready" })).toBe("ready");
    expect(readinessOf({ status: "degraded" })).toBe("degraded");
    expect(readinessOf({ status: "maintenance" })).toBe("maintenance");
  });

  it("trusts nothing it cannot parse: not a fourth state, just unreadable", () => {
    expect(readinessOf(null)).toBeNull();
    expect(readinessOf(undefined)).toBeNull();
    expect(readinessOf("ready")).toBeNull();
    expect(readinessOf({ status: "starting-up" })).toBeNull();
    expect(readinessOf({})).toBeNull();
  });
});

describe("reading /api/auth/availability's public body", () => {
  it("reads configured and the contact address, and nothing else", () => {
    expect(availabilityOf({ configured: true, contactAddress: null })).toEqual({
      configured: true, contactAddress: null,
    });
    expect(availabilityOf({ configured: false, contactAddress: "ops@example.com" })).toEqual({
      configured: false, contactAddress: "ops@example.com",
    });
  });

  it("drops any field beyond the two it knows, however the body is shaped", () => {
    const hostile = "provider-secret-sentinel.invalid/private-tenant";
    const answer = availabilityOf({
      configured: false,
      contactAddress: null,
      error: { code: "auth_not_configured", message: hostile, provider: hostile },
    });
    expect(answer).toEqual({ configured: false, contactAddress: null });
    expect(JSON.stringify(answer)).not.toContain(hostile);
  });

  it("is unreadable without a boolean configured field", () => {
    expect(availabilityOf(null)).toBeNull();
    expect(availabilityOf({})).toBeNull();
    expect(availabilityOf({ configured: "true" })).toBeNull();
  });

  it("treats a non-string contact address as absent rather than guessing", () => {
    expect(availabilityOf({ configured: true, contactAddress: 12345 })).toEqual({
      configured: true, contactAddress: null,
    });
  });
});

describe("deciding the door's next state", () => {
  it("opens the door when ready and configured", () => {
    expect(nextDoorState({ readiness: "ready", availability: { configured: true, contactAddress: null } }))
      .toBe(DOOR);
  });

  it("treats maintenance as healthy for the door's own purposes", () => {
    expect(nextDoorState({ readiness: "maintenance", availability: { configured: true, contactAddress: null } }))
      .toBe(DOOR);
  });

  it("is starting whenever readiness is degraded, whatever availability says", () => {
    expect(nextDoorState({ readiness: "degraded", availability: null })).toBe(STARTING);
    expect(nextDoorState({ readiness: "degraded", availability: { configured: true, contactAddress: null } }))
      .toBe(STARTING);
  });

  it("names the unconfigured state on its own, distinct from a hard failure", () => {
    expect(nextDoorState({ readiness: "ready", availability: { configured: false, contactAddress: null } }))
      .toBe(UNCONFIGURED);
  });

  it("fails closed when readiness could not be read at all", () => {
    expect(nextDoorState({ readiness: null, availability: null })).toBe(FAILED);
  });

  it("fails closed when availability could not be read, even though readiness was fine", () => {
    expect(nextDoorState({ readiness: "ready", availability: null })).toBe(FAILED);
  });
});

describe("the door's fixed wording", () => {
  it("uses the owner's exact ratified words for the first two states", () => {
    expect(doorMessageFor(UNCONFIGURED)).toEqual({
      primary: "Sign-in isn’t set up yet.",
      sub: "The administrator needs to configure authentication before the door can open.",
    });
    expect(doorMessageFor(STARTING)).toEqual({
      primary: "Orbit is waking up.",
      sub: "Sign-in will appear by itself in a moment.",
    });
  });

  it("names the address when one is set", () => {
    expect(failedMessage("ops@example.com")).toEqual({
      primary: "Orbit couldn’t open safely.",
      sub: "It’s not you, it’s us. If it keeps happening, let us know at ops@example.com.",
    });
  });

  it("drops the whole second sentence when no address is set (#860) — no empty address, no dangling \"at\"", () => {
    expect(failedMessage(null)).toEqual({
      primary: "Orbit couldn’t open safely.",
      sub: "It’s not you, it’s us.",
    });
    expect(failedMessage(undefined)).toEqual({
      primary: "Orbit couldn’t open safely.",
      sub: "It’s not you, it’s us.",
    });
    expect(failedMessage("")).toEqual({
      primary: "Orbit couldn’t open safely.",
      sub: "It’s not you, it’s us.",
    });
    expect(failedMessage("   ")).toEqual({
      primary: "Orbit couldn’t open safely.",
      sub: "It’s not you, it’s us.",
    });
  });

  it("never echoes anything but its own words and the address it was handed", () => {
    // Simulates a body that slipped a hostile string past availabilityOf --
    // proving the property holds even if that guard were ever weakened.
    const hostile = "provider-secret-sentinel.invalid/private-tenant";
    const message = doorMessageFor(FAILED, hostile);
    expect(message.sub).toContain(hostile); // the address itself is meant to show
    expect(message.sub).not.toContain("error");
    expect(message.primary).not.toContain(hostile);

    const withoutAddress = doorMessageFor(UNCONFIGURED, hostile);
    expect(JSON.stringify(withoutAddress)).not.toContain(hostile);
  });

  it("renders the door itself as empty words, never a placeholder string", () => {
    expect(doorMessageFor(DOOR)).toEqual({ primary: "", sub: "" });
  });
});
