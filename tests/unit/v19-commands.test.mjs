import { describe, expect, it } from "vitest";

import {
  archiveCommand,
  completeCommand,
  rescheduleCommand,
  snoozeCommand,
  statusCommand,
  upsertCommand,
} from "../../web/src/lib/data/commands.js";

// #455: the item view's writes. Builders are pure so the payload contract —
// expectedVersion threading, activity records shaped like the shipped app's
// (src/components/dashboard.tsx activity()) — is pinned here, not discovered
// in a container run.
const IDS = { uuid: () => "a-1", now: () => "2026-08-15T12:00:00.000Z" };

const ITEM = {
  id: "i-mot",
  householdId: "hh-1",
  sectionId: "s-vehicles",
  title: "Car MOT — Volvo V60",
  scheduleKind: "service",
  currency: "GBP",
  dueDate: "2026-08-29",
  recurrenceMonths: 12,
  status: "active",
  version: 5,
};

// The next due date after a completion is the engine's (ADR-0034, #1324):
// the month-end clamp and leap years that nextDateAfter's tests pinned here
// are pinned in src/lib/next-due-date.test.ts.

describe("command builders", () => {
  it("complete threads version, dates and a kind-correct activity", () => {
    const command = completeCommand(ITEM, {
      completedDate: "2026-08-15",
      costMinor: 5485,
      notes: "passed first time",
    }, IDS);
    expect(command).toMatchObject({
      type: "item.complete",
      householdId: "hh-1",
      itemId: "i-mot",
      expectedVersion: 5,
      completedDate: "2026-08-15",
      costMinor: 5485,
    });
    expect(command.activity).toMatchObject({
      id: "a-1",
      itemId: "i-mot",
      kind: "service_completed",
      occurredAt: "2026-08-15T12:00:00.000Z",
      effectiveDate: "2026-08-15",
      previousDate: "2026-08-29",
    });
  });

  it("complete never sends a next due date: the engine works it out (#1324)", () => {
    const command = completeCommand(ITEM, /** @type {any} */ ({ completedDate: "2026-08-15", nextDate: "2027-08-15" }), IDS);
    expect(command).not.toHaveProperty("nextDate");
    expect(command.activity).not.toHaveProperty("nextDate");
  });

  it("a renewal completes with the renewal kind", () => {
    const command = completeCommand({ ...ITEM, scheduleKind: "renewal" }, { completedDate: "2026-08-15" }, IDS);
    expect(command.activity.kind).toBe("renewal_completed");
  });

  it("reschedule and snooze record where the date moved from", () => {
    const moved = rescheduleCommand(ITEM, "2026-09-12", IDS);
    expect(moved).toMatchObject({ type: "item.reschedule", dueDate: "2026-09-12", expectedVersion: 5 });
    expect(moved.activity).toMatchObject({ kind: "rescheduled", previousDate: "2026-08-29", nextDate: "2026-09-12" });
    const snoozed = snoozeCommand(ITEM, "2026-08-22", IDS);
    expect(snoozed).toMatchObject({ type: "item.snooze", snoozedUntil: "2026-08-22" });
    expect(snoozed.activity.kind).toBe("snoozed");
  });

  it("archive, cancel and restore carry their kinds", () => {
    expect(archiveCommand(ITEM, IDS).activity.kind).toBe("archived");
    expect(statusCommand(ITEM, "cancelled", IDS)).toMatchObject({ type: "item.status", status: "cancelled" });
    expect(statusCommand(ITEM, "cancelled", IDS).activity.kind).toBe("cancelled");
    expect(statusCommand(ITEM, "active", IDS).activity.kind).toBe("restored");
  });

  it("upsert sends the schema's item only — no view-model extras", () => {
    const command = upsertCommand(ITEM, { title: "Car MOT", costMinor: 6000 }, IDS);
    expect(command).toMatchObject({ type: "item.upsert", householdId: "hh-1" });
    expect(command.item.title).toBe("Car MOT");
    expect(command.item.costMinor).toBe(6000);
    expect(command.item.version).toBe(5);
    expect(command.item.householdId).toBeUndefined();
    expect(command.item.section).toBeUndefined();
    expect(command.item.documents).toBeUndefined();
    expect(command.activity.kind).toBe("updated");
  });

  it("a versionless item defaults expectedVersion to 1 like the shipped app", () => {
    expect(archiveCommand({ ...ITEM, version: undefined }, IDS).expectedVersion).toBe(1);
  });
});
