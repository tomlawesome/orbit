/**
 * WHETHER THE FILM PLAYS (#866, pocket cut #1083), framework-free like
 * relaunch.js's own seam so the whole gate is driven by a unit test without a
 * mounted component (tests/unit/v19-tour-trigger.test.mjs). Tour.svelte calls
 * this once the ratified login flight has landed; everything the film itself
 * is not responsible for (film.js's own header) — the first-login trigger,
 * and the one write a skip or a finish makes — is decided here instead.
 *
 * #1083 ENDS THE PHONE GATE (owner-decisions.md §24, 2026-09-23 → shipped).
 * The film now has a pocket dialect (Tour.svelte hands `createFilmRun` the
 * real `isPocket()` reading), so a pocket viewport takes the same path as a
 * desk one: it starts the film and spends `tourSeenAt` the same way.
 *
 * @typedef {"failed-read" | "already-seen" | "no-household" | "started"} BeginOutcome
 */

/**
 * @param {object} deps
 * @param {() => Promise<{ tourSeenAt: string | null }>} deps.readTour
 * @param {() => boolean} deps.hasHousehold `tourHasSomethingToShow(document)`
 * @param {() => { player: { onEnd(cb: (ended: boolean) => void): () => boolean }, start(): Promise<unknown> }} deps.createFilmRun
 *   Builds (but does not start) the film for this arrival. Called only once every
 *   gate below has passed, so nothing is measured or mounted for an
 *   already-seen reader, or a reader with no household.
 * @param {() => unknown} deps.writeSeen the one write, made once the film ends
 * @returns {Promise<BeginOutcome>}
 */
export async function beginFilm({ readTour, hasHousehold, createFilmRun, writeSeen }) {
  /** @type {{ tourSeenAt: string | null }} */
  let record;
  try {
    record = await readTour();
  } catch {
    /* Orbit not being able to say whether the film has been taken is not a
       reason to interrupt someone's sky. Silence, and again next time. */
    return "failed-read";
  }
  if (record.tourSeenAt !== null) return "already-seen";

  /* #864: a reader with no household yet gets the labelled sky, not the
     dial the film opens on — offer nothing rather than a film explaining a
     screen that isn't there. */
  if (!hasHousehold()) return "no-household";

  const film = createFilmRun();
  /* Both a clean finish (player.js's `finish`) and a stop/skip (`stop`) set
     `ended` true; `jump` sets it false first, so a fresh start or a chapter
     jump never fires this. The unsubscribe keeps the write to exactly once
     even if the reader hits Esc again after the film has already ended. */
  const stopWatchingEnd = film.player.onEnd((ended) => {
    if (!ended) return;
    stopWatchingEnd();
    writeSeen();
  });
  await film.start();
  return "started";
}
