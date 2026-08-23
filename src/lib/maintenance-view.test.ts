import { describe, expect, it } from "vitest";
import {
  bannerLines,
  characterCountLabel,
  confirmCancelNotice,
  confirmSchedule,
  controlMode,
  dueNotice,
  formatWhen,
  localInputToIso,
  maintenanceFacts,
  messageProblem,
  pendingNotices,
  type MaintenanceNoticeView,
  type MaintenanceStateView,
} from "./maintenance-view";

const NOW = new Date("2026-08-23T12:00:00.000Z");

function notice(overrides: Partial<MaintenanceNoticeView> = {}): MaintenanceNoticeView {
  return {
    id: "11111111-1111-4111-8111-111111111111",
    message: "Upgrading the database.",
    startsAt: "2026-08-24T22:00:00.000Z",
    expectedEndAt: null,
    activatedAt: null,
    cancelledAt: null,
    createdAt: "2026-08-23T09:00:00.000Z",
    ...overrides,
  };
}

function state(overrides: Partial<MaintenanceStateView> = {}): MaintenanceStateView {
  return {
    id: "singleton",
    active: false,
    message: null,
    messagePublishedAt: null,
    expectedEndAt: null,
    activatedAt: null,
    version: 3,
    updatedAt: "2026-08-23T09:00:00.000Z",
    effectivelyActive: false,
    notices: [],
    ...overrides,
  };
}

describe("controlMode", () => {
  it("is open when nothing holds the instance closed", () => {
    expect(controlMode(state(), NOW)).toBe("open");
  });

  it("is active when the singleton is active", () => {
    expect(controlMode(state({ active: true, effectivelyActive: true }), NOW)).toBe("active");
  });

  it("is notice when only a due, unclaimed notice holds the instance closed", () => {
    const due = notice({ startsAt: "2026-08-23T11:30:00.000Z" });
    expect(controlMode(state({ effectivelyActive: true, notices: [due] }), NOW)).toBe("notice");
  });

  it("is open when a notice exists but has not started yet", () => {
    expect(controlMode(state({ notices: [notice()] }), NOW)).toBe("open");
  });
});

describe("pendingNotices", () => {
  it("lists only notices that are neither activated nor cancelled", () => {
    const pending = notice({ id: "pending" });
    const claimed = notice({ id: "claimed", activatedAt: "2026-08-23T10:00:00.000Z" });
    const cancelled = notice({ id: "cancelled", cancelledAt: "2026-08-23T10:00:00.000Z" });
    expect(pendingNotices(state({ notices: [pending, claimed, cancelled] })).map((entry) => entry.id)).toEqual([
      "pending",
    ]);
  });

  it("keeps the order the API returned", () => {
    const first = notice({ id: "first", startsAt: "2026-08-24T22:00:00.000Z" });
    const second = notice({ id: "second", startsAt: "2026-08-25T22:00:00.000Z" });
    expect(pendingNotices(state({ notices: [first, second] })).map((entry) => entry.id)).toEqual(["first", "second"]);
  });
});

describe("dueNotice", () => {
  it("ignores a future notice", () => {
    expect(dueNotice(state({ notices: [notice()] }), NOW)).toBeNull();
  });

  it("returns a notice whose start time has passed", () => {
    const due = notice({ id: "due", startsAt: "2026-08-23T11:59:00.000Z" });
    expect(dueNotice(state({ notices: [due] }), NOW)?.id).toBe("due");
  });
});

describe("maintenanceFacts", () => {
  it("reads the singleton when it is active", () => {
    const facts = maintenanceFacts(
      state({
        active: true,
        effectivelyActive: true,
        message: "Back shortly.",
        messagePublishedAt: "2026-08-23T11:00:00.000Z",
        activatedAt: "2026-08-23T11:00:00.000Z",
        expectedEndAt: "2026-08-23T13:00:00.000Z",
      }),
      NOW,
    );
    expect(facts.message).toBe("Back shortly.");
    expect(facts.expectedEndAt).toBe("2026-08-23T13:00:00.000Z");
  });

  it("reads the due notice when only a notice holds the instance closed", () => {
    const due = notice({
      startsAt: "2026-08-23T11:30:00.000Z",
      expectedEndAt: "2026-08-23T14:00:00.000Z",
      message: "Scheduled upgrade.",
    });
    const facts = maintenanceFacts(state({ effectivelyActive: true, notices: [due] }), NOW);
    expect(facts.message).toBe("Scheduled upgrade.");
    expect(facts.activatedAt).toBe("2026-08-23T11:30:00.000Z");
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
    expect(confirmCancelNotice("2026-08-24T22:00:00.000Z")).toBe(
      `Cancel this scheduled maintenance notice? Maintenance will not start at ${formatWhen("2026-08-24T22:00:00.000Z")}.`,
    );
  });
});

describe("bannerLines", () => {
  it("shows nothing while Orbit is open", () => {
    expect(bannerLines(state(), NOW)).toBeNull();
  });

  it("shows nothing for a notice that has not started", () => {
    expect(bannerLines(state({ notices: [notice()] }), NOW)).toBeNull();
  });

  it("states that Orbit is closed, without an expected end when none is set", () => {
    const lines = bannerLines(state({ active: true, effectivelyActive: true }), NOW);
    expect(lines).toEqual({ headline: "Maintenance is active — Orbit is closed to users.", expected: null });
  });

  it("adds the expected return time when one is set", () => {
    const lines = bannerLines(
      state({ active: true, effectivelyActive: true, expectedEndAt: "2026-08-23T13:00:00.000Z" }),
      NOW,
    );
    expect(lines?.expected).toBe(`Expected back by ${formatWhen("2026-08-23T13:00:00.000Z")}.`);
  });
});
