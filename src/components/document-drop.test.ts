import { describe, expect, it } from "vitest";
import { carriesFiles, leavesDropZone } from "./document-drop";

describe("drop target predicates", () => {
  it("accepts a drag that carries files", () => {
    expect(carriesFiles(["Files"])).toBe(true);
    expect(carriesFiles(["text/plain", "Files"])).toBe(true);
  });

  it("ignores drags that carry no files", () => {
    expect(carriesFiles(["text/plain"])).toBe(false);
    expect(carriesFiles(["text/uri-list"])).toBe(false);
    expect(carriesFiles(["text/html", "text/plain"])).toBe(false);
    expect(carriesFiles([])).toBe(false);
  });

  it("ignores an absent transfer rather than failing", () => {
    expect(carriesFiles(undefined)).toBe(false);
    expect(carriesFiles(null)).toBe(false);
  });

  it("is case sensitive, matching the DataTransfer contract", () => {
    // The specification defines the entry as exactly "Files"; accepting other
    // casings would make behaviour depend on the browser.
    expect(carriesFiles(["files"])).toBe(false);
  });

  it("keeps the zone highlighted while the pointer moves between its children", () => {
    expect(leavesDropZone(true)).toBe(false);
  });

  it("releases the highlight once the pointer leaves the zone", () => {
    expect(leavesDropZone(false)).toBe(true);
  });
});
