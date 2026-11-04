import { describe, expect, it } from "vitest";
import { selectWhatsNew } from "@/lib/whats-new";

/* #1618: which releases a person is shown. Pure; the rules from the spec. */
const b = (lead, text = `${lead} text.`) => ({ lead, text });
const notes = [
  { version: "v0.3.5", forEveryone: [b("A5")], forAdministrators: [b("Admin5")] },
  { version: "v0.3.6", forEveryone: [], forAdministrators: [b("Admin6")] },
  { version: "v0.3.7", forEveryone: [b("A7")], forAdministrators: [] },
  { version: "v0.3.8", forEveryone: [], forAdministrators: [] },
  { version: "v0.3.9", forEveryone: [b("A9")], forAdministrators: [b("Admin9")] },
];
const select = (over) => selectWhatsNew({ seen: "v0.3.4", running: "v0.3.9", isAdmin: false, notes, ...over });
const versions = (result) => result.releases.map((r) => r.version);

describe("selectWhatsNew", () => {
  it("lists releases after seen up to running, newest first", () => {
    expect(versions(select({ isAdmin: true }))).toEqual(["v0.3.9", "v0.3.7", "v0.3.6", "v0.3.5"]);
  });

  it("echoes the running version", () => {
    expect(select().version).toBe("v0.3.9");
  });

  it("excludes seen itself and anything above running", () => {
    expect(versions(select({ seen: "v0.3.5", running: "v0.3.7" }))).toEqual(["v0.3.7"]);
    expect(versions(select({ seen: "v0.3.7", running: "v0.3.7" }))).toEqual([]);
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

  it("gives an administrator both parts", () => {
    const { releases } = select({ isAdmin: true });
    expect(releases.find((r) => r.version === "v0.3.9")).toEqual({
      version: "v0.3.9", forEveryone: [b("A9")], forAdministrators: [b("Admin9")],
    });
  });

  it("reaches administrators only when a release has only an administrators part", () => {
    expect(versions(select({ isAdmin: false }))).not.toContain("v0.3.6");
    expect(versions(select({ isAdmin: true }))).toContain("v0.3.6");
  });

  it("leaves out a release with nothing for that person", () => {
    expect(versions(select({ isAdmin: true }))).not.toContain("v0.3.8");
    expect(versions(select({ isAdmin: false }))).not.toContain("v0.3.8");
  });

  it("is empty on a downgrade", () => {
    expect(select({ seen: "v0.3.9", running: "v0.3.6" })).toMatchObject({ releases: [] });
  });

  it("is empty when seen is null (the caller treats null as a new account)", () => {
    expect(select({ seen: null }).releases).toEqual([]);
  });

  it.each([undefined, null, "", "dev", "0.3.9", "v0.3.9-rc1", "v0.3"])(
    "is empty with a null version when running is %j", (running) => {
      expect(select({ running })).toEqual({ version: null, releases: [] });
    },
  );

  it("does not depend on the order of the notes", () => {
    expect(versions(select({ isAdmin: true, notes: [...notes].reverse() }))).toEqual(["v0.3.9", "v0.3.7", "v0.3.6", "v0.3.5"]);
  });

  it("compares numerically", () => {
    const wide = [
      { version: "v0.3.9", forEveryone: [b("nine")], forAdministrators: [] },
      { version: "v0.3.10", forEveryone: [b("ten")], forAdministrators: [] },
    ];
    expect(versions(select({ seen: "v0.3.9", running: "v0.3.10", notes: wide }))).toEqual(["v0.3.10"]);
  });
});
