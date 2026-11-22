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

/*
 * #1915 W-R1: a failed colour save is a refusal only for a 4xx other than 412;
 * anything else (no answer, 5xx, lost reply) is an unknown outcome, settled on
 * a re-read. Names chosen by the tests (the fix adds them to section-colours.js):
 * colourFailureKind(error) -> "refused" | "unknown";
 * settleUnknownColourPick({ rows, problems, id, colour, stored, reread }) where
 * reread is "ok" (stored = the re-read colour) or "failed".
 */
describe("a colour save that fails: refused or unknown (#1915 W-R1)", () => {
  const rows = [{ id: "a", name: "Garden", colour: "red" }, { id: "b", name: "Boat", colour: "green" }];
  const base = { rows, problems: {}, id: "a", colour: "red" };

  it("a 4xx other than 412 is a refusal; 412, 5xx, no status and a lost reply are unknown", async () => {
    const mod = await import("../../web/src/lib/section-colours.js");
    expect(typeof mod.colourFailureKind).toBe("function");
    for (const status of [400, 401, 403, 404, 409, 422, 429, 499]) expect(mod.colourFailureKind({ status })).toBe("refused");
    for (const status of [412, 500, 502, 503, 504, undefined, 0]) expect(mod.colourFailureKind({ status })).toBe("unknown");
    expect(mod.colourFailureKind(new TypeError("Failed to fetch"))).toBe("unknown");
  });

  it("stored equals the pick: saved, no problem, swatch stays", async () => {
    const { settleUnknownColourPick } = await import("../../web/src/lib/section-colours.js");
    const out = settleUnknownColourPick({ ...base, problems: { a: "not saved — Garden: x" }, stored: "red", reread: "ok" });
    expect(out.problems).toEqual({});
    expect(out.rows.find((r) => r.id === "a").colour).toBe("red");
  });

  it("stored differs: reverts to the stored colour with the not-confirmed words", async () => {
    const { settleUnknownColourPick } = await import("../../web/src/lib/section-colours.js");
    const out = settleUnknownColourPick({ ...base, stored: "blue", reread: "ok" });
    expect(out.rows.find((r) => r.id === "a").colour).toBe("blue");
    expect(out.problems.a).toBe("not confirmed — Garden: Orbit could not reach your sections; this is the colour as stored");
  });

  it("the re-read failed: keeps the picked swatch with the reload words", async () => {
    const { settleUnknownColourPick } = await import("../../web/src/lib/section-colours.js");
    const out = settleUnknownColourPick({ ...base, reread: "failed" });
    expect(out.rows.find((r) => r.id === "a").colour).toBe("red");
    expect(out.problems.a).toBe("not confirmed — Garden: Orbit could not reach your sections. reload to see the saved colour");
  });

  it("another section's problem is left alone", async () => {
    const { settleUnknownColourPick } = await import("../../web/src/lib/section-colours.js");
    const out = settleUnknownColourPick({ ...base, problems: { b: "not saved — Boat: y" }, stored: "blue", reread: "ok" });
    expect(out.problems.b).toBe("not saved — Boat: y");
  });
});

describe("the household page wires the split (#1915 W-R1)", () => {
  const page = readFileSync(new URL("../../web/src/routes/household/[id]/+page.svelte", import.meta.url), "utf8");
  const fn = page.slice(page.indexOf("async function saveColours"));
  const body = fn.slice(0, fn.indexOf("function addSection"));
  const catchPart = body.slice(body.indexOf("} catch"));

  it("the catch tells refusals from unknown outcomes and re-reads for the unknown", () => {
    expect(catchPart).toMatch(/colourFailureKind/);
    expect(catchPart).toMatch(/settleUnknownColourPick/);
    expect(catchPart).toMatch(/invalidateAll\(\)/);
  });

  it("an unconfirmed pick is not dropped from pickedColours before the re-read settles", () => {
    const drop = catchPart.indexOf("pickedColours.delete");
    const reread = catchPart.indexOf("invalidateAll()");
    expect(reread).toBeGreaterThan(-1);
    expect(drop === -1 || drop > reread || /refused/.test(catchPart.slice(0, drop))).toBe(true);
  });
});
