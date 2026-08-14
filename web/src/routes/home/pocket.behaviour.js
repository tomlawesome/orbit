/**
 * The mobile dialect's behaviour, carried across from
 * design/family/mobile-home.html and owned here from that point on.
 *
 * CON-10's grammar in one function: on a phone the callout is a bottom sheet,
 * and the first tap on a body raises it rather than navigating. The second tap
 * — approach — is drawn nowhere yet, so `open` and `documents` stay inert
 * rather than leading somewhere invented.
 *
 * One departure from the mockup: it passed the sheet's copy as arguments to an
 * inline `onclick`, which needs a global to reach. The copy now rides the
 * element as data, and is written with `textContent` rather than the mockup's
 * `innerHTML` — the attribute is already entity-decoded by the parser, so the
 * result is identical and nothing here can inject markup.
 */
export function mountPocket() {
  const controller = new AbortController();
  const on = (target, type, handler) =>
    target?.addEventListener(type, handler, { signal: controller.signal });

  const sheet = document.getElementById("sheet");
  const title = document.getElementById("sh-title");
  const meta = document.getElementById("sh-meta");

  for (const body of document.querySelectorAll("[data-sheet-title]")) {
    on(body, "click", () => {
      title.textContent = body.dataset.sheetTitle;
      meta.textContent = body.dataset.sheetMeta;
      sheet.classList.add("open");
    });
  }

  const close = () => sheet.classList.remove("open");
  for (const button of document.querySelectorAll("[data-sheet-close]")) {
    on(button, "click", close);
  }

  /* A sheet you cannot dismiss with the key that dismisses everything else is
     a trap. The mockup had no keyboard to worry about; the product does. */
  on(window, "keydown", (event) => {
    if (event.key === "Escape") close();
  });

  return () => controller.abort();
}
