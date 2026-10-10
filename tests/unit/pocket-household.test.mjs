import { describe, expect, it } from "vitest";

// The household on a phone (#1122, design/v19/phone-vision/proposal.md §2.10):
// what the rising save bar counts (owner decision 2b), the list moves it
// collects, home's chip carried onto the page, and the archive card's rules.
import { changesLabel, changesOf, chipBodyOf, commandsFor, moved } from "../../web/src/routes/household/[id]/edits.js";
import {
  archiveFileProblem, passphraseProblem, sizeLabel,
} from "../../web/src/routes/household/[id]/archive.js";

const identity = { name: "Lawson Home", timezone: "Europe/London", currency: "GBP" };
const sections = [
  { id: "s-home", name: "Home", icon: "home", visible: true },
  { id: "s-car", name: "Vehicles", icon: "vehicle", visible: true },
  { id: "s-dates", name: "Dates", icon: "hook", visible: true },
];
const saved = { identity, sections };
/** @param {Partial<typeof saved>} over */
const local = (over = {}) => ({ identity: { ...identity }, sections: sections.map((row) => ({ ...row })), ...over });

describe("the save bar's changes (2b)", () => {
  it("counts nothing when nothing moved, so the bar stays down", () => {
    expect(changesOf(saved, local())).toEqual([]);
  });

  it("counts each field of the system once, ignoring edge spaces on the name", () => {
    expect(changesOf(saved, local({ identity: { ...identity, name: " Lawson Home " } }))).toEqual([]);
    expect(changesOf(saved, local({ identity: { name: "Home", timezone: "UTC", currency: "EUR" } })))
      .toEqual(["name", "timezone", "currency"]);
  });

  it("counts a section once however many of its parts changed", () => {
    const rows = local().sections;
    rows[0].visible = false;
    rows[0].name = "House";
    expect(changesOf(saved, local({ sections: rows }))).toEqual(["edit s-home"]);
  });

  it("counts an added section, and a removed one, and forgets a section added then removed", () => {
    const rows = [...local().sections, { id: "new", name: "Pets", icon: "kite", visible: true, fresh: true }];
    rows[2].removed = true;
    expect(changesOf(saved, local({ sections: rows }))).toEqual(["remove s-dates", "add new"]);
    rows[3].removed = true;
    expect(changesOf(saved, local({ sections: rows }))).toEqual(["remove s-dates"]);
  });

  it("counts a reorder once, however many rows moved", () => {
    const rows = local().sections;
    expect(changesOf(saved, local({ sections: [rows[2], rows[0], rows[1]] }))).toEqual(["order"]);
  });

  it("does not call removing a row a reorder", () => {
    const rows = local().sections;
    rows[1].removed = true;
    expect(changesOf(saved, local({ sections: [rows[0], rows[2], rows[1]] }))).toEqual(["remove s-car"]);
  });

  it("sends only the commands that changed", () => {
    expect(commandsFor(["name"])).toEqual({ identity: true, sections: false });
    expect(commandsFor(["order"])).toEqual({ identity: false, sections: true });
    expect(commandsFor(["currency", "add x"])).toEqual({ identity: true, sections: true });
  });

  it("says the count in words", () => {
    expect(changesLabel(1)).toBe("1 change");
    expect(changesLabel(3)).toBe("3 changes");
  });
});

describe("long-press reorder", () => {
  it("moves a row and leaves the original list alone", () => {
    const list = ["a", "b", "c", "d"];
    expect(moved(list, 0, 2)).toEqual(["b", "c", "a", "d"]);
    expect(moved(list, 3, 0)).toEqual(["d", "a", "b", "c"]);
    expect(list).toEqual(["a", "b", "c", "d"]);
  });

  it("gives the same list back for a move off either end", () => {
    const list = ["a", "b"];
    expect(moved(list, 0, -1)).toBe(list);
    expect(moved(list, 1, 2)).toBe(list);
  });
});

describe("home's chip, carried onto the page", () => {
  it("places the body at the angle the id fixes, on the given radius", () => {
    expect(chipBodyOf(0, 10)).toEqual({ x: 10, y: 0 });
    const quarter = chipBodyOf(0xffffffff / 4, 10);
    expect(quarter.x).toBeCloseTo(0, 1);
    expect(quarter.y).toBeCloseTo(10, 1);
  });
});

// The engine's numbers as the session carries them (#1336); the card holds none.
const LIMITS = { archiveFileBytes: 179_022_508, passphraseMin: 12, passphraseMax: 256 };

describe("the archive card", () => {
  it("asks for the engine's passphrase length and the same passphrase twice", () => {
    expect(passphraseProblem("short", "short", LIMITS)).toMatch(/at least 12/);
    expect(passphraseProblem("correct horse battery", "correct horse", LIMITS)).toMatch(/not the same/);
    expect(passphraseProblem("x".repeat(257), "x".repeat(257), LIMITS)).toMatch(/at most 256/);
    expect(passphraseProblem("correct horse battery", "correct horse battery", LIMITS)).toBeNull();
    expect(passphraseProblem("short", "short", { ...LIMITS, passphraseMin: 20 })).toMatch(/at least 20/);
  });

  it("counts the floor in code points, as the engine does", () => {
    // Six emoji are twelve UTF-16 units but six characters.
    expect(passphraseProblem("😀".repeat(6), "😀".repeat(6), LIMITS)).toMatch(/at least 12/);
    expect(passphraseProblem("😀".repeat(12), "😀".repeat(12), LIMITS)).toBeNull();
  });

  it("refuses a passphrase while the engine's bounds are unknown", () => {
    expect(passphraseProblem("correct horse battery", "correct horse battery", null)).toMatch(/reload/);
  });

  it("refuses an empty or oversized file before reading it", () => {
    expect(archiveFileProblem({ size: 0 }, LIMITS)).toMatch(/empty/);
    expect(archiveFileProblem({ size: LIMITS.archiveFileBytes + 1 }, LIMITS)).toMatch(/larger than 171 MB/);
    expect(archiveFileProblem({ size: 130_000_000 }, LIMITS)).toBeNull();
    expect(archiveFileProblem({ size: 2048 }, LIMITS)).toBeNull();
    // No ceiling from the engine: only the empty check is the card's own.
    expect(archiveFileProblem({ size: 2048 }, null)).toBeNull();
  });

  it("prints sizes the way a person reads them", () => {
    expect(sizeLabel(33)).toBe("33 B");
    expect(sizeLabel(84 * 1024)).toBe("84 KB");
    expect(sizeLabel(3.2 * 1024 * 1024)).toBe("3.2 MB");
    expect(sizeLabel(38 * 1024 * 1024)).toBe("38 MB");
  });
});
