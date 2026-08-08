/**
 * Reading page state across a navigation.
 *
 * A browser journey that reloads or signs out will destroy the execution
 * context underneath an in-flight evaluation. The retry lives here, separate
 * from the journey, so its behaviour can be proven deterministically rather
 * than inferred from whether a browser run happened to be green.
 */

/** Playwright's wording for an evaluation whose context disappeared. */
const navigationRaceSignatures = [
  "Execution context was destroyed",
  "Cannot find context",
  "Target closed",
  "Target crashed",
  "Session closed",
];

export function isNavigationRace(error: unknown): boolean {
  const message = error instanceof Error ? error.message : String(error);
  return navigationRaceSignatures.some((signature) => message.includes(signature));
}

export interface NavigationSafeOptions<T> {
  /** Names the read, so an exhausted retry says what could not be established. */
  describe: string;
  work: () => Promise<T>;
  /** Waits for the page to settle between attempts. */
  settle: () => Promise<unknown>;
  attempts?: number;
}

/**
 * Runs a read that may race a navigation, retrying until the page settles.
 *
 * A failure is never converted into a result. An unreadable context is not
 * evidence about the state being read, so exhausting the attempts throws. The
 * journeys using this assert that private data is absent, and returning a
 * default on failure would turn "could not check" into "confirmed absent".
 */
export async function evaluateAcrossNavigation<T>(options: NavigationSafeOptions<T>): Promise<T> {
  const attempts = options.attempts ?? 10;
  let lastError: unknown;

  for (let attempt = 0; attempt < attempts; attempt += 1) {
    try {
      return await options.work();
    } catch (error) {
      // Only a navigation race is retried. Anything else is a real failure and
      // must surface immediately rather than being retried into a timeout.
      if (!isNavigationRace(error)) throw error;
      lastError = error;
      await options.settle();
    }
  }

  throw new Error(
    `${options.describe} could not be read: the page kept navigating after ${attempts} attempts. Last error: ${String(lastError)}`,
  );
}
