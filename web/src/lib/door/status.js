/*
 * THE HOST'S WORD THAT ITS FIRST WORK IS DONE (#119). In a worker with no background compile (Firefox: no
 * KHR_parallel_shader_compile) the flight's programs are built one at a time on the GPU's queue, and whatever the host
 * asks of the GPU meanwhile waits behind them: the install's unseen first draw waited 1.9-3.0 s, 0.24 s when asked
 * after (seen on a real device). So under the host's flag `links: "late"` the flight's world asks for its programs only
 * once the host gives the word (statusGo: on the page, told on to the flight's worker by remote-flight.js), and never
 * later than STATUS_LATE after it would have asked: the flight never waits for ever. Without the flag nothing waits.
 */
import { flag } from "./settings.js";

/* the longest the programs are put off, from the asking (ms) */
export const STATUS_LATE = 9000;
let given = false;
/** @type {Set<() => void>} */
const heard = new Set();

/** the host's word, given once for the life of the page (or the worker); a second is nothing */
export function statusGo() {
  if (given) return;
  given = true;
  for (const fn of [...heard]) { try { fn(); } catch { /* one listener's failure is not the others' */ } }
  heard.clear();
}

/** fn once the word is given (at once if it has been); returns the stop @param {() => void} fn @returns {() => void} */
export function onStatusGo(fn) {
  if (given) { fn(); return () => {}; }
  heard.add(fn);
  return () => { heard.delete(fn); };
}

/**
 * settled once the flight's programs may be asked for: at the word, or at STATUS_LATE, whichever first, once, with
 * the ms waited; at once with 0 without the flag or once the word is given. `stop` (an AbortSignal: the world lost or
 * taken down meanwhile) ends the wait then, its timer cleared; the caller looks for itself whether it is still wanted
 * @param {AbortSignal} [stop]
 * @returns {Promise<number>}
 */
export function statusTurn(stop) {
  if (flag("links") !== "late" || given) return Promise.resolve(0);
  const t0 = performance.now();
  return new Promise((resolve) => {
    const end = () => { clearTimeout(cap); unhear(); stop?.removeEventListener("abort", end); resolve(performance.now() - t0); };
    const cap = setTimeout(end, STATUS_LATE);
    const unhear = onStatusGo(end);
    if (stop?.aborted) end(); else stop?.addEventListener("abort", end);
  });
}
