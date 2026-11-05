import { canvasMeasure } from "./data/sky-labels.js";
import { POCKET_QUERY } from "./pocket/media.js";

/**
 * What the planet-name placer needs in a component (#1461), as a store
 * (`$sky`): both dialects of a screen are in the document and CSS shows one,
 * so each dialect asks only for itself. `shown` says whether `dialect` is the
 * one on screen (false on the server and until mounted); `current` is the text
 * measure once that is so and the UI font has loaded, so a name is measured in
 * the face it is drawn in, else null.
 *
 * A plain store rather than runes, so it also works where a page is compiled
 * on its own (tests/unit/settings-provider-sentence.test.mjs).
 *
 * @param {"desk" | "pocket"} dialect
 * @returns {{ subscribe: (run: (state: { shown: boolean, current: import("./data/sky-labels.js").Measure | null }) => void) => () => void }}
 */
export function skyMeasure(dialect) {
  return {
    subscribe(run) {
      let shown = false;
      let measure = /** @type {import("./data/sky-labels.js").Measure | null} */ (null);
      const say = () => run({ shown, current: shown ? measure : null });
      say();
      if (typeof document === "undefined" || typeof matchMedia !== "function") return () => {};
      let live = true;
      const query = matchMedia(POCKET_QUERY);
      const sync = () => { shown = query.matches === (dialect === "pocket"); say(); };
      query.addEventListener?.("change", sync);
      sync();
      const ready = () => { if (live) { measure = canvasMeasure(); say(); } };
      if (document.fonts?.load) document.fonts.load('400 12px "Inter Variable"').then(ready, ready);
      else ready();
      return () => { live = false; query.removeEventListener?.("change", sync); };
    },
  };
}
