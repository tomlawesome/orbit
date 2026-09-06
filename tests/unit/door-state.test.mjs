import { describe, expect, it } from "vitest";

import {
  DOOR, FAILED, STARTING, STARTING_BACKSTOP_MS, UNCONFIGURED,
  applyStartingBackstop, availabilityOf, doorMessageFor, failedMessage, nextDoorState, phaseOf, readinessOf,
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

describe("reading /api/auth/availability's phase field (#869)", () => {
  it("recognises both boot-phase words", () => {
    expect(phaseOf({ phase: "starting" })).toBe("starting");
    expect(phaseOf({ phase: "running" })).toBe("running");
  });

  it("trusts nothing it cannot parse: not a third state, just unreadable", () => {
    expect(phaseOf(null)).toBeNull();
    expect(phaseOf(undefined)).toBeNull();
    expect(phaseOf("starting")).toBeNull();
    expect(phaseOf({ phase: "booting" })).toBeNull();
    expect(phaseOf({})).toBeNull();
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

describe("deciding the door's next state (#869: phase, not readiness, decides starting)", () => {
  it("opens the door when running, ready and configured", () => {
    expect(nextDoorState({ phase: "running", readiness: "ready", availability: { configured: true, contactAddress: null } }))
      .toBe(DOOR);
  });

  it("treats maintenance as healthy for the door's own purposes", () => {
    expect(nextDoorState({ phase: "running", readiness: "maintenance", availability: { configured: true, contactAddress: null } }))
      .toBe(DOOR);
  });

  it("is starting whenever phase is starting, whatever readiness or availability say (criterion 1)", () => {
    expect(nextDoorState({ phase: "starting", readiness: null, availability: null })).toBe(STARTING);
    expect(nextDoorState({ phase: "starting", readiness: "degraded", availability: null })).toBe(STARTING);
    expect(nextDoorState({ phase: "starting", readiness: "ready", availability: { configured: true, contactAddress: null } }))
      .toBe(STARTING);
  });

  it("names the unconfigured state on its own, distinct from a hard failure", () => {
    expect(nextDoorState({ phase: "running", readiness: "ready", availability: { configured: false, contactAddress: null } }))
      .toBe(UNCONFIGURED);
  });

  it("fails at once, not waiting, when phase is running but readiness is degraded (criterion 2: boot is done, the database is the problem)", () => {
    expect(nextDoorState({ phase: "running", readiness: "degraded", availability: { configured: true, contactAddress: null } }))
      .toBe(FAILED);
  });

  it("fails closed when phase is running but readiness could not be read at all", () => {
    expect(nextDoorState({ phase: "running", readiness: null, availability: null })).toBe(FAILED);
  });

  it("fails closed when phase itself could not be read, regardless of anything else", () => {
    expect(nextDoorState({ phase: null, readiness: "ready", availability: { configured: true, contactAddress: null } }))
      .toBe(FAILED);
  });

  it("fails closed when running and ready but availability could not be read", () => {
    expect(nextDoorState({ phase: "running", readiness: "ready", availability: null })).toBe(FAILED);
  });
});

describe("the STARTING backstop (#869, criterion 3): a pure decision over a passed-in clock, not a wall-clock wait", () => {
  it("keeps polling before the deadline", () => {
    expect(applyStartingBackstop(STARTING, 1_000, 999)).toBe(STARTING);
  });

  it("fails at the deadline, not only strictly after it", () => {
    expect(applyStartingBackstop(STARTING, 1_000, 1_000)).toBe(FAILED);
  });

  it("fails once the deadline has passed", () => {
    expect(applyStartingBackstop(STARTING, 1_000, 1_001)).toBe(FAILED);
  });

  it("leaves a state that is no longer STARTING unaffected, whatever the clock says", () => {
    expect(applyStartingBackstop(DOOR, 1_000, 5_000)).toBe(DOOR);
    expect(applyStartingBackstop(UNCONFIGURED, 1_000, 5_000)).toBe(UNCONFIGURED);
    expect(applyStartingBackstop(FAILED, 1_000, 0)).toBe(FAILED);
  });

  it("is bounded at 2 minutes, matching the issue's own words", () => {
    expect(STARTING_BACKSTOP_MS).toBe(120_000);
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
