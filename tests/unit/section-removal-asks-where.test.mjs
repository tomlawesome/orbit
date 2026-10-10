import { readdirSync, readFileSync, statSync } from "node:fs";
import { describe, expect, it } from "vitest";

// #1332 (where do these entries go?): removing a section that still holds
// entries asks where they go, per section, at the moment it is removed. The
// design decision is the newest note on the issue ("Design decision: where do
// these entries go?"): delete and reassign. The engine half is built
// (`sections.replace` takes `moveItemsTo`); this file holds the interface's
// pure half: the commands the save sends, the save bar's count, and the words.
import { sectionCommandsOf } from "../../web/src/lib/data/household.js";
import { changesOf, commandsFor } from "../../web/src/routes/household/[id]/edits.js";

/** One editor row, in the shape sectionRowsOf gives, plus the editor's own marks. */
const row = (id, name, over = {}) => ({
  id, name, icon: "home", accent: "sage", shipped: false, visible: true,
  count: 0, incoming: 0, removable: true,
  ...over,
});
/** What travels for a row: the engine's own field names and nothing else. */
const sent = (one) => ({ id: one.id, name: one.name, icon: one.icon, accent: one.accent, visible: one.visible });
const ids = (command) => command.sections.map((one) => one.id);

describe("sectionCommandsOf: what a save sends for the sections list", () => {
  it("sends one command, without moveItemsTo, when nothing was dropped", () => {
    const rows = [row("s-home", "Home", { count: 4, removable: false }), row("s-car", "Vehicles")];
    const commands = sectionCommandsOf("hh-1", rows);
    expect(commands).toEqual([
      { type: "sections.replace", householdId: "hh-1", sections: rows.map(sent) },
    ]);
    expect(commands[0]).not.toHaveProperty("moveItemsTo");
  });

  it("sends one command without the row, and without moveItemsTo, for an empty section dropped", () => {
    const rows = [row("s-home", "Home"), row("s-car", "Vehicles", { removed: true }), row("s-pets", "Pets")];
    const commands = sectionCommandsOf("hh-1", rows);
    expect(commands).toHaveLength(1);
    expect(ids(commands[0])).toEqual(["s-home", "s-pets"]);
    expect(commands[0]).not.toHaveProperty("moveItemsTo");
  });

  it("still sends one command when several empty sections go together", () => {
    const rows = [row("a", "A", { removed: true }), row("b", "B"), row("c", "C", { removed: true })];
    const commands = sectionCommandsOf("hh-1", rows);
    expect(commands).toHaveLength(1);
    expect(ids(commands[0])).toEqual(["b"]);
    expect(commands[0]).not.toHaveProperty("moveItemsTo");
  });

  it("names the destination in moveItemsTo when a section holding entries is dropped", () => {
    const rows = [
      row("s-garage", "Garage", { count: 3, removable: false, removed: true, moveTo: "s-car" }),
      row("s-home", "Home"),
      row("s-car", "Vehicles"),
    ];
    expect(sectionCommandsOf("hh-1", rows)).toEqual([
      { type: "sections.replace", householdId: "hh-1", sections: [rows[1], rows[2]].map(sent), moveItemsTo: "s-car" },
    ]);
  });

  it("can send the entries to a section that is new and unsaved, which travels in the same command", () => {
    const rows = [
      row("s-garage", "Garage", { count: 2, removable: false, removed: true, moveTo: "s-new" }),
      row("s-home", "Home"),
      row("s-new", "Workshop", { fresh: true }),
    ];
    const [only, ...rest] = sectionCommandsOf("hh-1", rows);
    expect(rest).toEqual([]);
    expect(ids(only)).toEqual(["s-home", "s-new"]);
    expect(only.moveItemsTo).toBe("s-new");
  });

  it("sends one command per dropped section that held entries, in order, each list shrinking", () => {
    const rows = [
      row("s-a", "A", { count: 2, removable: false, removed: true, moveTo: "s-c" }),
      row("s-b", "B", { count: 1, removable: false, removed: true, moveTo: "s-d" }),
      row("s-c", "C"),
      row("s-d", "D"),
    ];
    const commands = sectionCommandsOf("hh-1", rows);
    expect(commands).toHaveLength(2);
    expect(commands.map((command) => command.type)).toEqual(["sections.replace", "sections.replace"]);
    expect(commands.map((command) => command.householdId)).toEqual(["hh-1", "hh-1"]);
    expect(ids(commands[0])).toEqual(["s-b", "s-c", "s-d"]);
    expect(commands[0].moveItemsTo).toBe("s-c");
    expect(ids(commands[1])).toEqual(["s-c", "s-d"]);
    expect(commands[1].moveItemsTo).toBe("s-d");
  });

  it("resolves a chain in order: entries land in a section that is itself then dropped and asked", () => {
    // A's entries go to B; B (now holding them, `incoming`) was removed and
    // chose C. The first command lands A in B, the second moves B on to C.
    const rows = [
      row("s-a", "A", { count: 2, removable: false, removed: true, moveTo: "s-b" }),
      row("s-b", "B", { count: 0, incoming: 2, removable: false, removed: true, moveTo: "s-c" }),
      row("s-c", "C"),
    ];
    const commands = sectionCommandsOf("hh-1", rows);
    expect(commands).toHaveLength(2);
    expect(ids(commands[0])).toEqual(["s-b", "s-c"]);
    expect(commands[0].moveItemsTo).toBe("s-b");
    expect(ids(commands[1])).toEqual(["s-c"]);
    expect(commands[1].moveItemsTo).toBe("s-c");
  });

  it("ends on the list the person left: an empty drop beside a held one costs no extra entries moved", () => {
    const rows = [
      row("s-a", "A", { count: 2, removable: false, removed: true, moveTo: "s-c" }),
      row("s-b", "B", { removed: true }),
      row("s-c", "C"),
    ];
    const commands = sectionCommandsOf("hh-1", rows);
    expect(ids(commands[commands.length - 1])).toEqual(["s-c"]);
    expect(commands.filter((command) => "moveItemsTo" in command).map((command) => command.moveItemsTo)).toEqual(["s-c"]);
  });

  /* Review of f42ab0ca: an empty drop sent inside a held drop's command rides
     its moveItemsTo, so an entry someone filed in the "empty" section since
     the screen loaded would move there unasked. The empty drops go first, in a
     command of their own with no moveItemsTo, so the engine refuses
     (section_has_items) if one is not empty after all. */
  it("sends the unasked empty drops first, alone, with nowhere named for entries", () => {
    const rows = [
      row("s-a", "A", { count: 2, removable: false, removed: true, moveTo: "s-c" }),
      row("s-b", "B", { removed: true }),
      row("s-c", "C"),
    ];
    const commands = sectionCommandsOf("hh-1", rows);
    expect(commands).toHaveLength(2);
    expect("moveItemsTo" in commands[0] && commands[0].moveItemsTo !== undefined).toBe(false);
    expect(ids(commands[0])).toEqual(["s-a", "s-c"]);
    expect(ids(commands[1])).toEqual(["s-c"]);
    expect(commands[1].moveItemsTo).toBe("s-c");
  });

  it("never drops a chosen destination unasked", () => {
    // B is going to receive A's entries, so B is no longer a section that goes
    // without asking. If B is struck out with no destination of its own, it
    // must not vanish quietly with A's entries inside: the helper refuses, or
    // keeps B in every list it sends.
    const rows = [
      row("s-a", "A", { count: 2, removable: false, removed: true, moveTo: "s-b" }),
      row("s-b", "B", { count: 0, incoming: 2, removable: false, removed: true }),
      row("s-c", "C"),
    ];
    expect(typeof sectionCommandsOf).toBe("function");
    let commands;
    try {
      commands = sectionCommandsOf("hh-1", rows);
    } catch {
      return;
    }
    for (const command of commands) expect(ids(command)).toContain("s-b");
  });

  it("leaves the rows it was given alone", () => {
    const rows = [
      row("s-a", "A", { count: 2, removable: false, removed: true, moveTo: "s-b" }),
      row("s-b", "B"),
    ];
    const before = structuredClone(rows);
    sectionCommandsOf("hh-1", rows);
    expect(rows).toEqual(before);
  });
});

