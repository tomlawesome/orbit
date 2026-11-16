import { describe, expect, it } from "vitest";

import { workspaceSchema } from "../../src/lib/workspace";
import { WORKSPACE_FIXTURE } from "../../web/src/lib/data/fixtures/workspace.js";
import { SCENES_COOKIE, SAVED_COOKIE, MOT_NOTES, documentsOf, keepSave, withScenes } from "../../web/src/lib/server/fixture-scenes.js";

/*
 * #1609: under ORBIT_FIXTURES=1 a browser that opts in (a rig state sets the
 * cookie) has its item saves held in its own cookie, so a journey that saves
 * an item and lands on `/home?item=<id>` finds it in the workspace home's
 * server load reads. A browser that did not opt in sees the sample workspace
 * untouched, which is what keeps every pixel baseline where it was.
 */

/** A cookie jar with the one method pair the fixture helpers use. */
const jar = (/** @type {Record<string, string>} */ start = {}) => {
  const held = { ...start };
  return { held, get: (/** @type {string} */ name) => held[name], set: (/** @type {string} */ name, /** @type {string} */ value) => { held[name] = value; } };
};

const upsert = (/** @type {string} */ id, /** @type {Record<string, unknown>} */ item = {}) => ({
  type: "item.upsert", householdId: "hh-harlow-1",
  item: { id, sectionId: "s-home", title: "Kept by the fixture", currency: "GBP", ...item },
});

const harlow = (/** @type {typeof WORKSPACE_FIXTURE} */ workspace) => workspace.households.find((one) => one.id === "hh-harlow-1");

describe("fixture saves", () => {

  it("leaves the workspace and the jar alone for a browser that did not opt in", () => {
    const cookies = jar();
    keepSave(cookies, upsert("i-new"));
    expect(cookies.held).toEqual({});
    expect(withScenes(WORKSPACE_FIXTURE, cookies)).toBe(WORKSPACE_FIXTURE);
  });

  it("holds a saved item for a browser that did, and the workspace still parses with the engine's schema", () => {
    const cookies = jar({ [SCENES_COOKIE]: "keep-saves" });
    keepSave(cookies, upsert("i-new", { dueDate: "2026-09-01", recurrenceMonths: 12 }));
    const workspace = withScenes(WORKSPACE_FIXTURE, cookies);
    const kept = harlow(workspace)?.items.find((one) => one.id === "i-new");
    expect(kept).toMatchObject({ title: "Kept by the fixture", scheduleKind: "renewal", status: "active", version: 1 });
    expect(kept).not.toHaveProperty("kind");
    expect(kept?.subtype).toBeUndefined();
    expect(workspaceSchema.safeParse(workspace).success).toBe(true);
    expect(harlow(WORKSPACE_FIXTURE)?.items.some((one) => one.id === "i-new")).toBe(false);
  });

  it("holds an unscheduled item too, and replaces an item saved again", () => {
    const cookies = jar({ [SCENES_COOKIE]: "keep-saves" });
    keepSave(cookies, upsert("i-new"));
    keepSave(cookies, upsert("i-new", { title: "Renamed" }));
    const workspace = withScenes(WORKSPACE_FIXTURE, cookies);
    const same = harlow(workspace)?.items.filter((one) => one.id === "i-new") ?? [];
    expect(same).toHaveLength(1);
    expect(same[0]).toMatchObject({ title: "Renamed" });
    expect(same[0]).not.toHaveProperty("kind");
    expect(same[0].scheduleKind).toBeUndefined();
    expect(workspaceSchema.safeParse(workspace).success).toBe(true);
  });

  it("adds the archived item and its paper only for a browser that asked, and the workspace parses", () => {
    expect(documentsOf("i-archived", jar())).toEqual([]);
    expect(withScenes(WORKSPACE_FIXTURE, jar())).toBe(WORKSPACE_FIXTURE);
    const cookies = jar({ [SCENES_COOKIE]: "archived-item" });
    const workspace = withScenes(WORKSPACE_FIXTURE, cookies);
    expect(harlow(workspace)?.items.find((one) => one.id === "i-archived")).toMatchObject({ status: "archived" });
    expect(documentsOf("i-archived", cookies).map((one) => one.displayName)).toEqual(["archived-proving.pdf"]);
    expect(documentsOf("i-mot", cookies)).toHaveLength(2);
    expect(workspaceSchema.safeParse(workspace).success).toBe(true);
    /* An item saved under both scenes keeps both. */
    const both = jar({ [SCENES_COOKIE]: "keep-saves,archived-item" });
    keepSave(both, upsert("i-new"));
    expect(harlow(withScenes(WORKSPACE_FIXTURE, both))?.items.map((one) => one.id)).toEqual(expect.arrayContaining(["i-new", "i-archived"]));
  });

  it("gives the Car MOT its note only for a browser that asked, and the workspace parses", () => {
    const motOf = (/** @type {typeof WORKSPACE_FIXTURE} */ workspace) => harlow(workspace)?.items.find((one) => one.id === "i-mot");
    expect(motOf(WORKSPACE_FIXTURE)?.notes).toBeUndefined();
    const workspace = withScenes(WORKSPACE_FIXTURE, jar({ [SCENES_COOKIE]: "noted-item" }));
    expect(motOf(workspace)?.notes).toBe(MOT_NOTES);
    expect(MOT_NOTES).toBe("Book the early slot.");
    expect(workspaceSchema.safeParse(workspace).success).toBe(true);
  });

  it("ignores a command the engine would refuse, any other command, and a damaged cookie", () => {
    const cookies = jar({ [SCENES_COOKIE]: "keep-saves" });
    keepSave(cookies, { type: "item.upsert", householdId: "hh-harlow-1" });
    keepSave(cookies, { type: "household.activate", householdId: "hh-seaside-4551" });
    expect(cookies.held[SAVED_COOKIE]).toBeUndefined();
    cookies.held[SAVED_COOKIE] = "{not json";
    expect(withScenes(WORKSPACE_FIXTURE, cookies)).toBe(WORKSPACE_FIXTURE);
  });

  it("keeps the cookie small by dropping the oldest saves", () => {
    const cookies = jar({ [SCENES_COOKIE]: "keep-saves" });
    for (let n = 0; n < 8; n++) keepSave(cookies, upsert(`i-${n}`, { notes: "x".repeat(400) }));
    expect(cookies.held[SAVED_COOKIE].length).toBeLessThanOrEqual(1200);
    const ids = harlow(withScenes(WORKSPACE_FIXTURE, cookies))?.items.map((one) => one.id) ?? [];
    expect(ids).toContain("i-7");
    expect(ids).not.toContain("i-0");
  });
});

