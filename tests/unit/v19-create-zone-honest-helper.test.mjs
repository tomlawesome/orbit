// @vitest-environment happy-dom
import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from "vitest";

import { createPageLoader } from "../support/svelte-page.mjs";

/*
 * #1316 (owner decision 17a, 2026-10-13; r4 row GS-2): the first-run create
 * card reads the time zone and currency off the browser, against a short
 * list. When the browser's zone is on that list the helper (the title on the
 * time zone field) keeps saying the values were read off the browser. When it
 * is NOT on the list, detection fell back to Europe/London and GBP, and the
 * helper must say so instead of claiming the browser supplied them:
 *
 *   your browser's zone isn't on this short list — change it in settings
 *
 * It is true: the household screen's time zone and currency fields change
 * both afterwards (household.update).
 *
 * CreateSystem.svelte is compiled with Svelte's own compiler and mounted in
 * happy-dom (the shape of v19-newcomer-empty-subline.test.mjs), with
 * Intl.DateTimeFormat().resolvedOptions().timeZone stubbed to the browser's
 * zone under test. The card is mounted with its defaults, as the host does
 * for a reader whose browser answer it has not overridden.
 */

const OFF_LIST_NOTE = "your browser's zone isn't on this short list — change it in settings";

const loader = createPageLoader("create-zone-helper");
beforeAll(() => loader.setup("lib/arrival/CreateSystem.svelte"));
afterAll(() => loader.teardown());
afterEach(() => {
  loader.unmount();
  vi.restoreAllMocks();
});

/** Mounts the card while the browser reports `browserZone`; returns the zone field's helper and the card's other words. */
async function mountCard(/** @type {string} */ browserZone) {
  const real = Intl.DateTimeFormat;
  vi.spyOn(Intl, "DateTimeFormat").mockImplementation(function (/** @type {any[]} */ ...args) {
    const format = new real(...args);
    return { ...format, format: format.format.bind(format), formatToParts: format.formatToParts.bind(format),
      resolvedOptions: () => ({ ...format.resolvedOptions(), timeZone: browserZone }) };
  });
  /* the shared page loader compiles ChooserCard and the rest of the card's tree */
  await loader.mount("lib/arrival/CreateSystem.svelte");
  const zone = document.querySelector("#tz");
  expect(zone, "the time zone field is drawn").not.toBeNull();
  const everyTitle = [...document.querySelectorAll("form [title]")].map((node) => node.getAttribute("title") ?? "");
  return {
    helper: zone?.getAttribute("title") ?? "",
    /** every word the card shows or carries in a tooltip */
    words: `${document.querySelector("form")?.textContent ?? ""}\n${everyTitle.join("\n")}`,
  };
}

describe("#1316 / 17a: the create card's time zone helper tells the truth about detection", () => {
  it("a browser zone on the short list: the helper says it was read off the browser", async () => {
    const card = await mountCard("Europe/Paris");
    expect(card.helper).toMatch(/read off your browser/i);
  });

  it("a browser zone on the short list: the off-list note is absent", async () => {
    const card = await mountCard("Europe/Paris");
    expect(card.words).not.toContain(OFF_LIST_NOTE);
  });

  it("a browser zone off the short list (America/Chicago): the helper says so, in the owner's words", async () => {
    const card = await mountCard("America/Chicago");
    expect(card.helper).toContain(OFF_LIST_NOTE);
  });

  it("a browser zone off the short list: the helper no longer claims the values were read off the browser", async () => {
    const card = await mountCard("America/Chicago");
    expect(card.helper).not.toMatch(/read off your browser/i);
  });

});
