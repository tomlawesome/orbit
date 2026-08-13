import { describe, expect, it } from "vitest";

import { type Clock, waitForComponentHealth } from "./health-wait";

// Unit coverage for issue #295 slice 5's wait_for_component_health port
// (install.sh:1107-1123, guarantee #35). A fake Clock drives simulated time
// deterministically — no real sleeping — matching the fake-clock pattern
// already used for other bounded-wait logic in this codebase.

function fakeClock(initialSeconds = 0): Clock & { advance(seconds: number): void; sleeps: number[] } {
  let seconds = initialSeconds;
  const sleeps: number[] = [];
  return {
    nowSeconds: () => seconds,
    sleep: async (duration) => {
      sleeps.push(duration);
      seconds += duration;
    },
    advance(duration: number) {
      seconds += duration;
    },
    sleeps,
  };
}

describe("waitForComponentHealth (install.sh:1107-1123, guarantee #35)", () => {
  it("returns true immediately when the probe succeeds on the first attempt", async () => {
    const clock = fakeClock();
    const result = await waitForComponentHealth({ probe: () => true, timeoutSeconds: 10, pollSeconds: 2, clock });
    expect(result).toBe(true);
    expect(clock.sleeps).toEqual([]);
  });

  it("polls until the probe succeeds, sleeping pollSeconds between attempts", async () => {
    const clock = fakeClock();
    let attempts = 0;
    const result = await waitForComponentHealth({
      probe: () => {
        attempts += 1;
        return attempts >= 3;
      },
      timeoutSeconds: 10,
      pollSeconds: 2,
      clock,
    });
    expect(result).toBe(true);
    expect(attempts).toBe(3);
    expect(clock.sleeps).toEqual([2, 2]);
  });

  it("gives up once the wall-clock deadline passes, regardless of how many quick-but-false probes occurred", async () => {
    const clock = fakeClock();
    let attempts = 0;
    const result = await waitForComponentHealth({
      probe: () => {
        attempts += 1;
        return false;
      },
      timeoutSeconds: 5,
      pollSeconds: 2,
      clock,
    });
    expect(result).toBe(false);
    // deadline=5; attempt at t=0 (fail), sleep 2 -> t=2; attempt (fail), sleep 2 -> t=4;
    // attempt (fail), remaining=1, sleep 1 -> t=5; loop exits (t>=deadline).
    expect(attempts).toBe(3);
    expect(clock.sleeps).toEqual([2, 2, 1]);
  });

  it("clamps the final sleep so it never overshoots the deadline", async () => {
    const clock = fakeClock();
    const result = await waitForComponentHealth({ probe: () => false, timeoutSeconds: 3, pollSeconds: 9, clock });
    expect(result).toBe(false);
    expect(clock.sleeps).toEqual([3]);
  });

  it("invokes onWaiting once per unsuccessful attempt", async () => {
    const clock = fakeClock();
    let waitingCount = 0;
    let attempts = 0;
    await waitForComponentHealth({
      probe: () => {
        attempts += 1;
        return attempts >= 2;
      },
      timeoutSeconds: 10,
      pollSeconds: 1,
      clock,
      onWaiting: () => {
        waitingCount += 1;
      },
    });
    expect(waitingCount).toBe(1);
  });

  it("supports an async probe", async () => {
    const clock = fakeClock();
    const result = await waitForComponentHealth({
      probe: async () => Promise.resolve(true),
      timeoutSeconds: 10,
      pollSeconds: 1,
      clock,
    });
    expect(result).toBe(true);
  });
});
