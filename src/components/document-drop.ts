/**
 * Drop-target predicates kept free of JSX so they are unit-testable under the
 * repository's node test environment, which has no DOM or React renderer.
 */

/**
 * A drag only counts as an upload when it actually carries files. Dragging
 * selected text, a link, or an element within the page also fires drag events,
 * and treating those as uploads would produce confusing empty attempts.
 */
export function carriesFiles(types: readonly string[] | undefined | null): boolean {
  return Array.from(types ?? []).includes("Files");
}

/**
 * `dragleave` also fires when the pointer crosses between child elements of the
 * zone. Releasing the highlight on those would make it flicker while the
 * pointer is still inside, so it is released only when the pointer genuinely
 * leaves the zone.
 */
export function leavesDropZone(
  zoneContainsRelatedTarget: boolean,
): boolean {
  return !zoneContainsRelatedTarget;
}
