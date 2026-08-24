import { describe, expect, it } from "vitest";
import {
  bannerLines,
  characterCountLabel,
  confirmCancelWindow,
  confirmSchedule,
  controlMode,
  dueScheduledWindow,
  formatWhen,
  localInputToIso,
  maintenanceFacts,
  messageProblem,
  pendingWindows,
  timelineNewestFirst,
  type MaintenanceStateView,
  type MaintenanceUpdateView,
  type MaintenanceWindowView,
} from "./maintenance-view";

const NOW = new Date("2026-08-23T12:00:00.000Z");

function entry(overrides: Partial<MaintenanceUpdateView> = {}): MaintenanceUpdateView {
  return {
    id: "22222222-2222-4222-8222-222222222222",
    windowId: "11111111-1111-4111-8111-111111111111",
    kind: "started",
    body: "Upgrading the database.",
    publishedAt: "2026-08-23T11:00:00.000Z",
    createdAt: "2026-08-23T11:00:00.000Z",
    editedAt: null,
    ...overrides,
  };
}

/* A scheduled window as the API returns one: its only entry is the
   `scheduled` one written when it was scheduled, and status is what
   distinguishes it — the same shape scheduleMaintenanceWindow produces. */
function scheduledWindow(overrides: Partial<MaintenanceWindowView> = {}): MaintenanceWindowView {
  const id = overrides.id ?? "11111111-1111-4111-8111-111111111111";
  return {
    id,
    status: "scheduled",
    scheduledStartAt: "2026-08-24T22:00:00.000Z",
    startedAt: null,
    expectedEndAt: null,
    endedAt: null,
    cancelledAt: null,
    absorbedIntoId: null,
    createdAt: "2026-08-23T09:00:00.000Z",
    updatedAt: "2026-08-23T09:00:00.000Z",
    updates: [entry({ id: `${id}-scheduled`, windowId: id, kind: "scheduled", publishedAt: "2026-08-23T09:00:00.000Z" })],
    ...overrides,
  };
}

function openWindow(overrides: Partial<MaintenanceWindowView> = {}): MaintenanceWindowView {
  const id = overrides.id ?? "33333333-3333-4333-8333-333333333333";
  return {
    ...scheduledWindow({ id }),
    status: "open",
    scheduledStartAt: null,
    startedAt: "2026-08-23T11:00:00.000Z",
    updates: [entry({ windowId: id })],
    ...overrides,
  };
}

function state(overrides: Partial<MaintenanceStateView> = {}): MaintenanceStateView {
  return {
    id: "singleton",
    active: false,
    currentWindowId: null,
    expectedEndAt: null,
    version: 3,
    updatedAt: "2026-08-23T09:00:00.000Z",
    effectivelyActive: false,
    openWindow: null,
    scheduledWindows: [],
    ...overrides,
  };
}

/* The state the API returns while a window is open: the singleton is active,
   names the window, and carries its denormalised expected end. */
function activeState(window: MaintenanceWindowView, overrides: Partial<MaintenanceStateView> = {}): MaintenanceStateView {
  return state({
    active: true,
    effectivelyActive: true,
    currentWindowId: window.id,
    expectedEndAt: window.expectedEndAt,
    openWindow: window,
    ...overrides,
  });
}

describe("controlMode", () => {
  it("is open when nothing holds the instance closed", () => {
    expect(controlMode(state(), NOW)).toBe("open");
  });

  it("is active when a window is open", () => {
    expect(controlMode(activeState(openWindow()), NOW)).toBe("active");
  });

  it("is scheduled when only a due scheduled window holds the instance closed", () => {
    const due = scheduledWindow({ scheduledStartAt: "2026-08-23T11:30:00.000Z" });
    expect(controlMode(state({ effectivelyActive: true, scheduledWindows: [due] }), NOW)).toBe("scheduled");
  });

  it("is open when a window exists but has not started yet", () => {
    expect(controlMode(state({ scheduledWindows: [scheduledWindow()] }), NOW)).toBe("open");
  });
});

describe("pendingWindows", () => {
  it("lists the windows still scheduled, in the order the API returned", () => {
    const first = scheduledWindow({ id: "aaaaaaaa-1111-4111-8111-111111111111", scheduledStartAt: "2026-08-24T22:00:00.000Z" });
    const second = scheduledWindow({ id: "bbbbbbbb-1111-4111-8111-111111111111", scheduledStartAt: "2026-08-25T22:00:00.000Z" });
    expect(pendingWindows(state({ scheduledWindows: [first, second] })).map((window) => window.id))
      .toEqual([first.id, second.id]);
  });
});

describe("dueScheduledWindow", () => {
  it("ignores a future window", () => {
    expect(dueScheduledWindow(state({ scheduledWindows: [scheduledWindow()] }), NOW)).toBeNull();
  });

  it("returns a window whose start time has passed", () => {
    const due = scheduledWindow({ id: "cccccccc-1111-4111-8111-111111111111", scheduledStartAt: "2026-08-23T11:59:00.000Z" });
    expect(dueScheduledWindow(state({ scheduledWindows: [due] }), NOW)?.id).toBe(due.id);
  });
});

