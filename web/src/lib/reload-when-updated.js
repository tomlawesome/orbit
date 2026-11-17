/**
 * SvelteKit's documented answer to a tab left open across an update (#1738
 * A-F1): version polling only sets `updated.current`; it reloads nothing by
 * itself unless a navigation fails. So once a new version exists, the next
 * in-app navigation is made a full page load of its target, which brings the
 * new version with it.
 *
 * @param {{ willUnload: boolean, to: { url: URL } | null }} navigation
 * @param {{ current: boolean }} updated  kit's `updated` from `$app/state`
 * @param {(href: string) => void} go  how to load a page; `location.href = ...` in the browser
 */
export function reloadWhenUpdated(navigation, updated, go) {
  if (!updated.current || navigation.willUnload || !navigation.to?.url) return;
  go(navigation.to.url.href);
}
