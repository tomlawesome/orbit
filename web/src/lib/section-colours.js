/**
 * Pure bookkeeping for a section colour pick (#1879 W-R3). Rows are
 * {id, name, colour}; `saved` is {id: colour}; `problems` is {id: text}.
 */

/**
 * Picking a section again clears only its own earlier problem.
 * @param {Record<string, string>} problems
 * @param {string} id
 * @returns {Record<string, string>}
 */
export function startColourPick(problems, id) {
  const { [id]: _cleared, ...rest } = problems;
  return rest;
}

/**
 * The outcome of the save. A failure reverts that swatch to its saved colour
 * and records "not saved — {section}: {words}"; a success changes nothing
 * about anyone's problem.
 * @param {{ rows: { id: string, name: string, colour: string }[], saved: Record<string, string>, problems: Record<string, string>, id: string, colour: string, error: string | null }} outcome
 */
export function settleColourPick({ rows, saved, problems, id, colour, error }) {
  const row = rows.find((one) => one.id === id);
  /* A later pick of this section is the latest word: this failure is stale. */
  if (!error || !row || row.colour !== colour) return { rows, problems };
  return {
    rows: rows.map((one) => (one.id === id ? { ...one, colour: saved[id] } : one)),
    problems: { ...problems, [id]: `not saved — ${row?.name ?? ""}: ${error}` },
  };
}
