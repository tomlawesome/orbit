// Bounded health-wait polling (issue #295 slice 5), ported from
// scripts/install.sh's `wait_for_component_health` (install.sh:1107-1123,
// guarantee #35). Guarantee numbers cite docs/installer-guarantees.md,
// Part 1 / install.sh, and are re-asserted by name in
// src/lib/health-wait.test.ts.
//
// The per-probe 5s/1s-kill-after bound (`bounded_compose_probe`,
// install.sh:1079-1082, guarantee #33) is the responsibility of whatever
// `probe` this module is handed — src/lib/install-docker-adapter.ts's own
// `compose exec` methods each carry their own Node-native bound (see that
// module's header comment for why it does not shell out to GNU `timeout`).
// This module only ports the *outer* wall-clock wait loop: poll until
// healthy, log a `waiting` event between attempts, and give up once the
// deadline — measured from when the wait began, independent of how long any
// individual probe took — has passed.

export interface Clock {
  /** Monotonic-enough seconds since some fixed epoch (install.sh's bash `$SECONDS`). */
  nowSeconds(): number;
  /** Waits `seconds`, then resolves. */
  sleep(seconds: number): Promise<void>;
}

/** A Clock backed by real wall-clock time and setTimeout — the production implementation. */
export function realClock(): Clock {
  return {
    nowSeconds: () => Date.now() / 1000,
    sleep: (seconds) => new Promise((resolve) => setTimeout(resolve, Math.max(0, seconds) * 1000)),
  };
}

export interface WaitForComponentHealthOptions {
  probe: () => boolean | Promise<boolean>;
  timeoutSeconds: number;
  pollSeconds: number;
  clock: Clock;
  /** Called once per unsuccessful probe attempt, before the next sleep — install.sh's own `waiting` status event. */
  onWaiting?: () => void;
}

/**
 * wait_for_component_health (install.sh:1107-1123, guarantee #35): polls
 * `probe` against a wall-clock deadline computed once at the start of the
 * wait, independent of the per-probe bound — the outer loop itself always
 * terminates once the deadline passes, even if `probe` keeps returning
 * quickly-but-falsely. Mirrors bash's own `deadline=$((SECONDS +
 * readiness_timeout_seconds))` / `pause="$readiness_poll_seconds"`,
 * clamping the final sleep so it never overshoots the deadline.
 */
export async function waitForComponentHealth(options: WaitForComponentHealthOptions): Promise<boolean> {
  const { probe, timeoutSeconds, pollSeconds, clock, onWaiting } = options;
  const deadline = clock.nowSeconds() + timeoutSeconds;

  while (true) {
    if (await probe()) return true;
    onWaiting?.();
    const remaining = deadline - clock.nowSeconds();
    if (remaining <= 0) return false;
    const pause = Math.min(pollSeconds, remaining);
    await clock.sleep(pause);
    if (clock.nowSeconds() >= deadline) return false;
  }
}