describe("timelineNewestFirst", () => {
  it("reverses the API's published order so the newest entry reads first", () => {
    const window = openWindow({
      updates: [
        entry({ id: "first", kind: "started", body: "Starting now.", publishedAt: "2026-08-23T11:00:00.000Z" }),
        entry({ id: "second", kind: "update", body: "Twenty minutes behind.", publishedAt: "2026-08-23T11:40:00.000Z" }),
      ],
    });
    expect(timelineNewestFirst(window).map((published) => published.id)).toEqual(["second", "first"]);
  });

  it("is empty when there is no window", () => {
    expect(timelineNewestFirst(null)).toEqual([]);
  });
});

describe("maintenanceFacts", () => {
  it("reads the open window, newest entry first", () => {
    const window = openWindow({
      expectedEndAt: "2026-08-23T13:00:00.000Z",
      updates: [
        entry({ id: "first", kind: "started", body: "Back shortly.", publishedAt: "2026-08-23T11:00:00.000Z" }),
        entry({ id: "second", kind: "update", body: "Running late.", publishedAt: "2026-08-23T11:45:00.000Z" }),
      ],
    });
    const facts = maintenanceFacts(activeState(window), NOW);
    expect(facts.timeline.map((published) => published.body)).toEqual(["Running late.", "Back shortly."]);
    expect(facts.startedAt).toBe("2026-08-23T11:00:00.000Z");
    expect(facts.lastPublishedAt).toBe("2026-08-23T11:45:00.000Z");
    expect(facts.expectedEndAt).toBe("2026-08-23T13:00:00.000Z");
  });

  it("reads the due scheduled window when only that holds the instance closed", () => {
    const due = scheduledWindow({
      scheduledStartAt: "2026-08-23T11:30:00.000Z",
      expectedEndAt: "2026-08-23T14:00:00.000Z",
    });
    due.updates = [entry({ windowId: due.id, kind: "scheduled", body: "Scheduled upgrade.", publishedAt: "2026-08-23T09:00:00.000Z" })];
    const facts = maintenanceFacts(state({ effectivelyActive: true, scheduledWindows: [due] }), NOW);
    expect(facts.timeline.map((published) => published.body)).toEqual(["Scheduled upgrade."]);
    expect(facts.startedAt).toBe("2026-08-23T11:30:00.000Z");
    expect(facts.expectedEndAt).toBe("2026-08-23T14:00:00.000Z");
  });
});

describe("messageProblem", () => {
  it("accepts a short message", () => {
    expect(messageProblem("Back at six.")).toBeNull();
  });

  it("rejects an empty message", () => {
    expect(messageProblem("   ")).toBe("Enter the message people will see on the maintenance screen.");
  });

  it("rejects more than 500 characters", () => {
    expect(messageProblem("x".repeat(501))).toBe("Use 500 characters or fewer.");
  });

  it("accepts exactly 500 characters", () => {
    expect(messageProblem("x".repeat(500))).toBeNull();
  });

  it("rejects more than 8 lines", () => {
    expect(messageProblem("a\nb\nc\nd\ne\nf\ng\nh\ni")).toBe("Use 8 lines or fewer.");
  });

  it("accepts exactly 8 lines", () => {
    expect(messageProblem("a\nb\nc\nd\ne\nf\ng\nh")).toBeNull();
  });
});

describe("characterCountLabel", () => {
  it("counts against the 500-character bound", () => {
    expect(characterCountLabel("abc")).toBe("3/500 characters");
  });
});

describe("localInputToIso", () => {
  it("returns null for an empty input", () => {
    expect(localInputToIso("")).toBeNull();
  });

  it("returns null for an unparseable input", () => {
    expect(localInputToIso("not a time")).toBeNull();
  });

  it("sends a local wall-clock time as UTC", () => {
    const iso = localInputToIso("2026-08-24T22:00");
    expect(iso).toBe(new Date("2026-08-24T22:00").toISOString());
    expect(iso?.endsWith("Z")).toBe(true);
  });
});

describe("formatWhen", () => {
  it("says Not set for a missing time", () => {
    expect(formatWhen(null)).toBe("Not set");
  });

  it("says Unknown time for an unparseable value", () => {
    expect(formatWhen("nonsense")).toBe("Unknown time");
  });
});

describe("confirmations", () => {
  it("names the local start time when scheduling", () => {
    expect(confirmSchedule("2026-08-24T22:00:00.000Z")).toBe(
      `Schedule maintenance for ${formatWhen("2026-08-24T22:00:00.000Z")}? It will start automatically at that time.`,
    );
  });

  it("names the start time that will not happen when cancelling", () => {
    expect(confirmCancelWindow("2026-08-24T22:00:00.000Z")).toBe(
      `Cancel this scheduled maintenance? Maintenance will not start at ${formatWhen("2026-08-24T22:00:00.000Z")}.`,
    );
  });
});

describe("bannerLines", () => {
  it("shows nothing while Orbit is open", () => {
    expect(bannerLines(state(), NOW)).toBeNull();
  });

  it("shows nothing for a window that has not started", () => {
    expect(bannerLines(state({ scheduledWindows: [scheduledWindow()] }), NOW)).toBeNull();
  });

  it("states that Orbit is closed, without an expected end when none is set", () => {
    const lines = bannerLines(activeState(openWindow()), NOW);
    expect(lines).toEqual({ headline: "Maintenance is active — Orbit is closed to users.", expected: null });
  });

  it("adds the expected return time when one is set", () => {
    const lines = bannerLines(activeState(openWindow({ expectedEndAt: "2026-08-23T13:00:00.000Z" })), NOW);
    expect(lines?.expected).toBe(`Expected back by ${formatWhen("2026-08-23T13:00:00.000Z")}.`);
  });
});
