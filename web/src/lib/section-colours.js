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
 * @template {{ id: string, name: string, colour?: string | null }} Row
 * @param {{ rows: Row[], saved: Record<string, string | null | undefined>, problems: Record<string, string>, id: string, colour: string, error: string | null }} outcome
 */
export function settleColourPick({ rows, saved, problems, id, colour, error }) {
  const row = rows.find((one) => one.id === id);
  /* A later pick of this section is the latest word: this failure is stale. */
  if (!error || !row || row.colour !== colour) return { rows, problems };
  return {
    rows: rows.map((one) => (one.id === id ? /** @type {Row} */ ({ ...one, colour: saved[id] }) : one)),
    problems: { ...problems, [id]: `not saved — ${row?.name ?? ""}: ${error}` },
  };
}

/**
 * Whether a failed colour save was refused or its outcome is unknown (#1915
 * W-R1, after `rotateRelayReconciled`, #1810 W-R2). A 4xx other than 412 is the
 * server's refusal; anything else (no answer, a 5xx, a lost reply, a 412) may
 * have applied and is settled by a re-read.
 * @param {unknown} error
 * @returns {"refused" | "unknown"}
 */
export function colourFailureKind(error) {
  const status = /** @type {{ status?: unknown } | null | undefined} */ (error)?.status;
  return typeof status === "number" && status >= 400 && status < 500 && status !== 412 ? "refused" : "unknown";
}

/**
 * Settles a colour pick whose outcome was unknown, after the saved list was
 * read again. `reread` is "ok" (and `stored` is the stored colour) or
 * "failed". A stored colour matching the pick is a save: the problem is
 * dropped. A different one reverts the swatch to it. A failed re-read keeps
 * the picked swatch, so the next Save does not overwrite a colour that landed.
 * @template {{ id: string, name: string, colour?: string | null }} Row
 * @param {{ rows: Row[], problems: Record<string, string>, id: string, colour: string, stored?: string | null, reread: "ok" | "failed" }} outcome
 */
export function settleUnknownColourPick({ rows, problems, id, colour, stored, reread }) {
  const row = rows.find((one) => one.id === id);
  /* A later pick of this section is the latest word: this outcome is stale. */
  if (!row || row.colour !== colour) return { rows, problems };
  if (reread === "ok" && stored === colour) return { rows, problems: startColourPick(problems, id) };
  if (reread === "ok") {
    return {
      rows: rows.map((one) => (one.id === id ? /** @type {Row} */ ({ ...one, colour: stored }) : one)),
      problems: { ...problems, [id]: `not confirmed — ${row.name}: Orbit could not reach your sections; this is the colour as stored` },
    };
  }
  return { rows, problems: { ...problems, [id]: `not confirmed — ${row.name}: Orbit could not reach your sections. reload to see the saved colour` } };
}
