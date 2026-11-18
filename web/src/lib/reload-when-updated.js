/**
 * SvelteKit's documented answer to a tab left open across an update (#1738
 * A-F1): version polling only sets `updated.current`; it reloads nothing by
 * itself unless a navigation fails. So once a new version exists, the next
 * in-app navigation is made a full page load of its target, which brings the
 * new version with it.
 *
 * With unsaved text (#1879 W-S1) the navigation first asks the discard
 * question, once: declined cancels it (no reload), accepted carries on.
 *
 * A dirty holder with its own ask (the phone's "Leave without adding?"
 * callout) is the only question there: the navigation is cancelled, that ask
 * is awaited, and a yes goes on by a full load when an update is pending, else
 * by `goto`. The returned promise settles when that is done.
 *
 * @param {{ willUnload: boolean, from?: { url: URL } | null, to: { url: URL } | null, cancel?: () => void }} navigation
 * @param {{ current: boolean }} updated  kit's `updated` from `$app/state`
 * @param {(href: string) => void} go  how to load a page; `location.href = ...` in the browser
 * @param {{ isDirty: () => boolean, ask: () => boolean, holderAsk?: () => Promise<boolean>, leaving?: () => (() => void) | void }} [guard]
 * @param {(href: string) => unknown} [goto]  an in-app navigation, for a holder's resumed one
 * @returns {Promise<void> | void}
 */
export function reloadWhenUpdated(navigation, updated, go, guard, goto) {
  if (navigation.willUnload || !navigation.to?.url) return;
  const href = navigation.to.url.href;
  /* A reload that only moves the #hash does not unload the page, so the
     leaving mark must come off again. */
  const from = navigation.from?.url;
  const sameDocument = !!from && from.href.split("#")[0] === href.split("#")[0];
  const reload = () => {
    const undo = guard?.leaving?.();
    go(href);
    if (sameDocument && typeof undo === "function") undo();
  };
  if (guard?.isDirty()) {
    if (guard.holderAsk) {
      navigation.cancel?.();
      return guard.holderAsk().then(async (yes) => {
        if (!yes) return;
        if (updated.current) {
          reload();
          return;
        }
        const undo = guard.leaving?.();
        try {
          await goto?.(href);
        } finally {
          if (typeof undo === "function") undo();
        }
      });
    }
    if (!guard.ask()) {
      navigation.cancel?.();
      return;
    }
  }
  if (updated.current) reload();
}
