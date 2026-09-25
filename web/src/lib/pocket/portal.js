/**
 * Moves an element to the end of <body> while it is mounted (#1120). Sheets
 * and the wake live there so that inertPage (focus.js) can make everything
 * else inert by marking <body>'s other children, and so no transformed
 * ancestor can capture their position:fixed.
 * @param {HTMLElement} node
 */
export function portal(node) {
  node.ownerDocument.body.appendChild(node);
  return {
    destroy() {
      node.remove();
    },
  };
}
