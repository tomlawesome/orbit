/*
 * Home's item drawer, near enough for the tour's chapters 8 and 9 (#1319):
 * shared by v19-tour-chapter-the-item.test.mjs and
 * v19-tour-chapter-done.test.mjs, so both chapters are played against the
 * same behaviour home's real drawer has.
 */

/** Gives an element a fixed box, which happy-dom does not lay out. */
export function box(el, { x, y, w, h }) {
  el.getBoundingClientRect = () => ({ left: x, top: y, width: w, height: h, right: x + w, bottom: y + h, x, y, toJSON() {} });
}

/**
 * Home's drawer, near enough for the film: the row's own click opens it,
 * a paper's click raises the preview card, the pencil puts the rows into
 * editing, the due value raises the chooser, and Escape takes them back in
 * home's own order — the preview, the chooser, the editing, then the row.
 * `writes` counts every press of save or complete, which the film must
 * never make.
 */
export function drawHome({ docs = 2, body = true, row = true } = {}) {
  document.body.innerHTML = '<div id="scene"></div>';
  const scene = /** @type {HTMLElement} */ (document.getElementById("scene"));
  scene.innerHTML = `
    <div class="desk">
      <svg class="dial" viewBox="0 0 380 380"><a class="sun-link"></a>${body ? `<a class="body-link" data-body="volvo"${docs > 0 ? ` data-docs="${docs}"` : ""}></a>` : ""}</svg>
      <div class="manifest">${row ? '<a class="item" id="volvo" href="/home?item=volvo" aria-expanded="false">Volvo</a>' : ""}</div>
    </div>`;
  const writes = { count: 0 };
  const state = { editing: false };
  const rowEl = scene.querySelector("a.item");
  const view = () => scene.querySelector(".itemview");
  const readView = () => `
    <div class="kv"><span>due</span><b>in 16 days</b></div>
    ${Array.from({ length: docs }, (_, k) => `<button type="button" class="doc" data-doc-row aria-label="Open Paper ${k}">Paper ${k}</button>`).join("")}
    <div class="ivfootrow"><div class="ivacts" role="group" aria-label="Actions for Volvo">
      <button aria-label="Snooze Volvo">snooze</button><button aria-label="Complete Volvo" data-write>complete</button>
      <button aria-label="Attach a document to Volvo">attach a document</button><button aria-label="Retire Volvo" data-write>retire</button>
    </div><button class="ivicon ivedit" aria-label="Edit this item"></button></div>`;
  const editView = () => `
    <div class="rows" data-edit-rows><div class="kv"><span>due</span><button class="pick" data-pick aria-label="due: 24 October 2026">24 October</button></div></div>
    ${Array.from({ length: docs }, (_, k) => `<button type="button" class="doc" data-doc-row aria-label="Open Paper ${k}">Paper ${k}</button>`).join("")}
    <div class="ivfootrow"><div class="ivacts" role="group" aria-label="Editing Volvo">
      <button class="act-accent" data-write>save</button><button>cancel</button>
    </div><button class="ivicon ivedit on" aria-label="Edit this item"></button></div>`;
  const paint = () => { const v = view(); if (v) v.innerHTML = state.editing ? editView() : readView(); };
  rowEl?.addEventListener("click", (event) => {
    event.preventDefault();
    if (view()) return;
    rowEl.classList.add("open");
    rowEl.setAttribute("aria-expanded", "true");
    const v = document.createElement("div");
    v.className = "itemview";
    rowEl.after(v);
    paint();
  });
  scene.addEventListener("click", (event) => {
    const target = /** @type {Element} */ (event.target);
    if (target.closest("[data-write]")) writes.count++;
    if (target.closest("[data-doc-row]") && !scene.querySelector("[data-preview-card]")) {
      scene.insertAdjacentHTML("beforeend", '<div class="glass readcard" data-preview-card></div>');
    }
    if (target.closest(".ivedit") && !state.editing) { state.editing = true; paint(); }
    if (target.closest(".pick") && !scene.querySelector("[data-chooser-card]")) {
      scene.insertAdjacentHTML("beforeend", '<div class="chseat" data-chooser-card></div>');
    }
  });
  const onKey = (event) => {
    if (event.key !== "Escape") return;
    const preview = scene.querySelector("[data-preview-card]");
    const chooser = scene.querySelector("[data-chooser-card]");
    if (preview) preview.remove();
    else if (chooser) chooser.remove();
    else if (state.editing) { state.editing = false; paint(); }
    else if (view()) {
      view()?.remove();
      rowEl?.classList.remove("open");
      rowEl?.setAttribute("aria-expanded", "false");
    }
  };
  window.addEventListener("keydown", onKey);
  const bodyLink = scene.querySelector(".body-link");
  if (bodyLink) box(bodyLink, { x: 646, y: 268, w: 50, h: 50 });
  return { scene, writes, state, done: () => window.removeEventListener("keydown", onKey) };
}