/*
 * #1463: the fixture's Harlow Home items carry round 6 P's importance split,
 * and a save under keep-saves keeps the level it was sent with.
 */
describe("fixture importance (#1463)", () => {
  it("gives the Harlow Home items P's split, with i-svc not set", () => {
    const byId = Object.fromEntries((harlow(WORKSPACE_FIXTURE)?.items ?? []).map((one) => [one.id, one.importance]));
    expect(byId).toMatchObject({
      "i-gutter": "high", "i-mot": "high", "i-roof": "high",
      "i-boiler": "normal",
      "i-chimney": "low", "i-smoke": "low",
      "i-svc": null,
    });
  });

  it("holds the level a saved item was sent with, and the workspace still parses", () => {
    const cookies = jar({ [SCENES_COOKIE]: "keep-saves" });
    keepSave(cookies, upsert("i-new", { importance: "high" }));
    const workspace = withScenes(WORKSPACE_FIXTURE, cookies);
    expect(harlow(workspace)?.items.find((one) => one.id === "i-new")?.importance).toBe("high");
    expect(workspaceSchema.safeParse(workspace).success).toBe(true);
  });

  it("holds a saved item sent without a level as not set (null)", () => {
    const cookies = jar({ [SCENES_COOKIE]: "keep-saves" });
    keepSave(cookies, upsert("i-bare"));
    const kept = harlow(withScenes(WORKSPACE_FIXTURE, cookies))?.items.find((one) => one.id === "i-bare");
    expect(kept?.importance).toBeNull();
  });

  it("changes the level of a saved item that is saved again, and leaves it when the save does not mention it", () => {
    const cookies = jar({ [SCENES_COOKIE]: "keep-saves" });
    keepSave(cookies, upsert("i-new", { importance: "low" }));
    keepSave(cookies, upsert("i-new", { importance: "normal" }));
    expect(harlow(withScenes(WORKSPACE_FIXTURE, cookies))?.items.find((one) => one.id === "i-new")?.importance).toBe("normal");
    keepSave(cookies, upsert("i-new", { title: "Renamed" }));
    expect(harlow(withScenes(WORKSPACE_FIXTURE, cookies))?.items.find((one) => one.id === "i-new")?.importance).toBe("normal");
  });
});

/* #1466 (colour part): the keep-saves scene stores a section's pick and returns
   it with the household; without a save Harlow's sections carry no colour. */
describe("fixture sections carry a colour", () => {
  const replace = (/** @type {Record<string, unknown>} */ homeExtra) => ({
    type: "sections.replace", householdId: "hh-harlow-1",
    sections: harlow(WORKSPACE_FIXTURE)?.sections.map((one) => (one.id === "s-home" ? { ...one, ...homeExtra } : one)),
  });

  it("leaves Harlow's sections with no colour until a pick is saved", () => {
    for (const one of harlow(WORKSPACE_FIXTURE)?.sections ?? []) expect(one.colour ?? null).toBeNull();
  });

  it("keeps a pick for a browser that asked for keep-saves, and returns it", () => {
    const cookies = jar({ [SCENES_COOKIE]: "keep-saves" });
    keepSave(cookies, replace({ colour: "vehicles" }));
    const sections = harlow(withScenes(WORKSPACE_FIXTURE, cookies))?.sections ?? [];
    expect(sections.find((one) => one.id === "s-home")?.colour).toBe("vehicles");
    expect(sections.filter((one) => one.id !== "s-home").map((one) => one.colour ?? null)).toEqual([null, null, null]);
  });

  it("does not keep a pick the engine would refuse", () => {
    const cookies = jar({ [SCENES_COOKIE]: "keep-saves" });
    keepSave(cookies, replace({ colour: "sage" }));
    expect(withScenes(WORKSPACE_FIXTURE, cookies)).toBe(WORKSPACE_FIXTURE);
  });
});
