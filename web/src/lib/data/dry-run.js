/**
 * THE ENGINE'S ANSWER AS THE MEMBER TYPES (ADR-0034 decision 3, #1325). A
 * form asks whether what it holds could be saved; the engine answers with
 * the same rules the save runs (checkCommand, a dry run of the command), and
 * the form shows the answer where its "not yet" line stands and holds its
 * save button to it. Nothing here decides anything: it only times the
 * questions and drops answers that a newer question has overtaken.
 *
 * About 300 ms after the last change, and at once when the form opens.
 */
import { checkCommand } from "./workspace.js";

export const DRY_RUN_DELAY_MS = 300;

/**
 * @param {{
 *   onanswer: (refusal: string | null) => void,
 *   check?: (command: object) => Promise<string | null>,
 *   delay?: number,
 * }} options  `onanswer` hears each current answer: null when the engine
 *   would accept the command, its refusal's words when not
 */
export function dryRunner({ onanswer, check = checkCommand, delay = DRY_RUN_DELAY_MS }) {
  /** @type {ReturnType<typeof setTimeout> | undefined} */
  let timer;
  let asked = 0;

  /** @param {() => object | null} build  the command as the form holds it now; null asks nothing */
  async function run(build) {
    const mine = ++asked;
    const command = build();
    if (!command) return;
    const refusal = await check(command);
    if (mine === asked) onanswer(refusal);
  }

  return {
    /** Ask again once the member pauses. @param {() => object | null} build */
    ask(build) {
      clearTimeout(timer);
      asked++;
      timer = setTimeout(() => run(build), delay);
    },
    /** Ask at once (the form opening). @param {() => object | null} build */
    now(build) {
      clearTimeout(timer);
      return run(build);
    },
    /** Stop asking; an answer still on its way is dropped. */
    stop() {
      clearTimeout(timer);
      asked++;
    },
  };
}
