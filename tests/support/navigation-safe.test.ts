import { describe, expect, it, vi } from "vitest";
import { evaluateAcrossNavigation, isNavigationRace } from "./navigation-safe";

const raceError = () => new Error("Execution context was destroyed, most likely because of a navigation");

describe("navigation race recognition", () => {
  it.each([
    "Execution context was destroyed, most likely because of a navigation",
    "Cannot find context with specified id",
    "Target closed",
    "Target crashed",
    "Session closed. Most likely the page has been closed.",
  ])("recognises %s", (message) => {
    expect(isNavigationRace(new Error(message))).toBe(true);
  });

  it("does not treat an unrelated failure as a navigation race", () => {
    expect(isNavigationRace(new Error("expect(locator).toBeVisible() failed"))).toBe(false);
    expect(isNavigationRace(new Error("indexedDB is not defined"))).toBe(false);
    expect(isNavigationRace("some string")).toBe(false);
    expect(isNavigationRace(undefined)).toBe(false);
  });
});

describe("reading across a navigation", () => {
  it("returns the value without retrying when no navigation intervenes", async () => {
    const settle = vi.fn(async () => undefined);
    const work = vi.fn(async () => true);

    await expect(evaluateAcrossNavigation({ describe: "presence", work, settle })).resolves.toBe(true);
    expect(work).toHaveBeenCalledTimes(1);
    expect(settle).not.toHaveBeenCalled();
  });

  it("reproduces the defect unwrapped and resolves it wrapped, for the same read", async () => {
    // The regression itself. The previous implementation called the read
    // directly, so a single destroyed context failed the journey outright.
    // Identical reads are compared to show the wrapper is what changes the
    // outcome, not the read.
    const readThatRacesOnce = () => vi.fn()
      .mockRejectedValueOnce(raceError())
      .mockResolvedValue(true);

    await expect(readThatRacesOnce()()).rejects.toThrow(/Execution context was destroyed/u);

    await expect(evaluateAcrossNavigation({
      describe: "Legacy workspace cache presence",
      work: readThatRacesOnce(),
      settle: async () => undefined,
    })).resolves.toBe(true);
  });

  it("recovers the real value after the context is destroyed mid-read", async () => {
    // This is the forced reproduction: the first read is destroyed by a
    // navigation, exactly as observed in CI, and the correct value still
    // reaches the assertion.
    const settle = vi.fn(async () => undefined);
    const work = vi.fn()
      .mockRejectedValueOnce(raceError())
      .mockResolvedValueOnce(true);

    await expect(evaluateAcrossNavigation({ describe: "presence", work, settle })).resolves.toBe(true);
    expect(work).toHaveBeenCalledTimes(2);
    expect(settle).toHaveBeenCalledTimes(1);
  });

  it("survives repeated navigations before the page settles", async () => {
    const settle = vi.fn(async () => undefined);
    const work = vi.fn()
      .mockRejectedValueOnce(raceError())
      .mockRejectedValueOnce(raceError())
      .mockRejectedValueOnce(raceError())
      .mockResolvedValueOnce(false);

    await expect(evaluateAcrossNavigation({ describe: "presence", work, settle })).resolves.toBe(false);
    expect(work).toHaveBeenCalledTimes(4);
  });

  it("throws rather than returning a value when the page never settles", async () => {
    // The critical property: "could not check" must never become
    // "confirmed absent". The journeys assert that private data is gone, so a
    // default return here would silently pass a failed purge.
    const settle = vi.fn(async () => undefined);
    const work = vi.fn(async () => { throw raceError(); });

    await expect(evaluateAcrossNavigation({ describe: "Legacy workspace cache presence", work, settle, attempts: 3 }))
      .rejects.toThrow(/Legacy workspace cache presence could not be read/u);
    expect(work).toHaveBeenCalledTimes(3);
  });

  it("surfaces an unrelated failure immediately instead of retrying it", async () => {
    const settle = vi.fn(async () => undefined);
    const work = vi.fn(async () => { throw new Error("indexedDB is not defined"); });

    await expect(evaluateAcrossNavigation({ describe: "presence", work, settle }))
      .rejects.toThrow(/indexedDB is not defined/u);
    expect(work).toHaveBeenCalledTimes(1);
    expect(settle).not.toHaveBeenCalled();
  });
});
