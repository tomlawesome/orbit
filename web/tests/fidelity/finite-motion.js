/**
 * "Every finite animation has finished", said once (T-Q17). Seven specs each
 * wrote their own version, and the versions differed in what they did about a
 * paused animation, so one spec could wait out its timeout on a page where
 * another passed. The rule here:
 *
 *   · an animation or transition counts when its end is finite (an endless
 *     loop -- a breathing ring, the sky's drift -- never finishes and is not
 *     waited for) and it is running;
 *   · a paused one (the film's held mark) is not running and is not waited for;
 *   · a cancelled one (its element left) is not running either.
 *
 * Both waits below are built from the same expression, so the rule cannot
 * drift between them. Written as source text because it runs in the page,
 * where nothing from this module exists.
 */
const RUNNING_FINITE = `document.getAnimations().filter((a) => a.playState === "running"
  && Number.isFinite(Number(a.effect?.getComputedTiming().endTime)))`;

/** Resolves once `frames` painted frames in a row have passed and nothing finite is running. */
const frames = (/** @type {number} */ n) => `await new Promise((done) => {
  let left = ${n};
  const next = () => (left-- > 0 ? requestAnimationFrame(next) : done(undefined));
  next();
});`;

/**
 * Waits for the page to be quiet: `quietFrames` painted frames, then no finite
 * animation running. Throws on `timeout` (as `waitForFunction` does), for a
 * caller that wants to name what never settled; one that would rather judge
 * what is there adds `.catch(() => {})`.
 * @param {import("@playwright/test").Page} page
 * @param {{ timeout?: number, quietFrames?: number }} [options]
 */
export function finiteMotionDone(page, { timeout = 20_000, quietFrames = 0 } = {}) {
  return page.waitForFunction(
    `(async () => { ${frames(quietFrames)} return ${RUNNING_FINITE}.length === 0; })()`,
    undefined,
    { timeout },
  );
}

/**
 * Lets two frames paint, then waits for the finite animations that are running
 * to finish, and again, up to `rounds` rounds, stopping early on a round that
 * finds nothing finite running and `also` (an expression, true while something
 * other than animation is still on its way) false; two more frames at the end.
 * The race against `bound` ms is only the limit on a wait that cannot end;
 * after it the caller judges what is there. Resolves to whether anything finite
 * was running when the last round began.
 * @param {import("@playwright/test").Page} page
 * @param {{ bound?: number, rounds?: number, also?: string }} [options]
 */
export function finiteMotionSettled(page, { bound = 20_000, rounds = 1, also = "false" } = {}) {
  return page.evaluate(`(async () => {
    let running = false;
    for (let round = 0; round < ${rounds}; round++) {
      ${frames(2)}
      const finite = ${RUNNING_FINITE};
      running = finite.length > 0;
      if (!running && !(${also})) return false;
      await Promise.race([
        Promise.all(finite.map((a) => a.finished.catch(() => {}))),
        new Promise((done) => setTimeout(done, ${bound})),
      ]);
    }
    ${frames(2)}
    return running;
  })()`);
}
