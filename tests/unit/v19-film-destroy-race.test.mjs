// @vitest-environment happy-dom
import { describe, expect, it } from "vitest";

import { createFilm } from "../../web/src/lib/tour/film.js";

/*
 * #1151 R10: start() awaits homeSettled() (up to 6s, waiting for home's own
 * `data-home-ready` read to land) before it measures the player and mounts
 * the transport bar. If destroy() runs while that await is still pending —
 * a reader restarting the tour from relaunch.js's onRestartInPlace, which
 * calls film?.destroy() on the old run before building a fresh one — start()
 * used to carry on regardless: no destroyed-check after the await, so it
 * measured and mounted a transport on an already-destroyed player. Because
 * destroy() is idempotent (guarded by `destroyed`), nothing ever tears that
 * second bar down — it leaks in the DOM, driven by a dead player, until the
 * page reloads.
 *
 * `document.body.dataset.homeReady = "true"` makes homeSettled() resolve
 * its very first check, so the awaited promise is already settled when
 * start() suspends on it — but start() is still an async function, so the
 * suspend/resume is still a real microtask boundary. Calling destroy()
 * synchronously right after start(), before awaiting it, lands inside that
 * window exactly the way a same-tick restart would.
 */
describe("#1151 R10: start() racing destroy() during homeSettled()", () => {
  it("does not mount a transport once destroy() ran while start() was awaiting homeSettled()", async () => {
    document.body.dataset.homeReady = "true";
    const film = createFilm({ doc: document, chapters: [], transport: true });

    const starting = film.start();
    film.destroy(); // the restart's own destroy(), landing before start() resumes
    await starting;

    expect(document.getElementById("orbit-tour-transport")).toBeNull();
    document.body.removeAttribute("data-home-ready");
  });

  it("still mounts a transport on an ordinary start with no race", async () => {
    document.body.dataset.homeReady = "true";
    const film = createFilm({ doc: document, chapters: [], transport: true });

    await film.start();

    expect(document.getElementById("orbit-tour-transport")).not.toBeNull();
    film.destroy();
    document.body.removeAttribute("data-home-ready");
  });
});
