import { describe, expect, it } from "vitest";
import { notes } from "@/release-notes/v0.3.7";

/* #1926: the v0.3.7 "Importance" entry wording, decided by the owner (54b). */
const importance = notes.forEveryone.find((entry) => entry.lead === "Importance");

describe("v0.3.7 Importance entry (#1926)", () => {
  it("says exactly the owner's sentence", () => {
    expect(importance?.text).toBe(
      "Every item now has an importance, low, normal or high, and you can have its planet's size show importance instead of cost.",
    );
  });

  it("does not name medium or colour", () => {
    expect(importance?.text).not.toContain("medium");
    expect(importance?.text).not.toContain("colour");
  });
});
