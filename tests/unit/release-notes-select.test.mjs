import { describe, expect, it } from "vitest";
import { selectReleaseNotes, selectWhatsNew } from "@/lib/whats-new";

/*
 * #1713: the About page's "Release notes" list. Pure, beside selectWhatsNew
 * (#1618), and filtered by role the same way: a member gets the for-everyone
 * part only (no forAdministrators key), an administrator both parts, and a
 * release with nothing for that person is left out. Unlike the card it has no
 * window: every bundled release, newest first, whatever the person has seen.
 *
 * Interface fixed here: selectReleaseNotes({ running, isAdmin, notes }) ->
 * { version, releases }, the same shape as GET /api/whats-new; `version` is
 * the running version, or null when it does not parse (a dev build).
 */
const b = (lead, text = `${lead} text.`) => ({ lead, text });
const notes = [
  { version: "v0.3.5", forEveryone: [b("A5")], forAdministrators: [b("Admin5")] },
  { version: "v0.3.6", forEveryone: [], forAdministrators: [b("Admin6")] },
  { version: "v0.3.7", forEveryone: [b("A7")], forAdministrators: [] },
  { version: "v0.3.8", forEveryone: [], forAdministrators: [] },
  { version: "v0.3.9", forEveryone: [b("A9")], forAdministrators: [b("Admin9")] },
];
const select = (over) => selectReleaseNotes({ running: "v0.3.9", isAdmin: false, notes, ...over });
const versions = (result) => result.releases.map((r) => r.version);

describe("selectReleaseNotes (#1713)", () => {
  it("lists every bundled release for an administrator, newest first", () => {
    expect(versions(select({ isAdmin: true }))).toEqual(["v0.3.9", "v0.3.7", "v0.3.6", "v0.3.5"]);
  });

  it("echoes the running version, so the page can mark it", () => {
    expect(select().version).toBe("v0.3.9");
    expect(select({ running: "v0.3.7" }).version).toBe("v0.3.7");
  });

  it("gives a member the everyone part only, with no administrators key", () => {
    const { releases } = select({ isAdmin: false });
    expect(releases).toEqual([
      { version: "v0.3.9", forEveryone: [b("A9")] },
      { version: "v0.3.7", forEveryone: [b("A7")] },
      { version: "v0.3.5", forEveryone: [b("A5")] },
    ]);
    for (const release of releases) expect("forAdministrators" in release).toBe(false);
  });

  it("gives an administrator both parts of each release", () => {
    expect(select({ isAdmin: true }).releases).toEqual([
      { version: "v0.3.9", forEveryone: [b("A9")], forAdministrators: [b("Admin9")] },
      { version: "v0.3.7", forEveryone: [b("A7")], forAdministrators: [] },
      { version: "v0.3.6", forEveryone: [], forAdministrators: [b("Admin6")] },
      { version: "v0.3.5", forEveryone: [b("A5")], forAdministrators: [b("Admin5")] },
    ]);
  });

  it("leaves out a release with nothing for that person", () => {
    expect(versions(select({ isAdmin: false }))).not.toContain("v0.3.6");
    expect(versions(select({ isAdmin: true }))).not.toContain("v0.3.8");
    expect(versions(select({ isAdmin: false }))).not.toContain("v0.3.8");
  });

  it("does not depend on what the person has seen: no seen input, no window", () => {
    /* The card would show nothing at seen == running; the page still lists everything. */
    expect(selectWhatsNew({ seen: "v0.3.9", running: "v0.3.9", isAdmin: false, notes }).releases).toEqual([]);
    expect(versions(select())).toEqual(["v0.3.9", "v0.3.7", "v0.3.5"]);
  });

  it("is empty, not an error, with no notes at all", () => {
    expect(select({ notes: [] })).toEqual({ version: "v0.3.9", releases: [] });
  });

  it("is empty when every release is empty", () => {
    const blank = [{ version: "v0.3.7", forEveryone: [], forAdministrators: [] }];
    expect(select({ isAdmin: true, notes: blank }).releases).toEqual([]);
  });

  it.each([undefined, null, "", "dev", "0.3.9", "v0.3.9-rc1", "v0.3"])(
    "still lists every release, with a null version, when running is %j (nothing is marked)", (running) => {
      const answer = select({ running, isAdmin: true });
      expect(answer.version).toBeNull();
      expect(versions(answer)).toEqual(["v0.3.9", "v0.3.7", "v0.3.6", "v0.3.5"]);
    },
  );

  it("does not depend on the order of the notes", () => {
    expect(versions(select({ isAdmin: true, notes: [...notes].reverse() }))).toEqual(["v0.3.9", "v0.3.7", "v0.3.6", "v0.3.5"]);
  });

  it("compares numerically", () => {
    const wide = [
      { version: "v0.3.9", forEveryone: [b("nine")], forAdministrators: [] },
      { version: "v0.3.10", forEveryone: [b("ten")], forAdministrators: [] },
      { version: "v0.10.0", forEveryone: [b("ten-minor")], forAdministrators: [] },
    ];
    expect(versions(select({ running: "v0.10.0", notes: wide }))).toEqual(["v0.10.0", "v0.3.10", "v0.3.9"]);
  });

  it("leaves out a notes entry whose version does not parse, as the card does", () => {
    const odd = [...notes, { version: "next", forEveryone: [b("odd")], forAdministrators: [] }];
    expect(versions(select({ notes: odd }))).toEqual(["v0.3.9", "v0.3.7", "v0.3.5"]);
  });

  it("does not change the notes it was given", () => {
    const copy = structuredClone(notes);
    select({ isAdmin: true });
    select({ isAdmin: false });
    expect(notes).toEqual(copy);
  });
});

describe("selectReleaseNotes filters by role exactly as GET /api/whats-new does (#1713)", () => {
  /* For a person who has seen nothing yet (v0.0.0), the card's selection is
     every release up to running; the page's list must hold the same entries. */
  it.each([[false, "a member"], [true, "an administrator"]])("same entries for %s (%s)", (isAdmin) => {
    const card = selectWhatsNew({ seen: "v0.0.0", running: "v0.3.9", isAdmin, notes });
    const page = selectReleaseNotes({ running: "v0.3.9", isAdmin, notes });
    expect(page).toEqual(card);
  });
});
