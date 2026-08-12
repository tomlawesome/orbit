import { describe, expect, it } from "vitest";
import {
  ImapRotationStaleError,
  decideImapRotationState,
  type ImapRotationConfigState,
  type ImapRotationState,
} from "./imap-rotation";

const now = new Date("2026-07-29T12:00:00.000Z");
const expiresAt = new Date("2026-07-30T12:00:00.000Z");

function state(currentGeneration: number, previousGeneration: number | null = null, previousExpiresAt: Date | null = null): ImapRotationState {
  return {
    currentGeneration,
    currentCommitment: `commitment-${currentGeneration}`,
    previousGeneration,
    previousExpiresAt,
    previousCommitment: previousGeneration === null ? null : `commitment-${previousGeneration}`,
  };
}

function config(currentGeneration: number, previousGeneration?: number, previousExpiresAt?: Date, currentCommitment = `commitment-${currentGeneration}`): ImapRotationConfigState {
  return {
    currentGeneration,
    currentCommitment,
    previousGeneration,
    previousExpiresAt,
    previousCommitment: previousGeneration === undefined ? undefined : `commitment-${previousGeneration}`,
  };
}

describe("persisted IMAP alias rotation state", () => {
  it("allows one G1 to G2 overlap and never keeps more than one previous generation", () => {
    expect(decideImapRotationState(null, config(1), now)).toEqual(state(1));
    expect(decideImapRotationState(state(1), config(2, 1, expiresAt), now)).toEqual(state(2, 1, expiresAt));
    expect(decideImapRotationState(state(2, 1, expiresAt), config(3, 2, expiresAt), now)).toEqual(state(3, 2, expiresAt));
  });

  it("fails closed for a stale lower generation and cannot resurrect an invalidated previous", () => {
    expect(() => decideImapRotationState(state(2, 1, expiresAt), config(1), now)).toThrow(ImapRotationStaleError);
    const invalidated = decideImapRotationState(state(2, 1, expiresAt), config(2), now);
    expect(invalidated).toEqual(state(2));
    expect(() => decideImapRotationState(invalidated, config(2, 1, expiresAt), now)).toThrow(ImapRotationStaleError);
  });

  it("cannot extend the authoritative previous expiry or rotate through a stale predecessor", () => {
    expect(() => decideImapRotationState(state(2, 1, expiresAt), config(2, 1, new Date("2026-08-01T00:00:00.000Z")), now))
      .toThrow(ImapRotationStaleError);
    expect(() => decideImapRotationState(state(2, 1, expiresAt), config(2, 1, new Date("2026-07-29T18:00:00.000Z")), now))
      .toThrow(ImapRotationStaleError);
    expect(() => decideImapRotationState(state(2, 1, expiresAt), config(3, 1, expiresAt), now)).toThrow(ImapRotationStaleError);
    expect(() => decideImapRotationState(state(2, 1, expiresAt), config(2, 1, expiresAt, "wrong-commitment"), now)).toThrow(ImapRotationStaleError);
  });

  it("clears an elapsed previous tuple while continuing with the current generation", () => {
    const expiry = new Date("2026-07-29T12:00:00.000Z");
    const before = new Date(expiry.getTime() - 1);
    const previous = state(2, 1, expiry);
    expect(decideImapRotationState(previous, config(2, 1, expiry), before)).toEqual(previous);
    expect(decideImapRotationState(previous, config(2, 1, expiry), expiry)).toEqual(state(2));
    expect(decideImapRotationState(previous, config(2, 1, expiry), new Date(expiry.getTime() + 1))).toEqual(state(2));
  });
});
