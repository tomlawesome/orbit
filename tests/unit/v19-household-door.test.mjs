import { beforeEach, describe, expect, it } from "vitest";

// §15, owner ruling 2026-08-17: the household screen's way back is the way you
// came in. Arriving by the helm it reads "← SETTINGS"; arriving by the sun at
// the centre of the dial (ce86c7e) it reads "← YOUR SKY" and returns to /home.
// The signal is the family's one-shot session marker — the launch signal's
// pattern (lib/flight/arrival.js) and the old dashboard's settings-return-focus
// — so the storage is injectable and the rule is testable in node.
import {
  DEFAULT_DOOR,
  DOORS,
  DOOR_KEY,
  consumeDoor,
  markDoor,
} from "../../web/src/routes/household/[id]/door.js";
import { sunHref } from "../../web/src/routes/home/home.behaviour.js";

/** A session store, as unforgiving as the real one about types. */
const fakeStorage = () => {
  const map = new Map();
  return {
    getItem: (key) => (map.has(key) ? map.get(key) : null),
    setItem: (key, value) => map.set(key, String(value)),
    removeItem: (key) => map.delete(key),
    get size() { return map.size; },
  };
};

let storage;
beforeEach(() => { storage = fakeStorage(); });

describe("the way back is the way you came", () => {
  it("reads the helm when nothing was marked — every deep link and bookmark", () => {
    expect(consumeDoor(storage)).toEqual({ name: "settings", href: "/settings", label: "← SETTINGS" });
    expect(DEFAULT_DOOR).toBe(DOORS.settings);
  });

  it("reads the sky when the sun marked the door", () => {
    expect(markDoor("sky", storage)).toBe(true);
    expect(consumeDoor(storage)).toEqual({ name: "sky", href: "/home", label: "← YOUR SKY" });
  });

  it("takes the marker away as it reads it, so only that arrival wears it", () => {
    markDoor("sky", storage);
    expect(consumeDoor(storage).name).toBe("sky");
    // A refresh, a Back into the screen, a visit typed into the bar: the door
    // that outlived its own journey would start answering for journeys it knows
    // nothing about (consumeLaunch's rule, for consumeLaunch's reason).
    expect(consumeDoor(storage).name).toBe("settings");
    expect(storage.size).toBe(0);
  });

  it("marks under a namespaced key, so two features cannot collide", () => {
    markDoor("sky", storage);
    expect(storage.getItem(DOOR_KEY)).toBe("sky");
    expect(DOOR_KEY).toBe("orbit-household-door");
  });

  it("ignores a door nobody drew", () => {
    expect(markDoor("kitchen-window", storage)).toBe(false);
    expect(storage.size).toBe(0);
    storage.setItem(DOOR_KEY, "kitchen-window");
    expect(consumeDoor(storage).name).toBe("settings");
  });

  it("falls to the helm when storage is denied outright", () => {
    // The way back is never a gate: a browser that refuses session storage gets
    // the ratified door and a working screen.
    const refuses = {
      getItem() { throw new Error("denied"); },
      setItem() { throw new Error("denied"); },
      removeItem() { throw new Error("denied"); },
    };
    expect(markDoor("sky", refuses)).toBe(false);
    expect(consumeDoor(refuses)).toBe(DEFAULT_DOOR);
  });

  it("sends each door somewhere the app actually serves", () => {
    expect(DOORS.settings.href).toBe("/settings");
    expect(DOORS.sky.href).toBe("/home");
    // And the door it is paired with: the sun's own address, which is the
    // screen doing the reading.
    expect(sunHref("hh-lawson-1")).toBe("/household/hh-lawson-1");
  });
});
