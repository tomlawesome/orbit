/**
 * A screen's teardown scope (#445).
 *
 * A mockup is one document per screen, so leaving it destroys everything the
 * page wrote. In the app <body> and the stylesheets outlive the screen, so
 * anything a screen writes outside its own subtree has to be handed back on
 * the way out or it follows the reader to the next screen — which is how a
 * blurred scrim once survived a trip to /create. Timers are the same problem
 * wearing a different hat: a flight that lands after unmount writes to nodes
 * that are gone.
 *
 * Three screens had each written their own version of this — create, the
 * pocket and home, the last one with a private timer set on top — and a
 * teardown that is nearly the same in three places is one that stops being
 * the same. It is one function now, and a new screen inherits it rather than
 * retyping it.
 *
 * @returns {{
 *   on: (target: EventTarget | null | undefined, type: string, handler: (event: any) => void, options?: AddEventListenerOptions) => void,
 *   onWindow: (type: string, handler: (event: any) => void, options?: any) => void,
 *   later: (fn: () => void, ms: number) => ReturnType<typeof setTimeout>,
 *   signal: AbortSignal,
 *   teardown: () => void,
 * }}
 */
export function screenScope() {
  const controller = new AbortController();
  /** @type {Set<ReturnType<typeof setTimeout>>} */
  const timers = new Set();

  return {
    /* Optional target throughout: every caller reaches for its nodes with
       getElementById/querySelector, and a screen that renders one dialect of
       itself must not throw because the other dialect's node is absent. */
    on: (target, type, handler, options) =>
      target?.addEventListener(type, handler, { ...options, signal: controller.signal }),

    /* Named so a screen can shadow the global `addEventListener` with it and
       leave the mockup's own bare `addEventListener(...)` calls untouched —
       they simply resolve a different binding. The third argument is the
       mockup's, which may be a boolean `useCapture` rather than an options
       object, so only an object is spread. */
    onWindow: (type, handler, options) =>
      window.addEventListener(type, handler, {
        ...(typeof options === "object" ? options : null),
        signal: controller.signal,
      }),

    later: (fn, ms) => {
      const id = setTimeout(() => { timers.delete(id); fn(); }, ms);
      timers.add(id);
      return id;
    },

    /* For an API that takes a signal directly rather than a listener. */
    signal: controller.signal,

    teardown: () => {
      controller.abort();
      for (const id of timers) clearTimeout(id);
      timers.clear();
    },
  };
}
