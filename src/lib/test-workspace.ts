import { demoItems } from "@/lib/demo-data";
import { activeHousehold, createEmptyWorkspace, type ItemActivity, type WorkspaceState } from "@/lib/workspace";

const activities: ItemActivity[] = [
  { id: "activity-car-created", itemId: "car-insurance", kind: "created", occurredAt: "2025-07-22T10:00:00.000Z", nextDate: "2026-07-22" },
  { id: "activity-boiler-created", itemId: "boiler-service", kind: "created", occurredAt: "2025-08-02T09:30:00.000Z", nextDate: "2026-08-02" },
  { id: "activity-broadband-created", itemId: "broadband", kind: "created", occurredAt: "2025-03-14T14:00:00.000Z", nextDate: "2026-09-14" },
  { id: "activity-washer-created", itemId: "washing-machine", kind: "created", occurredAt: "2025-11-05T11:15:00.000Z", nextDate: "2026-11-05" },
  { id: "activity-inventory-created", itemId: "home-inventory", kind: "created", occurredAt: "2026-01-10T16:00:00.000Z" },
];

/** Test-only representative data; this module is never imported by the production application. */
export function createTestWorkspace(): WorkspaceState {
  const workspace = createEmptyWorkspace();
  const household = activeHousehold(workspace);
  return {
    ...workspace,
    activeHouseholdId: "our-home",
    households: [{
      ...household,
      id: "our-home",
      name: "Our home",
      onboardingComplete: true,
      memberCount: 2,
      items: demoItems,
      activities,
    }],
  };
}
