import { describe, expect, it } from "vitest";

import { dueDateIn } from "../../web/src/lib/data/workspace.js";

/* #1324: after a completion the screens read the next due date from the
   workspace the engine returned, rather than working it out themselves. */
describe("dueDateIn", () => {
  const workspace = /** @type {any} */ ({
    households: [
      { id: "hh-1", items: [{ id: "i-mot", dueDate: "2027-08-15" }, { id: "i-once" }] },
      { id: "hh-2", items: [{ id: "i-mot", dueDate: "2030-01-01" }] },
    ],
  });

  it("reads the item's due date in its own household", () => {
    expect(dueDateIn(workspace, "hh-1", "i-mot")).toBe("2027-08-15");
  });

  it("is null when the completion ended the schedule, or the item is not there", () => {
    expect(dueDateIn(workspace, "hh-1", "i-once")).toBeNull();
    expect(dueDateIn(workspace, "hh-1", "i-gone")).toBeNull();
    expect(dueDateIn(workspace, "hh-9", "i-mot")).toBeNull();
  });
});
