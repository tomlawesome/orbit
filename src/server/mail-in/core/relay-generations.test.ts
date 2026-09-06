import { describe, expect, it } from "vitest";
import {
  activeRelayGenerations,
  assertRelayGenerationState,
  nextRelayGeneration,
  relayPreviousIsActive,
  RELAY_CUT_OFF_GRACE_MS,
  RELAY_MAX_GRACE_MS,
  RELAY_PREVIOUS_GRACE_MS,
  RelayGenerationError,
  type RelayGenerationState,
} from "./relay-generations";

const now = new Date("2026-09-06T12:00:00.000Z");
const state = (current: number, previous?: number, expiresAt?: Date): RelayGenerationState => ({
  currentGeneration: current,
  previousGeneration: previous ?? null,
  previousExpiresAt: expiresAt ?? null,
});

describe("nextRelayGeneration", () => {
  it("hands the current generation down to previous with a fourteen-day expiry", () => {
    const rotated = nextRelayGeneration(state(1), RELAY_PREVIOUS_GRACE_MS, now);
    expect(rotated).toEqual({
      currentGeneration: 2,
      previousGeneration: 1,
      previousExpiresAt: new Date("2026-09-20T12:00:00.000Z"),
    });
  });

  it("cuts the old address off immediately when the grace is zero", () => {
    const cutOff = nextRelayGeneration(state(1), RELAY_CUT_OFF_GRACE_MS, now);
    expect(cutOff.previousExpiresAt).toEqual(now);
    expect(relayPreviousIsActive(cutOff, now)).toBe(false);
  });

  it("never lowers or reuses a generation across repeated rotate and cut-off", () => {
    let current = state(1);
    const seen = [current.currentGeneration];
    for (const grace of [RELAY_PREVIOUS_GRACE_MS, RELAY_CUT_OFF_GRACE_MS, RELAY_PREVIOUS_GRACE_MS, RELAY_CUT_OFF_GRACE_MS]) {
      current = nextRelayGeneration(current, grace, now);
      seen.push(current.currentGeneration);
    }
    expect(seen).toEqual([1, 2, 3, 4, 5]);
    expect(new Set(seen).size).toBe(seen.length);
    expect(current.previousGeneration).toBe(4);
  });

  it("keeps at most one previous — the generation before it is dropped, not stacked", () => {
    const once = nextRelayGeneration(state(1), RELAY_PREVIOUS_GRACE_MS, now);
    const twice = nextRelayGeneration(once, RELAY_PREVIOUS_GRACE_MS, now);
    expect(twice.previousGeneration).toBe(2);
    expect(assertRelayGenerationState(twice)).toBe(twice);
  });

  it("accepts the administrator's ninety-day ceiling and refuses anything past it", () => {
    expect(nextRelayGeneration(state(3), RELAY_MAX_GRACE_MS, now).previousExpiresAt)
      .toEqual(new Date(now.getTime() + RELAY_MAX_GRACE_MS));
    expect(() => nextRelayGeneration(state(3), RELAY_MAX_GRACE_MS + 1, now)).toThrow(RelayGenerationError);
    expect(() => nextRelayGeneration(state(3), -1, now)).toThrow(RelayGenerationError);
  });

  it("refuses a state the database's own checks would have refused", () => {
    expect(() => nextRelayGeneration(state(0), RELAY_PREVIOUS_GRACE_MS, now)).toThrow(RelayGenerationError);
    expect(() => nextRelayGeneration(state(2, 1), RELAY_PREVIOUS_GRACE_MS, now)).toThrow(RelayGenerationError);
    expect(() => nextRelayGeneration(state(2, undefined, now), RELAY_PREVIOUS_GRACE_MS, now)).toThrow(RelayGenerationError);
    expect(() => nextRelayGeneration(state(2, 2, now), RELAY_PREVIOUS_GRACE_MS, now)).toThrow(RelayGenerationError);
  });

  it("says nothing about the key, the digest or the address when it refuses", () => {
    const error = new RelayGenerationError();
    expect(error.message).toBe("The relay generation state is invalid");
    expect(error.code).toBe("relay_generation_invalid");
  });
});

describe("activeRelayGenerations", () => {
  it("offers the previous generation only while its explicit expiry is in the future", () => {
    const rotated = nextRelayGeneration(state(1), RELAY_PREVIOUS_GRACE_MS, now);
    expect(activeRelayGenerations(rotated, now)).toEqual([2, 1]);
    expect(activeRelayGenerations(rotated, new Date(rotated.previousExpiresAt!.getTime() - 1))).toEqual([2, 1]);
    expect(activeRelayGenerations(rotated, rotated.previousExpiresAt!)).toEqual([2]);
    expect(activeRelayGenerations(rotated, new Date(rotated.previousExpiresAt!.getTime() + 1))).toEqual([2]);
  });

  it("offers only the current generation for a relay that has never rotated", () => {
    expect(activeRelayGenerations(state(1), now)).toEqual([1]);
  });
});
