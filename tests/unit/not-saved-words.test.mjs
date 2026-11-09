import { describe, expect, it } from "vitest";

import { WorkspaceError, notSavedWords } from "../../web/src/lib/data/workspace.js";

/*
 * #1463 (audit Low "create r2 F2", from #1426): the phone's message for a
 * create whose item already landed without its file ("This item was already
 * added, but without this file...", code item_already_saved, 409) gets the
 * "not saved —" prefix, which tells the member the opposite of the truth: the
 * item IS saved. notSavedWords leaves that message as the server worded it.
 */
const ALREADY = "This item was already added, but without this file. Open the item and attach the file there.";

describe("notSavedWords", () => {
  it("does not lead the already-added message with \"not saved\"", () => {
    const words = notSavedWords(new WorkspaceError(ALREADY, { status: 409, code: "item_already_saved" }));
    expect(words).toBe(ALREADY);
    expect(words.toLowerCase()).not.toContain("not saved");
  });

  it("still leads other failures with \"not saved —\"", () => {
    expect(notSavedWords(new WorkspaceError("The title is too long.", { status: 422, code: "validation_failed" }))).toBe("not saved — The title is too long.");
  });

  it("still leaves words that already say what did not happen", () => {
    expect(notSavedWords(new WorkspaceError("not yet — wait a moment", { status: 409 }))).toBe("not yet — wait a moment");
  });
});
