import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";

import { startColourPick, settleColourPick } from "../../web/src/lib/section-colours.js";

/*
 * #1879 W-R3: a failed colour pick reverts its swatch to the last saved colour
 * and keeps "not saved — {section}: {words}" until that same section is picked
 * again or the list is saved; another section's pick never clears it.
 * Pure helpers: rows are {id, name, colour}; saved is {id: colour};
 * problems is {id: text}.
 */
describe("section colour picks (#1879 W-R3)", () => {
  const saved = { a: "blue", b: "green" };
  const rows = [
    { id: "a", name: "Kitchen", colour: "blue" },
    { id: "b", name: "Garage", colour: "green" },
  ];
  const colourOf = (list, id) => list.find((row) => row.id === id).colour;

  it("pick A fails: A reverts to its saved colour and A has the problem", () => {
    const picked = rows.map((row) => (row.id === "a" ? { ...row, colour: "red" } : row));
    const out = settleColourPick({ rows: picked, saved, problems: {}, id: "a", colour: "red", error: "offline" });
    expect(colourOf(out.rows, "a")).toBe("blue");
    expect(colourOf(out.rows, "b")).toBe("green");
    expect(out.problems).toEqual({ a: "not saved — Kitchen: offline" });
  });

  it("pick B then succeeds: B keeps its new colour and A's problem stays", () => {
    const afterA = { a: "not saved — Kitchen: offline" };
    const picked = rows.map((row) => (row.id === "b" ? { ...row, colour: "amber" } : row));
    const started = startColourPick(afterA, "b");
    expect(started).toEqual(afterA);
    const out = settleColourPick({ rows: picked, saved, problems: started, id: "b", colour: "amber", error: null });
    expect(colourOf(out.rows, "b")).toBe("amber");
    expect(out.problems).toEqual(afterA);
  });

  it("pick A again: A's problem is cleared at send, others kept", () => {
    const problems = { a: "not saved — Kitchen: offline", b: "not saved — Garage: busy" };
    expect(startColourPick(problems, "a")).toEqual({ b: "not saved — Garage: busy" });
  });

  it("does not change its inputs", () => {
    const problems = { a: "x" };
    startColourPick(problems, "a");
    settleColourPick({ rows, saved, problems, id: "a", colour: "red", error: "no" });
    expect(problems).toEqual({ a: "x" });
    expect(colourOf(rows, "a")).toBe("blue");
  });

  it("latest pick wins: A red fails after A green was picked, so nothing reverts and no error shows", () => {
    // red sent, then green picked (row shows green, A's problem cleared at send),
    // then red's failure lands.
    const showing = rows.map((row) => (row.id === "a" ? { ...row, colour: "green" } : row));
    const out = settleColourPick({ rows: showing, saved, problems: {}, id: "a", colour: "red", error: "offline" });
    expect(colourOf(out.rows, "a")).toBe("green");
    expect(out.problems).toEqual({});
  });

  it("a failure still reverts when the row shows the colour that failed", () => {
    const showing = rows.map((row) => (row.id === "a" ? { ...row, colour: "red" } : row));
    const out = settleColourPick({ rows: showing, saved, problems: {}, id: "a", colour: "red", error: "offline" });
    expect(colourOf(out.rows, "a")).toBe("blue");
    expect(out.problems.a).toBe("not saved — Kitchen: offline");
  });

  it("a section with no stored colour reverts to exactly its snapshot (still unedited)", () => {
    const plain = [{ id: "c", name: "Attic", colour: "" }];
    const showing = [{ id: "c", name: "Attic", colour: "red" }];
    const out = settleColourPick({ rows: showing, saved: { c: "" }, problems: {}, id: "c", colour: "red", error: "x" });
    expect(out.rows).toEqual(plain);
    expect(JSON.stringify(out.rows)).toBe(JSON.stringify(plain));
  });

  it("the household page builds `saved` from each section's stored colour, not sectionColourOf", () => {
    const page = readFileSync(new URL("../../web/src/routes/household/[id]/+page.svelte", import.meta.url), "utf8");
    const line = page.split("\n").find((one) => one.includes("const saved = Object.fromEntries"));
    expect(line, "the saved snapshot line").toBeTruthy();
    expect(line).not.toMatch(/sectionColourOf/);
    expect(line).toMatch(/one\.colour/);
  });
});
