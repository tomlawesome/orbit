import { describe, expect, it } from "vitest";
import type { HomeItem } from "@/lib/domain";
import {
  buildDialItems,
  calloutPlacementForBody,
  costBandForCostMinor,
  dialStatusForDueBand,
  dialTypeForItem,
  formatTMinus,
} from "./dial-adapter";

const TODAY = "2026-08-13";

function homeItem(overrides: Partial<HomeItem> & Pick<HomeItem, "id" | "title">): HomeItem {
  return {
    sectionId: "home",
    currency: "GBP",
    status: "active",
    ...overrides,
  };
}

describe("dialStatusForDueBand", () => {
  it("renames the product's due-band taxonomy onto the dial's four materials", () => {
    expect(dialStatusForDueBand("overdue")).toBe("overdue");
    expect(dialStatusForDueBand("week")).toBe("soon");
    expect(dialStatusForDueBand("quarter")).toBe("upcoming");
    expect(dialStatusForDueBand("later")).toBe("ok");
  });

  it("excludes unscheduled items — nothing to plot without a date", () => {
    expect(dialStatusForDueBand("unscheduled")).toBeNull();
  });
});

describe("dialTypeForItem", () => {
  it("maps scheduleKind renewal/service straight through", () => {
    expect(dialTypeForItem({ scheduleKind: "renewal" })).toBe("renewal");
    expect(dialTypeForItem({ scheduleKind: "service" })).toBe("service");
  });

  it("defaults an item with no scheduleKind to the neutral service body", () => {
    expect(dialTypeForItem({})).toBe("service");
  });
});

describe("costBandForCostMinor", () => {
  it("bands costs from cheapest to costliest, boundaries inclusive on the lower band", () => {
    expect(costBandForCostMinor(undefined)).toBe(1);
    expect(costBandForCostMinor(null)).toBe(1);
    expect(costBandForCostMinor(0)).toBe(1);
    expect(costBandForCostMinor(5_000)).toBe(1);
    expect(costBandForCostMinor(5_001)).toBe(2);
    expect(costBandForCostMinor(20_000)).toBe(2);
    expect(costBandForCostMinor(20_001)).toBe(3);
    expect(costBandForCostMinor(75_000)).toBe(3);
    expect(costBandForCostMinor(75_001)).toBe(4);
    expect(costBandForCostMinor(1_000_000)).toBe(4);
  });
});

describe("formatTMinus", () => {
  it("counts up from an overdue date with a plus sign", () => {
    expect(formatTMinus(-16)).toBe("T+16d");
    expect(formatTMinus(-1)).toBe("T+1d");
  });

  it("counts down to a future date with a minus sign (U+2212)", () => {
    expect(formatTMinus(16)).toBe("T−16d");
    expect(formatTMinus(0)).toBe("T−0d");
  });
});

describe("buildDialItems", () => {
  it("maps a workspace-shaped item list onto dial items", () => {
    const items: HomeItem[] = [
      homeItem({ id: "gutter", title: "Gutter clearing", dueDate: "2026-07-28", costMinor: 15_000, scheduleKind: "service" }),
      homeItem({ id: "mot", title: "Car MOT", dueDate: "2026-08-18", costMinor: 5_485, scheduleKind: "renewal" }),
      homeItem({ id: "smoke", title: "Smoke alarm batteries", dueDate: "2026-12-13", costMinor: 1_200 }),
    ];
    const dialItems = buildDialItems(items, TODAY);
    expect(dialItems).toHaveLength(3);
    expect(dialItems[0]).toMatchObject({ id: "gutter", status: "overdue", type: "service", costBand: 2 });
    expect(dialItems[1]).toMatchObject({ id: "mot", status: "soon", type: "renewal", costBand: 2 });
    expect(dialItems[2]).toMatchObject({ id: "smoke", status: "ok", type: "service", costBand: 1 });
  });

  it("skips items without a due date — the dial has nowhere to place them", () => {
    const items: HomeItem[] = [
      homeItem({ id: "undated", title: "Someday" }),
      homeItem({ id: "dated", title: "Boiler service", dueDate: "2026-09-04" }),
    ];
    const dialItems = buildDialItems(items, TODAY);
    expect(dialItems.map((item) => item.id)).toEqual(["dated"]);
  });

  it("never sets documents — no per-item document count exists in the domain model yet", () => {
    const items: HomeItem[] = [homeItem({ id: "a", title: "A", dueDate: "2026-09-04" })];
    expect(buildDialItems(items, TODAY)[0].documents).toBeUndefined();
  });
});

describe("calloutPlacementForBody", () => {
  it("extends further left when the body sits left of the dial's centre, away from the cluster (POL-6)", () => {
    const placement = calloutPlacementForBody(
      { top: 200, left: 100, right: 112, width: 12 },
      { left: 50, width: 640 },
      1200,
    );
    expect(placement.side).toBe("left");
    expect(placement.left).toBeUndefined();
    expect(placement.right).toBe(1200 - 100 + 20);
    expect(placement.top).toBe(186);
  });

  it("extends further right when the body sits right of the dial's centre, away from the cluster (POL-6)", () => {
    const placement = calloutPlacementForBody(
      { top: 200, left: 700, right: 712, width: 12 },
      { left: 50, width: 640 },
      1200,
    );
    expect(placement.side).toBe("right");
    expect(placement.right).toBeUndefined();
    expect(placement.left).toBe(712 + 20);
  });
});
