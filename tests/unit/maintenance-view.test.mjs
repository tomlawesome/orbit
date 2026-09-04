/*
 * What the maintenance screen is handed, and how it tells the time (#526).
 *
 * Two pure modules from web/, reached the way the v19 unit tests reach
 * theirs. `maintenanceView` is the boundary between the administrator's
 * `MaintenanceState` and the screen a blocked stranger sees, so the test
 * pins what crosses it and, more to the point, what does not.
 */
import { describe, expect, it } from "vitest";

import { maintenanceView } from "../../web/src/lib/server/maintenance-view.js";
import { clock, when } from "../../web/src/routes/maintenance/when.js";

const at = (iso) => new Date(iso);

const update = (n, kind, body, iso) => ({
  id: `0d2a2d4e-6c3e-4b3a-9c47-3c2a7f5e1a0${n}`,
  windowId: "9f1c7b2e-4a6d-4f0b-8e2a-1d3c5b7a9e01",
  kind,
  body,
  publishedAt: at(iso),
  createdAt: at(iso),
  editedAt: null,
});

const state = {
  id: 1,
  active: true,
  currentWindowId: "9f1c7b2e-4a6d-4f0b-8e2a-1d3c5b7a9e01",
  expectedEndAt: at("2026-09-04T22:00:00.000Z"),
  version: 7,
  updatedAt: at("2026-09-04T21:48:00.000Z"),
  effectivelyActive: true,
  openWindow: {
    id: "9f1c7b2e-4a6d-4f0b-8e2a-1d3c5b7a9e01",
    status: "active",
    scheduledStartAt: at("2026-09-04T21:00:00.000Z"),
    expectedEndAt: at("2026-09-04T22:30:00.000Z"),
    startedAt: at("2026-09-04T21:00:00.000Z"),
    endedAt: null,
    createdBy: "u-admin",
    createdAt: at("2026-09-04T20:00:00.000Z"),
    updatedAt: at("2026-09-04T21:48:00.000Z"),
    updates: [
      update(1, "started", "We are moving Orbit to new storage.", "2026-09-04T21:00:00.000Z"),
      update(2, "update", "About halfway.", "2026-09-04T21:25:00.000Z"),
      update(3, "update", "Verifying before we reopen.", "2026-09-04T21:48:00.000Z"),
    ],
  },
  scheduledWindows: [{ id: "should-not-cross" }],
};

describe("maintenanceView", () => {
  it("hands the screen the open window's entries newest first, as ISO strings", () => {
    const view = maintenanceView(state);
    expect(view.entries.map((entry) => entry.publishedAt)).toEqual([
      "2026-09-04T21:48:00.000Z",
      "2026-09-04T21:25:00.000Z",
      "2026-09-04T21:00:00.000Z",
    ]);
    expect(view.entries[2]).toEqual({
      id: "0d2a2d4e-6c3e-4b3a-9c47-3c2a7f5e1a01",
      kind: "started",
      body: "We are moving Orbit to new storage.",
      publishedAt: "2026-09-04T21:00:00.000Z",
    });
  });

  it("prefers the window's own expected end over the state's", () => {
    expect(maintenanceView(state).expectedEndAt).toBe("2026-09-04T22:30:00.000Z");
  });

  it("carries nothing but entries and the expected end", () => {
    // Decision 8: no version, actor, window ids or scheduled windows. The
    // shape is the boundary, so the whole key set is pinned.
    const view = maintenanceView(state);
    expect(Object.keys(view).sort()).toEqual(["entries", "expectedEndAt"]);
    expect(Object.keys(view.entries[0]).sort()).toEqual(["body", "id", "kind", "publishedAt"]);
  });

  it("reads well with nothing: no open window is an empty timeline", () => {
    expect(maintenanceView({ ...state, openWindow: null, expectedEndAt: null })).toEqual({
      entries: [],
      expectedEndAt: null,
    });
  });

  it("does not mutate the window's update order", () => {
    const before = state.openWindow.updates.map((entry) => entry.id);
    maintenanceView(state);
    expect(state.openWindow.updates.map((entry) => entry.id)).toEqual(before);
  });
});

describe("the screen's clock", () => {
  const iso = "2026-09-04T21:48:00.000Z";

  it("renders in UTC on the server, whatever the host's zone", () => {
    expect(clock(iso, { utc: true })).toBe("21:48");
    expect(when(iso, { utc: true })).toBe("21:48 · 4 Sep");
  });

  it("pads the hour and never varies the month by locale", () => {
    expect(when("2026-01-09T03:05:00.000Z", { utc: true })).toBe("03:05 · 9 Jan");
  });

  it("uses the viewer's zone once mounted", () => {
    const d = new Date(iso);
    const hh = String(d.getHours()).padStart(2, "0");
    const mm = String(d.getMinutes()).padStart(2, "0");
    expect(clock(iso)).toBe(`${hh}:${mm}`);
  });
});