describe("the phone's save bar counts a section sent elsewhere as one removal", () => {
  const saved = {
    identity: { name: "Lawson Home", timezone: "Europe/London", currency: "GBP" },
    sections: [
      { id: "s-home", name: "Home", icon: "home", visible: true },
      { id: "s-car", name: "Vehicles", icon: "vehicle", visible: true },
      { id: "s-garage", name: "Garage", icon: "tool", visible: true },
    ],
  };
  const local = (rows) => ({ identity: { ...saved.identity }, sections: rows });
  const rows = () => saved.sections.map((one) => ({ ...one }));

  it("counts a removed row carrying moveTo as a remove, once", () => {
    const next = rows();
    next[2].removed = true;
    next[2].moveTo = "s-car";
    expect(changesOf(saved, local(next))).toEqual(["remove s-garage"]);
  });

  it("does not count the destination as edited", () => {
    const next = rows();
    next[2].removed = true;
    next[2].moveTo = "s-car";
    expect(changesOf(saved, local(next))).not.toContain("edit s-car");
  });

  it("makes the save send the sections list", () => {
    const next = rows();
    next[2].removed = true;
    next[2].moveTo = "s-car";
    expect(commandsFor(changesOf(saved, local(next)))).toEqual({ identity: false, sections: true });
  });

  it("forgets a new section that was removed again, whatever it was sent to", () => {
    const next = [...rows(), { id: "s-new", name: "Pets", icon: "kite", visible: true, fresh: true, removed: true, moveTo: "s-car" }];
    expect(changesOf(saved, local(next))).toEqual([]);
  });
});

