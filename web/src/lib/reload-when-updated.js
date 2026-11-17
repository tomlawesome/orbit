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
 * @param {{ willUnload: boolean, to: { url: URL } | null, cancel?: () => void }} navigation
 * @param {{ current: boolean }} updated  kit's `updated` from `$app/state`
 * @param {(href: string) => void} go  how to load a page; `location.href = ...` in the browser
 * @param {{ isDirty: () => boolean, ask: () => boolean }} [guard]
 */
export function reloadWhenUpdated(navigation, updated, go, guard) {
  if (navigation.willUnload || !navigation.to?.url) return;
  if (guard?.isDirty() && !guard.ask()) {
    navigation.cancel?.();
    return;
  }
  if (updated.current) go(navigation.to.url.href);
}
