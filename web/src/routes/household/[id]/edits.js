import { plural } from "$lib/format.js";
/**
 * THE POCKET HOUSEHOLD'S UNSAVED EDITS (#1122, proposal §2.10, owner decision
 * 2b): what the rising save bar counts, and the list moves it collects.
 *
 * The phone collects every edit on the page into one bar, "2 changes · undo ·
 * save": the system's name, time zone and currency, and the sections list
 * (shown or hidden, renamed, re-marked, added, removed, reordered). Save sends
 * what changed and nothing else: `household.update` when a field moved,
 * `sections.replace` when the list did. Undo puts every edit back to what the
 * server last said.
 *
 * Pure: no DOM, no Svelte, so the unit tests can hold it to its word.
 */

/**
 * @typedef {{ name: string, timezone: string, currency: string }} Identity
 * @typedef {{ id: string, name: string, icon: string, visible: boolean, removed?: boolean, moveTo?: string, fresh?: boolean }} EditRow
 */

/**
 * One line per change, in the order a reader would meet them on the page.
 * @param {{ identity: Identity, sections: EditRow[] }} saved   what the server said
 * @param {{ identity: Identity, sections: EditRow[] }} local   what the page holds now
 * @returns {string[]}
 */
export function changesOf(saved, local) {
  /** @type {string[]} */
  const out = [];
  for (const field of /** @type {const} */ (["name", "timezone", "currency"])) {
    if (local.identity[field].trim() !== saved.identity[field]) out.push(field);
  }
  const before = new Map(saved.sections.map((row) => [row.id, row]));
  for (const row of local.sections) {
    const was = before.get(row.id);
    if (!was) {
      if (!row.removed) out.push(`add ${row.id}`);
      continue;
    }
    if (row.removed) { out.push(`remove ${row.id}`); continue; }
    if (row.name.trim() !== was.name || row.icon !== was.icon || row.visible !== was.visible) out.push(`edit ${row.id}`);
  }
  /* The order counts once, however many rows moved: it is one decision. */
  const kept = local.sections.filter((row) => before.has(row.id) && !row.removed).map((row) => row.id);
  const order = saved.sections.map((row) => row.id).filter((id) => kept.includes(id));
  if (kept.join("|") !== order.join("|")) out.push("order");
  return out;
}

/**
 * Whether the save must send the identity bundle, the sections list, or both.
 * @param {string[]} changes  changesOf's answer
 */
export function commandsFor(changes) {
  return {
    identity: changes.some((change) => change === "name" || change === "timezone" || change === "currency"),
    sections: changes.some((change) => /^(add|remove|edit) |^order$/.test(change)),
  };
}

/** "1 change" / "3 changes". @param {number} count */
export const changesLabel = (count) => plural(count, "change");

/**
 * A copy of `rows` with the row at `from` moved to `to`; out-of-range moves
 * give the rows back unchanged.
 * @template T
 * @param {T[]} rows
 * @param {number} from
 * @param {number} to
 * @returns {T[]}
 */
export function moved(rows, from, to) {
  if (from === to || from < 0 || to < 0 || from >= rows.length || to >= rows.length) return rows;
  const next = rows.slice();
  const [row] = next.splice(from, 1);
  next.splice(to, 0, row);
  return next;
}

/**
 * The household's mark as home's chip draws it (home/pocket.svelte): one
 * body on a ring, at an angle fixed by the household's id, in the tone of its
 * nearest body. Carried onto the household's own page so the page is
 * recognisably the chip you tapped.
 * @param {number} hash  chart.js hashId(id)
 * @param {number} radius  the ring's radius in the drawing's units
 * @returns {{ x: number, y: number }} the body's offset from the ring's centre
 */
export function chipBodyOf(hash, radius) {
  const angle = (hash / 0xffffffff) * Math.PI * 2;
  return {
    x: Math.round(Math.cos(angle) * radius * 10) / 10,
    y: Math.round(Math.sin(angle) * radius * 10) / 10,
  };
}