/* ── the words ────────────────────────────────────────────────────────────
   The notes name no pure function for the heading or the status line, so the
   strings are held to their source: wherever the screens draw them. The
   rendered text is walked in tests/e2e/v19-household-where-entries.spec.ts. */
const root = new URL("../../web/src/", import.meta.url);
/** @param {URL} dir @returns {string[]} */
function sourcesUnder(dir) {
  return readdirSync(dir).flatMap((name) => {
    const path = new URL(name, dir);
    if (statSync(path).isDirectory()) return sourcesUnder(new URL(`${name}/`, dir));
    return /\.(svelte|js)$/.test(name) ? [readFileSync(path, "utf8")] : [];
  });
}
const everything = sourcesUnder(root).join("\n");
const desk = readFileSync(new URL("routes/household/[id]/+page.svelte", root), "utf8");
const phone = readFileSync(new URL("routes/household/[id]/pocket.svelte", root), "utf8");
const pickSheet = readFileSync(new URL("routes/household/[id]/PickSheet.svelte", root), "utf8");

describe("the words of the where-do-these-entries-go chooser (#1332)", () => {
  it("heads the chooser 'where N entries go' and 'where 1 entry goes'", () => {
    expect(/where[^\n]*\bgoes\b/.test(everything), `everything must match ${/where[^\n]*\bgoes\b/}`).toBe(true);
    expect(/where[^\n]*\bgo\b/.test(everything), `everything must match ${/where[^\n]*\bgo\b/}`).toBe(true);
  });

  it("says in the status line which section is removed and where its entries move", () => {
    expect(/removed · /.test(everything), `everything must match ${/removed · /}`).toBe(true);
    expect(/move to /.test(everything), `everything must match ${/move to /}`).toBe(true);
    expect(/when you save/.test(everything), `everything must match ${/when you save/}`).toBe(true);
  });

  it("notes a hidden section 'hidden' and an unsaved one 'new', under the group label 'sections'", () => {
    expect(/note:\s*["'`]hidden["'`]/.test(everything), `everything must match ${/note:\s*["'`]hidden["'`]/}`).toBe(true);
    expect(/note:\s*["'`]new["'`]/.test(everything), `everything must match ${/note:\s*["'`]new["'`]/}`).toBe(true);
    expect(/label:\s*["'`]sections["'`]/.test(everything), `everything must match ${/label:\s*["'`]sections["'`]/}`).toBe(true);
  });

  it("labels the desk × 'Remove <name>', not 'Remove section'", () => {
    expect(/Remove section/.test(desk), `desk must not match ${/Remove section/}`).toBe(false);
    expect(/aria-label=["{`']*Remove [$]?\{/.test(desk), `desk must match ${/aria-label=["{`']*Remove [$]?\{/}`).toBe(true);
  });

  it("keeps the desk's refusal in the words 'not saved — '", () => {
    expect(/not saved — /.test(desk), `desk must match ${/not saved — /}`).toBe(true);
  });

  it("offers the phone's remove act as 'remove' / 'Remove <name>' for every row, not only the empty ones", () => {
    expect(/label: "remove", name: `Remove \$\{sectionName\(row\)\}`/.test(phone), `phone must match ${/label: "remove", name: `Remove \$\{sectionName\(row\)\}`/}`).toBe(true);
    expect(/row\.removable \? \[\{ label: "remove"/.test(phone), `phone must not match ${/row\.removable \? \[\{ label: "remove"/}`).toBe(false);
  });

  it("opens the same tiles for a section on the phone, through the pick sheet", () => {
    expect(/["']section["']/.test(pickSheet), `pickSheet must match ${/["']section["']/}`).toBe(true);
    expect(/kind[=:]\s*\{?\s*["']section["']/.test(phone), `phone must match ${/kind[=:]\s*\{?\s*["']section["']/}`).toBe(true);
  });

  it("seats the desk chooser card beside the row, as the section's tiles", () => {
    expect(/["']section["']/.test(desk), `desk must match ${/["']section["']/}`).toBe(true);
    expect(/layout=["{]*["']?beside/.test(desk), `desk must match ${/layout=["{]*["']?beside/}`).toBe(true);
  });
});

/* Review of f42ab0ca: with several held drops the save is several commands.
   If a later one is refused for any reason, the earlier ones have already
   saved, so the editor must reload to the true list, not only on
   section_has_items. */
describe("a save that stops part-way shows the true list (#1332)", () => {
  const read = (path) => readFileSync(new URL(`../../${path}`, import.meta.url), "utf8");
  it("writeSections marks a refusal that came after earlier commands saved", () => {
    const source = read("web/src/lib/data/workspace.js");
    const body = source.slice(source.indexOf("export async function writeSections"));
    expect(body.slice(0, body.indexOf("\n}\n"))).toMatch(/\.partial\s*=\s*true/);
  });
  it("desk and phone reload on a part-way refusal", () => {
    for (const path of ["web/src/routes/household/[id]/+page.svelte", "web/src/routes/household/[id]/pocket.svelte"]) {
      expect(read(path), path).toMatch(/\.partial\b/);
    }
  });
});

