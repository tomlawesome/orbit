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
export function mountPocket({ approve, dismiss } = {}) {
  const controller = new AbortController();
  const on = (target, type, handler) =>
    target?.addEventListener(type, handler, { signal: controller.signal });

  const sheet = document.getElementById("sheet");
  const title = document.getElementById("sh-title");
  const meta = document.getElementById("sh-meta");
  const fields = document.getElementById("sh-fields");
  const actsItem = document.getElementById("sh-acts-item");
  const actsSugg = document.getElementById("sh-acts-sugg");
  const amend = document.getElementById("sh-amend");

  const resetSuggestionActs = () => {
    for (const button of actsSugg?.querySelectorAll("[data-sugg-act]") ?? []) {
      delete button.dataset.armed;
      button.textContent = button.dataset.suggAct === "approve" ? "Add to orbit" : "Dismiss";
    }
  };

  for (const body of document.querySelectorAll("[data-sheet-title]")) {
    on(body, "click", () => {
      title.textContent = body.dataset.sheetTitle;
      meta.textContent = body.dataset.sheetMeta;
      fields.replaceChildren();
      actsItem.hidden = false;
      if (actsSugg) actsSugg.hidden = true;
      if (amend) amend.hidden = true;
      sheet.classList.add("open");
    });
  }

  /* #466: a signal raises the SUGGESTION sheet — the pocket's review
     surface. Copy is cloned from a Svelte-rendered template, never built
     from strings; the two-tap grammar matches the desk rows (#434). */
  let activeSuggestion = null;
  for (const trigger of document.querySelectorAll("[data-sheet-sugg]")) {
    on(trigger, "click", () => {
      const id = trigger.dataset.sheetSugg;
      const template = document.querySelector(`[data-sugg-template="${CSS.escape(id)}"]`);
      if (!template) return;
      activeSuggestion = id;
      title.textContent = template.dataset.title;
      meta.textContent = template.dataset.meta;
      fields.replaceChildren(template.content.cloneNode(true));
      actsItem.hidden = true;
      if (actsSugg) actsSugg.hidden = false;
      if (amend) { amend.hidden = false; amend.setAttribute("href", `/item/${id}`); }
      resetSuggestionActs();
      sheet.classList.add("open");
    });
  }
  for (const button of actsSugg?.querySelectorAll("[data-sugg-act]") ?? []) {
    on(button, "click", () => {
      if (!activeSuggestion) return;
      const act = button.dataset.suggAct;
      if (!button.dataset.armed) {
        button.dataset.armed = "1";
        button.textContent = act === "approve" ? "tap again to approve" : "tap again to dismiss";
        return;
      }
      (act === "approve" ? approve : dismiss)?.(activeSuggestion);
      close();
    });
  }

  const close = () => {
    sheet.classList.remove("open");
    resetSuggestionActs();
  };
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
