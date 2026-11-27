export function bad(el: HTMLElement, html: string): void {
  // ruleid: dom-html-sink-non-literal
  el.innerHTML = html;
  // ruleid: dom-html-sink-non-literal
  el.outerHTML = `<b>${html}</b>`;
  // ruleid: dom-html-sink-non-literal
  el.insertAdjacentHTML("beforeend", html);
}

export function good(el: HTMLElement, text: string): void {
  // ok: dom-html-sink-non-literal
  el.innerHTML = "";
  // ok: dom-html-sink-non-literal
  el.textContent = text;
}
